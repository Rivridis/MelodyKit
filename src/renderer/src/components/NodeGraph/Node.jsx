import { memo } from 'react'

const Node = memo(({ 
  node, 
  isSelected, 
  onSelect, 
  onDragStart,
  onDelete,
  onSocketMouseDown,
  onEffectMenuOpen,
  children 
}) => {
  const { id, position, label, type, params } = node

  const handleSocketMouseDown = (e, socketType) => {
    e.stopPropagation()
    if (onSocketMouseDown) {
      onSocketMouseDown(e, id, socketType)
    }
  }

  return (
    <g
      transform={`translate(${position.x}, ${position.y})`}
      className="cursor-move"
      onClick={(e) => {
        if (!e.target.getAttribute('data-socket')) {
          e.stopPropagation()
          onSelect(id)
        }
      }}
      onMouseDown={(e) => {
        const isSocket = e.target.getAttribute('data-socket')
        if (e.button === 0 && onDragStart && !isSocket) {
          e.stopPropagation()
          onDragStart(e, id)
        }
      }}
    >
      {/* Node body */}
      <rect
        x="0"
        y="0"
        width="160"
        height={type === 'track' ? 80 : type === 'master' ? 80 : 140}
        rx="8"
        fill={isSelected ? '#3f3f46' : '#27272a'}
        stroke={isSelected ? '#a1a1a6' : '#52525b'}
        strokeWidth="2"
      />

      {/* Header */}
      <rect
        x="0"
        y="0"
        width="160"
        height="32"
        rx="8"
        fill={
          type === 'track'
            ? node.color || '#6b7280'
            : type === 'master'
            ? '#7c3aed'
            : '#f59e0b'
        }
        opacity="0.8"
      />

      {/* Label */}
      <text
        x="80"
        y="20"
        textAnchor="middle"
        fill="white"
        fontSize="12"
        fontWeight="bold"
        pointerEvents="none"
      >
        {label}
      </text>

      {/* Input socket - only for effect nodes */}
      {type === 'effect' && (
        <circle
          cx="0"
          cy={70}
          r="6"
          fill="#10b981"
          className="hover:fill-emerald-400 cursor-pointer"
          data-socket="input"
          onMouseDown={(e) => handleSocketMouseDown(e, 'input')}
        />
      )}

      {/* Output socket */}
      <circle
        cx="160"
        cy={type === 'track' ? 40 : type === 'master' ? 40 : 70}
        r="6"
        fill="#3b82f6"
        className="hover:fill-blue-400 cursor-pointer"
        data-socket="output"
        onMouseDown={(e) => handleSocketMouseDown(e, 'output')}
      />

      {/* Params display */}
      {type === 'effect' && params && (
        <g>
          {Object.entries(params).slice(0, 3).map(([key, value], idx) => (
            <text
              key={key}
              x="8"
              y={50 + idx * 18}
              fill="#a1a1a6"
              fontSize="10"
              pointerEvents="none"
            >
              {key}: {typeof value === 'number' ? value.toFixed(2) : value}
            </text>
          ))}
        </g>
      )}

      {/* Menu button for effect nodes */}
      {type === 'effect' && (
        <g
          onClick={(e) => {
            e.stopPropagation()
            if (onEffectMenuOpen) {
              const rect = e.currentTarget.getBoundingClientRect()
              onEffectMenuOpen(id, rect.left, rect.top + rect.height)
            }
          }}
          style={{ cursor: 'pointer' }}
        >
          <rect
            x="130"
            y="2"
            width="26"
            height="26"
            fill="transparent"
          />
          <text
            x="143"
            y="17"
            textAnchor="middle"
            dominantBaseline="middle"
            fill="white"
            fontSize="16"
            fontWeight="normal"
            pointerEvents="none"
          >
            ⋯
          </text>
        </g>
      )}

      {children}
    </g>
  )
})

Node.displayName = 'Node'

export default Node
