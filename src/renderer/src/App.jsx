import { useState, useEffect, useRef } from 'react'
import PianoRoll from './components/PianoRoll'
import Sidebar from './components/Sidebar'
import TrackTimeline from './components/TrackTimeline'
import TitleBar from './components/TitleBar'
import SequencerPanel from './components/SequencerPanel'
import { initBackend } from './utils/vstBackend'

const TRACK_COLORS = [
  '#dee12e', '#f59e0b', '#10b981', '#3b82f6', 
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'
]

function App() {
  const [tracks, setTracks] = useState([])
  const [selectedTrackId, setSelectedTrackId] = useState(null)
  const [trackNotes, setTrackNotes] = useState({}) // { trackId: [notes] }
  const [trackInstruments, setTrackInstruments] = useState({}) // { trackId: instrument }
  const [trackVolumes, setTrackVolumes] = useState({}) // { trackId: volume (50-150) }
  const [trackBeats, setTrackBeats] = useState({}) // { trackId: { steps, rows: [{id,name,filePath,fileUrl,steps:boolean[]}]} }
  const [trackOffsets, setTrackOffsets] = useState({}) // { trackId: startBeat } - timeline offset for all tracks
  const [trackVSTMode, setTrackVSTMode] = useState({}) // { trackId: boolean } - whether track uses VST backend
  const [gridWidth, setGridWidth] = useState(32) // Shared grid width state
  const [zoom, setZoom] = useState(1) // Zoom level for timeline (0.5 to 2)
  const [bpm, setBpm] = useState(120) // Global BPM for playback
  const [currentProjectPath, setCurrentProjectPath] = useState(null)
  const [isLoading, setIsLoading] = useState(false) // TitleBar loading indicator
  const loadDialogOpenRef = useRef(false)
  const saveAsDialogOpenRef = useRef(false)

  // Initialize VST backend on mount
  useEffect(() => {
    initBackend()
  }, [])

  // Add new track
  const handleAddTrack = () => {
    const color = TRACK_COLORS[tracks.length % TRACK_COLORS.length]
    const newTrack = {
      id: Date.now(),
      name: `Track ${tracks.length + 1}`,
      color: color,
      noteCount: 0
    }
    setTracks([...tracks, newTrack])
    setTrackNotes(prev => ({ ...prev, [newTrack.id]: [] }))
    // No default instrument - user must select one
    setTrackInstruments(prev => ({ 
      ...prev, 
      [newTrack.id]: null
    }))
    // Default volume 100%
    setTrackVolumes(prev => ({
      ...prev,
      [newTrack.id]: 100
    }))
    // Default offset 0
    setTrackOffsets(prev => ({
      ...prev,
      [newTrack.id]: 0
    }))
    // Default VST mode off
    setTrackVSTMode(prev => ({
      ...prev,
      [newTrack.id]: false
    }))
  }

  // Add new beat (drum) track and open sequencer editor
  const handleAddBeatTrack = () => {
    const color = TRACK_COLORS[tracks.length % TRACK_COLORS.length]
    const id = Date.now()
    const newTrack = {
      id,
      name: `Beat ${tracks.length + 1}`,
      color: color,
      noteCount: 0,
      type: 'beat'
    }
    setTracks((prev) => [...prev, newTrack])
    setTrackVolumes((prev) => ({ ...prev, [id]: 100 }))
    setTrackBeats((prev) => ({ ...prev, [id]: { steps: 16, rows: [] } }))
    setTrackOffsets((prev) => ({ ...prev, [id]: 0 }))
    // Do not auto-open sequencer; stay on current view
  }

  // Import audio file(s) as new audio tracks
  const handleImportAudio = async () => {
    try {
      const resp = await window.api?.openAudioFiles?.()
      if (!resp) return
      if (!resp.ok || !Array.isArray(resp.files) || resp.files.length === 0) {
        // canceled or error
        if (resp && resp.error) console.error('Audio import failed:', resp.error)
        return
      }
      // Add one track per imported file
      const newTracks = []
      const newVolumes = { ...trackVolumes }
      const now = Date.now()
      resp.files.forEach((file, idx) => {
        const color = TRACK_COLORS[(tracks.length + newTracks.length) % TRACK_COLORS.length]
        const id = now + idx
        const track = {
          id,
          name: file.name || `Audio ${tracks.length + newTracks.length + 1}`,
          color,
          noteCount: 0,
          type: 'audio',
          audioClip: {
            name: file.name,
            bytes: file.bytes, // number[]
            path: file.path || null
          }
        }
        newTracks.push(track)
        newVolumes[id] = 100
      })
      setTracks([...tracks, ...newTracks])
      setTrackVolumes(newVolumes)
      // Set default offsets
      const newOffsets = { ...trackOffsets }
      newTracks.forEach(t => {
        newOffsets[t.id] = 0
      })
      setTrackOffsets(newOffsets)
    } catch (e) {
      console.error('Error importing audio:', e)
    }
  }

  // Delete track
  const handleDeleteTrack = (trackId) => {
    setTracks(tracks.filter(t => t.id !== trackId))
    const newTrackNotes = { ...trackNotes }
    delete newTrackNotes[trackId]
    setTrackNotes(newTrackNotes)
    const newTrackInstruments = { ...trackInstruments }
    delete newTrackInstruments[trackId]
    setTrackInstruments(newTrackInstruments)
  const newTrackBeats = { ...trackBeats }
  delete newTrackBeats[trackId]
  setTrackBeats(newTrackBeats)
  const newTrackVolumes = { ...trackVolumes }
  delete newTrackVolumes[trackId]
  setTrackVolumes(newTrackVolumes)
  const newTrackOffsets = { ...trackOffsets }
  delete newTrackOffsets[trackId]
  setTrackOffsets(newTrackOffsets)
    
    // Select another track if we deleted the selected one
    if (selectedTrackId === trackId) {
      const remainingTracks = tracks.filter(t => t.id !== trackId)
      setSelectedTrackId(remainingTracks.length > 0 ? remainingTracks[0].id : null)
    }
  }

  // Rename track
  const handleRenameTrack = (trackId, newName) => {
    setTracks(tracks.map(t => t.id === trackId ? { ...t, name: newName } : t))
  }

  // Update notes for a track
  const handleNotesChange = (trackId, notes) => {
    setTrackNotes(prev => ({ ...prev, [trackId]: notes }))
    // Update note count in track
    setTracks(tracks.map(t => 
      t.id === trackId ? { ...t, noteCount: notes.length } : t
    ))
  }

  // Update instrument for a track
  const handleInstrumentChange = (trackId, instrument) => {
    setTrackInstruments(prev => ({ ...prev, [trackId]: instrument }))
  }

  const selectedTrack = tracks.find(t => t.id === selectedTrackId)
  const currentNotes = selectedTrackId ? (trackNotes[selectedTrackId] || []) : []
  const currentInstrument = selectedTrackId ? trackInstruments[selectedTrackId] : null

  // Build a serializable project object
  const buildProject = () => {
    return {
      app: 'MelodyKit',
      version: 1,
      savedAt: new Date().toISOString(),
      bpm,
      gridWidth,
      zoom,
      tracks: tracks.map(t => ({
        id: t.id,
        name: t.name,
        color: t.color,
        type: t.type || 'midi',
        ...(t.type === 'audio' && t.audioClip ? {
          audioClip: {
            name: t.audioClip.name || null,
            path: t.audioClip.path || t.audioClip.filePath || null
          }
        } : {}),
        ...(t.type === 'beat' && trackBeats[t.id] ? {
          beat: trackBeats[t.id]
        } : {})
      })),
      trackNotes,
      trackInstruments,
      trackVolumes,
      trackOffsets,
      trackVSTMode
    }
  }

  // Save project to file via Electron dialog
  const handleSaveProject = async () => {
    try {
      const project = buildProject()
      if (currentProjectPath) {
        const r = await window.api?.saveProjectToPath?.(project, currentProjectPath)
        if (!r?.ok) console.error('Save to path failed:', r?.error)
      } else {
        if (saveAsDialogOpenRef.current) return
        saveAsDialogOpenRef.current = true
        const resp = await window.api?.saveProject?.(project, 'MelodyKit_Project.melodykit')
        if (!resp) return
        if (resp.ok) {
          setCurrentProjectPath(resp.path)
        } else if (resp.canceled) {
          // no-op
        } else {
          console.error('Save project failed:', resp.error)
        }
        saveAsDialogOpenRef.current = false
      }
    } catch (e) {
      console.error('Error saving project:', e)
      saveAsDialogOpenRef.current = false
    }
  }

  // Load project from file and replace current state
  const handleLoadProject = async () => {
    try {
      if (loadDialogOpenRef.current) return
      loadDialogOpenRef.current = true
      setIsLoading(true)
      const resp = await window.api?.openProject?.()
      if (!resp) return
      if (!resp.ok || !resp.project) {
        if (resp && resp.canceled) return
        console.error('Open project failed:', resp && resp.error)
        setIsLoading(false)
        return
      }
      const p = resp.project || {}
      // Basic validation
      const nextBpm = typeof p.bpm === 'number' ? p.bpm : 120
      const nextGrid = typeof p.gridWidth === 'number' ? p.gridWidth : 32
      const nextZoom = typeof p.zoom === 'number' ? p.zoom : 1
      const nextTracks = Array.isArray(p.tracks) ? p.tracks.map(t => ({
        id: t.id,
        name: t.name || 'Track',
        color: t.color || TRACK_COLORS[0],
        type: t.type || 'midi',
        audioClip: t.type === 'audio' && t.audioClip ? {
          name: t.audioClip.name || null,
          path: t.audioClip.path || null
        } : undefined,
        noteCount: 0
      })) : []
      const nextTrackNotes = (p.trackNotes && typeof p.trackNotes === 'object') ? p.trackNotes : {}
      const nextTrackInstruments = (p.trackInstruments && typeof p.trackInstruments === 'object') ? p.trackInstruments : {}
      const nextTrackVolumes = (p.trackVolumes && typeof p.trackVolumes === 'object') ? p.trackVolumes : {}
      const nextTrackOffsets = (p.trackOffsets && typeof p.trackOffsets === 'object') ? p.trackOffsets : {}
      const nextTrackVSTMode = (p.trackVSTMode && typeof p.trackVSTMode === 'object') ? p.trackVSTMode : {}
      const nextTrackBeats = {}
      nextTracks.forEach((t) => {
        if (t.type === 'beat' && p.tracks) {
          const src = p.tracks.find(tt => tt.id === t.id)
          if (src && src.beat) nextTrackBeats[t.id] = src.beat
        }
      })

      // Recompute noteCount for each track
      const recomputedTracks = nextTracks.map(t => ({
        ...t,
        noteCount: t.type === 'audio' ? 0 : (Array.isArray(nextTrackNotes[t.id]) ? nextTrackNotes[t.id].length : 0)
      }))

      setBpm(nextBpm)
      setGridWidth(nextGrid)
      setZoom(nextZoom)
  setTracks(recomputedTracks)
  setTrackNotes(nextTrackNotes)
  setTrackInstruments(nextTrackInstruments)
  setTrackBeats(nextTrackBeats)
  // default volume to 100 for any missing track ids
  setTrackVolumes(recomputedTracks.reduce((acc, t) => {
    acc[t.id] = typeof nextTrackVolumes[t.id] === 'number' ? nextTrackVolumes[t.id] : 100
    return acc
  }, {}))
  // default offset to 0 for any missing track ids
  setTrackOffsets(recomputedTracks.reduce((acc, t) => {
    acc[t.id] = typeof nextTrackOffsets[t.id] === 'number' ? nextTrackOffsets[t.id] : 0
    return acc
  }, {}))
  // default VST mode to false for any missing track ids
  setTrackVSTMode(recomputedTracks.reduce((acc, t) => {
    acc[t.id] = typeof nextTrackVSTMode[t.id] === 'boolean' ? nextTrackVSTMode[t.id] : false
    return acc
  }, {}))
  // Stay on track timeline view after loading (do not auto-open Piano UI)
  setSelectedTrackId(null)
      setCurrentProjectPath(resp.path || null)
      // Keep loading=true; TrackTimeline will clear it after instruments load
    } catch (e) {
      console.error('Error loading project:', e)
      setIsLoading(false)
    }
    finally {
      loadDialogOpenRef.current = false
    }
  }

  // Autosave to current file (debounced) whenever state changes and a project path exists
  useEffect(() => {
    if (!currentProjectPath) return
    const id = setTimeout(async () => {
      try {
        const project = buildProject()
        const r = await window.api?.saveProjectToPath?.(project, currentProjectPath)
        if (!r?.ok) console.error('Autosave failed:', r?.error)
      } catch (e) {
        console.error('Autosave error:', e)
      }
    }, 500) // debounce 500ms
    return () => clearTimeout(id)
  }, [tracks, trackNotes, trackInstruments, trackVolumes, trackBeats, trackOffsets, bpm, gridWidth, zoom, currentProjectPath])

  const timelineRef = useRef(null)

  // No native menu; custom title bar will call handlers directly

  return (
    <div className="fixed inset-0 flex flex-col bg-zinc-900">
  {/* Custom Title Bar with dropdown menus */}
  <TitleBar
        onNewProject={() => {
          setTracks([])
          setTrackNotes({})
          setTrackInstruments({})
          setSelectedTrackId(null)
          setCurrentProjectPath(null)
          setIsLoading(false)
        }}
        onLoadProject={handleLoadProject}
        onSaveAsProject={async () => {
          try {
            const project = buildProject()
            const resp = await window.api?.saveProject?.(project, 'MelodyKit_Project.melodykit')
            if (resp?.ok) setCurrentProjectPath(resp.path)
          } catch (e) {
            console.error('Save As failed:', e)
          }
        }}
        onExportWav={() => timelineRef.current?.exportWav?.()}
        onImportAudio={handleImportAudio}
        currentProjectPath={currentProjectPath}
        loading={isLoading}
      />
      <div className="flex-1 min-h-0 min-w-0 flex">
        <Sidebar
          tracks={tracks}
          selectedTrackId={selectedTrackId}
          onSelectTrack={setSelectedTrackId}
          onAddTrack={handleAddTrack}
          onAddBeatTrack={handleAddBeatTrack}
          onDeleteTrack={handleDeleteTrack}
          onRenameTrack={handleRenameTrack}
        />
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {selectedTrack ? (
            selectedTrack.type === 'beat' ? (
              <SequencerPanel
                trackId={selectedTrack.id}
                pattern={trackBeats[selectedTrack.id] || { steps: 16, rows: [] }}
                onChange={(p) => setTrackBeats((prev) => ({ ...prev, [selectedTrack.id]: p }))}
                onBack={() => setSelectedTrackId(null)}
                bpm={bpm}
              />
            ) : (
              <PianoRoll
                trackId={selectedTrack.id}
                trackName={selectedTrack.name}
                trackColor={selectedTrack.color}
                notes={currentNotes}
                onNotesChange={(notes) => handleNotesChange(selectedTrack.id, notes)}
                onBack={() => setSelectedTrackId(null)}
                gridWidth={gridWidth}
                setGridWidth={setGridWidth}
                bpm={bpm}
                setBpm={setBpm}
                selectedInstrument={currentInstrument}
                onInstrumentChange={(instrument) => handleInstrumentChange(selectedTrack.id, instrument)}
                useVSTBackend={trackVSTMode[selectedTrack.id] || false}
                onVSTModeChange={(enabled) => {
                  setTrackVSTMode({ ...trackVSTMode, [selectedTrack.id]: enabled })
                }}
              />
            )
          ) : (
            <TrackTimeline
              ref={timelineRef}
              tracks={tracks}
              trackNotes={trackNotes}
              trackBeats={trackBeats}
              setTrackBeats={setTrackBeats}
              trackInstruments={trackInstruments}
              trackVolumes={trackVolumes}
              setTrackVolumes={setTrackVolumes}
              trackOffsets={trackOffsets}
              setTrackOffsets={setTrackOffsets}
              trackVSTMode={trackVSTMode}
              onSelectTrack={setSelectedTrackId}
              onAddTrack={handleAddTrack}
              gridWidth={gridWidth}
              setGridWidth={setGridWidth}
              zoom={zoom}
              setZoom={setZoom}
              bpm={bpm}
              setBpm={setBpm}
              onLoadingChange={setIsLoading}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export default App
