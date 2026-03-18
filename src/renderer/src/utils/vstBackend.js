// Helpers to play notes via the JUCE backend hosting VSTs

let backendReady = false
let backendEventUnsubscribe = null
const trackVSTPaths = new Map()
const pendingVSTRecoveries = new Set()
const readyVSTTracks = new Set()
const pendingVSTRecoveryPromises = new Map()

function waitForTrackLoadEvent(trackId, timeoutMs = 20000) {
  const id = String(trackId)

  return new Promise((resolve, reject) => {
    let unsubscribe = null
    const timeout = setTimeout(() => {
      if (unsubscribe) unsubscribe()
      reject(new Error(`timeout waiting for VST READY on track ${id}`))
    }, timeoutMs)

    unsubscribe = window.api.backend.onEvent((line) => {
      if (line.startsWith(`EVENT READY ${id} `)) {
        clearTimeout(timeout)
        if (unsubscribe) unsubscribe()
        resolve({ ok: true, line })
        return
      }

      if (line.startsWith(`ERROR LOAD ${id} `)) {
        clearTimeout(timeout)
        if (unsubscribe) unsubscribe()
        resolve({ ok: false, line })
      }
    })
  })
}

async function recoverVSTTrack(trackId) {
  const id = String(trackId)
  const pluginPath = trackVSTPaths.get(id)
  if (!pluginPath) return false
  if (pendingVSTRecoveryPromises.has(id)) return pendingVSTRecoveryPromises.get(id)
  if (pendingVSTRecoveries.has(id)) return false

  pendingVSTRecoveries.add(id)
  readyVSTTracks.delete(id)

  const recoveryPromise = (async () => {
    try {
      console.warn(`[Backend] Auto-recovering VST track ${id} after no-plugin-loaded`)
      const ok = await loadVST(id, pluginPath)
      return !!ok
    } catch (e) {
      console.error(`[Backend] VST auto-recovery failed for track ${id}:`, e)
      return false
    } finally {
      pendingVSTRecoveries.delete(id)
      pendingVSTRecoveryPromises.delete(id)
    }
  })()

  pendingVSTRecoveryPromises.set(id, recoveryPromise)
  return recoveryPromise
}

async function ensureVSTTrackReady(trackId) {
  const id = String(trackId)
  if (readyVSTTracks.has(id)) return true

  const pending = pendingVSTRecoveryPromises.get(id)
  if (pending) {
    try {
      return !!(await pending)
    } catch {
      return false
    }
  }

  if (!trackVSTPaths.has(id)) return false
  return !!(await recoverVSTTrack(id))
}

// Initialize backend listener for event stream
export function initBackend() {
  if (backendEventUnsubscribe) return
  
  backendEventUnsubscribe = window.api.backend.onEvent((line) => {
    if (line.startsWith('EVENT READY')) {
      backendReady = true
      const parts = line.split(' ')
      if (parts.length >= 3) {
        const trackId = parts[2]
        readyVSTTracks.add(String(trackId))
        console.log(`[Backend] Track ${trackId} marked ready`)
      }
    } else if (line.startsWith('EVENT LOADED')) {
      backendReady = true
    } else if (line.startsWith('EVENT READY_SF2') || line.startsWith('EVENT LOADED_SF2')) {
      backendReady = true
    } else if (line.startsWith('EVENT EXIT')) {
      // Backend process restarted or exited: runtime plugin state is gone.
      readyVSTTracks.clear()
      console.warn('[Backend] Backend exited; all VST tracks cleared from readiness')
    } else if (line.startsWith('ERROR')) {
      // ERROR GET_STATE is an expected probe response (used to detect unloaded plugins), not a real error
      if (!line.includes('ERROR GET_STATE')) {
        console.error('[Backend]', line)

        // If backend lost track plugin state (e.g. after process restart), auto-reload known VST once.
        const parts = line.split(' ')
        if (parts.length >= 4 && parts[0] === 'ERROR' && (parts[1] === 'NOTE' || parts[1] === 'VOLUME') && parts[3] === 'no-plugin-loaded') {
          const trackId = parts[2]
          console.warn(`[Backend] Detected no-plugin-loaded for track ${trackId}, initiating recovery`)
          readyVSTTracks.delete(String(trackId))
          // Use concurrency control via the promise map - if recovery is in flight, this will return that promise
          void recoverVSTTrack(trackId)
        }
      }
    }
  })
}

