import { useState, useRef, useEffect } from 'react'

const TRACK_COLORS = [
  '#ef4444', '#f59e0b', '#10b981', '#3b82f6', 
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'
]

function Sidebar({ tracks, selectedTrackId, onSelectTrack, onAddTrack, onAddBeatTrack, onDeleteTrack, onRenameTrack, onDuplicateTrack, isRestoring, trackAutomation, onAutomationChange }) {
  const [editingTrackId, setEditingTrackId] = useState(null)
  const [editName, setEditName] = useState('')
  const [openMenuTrackId, setOpenMenuTrackId] = useState(null)
  const menuRef = useRef(null)

  const handleAddTrack = () => {
    const color = TRACK_COLORS[tracks.length % TRACK_COLORS.length]
    onAddTrack(color)
  }
  const handleAddBeat = () => {
    onAddBeatTrack?.()
  }

  const handleDoubleClick = (track) => {
    setEditingTrackId(track.id)
    setEditName(track.name)
  }

  const handleRenameSubmit = (trackId) => {
    if (editName.trim()) {
      onRenameTrack(trackId, editName.trim())
    }
    setEditingTrackId(null)
    setEditName('')
  }

  const handleKeyDown = (e, trackId) => {
    if (e.key === 'Enter') {
      handleRenameSubmit(trackId)
    } else if (e.key === 'Escape') {
      setEditingTrackId(null)
      setEditName('')
    }
  }

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setOpenMenuTrackId(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleDuplicate = (trackId) => {
    setOpenMenuTrackId(null)
    onDuplicateTrack?.(trackId)
  }

  const handleAutomation = (trackId) => {
    setOpenMenuTrackId(null)
    const currentAuto = trackAutomation?.[trackId]
    if (currentAuto?.enabled) {
      // Toggle off - preserve data
      onAutomationChange?.(trackId, { ...currentAuto, enabled: false })
    } else {
      // Toggle on - preserve existing data if available, otherwise create defaults
      onAutomationChange?.(trackId, { 
        enabled: true, 
        type: currentAuto?.type || 'volume',
        data: currentAuto?.data || {
          volume: [{ beat: 0, value: 0.5 }],
          pan: [{ beat: 0, value: 0.5 }],
          resonance: [{ beat: 0, value: 0.5 }],
          cutoff: [{ beat: 0, value: 0.5 }]
        }
      })
    }
  }

  const handleAutomationTypeChange = (trackId, type) => {
    const currentAuto = trackAutomation?.[trackId]
    // Preserve existing data, just change the type
    onAutomationChange?.(trackId, { 
      enabled: true, 
      type,
      data: currentAuto?.data || {
        volume: [{ beat: 0, value: 0.5 }],
        pan: [{ beat: 0, value: 0.5 }],
        resonance: [{ beat: 0, value: 0.5 }],
        cutoff: [{ beat: 0, value: 0.5 }]
      }
    })
  }

  return (
    <div className="w-64 bg-zinc-900 border-r border-zinc-800 flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-zinc-800">
        <h2 className="text-white font-semibold text-lg mb-3">Tracks</h2>
        <button
          onClick={handleAddTrack}
          disabled={isRestoring}
          title="Add Track"
          aria-label="Add Track"
          className="relative inline-flex items-center justify-center h-9 w-full px-10 rounded-md text-sm font-medium text-white
                     bg-zinc-800 hover:bg-zinc-700 ring-1 ring-inset ring-zinc-700
                     shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-zinc-800"
        >
          <span
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2
                       inline-flex items-center justify-center w-5 h-5 rounded-full
                       bg-zinc-700 ring-1 ring-inset ring-zinc-600 text-zinc-200"
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M11 5h2v14h-2z"></path>
              <path d="M5 11h14v2H5z"></path>
            </svg>
          </span>
          <span className="text-center leading-none">Add Track</span>
        </button>
        <button
          onClick={handleAddBeat}
          disabled={isRestoring}
          title="Add Beat Track"
          aria-label="Add Beat Track"
          className="mt-2 relative inline-flex items-center justify-center h-9 w-full px-10 rounded-md text-sm font-medium text-white
                     bg-zinc-800 hover:bg-zinc-700 ring-1 ring-inset ring-zinc-700
                     shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-zinc-800"
        >
          <span
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2
                       inline-flex items-center justify-center w-5 h-5 rounded-full
                       bg-zinc-700 ring-1 ring-inset ring-zinc-600 text-zinc-200"
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M11 5h2v14h-2z"></path>
              <path d="M5 11h14v2H5z"></path>
            </svg>
          </span>
          <span className="text-center leading-none">Add Beat</span>
        </button>
      </div>

      {/* Track List */}
      <div className="flex-1 overflow-y-auto">
        {tracks.length === 0 ? (
          <div className="p-4 text-zinc-500 text-sm text-center">
            No tracks yet. Click "Add Track" to get started.
          </div>
        ) : (
          <div className="p-2">
            {tracks.map((track, index) => (
              <div
                key={track.id}
                onClick={() => onSelectTrack(track.id)}
                onDoubleClick={() => handleDoubleClick(track)}
                className={`
                  mb-2 p-3 rounded-lg cursor-pointer transition-all
                  ${selectedTrackId === track.id 
                    ? 'bg-zinc-800 ring-2 ring-amber-500' 
                    : 'bg-zinc-800/50 hover:bg-zinc-800'
                  }
                `}
              >
                <div className="flex items-center gap-3">
                  {/* Color indicator */}
                  <div
                    className="w-4 h-4 rounded-full flex-shrink-0"
                    style={{ backgroundColor: track.color }}
                  />
                  
                  {/* Track name */}
                  <div className="flex-1 min-w-0">
                    {editingTrackId === track.id ? (
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onBlur={() => handleRenameSubmit(track.id)}
                        onKeyDown={(e) => handleKeyDown(e, track.id)}
                        className="w-full bg-zinc-700 text-white px-2 py-1 rounded text-sm outline-none focus:ring-2 focus:ring-amber-500"
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <div className="text-white text-sm font-medium truncate">
                        {track.name}
                      </div>
                    )}
                    <div className="text-zinc-500 text-xs mt-1">
                      {track.noteCount || 0} notes
                    </div>
                  </div>

                  {/* Cog menu button */}
                  <div className="relative" ref={openMenuTrackId === track.id ? menuRef : null}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpenMenuTrackId(openMenuTrackId === track.id ? null : track.id)
                      }}
                      className="flex-shrink-0 w-6 h-6 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300 transition-colors flex items-center justify-center"
                      title="Track options"
                    >
                      ⚙
                    </button>
                    
                    {/* Dropdown menu */}
                    {openMenuTrackId === track.id && (
                      <div className="absolute right-0 top-full mt-1 w-40 bg-zinc-900 border border-zinc-700 rounded-md shadow-lg z-50">
                        <ul className="py-1">
                          <li>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                handleDuplicate(track.id)
                              }}
                              className="w-full text-left px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 transition-colors"
                            >
                              Duplicate
                            </button>
                          </li>
                          <li>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                setOpenMenuTrackId(null)
                                handleAutomation(track.id)
                              }}
                              className="w-full text-left px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 transition-colors"
                            >
                              Automation
                            </button>
                          </li>
                        </ul>
                      </div>
                    )}
                  </div>

                  {/* Delete button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteTrack(track.id)
                    }}
                    className="flex-shrink-0 w-6 h-6 rounded hover:bg-red-600/20 text-zinc-500 hover:text-red-500 transition-colors flex items-center justify-center"
                    title="Delete track"
                  >
                    ×
                  </button>
                </div>

                {/* Automation Type Selector */}
                {trackAutomation?.[track.id]?.enabled && (
                  <div className="mt-2 pt-2 border-t border-zinc-700" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-400 text-xs">Automation:</span>
                      <select
                        value={trackAutomation[track.id]?.type || 'volume'}
                        onChange={(e) => {
                          e.stopPropagation()
                          handleAutomationTypeChange(track.id, e.target.value)
                        }}
                        className="flex-1 bg-zinc-800 text-zinc-200 text-xs px-2 py-1 rounded border border-zinc-700 hover:border-zinc-600 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 transition-colors"
                      >
                        <option value="volume">Volume</option>
                        <option value="pan" disabled>Pan</option>
                        <option value="resonance" disabled>Resonance</option>
                        <option value="cutoff" disabled>Cutoff</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer info */}
      <div className="p-3 border-t border-zinc-800 text-zinc-500 text-xs">
        <div className="mb-1">Double-click to rename</div>
        <div>Right-click notes to delete</div>
      </div>
    </div>
  )
}

export default Sidebar
