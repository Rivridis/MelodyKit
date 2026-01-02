import { useRef, useEffect, useState } from 'react'

const POINT_RADIUS = 6
const SIDEBAR_WIDTH = 180

function AutomationLane({ trackId, automationType, beatWidth, zoom, trackColor, points, onPointsChange, onClose }) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const [draggingPoint, setDraggingPoint] = useState(null)
  const [hoveredPoint, setHoveredPoint] = useState(null)

  const beatToX = (beat) => {
    return SIDEBAR_WIDTH + beat * beatWidth * zoom
  }

  const xToBeat = (x) => {
    return Math.max(0, (x - SIDEBAR_WIDTH) / (beatWidth * zoom))
  }

  const valueToY = (value, height) => {
    return height * (1 - value)
  }

  const yToValue = (y, height) => {
    return Math.max(0, Math.min(1, 1 - y / height))
  }

  const findPointAt = (x, y, height) => {
    const clickRadius = POINT_RADIUS + 3
    for (let i = 0; i < points.length; i++) {
      const px = beatToX(points[i].beat)
      const py = valueToY(points[i].value, height)
      const dist = Math.sqrt((x - px) ** 2 + (y - py) ** 2)
      if (dist <= clickRadius) {
        return i
      }
    }
    return -1
  }

  const handleMouseDown = (e) => {
    const canvas = canvasRef.current
    if (!canvas) return
    
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    if (x < SIDEBAR_WIDTH) return

    const pointIndex = findPointAt(x, y, rect.height)
    
    if (pointIndex >= 0) {
      // Start dragging existing point
      setDraggingPoint(pointIndex)
    } else {
      // Create new point
      const beat = xToBeat(x)
      const value = yToValue(y, rect.height)
      const newPoints = [...points, { beat, value }]
      newPoints.sort((a, b) => a.beat - b.beat)
      onPointsChange?.(newPoints)
      setDraggingPoint(newPoints.findIndex(p => p.beat === beat && p.value === value))
    }
  }

  const handleMouseMove = (e) => {
    const canvas = canvasRef.current
    if (!canvas) return
    
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    if (draggingPoint !== null) {
      const beat = xToBeat(x)
      const value = yToValue(y, rect.height)
      
      const newPoints = [...points]
      newPoints[draggingPoint] = { beat, value }
      newPoints.sort((a, b) => a.beat - b.beat)
      onPointsChange?.(newPoints)
    } else {
      // Update hover state
      const pointIndex = findPointAt(x, y, rect.height)
      setHoveredPoint(pointIndex)
    }
  }

  const handleMouseUp = () => {
    setDraggingPoint(null)
  }

  const handleDoubleClick = (e) => {
    const canvas = canvasRef.current
    if (!canvas) return
    
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    const pointIndex = findPointAt(x, y, rect.height)
    if (pointIndex >= 0 && points.length > 1) {
      // Delete point (but keep at least 1 point)
      const newPoints = points.filter((_, i) => i !== pointIndex)
      onPointsChange?.(newPoints)
    }
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx.scale(dpr, dpr)

    // Clear canvas
    ctx.clearRect(0, 0, rect.width, rect.height)

    // Draw semi-transparent overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
    ctx.fillRect(0, 0, rect.width, rect.height)

    // Draw grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
    ctx.lineWidth = 1
    
    // Vertical grid lines (beats)
    const scaledBeatWidth = beatWidth * zoom
    for (let i = 0; i < rect.width / scaledBeatWidth; i++) {
      const x = SIDEBAR_WIDTH + i * scaledBeatWidth
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, rect.height)
      ctx.stroke()
    }

    // Horizontal grid lines
    const horizontalLines = 4
    for (let i = 0; i <= horizontalLines; i++) {
      const y = (rect.height / horizontalLines) * i
      ctx.beginPath()
      ctx.moveTo(SIDEBAR_WIDTH, y)
      ctx.lineTo(rect.width, y)
      ctx.stroke()
    }

    // Draw center line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(SIDEBAR_WIDTH, rect.height / 2)
    ctx.lineTo(rect.width, rect.height / 2)
    ctx.stroke()

    // Draw automation curve
    if (points.length >= 1) {
      ctx.strokeStyle = trackColor || '#3b82f6'
      ctx.lineWidth = 2
      ctx.beginPath()
      
      const sortedPoints = [...points].sort((a, b) => a.beat - b.beat)
      
      // Start from the left edge (using first point's value)
      const firstValue = sortedPoints[0].value
      ctx.moveTo(SIDEBAR_WIDTH, valueToY(firstValue, rect.height))
      
      // Draw to first point and through all points
      for (let i = 0; i < sortedPoints.length; i++) {
        const x = beatToX(sortedPoints[i].beat)
        const y = valueToY(sortedPoints[i].value, rect.height)
        ctx.lineTo(x, y)
      }
      
      // Extend to the right edge (using last point's value)
      const lastValue = sortedPoints[sortedPoints.length - 1].value
      ctx.lineTo(rect.width, valueToY(lastValue, rect.height))
      
      ctx.stroke()
      
      // Draw points
      sortedPoints.forEach((point, i) => {
        const x = beatToX(point.beat)
        const y = valueToY(point.value, rect.height)
        
        // Point fill
        ctx.fillStyle = trackColor || '#3b82f6'
        ctx.beginPath()
        ctx.arc(x, y, POINT_RADIUS, 0, Math.PI * 2)
        ctx.fill()
        
        // Point outline (highlight if hovered or dragging)
        if (i === hoveredPoint || i === draggingPoint) {
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(x, y, POINT_RADIUS + 2, 0, Math.PI * 2)
          ctx.stroke()
        }
      })
    }

  }, [beatWidth, zoom, trackColor, points, hoveredPoint, draggingPoint])

  const getAutomationLabel = () => {
    switch (automationType) {
      case 'volume': return 'Volume'
      case 'pan': return 'Pan'
      case 'resonance': return 'Resonance'
      case 'cutoff': return 'Cutoff'
      default: return automationType
    }
  }

  return (
    <div ref={containerRef} className="relative w-full h-full">
      {/* Sidebar label */}
      <div 
        className="absolute left-0 top-0 w-[180px] h-full bg-zinc-900/80 backdrop-blur-sm border-r border-zinc-700 flex items-center justify-between px-3"
        style={{ zIndex: 10 }}
      >
        <span className="text-zinc-300 text-xs font-medium">{getAutomationLabel()}</span>
        <button
          onClick={onClose}
          className="w-5 h-5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors flex items-center justify-center"
          title="Close automation"
        >
          ×
        </button>
      </div>

      {/* Canvas for automation curve */}
      <canvas
        ref={canvasRef}
        className="absolute top-0 w-full h-full cursor-crosshair"
        style={{ left: 0 }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
      />
    </div>
  )
}

export default AutomationLane
