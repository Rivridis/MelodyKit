// SF2 loader and simple note player using spessasynth_lib (WorkerSynthesizer)
import { WorkerSynthesizer } from 'spessasynth_lib'

// Per-AudioContext caches to avoid re-registering worklets and reloading banks unnecessarily
const contextInitCache = new WeakSet() // AudioContext -> initialized flag
const contextInitPromises = new WeakMap() // AudioContext -> in-flight Promise
const synthCacheByContext = new WeakMap() // AudioContext -> Map(samplePath -> Synth)
// IMPORTANT: Cache immutable Uint8Array copies (not ArrayBuffer) so we can clone per use.
const fileBytesCache = new Map() // samplePath -> Uint8Array (immutable source bytes)

function normalizeToImmutableU8(bytes) {
  // Returns a fresh Uint8Array that won't be transferred; safe to clone per use
  if (bytes instanceof ArrayBuffer) {
    // Make an immutable copy
    const copy = new Uint8Array(bytes)
    return copy.slice() // force new backing buffer
  }
  if (ArrayBuffer.isView(bytes)) {
    const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return view.slice() // new backing buffer
  }
  if (Array.isArray(bytes)) {
    const u8 = Uint8Array.from(bytes)
    return u8 // already a fresh copy
  }
  throw new Error('Unsupported bytes format for SF2 file')
}

// Convert note name like C4, A#3 to MIDI number (0-127)
function noteNameToMidi(noteName) {
  const map = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 }
  const m = /^([A-Ga-g])(#|b)?(\d+)$/.exec(String(noteName))
  if (!m) return 60
  const letter = m[1].toUpperCase()
  const accidental = m[2] || ''
  const octave = parseInt(m[3], 10)
  const semitone = map[letter + accidental]
  return Math.max(0, Math.min(127, (octave + 1) * 12 + semitone))
}

/**
 * Load an SF2 instrument using spessasynth_lib WorkerSynthesizer.
 * - samplePath: relative path under resources, e.g. "Piano/Grand Piano.sf2"
 * - audioContext: Web Audio context to bind the synth to
 * - destination: optional AudioNode to connect to (per-track gain or master)
 *
 * Returns a synth handle with a stop() convenience and passthrough to synth instance.
 */
export async function loadSf2Instrument(samplePath, audioContext, destination) {
  if (!samplePath || !samplePath.endsWith('.sf2')) {
    throw new Error('loadSf2Instrument expects a .sf2 samplePath')
  }
  if (!audioContext) {
    throw new Error('audioContext is required')
  }

  // Context-local cache
  let map = synthCacheByContext.get(audioContext)
  if (!map) { map = new Map(); synthCacheByContext.set(audioContext, map) }
  // Only reuse cached synths when no explicit destination is requested (shared preview usage)
  if (!destination && map.has(samplePath)) {
    const cached = map.get(samplePath)
    // Ensure routing is connected to latest destination
    try {
      // For preview, ensure it's connected to context destination
      try { cached.synth.disconnect() } catch {}
      cached.synth.connect(audioContext.destination)
    } catch {}
    return cached
  }

  // Ensure context is active (some browsers/Electron require user gesture for audio resume)
  try { if (audioContext.state === 'suspended') await audioContext.resume() } catch {}
  // Register the playback worklet once per context (WorkerSynth needs this too).
  // Guard against race conditions (StrictMode double-invoke) with an in-flight promise.
  if (!contextInitCache.has(audioContext)) {
    let p = contextInitPromises.get(audioContext)
    if (!p) {
      p = (async () => {
        try {
          await WorkerSynthesizer.registerPlaybackWorklet(audioContext)
        } catch (e) {
          // If already registered, ignore NotSupportedError
          const msg = (e && (e.message || e.toString())) || ''
          if (!/already registered/i.test(msg)) {
            throw e
          }
        } finally {
          contextInitCache.add(audioContext)
          contextInitPromises.delete(audioContext)
        }
      })()
      contextInitPromises.set(audioContext, p)
    }
    await p
  }

  // Fetch SF2 bytes via IPC and cache as immutable Uint8Array
  let cachedU8 = fileBytesCache.get(samplePath)
  if (!cachedU8) {
    const bytes = await window.api.getResourcePath(samplePath)
    if (!bytes || !Array.isArray(bytes)) {
      throw new Error('Invalid IPC response for SF2 file; expected byte array')
    }
    cachedU8 = normalizeToImmutableU8(bytes)
    fileBytesCache.set(samplePath, cachedU8)
  }

  // Create worker and synth
  const worker = new Worker(new URL('./spessaWorker.js', import.meta.url), { type: 'module' })
  const synth = new WorkerSynthesizer(audioContext, worker.postMessage.bind(worker))
  worker.onmessage = (ev) => synth.handleWorkerMessage(ev.data)

  // Route to destination or audio context destination
  try {
    if (destination) synth.connect(destination)
    else synth.connect(audioContext.destination)
  } catch (e) {
    console.warn('[spessaSf2] Failed to connect synth to destination:', e)
  }

  // Wait for synth to be ready and load the sound bank
  await synth.isReady
  // Always pass a fresh ArrayBuffer copy so underlying transfer won't detach our cached bytes
  const u8ForLoad = cachedU8.slice() // clone
  await synth.soundBankManager.addSoundBank(u8ForLoad.buffer, 'main')

  // Default to program 0 (GM Acoustic Grand Piano) on channel 0; users may switch later if needed
  try { synth.programChange(0, 0) } catch {}
  // Boost channel volume/expression a bit to avoid perceived low loudness on some banks
  try {
    if (typeof synth.controlChange === 'function') {
      // CC7 = Channel Volume, CC11 = Expression
      synth.controlChange(0, 7, 110)
      synth.controlChange(0, 11, 127)
    }
  } catch {}

  const handle = {
    type: 'sf2',
    synth,
    samplePath,
    stop: (force = true) => {
      try { synth.stopAll(!!force) } catch {}
    }
  }

  // Cache only the preview synth (no destination) for reuse in other views; per-track gets its own instance
  if (!destination) {
    map.set(samplePath, handle)
  }
  return handle
}

