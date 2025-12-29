import { useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react'
import { stopAllNotes } from '../utils/soundfontPlayer'
import { startRecording } from '../utils/exportWav'
import { encodeToWav } from '../utils/fastWav'
import { loadSf2Instrument, playSf2Note } from '../utils/spessaSf2'
import { getSharedAudioContext } from '@renderer/utils/audioContext'
import { playBackendNote, noteNameToMidi } from '@renderer/utils/vstBackend'

const BEAT_WIDTH = 40
const TRACK_HEIGHT = 80
const TIMELINE_HEIGHT = 30
const SIDEBAR_WIDTH = 180
const INITIAL_GRID_WIDTH = 32
const EXTEND_AMOUNT = 16
// Draw text with ellipsis if it exceeds maxWidth
function drawEllipsizedText(ctx, text, x, y, maxWidth) {
  if (!text) return
  const fullWidth = ctx.measureText(text).width
  if (fullWidth <= maxWidth) {
    ctx.fillText(text, x, y)
    return
  }
  const ellipsis = '…'
  const ellW = ctx.measureText(ellipsis).width
  let low = 0
  let high = text.length
  let fit = ''
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = text.slice(0, mid)
    const w = ctx.measureText(candidate).width + ellW
    if (w <= maxWidth) {
      fit = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  ctx.fillText(fit + ellipsis, x, y)
}

function noteToFrequency(noteName) {
  const noteMap = {
    C: -9, 'C#': -8, D: -7, 'D#': -6, E: -5, F: -4,
    'F#': -3, G: -2, 'G#': -1, A: 0, 'A#': 1, B: 2
  }
  const note = noteName.slice(0, -1)
  const octave = parseInt(noteName.slice(-1))
  const halfSteps = noteMap[note] + (octave - 4) * 12
  return 440 * Math.pow(2, halfSteps / 12)
}

// Calculate region from notes
function calculateRegion(notes) {
  if (!notes || notes.length === 0) return null
  
  const starts = notes.map(n => n.start)
  const ends = notes.map(n => n.start + n.duration)
  
  return {
    start: Math.min(...starts),
    end: Math.max(...ends),
    duration: Math.max(...ends) - Math.min(...starts)
  }
}

const TrackTimeline = forwardRef(function TrackTimeline({ tracks, trackNotes, trackBeats, setTrackBeats, trackInstruments, trackVolumes, setTrackVolumes, trackOffsets, setTrackOffsets, trackVSTMode, onSelectTrack, gridWidth, setGridWidth, zoom, setZoom, bpm, setBpm, onLoadingChange, isRestoring }, ref) {
  const [isPlaying, setIsPlaying] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [currentBeat, setCurrentBeat] = useState(0)
  const [hoveredTrack, setHoveredTrack] = useState(null)
  const [resizing, setResizing] = useState(null) // { trackId, startX, startLen, currentLen }
  const [dragging, setDragging] = useState(null) // { trackId, startX, startBeat, currentBeat, offsetBeats }
  const resizeClickSuppressRef = useRef(false)
  const dragClickSuppressRef = useRef(false)
  const [bpmInput, setBpmInput] = useState(bpm.toString())
  const canvasRef = useRef(null)
  const timelineCanvasRef = useRef(null)
  const scrollContainerRef = useRef(null)
  const audioContextRef = useRef(null)
  const [audioReady, setAudioReady] = useState(false)
  const playbackIntervalRef = useRef(null)
  const trackNotesRef = useRef(trackNotes)
  const trackInstrumentsRef = useRef(trackInstruments)
  const loadedInstrumentsRef = useRef({}) // Store loaded instruments by track ID
  const loadedAudioClipsRef = useRef({}) // Store decoded AudioBuffer by track ID for audio tracks
  const loadedBeatSamplesRef = useRef({}) // { [trackId]: { [rowId]: AudioBuffer } }
  const audioSourcesRef = useRef({}) // Active AudioBufferSourceNodes per audio track
  const activeSourcesRef = useRef([]) // Track active audio sources
  const beatLastStepRef = useRef({}) // Track last step index per beat track for scheduling
  const masterGainRef = useRef(null) // Master volume control
  const recordBusRef = useRef(null) // Invisible bus we record from
  const limiterRef = useRef(null) // Master limiter to prevent clipping
  const audioConnectPatchedRef = useRef(null) // store original connect
  const mirroredNodesRef = useRef(new WeakSet())
  const perTrackGainsRef = useRef({}) // { [trackId]: GainNode }
  const perTrackPreGainsRef = useRef({}) // { [trackId]: GainNode } pre-fader boost
  const perTrackSf2BoostGainsRef = useRef({}) // { [trackId]: GainNode } SF2-only boost

  // Ensure per-track gain chain exists for current context
  const ensureTrackChain = (trackId) => {
    const ctx = audioContextRef.current
    if (!ctx) return { pre: null, g: null }
    // Track gain
    let g = perTrackGainsRef.current[trackId]
    if (!g || (g.context && g.context !== ctx)) {
      try { g?.disconnect() } catch {}
      g = ctx.createGain()
      const vPct = Math.max(0, Math.min(150, Number(trackVolumes?.[trackId] ?? 100)))
      const v = vPct / 100
      try { g.gain.setValueAtTime(v, ctx.currentTime) } catch { g.gain.value = v }
      if (masterGainRef.current && masterGainRef.current.context === ctx) {
        g.connect(masterGainRef.current)
      } else {
        g.connect(ctx.destination)
      }
      perTrackGainsRef.current[trackId] = g
    }
    // Pre-gain
    let pre = perTrackPreGainsRef.current[trackId]
    if (!pre || (pre.context && pre.context !== ctx)) {
      try { pre?.disconnect() } catch {}
      pre = ctx.createGain()
      pre.gain.value = 1.8
      pre.connect(g)
      perTrackPreGainsRef.current[trackId] = pre
    } else {
      try { pre.connect(g) } catch {}
    }
    return { pre, g }
  }

  // Calculate beat width based on zoom level
  const beatWidth = BEAT_WIDTH * zoom

  useEffect(() => {
    // Use shared AudioContext across views
    audioContextRef.current = getSharedAudioContext()

  // Create master gain node and record bus
  masterGainRef.current = audioContextRef.current.createGain()
  // Keep master at unity; we'll handle perceived loudness at track pre-gain + limiter
  masterGainRef.current.gain.value = 1.0
    recordBusRef.current = audioContextRef.current.createGain()
    recordBusRef.current.gain.value = 1.0

    // Insert a master limiter to catch peaks when boosting
    try {
      const limiter = audioContextRef.current.createDynamicsCompressor()
      // Configure as a soft limiter
      limiter.threshold.value = -1
      limiter.ratio.value = 20
      limiter.attack.value = 0.003
      limiter.release.value = 0.25
      limiter.knee.value = 1
      masterGainRef.current.connect(limiter)
      // Route limiter to audible destination and record bus (post-limiter capture)
      limiter.connect(audioContextRef.current.destination)
      limiter.connect(recordBusRef.current)
      limiterRef.current = limiter
    } catch {
      // Fallback: connect master directly if DynamicsCompressor unavailable
      masterGainRef.current.connect(audioContextRef.current.destination)
      masterGainRef.current.connect(recordBusRef.current)
    }

    // Monkey-patch AudioNode.connect to mirror any connections to destination
  // into our record bus for THIS context, so third-party nodes (synth) are captured.
    const origConnect = AudioNode.prototype.connect
    audioConnectPatchedRef.current = origConnect
    AudioNode.prototype.connect = function (...args) {
      const dest = args[0]
      const result = origConnect.apply(this, args)
      try {
        const ctx = audioContextRef.current
        if (ctx && dest === ctx.destination) {
          const bus = recordBusRef.current
          if (bus && !mirroredNodesRef.current.has(this)) {
            // Mirror this source to the record bus
            origConnect.call(this, bus)
            mirroredNodesRef.current.add(this)
          }
        }
      } catch (e) {
        // no-op
      }
      return result
    }
    
  // Mark audio as ready so dependent effects (e.g., instrument loading) can proceed
  try { setAudioReady(true) } catch {}

  return () => {
      // Cleanup all active sources
      stopAllNotes(activeSourcesRef.current)
      // Stop any loaded SF2 samplers
      try {
        Object.values(loadedInstrumentsRef.current).forEach((inst) => {
          if (inst && inst.type === 'sf2' && inst.data && typeof inst.data.stop === 'function') {
            try { inst.data.stop() } catch {}
          }
        })
      } catch {}
      if (masterGainRef.current) {
        masterGainRef.current.disconnect()
      }
      if (limiterRef.current) {
        try { limiterRef.current.disconnect() } catch {}
        limiterRef.current = null
      }
      // Disconnect per-track gains
      try {
        Object.values(perTrackGainsRef.current || {}).forEach((gn) => {
          try { gn.disconnect() } catch {}
        })
        Object.values(perTrackPreGainsRef.current || {}).forEach((gn) => {
          try { gn.disconnect() } catch {}
        })
      } catch {}
      if (recordBusRef.current) {
        try { recordBusRef.current.disconnect() } catch {}
      }
      // Restore original connect
      if (audioConnectPatchedRef.current) {
        AudioNode.prototype.connect = audioConnectPatchedRef.current
        audioConnectPatchedRef.current = null
      }
      // Do not close the shared context
    }
  }, [])

  useEffect(() => { trackNotesRef.current = trackNotes }, [trackNotes])
  useEffect(() => { trackInstrumentsRef.current = trackInstruments }, [trackInstruments])

  // Ensure per-track gain nodes exist and are connected
  useEffect(() => {
    if (!audioContextRef.current || !masterGainRef.current) return
    const map = perTrackGainsRef.current
    const preMap = perTrackPreGainsRef.current
    const sf2Map = perTrackSf2BoostGainsRef.current
    // Create/Connect for existing tracks
    tracks.forEach((t) => {
      // Recreate node if it belongs to a different AudioContext (can happen with StrictMode remounts)
      if (map[t.id] && map[t.id].context && map[t.id].context !== audioContextRef.current) {
        try { map[t.id].disconnect() } catch {}
        delete map[t.id]
      }
      if (preMap[t.id] && preMap[t.id].context && preMap[t.id].context !== audioContextRef.current) {
        try { preMap[t.id].disconnect() } catch {}
        delete preMap[t.id]
      }
      if (sf2Map[t.id] && sf2Map[t.id].context && sf2Map[t.id].context !== audioContextRef.current) {
        try { sf2Map[t.id].disconnect() } catch {}
        delete sf2Map[t.id]
      }
      if (!map[t.id]) {
        const g = audioContextRef.current.createGain()
        // default to 1.0; will be updated below by volumes effect
        g.gain.value = Math.max(0, (trackVolumes?.[t.id] ?? 100) / 100)
        g.connect(masterGainRef.current)
        map[t.id] = g
      } else {
        // Ensure connected
        try { map[t.id].connect(masterGainRef.current) } catch {}
      }
      // Ensure pre-gain exists and connects to track gain
      if (!preMap[t.id]) {
        const pre = audioContextRef.current.createGain()
        // Apply a modest pre-boost (~+5 dB)
        pre.gain.value = 1.8
        pre.connect(map[t.id])
        preMap[t.id] = pre
      } else {
        try { preMap[t.id].connect(map[t.id]) } catch {}
      }
      // Ensure sf2-only boost exists and connects to pre-gain
      if (!sf2Map[t.id]) {
        const sf2g = audioContextRef.current.createGain()
        // SF2-specific additional boost (~+3 dB)
        sf2g.gain.value = 1.4
        sf2g.connect(preMap[t.id])
        sf2Map[t.id] = sf2g
      } else {
        try { sf2Map[t.id].connect(preMap[t.id]) } catch {}
      }
    })
    // Cleanup removed tracks
    Object.keys(map).forEach((id) => {
      if (!tracks.find(t => String(t.id) === String(id))) {
        try { map[id].disconnect() } catch {}
        delete map[id]
      }
    })
    Object.keys(preMap).forEach((id) => {
      if (!tracks.find(t => String(t.id) === String(id))) {
        try { preMap[id].disconnect() } catch {}
        delete preMap[id]
      }
    })
    Object.keys(sf2Map).forEach((id) => {
      if (!tracks.find(t => String(t.id) === String(id))) {
        try { sf2Map[id].disconnect() } catch {}
        delete sf2Map[id]
      }
    })
  }, [tracks])

  // Apply volume changes to per-track gains (and pre-gain) and VST tracks
  useEffect(() => {
    const map = perTrackGainsRef.current
    const preMap = perTrackPreGainsRef.current
    if (!map) return
    if (!trackVolumes) return
    Object.entries(trackVolumes).forEach(([trackId, vol]) => {
      // Update Web Audio gain nodes for SF2/audio tracks
      const g = map[trackId]
      if (g) {
        const v = Math.max(0, Math.min(150, Number(vol) || 80)) / 100
        try { g.gain.setValueAtTime(v, audioContextRef.current.currentTime) } catch { g.gain.value = v }
      }
      const pre = preMap?.[trackId]
      if (pre) {
        const v = Math.max(0, Math.min(150, Number(vol) || 80)) / 100
        const preTarget = 1.8 * v
        try { pre.gain.setValueAtTime(preTarget, audioContextRef.current.currentTime) } catch { pre.gain.value = preTarget }
      }
      
      // Update VST track volume via MIDI CC
      const isVST = trackVSTMode?.[trackId]
      if (isVST) {
        // Map 0-150% to MIDI 0-127 range, then reduce by 50% for VST loudness
        const volPercent = Math.max(0, Math.min(150, Number(vol) || 100))
        const midiVolume = Math.round((volPercent / 150) * 127 * 0.5)
        window.api.backend.setVolume(String(trackId), midiVolume, 1).catch(err => {
          console.error(`Failed to set VST volume for track ${trackId}:`, err)
        })
      }
    })
  }, [trackVolumes, trackVSTMode])

  // Decode imported audio clips for this AudioContext
  useEffect(() => {
    const ctx = audioContextRef.current
    if (!ctx) return
    const load = async () => {
      for (const t of tracks) {
        if (t.type === 'audio' && t.audioClip && !loadedAudioClipsRef.current[t.id]) {
          try {
            let bytes = t.audioClip.bytes
            if (!bytes && t.audioClip.path && window.api?.readAudioFile) {
              const res = await window.api.readAudioFile(t.audioClip.path)
              if (res && res.ok && Array.isArray(res.bytes)) bytes = res.bytes
            }
            if (bytes) {
              const uint8 = Uint8Array.from(bytes)
              const ab = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength)
              const buffer = await ctx.decodeAudioData(ab)
              loadedAudioClipsRef.current[t.id] = { buffer }
            }
          } catch (e) {
            console.error('Failed to decode audio clip for track', t.id, e)
          }
        }
      }
      // Cleanup for removed tracks
      Object.keys(loadedAudioClipsRef.current).forEach((id) => {
        if (!tracks.find(t => String(t.id) === String(id) && t.type === 'audio')) {
          delete loadedAudioClipsRef.current[id]
        }
      })
    }
    load()
  }, [tracks])

  // Load drum samples for beat tracks
  useEffect(() => {
    const ctx = audioContextRef.current
    if (!ctx || !trackBeats) return
    const load = async () => {
      for (const t of tracks) {
        if (t.type !== 'beat') continue
        const pattern = trackBeats[t.id]
        if (!pattern || !Array.isArray(pattern.rows)) continue
        if (!loadedBeatSamplesRef.current[t.id]) loadedBeatSamplesRef.current[t.id] = {}
        for (const row of pattern.rows) {
          const key = row.id
          if (!key) continue
          const hasBuf = loadedBeatSamplesRef.current[t.id][key]
          const filePath = row.filePath
          if (!hasBuf && filePath && window.api?.readAudioFile) {
            try {
              const res = await window.api.readAudioFile(filePath)
              if (res && res.ok && Array.isArray(res.bytes)) {
                const uint8 = Uint8Array.from(res.bytes)
                const ab = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength)
                const buffer = await ctx.decodeAudioData(ab)
                loadedBeatSamplesRef.current[t.id][key] = buffer
              }
            } catch (e) {
              console.error('Failed to load beat sample', filePath, e)
            }
          }
        }
      }
      // Cleanup missing tracks/rows
      Object.keys(loadedBeatSamplesRef.current).forEach((trackId) => {
        if (!tracks.find(tr => String(tr.id) === String(trackId))) {
          delete loadedBeatSamplesRef.current[trackId]
        }
      })
      Object.entries(loadedBeatSamplesRef.current).forEach(([trackId, map]) => {
        const p = trackBeats[trackId]
        const validRowIds = new Set((p?.rows || []).map(r => r.id))
        Object.keys(map).forEach((rid) => {
          if (!validRowIds.has(rid)) delete map[rid]
        })
      })
    }
    load()
  }, [tracks, trackBeats])

  // Track current async load session to avoid race conditions
  const loadSessionRef = useRef(0)

  // Load instruments when they change
  useEffect(() => {
    const loadAllInstruments = async () => {
      // Wait until AudioContext is ready before attempting to load/connect instruments
      if (!trackInstruments || !audioReady || !audioContextRef.current) return
      try { if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume() } catch {}
      const sessionId = ++loadSessionRef.current

      // Determine if there is anything to load (SF2s or changed instruments)
      let needsLoading = false
      // Helper to ensure we return a destination node from the current AudioContext
      const ensureTrackDestination = (trackId) => {
        const ctx = audioContextRef.current
        if (!ctx) return null
        let g = perTrackGainsRef.current[trackId]
        if (!g || (g.context && g.context !== ctx)) {
          try { g?.disconnect() } catch {}
          g = ctx.createGain()
          const v = Math.max(0, (trackVolumes?.[trackId] ?? 100) / 100)
          try { g.gain.setValueAtTime(v, ctx.currentTime) } catch { g.gain.value = v }
          if (masterGainRef.current && masterGainRef.current.context === ctx) {
            g.connect(masterGainRef.current)
          } else {
            // Fallback connect directly
            g.connect(ctx.destination)
          }
          perTrackGainsRef.current[trackId] = g
        }
        // Ensure pre-gain exists and connects to the track gain
        let pre = perTrackPreGainsRef.current[trackId]
        if (!pre || (pre.context && pre.context !== ctx)) {
          try { pre?.disconnect() } catch {}
          pre = ctx.createGain()
          pre.gain.value = 1.8
          pre.connect(g)
          perTrackPreGainsRef.current[trackId] = pre
        } else {
          try { pre.connect(g) } catch {}
        }
        // Ensure sf2 boost exists and connects to pre
        let sf2g = perTrackSf2BoostGainsRef.current[trackId]
        if (!sf2g || (sf2g.context && sf2g.context !== ctx)) {
          try { sf2g?.disconnect() } catch {}
          sf2g = ctx.createGain()
          sf2g.gain.value = 1.4
          sf2g.connect(pre)
          perTrackSf2BoostGainsRef.current[trackId] = sf2g
        } else {
          try { sf2g.connect(pre) } catch {}
        }
        // Return sf2-only boost as destination for SF2 instruments
        return sf2g
      }

      for (const [trackId, instrument] of Object.entries(trackInstruments)) {
        if (!instrument || !instrument.samplePath) continue
        const existing = loadedInstrumentsRef.current[trackId]
        if (!existing || existing.samplePath !== instrument.samplePath) {
          needsLoading = true
          break
        }
      }

      if (needsLoading) {
        try { onLoadingChange?.(true) } catch {}
      } else {
        // Nothing to load; ensure loading indicator is cleared
        try { onLoadingChange?.(false) } catch {}
        return
      }

      for (const [trackId, instrument] of Object.entries(trackInstruments)) {
        if (!instrument || !instrument.samplePath) continue
        
        // If already loaded but samplePath changed, dispose and reload
        const existing = loadedInstrumentsRef.current[trackId]
        if (existing && existing.samplePath === instrument.samplePath) {
          console.log(`Track ${trackId} instrument already loaded`)
          continue
        } else if (existing) {
          // Stop previous sampler if needed
          if (existing.type === 'sf2' && existing.data && typeof existing.data.stop === 'function') {
            try { existing.data.stop() } catch {}
          }
          delete loadedInstrumentsRef.current[trackId]
        }
        
        try {
          console.log(`Loading instrument for track ${trackId}:`, instrument.name, instrument.samplePath)

          // Use spessasynth_lib for SF2 files
          if (instrument.samplePath.toLowerCase().endsWith('.sf2')) {
            // Load without destination to use shared cache (PianoRoll already loaded this)
            const sampler = await loadSf2Instrument(
              instrument.samplePath,
              audioContextRef.current
            )
            // Route synth to this track's pre-gain chain for per-track volume control
            if (sampler && sampler.synth) {
              try {
                const { pre } = ensureTrackChain(trackId)
                if (pre) {
                  try { sampler.synth.disconnect() } catch {}
                  sampler.synth.connect(pre)
                } else {
                  const dest = masterGainRef.current || audioContextRef.current.destination
                  try { sampler.synth.disconnect() } catch {}
                  sampler.synth.connect(dest)
                }
              } catch (e) {
                console.error(`Failed to route synth for track ${trackId}:`, e)
              }
            }
            loadedInstrumentsRef.current[trackId] = { type: 'sf2', data: sampler, samplePath: instrument.samplePath }
            console.log(`Track ${trackId} SF2 loaded via spessasynth_lib`)
          } else {
            // Non-SF2: for now, fallback to oscillator during playback
            loadedInstrumentsRef.current[trackId] = { type: 'none', samplePath: instrument.samplePath }
            console.log(`Track ${trackId} non-SF2 instrument: using oscillator fallback`)
          }
        } catch (error) {
          console.error(`Failed to load instrument for track ${trackId}:`, error)
        }
      }

      // Only clear loading if this is the latest session and not restoring VSTs
      if (loadSessionRef.current === sessionId && !isRestoring) {
        try { onLoadingChange?.(false) } catch {}
      }
    }
    
    loadAllInstruments()
  }, [trackInstruments, audioReady, isRestoring])

  // Sync bpmInput when bpm prop changes (e.g., from PianoRoll)
  useEffect(() => {
    setBpmInput(bpm.toString())
  }, [bpm])

  const CANVAS_HEIGHT = tracks.length * TRACK_HEIGHT

  // Draw timeline
  useEffect(() => {
    const canvas = timelineCanvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const CANVAS_WIDTH = gridWidth * beatWidth + SIDEBAR_WIDTH
    canvas.width = CANVAS_WIDTH * dpr
    canvas.height = TIMELINE_HEIGHT * dpr
    canvas.style.width = CANVAS_WIDTH + 'px'
    canvas.style.height = TIMELINE_HEIGHT + 'px'
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    
    // Background
    ctx.fillStyle = '#18181b'
    ctx.fillRect(0, 0, CANVAS_WIDTH, TIMELINE_HEIGHT)
    
    // Track label area
    ctx.fillStyle = '#27272a'
    ctx.fillRect(0, 0, SIDEBAR_WIDTH, TIMELINE_HEIGHT)
    
    // Beat markers
    for (let i = 0; i <= gridWidth; i++) {
      const x = SIDEBAR_WIDTH + i * beatWidth
      
      // Draw vertical grid line
      if (i % 4 === 0) {
        ctx.strokeStyle = '#3f3f46'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, TIMELINE_HEIGHT)
        ctx.stroke()
      }
      
      // Beat numbers on every 4 beats
      if (i % 4 === 0) {
        ctx.fillStyle = '#a1a1aa'
        ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText((i / 4 + 1).toString(), x, TIMELINE_HEIGHT / 2)
      }
    }
    
    // Border
    ctx.strokeStyle = '#3f3f46'
    ctx.lineWidth = 1
    ctx.strokeRect(0, 0, CANVAS_WIDTH, TIMELINE_HEIGHT)
    
    // Playhead on timeline
    if (isPlaying || currentBeat > 0) {
      ctx.fillStyle = '#ef4444'
      ctx.fillRect(SIDEBAR_WIDTH + currentBeat * beatWidth - 1.5, 0, 3, TIMELINE_HEIGHT)
    }
  }, [gridWidth, currentBeat, isPlaying, beatWidth])

  // Draw track rows
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const CANVAS_WIDTH = gridWidth * beatWidth + SIDEBAR_WIDTH
    canvas.width = CANVAS_WIDTH * dpr
    canvas.height = CANVAS_HEIGHT * dpr
    canvas.style.width = CANVAS_WIDTH + 'px'
    canvas.style.height = CANVAS_HEIGHT + 'px'
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    
    // Draw each track row
    tracks.forEach((track, index) => {
      const y = index * TRACK_HEIGHT
      const isHovered = hoveredTrack === index
      
      // Track background
      ctx.fillStyle = '#27272a'
      ctx.fillRect(0, y, CANVAS_WIDTH, TRACK_HEIGHT)
      
      // Timeline area background
      ctx.fillStyle = '#18181b'
      ctx.fillRect(SIDEBAR_WIDTH, y, CANVAS_WIDTH - SIDEBAR_WIDTH, TRACK_HEIGHT)
      
      // Hover effect
      if (isHovered) {
        ctx.fillStyle = 'rgba(63, 63, 70, 0.3)'
        ctx.fillRect(0, y, CANVAS_WIDTH, TRACK_HEIGHT)
      }
      
      // Draw grid lines (every 4 beats)
      for (let i = 0; i <= gridWidth; i += 4) {
        ctx.strokeStyle = '#3f3f46'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(SIDEBAR_WIDTH + i * beatWidth, y)
        ctx.lineTo(SIDEBAR_WIDTH + i * beatWidth, y + TRACK_HEIGHT)
        ctx.stroke()
      }
      
      // Track info sidebar
      const padding = 12
      
      // Track color indicator (left border)
      ctx.fillStyle = track.color
      ctx.fillRect(0, y, 4, TRACK_HEIGHT)
      
  // Track name (clipped to sidebar width)
  ctx.fillStyle = '#fafafa'
  ctx.font = '600 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  const sidebarTextX = padding + 4
  const sidebarMaxW = SIDEBAR_WIDTH - sidebarTextX - 12
  drawEllipsizedText(ctx, track.name, sidebarTextX, y + padding, sidebarMaxW)
      
      // Note count / info
      const notes = trackNotes[track.id] || []
      ctx.fillStyle = '#a1a1aa'
      ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      if (track.type === 'audio') {
        const clipName = track.audioClip?.name || 'Audio'
        drawEllipsizedText(ctx, `${clipName}`, sidebarTextX, y + padding + 22, sidebarMaxW)
      } else {
        drawEllipsizedText(ctx, `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`, sidebarTextX, y + padding + 22, sidebarMaxW)
      }
      
      
      // Draw region: for MIDI tracks use notes; for audio tracks use clip duration; for beat tracks use adjustable loop length
      let region = null
      let trackOffset = typeof trackOffsets?.[track.id] === 'number' ? trackOffsets[track.id] : 0
      
      if (track.type === 'audio') {
        const rec = loadedAudioClipsRef.current?.[track.id]
        const durationSec = rec?.buffer?.duration || 0
        if (durationSec > 0) {
          const beats = (durationSec * bpm) / 60
          // Apply offset for audio tracks
          if (dragging && dragging.trackId === track.id && typeof dragging.currentBeat === 'number') {
            trackOffset = dragging.currentBeat
          }
          region = { start: trackOffset, duration: beats, end: trackOffset + beats }
        }
      } else if (track.type === 'beat') {
        const p = trackBeats?.[track.id]
        if (p) {
          // Default to 1 bar (4 beats) when no explicit length is set, regardless of steps count
          const defaultBeats = 4
          let beats = typeof p.lengthBeats === 'number' ? Math.max(4, p.lengthBeats) : defaultBeats
          // If actively resizing this beat track, show live length
          if (resizing && resizing.trackId === track.id && typeof resizing.currentLen === 'number') {
            beats = Math.max(4, resizing.currentLen)
          }
          // Get start position from trackOffsets (unified across all track types)
          let startBeat = trackOffset
          // If actively dragging this beat track, show live position
          if (dragging && dragging.trackId === track.id && typeof dragging.currentBeat === 'number') {
            startBeat = dragging.currentBeat
          }
          region = { start: startBeat, duration: beats, end: startBeat + beats }
        }
      } else {
        // MIDI/note tracks
        if (notes && notes.length > 0) {
          // Apply offset for MIDI tracks
          if (dragging && dragging.trackId === track.id && typeof dragging.currentBeat === 'number') {
            trackOffset = dragging.currentBeat
          }
          // Find the last note end position (relative to track start)
          const ends = notes.map(n => (n.start || 0) + (n.duration || 0))
          const lastNoteEnd = Math.max(...ends)
          // Region starts at track offset (beat 0 of track) and extends to last note
          region = { 
            start: trackOffset, 
            duration: lastNoteEnd, 
            end: trackOffset + lastNoteEnd 
          }
        }
      }
      if (region) {
        const regionX = SIDEBAR_WIDTH + region.start * beatWidth
        const regionWidth = region.duration * beatWidth
        const regionY = y + 12
        const regionHeight = TRACK_HEIGHT - 24
        
        const isRegionHovered = hoveredTrack === index
        
        // Region background with gradient
        const gradient = ctx.createLinearGradient(regionX, regionY, regionX, regionY + regionHeight)
        const baseColor = track.color
        gradient.addColorStop(0, baseColor + (isRegionHovered ? 'DD' : 'CC'))
        gradient.addColorStop(1, baseColor + (isRegionHovered ? 'AA' : '99'))
        ctx.fillStyle = gradient
        ctx.beginPath()
        ctx.roundRect(regionX, regionY, regionWidth, regionHeight, 6)
        ctx.fill()
        
        // Region border
        ctx.strokeStyle = isRegionHovered ? '#ffffff' : track.color
        ctx.lineWidth = isRegionHovered ? 3 : 2
        ctx.stroke()
        
        // Region name/label
        ctx.fillStyle = '#ffffff'
        ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        const labelPadding = 8
        ctx.save()
        ctx.beginPath()
        ctx.rect(regionX, regionY, regionWidth, regionHeight)
        ctx.clip()
        ctx.fillText(track.name, regionX + labelPadding, regionY + labelPadding)
        ctx.restore()
        
        // Waveform-like visualization (simplified)
        ctx.strokeStyle = '#ffffff66'
        ctx.lineWidth = 1
        const waveY = regionY + regionHeight / 2
        for (let i = 0; i < regionWidth - 4; i += 3) {
          const amplitude = (Math.sin(i * 0.1) * 0.3 + 0.7) * (regionHeight * 0.3)
          ctx.beginPath()
          ctx.moveTo(regionX + labelPadding + i, waveY - amplitude / 2)
          ctx.lineTo(regionX + labelPadding + i, waveY + amplitude / 2)
          ctx.stroke()
        }

        // Resize handle for beat tracks
        if (track.type === 'beat') {
          const handleX = regionX + regionWidth - 4
          ctx.fillStyle = '#ffffff99'
          ctx.fillRect(handleX, regionY + 6, 3, regionHeight - 12)
        }
      }
      
      // Track separator
      ctx.strokeStyle = '#18181b'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, y + TRACK_HEIGHT)
      ctx.lineTo(CANVAS_WIDTH, y + TRACK_HEIGHT)
      ctx.stroke()
    })
    
    // Draw playhead
    if (isPlaying || currentBeat > 0) {
      ctx.fillStyle = '#ef4444'
      ctx.shadowColor = '#ef4444'
      ctx.shadowBlur = 4
      ctx.fillRect(SIDEBAR_WIDTH + currentBeat * beatWidth - 1.5, 0, 3, CANVAS_HEIGHT)
      ctx.shadowBlur = 0
    }
  }, [tracks, trackNotes, trackBeats, trackOffsets, gridWidth, currentBeat, isPlaying, hoveredTrack, beatWidth, resizing, dragging])

  // Play a note with per-track instrument support
  const playNote = (trackId, noteName, duration = 0.3) => {
    if (!audioContextRef.current) return
    const ctx = audioContextRef.current
    const destination = masterGainRef.current || ctx.destination
    
    const loadedInstrument = loadedInstrumentsRef.current[trackId]
    
    console.log(`Playing note for track ${trackId}:`, noteName, 'Loaded instrument:', loadedInstrument)
    
    // Check if track uses VST backend
    const useVST = trackVSTMode && trackVSTMode[trackId]
    if (useVST) {
      try {
        console.log(`Using VST backend for track ${trackId}`)
        const midiNote = noteNameToMidi(noteName)
        
        // Send volume CC message before the note to ensure it's applied
        // Map 0-150% volume to MIDI 0-127 range, then reduce by 50% for VST loudness
        const volPercent = Math.max(0, Math.min(150, Number(trackVolumes?.[trackId] ?? 100)))
        const midiVolume = Math.round((volPercent / 150) * 127 * 0.5)
        window.api.backend.setVolume(String(trackId), midiVolume, 1).catch(() => {})
        
        // Use constant velocity, let CC 7 handle volume
        const velocity = 0.8
        playBackendNote(trackId, midiNote, velocity, Math.floor(duration * 1000), 1)
        return
      } catch (error) {
        console.error('Error playing VST note:', error)
        // Fall through to SF2/oscillator
      }
    }
    
  // If we have a loaded SF2 for this track, use spessasynth_lib. Only fall back on explicit errors.
    if (loadedInstrument && loadedInstrument.type === 'sf2') {
      try {
  console.log(`Using SF2 (spessasynth_lib) for track ${trackId}`)
        // Scale velocity by track volume so changes are audible even if sampler routes to destination directly
        const vol = Math.max(0, Math.min(150, Number(trackVolumes?.[trackId] ?? 100)))
        const baseVelocity = 80
        const velocity = Math.max(1, Math.min(127, Math.round(baseVelocity * (vol / 100))))
        playSf2Note(loadedInstrument.data, noteName, duration, velocity)
  // Do not fall back if return value is falsy; spessasynth_lib may not return an object.
      } catch (error) {
  console.error('Error playing SF2 (spessasynth_lib):', error)
        playOscillatorNote(trackId, noteName, duration)
      }
    } else {
      // Fallback to oscillator
      playOscillatorNote(trackId, noteName, duration)
    }
  }

  // Fallback oscillator playback
  const playOscillatorNote = (trackId, noteName, duration = 0.3) => {
    if (!audioContextRef.current) return
    const ctx = audioContextRef.current
    const oscillator = ctx.createOscillator()
    const gainNode = ctx.createGain()
    oscillator.connect(gainNode)
    // Route oscillator directly to track gain (bypass SF2 and pre boosts)
    const preGain = perTrackPreGainsRef.current?.[trackId]
    const trackGain = perTrackGainsRef.current?.[trackId]
    if (trackGain) {
      gainNode.connect(trackGain)
    } else if (trackGain) {
      gainNode.connect(trackGain)
    } else if (masterGainRef.current) {
      gainNode.connect(masterGainRef.current)
    } else {
      gainNode.connect(ctx.destination)
    }
    
    oscillator.frequency.value = noteToFrequency(noteName)
    oscillator.type = 'sine'
    
    // Sustain oscillator with quick fade at end
    const fadeOutTime = Math.min(duration * 0.1, 0.05)
    const sustainTime = duration - fadeOutTime
    
    // Slightly lower default oscillator loudness
    gainNode.gain.setValueAtTime(0.2, ctx.currentTime)
    
    if (sustainTime > 0) {
      gainNode.gain.setValueAtTime(0.2, ctx.currentTime + sustainTime)
    }
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration)
    
    oscillator.start(ctx.currentTime)
    oscillator.stop(ctx.currentTime + duration)
    
    oscillator.onended = () => {
      oscillator.disconnect()
      gainNode.disconnect()
    }
  }

  // Playback all tracks
  const togglePlayback = (startBeatOverride) => {
    // Prevent toggling playback while recording/exporting, restoring VSTs, or when there are no tracks
    if (isRecording || isRestoring) return
    if (!tracks || tracks.length === 0) return
    if (isPlaying) {
      setIsPlaying(false)
      if (playbackIntervalRef.current) clearInterval(playbackIntervalRef.current)
      // Stop any audio clip playback
      try { Object.values(audioSourcesRef.current || {}).forEach((s) => { try { s.stop() } catch {} }); audioSourcesRef.current = {} } catch {}
    } else {
      setIsPlaying(true)
      beatLastStepRef.current = {}
      const beatDuration = 60000 / bpm
      const startBeat = (typeof startBeatOverride === 'number' ? startBeatOverride : currentBeat) || 0
      const startTime = Date.now() - startBeat * beatDuration
      // Compute when to stop (last note/clip/beat end across all tracks)
      let maxEndBeat = 0
      const tnPlay = trackNotesRef.current || {}
      Object.entries(tnPlay).forEach(([trackId, notes = []]) => {
        const trackOffset = typeof trackOffsets?.[trackId] === 'number' ? trackOffsets[trackId] : 0
        for (const n of notes) {
          const endBeat = (n.start || 0) + (n.duration || 0) + trackOffset
          if (endBeat > maxEndBeat) maxEndBeat = endBeat
        }
      })
      // Include audio clip durations
      try {
        tracks.forEach((t) => {
          const trackOffset = typeof trackOffsets?.[t.id] === 'number' ? trackOffsets[t.id] : 0
          if (t.type === 'audio') {
            const buf = loadedAudioClipsRef.current?.[t.id]?.buffer
            if (buf) {
              const beats = (buf.duration * bpm) / 60 + trackOffset
              if (beats > maxEndBeat) maxEndBeat = beats
            }
            return
          }
          if (t.type === 'beat') {
            const p = trackBeats?.[t.id]
            if (p) {
              const defaultBeats = 4
              const beats = typeof p.lengthBeats === 'number' ? Math.max(4, p.lengthBeats) : defaultBeats
              const endBeat = trackOffset + beats
              if (endBeat > maxEndBeat) maxEndBeat = endBeat
            }
          }
        })
      } catch {}
      if (maxEndBeat <= 0) maxEndBeat = gridWidth
      // Start audio clip tracks from the correct offset
      try {
        const ctx = audioContextRef.current
        const startOffsetSecBase = startBeat * (60 / bpm)
        // Stop existing sources first
        Object.values(audioSourcesRef.current || {}).forEach((s) => { try { s.stop() } catch {} })
        audioSourcesRef.current = {}
        tracks.forEach((t) => {
          if (t.type === 'audio') {
            const rec = loadedAudioClipsRef.current?.[t.id]
            const { g } = ensureTrackChain(t.id)
            if (rec && rec.buffer && ctx) {
              const buf = rec.buffer
              // Apply track offset to audio playback
              const trackOffset = typeof trackOffsets?.[t.id] === 'number' ? trackOffsets[t.id] : 0
              const trackOffsetSec = trackOffset * (60 / bpm)
              
              // Calculate when to start this audio relative to now
              const playheadSec = startOffsetSecBase
              const trackStartSec = trackOffsetSec
              
              if (playheadSec >= trackStartSec) {
                // Playhead is already past track start - start playing from current position in audio
                const offsetIntoAudio = playheadSec - trackStartSec
                const offset = Math.max(0, Math.min(buf.duration, offsetIntoAudio))
                const remaining = buf.duration - offset
                
                if (remaining > 0.005) {
                  const src = ctx.createBufferSource()
                  src.buffer = buf
                  // Connect directly to track gain, bypassing pre-gain for audio to avoid clipping
                  if (g) {
                    src.connect(g)
                  } else if (masterGainRef.current) {
                    src.connect(masterGainRef.current)
                  } else {
                    src.connect(ctx.destination)
                  }
                  try { src.start(ctx.currentTime, offset) } catch {}
                  audioSourcesRef.current[t.id] = src
                }
              } else {
                // Playhead hasn't reached track start yet - schedule to start in the future
                const delaySeconds = trackStartSec - playheadSec
                if (delaySeconds < 60) { // Only schedule if it's within a minute
                  const src = ctx.createBufferSource()
                  src.buffer = buf
                  // Connect directly to track gain, bypassing pre-gain for audio to avoid clipping
                  if (g) {
                    src.connect(g)
                  } else if (masterGainRef.current) {
                    src.connect(masterGainRef.current)
                  } else {
                    src.connect(ctx.destination)
                  }
                  try { src.start(ctx.currentTime + delaySeconds, 0) } catch {}
                  audioSourcesRef.current[t.id] = src
                }
              }
            }
          }
        })
      } catch (e) { console.error('Error starting audio clip playback:', e) }
      // Use 16th-note precision like PianoRoll so off-beat notes play
      const subdivisionsPerBeat = 4
      let lastSubdivision = Math.floor(startBeat * subdivisionsPerBeat) - 1
      playbackIntervalRef.current = setInterval(() => {
        const elapsed = Date.now() - startTime
        const beat = elapsed / beatDuration
        setCurrentBeat(beat)
        // High-resolution beat scheduling: run every tick so high step counts (24/32) don't skip
        try {
          tracks.forEach((t) => {
            if (t.type !== 'beat') return
            const p = trackBeats?.[t.id]
            if (!p || !Array.isArray(p.rows) || !p.steps) return
            // Get beat track start position from unified trackOffsets
            const trackStartBeat = typeof trackOffsets?.[t.id] === 'number' ? trackOffsets[t.id] : 0
            // Check if playback is within this beat track's region
            const defaultBeats = 4
            const regionBeats = typeof p.lengthBeats === 'number' ? Math.max(4, p.lengthBeats) : defaultBeats
            const regionEndBeat = trackStartBeat + regionBeats
            if (beat < trackStartBeat - 0.0001 || beat >= regionEndBeat - 0.0001) return
            // Calculate position within the region
            const beatInRegion = beat - trackStartBeat
            const S = Math.max(1, Number(p.steps) || 16)
            // Loop the pattern every bar (4 beats), do NOT stretch across region
            const beatsPerBar = 4
            const beatInBar = beatInRegion % beatsPerBar
            const phase = Math.max(0, Math.min(1, beatInBar / beatsPerBar))
            const stepIndex = Math.min(S - 1, Math.floor(phase * S))
            const last = beatLastStepRef.current[t.id]
            if (last === stepIndex) return
            beatLastStepRef.current[t.id] = stepIndex
            const rowBuffers = loadedBeatSamplesRef.current?.[t.id] || {}
            const ctx = audioContextRef.current
            const { pre, g } = ensureTrackChain(t.id)
            p.rows.forEach((row) => {
              if (row.steps?.[stepIndex]) {
                const buf = rowBuffers[row.id]
                if (buf && ctx) {
                  try {
                    const src = ctx.createBufferSource()
                    src.buffer = buf
                    if (pre) src.connect(pre)
                    else if (g) src.connect(g)
                    else if (masterGainRef.current) src.connect(masterGainRef.current)
                    else src.connect(ctx.destination)
                    src.start()
                    activeSourcesRef.current.push(src)
                    src.onended = () => {
                      try { src.disconnect() } catch {}
                      const arr = activeSourcesRef.current
                      const idx = arr.indexOf(src)
                      if (idx >= 0) arr.splice(idx, 1)
                    }
                  } catch (e) { console.error('beat playback error', e) }
                }
              }
            })
          })
        } catch {}

        const currentSubdivision = Math.floor(beat * subdivisionsPerBeat)
        if (currentSubdivision !== lastSubdivision) {
          lastSubdivision = currentSubdivision
          const currentPosition = currentSubdivision / subdivisionsPerBeat
          // Round to subdivision to avoid FP drift
          const positionRounded = Math.round(currentPosition * subdivisionsPerBeat) / subdivisionsPerBeat
          const epsilon = 0.001
          // Play notes from all tracks with their instruments, applying track offsets
          Object.entries(trackNotesRef.current).forEach(([trackId, notes]) => {
            const trackOffset = typeof trackOffsets?.[trackId] === 'number' ? trackOffsets[trackId] : 0
            notes.forEach(note => {
              // Apply track offset to note position
              const noteAbsoluteStart = (note.start || 0) + trackOffset
              const noteStartRounded = Math.round(noteAbsoluteStart * subdivisionsPerBeat) / subdivisionsPerBeat
              if (Math.abs(noteStartRounded - positionRounded) < epsilon) {
                playNote(trackId, note.note, (note.duration || 1) * beatDuration / 1000)
              }
            })
          })
        }
        if (beat >= maxEndBeat - 0.001) {
          setIsPlaying(false)
          setCurrentBeat(0)
          clearInterval(playbackIntervalRef.current)
          // Stop audio sources
          try { Object.values(audioSourcesRef.current || {}).forEach((s) => { try { s.stop() } catch {} }); audioSourcesRef.current = {} } catch {}
        }
      }, 16)
    }
  }

  useEffect(() => {
    return () => {
      if (playbackIntervalRef.current) clearInterval(playbackIntervalRef.current)
    }
  }, [])

  // Global mouse up handler for drag/resize operations
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (resizing) {
        const { trackId, currentLen, startLen } = resizing
        const raw = Number(currentLen || startLen) || 4
        const bars = Math.max(1, Math.round(raw / 4))
        const commitLen = bars * 4
        // Only suppress click if there was actual resizing (length changed)
        if (commitLen !== startLen) {
          resizeClickSuppressRef.current = true
        }
        setTrackBeats?.((prev) => {
          const p = prev?.[trackId] || { steps: 16, rows: [] }
          return { ...prev, [trackId]: { ...p, lengthBeats: commitLen } }
        })
        setResizing(null)
      }
      
      if (dragging) {
        const { trackId, currentBeat, startBeat } = dragging
        // Use currentBeat if it's a number (including 0), otherwise fall back to startBeat
        const beatToCommit = typeof currentBeat === 'number' ? currentBeat : startBeat
        const commitStart = Math.max(0, Math.round(beatToCommit * 4) / 4)
        // Only suppress click if there was actual dragging (position changed by more than threshold)
        if (Math.abs(commitStart - startBeat) > 0.01) {
          dragClickSuppressRef.current = true
        }
        // Update trackOffsets for all track types (unified approach)
        setTrackOffsets?.((prev) => {
          return { ...prev, [trackId]: commitStart }
        })
        setDragging(null)
        if (canvasRef.current) {
          canvasRef.current.style.cursor = 'default'
        }
      }
    }

    const handleGlobalMouseMove = (e) => {
      if (!canvasRef.current) return
      
      if (dragging) {
        const rect = canvasRef.current.getBoundingClientRect()
        const x = e.clientX - rect.left
        const beatAtMouse = Math.max(0, (x - SIDEBAR_WIDTH) / beatWidth)
        let newStart = Math.max(0, beatAtMouse - dragging.offsetBeats)
        newStart = Math.round(newStart * 4) / 4
        setDragging((prev) => (prev ? { ...prev, currentBeat: newStart } : prev))
      }
      
      if (resizing) {
        const rect = canvasRef.current.getBoundingClientRect()
        const x = e.clientX - rect.left
        const startLen = resizing.startLen
        const dx = x - resizing.startX
        let newLen = Math.max(1, startLen + dx / beatWidth)
        const bars = Math.max(1, Math.round(newLen / 4))
        newLen = bars * 4
        setResizing((prev) => (prev ? { ...prev, currentLen: newLen } : prev))
      }
    }

    if (resizing || dragging) {
      window.addEventListener('mouseup', handleGlobalMouseUp)
      window.addEventListener('mousemove', handleGlobalMouseMove)
      return () => {
        window.removeEventListener('mouseup', handleGlobalMouseUp)
        window.removeEventListener('mousemove', handleGlobalMouseMove)
      }
    }
  }, [resizing, dragging, beatWidth, setTrackBeats])

  // Handle canvas click - just open piano roll
  const handleCanvasClick = (e) => {
    if (resizing) return
    if (dragging) return
    if (resizeClickSuppressRef.current) {
      // Suppress the click that follows a resize drag so we don't open editors
      resizeClickSuppressRef.current = false
      return
    }
    if (dragClickSuppressRef.current) {
      // Suppress the click that follows a drag so we don't open editors
      dragClickSuppressRef.current = false
      return
    }
    const rect = canvasRef.current.getBoundingClientRect()
    const y = e.clientY - rect.top
    
    const trackIndex = Math.floor(y / TRACK_HEIGHT)
    if (trackIndex >= 0 && trackIndex < tracks.length) {
      const track = tracks[trackIndex]
      // Only open PianoRoll for MIDI/note tracks
      if (track.type !== 'audio') onSelectTrack(track.id)
    }
  }

  // Handle mouse move for hover effects
  const handleCanvasMouseMove = (e) => {
    // Skip hover detection if we're actively dragging or resizing (handled by global listener)
    if (resizing || dragging) return
    
    const rect = canvasRef.current.getBoundingClientRect()
    const y = e.clientY - rect.top
    const x = e.clientX - rect.left
    const trackIndex = Math.floor(y / TRACK_HEIGHT)

      if (trackIndex >= 0 && trackIndex < tracks.length) {
      setHoveredTrack(trackIndex)
      const track = tracks[trackIndex]
      
      // Determine region bounds for this track
      let regionX = 0, regionWidth = 0, regionY = 0, regionHeight = 0
      const trackOffset = typeof trackOffsets?.[track.id] === 'number' ? trackOffsets[track.id] : 0
      
      if (track.type === 'beat') {
        const p = trackBeats?.[track.id]
        const beats = typeof p?.lengthBeats === 'number' ? Math.max(4, p.lengthBeats) : 4
        regionX = SIDEBAR_WIDTH + trackOffset * beatWidth
        regionWidth = beats * beatWidth
        regionY = trackIndex * TRACK_HEIGHT + 12
        regionHeight = TRACK_HEIGHT - 24
      } else if (track.type === 'audio') {
        const rec = loadedAudioClipsRef.current?.[track.id]
        const durationSec = rec?.buffer?.duration || 0
        if (durationSec > 0) {
          const beats = (durationSec * bpm) / 60
          regionX = SIDEBAR_WIDTH + trackOffset * beatWidth
          regionWidth = beats * beatWidth
          regionY = trackIndex * TRACK_HEIGHT + 12
          regionHeight = TRACK_HEIGHT - 24
        }
      } else {
        // MIDI track
        const notes = trackNotes[track.id] || []
        if (notes && notes.length > 0) {
          // Find the last note end position (relative to track start)
          const ends = notes.map(n => (n.start || 0) + (n.duration || 0))
          const lastNoteEnd = Math.max(...ends)
          regionX = SIDEBAR_WIDTH + trackOffset * beatWidth
          regionWidth = lastNoteEnd * beatWidth
          regionY = trackIndex * TRACK_HEIGHT + 12
          regionHeight = TRACK_HEIGHT - 24
        }
      }
      
      // Check if hovering near resize handle (beat tracks only) or in region for dragging
      if (regionWidth > 0) {
        const inY = y >= regionY && y <= regionY + regionHeight
        const nearRight = Math.abs(x - (regionX + regionWidth)) <= 6
        const inRegion = x >= regionX && x <= regionX + regionWidth && inY
        
        if (track.type === 'beat' && inY && nearRight) {
          canvasRef.current.style.cursor = 'ew-resize'
        } else if (inRegion) {
          canvasRef.current.style.cursor = 'grab'
        } else {
          canvasRef.current.style.cursor = 'pointer'
        }
      } else {
        canvasRef.current.style.cursor = 'pointer'
      }
    } else {
      setHoveredTrack(null)
      canvasRef.current.style.cursor = 'default'
    }
  }

  // Handle mouse leave
  const handleCanvasMouseLeave = () => {
    setHoveredTrack(null)
    if (canvasRef.current) {
      canvasRef.current.style.cursor = 'default'
    }
  }

  const handleCanvasMouseDown = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const y = e.clientY - rect.top
    const x = e.clientX - rect.left
    const trackIndex = Math.floor(y / TRACK_HEIGHT)
    if (trackIndex < 0 || trackIndex >= tracks.length) return
    
    const track = tracks[trackIndex]
    const trackOffset = typeof trackOffsets?.[track.id] === 'number' ? trackOffsets[track.id] : 0
    
    // Determine region bounds for this track
    let regionX = 0, regionWidth = 0, regionY = 0, regionHeight = 0, beats = 0
    
    if (track.type === 'beat') {
      const p = trackBeats?.[track.id]
      beats = typeof p?.lengthBeats === 'number' ? Math.max(4, p.lengthBeats) : 4
      regionX = SIDEBAR_WIDTH + trackOffset * beatWidth
      regionWidth = beats * beatWidth
      regionY = trackIndex * TRACK_HEIGHT + 12
      regionHeight = TRACK_HEIGHT - 24
    } else if (track.type === 'audio') {
      const rec = loadedAudioClipsRef.current?.[track.id]
      const durationSec = rec?.buffer?.duration || 0
      if (durationSec > 0) {
        beats = (durationSec * bpm) / 60
        regionX = SIDEBAR_WIDTH + trackOffset * beatWidth
        regionWidth = beats * beatWidth
        regionY = trackIndex * TRACK_HEIGHT + 12
        regionHeight = TRACK_HEIGHT - 24
      } else {
        return // No region to interact with
      }
    } else {
      // MIDI track
      const notes = trackNotes[track.id] || []
      if (notes && notes.length > 0) {
        // Find the last note end position (relative to track start)
        const ends = notes.map(n => (n.start || 0) + (n.duration || 0))
        const lastNoteEnd = Math.max(...ends)
        beats = lastNoteEnd
        regionX = SIDEBAR_WIDTH + trackOffset * beatWidth
        regionWidth = lastNoteEnd * beatWidth
        regionY = trackIndex * TRACK_HEIGHT + 12
        regionHeight = TRACK_HEIGHT - 24
      } else {
        return // No notes to interact with
      }
    }
    
    const inY = y >= regionY && y <= regionY + regionHeight
    const nearRight = Math.abs(x - (regionX + regionWidth)) <= 6
    const inRegion = x >= regionX && x <= regionX + regionWidth && inY
    
    if (track.type === 'beat' && inY && nearRight) {
      // Start resizing (beat tracks only)
      setResizing({ trackId: track.id, startX: x, startLen: beats, currentLen: beats })
      e.preventDefault()
      e.stopPropagation()
    } else if (inRegion) {
      // Start dragging - calculate offset from region start to mouse position
      const offsetX = x - regionX
      const offsetBeats = offsetX / beatWidth
      setDragging({ 
        trackId: track.id, 
        startX: x, 
        startBeat: trackOffset, 
        currentBeat: trackOffset, 
        offsetBeats: offsetBeats 
      })
      e.preventDefault()
      e.stopPropagation()
    }
  }

  // Timeline click to seek
  const handleTimelineClick = (e) => {
    const rect = timelineCanvasRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    if (x >= SIDEBAR_WIDTH) {
      const beat = (x - SIDEBAR_WIDTH) / beatWidth
      setCurrentBeat(beat)
      if (isPlaying) {
        // Reset playback
        if (playbackIntervalRef.current) clearInterval(playbackIntervalRef.current)
        const beatDuration = 60000 / bpm
        const startTime = Date.now() - beat * beatDuration
        // Restart audio clip playback from new position
        try {
          const ctx = audioContextRef.current
          const startOffsetSecBase = beat * (60 / bpm)
          Object.values(audioSourcesRef.current || {}).forEach((s) => { try { s.stop() } catch {} })
          audioSourcesRef.current = {}
          tracks.forEach((t) => {
            if (t.type === 'audio') {
              const rec = loadedAudioClipsRef.current?.[t.id]
              const { g } = ensureTrackChain(t.id)
              if (rec && rec.buffer && ctx) {
                const buf = rec.buffer
                // Apply track offset to audio playback
                const trackOffset = typeof trackOffsets?.[t.id] === 'number' ? trackOffsets[t.id] : 0
                const trackOffsetSec = trackOffset * (60 / bpm)
                
                // Calculate when to start this audio relative to now
                const playheadSec = startOffsetSecBase
                const trackStartSec = trackOffsetSec
                
                if (playheadSec >= trackStartSec) {
                  // Playhead is already past track start - start playing from current position in audio
                  const offsetIntoAudio = playheadSec - trackStartSec
                  const offset = Math.max(0, Math.min(buf.duration, offsetIntoAudio))
                  const remaining = buf.duration - offset
                  
                  if (remaining > 0.005) {
                    const src = ctx.createBufferSource()
                    src.buffer = buf
                    // Connect directly to track gain to avoid clipping
                    if (g) src.connect(g)
                    else if (masterGainRef.current) src.connect(masterGainRef.current)
                    else src.connect(ctx.destination)
                    try { src.start(ctx.currentTime, offset) } catch {}
                    audioSourcesRef.current[t.id] = src
                  }
                } else {
                  // Playhead hasn't reached track start yet - schedule to start in the future
                  const delaySeconds = trackStartSec - playheadSec
                  if (delaySeconds < 60) {
                    const src = ctx.createBufferSource()
                    src.buffer = buf
                    // Connect directly to track gain to avoid clipping
                    if (g) src.connect(g)
                    else if (masterGainRef.current) src.connect(masterGainRef.current)
                    else src.connect(ctx.destination)
                    try { src.start(ctx.currentTime + delaySeconds, 0) } catch {}
                    audioSourcesRef.current[t.id] = src
                  }
                }
              }
            }
          })
        } catch {}
        // Use 16th-note precision like PianoRoll so off-beat notes play
  const subdivisionsPerBeat = 4
        let lastSubdivision = Math.floor(beat * subdivisionsPerBeat) - 1
  beatLastStepRef.current = {}
        // Compute when to stop (last note/clip/beat end across all tracks)
        let maxEndBeat = 0
        const tnPlay = trackNotesRef.current || {}
        Object.entries(tnPlay).forEach(([trackId, notes = []]) => {
          const trackOffset = typeof trackOffsets?.[trackId] === 'number' ? trackOffsets[trackId] : 0
          for (const n of notes) {
            const endBeat = (n.start || 0) + (n.duration || 0) + trackOffset
            if (endBeat > maxEndBeat) maxEndBeat = endBeat
          }
        })
        // Include audio clip durations
        try {
          tracks.forEach((t) => {
            const trackOffset = typeof trackOffsets?.[t.id] === 'number' ? trackOffsets[t.id] : 0
            if (t.type === 'audio') {
              const buf = loadedAudioClipsRef.current?.[t.id]?.buffer
              if (buf) {
                const beats = (buf.duration * bpm) / 60 + trackOffset
                if (beats > maxEndBeat) maxEndBeat = beats
              }
              return
            }
            if (t.type === 'beat') {
              const p = trackBeats?.[t.id]
              if (p) {
                const defaultBeats = 4
                const beats = typeof p.lengthBeats === 'number' ? Math.max(4, p.lengthBeats) : defaultBeats
                const endBeat = trackOffset + beats
                if (endBeat > maxEndBeat) maxEndBeat = endBeat
              }
            }
          })
        } catch {}
        if (maxEndBeat <= 0) maxEndBeat = gridWidth
        playbackIntervalRef.current = setInterval(() => {
            const elapsed = Date.now() - startTime
          const currentBeat = (elapsed / beatDuration)
          setCurrentBeat(currentBeat)

          // High-resolution beat scheduling: run every tick
          try {
            tracks.forEach((t) => {
              if (t.type !== 'beat') return
              const p = trackBeats?.[t.id]
              if (!p || !Array.isArray(p.rows) || !p.steps) return
                // Get beat track start position from unified trackOffsets
                const trackStartBeat = typeof trackOffsets?.[t.id] === 'number' ? trackOffsets[t.id] : 0
                // Check if playback is within this beat track's region
                const defaultBeats = 4
                const regionBeats = typeof p.lengthBeats === 'number' ? Math.max(4, p.lengthBeats) : defaultBeats
                const regionEndBeat = trackStartBeat + regionBeats
                if (currentBeat < trackStartBeat - 0.0001 || currentBeat >= regionEndBeat - 0.0001) return
                // Calculate position within the region
                const beatInRegion = currentBeat - trackStartBeat
              const S = Math.max(1, Number(p.steps) || 16)
              const beatsPerBar = 4
              const beatInBar = beatInRegion % beatsPerBar
              const phase = Math.max(0, Math.min(1, beatInBar / beatsPerBar))
              const stepIndex = Math.min(S - 1, Math.floor(phase * S))
              const last = beatLastStepRef.current[t.id]
              if (last === stepIndex) return
              beatLastStepRef.current[t.id] = stepIndex
              const rowBuffers = loadedBeatSamplesRef.current?.[t.id] || {}
              const ctx = audioContextRef.current
              const { pre, g } = ensureTrackChain(t.id)
              p.rows.forEach((row) => {
                if (row.steps?.[stepIndex]) {
                  const buf = rowBuffers[row.id]
                  if (buf && ctx) {
                    try {
                      const src = ctx.createBufferSource()
                      src.buffer = buf
                      if (pre) src.connect(pre)
                      else if (g) src.connect(g)
                      else if (masterGainRef.current) src.connect(masterGainRef.current)
                      else src.connect(ctx.destination)
                      src.start()
                      activeSourcesRef.current.push(src)
                      src.onended = () => {
                        try { src.disconnect() } catch {}
                        const arr = activeSourcesRef.current
                        const idx = arr.indexOf(src)
                        if (idx >= 0) arr.splice(idx, 1)
                      }
                    } catch (e) { console.error('beat playback error', e) }
                  }
                }
              })
            })
          } catch {}

          const currentSubdivision = Math.floor(currentBeat * subdivisionsPerBeat)
          if (currentSubdivision !== lastSubdivision) {
            lastSubdivision = currentSubdivision
            const currentPosition = currentSubdivision / subdivisionsPerBeat
            const positionRounded = Math.round(currentPosition * subdivisionsPerBeat) / subdivisionsPerBeat
            const epsilon = 0.001
            Object.entries(trackNotesRef.current).forEach(([trackId, notes]) => {
              const trackOffset = typeof trackOffsets?.[trackId] === 'number' ? trackOffsets[trackId] : 0
              notes.forEach(note => {
                // Apply track offset to note position
                const noteAbsoluteStart = (note.start || 0) + trackOffset
                const noteStartRounded = Math.round(noteAbsoluteStart * subdivisionsPerBeat) / subdivisionsPerBeat
                if (Math.abs(noteStartRounded - positionRounded) < epsilon) {
                  playNote(trackId, note.note, (note.duration || 1) * beatDuration / 1000)
                }
              })
            })
          }
          if (currentBeat >= maxEndBeat - 0.001) {
            setIsPlaying(false)
            setCurrentBeat(0)
            clearInterval(playbackIntervalRef.current)
            try { Object.values(audioSourcesRef.current || {}).forEach((s) => { try { s.stop() } catch {} }); audioSourcesRef.current = {} } catch {}
          }
        }, 16)
      }
    }
  }

  const handleExtend = () => {
    setGridWidth(gw => gw + EXTEND_AMOUNT)
  }

  const handleZoomIn = () => {
    setZoom(z => Math.min(2, z + 0.25))
  }

  const handleZoomOut = () => {
    setZoom(z => Math.max(0.5, z - 0.25))
  }

  // Rewind to start (GarageBand-style): move cursor to 0; if playing, restart from beginning
  const handleRewind = () => {
    if (isRecording) return
    if (isPlaying) {
      // Stop current playback and restart from 0
      if (playbackIntervalRef.current) clearInterval(playbackIntervalRef.current)
      setIsPlaying(false)
      setCurrentBeat(0)
      // Next tick start from beginning
      setTimeout(() => togglePlayback(0), 0)
    } else {
      setCurrentBeat(0)
    }
  }

  // Save current mix to WAV via hybrid rendering: VST backend + SF2 realtime recording
  const exportDialogOpenRef = useRef(false)

  const handleSaveWav = async () => {
    try {
      if (exportDialogOpenRef.current) return
      exportDialogOpenRef.current = true
      if (!audioContextRef.current || !masterGainRef.current) return
      if (isRecording) return
      // Do not allow saving while transport is running
      if (isPlaying) return

      // Check if any tracks are using VST mode
      const hasVSTTracks = tracks.some((t) => trackVSTMode?.[t.id])
      const hasSF2Tracks = tracks.some((t) => !trackVSTMode?.[t.id] && t.type !== 'audio' && t.type !== 'beat')
      const hasBeatTracks = tracks.some((t) => t.type === 'beat')

      if (hasVSTTracks && !hasSF2Tracks && !hasBeatTracks) {
        // Pure VST export - use backend rendering only
        setIsRecording(true)
        
        // Collect all MIDI notes from VST tracks
        const allNotes = []
        const beatDuration = 60.0 / bpm // seconds per beat
        
        Object.entries(trackNotesRef.current || {}).forEach(([trackId, notes]) => {
          const trackOffset = typeof trackOffsets?.[trackId] === 'number' ? trackOffsets[trackId] : 0
          const isVST = trackVSTMode?.[trackId]
          
          if (!isVST) return
          
          notes.forEach((note) => {
            const startBeat = (note.start || 0) + trackOffset
            const durationBeats = note.duration || 1
            const midiNote = noteNameToMidi(note.note)
            
            // Apply track volume to velocity
            const vol = Math.max(0, Math.min(150, Number(trackVolumes?.[trackId] ?? 100)))
            const baseVelocity = 0.8
            const velocity = baseVelocity * (vol / 100)
            
            allNotes.push({
              trackId: String(trackId),
              startTime: startBeat * beatDuration,
              duration: durationBeats * beatDuration,
              midiNote: midiNote,
              velocity: velocity,
              channel: 1
            })
          })
        })
        
        if (allNotes.length === 0) {
          console.warn('No VST notes to render')
          setIsRecording(false)
          exportDialogOpenRef.current = false
          return
        }
        
        allNotes.sort((a, b) => a.startTime - b.startTime)
        
        const result = await window.api.backend.renderWav(allNotes, 44100, 24)
        
        setIsRecording(false)
        
        if (result && result.ok) {
          console.log('VST WAV rendered to:', result.path)
        } else if (result && result.canceled) {
          console.log('Render canceled')
        } else {
          console.error('Failed to render VST WAV:', result?.error)
        }
        
        exportDialogOpenRef.current = false
        return
      }

      if (hasVSTTracks && (hasSF2Tracks || hasBeatTracks)) {
        // Hybrid export: render VST to temp file, then mix with SF2/beats in realtime
        setIsRecording(true)
        
        // Step 1: Collect and render VST notes to temporary file
        const vstNotes = []
        const beatDuration = 60.0 / bpm
        
        Object.entries(trackNotesRef.current || {}).forEach(([trackId, notes]) => {
          const trackOffset = typeof trackOffsets?.[trackId] === 'number' ? trackOffsets[trackId] : 0
          const isVST = trackVSTMode?.[trackId]
          
          if (!isVST) return
          
          notes.forEach((note) => {
            const startBeat = (note.start || 0) + trackOffset
            const durationBeats = note.duration || 1
            const midiNote = noteNameToMidi(note.note)
            
            // Apply track volume to velocity
            const vol = Math.max(0, Math.min(150, Number(trackVolumes?.[trackId] ?? 100)))
            const baseVelocity = 0.8
            const velocity = baseVelocity * (vol / 100)
            
            vstNotes.push({
              trackId: String(trackId),
              startTime: startBeat * beatDuration,
              duration: durationBeats * beatDuration,
              midiNote: midiNote,
              velocity: velocity,
              channel: 1
            })
          })
        })
        
        if (vstNotes.length > 0) {
          vstNotes.sort((a, b) => a.startTime - b.startTime)
          
          // Render to temp file (without showing save dialog)
          const tempResult = await window.api.backend.renderWavTemp(vstNotes, 44100, 24)
          
          if (!tempResult || !tempResult.ok) {
            setIsRecording(false)
            exportDialogOpenRef.current = false
            console.error('Failed to render VST tracks:', tempResult?.error)
            return
          }
          
          // Step 2: Load the rendered VST audio
          const vstAudioBytes = await window.api.readAudioFile(tempResult.path)
          if (!vstAudioBytes || !vstAudioBytes.ok) {
            console.error('Failed to read rendered VST file')
            setIsRecording(false)
            exportDialogOpenRef.current = false
            return
          }
          
          const vstBuffer = await audioContextRef.current.decodeAudioData(
            Uint8Array.from(vstAudioBytes.bytes).buffer
          )
          
          // Step 3: Set up mixed recording
          let maxEndBeat = 0
          const tn = trackNotesRef.current || {}
          Object.entries(tn).forEach(([trackId, notes = []]) => {
            const trackOffset = typeof trackOffsets?.[trackId] === 'number' ? trackOffsets[trackId] : 0
            for (const n of notes) {
              const endBeat = (n.start || 0) + (n.duration || 0) + trackOffset
              if (endBeat > maxEndBeat) maxEndBeat = endBeat
            }
          })
          
          if (maxEndBeat <= 0) maxEndBeat = gridWidth
          const totalSeconds = (maxEndBeat * 60) / bpm
          const TAIL_SEC = 2.0 // Extra tail for reverb
          
          // Start recording from record bus
          const recSource = recordBusRef.current || masterGainRef.current
          const rec = startRecording(audioContextRef.current, recSource, { numChannels: 2 })
          
          // Step 4: Play VST audio buffer
          const vstSource = audioContextRef.current.createBufferSource()
          vstSource.buffer = vstBuffer
          vstSource.connect(masterGainRef.current)
          vstSource.start(audioContextRef.current.currentTime)
          
          // Step 5: Start SF2 playback
          setCurrentBeat(0)
          togglePlayback(0)
          
          // Wait for completion
          await new Promise((res) => setTimeout(res, Math.ceil((totalSeconds + TAIL_SEC) * 1000)))
          
          vstSource.stop()
          vstSource.disconnect()
          
          const { sampleRate, channels } = await rec.stop()
          
          // Stop playback
          if (playbackIntervalRef.current) clearInterval(playbackIntervalRef.current)
          setIsPlaying(false)
          setCurrentBeat(0)
          
          // Save final mix
          const ch = channels && channels.length > 0 ? channels : [new Float32Array()]
          const stereo = ch.length >= 2 ? [ch[0], ch[1]] : [ch[0], ch[0]]
          const wavBytes = encodeToWav({ channels: stereo, sampleRate })
          
          const ts = new Date()
          const pad = (n) => String(n).padStart(2, '0')
          const fname = `MelodyKit_${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.wav`
          
          const result = await window.api.saveWav(Array.from(wavBytes), fname)
          
          if (result && result.ok) {
            console.log('Mixed WAV saved to:', result.path)
          } else if (result && result.canceled) {
            console.log('Save canceled')
          } else {
            console.error('Failed to save mixed WAV:', result?.error)
          }
          
          setIsRecording(false)
          exportDialogOpenRef.current = false
          return
        }
      }

      // Fall back to realtime recording for SF2/audio tracks only
      // Determine duration based on the actual end of notes/clips/beat loops across all tracks
      let maxEndBeat = 0
      const tn = trackNotesRef.current || {}
      Object.values(tn).forEach((notes = []) => {
        for (const n of notes) {
          const endBeat = (n.start || 0) + (n.duration || 0)
          if (endBeat > maxEndBeat) maxEndBeat = endBeat
        }
      })
      // Include audio clip durations
      try {
        tracks.forEach((t) => {
          if (t.type === 'audio') {
            const buf = loadedAudioClipsRef.current?.[t.id]?.buffer
            if (buf) {
              const beats = (buf.duration * bpm) / 60
              if (beats > maxEndBeat) maxEndBeat = beats
            }
            return
          }
          if (t.type === 'beat') {
            const p = trackBeats?.[t.id]
            if (p) {
              const defaultBeats = 4
              const beats = typeof p.lengthBeats === 'number' ? Math.max(4, p.lengthBeats) : defaultBeats
              const startBeat = typeof p.startBeat === 'number' ? p.startBeat : 0
              const endBeat = startBeat + beats
              if (endBeat > maxEndBeat) maxEndBeat = endBeat
            }
          }
        })
      } catch {}
      // Fallback to grid if there are no notes/clips at all
      if (maxEndBeat <= 0) maxEndBeat = gridWidth
      const totalSeconds = (maxEndBeat * 60) / bpm
      const TAIL_SEC = 0.25

      // Start recording from record bus (or master gain)
      const recSource = recordBusRef.current || masterGainRef.current
      const rec = startRecording(audioContextRef.current, recSource, { numChannels: 2 })

      // If not already playing, start playback from the beginning
      let startedPlayback = false
      if (!isPlaying) {
        setCurrentBeat(0)
        startedPlayback = true
        // Start playback
        togglePlayback(0)
      }

      // Mark recording state now that transport has started
      setIsRecording(true)

  // Record until note end plus a small tail for releases
  await new Promise((res) => setTimeout(res, Math.ceil((totalSeconds + TAIL_SEC) * 1000)))

      const { sampleRate, channels } = await rec.stop()

      // Ensure we have two channels (stereo)
  const ch = channels && channels.length > 0 ? channels : [new Float32Array()]
  const stereo = ch.length >= 2 ? [ch[0], ch[1]] : [ch[0], ch[0]]
  const wavBytes = encodeToWav({ channels: stereo, sampleRate })

      const ts = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const fname = `MelodyKit_${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.wav`

      const result = await window.api.saveWav(Array.from(wavBytes), fname)
      if (result && result.ok) {
        console.log('WAV saved to:', result.path)
      } else if (result && result.canceled) {
        console.log('Save canceled')
      } else {
        console.error('Failed to save WAV:', result && result.error)
      }

      // If we started playback solely for export, stop it after exporting
      if (startedPlayback) {
        try {
          if (playbackIntervalRef.current) clearInterval(playbackIntervalRef.current)
          setIsPlaying(false)
          setCurrentBeat(0)
        } catch {}
      }
    } catch (e) {
      console.error('Error saving WAV:', e)
    } finally {
      setIsRecording(false)
      exportDialogOpenRef.current = false
    }
  }

  // Expose export method to parent (TitleBar triggers this)
  useImperativeHandle(ref, () => ({
    exportWav: () => handleSaveWav()
  }))

  // Attach non-passive wheel listener to allow preventDefault without warnings
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const onWheel = (e) => {
      const verticalOverflow = container.scrollHeight > container.clientHeight + 1
      const horizontalOverflow = container.scrollWidth > container.clientWidth + 1
      if (!horizontalOverflow) return

      const prefersHorizontal = e.shiftKey || !verticalOverflow || Math.abs(e.deltaX) > Math.abs(e.deltaY)
      if (prefersHorizontal) {
        const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY
        container.scrollLeft += delta
        e.preventDefault()
      }
    }

    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-zinc-900">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 bg-zinc-900 border-b border-zinc-800">
        <div className="flex items-center gap-3">
          {/* Transport: Play/Pause */}
          {/* Rewind to start */}
          <button
            onClick={handleRewind}
            disabled={isRecording}
            title="Rewind to start"
            aria-label="Rewind to start"
            className="inline-flex items-center justify-center h-9 w-9 rounded-md bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-white shadow focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
              <path d="M11 7l-6 5 6 5V7zm8 0l-6 5 6 5V7z"></path>
            </svg>
          </button>

          <button
            onClick={togglePlayback}
            disabled={isRecording || isRestoring || tracks.length === 0}
            title={isRestoring ? 'Loading VST presets...' : (isPlaying ? 'Pause' : 'Play')}
            aria-label={isRestoring ? 'Loading VST presets' : (isPlaying ? 'Pause' : 'Play')}
            className="inline-flex items-center justify-center h-9 px-3 rounded-md bg-blue-500 hover:bg-blue-600 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed text-white shadow focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                <rect x="6" y="5" width="4" height="14" rx="1"></rect>
                <rect x="14" y="5" width="4" height="14" rx="1"></rect>
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7-11-7z"></path>
              </svg>
            )}
          </button>

          <h2 className="text-white font-semibold text-base select-none">Arrangement</h2>
        </div>

        <div className="flex-1" />

        {/* Save WAV */}
        <button
          onClick={handleSaveWav}
          disabled={isRecording || isPlaying}
          className="inline-flex items-center justify-center h-9 px-3 bg-blue-500 hover:bg-blue-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-white rounded-md transition-colors ring-1 ring-inset ring-emerald-400/40 text-sm"
          title="Record and save mix to WAV"
        >
          {isRecording ? 'Saving…' : 'Export'}
        </button>

        {/* Add Track button removed (present in Sidebar) */}

        {/* BPM */}
        <div className="flex items-center gap-2 ml-1">
          <label className="text-zinc-400 text-xs">BPM</label>
          <input
            type="number"
            value={bpmInput}
            onChange={(e) => {
              setBpmInput(e.target.value)
              const num = parseInt(e.target.value)
              if (!isNaN(num) && num >= 40 && num <= 300) {
                setBpm(num)
              }
            }}
            onBlur={() => {
              const num = parseInt(bpmInput)
              if (isNaN(num) || num < 40 || num > 300) {
                setBpm(120)
                setBpmInput('120')
              }
            }}
            className="h-9 w-16 px-2 bg-zinc-800 text-white rounded-md border border-zinc-700 focus:border-blue-500 focus:outline-none text-sm"
          />
        </div>

        {/* Zoom */}
        <div className="ml-1 flex items-center gap-1 px-1.5 py-1 bg-zinc-800 rounded-md ring-1 ring-inset ring-zinc-700">
          <button
            onClick={handleZoomOut}
            disabled={zoom <= 0.5}
            className="inline-flex items-center justify-center w-7 h-7 bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-900 disabled:text-zinc-600 disabled:cursor-not-allowed text-white rounded-md transition-colors text-sm font-semibold"
            title="Zoom Out"
          >
            −
          </button>
          <span className="text-zinc-400 text-xs w-12 text-center">{Math.round(zoom * 100)}%</span>
          <button
            onClick={handleZoomIn}
            disabled={zoom >= 2}
            className="inline-flex items-center justify-center w-7 h-7 bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-900 disabled:text-zinc-600 disabled:cursor-not-allowed text-white rounded-md transition-colors text-sm font-semibold"
            title="Zoom In"
          >
            +
          </button>
        </div>

        {/* Extend bars */}
        <button
          onClick={handleExtend}
          className="inline-flex items-center justify-center h-9 px-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-md transition-colors ring-1 ring-inset ring-zinc-700 text-sm"
          title={`Extend ${EXTEND_AMOUNT} bars`}
        >
          + {EXTEND_AMOUNT} bars
        </button>

        {/* Track count */}
        <div className="ml-1 text-zinc-400 text-xs select-none">
          {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}
        </div>
      </div>

      {/* Timeline and Track Rows */}
      <div
        ref={scrollContainerRef}
        className="flex-1 min-w-0 min-h-0 overflow-auto bg-zinc-900 relative"
      >
        {tracks.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-500">
            <div className="text-center">
              <div className="text-6xl mb-4">🎵</div>
              <div className="text-xl mb-2">No tracks yet</div>
              <div className="text-sm">Click "Add Track" to get started</div>
            </div>
          </div>
        ) : (
          <>
            <div style={{ position: 'sticky', top: 0, zIndex: 10 }}>
              <canvas
                ref={timelineCanvasRef}
                style={{
                  display: 'block',
                  width: gridWidth * beatWidth + SIDEBAR_WIDTH,
                  height: TIMELINE_HEIGHT,
                  background: 'transparent',
                  cursor: 'pointer',
                  borderBottom: '1px solid #3f3f46'
                }}
                onClick={handleTimelineClick}
              />
            </div>
            <div style={{ width: gridWidth * beatWidth + SIDEBAR_WIDTH, minHeight: CANVAS_HEIGHT }}>
              <canvas
                ref={canvasRef}
                style={{
                  display: 'block',
                  width: gridWidth * beatWidth + SIDEBAR_WIDTH,
                  height: CANVAS_HEIGHT,
                  background: 'transparent',
                  cursor: 'pointer'
                }}
                onClick={handleCanvasClick}
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseLeave={handleCanvasMouseLeave}
              />
              {/* Overlay per-track volume sliders within sidebar area */}
              <div
                style={{ position: 'absolute', left: 0, top: TIMELINE_HEIGHT, width: SIDEBAR_WIDTH, pointerEvents: 'none' }}
              >
                {tracks.map((track, index) => {
                  const y = index * TRACK_HEIGHT
                  const padding = 12
                  const sliderTop = y + 44 // below name + notes
                  const sliderWidth = SIDEBAR_WIDTH - padding * 2
                  const value = (trackVolumes?.[track.id] ?? 100)
                  return (
                    <div
                      key={track.id}
                      style={{ position: 'absolute', left: padding + 4, top: sliderTop, width: sliderWidth - 8 }}
                      className="flex items-center gap-2"
                    >
                      <input
                        type="range"
                        min={0}
                        max={150}
                        step={1}
                        value={value}
                        aria-label={`Volume for ${track.name}`}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          setTrackVolumes?.((prev) => ({ ...prev, [track.id]: v }))
                          const g = perTrackGainsRef.current?.[track.id]
                          const pre = perTrackPreGainsRef.current?.[track.id]
                          if (g) {
                            const scalar = Math.max(0, Math.min(150, v)) / 100
                            try { g.gain.setValueAtTime(scalar, audioContextRef.current.currentTime) } catch { g.gain.value = scalar }
                          }
                          if (pre) {
                            const scalar = Math.max(0, Math.min(150, v)) / 100
                            const preTarget = 1.8 * scalar
                            try { pre.gain.setValueAtTime(preTarget, audioContextRef.current.currentTime) } catch { pre.gain.value = preTarget }
                          }
                        }}
                        className="appearance-none w-full h-1 bg-zinc-700 rounded outline-none focus:ring-2 focus:ring-blue-500"
                        style={{ pointerEvents: 'auto' }}
                      />
                      <span className="text-xs text-zinc-300 select-none" style={{ pointerEvents: 'auto', width: 34, textAlign: 'right' }}>{value}%</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
})

export default TrackTimeline
