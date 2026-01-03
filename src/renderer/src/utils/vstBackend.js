// Helpers to play notes via the JUCE backend hosting VSTs

let backendReady = false
let backendEventUnsubscribe = null

// Initialize backend listener for event stream
export function initBackend() {
  if (backendEventUnsubscribe) return
  
  backendEventUnsubscribe = window.api.backend.onEvent((line) => {
    if (line.startsWith('EVENT READY')) {
      backendReady = true
    } else if (line.startsWith('EVENT LOADED')) {
      backendReady = true
    } else if (line.startsWith('EVENT READY_SF2') || line.startsWith('EVENT LOADED_SF2')) {
      backendReady = true
    } else if (line.startsWith('ERROR')) {
      console.error('[Backend]', line)
    }
  })
}

// Load a VST plugin by absolute path for a specific track
export async function loadVST(trackId, pluginPath) {
  try {
    const res = await window.api.backend.loadVST(String(trackId), pluginPath)
    if (!res.ok) {
      console.error(`Failed to load VST for track ${trackId}:`, res.error)
      return false
    }
    backendReady = true
    
    // Set initial volume to 32 (50% of center 64 for reduced VST loudness)
    try {
      await window.api.backend.setVolume(String(trackId), 32, 1)
    } catch (e) {
      console.warn(`Failed to set initial volume for track ${trackId}:`, e)
    }
    
    return true
  } catch (e) {
    console.error(`Error loading VST for track ${trackId}:`, e)
    return false
  }
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
    const res = await window.api.backend.noteOn({ 
      trackId: String(trackId),
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
