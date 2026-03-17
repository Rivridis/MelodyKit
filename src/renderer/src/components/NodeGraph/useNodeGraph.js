import { useState, useCallback, useEffect, useRef } from 'react'

const AVAILABLE_EFFECTS = [
  { id: 'reverb', name: 'Reverb', params: { wet: 0.3, decay: 2 } },
  { id: 'delay', name: 'Delay', params: { time: 0.5, feedback: 0.4, wet: 0.3 } },
  { id: 'chorus', name: 'Chorus', params: { rate: 1.5, depth: 0.5, wet: 0.3 } },
  { id: 'distortion', name: 'Distortion', params: { drive: 0.5, tone: 0.5 } },
  { id: 'compressor', name: 'Compressor', params: { threshold: -20, ratio: 4, attack: 0.005, release: 0.1 } },
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
  const pendingAddsRef = useRef([])

  useEffect(() => {
    if (!window?.api?.backend?.onEvent) return

    const unsubscribe = window.api.backend.onEvent((line) => {
      if (typeof line !== 'string' || !line.startsWith('EVENT ')) return

      if (line.startsWith('EVENT EFFECT_ADDED ')) {
        const parts = line.split(' ')
        if (parts.length < 5) return
        const trackId = parts[2]
        const effectId = parts[3]
        const effectType = parts[4]

        const idx = pendingAddsRef.current.findIndex(
          (p) => p.scope === 'track' && p.trackId === trackId && p.effectType === effectType
        )
        if (idx >= 0) {
          const pending = pendingAddsRef.current[idx]
          pendingAddsRef.current.splice(idx, 1)
          setNodes((prev) =>
            prev.map((n) =>
              n.id === pending.nodeId
                ? { ...n, backendEffectId: effectId, backendScope: 'track', backendTrackId: trackId }
                : n
            )
          )
        }
      }

      if (line.startsWith('EVENT MASTER_EFFECT_ADDED ')) {
        const parts = line.split(' ')
        if (parts.length < 4) return
        const effectId = parts[2]
        const effectType = parts[3]

        const idx = pendingAddsRef.current.findIndex(
          (p) => p.scope === 'master' && p.effectType === effectType
        )
        if (idx >= 0) {
          const pending = pendingAddsRef.current[idx]
          pendingAddsRef.current.splice(idx, 1)
          setNodes((prev) =>
            prev.map((n) => (n.id === pending.nodeId ? { ...n, backendEffectId: effectId, backendScope: 'master' } : n))
          )
        }
      }
    })

    return () => {
      if (unsubscribe) unsubscribe()
    }
  }, [])

  const resolveEffectTarget = useCallback(
    (sourceNodeId, sourceNodes = nodes, sourceConnections = connections) => {
      let currentId = sourceNodeId
      const visited = new Set()

      while (currentId && !visited.has(currentId)) {
        visited.add(currentId)
        const node = sourceNodes.find((n) => n.id === currentId)
        if (!node) break

        if (node.type === 'master') return { scope: 'master' }
        if (node.type === 'track') return { scope: 'track', trackId: String(node.trackId ?? String(node.id).replace(/^track-/, '')) }

        const parentConn = sourceConnections.find((c) => c.target === currentId)
        currentId = parentConn ? parentConn.source : null
      }

      return null
    },
    [nodes, connections]
  )

  const getParamIndex = useCallback((effectType, paramKey) => {
    const map = {
      reverb: { wet: 2, decay: 0 },
      delay: { time: 0, feedback: 1, wet: 2 },
      chorus: { rate: 0, depth: 1, wet: 2 },
      distortion: { drive: 0, tone: 1 },
      compressor: { threshold: 0, ratio: 1, attack: 2, release: 3 },
      phaser: { rate: 0, depth: 1 },
      flanger: { rate: 0, depth: 1, wet: 2 },
    }
    return map[effectType]?.[paramKey]
  }, [])

  const normalizeParamValue = useCallback((effectType, paramKey, value) => {
    const ranges = {
      reverb: { wet: [0, 1], decay: [0.1, 5] },
      delay: { time: [0.01, 2], feedback: [0, 0.99], wet: [0, 1] },
      chorus: { rate: [0.1, 10], depth: [0, 1], wet: [0, 1] },
      distortion: { drive: [0, 1], tone: [0, 1] },
      compressor: { threshold: [-60, 0], ratio: [1, 20], attack: [0.001, 0.5], release: [0.01, 3] },
      phaser: { rate: [0.1, 10], depth: [0, 1] },
      flanger: { rate: [0.1, 5], depth: [0, 1], wet: [0, 1] },
    }

    const range = ranges[effectType]?.[paramKey]
    if (!range) return Math.max(0, Math.min(1, Number(value) || 0))

    const [min, max] = range
    const v = Number(value)
    if (!Number.isFinite(v) || max <= min) return 0
    return Math.max(0, Math.min(1, (v - min) / (max - min)))
  }, [])

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

    const target = resolveEffectTarget(sourceNodeId)
    if (!target) {
      console.warn('[NodeGraph] Could not resolve backend target for source node:', sourceNodeId)
      return
    }

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
      backendEffectId: null,
      backendScope: target.scope,
      backendTrackId: target.trackId,
    }

    setNodes((prev) => [...prev, newNode])

    pendingAddsRef.current.push({
      nodeId: newNodeId,
      effectType,
      scope: target.scope,
      trackId: target.trackId,
    })

    if (target.scope === 'master') {
      window.api.backend.addMasterEffect(effectType).catch((e) => {
        console.error('[NodeGraph] addMasterEffect failed:', e)
      })
    } else {
      window.api.backend.addEffect(target.trackId, effectType).catch((e) => {
        console.error('[NodeGraph] addEffect failed:', e)
      })
    }

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
  }, [nodes, connections, resolveEffectTarget])

  const removeNode = useCallback((nodeId) => {
    const node = nodes.find((n) => n.id === nodeId)
    if (node?.isLocked) return

    if (node?.type === 'effect' && node.backendEffectId) {
      if (node.backendScope === 'master') {
        window.api.backend.removeMasterEffect(node.backendEffectId).catch((e) => {
          console.error('[NodeGraph] removeMasterEffect failed:', e)
        })
      } else if (node.backendTrackId) {
        window.api.backend.removeEffect(node.backendTrackId, node.backendEffectId).catch((e) => {
          console.error('[NodeGraph] removeEffect failed:', e)
        })
      }
    }

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
    const node = nodes.find((n) => n.id === nodeId)

    if (node?.type === 'effect' && node.backendEffectId) {
      const prevParams = node.params || {}
      Object.entries(params).forEach(([key, value]) => {
        if (prevParams[key] === value) return

        const paramIndex = getParamIndex(node.effectType, key)
        if (paramIndex === undefined) return

        const normalized = normalizeParamValue(node.effectType, key, value)

        if (node.backendScope === 'master') {
          window.api.backend
            .setMasterEffectParameter(node.backendEffectId, paramIndex, normalized)
            .catch((e) => console.error('[NodeGraph] setMasterEffectParameter failed:', e))
        } else if (node.backendTrackId) {
          window.api.backend
            .setEffectParameter(node.backendTrackId, node.backendEffectId, paramIndex, normalized)
            .catch((e) => console.error('[NodeGraph] setEffectParameter failed:', e))
        }
      })
    }

    setNodes((prev) =>
      prev.map((n) => (n.id === nodeId ? { ...n, params } : n))
    )
  }, [nodes, getParamIndex, normalizeParamValue])

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

    const existing = nodes.find((n) => n.id === nodeId)
    if (existing?.type === 'effect' && existing.backendEffectId) {
      if (existing.backendScope === 'master') {
        window.api.backend.removeMasterEffect(existing.backendEffectId).catch((e) => {
          console.error('[NodeGraph] removeMasterEffect for replace failed:', e)
        })
      } else if (existing.backendTrackId) {
        window.api.backend.removeEffect(existing.backendTrackId, existing.backendEffectId).catch((e) => {
          console.error('[NodeGraph] removeEffect for replace failed:', e)
        })
      }

      pendingAddsRef.current.push({
        nodeId,
        effectType: newEffectType,
        scope: existing.backendScope || 'track',
        trackId: existing.backendTrackId,
      })

      if (existing.backendScope === 'master') {
        window.api.backend.addMasterEffect(newEffectType).catch((e) => {
          console.error('[NodeGraph] addMasterEffect for replace failed:', e)
        })
      } else if (existing.backendTrackId) {
        window.api.backend.addEffect(existing.backendTrackId, newEffectType).catch((e) => {
          console.error('[NodeGraph] addEffect for replace failed:', e)
        })
      }
    }

    setNodes((prev) =>
      prev.map((n) =>
        n.id === nodeId && n.type === 'effect'
          ? {
              ...n,
              effectType: newEffectType,
              label: effect.name,
              params: { ...effect.params },
              backendEffectId: null,
            }
          : n
      )
    )
  }, [nodes])

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