// Load a VST plugin by absolute path for a specific track
export async function loadVST(trackId, pluginPath) {
  try {
    const id = String(trackId)
    const readyPromise = waitForTrackLoadEvent(id, 20000)
    const res = await window.api.backend.loadVST(id, pluginPath)
    if (!res.ok) {
      console.error(`Failed to load VST for track ${trackId}:`, res.error)
      return false
    }

    const readyResult = await readyPromise
    if (!readyResult.ok) {
      console.error(`Backend reported VST load error for track ${trackId}:`, readyResult.line)
      readyVSTTracks.delete(id)
      return false
    }

    trackVSTPaths.set(id, pluginPath)
    readyVSTTracks.add(id)
    backendReady = true
    
    // Set initial volume to 32 (50% of center 64 for reduced VST loudness)
    try {
      await window.api.backend.setVolume(id, 32, 1)
    } catch (e) {
      console.warn(`Failed to set initial volume for track ${trackId}:`, e)
    }
    
    return true
  } catch (e) {
    readyVSTTracks.delete(String(trackId))
    console.error(`Error loading VST for track ${trackId}:`, e)
    return false
  }
}

// Register a VST path for a track so backend auto-recovery can reload it if backend state is lost.
export function registerVSTTrackPath(trackId, pluginPath) {
  const id = String(trackId)
  if (!pluginPath || typeof pluginPath !== 'string') return
  trackVSTPaths.set(id, pluginPath)
}

// Forget a VST path registration (e.g. when switching away from VST on a track).
export function unregisterVSTTrackPath(trackId) {
  const id = String(trackId)
  trackVSTPaths.delete(id)
  readyVSTTracks.delete(id)
  pendingVSTRecoveries.delete(id)
  pendingVSTRecoveryPromises.delete(id)
}

// Load an SF2 SoundFont from resources for a specific track
export async function loadSF2(trackId, relativePath, bank = 0, preset = 0) {
  try {
    const res = await window.api.backend.loadSF2(String(trackId), relativePath)
    if (!res.ok) {
      console.error(`Failed to load SF2 for track ${trackId}:`, res.error)
      return false
    }
    backendReady = true
    
    // Set the preset (bank and preset number)
    try {
      await window.api.backend.setSF2Preset(String(trackId), bank, preset)
    } catch (e) {
      console.warn(`Failed to set SF2 preset for track ${trackId}:`, e)
    }
    
    return true
  } catch (e) {
    console.error(`Error loading SF2 for track ${trackId}:`, e)
    return false
  }
}

// Set SF2 preset for a specific track
export async function setSF2Preset(trackId, bank, preset) {
  try {
    const res = await window.api.backend.setSF2Preset(String(trackId), bank, preset)
    if (!res.ok) {
      console.error(`Failed to set SF2 preset for track ${trackId}:`, res.error)
      return false
    }
    return true
  } catch (e) {
    console.error(`Error setting SF2 preset for track ${trackId}:`, e)
    return false
  }
}

// Unload VST plugin for a specific track (frontend-only, closes editor)
export async function unloadVST(trackId) {
  try {
    unregisterVSTTrackPath(trackId)
    // Just close the editor window - no need to send command to backend
    // The frontend will handle state updates (useVSTBackend flag)
    await closeVSTEditor(trackId)
    return true
  } catch (e) {
    console.error(`Error unloading VST for track ${trackId}:`, e)
    return false
  }
}

