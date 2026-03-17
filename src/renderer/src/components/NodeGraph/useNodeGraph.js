import { useState, useCallback } from 'react'

const AVAILABLE_EFFECTS = [
  { id: 'reverb', name: 'Reverb', params: { wet: 0.3, decay: 2 } },
  { id: 'delay', name: 'Delay', params: { time: 0.5, feedback: 0.4, wet: 0.3 } },
  { id: 'chorus', name: 'Chorus', params: { rate: 1.5, depth: 0.5, wet: 0.3 } },
  { id: 'distortion', name: 'Distortion', params: { drive: 0.5, tone: 0.5 } },
  { id: 'compressor', name: 'Compressor', params: { threshold: -20, ratio: 4, attack: 0.005, release: 0.1 } },
  { id: 'equalizerLow', name: 'EQ (Low)', params: { frequency: 100, gain: 0 } },
  { id: 'equalizerMid', name: 'EQ (Mid)', params: { frequency: 1000, gain: 0 } },
  { id: 'equalizerHigh', name: 'EQ (High)', params: { frequency: 10000, gain: 0 } },
  { id: 'phaser', name: 'Phaser', params: { rate: 0.5, depth: 0.5 } },
  { id: 'flanger', name: 'Flanger', params: { rate: 0.5, depth: 0.5 } },
]

