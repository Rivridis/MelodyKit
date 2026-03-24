import { useState } from 'react'

function TrackLimitModal({ isOpen, onClose }) {
  if (!isOpen) return null

  const handleBackdropMouseDown = (e) => {
    if (e.target !== e.currentTarget) return
    onClose?.()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className="w-[500px] max-w-[90vw] rounded-2xl border border-zinc-700 bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-950 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b border-zinc-700/70 px-6 py-4">
          <h2 className="text-xl font-semibold text-zinc-100">Track Limit Reached</h2>
        </div>

        {/* Content */}
        <div className="px-6 py-6 space-y-4">
          <p className="text-zinc-300">
            You've reached the maximum of <span className="font-semibold text-amber-400">6 tracks</span> in the free version.
          </p>

          <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-4">
            <p className="text-sm text-zinc-400">
              Upgrade to the premium version to unlock unlimited tracks and access advanced features.
            </p>
          </div>

          <div className="space-y-3 pt-2">
            <h3 className="text-sm font-semibold text-zinc-300">Premium Features:</h3>
            <ul className="space-y-2 text-sm text-zinc-400">
              <li className="flex items-start">
                <span className="mr-2 text-amber-400">✓</span>
                <span>Unlimited tracks</span>
              </li>
              <li className="flex items-start">
                <span className="mr-2 text-amber-400">✓</span>
                <span>Advanced effects and automation</span>
              </li>
              <li className="flex items-start">
                <span className="mr-2 text-amber-400">✓</span>
                <span>Priority support</span>
              </li>
            </ul>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-zinc-700/70 flex gap-3 px-6 py-4">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100 font-medium transition-colors"
          >
            Close
          </button>
          <button
            onClick={() => {
              window.open('https://www.rivridis.com/melodykit', '_blank')
              onClose?.()
            }}
            className="flex-1 px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white font-medium transition-colors"
          >
            Upgrade Now
          </button>
        </div>
      </div>
    </div>
  )
}

export default TrackLimitModal