// Play a note via the backend (trackId, note, velocity, durationMs, channel)
// Returns immediately; note plays asynchronously in the backend
export async function playBackendNote(trackId, midiNote, velocity = 0.8, durationMs = 500, channel = 1) {
  if (!backendReady) {
    console.warn('Backend not ready; skipping note')
    return false
  }
  
  try {
    const id = String(trackId)

    // For known VST tracks, ensure readiness before sending note.
    // Even if the track is marked ready, we need to gate on recovery if it's in-flight.
    if (trackVSTPaths.has(id)) {
      // If pending recovery exists for this track, wait for it (recovery may have been triggered by a previous error)
      const pending = pendingVSTRecoveryPromises.get(id)
      if (pending) {
        console.log(`[VST] Waiting for recovery to complete for track ${id}...`)
        const recovered = await pending
        if (!recovered) {
          console.warn(`Backend VST track ${id} recovery failed; skipping note send`)
          return false
        }
        console.log(`[VST] Recovery completed for track ${id}, sending note`)
      } else if (!readyVSTTracks.has(id)) {
        // If no recovery is pending but track is not ready, trigger recovery
        const recovered = await ensureVSTTrackReady(id)
        if (!recovered) {
          console.warn(`Backend VST track ${id} not ready; skipping note send`)
          return false
        }
      }
    }

    const res = await window.api.backend.noteOn({ 
      trackId: id,
      note: midiNote, 
      velocity, 
      durationMs, 
      channel 
    })
    if (!res.ok) {
      console.error(`Backend note failed for track ${trackId}:`, res.error)
      return false
    }
    return true
  } catch (e) {
    console.error(`Error playing backend note for track ${trackId}:`, e)
    return false
  }
}

// All notes off (panic) for a specific track or all tracks
export async function backendPanic(trackId = '') {
  try {
    await window.api.backend.panic(trackId)
  } catch (e) {
    console.error('Backend panic failed:', e)
  }
}

// Check backend status
export async function backendStatus() {
  try {
    const res = await window.api.backend.status()
    return res
  } catch (e) {
    console.error('Backend status failed:', e)
    return { ok: false }
  }
}

// Open the VST plugin's native editor window for a specific track
export async function openVSTEditor(trackId) {
  try {
    const res = await window.api.backend.openEditor(String(trackId))
    if (!res.ok) {
      console.error(`Failed to open VST editor for track ${trackId}:`, res.error)
      return false
    }
    return true
  } catch (e) {
    console.error(`Error opening VST editor for track ${trackId}:`, e)
    return false
  }
}

// Close the VST editor window for a specific track
export async function closeVSTEditor(trackId) {
  try {
    await window.api.backend.closeEditor(String(trackId))
    return true
  } catch (e) {
    console.error(`Error closing VST editor for track ${trackId}:`, e)
    return false
  }
}

// Convert note name like "C4" to MIDI note number (middle C = 60)
export function noteNameToMidi(noteName) {
  const noteMap = {
    C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5,
    'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11
  }
  const note = noteName.slice(0, -1)
  const octave = parseInt(noteName.slice(-1))
  return (octave + 1) * 12 + noteMap[note]
}

// Load a sample into the sampler for a specific track
export async function loadSamplerSample(trackId, filePath) {
  try {
    const res = await window.api.backend.loadSamplerSample(String(trackId), filePath)
    if (!res.ok) {
      console.error(`Failed to load sampler sample for track ${trackId}:`, res.error)
      return false
    }
    return true
  } catch (e) {
    console.error(`Error loading sampler sample for track ${trackId}:`, e)
    return false
  }
}

// Trigger a sampler note with pitch shifting
export async function playSamplerNote(trackId, midiNote, velocity = 0.8, durationMs = 0) {
  try {
    const res = await window.api.backend.triggerSampler(String(trackId), midiNote, velocity, durationMs)
    if (!res.ok) {
      console.error(`Failed to trigger sampler note for track ${trackId}:`, res.error)
      return false
    }
    return true
  } catch (e) {
    console.error(`Error triggering sampler note for track ${trackId}:`, e)
    return false
  }
}

// Stop a specific note in the sampler
export async function stopSamplerNote(trackId, midiNote) {
  try {
    const res = await window.api.backend.stopSamplerNote(String(trackId), midiNote)
    if (!res.ok) {
      console.error(`Failed to stop sampler note for track ${trackId}:`, res.error)
      return false
    }
    return true
  } catch (e) {
    console.error(`Error stopping sampler note for track ${trackId}:`, e)
    return false
  }
}

// Clear all samples and voices for a sampler track
export async function clearSamplerTrack(trackId) {
  try {
    const res = await window.api.backend.clearSampler(String(trackId))
    if (!res.ok) {
      console.error(`Failed to clear sampler track ${trackId}:`, res.error)
      return false
    }
    return true
  } catch (e) {
    console.error(`Error clearing sampler track ${trackId}:`, e)
    return false
  }
}

// Cleanup
export function cleanupBackend() {
  if (backendEventUnsubscribe) {
    backendEventUnsubscribe()
    backendEventUnsubscribe = null
  }
}
