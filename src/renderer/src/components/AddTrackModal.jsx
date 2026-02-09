import { useEffect, useState } from 'react'
import InstrumentSelector from './InstrumentSelector'
import VSTSelector from './VSTSelector'

const TRACK_TYPES = [
  { id: 'instrument', label: 'Instrument', desc: 'SF2 or built-in instruments', badge: 'I' },
  { id: 'vst', label: 'VST', desc: 'Load a VST3 plugin', badge: 'V' },
  { id: 'sampler', label: 'Sampler', desc: 'Trigger a single audio sample', badge: 'S' },
  { id: 'beat', label: 'Beat', desc: 'Step sequencer track', badge: 'B' }
]

function AddTrackModal({ isOpen, onClose, onCreateInstrumentTrack, onCreateVstTrack, onCreateSamplerTrack, onCreateBeatTrack }) {
  const [selectedType, setSelectedType] = useState('instrument')
  const [selectedInstrument, setSelectedInstrument] = useState(null)
  const [selectedVstPath, setSelectedVstPath] = useState('')
  const [selectedSample, setSelectedSample] = useState(null)
  const [showInstrumentSelector, setShowInstrumentSelector] = useState(false)
  const [showVstSelector, setShowVstSelector] = useState(false)
  const [beatPacks, setBeatPacks] = useState([])
  const [selectedBeatPack, setSelectedBeatPack] = useState('')

  useEffect(() => {
    if (!isOpen) return
    setSelectedType('instrument')
    setSelectedInstrument(null)
    setSelectedVstPath('')
    setSelectedSample(null)
    setShowInstrumentSelector(false)
    setShowVstSelector(false)
    ;(async () => {
      try {
        const packs = await window.api?.sequencer?.listPacks?.()
        if (Array.isArray(packs)) {
          setBeatPacks(packs)
          setSelectedBeatPack(packs[0] || '')
        }
      } catch (err) {
        console.error('Failed to load beat packs:', err)
        setBeatPacks([])
        setSelectedBeatPack('')
      }
    })()
  }, [isOpen])

  if (!isOpen) return null

  const handleChooseSample = async () => {
    try {
      const res = await window.api?.openSampleFile?.()
      if (!res || !res.ok || res.canceled) return
      setSelectedSample({ path: res.path, name: res.name })
    } catch (err) {
      console.error('Failed to select sample:', err)
    }
  }

  const canCreate =
    (selectedType === 'instrument' && !!selectedInstrument) ||
    (selectedType === 'vst' && !!selectedVstPath) ||
    (selectedType === 'sampler' && !!selectedSample) ||
    (selectedType === 'beat' && !!selectedBeatPack)

  const handleCreate = () => {
    if (selectedType === 'instrument' && selectedInstrument) {
      onCreateInstrumentTrack?.(selectedInstrument)
      onClose?.()
      return
    }
    if (selectedType === 'vst' && selectedVstPath) {
      onCreateVstTrack?.(selectedVstPath)
      onClose?.()
      return
    }
    if (selectedType === 'sampler' && selectedSample) {
      onCreateSamplerTrack?.(selectedSample)
      onClose?.()
      return
    }
    if (selectedType === 'beat' && selectedBeatPack) {
      onCreateBeatTrack?.(selectedBeatPack)
      onClose?.()
    }
  }

  const handleBackdropMouseDown = (e) => {
    if (showInstrumentSelector || showVstSelector) return
    if (e.target !== e.currentTarget) return
    onClose?.()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className="w-[920px] max-w-[94vw] max-h-[85vh] overflow-hidden rounded-2xl border border-zinc-700 bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-950 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-700/70 px-6 py-4">
          <div>
            <div className="text-xs uppercase tracking-[0.25em] text-amber-200/80">New Track</div>
            <h2 className="text-2xl font-semibold text-white">Create Track</h2>
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-lg text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
            title="Close"
          >
            x
          </button>
        </div>

        <div className="grid grid-cols-[280px_1fr] gap-6 p-6">
          <div className="space-y-3">
            {TRACK_TYPES.map((type) => (
              <button
                key={type.id}
                onClick={() => {
                  setSelectedType(type.id)
                }}
                className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition ${
                  selectedType === type.id
                    ? 'border-amber-400/60 bg-amber-500/10 text-white'
                    : 'border-zinc-700/70 bg-zinc-900/60 text-zinc-300 hover:border-zinc-600'
                }`}
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-800/70 text-sm font-semibold text-zinc-200">
                  {type.badge}
                </div>
                <div>
                  <div className="text-sm font-semibold">{type.label}</div>
                  <div className="text-xs text-zinc-400">{type.desc}</div>
                </div>
                
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-zinc-700/70 bg-zinc-900/40 p-5">
            {selectedType === 'instrument' && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-semibold text-white">Instrument Track</h3>
                  <p className="text-sm text-zinc-400">Select an instrument to load on this track.</p>
                </div>
                <div className="flex items-center gap-3 pt-2">
                  <div className="flex-1 rounded-lg border border-zinc-700/60 bg-zinc-950/40 px-4 py-3">
                    <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Selected</div>
                    <div className="text-sm text-white">
                      {selectedInstrument ? selectedInstrument.name : 'No instrument selected'}
                    </div>
                  </div>
                  <button
                    onClick={() => setShowInstrumentSelector(true)}
                    className="h-10 whitespace-nowrap rounded-lg bg-amber-500/20 px-4 text-sm font-semibold text-amber-100 ring-1 ring-amber-400/40 hover:bg-amber-500/30"
                  >
                    Choose Instrument
                  </button>
                </div>
              </div>
            )}

            {selectedType === 'vst' && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-semibold text-white">VST Track</h3>
                  <p className="text-sm text-zinc-400">Pick a VST3 plugin to load on this track.</p>
                </div>
                <div className="flex items-center gap-3 pt-2">
                  <div className="flex-1 rounded-lg border border-zinc-700/60 bg-zinc-950/40 px-4 py-3">
                    <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Selected</div>
                    <div className="text-sm text-white">
                      {selectedVstPath ? selectedVstPath.split('\\').pop().replace('.vst3', '') : 'No VST selected'}
                    </div>
                  </div>
                  <button
                    onClick={() => setShowVstSelector(true)}
                    className="h-10 whitespace-nowrap rounded-lg bg-amber-500/20 px-4 text-sm font-semibold text-amber-100 ring-1 ring-amber-400/40 hover:bg-amber-500/30"
                  >
                    Choose VST
                  </button>
                </div>
              </div>
            )}

            {selectedType === 'sampler' && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-semibold text-white">Sampler Track</h3>
                  <p className="text-sm text-zinc-400">Load a sample file for the sampler.</p>
                </div>
                <div className="flex items-center gap-3 pt-2">
                  <div className="flex-1 rounded-lg border border-zinc-700/60 bg-zinc-950/40 px-4 py-3">
                    <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Selected</div>
                    <div className="text-sm text-white">
                      {selectedSample ? selectedSample.name : 'No sample selected'}
                    </div>
                  </div>
                  <button
                    onClick={handleChooseSample}
                    className="h-10 whitespace-nowrap rounded-lg bg-amber-500/20 px-4 text-sm font-semibold text-amber-100 ring-1 ring-amber-400/40 hover:bg-amber-500/30"
                  >
                    Choose Sample
                  </button>
                </div>
              </div>
            )}

            {selectedType === 'beat' && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-semibold text-white">Beat Track</h3>
                  <p className="text-sm text-zinc-400">Choose a sequencer pack to start from.</p>
                </div>
                <div className="rounded-lg border border-zinc-700/60 bg-zinc-950/40 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Pack</div>
                  <select
                    value={selectedBeatPack}
                    onChange={(e) => setSelectedBeatPack(e.target.value)}
                    className="mt-2 w-full h-10 rounded-md bg-zinc-900 text-zinc-100 border border-zinc-700 px-2"
                  >
                    {beatPacks.length === 0 ? (
                      <option value="">No packs found</option>
                    ) : (
                      beatPacks.map((pack) => (
                        <option key={pack} value={pack}>{pack}</option>
                      ))
                    )}
                  </select>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-zinc-700/70 px-6 py-4">
          <div className="text-xs text-zinc-500">Choose a beat pack to create a beat track.</div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg bg-zinc-800/60 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-700"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!canCreate}
              className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-zinc-900 shadow-md transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Create Track
            </button>
          </div>
        </div>
      </div>

      <InstrumentSelector
        isOpen={showInstrumentSelector}
        onClose={() => setShowInstrumentSelector(false)}
        onSelectInstrument={(instrument) => {
          setSelectedInstrument(instrument)
          setShowInstrumentSelector(false)
        }}
        currentInstrument={selectedInstrument}
        isLoadingInstrument={false}
      />

      {showVstSelector && (
        <VSTSelector
          selectOnly
          onClose={() => setShowVstSelector(false)}
          onSelectPath={(path) => {
            setSelectedVstPath(path)
            setShowVstSelector(false)
          }}
        />
      )}
    </div>
  )
}

export default AddTrackModal
