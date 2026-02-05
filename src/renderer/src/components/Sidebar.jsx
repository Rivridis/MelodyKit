import { useState, useRef, useEffect } from 'react'
import InstrumentSelector from './InstrumentSelector'
import VSTSelector from './VSTSelector'
import { openVSTEditor } from '@renderer/utils/vstBackend'

function Sidebar({
  tracks,
  selectedTrackId,
  onSelectTrack,
  onOpenAddTrackModal,
  onDeleteTrack,
  onRenameTrack,
  onDuplicateTrack,
  isRestoring,
  trackAutomation,
  onAutomationChange,
  trackInstruments,
  trackVSTMode,
  trackVSTPlugins,
  trackVSTLoading,
  trackSamplerPaths,
  onChangeInstrument,
  onChangeVst,
  onChangeSample,
  onCreateInstrumentTrack,
  onCreateLoopTrack
}) {
  const [editingTrackId, setEditingTrackId] = useState(null)
  const [editName, setEditName] = useState('')
  const [openMenuTrackId, setOpenMenuTrackId] = useState(null)
  const menuRef = useRef(null)
  const [instrumentPickerTrackId, setInstrumentPickerTrackId] = useState(null)
  const [vstPickerTrackId, setVstPickerTrackId] = useState(null)
  const [activeTab, setActiveTab] = useState('tracks')
  const [packsLoading, setPacksLoading] = useState(false)
  const [packInstruments, setPackInstruments] = useState([])
  const [sequencerPacks, setSequencerPacks] = useState([])
  const [sequencerSoundsByPack, setSequencerSoundsByPack] = useState({})
  const [expandedInstrumentCategory, setExpandedInstrumentCategory] = useState(null)
  const [expandedSequencerPack, setExpandedSequencerPack] = useState(null)
  const [loopPacks, setLoopPacks] = useState([])
  const [loopSoundsByPack, setLoopSoundsByPack] = useState({})
  const [expandedLoopPack, setExpandedLoopPack] = useState(null)

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
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpenMenuTrackId(null)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const getBaseName = (value) => {
    if (!value) return ''
    const normalized = value.replaceAll('\\', '/')
    return normalized.split('/').pop() || value
  }

  const openInstrumentPicker = (trackId) => {
    if (instrumentPickerTrackId === trackId) return
    setTimeout(() => setInstrumentPickerTrackId(trackId), 0)
  }

  const openVstPicker = (trackId) => {
    if (vstPickerTrackId === trackId) return
    setTimeout(() => setVstPickerTrackId(trackId), 0)
  }

  useEffect(() => {
    if (activeTab !== 'packs') return
    let mounted = true
    const load = async () => {
      setPacksLoading(true)
      try {
        if (!window.api?.getInstruments || !window.api?.sequencer?.listPacks) {
          setPackInstruments([])
          setSequencerPacks([])
          setSequencerSoundsByPack({})
          setLoopPacks([])
          setLoopSoundsByPack({})
          setPacksLoading(false)
          return
        }
        const instruments = await window.api.getInstruments()
        const packs = await window.api.sequencer.listPacks()
        const loops = await window.api?.loops?.listPacks?.()
        if (!mounted) return
        setPackInstruments(instruments || [])
        setSequencerPacks(packs || [])
        setSequencerSoundsByPack({})
        setLoopPacks(loops || [])
        setLoopSoundsByPack({})
      } catch (e) {
        console.error('Failed to load packs view:', e)
        if (!mounted) return
        setPackInstruments([])
        setSequencerPacks([])
        setSequencerSoundsByPack({})
        setLoopPacks([])
        setLoopSoundsByPack({})
      } finally {
        if (mounted) setPacksLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [activeTab])

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
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-lg font-semibold">
            <button
              onClick={() => setActiveTab('tracks')}
              className={`transition ${activeTab === 'tracks' ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              Tracks
            </button>
            <span className="text-zinc-600">/</span>
            <button
              onClick={() => setActiveTab('packs')}
              className={`transition ${activeTab === 'packs' ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              Packs
            </button>
          </div>
          {activeTab === 'tracks' && (
            <button
              onClick={onOpenAddTrackModal}
              disabled={isRestoring}
              title="Add track"
              aria-label="Add track"
              className="inline-flex items-center justify-center h-8 w-8 rounded-md text-white
                         bg-zinc-800 hover:bg-zinc-700 ring-1 ring-inset ring-zinc-700
                         shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-zinc-800"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                <path d="M11 5h2v14h-2z"></path>
                <path d="M5 11h14v2H5z"></path>
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Track List */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'tracks' ? (
          tracks.length === 0 ? (
          <div className="p-4 text-zinc-500 text-sm text-center">
            No tracks yet. Click "Add Track" to get started.
          </div>
        ) : (
          <div className="p-2">
            {tracks.map((track, index) => (
              <div
                key={track.id}
                onClick={() => {
                  if (track.type === 'audio') return
                  onSelectTrack(track.id)
                }}
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
                    {track.type === 'beat' ? (
                      <div className="text-white text-sm font-medium">Beat Track</div>
                    ) : track.type === 'audio' ? (
                      <div className="text-white text-sm font-medium">Audio Track</div>
                    ) : (trackVSTMode?.[track.id] || trackVSTPlugins?.[track.id]) ? (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            if (trackVSTLoading?.[track.id]) return
                            openVstPicker(track.id)
                          }}
                          className={`flex-1 rounded-md border border-zinc-700/70 bg-zinc-900/60 px-3 py-2 text-left text-sm font-medium text-white transition hover:border-zinc-600 hover:bg-zinc-800/70 ${
                            trackVSTLoading?.[track.id] ? 'opacity-60 cursor-wait' : ''
                          }`}
                        >
                          <span className="block truncate">
                            {trackVSTLoading?.[track.id]
                              ? 'Loading VST...'
                              : (trackVSTPlugins?.[track.id] ? getBaseName(trackVSTPlugins[track.id]).replace('.vst3', '') : 'Select VST')}
                          </span>
                        </button>
                        <button
                          onClick={async (e) => {
                            e.stopPropagation()
                            if (trackVSTLoading?.[track.id]) return
                            await openVSTEditor(track.id)
                          }}
                          title="Open VST editor"
                          className={`h-9 w-9 rounded-md border border-zinc-700/70 bg-zinc-900/60 text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800/70 flex items-center justify-center ${
                            trackVSTLoading?.[track.id] ? 'opacity-60 cursor-wait' : ''
                          }`}
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                            <path d="M5 3h2v18H5zM4 7h4v2H4zM11 3h2v18h-2zM10 11h4v2h-4zM17 3h2v18h-2zM16 5h4v2h-4z"></path>
                          </svg>
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          if (track.type === 'sampler') {
                            onChangeSample?.(track.id)
                            return
                          }
                          openInstrumentPicker(track.id)
                        }}
                        className="w-full rounded-md border border-zinc-700/70 bg-zinc-900/60 px-3 py-2 text-left text-sm font-medium text-white transition hover:border-zinc-600 hover:bg-zinc-800/70"
                      >
                        <span className="block truncate">
                          {track.type === 'sampler'
                            ? (trackSamplerPaths?.[track.id] ? getBaseName(trackSamplerPaths[track.id]) : 'Select sample')
                            : (trackInstruments?.[track.id]?.name || 'Select instrument')}
                        </span>
                      </button>
                    )}
                    <div className="mt-2 text-zinc-500 text-xs flex items-center gap-2">
                      {editingTrackId === track.id ? (
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onBlur={() => handleRenameSubmit(track.id)}
                          onKeyDown={(e) => handleKeyDown(e, track.id)}
                          className="w-full bg-zinc-700 text-white px-2 py-1 rounded text-xs outline-none focus:ring-2 focus:ring-amber-500"
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span className="truncate">{track.name}</span>
                      )}
                      <span className="text-zinc-600">•</span>
                      <span>{track.noteCount || 0} notes</span>
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
        )
        ) : (
          <div className="p-3 space-y-4">
            {packsLoading ? (
              <div className="text-zinc-500 text-sm">Loading packs…</div>
            ) : (
              <>
                <div className="space-y-2">
                  <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-400">SF2 Instruments</div>
                  <div className="h-3" />
                  {packInstruments.length === 0 ? (
                    <div className="text-zinc-500 text-sm">No instruments found.</div>
                  ) : (
                    <div className="space-y-2">
                      {Array.from(new Set(packInstruments.map(i => i.folderName || i.category || 'Other'))).map((group) => {
                        const isExpanded = expandedInstrumentCategory === group
                        return (
                          <div key={group}>
                            <button
                              onClick={() => setExpandedInstrumentCategory(isExpanded ? null : group)}
                              className={`w-full flex items-center justify-between rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                                isExpanded
                                  ? 'border-amber-500/50 bg-gradient-to-r from-amber-500/20 to-zinc-900/40 text-amber-100'
                                  : 'border-zinc-700/70 bg-zinc-900/60 text-zinc-200 hover:bg-zinc-800/70'
                              }`}
                            >
                              <span>{group}</span>
                              <span className="text-zinc-500">{isExpanded ? '−' : '+'}</span>
                            </button>
                            {isExpanded && (
                              <div className="mt-3 flex flex-col gap-1 pl-2">
                                {packInstruments
                                  .filter(i => (i.folderName || i.category || 'Other') === group)
                                  .map((i) => (
                                    <button
                                      key={i.samplePath || i.name}
                                      onClick={() => onCreateInstrumentTrack?.(i)}
                                      className="w-full rounded-md border border-zinc-700/70 bg-zinc-900/60 px-2.5 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800/70"
                                      title={i.samplePath}
                                    >
                                      {i.name}
                                    </button>
                                  ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="h-3" />
                  <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-400">Sequencer Packs</div>
                  <div className="h-3" />
                  {sequencerPacks.length === 0 ? (
                    <div className="text-zinc-500 text-sm">No packs found.</div>
                  ) : (
                    <div className="space-y-3">
                      {sequencerPacks.map((pack) => {
                        const isExpanded = expandedSequencerPack === pack
                        const sounds = sequencerSoundsByPack[pack] || []
                        return (
                          <div key={pack}>
                            <button
                              onClick={async () => {
                                const next = isExpanded ? null : pack
                                setExpandedSequencerPack(next)
                                if (next && !sequencerSoundsByPack[pack]) {
                                  const list = await window.api?.sequencer?.listSounds?.(pack)
                                  setSequencerSoundsByPack((prev) => ({ ...prev, [pack]: list || [] }))
                                }
                              }}
                              className={`w-full flex items-center justify-between rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                                isExpanded
                                  ? 'border-amber-500/50 bg-gradient-to-r from-amber-500/20 to-zinc-900/40 text-amber-100'
                                  : 'border-zinc-700/70 bg-zinc-900/60 text-zinc-200 hover:bg-zinc-800/70'
                              }`}
                            >
                              <span>{pack}</span>
                              <span className="text-zinc-500">{isExpanded ? '−' : '+'}</span>
                            </button>
                            {isExpanded && (
                              <div className="mt-3 flex flex-col gap-1 pl-2">
                                {(sounds || []).map((s) => (
                                  <div
                                    key={`${pack}:${s.fileName}`}
                                    className="w-full rounded-md border border-zinc-700/70 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-zinc-200"
                                    title={s.filePath}
                                  >
                                    {s.name}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="h-3" />
                  <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-400">Loop Packs</div>
                  <div className="h-3" />
                  {loopPacks.length === 0 ? (
                    <div className="text-zinc-500 text-sm">No loop packs found.</div>
                  ) : (
                    <div className="space-y-3">
                      {loopPacks.map((pack) => {
                        const isExpanded = expandedLoopPack === pack
                        const sounds = loopSoundsByPack[pack] || []
                        return (
                          <div key={pack}>
                            <button
                              onClick={async () => {
                                const next = isExpanded ? null : pack
                                setExpandedLoopPack(next)
                                if (next && !loopSoundsByPack[pack]) {
                                  const list = await window.api?.loops?.listSounds?.(pack)
                                  setLoopSoundsByPack((prev) => ({ ...prev, [pack]: list || [] }))
                                }
                              }}
                              className={`w-full flex items-center justify-between rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                                isExpanded
                                  ? 'border-amber-500/50 bg-gradient-to-r from-amber-500/20 to-zinc-900/40 text-amber-100'
                                  : 'border-zinc-700/70 bg-zinc-900/60 text-zinc-200 hover:bg-zinc-800/70'
                              }`}
                            >
                              <span>{pack}</span>
                              <span className="text-zinc-500">{isExpanded ? '−' : '+'}</span>
                            </button>
                            {isExpanded && (
                              <div className="mt-3 flex flex-col gap-1 pl-2">
                                {(sounds || []).map((s) => (
                                  <button
                                    key={`${pack}:${s.fileName}`}
                                    onClick={() => onCreateLoopTrack?.(s)}
                                    className="w-full rounded-md border border-zinc-700/70 bg-zinc-900/60 px-2.5 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800/70"
                                    title={s.filePath}
                                  >
                                    {s.name}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Footer info */}
      <div className="p-3 border-t border-zinc-800 text-zinc-500 text-xs">
        {activeTab === 'tracks' ? (
          <>
            <div className="mb-1">Double-click to rename</div>
            <div>Right-click notes to delete</div>
          </>
        ) : (
          <div>Click to add a track or audio.</div>
        )}
      </div>
      <InstrumentSelector
        isOpen={instrumentPickerTrackId !== null}
        onClose={() => setInstrumentPickerTrackId(null)}
        onSelectInstrument={(instrument) => {
          if (instrumentPickerTrackId === null) return
          onChangeInstrument?.(instrumentPickerTrackId, instrument)
          setInstrumentPickerTrackId(null)
        }}
        currentInstrument={instrumentPickerTrackId !== null ? trackInstruments?.[instrumentPickerTrackId] : null}
        isLoadingInstrument={false}
      />
      {vstPickerTrackId !== null && (
        <VSTSelector
          selectOnly
          trackId={vstPickerTrackId}
          onClose={() => setVstPickerTrackId(null)}
          onSelectPath={(path) => {
            if (vstPickerTrackId === null) return
            onChangeVst?.(vstPickerTrackId, path)
            setVstPickerTrackId(null)
          }}
        />
      )}
    </div>
  )
}

export default Sidebar
