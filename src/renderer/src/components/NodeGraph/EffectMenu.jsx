const EffectMenu = ({ effects, onSelect, onClose, position }) => {
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-30"
        onClick={onClose}
      />

      {/* Menu */}
      <div
        className="fixed bg-zinc-800 border border-zinc-700 rounded-lg shadow-lg z-40 min-w-48"
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
        }}
      >
        <div className="p-2">
          <p className="text-xs font-semibold text-gray-500 px-2 py-1">Add Effect</p>
          <div className="mt-2 space-y-1">
            {effects.map((effect) => (
              <button
                key={effect.id}
                onClick={() => {
                  onSelect(effect.id)
                  onClose()
                }}
                className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-zinc-700 rounded transition text-xs font-medium"
              >
                {effect.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

export default EffectMenu
