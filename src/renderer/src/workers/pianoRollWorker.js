/*
  Piano Roll drawing worker using OffscreenCanvas to offload heavy painting
  from the main thread. It mirrors the drawMainCanvas logic in PianoRoll.jsx
  and draws only the visible horizontal region.
*/

// Constants should match the renderer component
const BEAT_WIDTH = 40; // px
const NOTE_HEIGHT = 20; // px
const TIMELINE_HEIGHT = 24; // not used here

// Build the same piano notes list as in the renderer
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const OCTAVES = [2, 3, 4, 5, 6, 7]
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
const noteIndexMap = pianoNotes.reduce((acc, n, i) => { acc[n] = i; return acc }, {})

// Worker-local state
let ctx = null
let offscreenCanvas = null
let canvasWidthCSS = 0
let canvasHeightCSS = pianoNotes.length * NOTE_HEIGHT
let dpr = 1
let gridWidth = 32
let gridDivision = 4
let trackColor = '#3b82f6'
let notes = []
let hiddenNoteIds = []
let selectedNoteIds = []

// Notify main thread that worker booted successfully so it can safely transfer the canvas
try { self.postMessage({ type: 'ready' }) } catch {}

// Utility
function clearRegion(x, y, w, h) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(x, y, w, h)
}

function ensureSize(offscreen, widthCSS, heightCSS) {
  const w = Math.max(1, Math.floor(widthCSS * dpr))
  const h = Math.max(1, Math.floor(heightCSS * dpr))
  if (offscreen.width !== w || offscreen.height !== h) {
    offscreen.width = w
    offscreen.height = h
  }
}

function drawVisibleSlice(scrollLeft, clientWidth) {
  if (!ctx) return
  const vLeft = scrollLeft | 0
  const vWidth = clientWidth | 0
  const vx1 = Math.max(0, vLeft)
  const vx2 = Math.min(gridWidth * BEAT_WIDTH + 80, vLeft + vWidth)
  const vw = Math.max(0, vx2 - vx1)
  if (vw <= 0) return

  // Clear only visible slice
  clearRegion(vx1, 0, vw, canvasHeightCSS)

  // Determine visible beats (+margin)
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
    ctx.strokeStyle = '#5a606f'
    ctx.lineWidth = i % 4 === 0 ? 2 : 1
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, canvasHeightCSS)
    ctx.stroke()
  }

  // Subdivision lines
  const subdivisionsPerBeat = gridDivision / 4
  for (let i = startI; i < endI; i++) {
    const baseX = 80 + i * BEAT_WIDTH
    for (let j = 1; j < subdivisionsPerBeat; j++) {
      const x = baseX + (j * BEAT_WIDTH / subdivisionsPerBeat)
      if (x < vx1 - 1 || x > vx2 + 1) continue
      ctx.strokeStyle = '#5a606f'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, canvasHeightCSS)
      ctx.stroke()
    }
  }

  // Notes
  const hiddenSet = new Set(hiddenNoteIds)
  const selSet = new Set(selectedNoteIds)
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]
    if (hiddenSet.has(n.id)) continue
    const idx = noteIndexMap[n.note]
    if (idx === -1 || idx === undefined) continue
    const noteStartX = 80 + n.start * BEAT_WIDTH
    const noteEndX = noteStartX + n.duration * BEAT_WIDTH
    if (noteEndX < vx1 || noteStartX > vx2) continue
    const y = idx * NOTE_HEIGHT
    const isSelected = selSet.has(n.id)
    const colorWithOpacity = isSelected ? trackColor + 'FF' : trackColor + 'E8'
    ctx.fillStyle = colorWithOpacity
    ctx.strokeStyle = isSelected ? '#ffffff' : trackColor
    ctx.lineWidth = isSelected ? 3 : 2
    ctx.beginPath()
    // roundRect may not exist in some contexts; fallback if needed
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(noteStartX, y + 2, Math.max(1, n.duration * BEAT_WIDTH), NOTE_HEIGHT - 4, 6)
    } else {
      ctx.rect(noteStartX, y + 2, Math.max(1, n.duration * BEAT_WIDTH), NOTE_HEIGHT - 4)
    }
    ctx.fill()
    ctx.stroke()
    // Thin resize line
    const lineX = noteEndX - 1 - 1
    const lineY = y + 6
    ctx.fillStyle = 'rgba(255, 245, 157, 0.95)'
    ctx.fillRect(lineX, lineY, 1, NOTE_HEIGHT - 12)
  }
}

self.onmessage = (evt) => {
  const { type } = evt.data || {}
  if (type === 'init') {
    const { canvas, widthCSS, heightCSS, devicePixelRatio } = evt.data
    dpr = devicePixelRatio || 1
    canvasWidthCSS = widthCSS
    canvasHeightCSS = heightCSS
    offscreenCanvas = canvas
    ensureSize(offscreenCanvas, widthCSS, heightCSS)
    ctx = offscreenCanvas.getContext('2d')
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'low'
    }
  } else if (type === 'setState') {
    if (typeof evt.data.gridWidth === 'number') gridWidth = evt.data.gridWidth
    if (typeof evt.data.gridDivision === 'number') gridDivision = evt.data.gridDivision
    if (typeof evt.data.trackColor === 'string') trackColor = evt.data.trackColor
    if (Array.isArray(evt.data.notes)) notes = evt.data.notes
    if (Array.isArray(evt.data.hiddenNoteIds)) hiddenNoteIds = evt.data.hiddenNoteIds
    if (Array.isArray(evt.data.selectedNoteIds)) selectedNoteIds = evt.data.selectedNoteIds
  } else if (type === 'resize') {
    // Resize offscreen backing store when gridWidth/viewport changes
    if (typeof evt.data.widthCSS === 'number' && typeof evt.data.heightCSS === 'number') {
      canvasWidthCSS = evt.data.widthCSS
      canvasHeightCSS = evt.data.heightCSS
      if (typeof evt.data.devicePixelRatio === 'number' && evt.data.devicePixelRatio > 0) {
        dpr = evt.data.devicePixelRatio
      }
      if (offscreenCanvas) {
        ensureSize(offscreenCanvas, canvasWidthCSS, canvasHeightCSS)
      }
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
    }
  } else if (type === 'draw') {
    drawVisibleSlice(evt.data.scrollLeft || 0, evt.data.clientWidth || 0)
  }
}