/**
 * Best-effort retrieval of playable note range for the currently loaded SF2 preset
 * using spessasynth_lib. Returns an object { min, max } in MIDI note numbers (0-127).
 * Falls back to full range when unavailable.
 */
export async function getSf2NoteRange(samplePath, audioContext) {
  // Prefer parsing bytes locally via spessasynth_core's SoundBankLoader
  try {
    // Ensure bytes are cached
    let u8 = fileBytesCache.get(samplePath)
    if (!u8) {
      const bytes = await window.api.getResourcePath(samplePath)
      if (Array.isArray(bytes)) {
        u8 = normalizeToImmutableU8(bytes)
        fileBytesCache.set(samplePath, u8)
      }
    }
    if (!u8) return { min: 0, max: 127 }

    // Dynamic import to avoid hard dependency mismatch
    let SoundBankLoader
    try {
      const core = await import('spessasynth_core')
      SoundBankLoader = core?.SoundBankLoader
    } catch {}
    if (!SoundBankLoader) {
      try {
        const lib = await import('spessasynth_lib')
        SoundBankLoader = lib?.SoundBankLoader
      } catch {}
    }
    if (!SoundBankLoader) return { min: 0, max: 127 }

    const ab = u8.slice().buffer
    const bank = SoundBankLoader.fromArrayBuffer(ab)
    const presets = Array.isArray(bank?.presets) ? bank.presets : []
    // Try program 0 on bank 0 first
    let target = presets.find((p) => (p?.program | 0) === 0 && ((p?.bankMSB | 0) === 0)) || presets[0]

    const unionFromZones = (pres) => {
      let min = 127
      let max = 0
      const consider = (lo, hi) => {
        if (hi < lo) return
        if (lo < min) min = lo
        if (hi > max) max = hi
      }
      const clamp = (n, def) => (n == null || n < 0 ? def : n | 0)
      if (pres && Array.isArray(pres.zones)) {
        for (const pz of pres.zones) {
          const pLo = clamp(pz?.keyRange?.min, 0)
          const pHi = clamp(pz?.keyRange?.max, 127)
          const inst = pz?.instrument
          if (inst && Array.isArray(inst.zones)) {
            for (const iz of inst.zones) {
              const iLo = clamp(iz?.keyRange?.min, 0)
              const iHi = clamp(iz?.keyRange?.max, 127)
              consider(Math.max(pLo, iLo), Math.min(pHi, iHi))
            }
          } else {
            consider(pLo, pHi)
          }
        }
      }
      if (min <= max) return { min, max }
      // fallback: union across all presets
      for (const pr of presets) {
        if (!pr || !Array.isArray(pr.zones)) continue
        for (const pz of pr.zones) {
          const pLo = clamp(pz?.keyRange?.min, 0)
          const pHi = clamp(pz?.keyRange?.max, 127)
          const inst = pz?.instrument
          if (inst && Array.isArray(inst.zones)) {
            for (const iz of inst.zones) {
              const iLo = clamp(iz?.keyRange?.min, 0)
              const iHi = clamp(iz?.keyRange?.max, 127)
              consider(Math.max(pLo, iLo), Math.min(pHi, iHi))
            }
          } else {
            consider(pLo, pHi)
          }
        }
      }
      return min <= max ? { min, max } : { min: 0, max: 127 }
    }

    return unionFromZones(target)
  } catch {
    // Last resort fallback
    return { min: 0, max: 127 }
  }
}

/**
 * Extract per-key labels from an SF2 preset by parsing zones and intersecting
 * preset/instrument key ranges. Typically useful for drum kits, where each key
 * maps to a single sample (e.g., Hi-Hat, Snare, Crash).
 *
 * Returns an object { labels, isDrumLike } where:
 * - labels: Record<midiNote:number, name:string>
 * - isDrumLike: boolean heuristic (true if lots of single-key zones or path suggests drums)
 */
