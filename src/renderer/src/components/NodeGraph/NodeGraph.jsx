import { useState, useRef, useEffect } from 'react'
import Node from './Node'
import ControlPanel from './ControlPanel'
import EffectMenu from './EffectMenu'
import ReplaceEffectMenu from './ReplaceEffectMenu'
import './NodeGraph.css'

const NodeGraph = ({
  nodes,
  connections,
  selectedNodeId,
  onSelectNode,
  onDeleteNode,
  onUpdateNodePosition,
  onAddEffect,
  onRemoveConnection,
  onUpdateNodeParams,
  onConnectNodes,
  onReplaceEffect,
  AVAILABLE_EFFECTS,
  tracks,
}) => {
  const containerRef = useRef(null)
  const svgRef = useRef(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [draggingNode, setDraggingNode] = useState(null)
  const [draggingConnection, setDraggingConnection] = useState(null)
  const [showEffectMenu, setShowEffectMenu] = useState(false)
  const [effectMenuPosition, setEffectMenuPosition] = useState(null)
  const [effectMenuSourceId, setEffectMenuSourceId] = useState(null)
  const [showNodeMenu, setShowNodeMenu] = useState(false)
  const [nodeMenuPosition, setNodeMenuPosition] = useState(null)
  const [nodeMenuId, setNodeMenuId] = useState(null)

  const selectedNode = nodes.find((n) => n.id === selectedNodeId)

  // Handle node dragging
  const handleNodeDragStart = (e, nodeId) => {
    setDraggingNode({ id: nodeId, startX: e.clientX, startY: e.clientY })
  }

  useEffect(() => {
    if (!draggingNode) return

    const handleMouseMove = (e) => {
      const deltaX = (e.clientX - draggingNode.startX) / zoom
      const deltaY = (e.clientY - draggingNode.startY) / zoom
      const node = nodes.find((n) => n.id === draggingNode.id)
      if (node) {
        onUpdateNodePosition(draggingNode.id, {
          x: node.position.x + deltaX,
          y: node.position.y + deltaY,
        })
      }
      draggingNode.startX = e.clientX
      draggingNode.startY = e.clientY
    }

    const handleMouseUp = () => {
      setDraggingNode(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [draggingNode, nodes, zoom, onUpdateNodePosition])

  // Handle canvas panning
  const handleCanvasMouseDown = (e) => {
    if (e.button === 2) {
      // Right-click: pan
      const startX = e.clientX
      const startY = e.clientY
      const startPan = { ...pan }

      const handleMouseMove = (e) => {
        setPan({
          x: startPan.x + (e.clientX - startX),
          y: startPan.y + (e.clientY - startY),
        })
      }

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    } else if (e.button === 0) {
      // Left-click on empty canvas: deselect
      onSelectNode(null)
    }
  }

  // Handle zoom
  const handleWheel = (e) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setZoom((prev) => Math.max(0.1, Math.min(3, prev * delta)))
  }

  // Handle node menu button click
  const handleNodeMenuOpen = (nodeId, x, y) => {
    const containerRect = containerRef.current?.getBoundingClientRect()
    if (!containerRect) return

    setNodeMenuId(nodeId)
    setNodeMenuPosition({
      x: x - containerRect.left,
      y: y - containerRect.top,
    })
    setShowNodeMenu(true)
  }

  // Connection drawing
  const handleSocketMouseDown = (e, nodeId, socketType) => {
    // Only allow dragging from output sockets
    if (socketType === 'input') return

    e.stopPropagation()
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return

    const node = nodes.find(n => n.id === nodeId)
    if (!node) return

    const socketY = node.type === 'track' ? 40 : node.type === 'master' ? 40 : 70
    // Account for pan and zoom when calculating socket position on screen
    const socketScreenX = (node.position.x + (socketType === 'output' ? 160 : 0)) * zoom + pan.x + rect.left
    const socketScreenY = (node.position.y + socketY) * zoom + pan.y + rect.top

    // Store connection data in local variable for closure
    const connectionData = {
      sourceId: nodeId,
      sourceType: socketType,
      startScreenX: socketScreenX,
      startScreenY: socketScreenY,
      currentScreenX: e.clientX,
      currentScreenY: e.clientY,
    }

    setDraggingConnection(connectionData)

    const handleMouseMove = (e) => {
      setDraggingConnection((prev) =>
        prev ? {
          ...prev,
          currentScreenX: e.clientX,
          currentScreenY: e.clientY,
        } : null
      )
    }

    const handleMouseUp = (e) => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)

      if (!connectionData) return

      // Try to find target socket
      const elementsAtEnd = document.elementsFromPoint(e.clientX, e.clientY)
      const targetSocket = elementsAtEnd.find((el) => el.getAttribute?.('data-socket'))
      
      let madeConnection = false
      if (targetSocket) {
        const targetSocketType = targetSocket.getAttribute('data-socket')
        // Find the target node by traversing up the DOM
        let parent = targetSocket.parentElement
        while (parent) {
          const transform = parent.getAttribute('transform')
          if (transform && transform.includes('translate')) {
            const match = transform.match(/translate\(([\d.-]+),\s*([\d.-]+)\)/)
            if (match) {
              const x = parseFloat(match[1])
              const y = parseFloat(match[2])
              const targetNode = nodes.find((n) => {
                return Math.abs(n.position.x - x) < 1 && Math.abs(n.position.y - y) < 1
              })
              if (targetNode && targetNode.id !== connectionData.sourceId) {
                // Make connection based on socket types
                if (connectionData.sourceType === 'output' && targetSocketType === 'input') {
                  onConnectNodes?.(connectionData.sourceId, targetNode.id)
                  madeConnection = true
                } else if (connectionData.sourceType === 'input' && targetSocketType === 'output') {
                  onConnectNodes?.(targetNode.id, connectionData.sourceId)
                  madeConnection = true
                }
              }
            }
            break
          }
          parent = parent.parentElement
        }
      }
      
      // If dragging from output socket and no connection made, show effect menu
      if (!madeConnection && connectionData.sourceType === 'output') {
        setEffectMenuSourceId(connectionData.sourceId)
        setEffectMenuPosition({ x: e.clientX, y: e.clientY })
        setShowEffectMenu(true)
      }
      
      setDraggingConnection(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  return (
    <div ref={containerRef} className="relative w-full h-full bg-zinc-950 overflow-hidden">
      {/* SVG Canvas */}
      <svg
        ref={svgRef}
        className="w-full h-full"
        width="100%"
        height="100%"
        preserveAspectRatio="none"
        onMouseDown={handleCanvasMouseDown}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
      >
        <defs>
          <marker
            id="arrowhead"
            markerWidth="10"
            markerHeight="10"
            refX="9"
            refY="3"
            orient="auto"
          >
            <polygon points="0 0, 10 3, 0 6" fill="#60a5fa" />
          </marker>
        </defs>

        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {/* Connections */}
          {connections.map((conn) => {
            const sourceNode = nodes.find((n) => n.id === conn.source)
            const targetNode = nodes.find((n) => n.id === conn.target)
            if (!sourceNode || !targetNode) return null

            const x1 = sourceNode.position.x + 160
            const y1 = sourceNode.position.y + (sourceNode.type === 'track' ? 40 : sourceNode.type === 'master' ? 40 : 70)
            const x2 = targetNode.position.x
            const y2 = targetNode.position.y + (targetNode.type === 'track' ? 40 : targetNode.type === 'master' ? 40 : 70)

            return (
              <g key={conn.id}>
                <path
                  d={`M ${x1} ${y1} Q ${(x1 + x2) / 2} ${(y1 + y2) / 2} ${x2} ${y2}`}
                  fill="none"
                  stroke="#60a5fa"
                  strokeWidth="2"
                  markerEnd="url(#arrowhead)"
                  className="hover:stroke-blue-400 cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemoveConnection(conn.id)
                  }}
                />
              </g>
            )
          })}

          {/* Dragging connection preview */}
          {draggingConnection && svgRef.current && (() => {
            const rect = svgRef.current.getBoundingClientRect()
            if (!rect) return null
            
            const node = nodes.find(n => n.id === draggingConnection.sourceId)
            if (!node) return null
            
            const socketY = node.type === 'track' ? 40 : node.type === 'master' ? 40 : 70
            const x1 = node.position.x + (draggingConnection.sourceType === 'output' ? 160 : 0)
            const y1 = node.position.y + socketY
            
            const x2 = (draggingConnection.currentScreenX - rect.left - pan.x) / zoom
            const y2 = (draggingConnection.currentScreenY - rect.top - pan.y) / zoom
            
            return (
              <path
                d={`M ${x1} ${y1} L ${x2} ${y2}`}
                fill="none"
                stroke="#fbbf24"
                strokeWidth="2"
                strokeDasharray="4"
                pointerEvents="none"
              />
            )
          })()}

          {/* Nodes */}
          {nodes.map((node) => (
            <Node
              key={node.id}
              node={node}
              isSelected={node.id === selectedNodeId}
              onSelect={onSelectNode}
              onDragStart={handleNodeDragStart}
              onDelete={onDeleteNode}
              onSocketMouseDown={handleSocketMouseDown}
              onEffectMenuOpen={handleNodeMenuOpen}
            />
          ))}
        </g>
      </svg>

      {/* Control Panel */}
      {selectedNode && selectedNode.type === 'effect' && (
        <ControlPanel 
          node={selectedNode} 
          onParamChange={onUpdateNodeParams}
        />
      )}

      {/* Effect Menu */}
      {showEffectMenu && effectMenuPosition && (
        <EffectMenu
          effects={AVAILABLE_EFFECTS}
          onSelect={(effectType) => {
            onAddEffect(effectType, effectMenuSourceId)
            setShowEffectMenu(false)
          }}
          onClose={() => setShowEffectMenu(false)}
          position={effectMenuPosition}
        />
      )}

      {/* Node Menu */}
      {showNodeMenu && nodeMenuPosition && (
        <ReplaceEffectMenu
          nodeId={nodeMenuId}
          effects={AVAILABLE_EFFECTS}
          onDelete={onDeleteNode}
          onReplace={onReplaceEffect}
          onClose={() => setShowNodeMenu(false)}
          position={nodeMenuPosition}
        />
      )}

      {/* Info Panel */}
      <div className="absolute bottom-4 right-4 text-gray-400 text-sm max-w-xs">
        <p className="font-semibold text-gray-300">Node Graph Editor</p>
        <p className="text-gray-500 text-xs mt-1">
          • Right-click + drag to pan
        </p>
        <p className="text-gray-500 text-xs">
          • Scroll to zoom (no modifier key needed)
        </p>
        <p className="text-gray-500 text-xs">
          • Drag nodes to move
        </p>
        <p className="text-gray-500 text-xs">
          • Drag output socket to add effects
        </p>
      </div>

      <style>{`
        svg {
          cursor: grab;
          user-select: none;
        }
        svg:active {
          cursor: grabbing;
        }
        svg g, svg text {
          user-select: none;
          -webkit-user-select: none;
        }
      `}</style>
    </div>
  )
}

export default NodeGraph
