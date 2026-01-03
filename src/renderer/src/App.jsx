import { useState, useEffect, useRef } from 'react'
import PianoRoll from './components/PianoRoll'
import Sidebar from './components/Sidebar'
import TrackTimeline from './components/TrackTimeline'
import TitleBar from './components/TitleBar'
import SequencerPanel from './components/SequencerPanel'
import { initBackend } from './utils/vstBackend'
import { loadSF2 } from './utils/vstBackend'

// Helper to wait for backend response via event stream
const waitForBackendEvent = (matchPattern, timeoutMs = 5000) => {
  return new Promise((resolve, reject) => {
    let unsubscribe = null
    let eventCount = 0
    const timeout = setTimeout(() => {
      console.warn(`Timeout after ${timeoutMs}ms, received ${eventCount} events but none matched`)
      if (unsubscribe) unsubscribe()
      reject(new Error('Timeout waiting for backend event'))
    }, timeoutMs)

    unsubscribe = window.api.backend.onEvent((line) => {
      eventCount++
      console.log(`[Event ${eventCount}] Received backend event:`, line.substring(0, 150))
      if (matchPattern(line)) {
        console.log(`[Event ${eventCount}] ✓ Matched! Resolving...`)
        clearTimeout(timeout)
        if (unsubscribe) unsubscribe()
        resolve(line)
      } else {
        console.log(`[Event ${eventCount}] ✗ Did not match pattern`)
      }
    })
  })
}

const TRACK_COLORS = [
  '#dee12e', '#f59e0b', '#10b981', '#3b82f6', 
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'
]