export const useNodeGraph = (tracks) => {
  const [nodes, setNodes] = useState([
    // Master node (always present, fixed at top left)
    {
      id: 'master',
      type: 'master',
      position: { x: 50, y: 50 },
      label: 'Master',
      isLocked: true,
    },
  ])

  const [connections, setConnections] = useState([])
  const [selectedNodeId, setSelectedNodeId] = useState(null)
  const [selectedConnection, setSelectedConnection] = useState(null)

  // Initialize track nodes when tracks change
  const initializeTrackNodes = useCallback(() => {
    setNodes((prevNodes) => {
      // Keep only master and effect nodes
      const nonTrackNodes = prevNodes.filter((n) => n.type !== 'track')
      
      // Create track nodes below master
      const trackNodes = tracks.map((track, idx) => ({
        id: `track-${track.id}`,
        trackId: track.id,
        type: 'track',
        position: { x: 50, y: 200 + idx * 120 },
        label: track.name,
        color: track.color,
        isLocked: false,
      }))

      return [...trackNodes, ...nonTrackNodes]
    })
  }, [tracks])

  const addEffectNode = useCallback((effectType, sourceNodeId) => {
    const effect = AVAILABLE_EFFECTS.find((e) => e.id === effectType)
    if (!effect) return

    const newNodeId = `effect-${Date.now()}`
    const sourceNode = nodes.find((n) => n.id === sourceNodeId)
    
    // Position the effect node slightly to the right of the source
    const newPosition = sourceNode
      ? { x: sourceNode.position.x + 200, y: sourceNode.position.y }
      : { x: 500, y: 200 }

    const newNode = {
      id: newNodeId,
      type: 'effect',
      effectType: effectType,
      position: newPosition,
      label: effect.name,
      params: { ...effect.params },
      isLocked: false,
    }

    setNodes((prev) => [...prev, newNode])

    // Find existing connection that points to target (if any)
    const existingConnToTarget = connections.find((c) => c.source === sourceNodeId)
    if (existingConnToTarget) {
      // Redirect connection chain: source -> effect, effect -> original target
      setConnections((prev) => [
        ...prev.filter((c) => c.id !== existingConnToTarget.id),
        {
          id: `conn-${sourceNodeId}-${newNodeId}`,
          source: sourceNodeId,
          target: newNodeId,
        },
        {
          id: `conn-${newNodeId}-${existingConnToTarget.target}`,
          source: newNodeId,
          target: existingConnToTarget.target,
        },
      ])
    } else {
      // Create new connection from source to effect
      setConnections((prev) => [
        ...prev,
        {
          id: `conn-${sourceNodeId}-${newNodeId}`,
          source: sourceNodeId,
          target: newNodeId,
        },
      ])
    }

    return newNodeId
  }, [nodes, connections])

  const removeNode = useCallback((nodeId) => {
    const node = nodes.find((n) => n.id === nodeId)
    if (node?.isLocked) return

    // Get all connections involving this node
    const relatedConnections = connections.filter(
      (c) => c.source === nodeId || c.target === nodeId
    )

    // If node has inbound and outbound connections, chain them together
    const inbound = relatedConnections.find((c) => c.target === nodeId)
    const outbound = relatedConnections.filter((c) => c.source === nodeId)

    if (inbound && outbound.length > 0) {
      // Create new connections from inbound source to all outbound targets
      const newConnections = outbound.map((out) => ({
        id: `conn-${inbound.source}-${out.target}`,
        source: inbound.source,
        target: out.target,
      }))
      setConnections((prev) =>
        [
          ...prev.filter((c) => !relatedConnections.find((rc) => rc.id === c.id)),
          ...newConnections,
        ]
      )
    } else {
      // Just remove the connections
      setConnections((prev) =>
        prev.filter((c) => !relatedConnections.find((rc) => rc.id === c.id))
      )
    }

    setNodes((prev) => prev.filter((n) => n.id !== nodeId))
    setSelectedNodeId(null)
  }, [nodes, connections])

  const updateNodePosition = useCallback((nodeId, position) => {
    setNodes((prev) =>
      prev.map((n) => (n.id === nodeId ? { ...n, position } : n))
    )
  }, [])

  const updateNodeParams = useCallback((nodeId, params) => {
    setNodes((prev) =>
      prev.map((n) => (n.id === nodeId ? { ...n, params } : n))
    )
  }, [])

  const connectNodes = useCallback((sourceId, targetId) => {
    if (sourceId === targetId) return

    const connectionExists = connections.some(
      (c) => c.source === sourceId && c.target === targetId
    )
    if (connectionExists) return

    // Find all nodes in the path from source to target
    const findPathNodes = (fromId, toId) => {
      const visited = new Set()
      const path = []
      
      const traverse = (nodeId) => {
        if (visited.has(nodeId)) return false
        visited.add(nodeId)
        
        // Find connection from this node
        const outgoing = connections.find((c) => c.source === nodeId)
        if (!outgoing) return false
        
        const nextId = outgoing.target
        
        if (nextId === toId) return true
        
        path.push(nextId)
        return traverse(nextId)
      }
      
      traverse(fromId)
      return path
    }

    // Get nodes between source and target
    const pathNodes = findPathNodes(sourceId, targetId)
    
    // Remove all intermediate nodes and their connections in one batch
    if (pathNodes.length > 0) {
      setNodes((prev) => prev.filter((n) => !pathNodes.includes(n.id)))
      
      // Remove all connections that involve intermediate nodes
      setConnections((prev) =>
        prev.filter((c) => !pathNodes.includes(c.source) && !pathNodes.includes(c.target))
      )
    }

    // Create the new direct connection
    const newConnection = {
      id: `conn-${sourceId}-${targetId}`,
      source: sourceId,
      target: targetId,
    }
    setConnections((prev) => [...prev, newConnection])
  }, [connections])

  const removeConnection = useCallback((connectionId) => {
    setConnections((prev) => prev.filter((c) => c.id !== connectionId))
  }, [])

  const replaceEffectNode = useCallback((nodeId, newEffectType) => {
    const effect = AVAILABLE_EFFECTS.find((e) => e.id === newEffectType)
    if (!effect) return

    setNodes((prev) =>
      prev.map((n) =>
        n.id === nodeId && n.type === 'effect'
          ? {
              ...n,
              effectType: newEffectType,
              label: effect.name,
              params: { ...effect.params },
            }
          : n
      )
    )
  }, [])

  return {
    nodes,
    connections,
    selectedNodeId,
    selectedConnection,
    setSelectedNodeId,
    setSelectedConnection,
    initializeTrackNodes,
    addEffectNode,
    removeNode,
    updateNodePosition,
    updateNodeParams,
    connectNodes,
    removeConnection,
    replaceEffectNode,
    AVAILABLE_EFFECTS,
  }
}
