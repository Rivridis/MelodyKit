import { useRef, useEffect, useState } from 'react'
import { Midi } from '@tonejs/midi'
import InstrumentSelector from './InstrumentSelector'
import VSTSelector from './VSTSelector'
import { getSharedAudioContext } from '@renderer/utils/audioContext'
import { playBackendNote, noteNameToMidi, backendPanic, openVSTEditor, loadSF2, setSF2Preset } from '@renderer/utils/vstBackend'

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const OCTAVES = [2, 3, 4, 5, 6, 7]
const INITIAL_GRID_WIDTH = 32
const EXTEND_AMOUNT = 16
const BEAT_WIDTH = 40 // px
const NOTE_HEIGHT = 20 // px
const RESIZE_HANDLE_WIDTH = 10 // px, hit area for resize detection
const RESIZE_HANDLE_LINE = 1 // px, slimmer visual line to avoid crossing note edge
const RESIZE_HANDLE_COLOR = 'rgba(255, 245, 157, 0.95)' // soft white/yellow tint
const TIMELINE_HEIGHT = 24 // px
const CANVAS_HEIGHT = NOTES.length * OCTAVES.length * NOTE_HEIGHT

// Utility: convert #RRGGBB to rgba(r,g,b,a)
function hexToRgba(hex, alpha = 1) {
  if (!hex) return `rgba(0,0,0,${alpha})`
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex)
  if (!m) return `rgba(0,0,0,${alpha})`
  const r = parseInt(m[1], 16)
  const g = parseInt(m[2], 16)
  const b = parseInt(m[3], 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Utility: return a slightly darker hex color
function darkenHex(hex, amount = 0.2) {
  if (!hex) return '#000000'
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex)
  if (!m) return '#000000'
  const r = Math.max(0, Math.floor(parseInt(m[1], 16) * (1 - amount)))
  const g = Math.max(0, Math.floor(parseInt(m[2], 16) * (1 - amount)))
  const b = Math.max(0, Math.floor(parseInt(m[3], 16) * (1 - amount)))
  const toHex = (v) => v.toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function getPianoNotes() {
  const pianoNotes = []
  for (let i = OCTAVES.length - 1; i >= 0; i--) {
    for (let j = NOTES.length - 1; j >= 0; j--) {
      pianoNotes.push(`${NOTES[j]}${OCTAVES[i]}`)
    }
  }
  return pianoNotes
}
const pianoNotes = getPianoNotes()
// Fast lookup for note index to avoid repeated indexOf in hot paths
const noteIndexMap = pianoNotes.reduce((acc, n, i) => { acc[n] = i; return acc }, {})

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

function PianoRoll({ trackId, trackName, trackColor, notes, onNotesChange, onBack, gridWidth, setGridWidth, bpm, setBpm, selectedInstrument, onInstrumentChange, useVSTBackend = false, onVSTModeChange }) {
  const [isPlaying, setIsPlaying] = useState(false)
  // Keep an imperative ref in sync to avoid stale-closure in rAF playhead draws
  const isPlayingRef = useRef(false)
  const [mode, setMode] = useState('edit') // 'edit' | 'play'
  const modeRef = useRef('edit') // Keep mode ref in sync for event handlers
  const pausedForEditRef = useRef(false) // track pause caused by drag/resize
  // When switching to Play via Space, defer starting playback until mode has applied
  const autoStartOnPlayRef = useRef(false)
  const [currentBeat, setCurrentBeat] = useState(0)
  const currentBeatRef = useRef(0)
  const lastBeatStateUpdateRef = useRef(0)
  const [dragging, setDragging] = useState(null)
  const [resizing, setResizing] = useState(null)
  // Live drag/resize preview without mutating React state on every mousemove
  const dragPreviewRef = useRef(null)
  const overlayRafRef = useRef(null)
  const resizingLiveRef = useRef(null)
  const [hoveredKey, setHoveredKey] = useState(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedNoteIds, setSelectedNoteIds] = useState([]) // multi-select support
  const [hiddenNoteIds, setHiddenNoteIds] = useState([]) // hide originals during drag/resize to avoid ghosts
  const [marquee, setMarquee] = useState(null) // state used only for start/end lifecycle; live updates go via ref
  const marqueeRef = useRef(null) // live marquee rect without triggering React renders
  const marqueeRafRef = useRef(null) // rAF throttling for marquee drawing
  const lastOverlayRectsRef = useRef([]) // track last drawn overlay rects for minimal clears
  const dragLayerRef = useRef(null)
  const dragDomCacheRef = useRef(new Map()) // id -> HTMLElement for preview notes
  const [bpmInput, setBpmInput] = useState(bpm.toString())
  const [gridDivision, setGridDivision] = useState(4) // 4 = quarter notes, 8 = eighth notes, 16 = sixteenth notes
  const [lastNoteDuration, setLastNoteDuration] = useState(null) // Remember last placed/resized note duration
  const [showInstrumentSelector, setShowInstrumentSelector] = useState(false)
  const [showVSTSelector, setShowVSTSelector] = useState(false)
  const [spessaInstrument, setSpessaInstrument] = useState(null) // Store loaded spessasynth instrument
  const [instrumentLoading, setInstrumentLoading] = useState(false) // Track loading state
  const [keyLabels, setKeyLabels] = useState({}) // midi -> label (e.g., Snare, Hi-Hat)
  const [isDrumLike, setIsDrumLike] = useState(false)
  // Guard async instrument loads to avoid race conditions when switching quickly
  const loadSessionRef = useRef(0)
  // Keep instrument synth in a ref so closures (like scheduleNoteAt) always see the latest
  const spessaInstrumentRef = useRef(null)
  // Keep VST backend mode in ref for immediate access without waiting for prop updates
  const useVSTBackendRef = useRef(useVSTBackend)
  const canvasRef = useRef(null)
  const timelineCanvasRef = useRef(null)
  const playheadCanvasRef = useRef(null)
  const timelinePlayheadCanvasRef = useRef(null)
  const keysCanvasRef = useRef(null)
  const keysOverlayRef = useRef(null)
  const scrollContainerRef = useRef(null)
  // Offscreen drawing worker for main canvas
  const workerRef = useRef(null)
  const useOffscreenRef = useRef(false)
  // Guard to avoid touching 2D context before attempting Offscreen transfer
  const offscreenDesiredRef = useRef(true)
  const offscreenReadyRef = useRef(false)
  const audioContextRef = useRef(null)
  const previewGainRef = useRef(null)
  const previewLimiterRef = useRef(null)
  const playbackIntervalRef = useRef(null)
  const playbackAnimationRef = useRef(null)
  const playbackStartTimeRef = useRef(null)
  const playbackStartBeatRef = useRef(0)
  const playbackMaxEndBeatRef = useRef(null)
  const lastPlayedBeatsRef = useRef(new Set())
  const noteScheduleMapRef = useRef(new Map()) // subdivisionIndex -> notes array
  const notesRef = useRef(notes)
  const playableRangeRef = useRef({ min: 0, max: 127 })
  // Track current playback session to ignore stale scheduled notes
  const playbackSessionRef = useRef(0)
  const [playableRangeState, setPlayableRangeState] = useState({ min: 0, max: 127 })
  // History stack for Undo
  const historyRef = useRef([])
  const [canUndo, setCanUndo] = useState(false)
  const MAX_HISTORY = 100
  // Playback scheduler worker and scheduled timeouts
  const playbackWorkerRef = useRef(null)
  const scheduledTimeoutsRef = useRef(new Set())
  const schedulerReadyRef = useRef(false)
  const lookaheadSecRef = useRef(0.5)
  const schedulerTickSecRef = useRef(0.02)

  // Helper: safely deep-clone notes array (favor structuredClone when available)
  const cloneNotes = (arr) => {
    try { return typeof structuredClone === 'function' ? structuredClone(arr) : JSON.parse(JSON.stringify(arr)) } catch { return (arr || []).map(n => ({ ...n })) }
  }
  const pushHistory = () => {
    const snapshot = cloneNotes(notesRef.current || [])
    historyRef.current.push(snapshot)
    if (historyRef.current.length > MAX_HISTORY) historyRef.current.shift()
    if (!canUndo) setCanUndo(true)
  }
  const commitNotesChange = (next) => {
    pushHistory()
    onNotesChange(next)
  }
  const handleUndo = () => {
    const stack = historyRef.current
    if (!stack || stack.length === 0) return
    const previous = stack.pop()
    onNotesChange(previous)
    if (stack.length === 0) setCanUndo(false)
  }

  // Helper to ensure the preview chain is set up and connected to the audio destination
  const ensurePreviewChainConnected = () => {
    try {
      const ctx = audioContextRef.current
      if (!ctx) return false
      // If chain already exists and is connected to the right context, verify connection
      if (previewGainRef.current && previewLimiterRef.current) {
        // Verify the limiter is still connected to destination
        try { previewLimiterRef.current.connect(ctx.destination) } catch {}
        return true
      }
      // Build a small preview chain: pre-boost -> soft limiter -> speakers
      const gain = ctx.createGain()
      gain.gain.value = 2.2 // boost SF2 preview without affecting oscillator
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -1
      limiter.ratio.value = 20
      limiter.attack.value = 0.003
      limiter.release.value = 0.25
      limiter.knee.value = 1
      gain.connect(limiter)
      limiter.connect(ctx.destination)
      previewGainRef.current = gain
      previewLimiterRef.current = limiter
      return true
    } catch (e) {
      console.error('[PianoRoll] Failed to ensure preview chain:', e)
      return false
    }
  }

  useEffect(() => {
    // Use shared AudioContext across views
    audioContextRef.current = getSharedAudioContext()
    ensurePreviewChainConnected()
    
    return () => {
      // Do not close the shared context; just stop any ringing voices
      if (spessaInstrumentRef.current) {
        try { spessaInstrumentRef.current.stop() } catch {}
      }
      try { previewGainRef.current?.disconnect() } catch {}
      try { previewLimiterRef.current?.disconnect() } catch {}
      previewGainRef.current = null
      previewLimiterRef.current = null
    }
  }, [])

  useEffect(() => { notesRef.current = notes }, [notes])

  // Sync instrument state to ref so closures always see latest
  useEffect(() => { spessaInstrumentRef.current = spessaInstrument }, [spessaInstrument])

  // Sync VST backend mode to ref for immediate access
  useEffect(() => { useVSTBackendRef.current = useVSTBackend }, [useVSTBackend])

  // Mirror playing state to ref for paint functions outside React's render timing
  useEffect(() => { isPlayingRef.current = isPlaying }, [isPlaying])
  useEffect(() => { modeRef.current = mode }, [mode])

  // Enforce mode invariants: stop playback in edit mode, clear edit interactions when switching to play
  useEffect(() => {
    if (mode === 'edit') {
      // Stop playback immediately if switching to edit mode
      if (isPlaying) {
        togglePlayback()
      }
    } else if (mode === 'play') {
      // If requested by transport toggle, start playback as soon as Play mode is active
      if (autoStartOnPlayRef.current && !isPlayingRef.current) {
        try { togglePlayback() } catch {}
        autoStartOnPlayRef.current = false
      }
      // Exit selection/edit states and clear any transient overlays
      if (selectionMode) setSelectionMode(false)
      if (selectedNoteIds.length) setSelectedNoteIds([])
      if (dragging) setDragging(null)
      if (resizing) setResizing(null)
      if (hiddenNoteIds.length) setHiddenNoteIds([])
      // Close instrument selector if open in Play mode
      setShowInstrumentSelector(false)
      dragPreviewRef.current = null
      resizingLiveRef.current = null
      clearDragDom()
      // Ensure marquee cleared
      if (marqueeRef.current || marquee) {
        marqueeRef.current = null
        setMarquee(null)
      }
      // Refresh playhead overlays without edit artifacts
      drawPlayhead(currentBeat, playheadCanvasRef, CANVAS_HEIGHT)
      drawPlayhead(currentBeat, timelinePlayheadCanvasRef, TIMELINE_HEIGHT)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // Global keyboard shortcuts: Ctrl/Cmd+Z → Undo
  useEffect(() => {
    const onKeyDown = (e) => {
      const isUndo = (e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')
      if (isUndo) {
        e.preventDefault()
        handleUndo()
        return
      }
      // Transport: Space toggles Edit⇄Play with playback
      const isSpace = (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar')
      if (isSpace && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Don't hijack when typing in inputs/textareas/contenteditable
        const target = e.target
        const tag = target?.tagName
        const isTextBox = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable || (target?.getAttribute && target.getAttribute('role') === 'textbox')
        if (isTextBox) return
        e.preventDefault()
        if (isPlayingRef.current) {
          // Pause (stay in current mode)
          try { togglePlayback() } catch {}
        } else if (modeRef.current === 'play') {
          // In play mode but paused → resume playback
          try { togglePlayback() } catch {}
        } else {
          // In edit mode → switch to play mode and start playing
          autoStartOnPlayRef.current = true
          setMode('play')
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Canvas text helper: truncate from start to fit width (ellipsis at end)
  const truncateToWidth = (ctx, text, maxWidth) => {
    if (!text) return ''
    const full = String(text)
    if (ctx.measureText(full).width <= maxWidth) return full
    const ell = '…'
    // Binary search the longest prefix that fits when suffixed with ellipsis
    let lo = 0, hi = full.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      const candidate = full.slice(0, mid) + ell
      if (ctx.measureText(candidate).width <= maxWidth) lo = mid
      else hi = mid - 1
    }
    const prefix = full.slice(0, lo)
    return prefix + ell
  }
  useEffect(() => {
    const loadSharedSampler = async () => {
      const sessionId = ++loadSessionRef.current
      if (!selectedInstrument) {
        // Clear current instrument only if still the latest session
        if (loadSessionRef.current === sessionId) setSpessaInstrument(null)
        return
      }
      
      if (loadSessionRef.current === sessionId) setInstrumentLoading(true)
      try {
        if (selectedInstrument.samplePath && selectedInstrument.samplePath.endsWith('.sf2')) {
          // Use C++ backend to load SF2
          const bank = selectedInstrument.bank || 0
          const preset = selectedInstrument.preset || 0
          const success = await loadSF2(trackId, selectedInstrument.samplePath, bank, preset)
          
          if (!success) {
            console.error('Failed to load SF2 via backend')
            if (loadSessionRef.current === sessionId) {
              setInstrumentLoading(false)
              setSpessaInstrument(null)
            }
            return
          }
          
          // Mark as loaded
          if (loadSessionRef.current === sessionId) {
            setSpessaInstrument({ backend: true }) // Flag that backend is handling this
            
            // Set playable range (SF2 typically supports full MIDI range)
            playableRangeRef.current = { min: 0, max: 127 }
            setPlayableRangeState({ min: 0, max: 127 })
            
            // Check if it's a drumkit for labels
            const p = String(selectedInstrument.samplePath || '')
            const normalized = p.toLowerCase().replace(/\s+/g, '')
            const shouldLoadLabels = normalized.includes('drumkit')
            
            if (shouldLoadLabels) {
              // For drum kits, set isDrumLike
              setIsDrumLike(true)
              // You could add label loading here if needed
              setKeyLabels({})
            } else {
              setKeyLabels({})
              setIsDrumLike(false)
            }
            
            setInstrumentLoading(false)
            setShowInstrumentSelector(false)
          }
        } else {
          if (loadSessionRef.current === sessionId) {
            setSpessaInstrument(null)
            setInstrumentLoading(false)
            playableRangeRef.current = { min: 0, max: 127 }
            setPlayableRangeState({ min: 0, max: 127 })
            setKeyLabels({})
            setIsDrumLike(false)
          }
        }
      } catch (err) {
        console.error('Failed to load SF2 via backend:', err)
        if (loadSessionRef.current === sessionId) {
          setInstrumentLoading(false)
          setSpessaInstrument(null)
          playableRangeRef.current = { min: 0, max: 127 }
          setPlayableRangeState({ min: 0, max: 127 })
          setKeyLabels({})
          setIsDrumLike(false)
        }
      }
    }
    loadSharedSampler()
  }, [selectedInstrument, trackId])
  // Helper: convert note name like C4 to MIDI number
  const noteNameToMidi = (noteName) => {
    const map = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 }
    const m = /^([A-Ga-g])(#|b)?(\d+)$/.exec(String(noteName))
    if (!m) return 60
    const letter = m[1].toUpperCase()
    const accidental = m[2] || ''
    const octave = parseInt(m[3], 10)
    const semitone = map[letter + accidental]
    return Math.max(0, Math.min(127, (octave + 1) * 12 + semitone))
  }


  // Sync bpmInput when bpm prop changes (e.g., from TrackTimeline)
  useEffect(() => {
    setBpmInput(bpm.toString())
    // If tempo changes mid-playback, inform scheduler for future windows
    if (isPlaying && playbackWorkerRef.current) {
      try { playbackWorkerRef.current.postMessage({ type: 'updateBpm', bpm }) } catch {}
    }
  }, [bpm])

  // Draw playhead on separate canvas for smooth animation
  const drawPlayhead = (beat, canvasRef, height) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    
    // Clear the entire playhead canvas (reset transform first)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    
  // Draw playhead
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  // Use ref to avoid stale state captured by rAF callbacks
  ctx.fillStyle = isPlayingRef.current ? '#ef4444' : '#666'
    ctx.fillRect(80 + beat * BEAT_WIDTH - 1, 0, 3, height)

    // Draw selection marquee if active on main canvas overlay only
    const m = marqueeRef.current
    if (canvasRef === playheadCanvasRef && m) {
      const x1 = Math.min(m.startX, m.x)
      const y1 = Math.min(m.startY, m.y)
      const x2 = Math.max(m.startX, m.x)
      const y2 = Math.max(m.startY, m.y)
      ctx.fillStyle = 'rgba(59,130,246,0.15)'
      ctx.strokeStyle = '#60a5fa'
      ctx.lineWidth = 1
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1)
      ctx.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, y2 - y1 - 1)
    }
  }

  // Minimal overlay redraw for interaction previews (no playhead for perf)
  // Drag preview moved to DOM drag layer for GPU-accelerated transforms
  const ensureDragLayer = () => dragLayerRef.current
  const stylePreviewElement = (el) => {
    el.style.position = 'absolute'
    el.style.left = '0px'
    el.style.top = '0px'
    el.style.borderRadius = '6px'
    el.style.boxSizing = 'border-box'
    el.style.pointerEvents = 'none'
    el.style.backgroundColor = hexToRgba(trackColor, 0.9)
    el.style.border = '2px solid ' + trackColor
    el.style.willChange = 'transform, width, height'
    el.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.25)'
  }
  const upsertPreviewEl = (key) => {
    const layer = ensureDragLayer()
    if (!layer) return null
    let el = dragDomCacheRef.current.get(key)
    if (!el) {
      el = document.createElement('div')
      stylePreviewElement(el)
      const handle = document.createElement('div')
      handle.style.position = 'absolute'
  handle.style.right = '1px'
  handle.style.top = '4px'
      handle.style.width = RESIZE_HANDLE_LINE + 'px'
  handle.style.height = 'calc(100% - 8px)'
  // Minimal, GarageBand-style thin line with white/yellow tint
  handle.style.background = RESIZE_HANDLE_COLOR
      handle.style.border = 'none'
      handle.style.borderRadius = '0'
      handle.style.boxShadow = 'none'
      el.appendChild(handle)
      layer.appendChild(el)
      dragDomCacheRef.current.set(key, el)
    }
    return el
  }
  const clearDragDom = () => {
    for (const [, el] of dragDomCacheRef.current) {
      el.remove()
    }
    dragDomCacheRef.current.clear()
  }
  const updateDragDomFromPreview = (preview) => {
    const layer = ensureDragLayer()
    if (!layer) return
    // Mark all existing as unused initially
    const used = new Set()
    const place = (key, start, duration, noteIdx) => {
      const x = 80 + start * BEAT_WIDTH
      const y = noteIdx * NOTE_HEIGHT
      const w = Math.max(1, duration * BEAT_WIDTH)
      const h = NOTE_HEIGHT
      const el = upsertPreviewEl(key)
      if (!el) return
      used.add(key)
      el.style.transform = `translate3d(${x}px, ${y + 2}px, 0)`
      el.style.width = `${w}px`
      el.style.height = `${h - 4}px`
    }
    if (preview) {
      if (preview.type === 'single') {
        const idx = noteIndexMap[preview.note]
        if (idx !== -1 && idx !== undefined) place(`single:${preview.id}`, preview.start, preview.duration, idx)
      } else if (preview.type === 'resize') {
        const base = notesRef.current.find(n => n.id === preview.id)
        if (base) {
          const idx = noteIndexMap[base.note]
          if (idx !== -1 && idx !== undefined) place(`resize:${preview.id}`, base.start, preview.duration, idx)
        }
      } else if (preview.type === 'group' && Array.isArray(preview.items)) {
        for (let i = 0; i < preview.items.length; i++) {
          const it = preview.items[i]
          place(`group:${it.id}`, it.start, it.duration, it.noteIdx)
        }
      }
    }
    // Remove any elements that were not used this frame
    for (const [key, el] of [...dragDomCacheRef.current.entries()]) {
      if (!used.has(key)) {
        el.remove()
        dragDomCacheRef.current.delete(key)
      }
    }
  }

  // Update playhead position smoothly
  useEffect(() => {
    // During drag/resize, overlay redraws are driven by the interaction rAF to avoid double clears
    if (dragging || resizing) return
    drawPlayhead(currentBeat, playheadCanvasRef, CANVAS_HEIGHT)
    drawPlayhead(currentBeat, timelinePlayheadCanvasRef, TIMELINE_HEIGHT)
  }, [currentBeat, isPlaying, dragging, resizing])

  // Draw timeline
  useEffect(() => {
    const canvas = timelineCanvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const CANVAS_WIDTH = gridWidth * BEAT_WIDTH + 80
    canvas.width = CANVAS_WIDTH * dpr
    canvas.height = TIMELINE_HEIGHT * dpr
    canvas.style.width = CANVAS_WIDTH + 'px'
    canvas.style.height = TIMELINE_HEIGHT + 'px'
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    
    // Background
    ctx.fillStyle = '#1f2937'
    ctx.fillRect(0, 0, CANVAS_WIDTH, TIMELINE_HEIGHT)
    
    // Piano key label area
    ctx.fillStyle = '#27272a'
    ctx.fillRect(0, 0, 80, TIMELINE_HEIGHT)
    ctx.strokeStyle = '#444'
    ctx.lineWidth = 1
    ctx.strokeRect(0, 0, 80, TIMELINE_HEIGHT)
    
    // Beat markers
    for (let i = 0; i <= gridWidth; i++) {
      const x = 80 + i * BEAT_WIDTH
      ctx.strokeStyle = i % 4 === 0 ? '#666' : '#444'
      ctx.lineWidth = i % 4 === 0 ? 2 : 1
      ctx.beginPath()
      ctx.moveTo(x, i % 4 === 0 ? TIMELINE_HEIGHT - 8 : TIMELINE_HEIGHT - 4)
      ctx.lineTo(x, TIMELINE_HEIGHT)
      ctx.stroke()
      
      // Bar numbers on main beats (every 4 beats = 1 bar)
      if (i % 4 === 0) {
        ctx.fillStyle = '#999'
        ctx.font = '11px Inter, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillText((i / 4 + 1).toString(), x, 2)
      }
    }
    
    // Draw subdivision lines
    const subdivisionsPerBeat = gridDivision / 4  // e.g., 4→1, 8→2, 16→4
    for (let i = 0; i < gridWidth; i++) {
      for (let j = 1; j < subdivisionsPerBeat; j++) {
        const x = 80 + i * BEAT_WIDTH + (j * BEAT_WIDTH / subdivisionsPerBeat)
        // For 1/8th grid (subdivisionsPerBeat=2), darken the center line (j=1)
        const isCenterLine = subdivisionsPerBeat === 2 && j === 1
        ctx.strokeStyle = isCenterLine ? '#5a606f' : '#5a606f'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x, TIMELINE_HEIGHT - 3)
        ctx.lineTo(x, TIMELINE_HEIGHT)
        ctx.stroke()
      }
    }
    
    // Setup playhead canvas
    const playheadCanvas = timelinePlayheadCanvasRef.current
    if (playheadCanvas) {
      playheadCanvas.width = CANVAS_WIDTH * dpr
      playheadCanvas.height = TIMELINE_HEIGHT * dpr
      playheadCanvas.style.width = CANVAS_WIDTH + 'px'
      playheadCanvas.style.height = TIMELINE_HEIGHT + 'px'
    }
  }, [gridWidth, gridDivision])

  // Helper: draw main canvas for currently visible horizontal region only
  // If OffscreenCanvas is available, this posts a draw request to the worker; otherwise draws on main thread.
  const drawMainCanvas = () => {
    // If we plan to use Offscreen but it's not ready yet, avoid creating a 2D context
    if (offscreenDesiredRef.current && !offscreenReadyRef.current && !useOffscreenRef.current) {
      return
    }
    if (useOffscreenRef.current && workerRef.current && scrollContainerRef.current) {
      const sc = scrollContainerRef.current
      workerRef.current.postMessage({
        type: 'draw',
        scrollLeft: sc.scrollLeft || 0,
        clientWidth: sc.clientWidth || (gridWidth * BEAT_WIDTH + 80)
      })
      return
    }
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const sc = scrollContainerRef.current
    const vLeft = sc ? sc.scrollLeft : 0
    const vWidth = sc ? sc.clientWidth : (gridWidth * BEAT_WIDTH + 80)
    const vx1 = Math.max(0, vLeft)
    const vx2 = Math.min(gridWidth * BEAT_WIDTH + 80, vLeft + vWidth)
    const vw = Math.max(0, vx2 - vx1)
    if (vw <= 0) return

    // Clear only visible region
    ctx.clearRect(vx1, 0, vw, CANVAS_HEIGHT)

    // Determine visible beats range (+ small margin)
    const startBeat = Math.max(0, (vx1 - 80) / BEAT_WIDTH) - 1
    const endBeat = Math.min(gridWidth, (vx2 - 80) / BEAT_WIDTH) + 1
    const startI = Math.max(0, Math.floor(startBeat))
    const endI = Math.min(gridWidth, Math.ceil(endBeat))

    // Row backgrounds
    const bgX = Math.max(80, vx1)
    const bgW = Math.max(0, vx2 - bgX)
    for (let i = 0; i < pianoNotes.length; i++) {
      const isBlack = pianoNotes[i].includes('#')
      ctx.fillStyle = isBlack ? '#23272e' : '#2d2f36'
      if (bgW > 0) ctx.fillRect(bgX, i * NOTE_HEIGHT, bgW, NOTE_HEIGHT)
    }

    // Vertical grid lines (beats)
    for (let i = startI; i <= endI; i++) {
      const x = 80 + i * BEAT_WIDTH
      if (x < vx1 - 1 || x > vx2 + 1) continue
      ctx.strokeStyle = i % 4 === 0 ? '#5a606f' : '#5a606f'
      ctx.lineWidth = i % 4 === 0 ? 2 : 1
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, CANVAS_HEIGHT)
      ctx.stroke()
    }

    // Subdivision lines
    const subdivisionsPerBeat = gridDivision / 4
    for (let i = startI; i < endI; i++) {
      const baseX = 80 + i * BEAT_WIDTH
      for (let j = 1; j < subdivisionsPerBeat; j++) {
        const x = baseX + (j * BEAT_WIDTH / subdivisionsPerBeat)
        if (x < vx1 - 1 || x > vx2 + 1) continue
        const isCenterLine = subdivisionsPerBeat === 2 && j === 1
        ctx.strokeStyle = isCenterLine ? '#5a606f' : '#5a606f'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, CANVAS_HEIGHT)
        ctx.stroke()
      }
    }

    // Notes within visible horizontal range
    const hiddenSet = new Set(hiddenNoteIds)
    const selSet = new Set(selectedNoteIds)
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]
      if (hiddenSet.has(n.id)) continue
      const idx = noteIndexMap[n.note]
      if (idx === -1 || idx === undefined) continue
      const noteStartX = 80 + n.start * BEAT_WIDTH
      const noteEndX = noteStartX + n.duration * BEAT_WIDTH
      if (noteEndX < vx1 || noteStartX > vx2) continue // horizontal cull
      const y = idx * NOTE_HEIGHT
      const isSelected = selSet.has(n.id)
      const colorWithOpacity = isSelected ? trackColor + 'FF' : trackColor + 'E8'
      ctx.fillStyle = colorWithOpacity
      ctx.strokeStyle = isSelected ? '#ffffff' : trackColor
      ctx.lineWidth = isSelected ? 3 : 2
      ctx.beginPath()
      ctx.roundRect(noteStartX, y + 2, Math.max(1, n.duration * BEAT_WIDTH), NOTE_HEIGHT - 4, 6)
      ctx.fill()
      ctx.stroke()
      // Thin resize line
      const lineX = noteEndX - RESIZE_HANDLE_LINE - 1
      const lineY = y + 6
      ctx.fillStyle = RESIZE_HANDLE_COLOR
      ctx.fillRect(lineX, lineY, RESIZE_HANDLE_LINE, NOTE_HEIGHT - 12)
    }
  }

  // Initialize Offscreen worker (if supported) and set canvas size; always draw only visible region
  useEffect(() => {
    const htmlCanvas = canvasRef.current
    if (!htmlCanvas) return
    const dpr = window.devicePixelRatio || 1
    const CANVAS_WIDTH = gridWidth * BEAT_WIDTH + 80
    // Always size CSS for layout
    htmlCanvas.style.width = CANVAS_WIDTH + 'px'
    htmlCanvas.style.height = CANVAS_HEIGHT + 'px'

    // Setup playhead canvas size on main thread
    const playheadCanvas = playheadCanvasRef.current
    if (playheadCanvas) {
      playheadCanvas.width = CANVAS_WIDTH * dpr
      playheadCanvas.height = CANVAS_HEIGHT * dpr
      playheadCanvas.style.width = CANVAS_WIDTH + 'px'
      playheadCanvas.style.height = CANVAS_HEIGHT + 'px'
    }

    // Try OffscreenCanvas path once using a safe handshake to avoid blank canvas if worker fails
    if (!workerRef.current) {
      offscreenDesiredRef.current = true
      let fallbackDone = false
      const doFallback = (reason) => {
        if (fallbackDone) return
        fallbackDone = true
        useOffscreenRef.current = false
        offscreenDesiredRef.current = false
        offscreenReadyRef.current = false
        // Ensure 2D backing store and draw on main thread
        // Only resize if canvas hasn't been transferred (check if getContext still works)
        try {
          if (htmlCanvas.getContext) {
            htmlCanvas.width = CANVAS_WIDTH * dpr
            htmlCanvas.height = CANVAS_HEIGHT * dpr
          }
        } catch (e) {
          console.warn('Cannot resize canvas (already transferred):', e.message)
        }
        drawMainCanvas()
        if (reason) console.warn('Offscreen path disabled:', reason)
      }
      try {
        const worker = new Worker(new URL('../workers/pianoRollWorker.js', import.meta.url))
        workerRef.current = worker
        // Wait for 'ready' before transferring the canvas
        const readyHandler = (e) => {
          if (!e || !e.data || e.data.type !== 'ready') return
          worker.removeEventListener('message', readyHandler)
          // Now attempt Offscreen transfer if supported
          if (typeof htmlCanvas.transferControlToOffscreen !== 'function') {
            doFallback('transferControlToOffscreen not supported')
            return
          }
          try {
            const offscreen = htmlCanvas.transferControlToOffscreen()
            useOffscreenRef.current = true
            offscreenReadyRef.current = true
            worker.postMessage({
              type: 'init',
              canvas: offscreen,
              widthCSS: CANVAS_WIDTH,
              heightCSS: CANVAS_HEIGHT,
              devicePixelRatio: dpr
            }, [offscreen])
            // Push state and draw once
            worker.postMessage({
              type: 'setState',
              gridWidth,
              gridDivision,
              trackColor,
              notes,
              hiddenNoteIds,
              selectedNoteIds
            })
            drawMainCanvas()
          } catch (err) {
            doFallback(err?.message || 'Offscreen transfer failed')
          }
        }
        worker.addEventListener('message', readyHandler)
        worker.addEventListener('error', () => doFallback('worker error'))
        // Safety timeout: if ready not received soon, fallback
        setTimeout(() => {
          if (!useOffscreenRef.current) doFallback('worker ready timeout')
        }, 1500)
      } catch (e) {
        doFallback(e?.message || 'worker creation failed')
      }
    } else {
      // Worker exists: if width changed, notify to resize backing store
      if (useOffscreenRef.current) {
        workerRef.current.postMessage({
          type: 'resize',
          widthCSS: CANVAS_WIDTH,
          heightCSS: CANVAS_HEIGHT,
          devicePixelRatio: dpr
        })
      }
    }

    // Push latest state to worker or set up 2D canvas as fallback
    if (useOffscreenRef.current && workerRef.current) {
      workerRef.current.postMessage({
        type: 'setState',
        gridWidth,
        gridDivision,
        trackColor,
        notes,
        hiddenNoteIds,
        selectedNoteIds
      })
      // Trigger an initial draw for current viewport
      drawMainCanvas()
    } else {
      // Fallback: size the backing store and draw on main thread
      htmlCanvas.width = CANVAS_WIDTH * dpr
      htmlCanvas.height = CANVAS_HEIGHT * dpr
      drawMainCanvas()
    }

    return () => {
      // no-op here; worker terminated on unmount
    }
  }, [gridWidth])

  // Cleanup worker on unmount
  useEffect(() => {
    return () => {
      try { workerRef.current?.terminate() } catch {}
      workerRef.current = null
      useOffscreenRef.current = false
      try { playbackWorkerRef.current?.terminate() } catch {}
      playbackWorkerRef.current = null
      for (const id of scheduledTimeoutsRef.current) { try { clearTimeout(id) } catch {} }
      scheduledTimeoutsRef.current.clear()
    }
  }, [])

  // Keep worker state in sync on dependent changes
  useEffect(() => {
    if (useOffscreenRef.current && workerRef.current) {
      workerRef.current.postMessage({
        type: 'setState',
        gridWidth,
        gridDivision,
        trackColor,
        notes,
        hiddenNoteIds,
        selectedNoteIds
      })
      // Ask for a redraw of current viewport
      drawMainCanvas()
    } else {
      // Fallback path
      drawMainCanvas()
    }
  }, [notes, trackColor, gridDivision, selectedNoteIds, selectionMode, hiddenNoteIds])

  // Throttle scroll-driven redraws without React state churn
  useEffect(() => {
    const sc = scrollContainerRef.current
    if (!sc) return
    let raf = null
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = null
        drawMainCanvas()
      })
    }
    sc.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      sc.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [gridWidth])

  // Draw sticky piano keys on separate overlay canvas, dimming keys outside playable range
  useEffect(() => {
    const canvas = keysCanvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const KEYS_WIDTH = 80
    canvas.width = KEYS_WIDTH * dpr
    canvas.height = CANVAS_HEIGHT * dpr
    canvas.style.width = KEYS_WIDTH + 'px'
    canvas.style.height = CANVAS_HEIGHT + 'px'
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Clear
    ctx.clearRect(0, 0, KEYS_WIDTH, CANVAS_HEIGHT)

    for (let i = 0; i < pianoNotes.length; i++) {
      const y = i * NOTE_HEIGHT
      const isBlack = pianoNotes[i].includes('#')
      const midi = noteNameToMidi(pianoNotes[i])
      const inRange = midi >= (playableRangeState.min ?? 0) && midi <= (playableRangeState.max ?? 127)
      ctx.fillStyle = isBlack ? '#22242a' : '#f7f7fa'
      ctx.fillRect(0, y, KEYS_WIDTH, NOTE_HEIGHT)
      ctx.strokeStyle = '#444'
      ctx.lineWidth = 1
      ctx.strokeRect(0, y, KEYS_WIDTH, NOTE_HEIGHT)
  // Label: show drum/sample name when available, else note name
  const label = keyLabels[midi] || pianoNotes[i]
  // Label color dims when out of range
  ctx.fillStyle = inRange ? (isBlack ? '#ddd' : '#222') : (isBlack ? '#666' : '#999')
  ctx.font = keyLabels[midi] ? '11px Inter, sans-serif' : '12px Inter, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const paddingX = 6
  const maxTextWidth = KEYS_WIDTH - paddingX - 6
  const text = truncateToWidth(ctx, label, maxTextWidth)
  ctx.fillText(text, paddingX, y + NOTE_HEIGHT / 2)
      if (!inRange) {
        // Overlay semi-transparent hatch to indicate disabled
        ctx.fillStyle = isBlack ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'
        ctx.fillRect(0, y, KEYS_WIDTH, NOTE_HEIGHT)
      }
      if (hoveredKey === i) {
        ctx.fillStyle = 'rgba(59,130,246,0.18)'
        ctx.fillRect(0, y, KEYS_WIDTH, NOTE_HEIGHT)
      }
    }
  }, [hoveredKey, playableRangeState, keyLabels])

  // Removed JS-based horizontal counter-translation; using CSS position: sticky for jitter-free behavior

  // Keys canvas mouse helpers
  const getKeysMousePos = (e) => {
    const rect = keysCanvasRef.current.getBoundingClientRect()
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    }
  }

  const handleKeysMouseMove = (e) => {
    const { y } = getKeysMousePos(e)
    setHoveredKey(Math.max(0, Math.min(pianoNotes.length - 1, Math.floor(y / NOTE_HEIGHT))))
  }

  const handleKeysMouseLeave = () => {
    setHoveredKey(null)
  }

  const handleKeysMouseDown = (e) => {
    const { y } = getKeysMousePos(e)
    const keyIdx = Math.max(0, Math.min(pianoNotes.length - 1, Math.floor(y / NOTE_HEIGHT)))
    setHoveredKey(keyIdx)
    const nn = pianoNotes[keyIdx]
    const midi = noteNameToMidi(nn)
    const r = playableRangeRef.current || { min: 0, max: 127 }
    if (midi < r.min || midi > r.max) return
    playNote(nn, 0.3)
  }

  // Play a note using smplr instrument
  const playNote = (noteName, duration = 0.3) => {
    // Route to VST backend if enabled (use ref for immediate state)
    if (useVSTBackendRef.current) {
      const midiNote = noteNameToMidi(noteName)
      // Use longer duration for better sustain (min 500ms for preview notes)
      const durationMs = Math.max(500, Math.floor(duration * 1000))
      playBackendNote(trackId, midiNote, 0.8, durationMs, 1)
      return
    }
    
    if (!audioContextRef.current) {
      console.warn('No audio context available')
      return
    }
    // If we have a loaded SF2 instrument, use the backend
    if (spessaInstrumentRef.current && !instrumentLoading) {
      try {
        // Use backend to play the note
        const midiNote = noteNameToMidi(noteName)
        const vel = 80 / 127.0 // normalize to 0..1
        playBackendNote(trackId, midiNote, vel, Math.floor(duration * 1000), 1)
      } catch (error) {
        console.error('Error playing backend note:', error)
        // Fallback to oscillator
        playOscillatorNote(noteName, duration)
      }
    } else {
      if (instrumentLoading) {
        console.log('Instrument still loading, using oscillator')
      } else {
        console.log('No instrument loaded, using oscillator')
      }
      // Fallback to oscillator if no instrument loaded
      playOscillatorNote(noteName, duration)
    }
  }
  // Schedule a note at absolute AudioContext time (seconds)
  const scheduleNoteAt = (noteName, whenSec, durationSec, velocity = 80) => {
    const ctx = audioContextRef.current
    if (!ctx) return
    const now = ctx.currentTime
    const inSec = Math.max(0, whenSec - now)
    const sessionId = playbackSessionRef.current
    
    // Route to backend if VST or SF2 is loaded (use ref for immediate state)
    if (useVSTBackendRef.current || spessaInstrumentRef.current) {
      const id = setTimeout(() => {
        if (playbackSessionRef.current === sessionId) {
          const midiNote = noteNameToMidi(noteName)
          const vel = velocity / 127.0 // normalize to 0..1
          playBackendNote(trackId, midiNote, vel, Math.floor((durationSec || 0.3) * 1000), 1)
        }
        scheduledTimeoutsRef.current.delete(id)
      }, Math.floor(inSec * 1000))
      scheduledTimeoutsRef.current.add(id)
      return
    }
    
    // Oscillator fallback for when no instrument is loaded
    // Use setTimeout to allow session ID check (prevents ghost notes after pause)
    const id = setTimeout(() => {
      // Only play if still the same playback session (not paused/stopped)
      if (playbackSessionRef.current === sessionId) {
        try {
          const oscCtx = ctx
          const oscillator = oscCtx.createOscillator()
          const gainNode = oscCtx.createGain()
          oscillator.connect(gainNode)
          // Prefer preview chain (gain -> soft limiter) for consistent tone
          const dest = previewGainRef.current || oscCtx.destination
          gainNode.connect(dest)
          oscillator.frequency.value = noteToFrequency(noteName)
          oscillator.type = 'sine'
          const total = Math.max(0.01, durationSec || 0.3)
          const fadeOut = Math.min(total * 0.1, 0.05)
          const sustain = Math.max(0, total - fadeOut)
          // Start at modest level to match timeline fallback
          gainNode.gain.setValueAtTime(0.2, ctx.currentTime)
          if (sustain > 0) gainNode.gain.setValueAtTime(0.2, ctx.currentTime + sustain)
          gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + total)
          oscillator.start(ctx.currentTime)
          oscillator.stop(ctx.currentTime + total)
        } catch {}
      }
      scheduledTimeoutsRef.current.delete(id)
    }, Math.floor(inSec * 1000))
    scheduledTimeoutsRef.current.add(id)
  }


  // Fallback oscillator playback
  const playOscillatorNote = (noteName, duration = 0.3) => {
    if (!audioContextRef.current) return
    const ctx = audioContextRef.current
    const oscillator = ctx.createOscillator()
    const gainNode = ctx.createGain()
    oscillator.connect(gainNode)
  // Prefer preview chain (gain -> soft limiter) for consistent tone with Track view
  const dest = previewGainRef.current || ctx.destination
  gainNode.connect(dest)
    oscillator.frequency.value = noteToFrequency(noteName)
    oscillator.type = 'sine'
    const total = Math.max(0.01, duration)
    const fadeOut = Math.min(total * 0.1, 0.05)
    const sustain = Math.max(0, total - fadeOut)
    // Match TrackTimeline fallback loudness envelope
    gainNode.gain.setValueAtTime(0.2, ctx.currentTime)
    if (sustain > 0) gainNode.gain.setValueAtTime(0.2, ctx.currentTime + sustain)
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + total)
    oscillator.start(ctx.currentTime)
    oscillator.stop(ctx.currentTime + total)
  }

  // Mouse helpers
  const getMousePos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    }
  }

  // Find note at mouse
  const findNoteAt = (x, y) => {
    // iterate backwards to hit topmost first in case of overlaps
    for (let i = notes.length - 1; i >= 0; i--) {
      const note = notes[i]
      const idx = noteIndexMap[note.note]
      const nx = 80 + note.start * BEAT_WIDTH
      const ny = idx * NOTE_HEIGHT
      if (
        x >= nx && x <= nx + note.duration * BEAT_WIDTH &&
        y >= ny && y <= ny + NOTE_HEIGHT
      ) return note
    }
    return null
  }

  // Find resize handle at mouse
  const findResizeAt = (x, y) => {
    for (let i = notes.length - 1; i >= 0; i--) {
      const note = notes[i]
      const idx = noteIndexMap[note.note]
      const nx = 80 + note.start * BEAT_WIDTH
      const ny = idx * NOTE_HEIGHT
      if (
        x >= nx + note.duration * BEAT_WIDTH - RESIZE_HANDLE_WIDTH && x <= nx + note.duration * BEAT_WIDTH &&
        y >= ny && y <= ny + NOTE_HEIGHT
      ) return note
    }
    return null
  }

  // Rectangle intersection helper
  const rectsIntersect = (ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) => {
    return ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1
  }

  // Mouse down
  const handleMouseDown = (e) => {
    const { x, y } = getMousePos(e)
    if (x < 80) {
      // Piano key click
      const keyIdx = Math.floor(y / NOTE_HEIGHT)
      setHoveredKey(keyIdx)
      playNote(pianoNotes[keyIdx], 0.3)
      return
    }
    // All editing interactions (add/drag/resize/marquee) are only allowed in Edit mode
    if (mode !== 'edit') return
    if (!selectionMode) {
      // Resize
      const resizeNote = findResizeAt(x, y)
      if (resizeNote) {
        // Pause playback during resize (resume on mouseup)
        if (isPlaying && !pausedForEditRef.current) {
          pausedForEditRef.current = true
          togglePlayback()
        }
        const state = {
          id: resizeNote.id,
          startX: x,
          origDuration: resizeNote.duration
        }
        setResizing(state)
        setHiddenNoteIds([resizeNote.id])
        resizingLiveRef.current = { ...state, currentDuration: resizeNote.duration }
        // Seed preview for immediate visual feedback
        dragPreviewRef.current = { type: 'resize', id: resizeNote.id, duration: resizeNote.duration }
  updateDragDomFromPreview(dragPreviewRef.current)
        return
      }
      // Drag single note
      const dragNote = findNoteAt(x, y)
      if (dragNote) {
        // Pause playback during drag (resume on mouseup)
        if (isPlaying && !pausedForEditRef.current) {
          pausedForEditRef.current = true
          togglePlayback()
        }
        const state = {
          type: 'single',
          id: dragNote.id,
          startX: x,
          startY: y,
          origStart: dragNote.start,
          origNote: dragNote.note,
          origDuration: dragNote.duration
        }
        setDragging(state)
        setHiddenNoteIds([dragNote.id])
        // Seed preview
        dragPreviewRef.current = { type: 'single', id: dragNote.id, start: dragNote.start, note: dragNote.note, duration: dragNote.duration }
  updateDragDomFromPreview(dragPreviewRef.current)
        return
      }
      // Add note (only if within playable range)
      const subdivisionsPerBeat = gridDivision / 4  // e.g., 4→1, 8→2, 16→4
      const beatRaw = (x - 80) / BEAT_WIDTH
      const beat = Math.floor(beatRaw * subdivisionsPerBeat) / subdivisionsPerBeat // Snap to grid division
      const noteIdx = Math.floor(y / NOTE_HEIGHT)
      const noteName = pianoNotes[noteIdx]
      if (beat >= 0 && beat < gridWidth && noteName) {
        const midi = noteNameToMidi(noteName)
        const r = playableRangeRef.current || { min: 0, max: 127 }
        if (midi < r.min || midi > r.max) return
        // Use last note duration if available, otherwise default to one subdivision
        const duration = lastNoteDuration !== null ? lastNoteDuration : (1 / subdivisionsPerBeat)
        const newNote = {
          id: Date.now(),
          note: noteName,
          start: beat,
          duration: duration
        }
  commitNotesChange([...notes, newNote])
        // Don't save duration here - only save when resizing
        playNote(noteName, 0.2)
      }
    } else {
      // Selection mode
      const hit = findNoteAt(x, y)
      if (hit && selectedNoteIds.includes(hit.id)) {
        // Pause playback during grouped drag
        if (isPlaying && !pausedForEditRef.current) {
          pausedForEditRef.current = true
          togglePlayback()
        }
        // Start group drag
        const snapshot = notes
          .filter(n => selectedNoteIds.includes(n.id))
          .map(n => ({ id: n.id, origStart: n.start, origIdx: noteIndexMap[n.note] }))
        // Enrich snapshot with duration and precomputed bounds for fast clamping during drag
        const enriched = snapshot.map(s => ({ ...s, origDuration: (notes.find(n => n.id === s.id)?.duration) || 0 }))
        const origStarts = enriched.map(s => s.origStart)
        const origEnds = enriched.map(s => s.origStart + s.origDuration)
        const minStart = Math.min(...origStarts)
        const maxEnd = Math.max(...origEnds)
        const state = { type: 'group', startX: x, startY: y, snapshot: enriched, minStart, maxEnd }
        setDragging(state)
        setHiddenNoteIds(snapshot.map(s => s.id))
        // Seed preview
        dragPreviewRef.current = {
          type: 'group',
          items: enriched.map(s => ({ id: s.id, start: s.origStart, noteIdx: s.origIdx, duration: s.origDuration }))
        }
  updateDragDomFromPreview(dragPreviewRef.current)
        return
      }
      // Start marquee selection
      const start = { startX: x, startY: y, x, y }
      marqueeRef.current = start
      setMarquee(start) // set once to mark lifecycle start (no heavy redraws)
      // Draw initial marquee
      drawPlayhead(currentBeat, playheadCanvasRef, CANVAS_HEIGHT)
      // If clicked directly on a note but wasn't selected, we'll update selection on move/up via marquee
    }
  }

  // Mouse move
  const handleMouseMove = (e) => {
    // Ignore editing move updates outside Edit mode
    if (mode !== 'edit') return
    const { x, y } = getMousePos(e)
    if (x < 80) {
      setHoveredKey(Math.floor(y / NOTE_HEIGHT))
    } else {
      setHoveredKey(null)
    }
    // Update cursor when hovering resize handle (when not actively dragging/resizing)
    if (!dragging && !resizing && playheadCanvasRef.current) {
      const overHandle = x >= 80 && !!findResizeAt(x, y)
      playheadCanvasRef.current.style.cursor = overHandle ? 'ew-resize' : (selectionMode ? 'crosshair' : 'crosshair')
    }
    if (dragging) {
      const subdivisionsPerBeat = gridDivision / 4
      if (dragging.type === 'single') {
        const beatDelta = ((x - dragging.startX) / BEAT_WIDTH) // free move (no snap)
        const noteDelta = Math.round((y - dragging.startY) / NOTE_HEIGHT)
        const noteIdx = noteIndexMap[dragging.origNote]
        const newNoteIdx = Math.max(0, Math.min(pianoNotes.length - 1, noteIdx + noteDelta))
        const newNote = pianoNotes[newNoteIdx]
        const duration = dragging.origDuration || 0
        const maxStart = Math.max(0, gridWidth - duration)
        const newStart = Math.max(0, Math.min(maxStart, dragging.origStart + beatDelta))
        dragPreviewRef.current = {
          type: 'single',
          id: dragging.id,
          start: newStart,
          note: newNote,
          duration
        }
        if (!overlayRafRef.current) {
          overlayRafRef.current = requestAnimationFrame(() => {
            overlayRafRef.current = null
            updateDragDomFromPreview(dragPreviewRef.current)
          })
        }
      } else if (dragging.type === 'group') {
        // Compute allowed deltas for the whole group (no snap during drag)
        const rawBeatDelta = ((x - dragging.startX) / BEAT_WIDTH)
        const noteDelta = Math.round((y - dragging.startY) / NOTE_HEIGHT)
        const origIdxs = dragging.snapshot.map(s => s.origIdx)
        const minIdx = Math.min(...origIdxs)
        const maxIdx = Math.max(...origIdxs)
        // Clamp vertical delta so all notes stay within range
        const clampedNoteDelta = Math.max(-minIdx, Math.min(noteDelta, pianoNotes.length - 1 - maxIdx))
        // Clamp horizontal delta so region stays within grid using precomputed bounds
        const maxLeft = -dragging.minStart
        const maxRight = gridWidth - dragging.maxEnd
        const clampedBeatDelta = Math.max(maxLeft, Math.min(rawBeatDelta, maxRight))
        // Build preview items only (no state write)
        const items = dragging.snapshot.map(s => ({
          id: s.id,
          start: Math.max(0, Math.min(gridWidth, s.origStart + clampedBeatDelta)),
          noteIdx: s.origIdx + clampedNoteDelta,
          duration: s.origDuration
        }))
        dragPreviewRef.current = { type: 'group', items }
        if (!overlayRafRef.current) {
          overlayRafRef.current = requestAnimationFrame(() => {
            overlayRafRef.current = null
            updateDragDomFromPreview(dragPreviewRef.current)
          })
        }
      }
    } else if (resizing) {
      // Free resize (no snap) — snap on commit
      const beatDelta = (x - resizing.startX) / BEAT_WIDTH
      const newDuration = Math.max(0.05, resizing.origDuration + beatDelta)
      // Live preview only; commit on mouseup
      resizingLiveRef.current = { ...resizing, currentDuration: newDuration }
      dragPreviewRef.current = { type: 'resize', id: resizing.id, duration: newDuration }
      if (!overlayRafRef.current) {
        overlayRafRef.current = requestAnimationFrame(() => {
          overlayRafRef.current = null
          updateDragDomFromPreview(dragPreviewRef.current)
        })
      }
    } else if (selectionMode && marqueeRef.current) {
      // Update marquee in a ref and throttle drawing via rAF
      marqueeRef.current = { ...marqueeRef.current, x, y }
      if (!marqueeRafRef.current) {
        marqueeRafRef.current = requestAnimationFrame(() => {
          marqueeRafRef.current = null
          drawPlayhead(currentBeat, playheadCanvasRef, CANVAS_HEIGHT)
        })
      }
    }
  }

  // Mouse up
  const handleMouseUp = (e) => {
    // Ignore commits outside Edit mode
    if (mode !== 'edit') return
    // Commit drag/resize changes once on mouseup
    if (dragging) {
      const subdivisionsPerBeat = gridDivision / 4
      if (dragging.type === 'single') {
        const { x, y } = getMousePos(e)
        const beatDelta = ((x - dragging.startX) / BEAT_WIDTH)
        const snappedBeatDelta = Math.round(beatDelta * subdivisionsPerBeat) / subdivisionsPerBeat
        const noteDelta = Math.round((y - dragging.startY) / NOTE_HEIGHT)
        const noteIdx = noteIndexMap[dragging.origNote]
        const newNoteIdx = Math.max(0, Math.min(pianoNotes.length - 1, noteIdx + noteDelta))
        const newNote = pianoNotes[newNoteIdx]
        const newStart = Math.max(0, Math.min(gridWidth - (1 / subdivisionsPerBeat), dragging.origStart + snappedBeatDelta))
  commitNotesChange(notes.map(n => n.id === dragging.id ? { ...n, note: newNote, start: newStart } : n))
      } else if (dragging.type === 'group') {
        const { x, y } = getMousePos(e)
        const rawBeatDelta = ((x - dragging.startX) / BEAT_WIDTH)
        const snappedBeatDelta = Math.round(rawBeatDelta * subdivisionsPerBeat) / subdivisionsPerBeat
        const noteDelta = Math.round((y - dragging.startY) / NOTE_HEIGHT)
        const origIdxs = dragging.snapshot.map(s => s.origIdx)
        const minIdx = Math.min(...origIdxs)
        const maxIdx = Math.max(...origIdxs)
        const clampedNoteDelta = Math.max(-minIdx, Math.min(noteDelta, pianoNotes.length - 1 - maxIdx))
        const origStarts = dragging.snapshot.map(s => s.origStart)
        const origDurations = dragging.snapshot.map(s => (notes.find(n => n.id === s.id)?.duration || 0))
        const minStart = Math.min(...origStarts)
        const maxEnd = Math.max(...origStarts.map((s, i) => s + (origDurations[i] || 0)))
        const maxLeft = -minStart
        const maxRight = gridWidth - maxEnd
        const clampedBeatDelta = Math.max(maxLeft, Math.min(snappedBeatDelta, maxRight))
        const updated = notes.map(n => {
          const snap = dragging.snapshot.find(s => s.id === n.id)
          if (!snap) return n
          const newIdx = snap.origIdx + clampedNoteDelta
          return {
            ...n,
            note: pianoNotes[newIdx],
            start: Math.max(0, Math.min(gridWidth, snap.origStart + clampedBeatDelta))
          }
        })
  commitNotesChange(updated)
      }
    }
    if (resizing && resizingLiveRef.current && resizingLiveRef.current.currentDuration !== undefined) {
      // Snap duration on commit
      const subdivisionsPerBeat = gridDivision / 4
      const rawFinal = resizingLiveRef.current.currentDuration
      const snapped = Math.max(1 / subdivisionsPerBeat, Math.round(rawFinal * subdivisionsPerBeat) / subdivisionsPerBeat)
      setLastNoteDuration(snapped)
  commitNotesChange(notes.map(n => n.id === resizing.id ? { ...n, duration: snapped } : n))
    }
  setDragging(null)
  setResizing(null)
  setHiddenNoteIds([])
    dragPreviewRef.current = null
    resizingLiveRef.current = null
    // Clear overlay artifacts: clear last rects once, then redraw playhead fresh
    clearDragDom()
    drawPlayhead(currentBeat, playheadCanvasRef, CANVAS_HEIGHT)
    drawPlayhead(currentBeat, playheadCanvasRef, CANVAS_HEIGHT)
    // Resume playback if we paused for edit
    if (pausedForEditRef.current) {
      pausedForEditRef.current = false
      togglePlayback()
    }
    if (marqueeRef.current) {
      // Finalize marquee selection: compute selected once
      const m = marqueeRef.current
      const sx1 = Math.min(m.startX, m.x)
      const sy1 = Math.min(m.startY, m.y)
      const sx2 = Math.max(m.startX, m.x)
      const sy2 = Math.max(m.startY, m.y)
      const newlySelected = []
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i]
        const idx = noteIndexMap[n.note]
        if (idx === -1) continue
        const nx1 = 80 + n.start * BEAT_WIDTH
        const ny1 = idx * NOTE_HEIGHT
        const nx2 = nx1 + n.duration * BEAT_WIDTH
        const ny2 = ny1 + NOTE_HEIGHT
        if (rectsIntersect(sx1, sy1, sx2, sy2, nx1, ny1, nx2, ny2)) {
          newlySelected.push(n.id)
        }
      }
      setSelectedNoteIds(newlySelected)
      setMarquee(null)
      marqueeRef.current = null
      drawPlayhead(currentBeat, playheadCanvasRef, CANVAS_HEIGHT)
    }
  }

  // Right click
  const handleContextMenu = (e) => {
    e.preventDefault()
    if (mode !== 'edit') return
    const { x, y } = getMousePos(e)
    const note = findNoteAt(x, y)
    if (selectionMode) {
      // In selection mode, delete all selected if right-click on any selected
      if (note && selectedNoteIds.includes(note.id)) {
  commitNotesChange(notes.filter(n => !selectedNoteIds.includes(n.id)))
        setSelectedNoteIds([])
      } else if (note) {
  commitNotesChange(notes.filter(n => n.id !== note.id))
      }
    } else {
  if (note) commitNotesChange(notes.filter(n => n.id !== note.id))
    }
  }

  // Playback animation loop using requestAnimationFrame for smoothness
  const playbackLoop = () => {
    if (!playbackStartTimeRef.current) return
    
    const beatDuration = 60000 / bpm
    const elapsed = Date.now() - playbackStartTimeRef.current
    const beat = playbackStartBeatRef.current + (elapsed / beatDuration)
    
    // Determine when to stop: last note end (fallback to grid width)
    const maxEndBeat = (typeof playbackMaxEndBeatRef.current === 'number')
      ? playbackMaxEndBeatRef.current
      : gridWidth

    if (beat >= maxEndBeat - 0.001) {
      // End of track
      setIsPlaying(false)
      setCurrentBeat(0)
      currentBeatRef.current = 0
      playbackStartTimeRef.current = null
      lastPlayedBeatsRef.current.clear()
      playbackMaxEndBeatRef.current = null
      playbackSessionRef.current++ // Invalidate any remaining scheduled notes
      // Stop scheduler
      try { playbackWorkerRef.current?.postMessage({ type: 'stop' }) } catch {}
      for (const id of scheduledTimeoutsRef.current) { try { clearTimeout(id) } catch {} }
      scheduledTimeoutsRef.current.clear()
      if (playbackAnimationRef.current) {
        cancelAnimationFrame(playbackAnimationRef.current)
        playbackAnimationRef.current = null
      }
      return
    }
    // Update refs & draw playheads directly to avoid full React re-render each frame
    currentBeatRef.current = beat
    drawPlayhead(beat, playheadCanvasRef, CANVAS_HEIGHT)
    drawPlayhead(beat, timelinePlayheadCanvasRef, TIMELINE_HEIGHT)
    // Throttle state updates for external consumers/UI (every ~100ms)
    const now = Date.now()
    if (now - (lastBeatStateUpdateRef.current || 0) > 100) {
      lastBeatStateUpdateRef.current = now
      setCurrentBeat(beat)
    }

    // Note triggering is handled by the playback scheduler worker; UI loop only updates playhead
    
    playbackAnimationRef.current = requestAnimationFrame(playbackLoop)
  }

  // Playback (pause keeps cursor; resume starts from cursor)
  const togglePlayback = () => {
    if (isPlayingRef.current) {
      // Pause: keep current cursor position
      setIsPlaying(false)
      if (playbackAnimationRef.current) {
        cancelAnimationFrame(playbackAnimationRef.current)
        playbackAnimationRef.current = null
      }
      // Save the current playhead position when pausing
      setCurrentBeat(currentBeatRef.current)
      playbackStartTimeRef.current = null
      lastPlayedBeatsRef.current.clear()
      playbackMaxEndBeatRef.current = null
      // Increment session ID so any in-flight timeouts won't play notes
      playbackSessionRef.current++
      // Stop scheduler and clear pending timeouts
      try { playbackWorkerRef.current?.postMessage({ type: 'stop' }) } catch {}
      for (const id of scheduledTimeoutsRef.current) { try { clearTimeout(id) } catch {} }
      scheduledTimeoutsRef.current.clear()
    } else {
      // Only allow starting playback in Play mode for performance
      if (modeRef.current !== 'play') return
      // Resume/start: from current cursor
      setIsPlaying(true)
      // Increment session ID for new playback session
      playbackSessionRef.current++
      const startBeat = currentBeatRef.current || 0
      // Compute last note end as stop point
      const maxEndBeat = (() => {
        const arr = notesRef.current || []
        let maxEnd = 0
        for (const n of arr) {
          const end = (n.start || 0) + (n.duration || 0)
          if (end > maxEnd) maxEnd = end
        }
        return maxEnd > 0 ? maxEnd : gridWidth
      })()
      playbackMaxEndBeatRef.current = maxEndBeat
      playbackStartTimeRef.current = Date.now()
      playbackStartBeatRef.current = startBeat
      lastPlayedBeatsRef.current.clear()
      playbackAnimationRef.current = requestAnimationFrame(playbackLoop)
      // Start scheduler worker for audio note triggering
      const ctx = audioContextRef.current
      if (ctx) {
        try { if (ctx.state === 'suspended') ctx.resume() } catch {}
        const baseAudioTime = ctx.currentTime
  // No need to pass main-thread performance.now to worker; it uses its own clock
        if (!playbackWorkerRef.current) {
          try {
            const w = new Worker(new URL('../workers/playbackScheduler.js', import.meta.url))
            playbackWorkerRef.current = w
            w.onmessage = (e) => {
              const { type, events } = e.data || {}
              if (type === 'ready') {
                schedulerReadyRef.current = true
              } else if (type === 'events' && Array.isArray(events)) {
                for (let i = 0; i < events.length; i++) {
                  const ev = events[i]
                  scheduleNoteAt(ev.note, ev.audioTime, ev.durationSec, 80)
                }
              } else if (type === 'ended') {
                // Auto-stop when scheduler is done
                setIsPlaying(false)
                setCurrentBeat(0)
                currentBeatRef.current = 0
                playbackStartTimeRef.current = null
                lastPlayedBeatsRef.current.clear()
                playbackMaxEndBeatRef.current = null
                if (playbackAnimationRef.current) {
                  cancelAnimationFrame(playbackAnimationRef.current)
                  playbackAnimationRef.current = null
                }
              }
            }
          } catch {}
        }
        const w = playbackWorkerRef.current
        if (w) {
          const arr = notesRef.current || []
          w.postMessage({
            type: 'init',
            bpm,
            startBeat,
            notes: arr,
            lookaheadSec: lookaheadSecRef.current,
            tickSec: schedulerTickSecRef.current,
            maxEndBeat,
            baseAudioTime
          })
          w.postMessage({ type: 'start' })
        }
      }
    }
  }

  // Build subdivision schedule map whenever notes change
  useEffect(() => {
    const map = new Map()
    const arr = notesRef.current || []
    const subdivisionsPerBeat = 4 // 16th
    for (let i = 0; i < arr.length; i++) {
      const n = arr[i]
      const key = Math.round((n.start || 0) * subdivisionsPerBeat)
      const bucket = map.get(key)
      if (bucket) bucket.push(n)
      else map.set(key, [n])
    }
    noteScheduleMapRef.current = map
  }, [notes])

  // Rewind to start; if playing, continue from start immediately
  const handleRewind = () => {
    setCurrentBeat(0)
    currentBeatRef.current = 0
    if (isPlaying) {
      // Restart playhead timing from beginning without toggling state
      playbackStartTimeRef.current = Date.now()
      playbackStartBeatRef.current = 0
      // Recompute stop point on rewind
      const arr = notesRef.current || []
      let maxEnd = 0
      for (const n of arr) {
        const end = (n.start || 0) + (n.duration || 0)
        if (end > maxEnd) maxEnd = end
      }
      playbackMaxEndBeatRef.current = maxEnd > 0 ? maxEnd : gridWidth
      lastPlayedBeatsRef.current.clear()
      // Clear any previously scheduled note callbacks
      for (const id of scheduledTimeoutsRef.current) { try { clearTimeout(id) } catch {} }
      scheduledTimeoutsRef.current.clear()
      if (!playbackAnimationRef.current) {
        playbackAnimationRef.current = requestAnimationFrame(playbackLoop)
      }
      // Also reset scheduler to start
      const ctx = audioContextRef.current
      if (playbackWorkerRef.current && ctx) {
        try {
          playbackWorkerRef.current.postMessage({
            type: 'seek',
            startBeat: 0,
            baseAudioTime: ctx.currentTime
          })
        } catch {}
      }
    }
  }

  useEffect(() => {
    return () => {
      if (playbackIntervalRef.current) clearInterval(playbackIntervalRef.current)
      if (playbackAnimationRef.current) cancelAnimationFrame(playbackAnimationRef.current)
    }
  }, [])

  // Attach global mouse listeners during drag/resize/marquee selection
  useEffect(() => {
    if (dragging || resizing || marquee) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [dragging, resizing, marquee])

  // Extend piano roll
  const handleExtend = () => {
    setGridWidth(gw => gw + EXTEND_AMOUNT)
  }

  // Import MIDI file and replace notes
  const handleImportMidi = async () => {
    try {
      const res = await window.api.openMidi()
      if (!res || !res.ok || !res.bytes || res.canceled) return
      const bytes = new Uint8Array(res.bytes)
      const arrayBuffer = bytes.buffer
      const midi = new Midi(arrayBuffer)
      const ppq = midi.header.ppq || 480
      const imported = []
      let idCounter = Date.now()
      let maxEnd = 0
      // Merge notes from all tracks
      for (const track of midi.tracks) {
        for (const n of track.notes) {
          const name = n.name // e.g., 'C#4'
          if (!name) continue
          // Skip notes outside our displayed piano range
          if (!pianoNotes.includes(name)) continue
          const startBeats = (n.ticks ?? Math.round(n.time * ppq)) / ppq
          const durationBeats = (n.durationTicks ?? Math.round(n.duration * ppq)) / ppq
          if (durationBeats <= 0) continue
          imported.push({
            id: idCounter++,
            note: name,
            start: startBeats,
            duration: durationBeats
          })
          const end = startBeats + durationBeats
          if (end > maxEnd) maxEnd = end
        }
      }
      // Sort by start time for consistency
      imported.sort((a, b) => a.start - b.start || a.note.localeCompare(b.note))
  commitNotesChange(imported)
      // Extend grid to fit imported content with a small tail
      const needed = Math.ceil(maxEnd + 4)
      setGridWidth(gw => (needed > gw ? needed : gw))
      setCurrentBeat(0)
    } catch (err) {
      console.error('Failed to import MIDI:', err)
    }
  }

  // Toggle grid division between quarter, eighth, and sixteenth notes
  const cycleGridDivision = () => {
    setGridDivision(prev => {
      if (prev === 4) return 8   // quarter → eighth
      if (prev === 8) return 16  // eighth → sixteenth
      return 4                    // sixteenth → quarter
    })
  }

  // Timeline click to seek
  const handleTimelineClick = (e) => {
    const rect = timelineCanvasRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    if (x >= 80) {
      const beat = (x - 80) / BEAT_WIDTH
      setCurrentBeat(beat)
      if (isPlaying) {
        // Reset playback from new position
        if (playbackAnimationRef.current) {
          cancelAnimationFrame(playbackAnimationRef.current)
        }
        playbackStartTimeRef.current = Date.now()
        playbackStartBeatRef.current = beat
        lastPlayedBeatsRef.current.clear()
        // Clear any pending scheduled timeouts from previous position
        for (const id of scheduledTimeoutsRef.current) { try { clearTimeout(id) } catch {} }
        scheduledTimeoutsRef.current.clear()
        // Seek scheduler so audio matches the new position
        const ctx = audioContextRef.current
        if (playbackWorkerRef.current && ctx) {
          try {
            playbackWorkerRef.current.postMessage({
              type: 'seek',
              startBeat: beat,
              baseAudioTime: ctx.currentTime
            })
          } catch {}
        }
        playbackAnimationRef.current = requestAnimationFrame(playbackLoop)
      }
    }
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-zinc-900">
      <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-b from-zinc-800 to-zinc-900 border-b border-zinc-700 shadow-lg">
        {/* Left section: Back button, Track info, and Play button */}
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="h-9 px-3 flex items-center justify-center bg-zinc-700/50 hover:bg-zinc-600 text-white rounded-lg transition-all hover:scale-105 active:scale-95"
              title="Back to tracks"
            >
              <span className="text-xl leading-none">←</span>
            </button>
          )}
          <div className="flex items-center gap-2.5 px-3 h-9 bg-zinc-800/60 rounded-lg border border-zinc-700/50">
            <div
              className="w-3 h-3 rounded-full shadow-sm"
              style={{ backgroundColor: trackColor }}
            />
            <h2 className="text-white font-medium text-sm">{trackName}</h2>
          </div>
          {/* Mode switcher */}
          <div className="flex items-center rounded-lg overflow-hidden border border-zinc-700/50">
            <button
              onClick={() => setMode('edit')}
              className={`h-9 px-3 text-xs font-medium transition-colors ${mode === 'edit' ? 'bg-zinc-200 text-zinc-900' : 'bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700 hover:text-white'}`}
              title="Edit notes"
            >
              Edit
            </button>
            <button
              onClick={() => setMode('play')}
              className={`h-9 px-3 text-xs font-medium transition-colors border-l border-zinc-700/50 ${mode === 'play' ? 'bg-zinc-200 text-zinc-900' : 'bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700 hover:text-white'}`}
              title="Playback mode"
            >
              Play
            </button>
          </div>
          {/* Rewind to start */}
          <button
            onClick={handleRewind}
            className="h-9 w-9 flex items-center justify-center bg-zinc-700/50 hover:bg-zinc-600 text-white rounded-lg transition-all hover:scale-105 active:scale-95"
            title="Rewind to start"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
              <path d="M11 7l-6 5 6 5V7zm8 0l-6 5 6 5V7z"></path>
            </svg>
          </button>
          <button
            onClick={togglePlayback}
            disabled={mode !== 'play'}
            className={`h-9 px-3 flex items-center justify-center ${
              mode !== 'play' ? 'bg-zinc-800/40 text-zinc-500 cursor-not-allowed border border-zinc-700/40' : (isPlaying 
                ? 'bg-red-600 hover:bg-red-700' 
                : 'bg-blue-600 hover:bg-blue-700')
            } rounded-lg transition-all ${mode === 'play' ? 'text-white hover:scale-105 active:scale-95 shadow-md' : ''}`}
            title={mode !== 'play' ? 'Switch to Play mode to play' : (isPlaying ? 'Pause' : 'Play')}
          >
            <span className="text-sm leading-none">{isPlaying ? '⏸' : '▶'}</span>
          </button>
        </div>

        {/* Center section: Instrument selector */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              setSelectionMode(s => {
                const next = !s
                if (!next) setSelectedNoteIds([])
                return next
              })
            }}
            disabled={mode !== 'edit'}
            className={`h-9 px-3 rounded-lg transition-all text-xs font-medium border ${mode !== 'edit' ? 'bg-zinc-800/30 text-zinc-500 border-zinc-700/30 cursor-not-allowed' : (selectionMode ? 'bg-blue-600 text-white border-blue-500' : 'bg-zinc-800/60 hover:bg-zinc-700 text-zinc-300 hover:text-white border-zinc-700/50')}`}
            title="Toggle selection mode"
          >
            {selectionMode ? 'Selecting…' : 'Select'}
          </button>
          <button
            onClick={() => { if (mode === 'edit' && !useVSTBackend) setShowInstrumentSelector(true) }}
            disabled={mode !== 'edit' || useVSTBackend}
            className={`h-9 px-4 rounded-lg transition-all border flex items-center gap-2 shadow-sm ${mode !== 'edit' || useVSTBackend ? 'bg-zinc-800/30 text-zinc-500 border-zinc-700/30 cursor-not-allowed' : 'bg-zinc-800/80 hover:bg-zinc-700 text-white border-zinc-600/50 hover:border-zinc-500'}`}
            title={useVSTBackend ? 'Instrument disabled (VST loaded)' : (mode !== 'edit' ? 'Switch to Edit mode to change instrument' : 'Select Instrument')}
          >
            <span className="text-base">{selectedInstrument?.icon || '🎹'}</span>
            <span className="text-sm font-medium">{selectedInstrument?.name || 'Select Instrument'}</span>
            <span className="text-xs text-zinc-400">▼</span>
          </button>
          <button
            onClick={() => { if (mode === 'edit') setShowVSTSelector(true) }}
            disabled={mode !== 'edit'}
            className={`h-9 px-4 rounded-lg transition-all border flex items-center gap-2 shadow-sm ${mode !== 'edit' ? 'bg-zinc-800/30 text-zinc-500 border-zinc-700/30 cursor-not-allowed' : (useVSTBackend ? 'bg-emerald-600/80 hover:bg-emerald-600 text-white border-emerald-500/50' : 'bg-zinc-800/80 hover:bg-zinc-700 text-white border-zinc-600/50 hover:border-zinc-500')}`}
            title={mode !== 'edit' ? 'Switch to Edit mode to load VST' : 'Load VST Plugin'}
          >
            <span className="text-base">🎛️</span>
            <span className="text-sm font-medium">{useVSTBackend ? 'VST Loaded' : 'Load VST'}</span>
          </button>
          {useVSTBackend && (
            <button
              onClick={async () => {
                if (mode === 'edit') {
                  const success = await openVSTEditor(trackId)
                  if (!success) {
                    alert('Failed to open VST editor. Check console for details.')
                  }
                }
              }}
              disabled={mode !== 'edit'}
              className={`h-9 px-4 rounded-lg transition-all border flex items-center gap-2 shadow-sm ${mode !== 'edit' ? 'bg-zinc-800/30 text-zinc-500 border-zinc-700/30 cursor-not-allowed' : 'bg-emerald-600/80 hover:bg-emerald-700 text-white border-emerald-500/50'}`}
              title={mode !== 'edit' ? 'Switch to Edit mode to edit VST' : 'Open VST Editor'}
            >
              <span className="text-base">⚙️</span>
              <span className="text-sm font-medium">Edit VST</span>
            </button>
          )}
          <button
            onClick={handleImportMidi}
            disabled={mode !== 'edit'}
            className={`h-9 px-3 rounded-lg transition-all text-xs font-medium border ${mode !== 'edit' ? 'bg-emerald-700/20 text-zinc-500 border-emerald-700/20 cursor-not-allowed' : 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-500/60 shadow-sm'}`}
            title="Import MIDI file into this piano roll"
          >
            Import MIDI
          </button>
          <button
            onClick={() => commitNotesChange([])}
            disabled={mode !== 'edit'}
            className={`h-9 px-3 rounded-lg transition-all text-xs font-medium border ${mode !== 'edit' ? 'bg-zinc-800/30 text-zinc-500 border-zinc-700/30 cursor-not-allowed' : 'bg-zinc-800/60 hover:bg-zinc-700 text-zinc-300 hover:text-white border-zinc-700/50'}`}
            title="Clear all notes"
          >
            Clear All
          </button>
          <button
            onClick={handleUndo}
            disabled={!canUndo}
            className={`h-9 px-3 rounded-lg transition-all text-xs font-medium border ${canUndo ? 'bg-zinc-800/60 hover:bg-zinc-700 text-zinc-100 hover:text-white border-zinc-700/50' : 'bg-zinc-800/30 text-zinc-500 border-zinc-700/30 cursor-not-allowed'}`}
            title="Undo (Ctrl+Z)"
          >
            Undo
          </button>
          <button
            onClick={cycleGridDivision}
            disabled={mode !== 'edit'}
            className={`h-9 px-3 rounded-lg transition-all text-xs font-medium border ${mode !== 'edit' ? 'bg-zinc-800/30 text-zinc-500 border-zinc-700/30 cursor-not-allowed' : 'bg-zinc-800/60 hover:bg-zinc-700 text-zinc-300 hover:text-white border-zinc-700/50'}`}
            title="Change grid division"
          >
            Grid: 1/{gridDivision}
          </button>
          <button
            onClick={handleExtend}
            disabled={mode !== 'edit'}
            className={`h-9 px-3 rounded-lg transition-all text-xs font-medium border ${mode !== 'edit' ? 'bg-zinc-800/30 text-zinc-500 border-zinc-700/30 cursor-not-allowed' : 'bg-zinc-800/60 hover:bg-zinc-700 text-zinc-300 hover:text-white border-zinc-700/50'}`}
            title={`Extend roll by ${EXTEND_AMOUNT} beats`}
          >
            Extend
          </button>
        </div>

        {/* Right section: BPM control */}
        <div className="flex items-center gap-2 px-3 h-9 bg-zinc-800/60 rounded-lg border border-zinc-700/50">
          <label className="text-zinc-400 text-xs font-medium tracking-wide">BPM</label>
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
            className="w-14 px-2 py-1 bg-zinc-900 text-white rounded border border-zinc-600 focus:border-blue-500 focus:outline-none text-sm font-medium text-center"
            min="40"
            max="300"
          />
        </div>
      </div>
      <div ref={scrollContainerRef} className="flex-1 overflow-auto bg-zinc-900 relative">
        <div style={{ position: 'sticky', top: 0, zIndex: 10 }}>
          <div style={{ position: 'relative' }}>
            <canvas
              ref={timelineCanvasRef}
              style={{
                display: 'block',
                width: gridWidth * BEAT_WIDTH + 80,
                height: TIMELINE_HEIGHT,
                background: 'transparent',
                borderBottom: '1px solid #3f3f46',
                position: 'absolute',
                top: 0,
                left: 0
              }}
            />
            <canvas
              ref={timelinePlayheadCanvasRef}
              style={{
                display: 'block',
                width: gridWidth * BEAT_WIDTH + 80,
                height: TIMELINE_HEIGHT,
                background: 'transparent',
                cursor: 'pointer',
                position: 'absolute',
                top: 0,
                left: 0,
                pointerEvents: 'auto'
              }}
              onClick={handleTimelineClick}
            />
          </div>
        </div>
        <div style={{ width: gridWidth * BEAT_WIDTH + 80, minWidth: '100vw', minHeight: '100vh' }}>
          <div style={{ position: 'relative' }}>
            {/* Sticky left piano keys overlay (counter-scroll horizontally) */}
            <div
              ref={keysOverlayRef}
              style={{
                position: 'sticky',
                left: 0,
                width: 80,
                height: CANVAS_HEIGHT,
                zIndex: 5,
                pointerEvents: 'auto',
                background: 'transparent'
              }}
            >
              <canvas
                ref={keysCanvasRef}
                style={{
                  display: 'block',
                  width: 80,
                  height: CANVAS_HEIGHT,
                  background: 'transparent'
                }}
                onMouseDown={handleKeysMouseDown}
                onMouseMove={handleKeysMouseMove}
                onMouseLeave={handleKeysMouseLeave}
              />
            </div>
            <canvas
              ref={canvasRef}
              style={{
                display: 'block',
                width: gridWidth * BEAT_WIDTH + 80,
                height: CANVAS_HEIGHT,
                background: 'transparent',
                position: 'absolute',
                top: 0,
                left: 0
              }}
            />
            <canvas
              ref={playheadCanvasRef}
              style={{
                display: 'block',
                width: gridWidth * BEAT_WIDTH + 80,
                height: CANVAS_HEIGHT,
                background: 'transparent',
                cursor: mode !== 'edit' ? 'default' : (dragging ? 'move' : (resizing ? 'ew-resize' : (selectionMode ? 'crosshair' : 'crosshair'))),
                position: 'absolute',
                top: 0,
                left: 0,
                pointerEvents: 'auto'
              }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onContextMenu={handleContextMenu}
            />
            {/* GPU-accelerated DOM drag layer for realtime previews */}
            <div
              ref={dragLayerRef}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: gridWidth * BEAT_WIDTH + 80,
                height: CANVAS_HEIGHT,
                pointerEvents: 'none',
                zIndex: 100
              }}
            />
          </div>
        </div>
      </div>

      {/* Instrument Selector Modal */}
      <InstrumentSelector
        isOpen={showInstrumentSelector}
        onClose={() => setShowInstrumentSelector(false)}
        onSelectInstrument={onInstrumentChange}
        currentInstrument={selectedInstrument}
        isLoadingInstrument={instrumentLoading}
      />

      {/* VST Selector Modal */}
      {showVSTSelector && (
        <VSTSelector
          trackId={trackId}
          currentVSTPath={selectedInstrument?.vstPath}
          useVSTBackend={useVSTBackend}
          onVSTLoaded={(path) => {
            // Thoroughly unload SF2 instrument before switching to VST
            if (spessaInstrument) {
              try {
                // Stop all notes
                spessaInstrument.stopAll()
                // Stop the instrument
                if (spessaInstrument.stop) spessaInstrument.stop()
                // Disconnect the synth from audio chain
                if (spessaInstrument.synth) {
                  spessaInstrument.synth.disconnect()
                }
              } catch (e) {
                console.error('Error cleaning up SF2:', e)
              }
            }
            // Clear SF2 state completely
            setSpessaInstrument(null)
            spessaInstrumentRef.current = null
            setInstrumentLoading(false)
            
            // Update ref immediately for instant routing switch
            useVSTBackendRef.current = true
            // Update state to trigger parent re-render with new useVSTBackend prop
            if (onVSTModeChange) {
              onVSTModeChange(true)
            }
            // Store VST path in selected instrument for reference
            if (onInstrumentChange) {
              onInstrumentChange({ ...selectedInstrument, vstPath: path })
            }
            console.log('VST loaded for track', trackId, 'from:', path)
          }}
          onVSTUnloaded={() => {
            // Update ref immediately
            useVSTBackendRef.current = false
            if (onVSTModeChange) onVSTModeChange(false)
            // Clear VST path from instrument
            if (onInstrumentChange && selectedInstrument) {
              const { vstPath, ...rest } = selectedInstrument
              onInstrumentChange(rest)
            }
            console.log('VST unloaded for track', trackId)
          }}
          onClose={() => setShowVSTSelector(false)}
        />
      )}
    </div>
  )
}

export default PianoRoll