export async function getSf2KeyLabels(samplePath) {
  try {
    // Ensure bytes are cached
    let u8 = fileBytesCache.get(samplePath)
    if (!u8) {
      const bytes = await window.api.getResourcePath(samplePath)
      if (Array.isArray(bytes)) {
        u8 = normalizeToImmutableU8(bytes)
        fileBytesCache.set(samplePath, u8)
      }
    }
    if (!u8) return { labels: {}, isDrumLike: false }

    // Dynamic import (either package may expose SoundBankLoader)
    let SoundBankLoader
    try {
      const core = await import('spessasynth_core')
      SoundBankLoader = core?.SoundBankLoader
    } catch {}
    if (!SoundBankLoader) {
      try {
        const lib = await import('spessasynth_lib')
        SoundBankLoader = lib?.SoundBankLoader
      } catch {}
    }
    if (!SoundBankLoader) return { labels: {}, isDrumLike: false }

    const ab = u8.slice().buffer
    const bank = SoundBankLoader.fromArrayBuffer(ab)
    const presets = Array.isArray(bank?.presets) ? bank.presets : []
    if (!presets.length) return { labels: {}, isDrumLike: false }

    // Prefer percussion bank 128 if present; otherwise program 0 on bank 0; else first preset
    let target = presets.find((p) => (p?.bankMSB | 0) === 128) ||
                 presets.find((p) => (p?.program | 0) === 0 && ((p?.bankMSB | 0) === 0)) ||
                 presets[0]

    const labels = {}
    let singleKeyCount = 0
    const clamp = (n, def) => (n == null || n < 0 ? def : n | 0)
    const cleanName = (s) => {
      if (!s) return ''
      try {
        // Remove trailing nulls and common padding, replace underscores
        return String(s).replace(/\u0000+/g, '').replace(/[_]+/g, ' ').trim()
      } catch { return '' }
    }

    if (target && Array.isArray(target.zones)) {
      for (const pz of target.zones) {
        const pLo = clamp(pz?.keyRange?.min, 0)
        const pHi = clamp(pz?.keyRange?.max, 127)
        const inst = pz?.instrument
        // Try instrument-level zones when available
        if (inst && Array.isArray(inst.zones)) {
          for (const iz of inst.zones) {
            const iLo = clamp(iz?.keyRange?.min, 0)
            const iHi = clamp(iz?.keyRange?.max, 127)
            const lo = Math.max(pLo, iLo)
            const hi = Math.min(pHi, iHi)
            if (hi < lo) continue
            const sampleName = cleanName(iz?.sample?.name || iz?.sampleHeader?.name)
            const instrumentName = cleanName(inst?.name)
            const presetName = cleanName(target?.name)
            const base = sampleName || instrumentName || presetName
            if (!base) continue
            if (lo === hi) {
              labels[lo] = base
              singleKeyCount++
            } else {
              // If the zone covers a very small range (<=2), still map keys individually
              const span = hi - lo + 1
              if (span <= 2) {
                for (let k = lo; k <= hi; k++) {
                  labels[k] = base
                  singleKeyCount++
                }
              }
            }
          }
        } else {
          // No instrument ref; label the range with preset name if it's single-key
          const name = cleanName(target?.name)
          if (name && pLo === pHi) {
            labels[pLo] = name
            singleKeyCount++
          }
        }
      }
    }

    // Heuristic: consider it drum-like if many single-key zones or path indicates drums
    const pathHint = /(^|\/)drums(\/|$)/i.test(String(samplePath))
    const isDrumLike = pathHint || singleKeyCount >= 8
    return { labels, isDrumLike }
  } catch {
    return { labels: {}, isDrumLike: false }
  }
}

/**
 * Play a note on the loaded synthesizer
 * @param {object} handle - object returned by loadSf2Instrument
 * @param {string} noteName - e.g. C4, A#3
 * @param {number} duration - seconds
 * @param {number} velocity - 0-127
 */
export function playSf2Note(handle, noteName, duration = 0.3, velocity = 80) {
  if (!handle || !handle.synth) return null
  const midi = noteNameToMidi(noteName)
  const v = Math.max(1, Math.min(127, Math.floor(velocity || 80)))
  try {
    handle.synth.noteOn(0, midi, v)
    const to = setTimeout(() => {
      try { handle.synth.noteOff(0, midi) } catch {}
    }, Math.max(1, Math.floor(duration * 1000)))
    return {
      stop: () => {
        clearTimeout(to)
        try { handle.synth.noteOff(0, midi, true) } catch {}
      }
    }
  } catch (e) {
    console.error('playSf2Note error:', e)
    return null
  }
}

export function disposeSf2(samplePath) {
  // Dispose cached synths for all contexts
  synthCacheByContext.forEach((map) => {
    const h = map.get(samplePath)
    if (h) {
      try { h.stop(true) } catch {}
      try { h.synth.disconnect() } catch {}
      map.delete(samplePath)
    }
  })
}

export function clearSf2Cache() {
  synthCacheByContext.forEach((map) => {
    map.forEach((h) => { try { h.stop(true); h.synth.disconnect() } catch {} })
    map.clear()
  })
}
