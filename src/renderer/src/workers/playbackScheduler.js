/*
  Playback scheduler worker
  - Runs a lookahead timer to batch upcoming note events based on BPM and current beat
  - Posts messages to main thread with absolute audioTime for each note
*/

let bpm = 120
let startBeat = 0
let lookaheadSec = 0.35
let tickSec = 0.05
let maxEndBeat = null
let notes = [] // {id, note, start, duration}
let nextIdx = 0

// Mapping to audio time
let baseAudioTime = 0 // seconds (AudioContext.currentTime at start)
let basePerfTime = 0   // ms (performance.now at start)

let timerId = null
let frontierBeat = 0
let ended = false

function beatsPerSecond() {
  return bpm / 60
}

function beatToAudioTime(beat) {
  const deltaBeats = beat - startBeat
  const deltaSec = deltaBeats / beatsPerSecond() // beats * (60/bpm)
  return baseAudioTime + deltaSec
}

function currentBeatByPerf() {
  const nowMs = performance.now()
  const deltaSec = Math.max(0, (nowMs - basePerfTime) / 1000)
  return startBeat + deltaSec * beatsPerSecond()
}

function scheduleTick() {
  if (ended) return
  const nowBeat = currentBeatByPerf()
  const horizonBeat = nowBeat + lookaheadSec * beatsPerSecond()
  const stopBeat = (typeof maxEndBeat === 'number') ? maxEndBeat : Infinity
  const windowEnd = Math.min(horizonBeat, stopBeat)

  // Find notes in [frontierBeat, windowEnd]
  if (windowEnd > frontierBeat) {
    const upcoming = []
    // Advance nextIdx to the first note at or after frontierBeat
    while (nextIdx < notes.length && (notes[nextIdx].start || 0) < frontierBeat - 1e-6) {
      nextIdx++
    }
    // Collect notes up to windowEnd
    while (nextIdx < notes.length) {
      const n = notes[nextIdx]
      const s = n.start || 0
      if (s > windowEnd + 1e-6) break
      if (s >= frontierBeat - 1e-6 && s < windowEnd + 1e-6) {
        upcoming.push({
          note: n.note,
          audioTime: beatToAudioTime(s),
          durationSec: Math.max(0, (n.duration || 0) / beatsPerSecond()),
        })
      }
      nextIdx++
    }
    if (upcoming.length) {
      self.postMessage({ type: 'events', events: upcoming })
    }
    frontierBeat = windowEnd
  }

  // Stop if done
  if (nowBeat >= stopBeat - 1e-4) {
    ended = true
    clearInterval(timerId)
    timerId = null
    self.postMessage({ type: 'ended' })
    return
  }
}

self.onmessage = (e) => {
  const { type } = e.data || {}
  if (type === 'init') {
    bpm = e.data.bpm || 120
    startBeat = e.data.startBeat || 0
    notes = Array.isArray(e.data.notes) ? e.data.notes.slice() : []
    // Sort notes by start time to enable linear scheduling
    notes.sort((a, b) => (a.start || 0) - (b.start || 0))
    lookaheadSec = typeof e.data.lookaheadSec === 'number' ? e.data.lookaheadSec : 0.35
    tickSec = typeof e.data.tickSec === 'number' ? e.data.tickSec : 0.05
    maxEndBeat = (typeof e.data.maxEndBeat === 'number') ? e.data.maxEndBeat : null
  baseAudioTime = e.data.baseAudioTime || 0
  // Use worker's own clock to avoid cross-context time origin mismatch
  basePerfTime = performance.now()
    frontierBeat = startBeat
    nextIdx = 0
    ended = false
    // No timer yet; wait for 'start'
  } else if (type === 'start') {
    if (timerId) clearInterval(timerId)
    timerId = setInterval(scheduleTick, Math.max(10, Math.floor(tickSec * 1000)))
  } else if (type === 'stop') {
    if (timerId) clearInterval(timerId)
    timerId = null
    ended = true
  } else if (type === 'updateBpm') {
    bpm = e.data.bpm || bpm
  } else if (type === 'seek') {
    startBeat = e.data.startBeat || startBeat
    baseAudioTime = e.data.baseAudioTime || baseAudioTime
    // Reset to worker clock now
    basePerfTime = performance.now()
    frontierBeat = startBeat
    // Reset index to first note at or after new start
    nextIdx = 0
    while (nextIdx < notes.length && (notes[nextIdx].start || 0) < startBeat - 1e-6) {
      nextIdx++
    }
    ended = false
  }
}

try { self.postMessage({ type: 'ready' }) } catch {}
