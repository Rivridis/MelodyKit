import { useEffect, useRef } from 'react'

const ReplaceEffectMenu = ({ nodeId, effects, onDelete, onReplace, onClose, position }) => {
  const menuRef = useRef(null)

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  return (
    <div
      ref={menuRef}
      className="absolute bg-zinc-800 border border-zinc-700 rounded shadow-lg z-50 py-1"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
      }}
    >
      {/* Delete option */}
      <button
        onClick={() => {
          onDelete(nodeId)
          onClose()
        }}
        className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-zinc-700 transition"
      >
        Delete Effect
      </button>

      {/* Separator */}
      <div className="border-t border-zinc-700 my-1" />

      {/* Replace submenu */}
      <div className="relative group">
        <button className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-zinc-700 transition flex items-center justify-between">
          Replace Effect
          <span className="ml-2">›</span>
        </button>

        {/* Submenu */}
        <div className="absolute left-full top-0 hidden group-hover:block bg-zinc-800 border border-zinc-700 rounded shadow-lg py-1 min-w-40">
          {effects.map((effect) => (
            <button
              key={effect.id}
              onClick={() => {
                onReplace(nodeId, effect.id)
                onClose()
              }}
              className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-zinc-700 transition"
            >
              {effect.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default ReplaceEffectMenu