function App() {
  const [tracks, setTracks] = useState([])
  const [selectedTrackId, setSelectedTrackId] = useState(null)
  const [trackNotes, setTrackNotes] = useState({}) // { trackId: [notes] }
  const [trackInstruments, setTrackInstruments] = useState({}) // { trackId: instrument }
  const [trackVolumes, setTrackVolumes] = useState({}) // { trackId: volume (0-150) }
  const [trackBeats, setTrackBeats] = useState({}) // { trackId: { steps, rows: [{id,name,filePath,fileUrl,steps:boolean[]}]} }
  const [trackOffsets, setTrackOffsets] = useState({}) // { trackId: startBeat } - timeline offset for all tracks
  const [trackLengths, setTrackLengths] = useState({}) // { trackId: lengthBeats } - manual length for MIDI/audio tracks
  const [trackVSTMode, setTrackVSTMode] = useState({}) // { trackId: boolean } - whether track uses VST backend
  const [trackVSTPlugins, setTrackVSTPlugins] = useState({}) // { trackId: vstPath } - loaded VST plugin paths
  const [trackVSTPresets, setTrackVSTPresets] = useState({}) // { trackId: base64State } - VST plugin preset state
  const [trackVSTLoading, setTrackVSTLoading] = useState({}) // { trackId: boolean } - track VST is currently loading
  const [trackSamplerPaths, setTrackSamplerPaths] = useState({}) // { trackId: filePath } - sampler track sample file paths
  const [trackMuted, setTrackMuted] = useState({}) // { trackId: boolean } - track mute status
  const [trackSoloed, setTrackSoloed] = useState({}) // { trackId: boolean } - track solo status
  const [trackAutomation, setTrackAutomation] = useState({}) // { trackId: { enabled: boolean, type: 'volume'|'pan'|'resonance'|'cutoff', data: { volume: [{beat, value}], pan: [...], resonance: [...], cutoff: [...] } } }
  const [gridWidth, setGridWidth] = useState(32) // Shared grid width state
  const [zoom, setZoom] = useState(1) // Zoom level for timeline (0.5 to 2)
  const [bpm, setBpm] = useState(120) // Global BPM for playback
  const [loopStart, setLoopStart] = useState(null) // Loop region start (in beats), null = no loop
  const [loopEnd, setLoopEnd] = useState(null) // Loop region end (in beats), null = no loop
  const [currentProjectPath, setCurrentProjectPath] = useState(null)
  const [isLoading, setIsLoading] = useState(false) // TitleBar loading indicator
  const [loadingMessage, setLoadingMessage] = useState('') // Detailed loading progress message
  const [isRestoring, setIsRestoring] = useState(false) // Flag to prevent autosave during VST restoration
  const [isAutosaving, setIsAutosaving] = useState(false) // Autosave status indicator
  const [showWelcome, setShowWelcome] = useState(true)
  const loadDialogOpenRef = useRef(false)
  const saveAsDialogOpenRef = useRef(false)

  // Initialize VST backend on mount
  useEffect(() => {
    initBackend()
  }, [])

  // Hide welcome overlay once any track exists
  useEffect(() => {
    if (tracks.length > 0) setShowWelcome(false)
  }, [tracks.length])

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
    // Default mute/solo off
    setTrackMuted(prev => ({ ...prev, [newTrack.id]: false }))
    setTrackSoloed(prev => ({ ...prev, [newTrack.id]: false }))
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
    setTrackMuted(prev => ({ ...prev, [id]: false }))
    setTrackSoloed(prev => ({ ...prev, [id]: false }))
    // Do not auto-open sequencer; stay on current view
  }

  const handleAddSamplerTrack = () => {
    const color = TRACK_COLORS[tracks.length % TRACK_COLORS.length]
    const id = Date.now()
    const newTrack = {
      id,
      name: `Sampler ${tracks.length + 1}`,
      color: color,
      noteCount: 0,
      type: 'sampler'
    }
    setTracks((prev) => [...prev, newTrack])
    setTrackVolumes((prev) => ({ ...prev, [id]: 100 }))
    setTrackNotes(prev => ({ ...prev, [id]: [] }))
    setTrackOffsets((prev) => ({ ...prev, [id]: 0 }))
    setTrackMuted(prev => ({ ...prev, [id]: false }))
    setTrackSoloed(prev => ({ ...prev, [id]: false }))
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
      const newMuted = { ...trackMuted }
      const newSoloed = { ...trackSoloed }
      newTracks.forEach(t => {
        newOffsets[t.id] = 0
        newMuted[t.id] = false
        newSoloed[t.id] = false
      })
      setTrackOffsets(newOffsets)
      setTrackMuted(newMuted)
      setTrackSoloed(newSoloed)
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
  const newTrackMuted = { ...trackMuted }
  delete newTrackMuted[trackId]
  setTrackMuted(newTrackMuted)
  const newTrackSoloed = { ...trackSoloed }
  delete newTrackSoloed[trackId]
  setTrackSoloed(newTrackSoloed)
  const newTrackVSTPlugins = { ...trackVSTPlugins }
  delete newTrackVSTPlugins[trackId]
  setTrackVSTPlugins(newTrackVSTPlugins)
  const newTrackVSTPresets = { ...trackVSTPresets }
  delete newTrackVSTPresets[trackId]
  setTrackVSTPresets(newTrackVSTPresets)
  const newTrackVSTLoading = { ...trackVSTLoading }
  delete newTrackVSTLoading[trackId]
  setTrackVSTLoading(newTrackVSTLoading)
    // Clear backend beat resources if this was a beat track
    window.api?.backend?.clearBeat?.(String(trackId)).catch(() => {})
    
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

  // Duplicate track
  const handleDuplicateTrack = async (trackId) => {
    const trackToDuplicate = tracks.find(t => t.id === trackId)
    if (!trackToDuplicate) return
    
    const newId = Date.now()
    
    // If this is a VST track, capture the current preset state BEFORE duplicating
    let capturedPreset = trackVSTPresets[trackId]
    if (trackVSTMode[trackId] && trackVSTPlugins[trackId] && !capturedPreset) {
      console.log(`[Duplicate] Capturing VST preset from track ${trackId} before duplication...`)
      try {
        const statePromise = waitForBackendEvent(
          (line) => line.startsWith(`EVENT STATE ${trackId} `) || line.startsWith(`ERROR GET_STATE ${trackId}`),
          5000
        )
        await window.api?.backend?.getVSTState?.(String(trackId))
        const stateEvent = await statePromise
        
        if (stateEvent.startsWith(`EVENT STATE ${trackId} `)) {
          capturedPreset = stateEvent.substring(`EVENT STATE ${trackId} `.length)
          console.log(`[Duplicate] ✓ Captured preset for track ${trackId}, length: ${capturedPreset.length}`)
          // Update the state with the captured preset
          setTrackVSTPresets(prev => ({ ...prev, [trackId]: capturedPreset }))
        }
      } catch (err) {
        console.warn(`[Duplicate] Could not capture VST preset:`, err.message)
      }
    }
    
    const newTrack = {
      ...trackToDuplicate,
      id: newId,
      name: trackToDuplicate.type === 'beat' ? `Beat ${tracks.length + 1}` : `Track ${tracks.length + 1}`,
      noteCount: trackToDuplicate.noteCount
    }
    
    // Add duplicated track after the original
    const trackIndex = tracks.findIndex(t => t.id === trackId)
    const newTracks = [...tracks]
    newTracks.splice(trackIndex + 1, 0, newTrack)
    setTracks(newTracks)
    
    // Copy all track state (deep copy where needed)
    if (trackNotes[trackId]) {
      setTrackNotes(prev => ({ ...prev, [newId]: [...trackNotes[trackId]] }))
    }
    
    if (trackBeats[trackId]) {
      setTrackBeats(prev => ({ 
        ...prev, 
        [newId]: { 
          ...trackBeats[trackId], 
          rows: trackBeats[trackId].rows?.map(r => ({ ...r })) || [] 
        } 
      }))
    }
    
    // Copy other track properties
    setTrackVolumes(prev => ({ ...prev, [newId]: trackVolumes[trackId] ?? 100 }))
    setTrackOffsets(prev => ({ ...prev, [newId]: trackOffsets[trackId] ?? 0 }))
    setTrackLengths(prev => ({ ...prev, [newId]: trackLengths[trackId] }))
    setTrackMuted(prev => ({ ...prev, [newId]: trackMuted[trackId] ?? false }))
    setTrackSoloed(prev => ({ ...prev, [newId]: trackSoloed[trackId] ?? false }))
    
    // Copy instrument/VST settings - these will trigger loading via existing effects
    if (trackInstruments[trackId]) {
      const instrumentCopy = JSON.parse(JSON.stringify(trackInstruments[trackId]))
      setTrackInstruments(prev => ({ ...prev, [newId]: instrumentCopy }))
    }
    
    if (trackVSTMode[trackId]) {
      setTrackVSTMode(prev => ({ ...prev, [newId]: true }))
    }
    
    if (trackVSTPlugins[trackId]) {
      setTrackVSTPlugins(prev => ({ ...prev, [newId]: trackVSTPlugins[trackId] }))
    }
    
    // Copy the captured or existing preset
    if (capturedPreset) {
      setTrackVSTPresets(prev => ({ ...prev, [newId]: capturedPreset }))
      console.log(`[Duplicate] ✓ VST preset copied to new track ${newId}`)
    }
    
    console.log(`[Duplicate] Track ${trackId} duplicated as ${newId}`)
  }

  // Auto-load VST plugins when trackVSTPlugins or trackVSTMode changes
  useEffect(() => {
    if (isRestoring) return // Don't interfere with project loading
    
    const loadVSTsForNewTracks = async () => {
      for (const [trackId, vstPath] of Object.entries(trackVSTPlugins)) {
        // Skip if already loading
        if (trackVSTLoading[trackId]) {
          console.log(`[Auto-Load] Track ${trackId} already loading, skipping...`)
          continue
        }
        
        // Check if this track needs VST loaded
        if (trackVSTMode[trackId] && vstPath) {
          // Check if already loaded by trying to get state
          try {
            const checkPromise = waitForBackendEvent(
              (line) => line.startsWith(`EVENT STATE ${trackId} `) || line.startsWith(`ERROR GET_STATE ${trackId}`),
              1500
            )
            await window.api?.backend?.getVSTState?.(String(trackId))
            const checkResult = await checkPromise
            
            // If we get an error, the VST isn't loaded yet
            if (checkResult.startsWith(`ERROR GET_STATE ${trackId}`)) {
              console.log(`[Auto-Load] VST not loaded for track ${trackId}, loading now...`)
              
              // Mark as loading
              setTrackVSTLoading(prev => ({ ...prev, [trackId]: true }))
              
              try {
                // Wait for both LOADED and READY events
                const loadEventPromise = waitForBackendEvent(
                  (line) => line.startsWith(`EVENT LOADED ${trackId} `) || line.startsWith(`ERROR LOAD ${trackId}`),
                  15000
                )
                
                const readyEventPromise = waitForBackendEvent(
                  (line) => line.startsWith(`EVENT READY ${trackId} `),
                  20000
                )
                
                const loadResult = await window.api?.backend?.loadVST?.(trackId, vstPath)
                
                if (loadResult && loadResult.ok) {
                  const loadEvent = await loadEventPromise
                  if (loadEvent.startsWith(`EVENT LOADED ${trackId}`)) {
                    console.log(`[Auto-Load] VST LOADED event received for track ${trackId}`)
                    
                    // Wait for READY event (plugin fully initialized)
                    const readyEvent = await readyEventPromise
                    if (readyEvent.startsWith(`EVENT READY ${trackId}`)) {
                      console.log(`[Auto-Load] ✓ VST READY for track ${trackId}`)
                      
                      // Small delay to ensure all React state updates have propagated
                      await new Promise(resolve => setTimeout(resolve, 100))
                      
                      // Check for preset again in case it was just set
                      const presetData = trackVSTPresets[trackId]
                      if (presetData) {
                        console.log(`[Auto-Load] Found preset for track ${trackId}, applying... (length: ${presetData.length})`)
                        try {
                          const stateEventPromise = waitForBackendEvent(
                            (line) => line.startsWith(`EVENT STATE_SET ${trackId}`) || line.startsWith(`ERROR SET_STATE ${trackId}`),
                            15000
                          )
                          
                          await window.api?.backend?.setVSTState?.(trackId, presetData)
                          const stateEvent = await stateEventPromise
                          
                          if (stateEvent.startsWith(`EVENT STATE_SET ${trackId}`)) {
                            console.log(`[Auto-Load] ✓ VST preset applied for track ${trackId}`)
                          } else {
                            console.error(`[Auto-Load] ✗ Failed to apply preset for track ${trackId}:`, stateEvent)
                          }
                        } catch (err) {
                          console.error(`[Auto-Load] Failed to apply preset for track ${trackId}:`, err)
                        }
                      } else {
                        console.warn(`[Auto-Load] No preset found for track ${trackId}, VST will use default state`)
                      }
                    }
                  }
                }
              } catch (err) {
                console.error(`[Auto-Load] Failed to load VST for track ${trackId}:`, err)
              } finally {
                // Clear loading state
                setTrackVSTLoading(prev => ({ ...prev, [trackId]: false }))
              }
            } else {
              // VST is already loaded
              console.log(`[Auto-Load] VST already loaded for track ${trackId}`)
            }
          } catch (err) {
            // Timeout or error checking - might need to load
            console.log(`[Auto-Load] Could not verify VST state for track ${trackId} (${err.message})`)
          }
        }
      }
    }
    
    loadVSTsForNewTracks()
  }, [trackVSTPlugins, trackVSTMode, trackVSTPresets, trackVSTLoading, isRestoring])

  // Update notes for a track
  const handleNotesChange = (trackId, notes) => {
    console.log(`[Notes] Track ${trackId} updated with ${notes.length} notes, max position:`, 
      notes.length > 0 ? Math.max(...notes.map(n => (n.start || 0) + (n.duration || 0))) : 0)
    setTrackNotes(prev => ({ ...prev, [trackId]: notes }))
    
    // Auto-update track length based on furthest note
    if (notes.length > 0) {
      const maxPos = Math.max(...notes.map(n => (n.start || 0) + (n.duration || 0)))
      setTrackLengths(prev => ({ ...prev, [trackId]: Math.ceil(maxPos) }))
    }
    
    // Update note count in track
    setTracks(tracks.map(t => 
      t.id === trackId ? { ...t, noteCount: notes.length } : t
    ))
  }
  
  // Trigger immediate save (when closing piano roll, etc.)
  const triggerImmediateSave = async () => {
    if (!currentProjectPath || isRestoring || isSavingRef.current) return
    
    // Wait a tick to ensure all state updates are committed
    await new Promise(resolve => setTimeout(resolve, 100))
    
    try {
      isSavingRef.current = true
      setIsAutosaving(true)
      const project = await buildProject()
      const r = await window.api?.saveProjectToPath?.(project, currentProjectPath)
      if (r?.ok) {
        console.log('[Immediate Save] ✓ Saved')
        lastSaveDataRef.current = JSON.stringify(project)
      } else {
        console.error('[Immediate Save] Failed:', r?.error)
      }
    } catch (e) {
      console.error('[Immediate Save] Error:', e)
    } finally {
      isSavingRef.current = false
      setTimeout(() => setIsAutosaving(false), 500) // Show indicator briefly
    }
  }

  // Update instrument for a track
  const handleInstrumentChange = (trackId, instrument) => {
    setTrackInstruments(prev => ({ ...prev, [trackId]: instrument }))
    
    // PERFORMANCE: Pre-load SF2 immediately when instrument is selected
    // This prevents the 2-3 second delay when opening piano roll
    if (instrument && instrument.samplePath && instrument.samplePath.endsWith('.sf2')) {
      const bank = instrument.bank || 0
      const preset = instrument.preset || 0
      console.log(`[Preload] Loading SF2 for track ${trackId}: ${instrument.samplePath}`)
      
      // Fire-and-forget: load SF2 in background immediately
      loadSF2(trackId, instrument.samplePath, bank, preset).then(success => {
        if (success) {
          console.log(`[Preload] ✓ SF2 loaded for track ${trackId}`)
        } else {
          console.warn(`[Preload] ✗ Failed to load SF2 for track ${trackId}`)
        }
      }).catch(err => {
        console.error(`[Preload] Error loading SF2 for track ${trackId}:`, err)
      })
    }
    
    // Track VST plugin path if present
    if (instrument && instrument.vstPath) {
      console.log(`VST loaded for track ${trackId}: ${instrument.vstPath}`)
      setTrackVSTPlugins(prev => ({ ...prev, [String(trackId)]: instrument.vstPath }))
    } else {
      // Remove VST plugin if switching to SF2 or no instrument
      console.log(`Removing VST for track ${trackId}`)
      setTrackVSTPlugins(prev => {
        const updated = { ...prev }
        delete updated[String(trackId)]
        return updated
      })
    }
  }

  const selectedTrack = tracks.find(t => t.id === selectedTrackId)
  const currentNotes = selectedTrackId ? (trackNotes[selectedTrackId] || []) : []
  const currentInstrument = selectedTrackId ? trackInstruments[selectedTrackId] : null

  // Build a serializable project object
  const buildProject = async () => {
    // Capture VST preset states for tracks with loaded VSTs
    const capturedVSTPresets = {}
    console.log('Building project - trackVSTPlugins:', trackVSTPlugins)
    console.log('Building project - trackVSTMode:', trackVSTMode)
    
    for (const [trackId, vstPath] of Object.entries(trackVSTPlugins)) {
      console.log(`Checking track ${trackId}: vstPath=${vstPath}, vstMode=${trackVSTMode[trackId]}`)
      if (trackVSTMode[trackId] && vstPath) {
        try {
          console.log(`Getting VST state for track ${trackId}...`)
          
          // Set up listener BEFORE sending command
          const responsePromise = waitForBackendEvent(
            (line) => line.startsWith(`EVENT STATE ${trackId} `) || line.startsWith(`ERROR GET_STATE ${trackId}`),
            10000
          )
          
          // Now send the command
          await window.api?.backend?.getVSTState?.(String(trackId))
          console.log(`GET_STATE command sent for track ${trackId}`)
          
          // Wait for response
          try {
            const response = await responsePromise
            console.log(`VST state response for track ${trackId}:`, response.substring(0, 100))
            
            if (response.startsWith(`EVENT STATE ${trackId} `)) {
              const stateData = response.substring(`EVENT STATE ${trackId} `.length)
              capturedVSTPresets[trackId] = stateData
              console.log(`✓ Captured VST state for track ${trackId}, length: ${stateData.length}`)
            } else {
              console.warn(`✗ Failed to get VST state for track ${trackId}: ${response}`)
            }
          } catch (eventErr) {
            console.error(`✗ Timeout waiting for VST state event for track ${trackId}:`, eventErr.message)
          }
        } catch (e) {
          console.error(`✗ Failed to get VST state for track ${trackId}:`, e)
        }
      }
    }
    
    // Don't update state here - just use capturedVSTPresets in the return value
    // (updating state here causes infinite autosave loop)
    
    console.log('Final trackVSTPresets keys:', Object.keys(capturedVSTPresets))
    console.log('Final trackVSTPresets sizes:', Object.entries(capturedVSTPresets).map(([k,v]) => `${k}: ${v?.length || 0} bytes`))
    console.log('[Save] trackBeats with lengths:', Object.entries(trackBeats).map(([k,v]) => `${k}: ${v.lengthBeats || 'no length'} beats`))
    console.log('[Save] trackNotes counts:', Object.entries(trackNotes).map(([k,v]) => `${k}: ${v.length} notes, max pos: ${v.length > 0 ? Math.max(...v.map(n => (n.start || 0) + (n.duration || 0))) : 0}`))
    console.log('[Save] trackOffsets:', trackOffsets)

    // Recalculate trackLengths from current notes to ensure it's up-to-date
    const currentTrackLengths = { ...trackLengths }
    tracks.forEach(t => {
      if (t.type === 'midi' || (!t.type && t.type !== 'beat' && t.type !== 'audio')) {
        const notes = trackNotes[t.id]
        if (notes && notes.length > 0) {
          const maxPos = Math.max(...notes.map(n => (n.start || 0) + (n.duration || 0)))
          currentTrackLengths[t.id] = Math.ceil(maxPos)
        }
      }
    })
    console.log('[Save] Calculated trackLengths:', currentTrackLengths)
    console.log('[Save] Detailed track info:')
    tracks.forEach(t => {
      if (t.type !== 'beat' && t.type !== 'audio') {
        const notes = trackNotes[t.id] || []
        console.log(`  Track ${t.id} (${t.name}): ${notes.length} notes, length: ${currentTrackLengths[t.id] || 'none'}`)
        if (notes.length > 0) {
          console.log(`    Note positions:`, notes.map(n => `${n.start?.toFixed(2)}-${((n.start || 0) + (n.duration || 0)).toFixed(2)}`))
        }
      }
    })

    return {
      app: 'MelodyKit',
      version: 2, // Bumped from 1 to 2 for VST preset support
      savedAt: new Date().toISOString(),
      bpm,
      gridWidth,
      zoom,
      loopStart,
      loopEnd,
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
        } : {}),
        ...(t.type === 'sampler' && trackSamplerPaths[t.id] ? {
          samplerPath: trackSamplerPaths[t.id]
        } : {})
      })),
      trackNotes,
      trackInstruments,
      trackVolumes,
      trackOffsets,
      trackLengths: currentTrackLengths,
      trackVSTMode,
      trackVSTPlugins,
      trackVSTPresets: capturedVSTPresets,
      trackSamplerPaths,
      trackMuted,
      trackSoloed,
      trackAutomation
    }
  }

  // Save project to file via Electron dialog
  const handleSaveProject = async () => {
    try {
      const project = await buildProject()
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
      setLoadingMessage('Opening project file...')
      const resp = await window.api?.openProject?.()
      if (!resp) {
        setLoadingMessage('')
        return
      }
      if (!resp.ok || !resp.project) {
        if (resp && resp.canceled) {
          setLoadingMessage('')
          return
        }
        console.error('Open project failed:', resp && resp.error)
        setIsLoading(false)
        setLoadingMessage('')
        return
      }
      setLoadingMessage('Parsing project data...')
      const p = resp.project || {}
      // Basic validation
      const nextBpm = typeof p.bpm === 'number' ? p.bpm : 120
      const nextGrid = typeof p.gridWidth === 'number' ? p.gridWidth : 32
      const nextZoom = typeof p.zoom === 'number' ? p.zoom : 1
      const nextLoopStart = typeof p.loopStart === 'number' ? p.loopStart : null
      const nextLoopEnd = typeof p.loopEnd === 'number' ? p.loopEnd : null
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
      const nextTrackLengths = (p.trackLengths && typeof p.trackLengths === 'object') ? p.trackLengths : {}
      const nextTrackVSTMode = (p.trackVSTMode && typeof p.trackVSTMode === 'object') ? p.trackVSTMode : {}
      const nextTrackVSTPlugins = (p.trackVSTPlugins && typeof p.trackVSTPlugins === 'object') ? p.trackVSTPlugins : {}
      const nextTrackVSTPresets = (p.trackVSTPresets && typeof p.trackVSTPresets === 'object') ? p.trackVSTPresets : {}
      const nextTrackSamplerPaths = (p.trackSamplerPaths && typeof p.trackSamplerPaths === 'object') ? p.trackSamplerPaths : {}
      const nextTrackMuted = (p.trackMuted && typeof p.trackMuted === 'object') ? p.trackMuted : {}
      const nextTrackSoloed = (p.trackSoloed && typeof p.trackSoloed === 'object') ? p.trackSoloed : {}
      const nextTrackAutomation = (p.trackAutomation && typeof p.trackAutomation === 'object') ? p.trackAutomation : {}
      const nextTrackBeats = {}
      nextTracks.forEach((t) => {
        if (t.type === 'beat' && p.tracks) {
          const src = p.tracks.find(tt => tt.id === t.id)
          if (src && src.beat) nextTrackBeats[t.id] = src.beat
        }
      })

      console.log('[Load] nextTrackOffsets:', nextTrackOffsets)
      console.log('[Load] nextTrackOffsets details:', Object.entries(nextTrackOffsets).map(([k,v]) => `${k}: ${v} beats`))
      console.log('[Load] nextTrackBeats:', Object.keys(nextTrackBeats), nextTrackBeats)
      console.log('[Load] nextTrackNotes counts:', Object.entries(nextTrackNotes).map(([k,v]) => `${k}: ${v?.length || 0} notes, max pos: ${v?.length > 0 ? Math.max(...v.map(n => (n.start || 0) + (n.duration || 0))) : 0}`))
      console.log('[Load] nextTrackLengths:', nextTrackLengths)

      // Recompute noteCount for each track
      const recomputedTracks = nextTracks.map(t => ({
        ...t,
        noteCount: t.type === 'audio' ? 0 : (Array.isArray(nextTrackNotes[t.id]) ? nextTrackNotes[t.id].length : 0)
      }))

      // Prevent autosave during state restoration
      setIsRestoring(true)
      setLoadingMessage('Restoring project state...')

      // Recalculate missing trackLengths from notes
      const calculatedLengths = {}
      recomputedTracks.forEach(t => {
        if (t.type === 'midi' || (!t.type && t.type !== 'beat' && t.type !== 'audio')) {
          const notes = nextTrackNotes[t.id]
          if (notes && notes.length > 0) {
            const maxPos = Math.max(...notes.map(n => (n.start || 0) + (n.duration || 0)))
            calculatedLengths[t.id] = Math.ceil(maxPos)
          }
        }
      })
      
      // Merge calculated lengths with loaded lengths (loaded takes priority)
      const finalLengths = { ...calculatedLengths, ...nextTrackLengths }
      console.log('[Load] Final trackLengths:', finalLengths)
      console.log('[Load] Calculated from notes:', calculatedLengths)
      console.log('[Load] Loaded from file:', nextTrackLengths)
      
      // PERFORMANCE OPTIMIZATION: Batch all state updates together to minimize React re-renders
      // This reduces from 15+ sequential setState calls to a single batch update
      const volumesWithDefaults = recomputedTracks.reduce((acc, t) => {
        acc[t.id] = typeof nextTrackVolumes[t.id] === 'number' ? nextTrackVolumes[t.id] : 100
        return acc
      }, {})
      
      const offsetsWithDefaults = recomputedTracks.reduce((acc, t) => {
        acc[t.id] = typeof nextTrackOffsets[t.id] === 'number' ? nextTrackOffsets[t.id] : 0
        return acc
      }, {})
      
      const mutedWithDefaults = recomputedTracks.reduce((acc, t) => {
        acc[t.id] = typeof nextTrackMuted[t.id] === 'boolean' ? nextTrackMuted[t.id] : false
        return acc
      }, {})
      
      const soloedWithDefaults = recomputedTracks.reduce((acc, t) => {
        acc[t.id] = typeof nextTrackSoloed[t.id] === 'boolean' ? nextTrackSoloed[t.id] : false
        return acc
      }, {})
      
      const vstModeWithDefaults = recomputedTracks.reduce((acc, t) => {
        acc[t.id] = typeof nextTrackVSTMode[t.id] === 'boolean' ? nextTrackVSTMode[t.id] : false
        return acc
      }, {})
      
      // Apply all state updates in a single synchronous batch
      setBpm(nextBpm)
      setGridWidth(nextGrid)
      setZoom(nextZoom)
      setLoopStart(nextLoopStart)
      setLoopEnd(nextLoopEnd)
      setTracks(recomputedTracks)
      setTrackNotes(nextTrackNotes)
      setTrackInstruments(nextTrackInstruments)
      setTrackBeats(nextTrackBeats)
      setTrackVolumes(volumesWithDefaults)
      setTrackOffsets(offsetsWithDefaults)
      setTrackMuted(mutedWithDefaults)
      setTrackSoloed(soloedWithDefaults)
      setTrackAutomation(nextTrackAutomation)
      setTrackLengths(finalLengths)
      setTrackVSTMode(vstModeWithDefaults)
      setTrackVSTPlugins(nextTrackVSTPlugins)
      setTrackVSTPresets(nextTrackVSTPresets)
      setTrackSamplerPaths(nextTrackSamplerPaths)
      setSelectedTrackId(null)
      setCurrentProjectPath(resp.path || null)
      
      // Restore sampler tracks - load samples in background
      recomputedTracks.forEach(track => {
        if (track.type === 'sampler' && nextTrackSamplerPaths[track.id]) {
          const samplePath = nextTrackSamplerPaths[track.id]
          console.log(`[Preload] Loading sampler sample for track ${track.id}: ${samplePath}`)
          window.api.backend.loadSamplerSample(String(track.id), samplePath).then(res => {
            if (res.ok) {
              console.log(`[Preload] ✓ Sampler sample loaded for track ${track.id}`)
            } else {
              console.warn(`[Preload] ✗ Failed to load sampler sample for track ${track.id}:`, res.error)
            }
          }).catch(err => {
            console.error(`[Preload] Error loading sampler sample for track ${track.id}:`, err)
          })
        }
      })
      
      // PERFORMANCE: Pre-load SF2 instruments in parallel immediately after state restore
      // This prevents the 2-3 second delay when opening piano roll for the first time
      const sf2LoadPromises = []
      recomputedTracks.forEach(track => {
        const instrument = nextTrackInstruments[track.id]
        if (instrument && instrument.samplePath && instrument.samplePath.endsWith('.sf2')) {
          const bank = instrument.bank || 0
          const preset = instrument.preset || 0
          console.log(`[Preload] Loading SF2 for track ${track.id}: ${instrument.samplePath}`)
          
          const promise = loadSF2(track.id, instrument.samplePath, bank, preset).then(success => {
            if (success) {
              console.log(`[Preload] ✓ SF2 loaded for track ${track.id}`)
            } else {
              console.warn(`[Preload] ✗ Failed to load SF2 for track ${track.id}`)
            }
          }).catch(err => {
            console.error(`[Preload] Error loading SF2 for track ${track.id}:`, err)
          })
          
          sf2LoadPromises.push(promise)
        }
      })
      
      // Don't await - let SF2s load in background
      if (sf2LoadPromises.length > 0) {
        setLoadingMessage(`Loading ${sf2LoadPromises.length} instrument${sf2LoadPromises.length > 1 ? 's' : ''}...`)
        Promise.all(sf2LoadPromises).finally(() => {
          // Only clear loading message if not already showing VST loading
          if (Object.keys(nextTrackVSTPlugins).filter(tid => nextTrackVSTMode[tid]).length === 0) {
            setLoadingMessage('')
          }
        })
      }
      
      // Restore VST plugins and presets asynchronously (don't block UI)
      // PERFORMANCE OPTIMIZATION: Load VSTs in parallel instead of sequentially
      ;(async () => {
        console.log('[Load] Starting VST restoration...')
        console.log('[Load] nextTrackVSTPlugins:', nextTrackVSTPlugins)
        console.log('[Load] nextTrackVSTPresets:', Object.keys(nextTrackVSTPresets))
        
        const vstCount = Object.keys(nextTrackVSTPlugins).filter(tid => nextTrackVSTMode[tid]).length
        if (vstCount > 0) {
          setLoadingMessage(`Loading ${vstCount} VST plugin${vstCount > 1 ? 's' : ''}...`)
        }
        
        // Process tracks in parallel for much faster loading
        const trackIds = Object.keys(nextTrackVSTPlugins)
        const vstPromises = trackIds.map(async (trackId, index) => {
          const vstPath = nextTrackVSTPlugins[trackId]
          
          if (nextTrackVSTMode[trackId] && vstPath) {
            try {
              console.log(`[Load] [${index+1}/${trackIds.length}] Restoring VST for track ${trackId}...`)
              
              // Load the VST plugin
              const loadResult = await window.api?.backend?.loadVST?.(trackId, vstPath)
              if (loadResult && loadResult.ok) {
                console.log(`[Load] VST loaded for track ${trackId}:`, vstPath)
                
                // Reduced initialization wait time from 150ms to 50ms
                await new Promise(resolve => setTimeout(resolve, 50))
                
                // Restore preset state if available
                if (nextTrackVSTPresets[trackId]) {
                  console.log(`[Load] Setting VST preset for track ${trackId}, state length:`, nextTrackVSTPresets[trackId].length)
                  try {
                    // Set up listener BEFORE sending command
                    const responsePromise = waitForBackendEvent(
                      (line) => line.startsWith(`EVENT STATE_SET ${trackId}`) || line.startsWith(`ERROR SET_STATE ${trackId}`),
                      15000
                    )
                    
                    // Send SET_STATE command
                    await window.api?.backend?.setVSTState?.(trackId, nextTrackVSTPresets[trackId])
                    console.log(`[Load] SET_STATE command sent for track ${trackId}`)
                    
                    // Wait for confirmation
                    const response = await responsePromise
                    console.log(`[Load] setVSTState response:`, response)
                    
                    if (response.startsWith(`EVENT STATE_SET ${trackId}`)) {
                      console.log(`[Load] ✓ Successfully restored VST preset for track ${trackId}`)
                    } else {
                      console.error(`[Load] ✗ Failed to restore VST preset for track ${trackId}: ${response}`)
                    }
                  } catch (err) {
                    console.error(`[Load] Exception or timeout restoring VST state for track ${trackId}:`, err.message)
                  }
                } else {
                  console.warn(`[Load] No preset data found for track ${trackId}`)
                }
              } else {
                console.error(`[Load] Failed to load VST for track ${trackId}:`, loadResult?.error)
              }
            } catch (e) {
              console.error(`[Load] Error restoring VST for track ${trackId}:`, e)
            }
          }
        })
        
        // Wait for all VSTs to load in parallel
        await Promise.all(vstPromises)
        
        console.log('[Load] VST restoration complete')
        setLoadingMessage('')
        
        // Re-enable autosave and clear loading indicator after restoration completes
        setIsRestoring(false)
        setIsLoading(false)
      })()
    } catch (e) {
      console.error('Error loading project:', e)
      setIsLoading(false)
      setLoadingMessage('')
    }
    finally {
      loadDialogOpenRef.current = false
    }
  }

  // Unified autosave system - triggers save when state changes
  const autosaveTimerRef = useRef(null)
  const lastSaveDataRef = useRef(null)
  const isSavingRef = useRef(false)
  
  useEffect(() => {
    if (!currentProjectPath || isRestoring) return
    
    console.log('[Autosave] Effect triggered - trackOffsets:', trackOffsets)
    
    // Clear existing timer
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current)
    }
    
    // Debounced save
    autosaveTimerRef.current = setTimeout(async () => {
      // Skip if already saving
      if (isSavingRef.current) {
        console.log('[Autosave] Save already in progress, skipping')
        return
      }
      
      try {
        isSavingRef.current = true
        setIsAutosaving(true)
        const project = await buildProject()
        
        // Compare the actual project data, not the state values
        const currentData = JSON.stringify(project)
        
        // Skip save if nothing changed
        if (lastSaveDataRef.current === currentData) {
          console.log('[Autosave] No changes detected, skipping save')
          return
        }
        
        const r = await window.api?.saveProjectToPath?.(project, currentProjectPath)
        if (!r?.ok) {
          console.error('[Autosave] Failed:', r?.error)
        } else {
          console.log('[Autosave] ✓ Saved successfully to:', currentProjectPath)
          console.log('[Autosave] Saved tracks:', tracks.map(t => `${t.id}:${t.name}`))
          lastSaveDataRef.current = currentData
        }
      } catch (e) {
        console.error('[Autosave] Error:', e)
      } finally {
        isSavingRef.current = false
        setTimeout(() => setIsAutosaving(false), 500) // Show indicator briefly
      }
    }, 500) // debounce 500ms to batch rapid changes
    
    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current)
      }
    }
  }, [tracks, trackNotes, trackInstruments, trackVolumes, trackBeats, trackOffsets, trackLengths, trackVSTMode, trackVSTPlugins, trackVSTPresets, trackAutomation, trackMuted, trackSoloed, bpm, gridWidth, zoom, currentProjectPath, isRestoring])

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
            const project = await buildProject()
            const resp = await window.api?.saveProject?.(project, 'MelodyKit_Project.melodykit')
            if (resp?.ok) setCurrentProjectPath(resp.path)
          } catch (e) {
            console.error('Save As failed:', e)
          }
        }}
        onExportWav={() => timelineRef.current?.exportWav?.()}
        onImportAudio={handleImportAudio}
        currentProjectPath={currentProjectPath}
        loading={isLoading || isRestoring}
        loadingMessage={loadingMessage}
        isAutosaving={isAutosaving}
        bpm={bpm}
      />
      {showWelcome && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur">
          <div className="w-[min(640px,96vw)] max-h-[92vh] overflow-auto rounded-[28px] border border-zinc-700/70 bg-gradient-to-br from-zinc-900 via-zinc-900/90 to-amber-900/20 p-8 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.7)]">
            <div className="flex items-start gap-4">
              <div className="mt-1 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-400/15 ring-1 ring-amber-300/40 shadow-inner">
                <span className="text-lg font-semibold text-amber-200">♪</span>
              </div>
              <div className="flex-1 space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-amber-200">New Session</p>
                <h1 className="text-3xl font-semibold text-white">Welcome to MelodyKit</h1>
                <p className="text-sm leading-relaxed text-zinc-200">
                  Shape ideas like a professional! Add a track, drop in a loop, or open an existing project.
                </p>
                <p className="text-sm leading-relaxed text-zinc-300">
                  Need a great free synth? Grab Surge XT below and load it per track to craft your sound.
                </p>
              </div>
            </div>

            <div className="mt-6 flex flex-col gap-4 pl-14 sm:pl-16">
              <div className="flex flex-wrap gap-2 text-xs text-zinc-200">
                <span className="rounded-full border border-zinc-700/70 bg-zinc-800/60 px-3 py-1">Add MIDI or beat tracks</span>
                <span className="rounded-full border border-zinc-700/70 bg-zinc-800/60 px-3 py-1">Load VSTs per track</span>
                <span className="rounded-full border border-zinc-700/70 bg-zinc-800/60 px-3 py-1">Import and arrange audio</span>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  className="inline-flex items-center justify-center rounded-xl bg-white/90 px-4 py-2 text-sm font-semibold text-zinc-900 shadow-sm transition hover:bg-white"
                  onClick={() => setShowWelcome(false)}
                >
                  Start composing
                </button>
                <a
                  className="inline-flex items-center gap-2 rounded-xl bg-amber-500/15 px-4 py-2 text-sm font-medium text-amber-100 ring-1 ring-amber-300/40 transition hover:bg-amber-400/25"
                  href="https://surge-synthesizer.github.io/"
                  target="_blank"
                  rel="noreferrer"
                >
                  <span>Download Surge XT (VST)</span>
                  <span className="text-[11px] text-amber-200">surge-synthesizer.github.io</span>
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 min-w-0 flex">
        <Sidebar
          tracks={tracks}
          selectedTrackId={selectedTrackId}
          onSelectTrack={setSelectedTrackId}
          onAddTrack={handleAddTrack}
          onAddBeatTrack={handleAddBeatTrack}
          onAddSamplerTrack={handleAddSamplerTrack}
          onDeleteTrack={handleDeleteTrack}
          onRenameTrack={handleRenameTrack}
          onDuplicateTrack={handleDuplicateTrack}
          isRestoring={isRestoring}
          trackAutomation={trackAutomation}
          onAutomationChange={(trackId, automation) => setTrackAutomation(prev => ({ ...prev, [trackId]: automation }))}
        />
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {selectedTrack ? (
            selectedTrack.type === 'beat' ? (
              <SequencerPanel
                trackId={selectedTrack.id}
                pattern={trackBeats[selectedTrack.id] || { steps: 16, rows: [] }}
                onChange={(p) => setTrackBeats((prev) => ({ ...prev, [selectedTrack.id]: p }))}
                onBack={() => { setSelectedTrackId(null); triggerImmediateSave(); }}
                bpm={bpm}
              />
            ) : (
              <PianoRoll
                trackId={selectedTrack.id}
                trackName={selectedTrack.name}
                trackColor={selectedTrack.color}
                trackType={selectedTrack.type}
                notes={currentNotes}
                onNotesChange={(notes) => handleNotesChange(selectedTrack.id, notes)}
                onBack={() => { setSelectedTrackId(null); triggerImmediateSave(); }}
                gridWidth={gridWidth}
                setGridWidth={setGridWidth}
                bpm={bpm}
                setBpm={setBpm}
                selectedInstrument={currentInstrument}
                onInstrumentChange={(instrument) => handleInstrumentChange(selectedTrack.id, instrument)}
                useVSTBackend={trackVSTMode[selectedTrack.id] || false}
                onVSTModeChange={(enabled) => {
                  console.log(`VST mode changed for track ${selectedTrack.id}: ${enabled}`)
                  setTrackVSTMode({ ...trackVSTMode, [selectedTrack.id]: enabled })
                }}
                samplerPath={trackSamplerPaths[selectedTrack.id]}
                onSamplerPathChange={(path) => {
                  setTrackSamplerPaths({ ...trackSamplerPaths, [selectedTrack.id]: path })
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
              trackLengths={trackLengths}
              setTrackLengths={setTrackLengths}
              trackVSTMode={trackVSTMode}
              trackVSTLoading={trackVSTLoading}
              trackMuted={trackMuted}
              setTrackMuted={setTrackMuted}
              trackSoloed={trackSoloed}
              setTrackSoloed={setTrackSoloed}
              trackAutomation={trackAutomation}
              onAutomationChange={(trackId, automation) => setTrackAutomation(prev => ({ ...prev, [trackId]: automation }))}
              onSelectTrack={setSelectedTrackId}
              onAddTrack={handleAddTrack}
              gridWidth={gridWidth}
              setGridWidth={setGridWidth}
              zoom={zoom}
              setZoom={setZoom}
              bpm={bpm}
              setBpm={setBpm}
              loopStart={loopStart}
              setLoopStart={setLoopStart}
              loopEnd={loopEnd}
              setLoopEnd={setLoopEnd}
              onLoadingChange={setIsLoading}
              isRestoring={isRestoring}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export default App
