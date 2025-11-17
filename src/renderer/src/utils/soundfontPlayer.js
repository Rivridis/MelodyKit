// SoundFont Player Utility using soundfont-player library
import Soundfont from 'soundfont-player'

// Cache for loaded instruments
const instrumentCache = new Map()

// Map file names to soundfont-player instrument names
const instrumentNameMap = {
  'piano': 'acoustic_grand_piano',
  'guitar': 'acoustic_guitar_nylon',
  'bass': 'acoustic_bass',
  'drum': 'synth_drum',
  'violin': 'violin',
  'trumpet': 'trumpet',
  'flute': 'flute',
  'organ': 'church_organ',
  'synth': 'lead_1_square'
}

/**
 * Get instrument name from file path
 * @param {string} filePath - Path to the file
 * @returns {string} - Instrument name for soundfont-player
 */ 
function getInstrumentName(filePath) {
  const fileName = filePath.toLowerCase()
  
  // Try to match known instrument names
  for (const [key, value] of Object.entries(instrumentNameMap)) {
    if (fileName.includes(key)) {
      return value
    }
  }
  
  // Default to acoustic grand piano
  return 'acoustic_grand_piano'
}

/**
 * Load a SoundFont file and create an instrument player
 * @param {string} soundfontPath - Path to the .sf2 file or instrument name
 * @param {AudioContext} audioContext - Web Audio API context
 * @returns {Promise<Object>} - Instrument player object
 */
export async function loadSoundFont(soundfontPath, audioContext) {
  try {
    // Check cache first
    if (instrumentCache.has(soundfontPath)) {
      console.log('Using cached instrument:', soundfontPath)
      return instrumentCache.get(soundfontPath)
    }

    console.log('Loading SoundFont from CDN:', soundfontPath)
    
    // Get the appropriate instrument name
    const instrumentName = getInstrumentName(soundfontPath)
    console.log('Using instrument:', instrumentName)
    
    // Load from CDN (soundfont-player has built-in high-quality soundfonts)
    // Important: Don't pass destination here - we'll handle routing in playNote
    const instrument = await Soundfont.instrument(audioContext, instrumentName, {
      soundfont: 'MusyngKite', // High quality soundfont from CDN
      // Use FluidR3_GM for more instruments: 'FluidR3_GM'
      // Don't connect to destination automatically
      gain: 1.0
    })
    
    // Cache the loaded instrument
    instrumentCache.set(soundfontPath, instrument)
    
    console.log('SoundFont loaded successfully:', instrumentName)
    return instrument
  } catch (error) {
    console.error('Failed to load SoundFont:', error)
    
    // Fallback to default piano
    console.log('Falling back to acoustic_grand_piano...')
    try {
      const instrument = await Soundfont.instrument(audioContext, 'acoustic_grand_piano')
      instrumentCache.set(soundfontPath, instrument)
      return instrument
    } catch (fallbackError) {
      console.error('Fallback also failed:', fallbackError)
      throw error
    }
  }
}

/**
 * Play a note from the loaded SoundFont
 * @param {Object} instrument - Loaded soundfont-player instrument
 * @param {string} noteName - Note to play (e.g., "C4", "A#5")
 * @param {number} duration - Duration in seconds
 * @param {AudioNode} destination - Audio destination (master gain or audio context destination) - UNUSED, kept for compatibility
 * @param {number} volume - Volume (0-1)
 * @returns {Object} - Audio node for cleanup
 */
export function playSoundFontNote(instrument, noteName, duration, destination, volume = 0.5) {
  if (!instrument || !instrument.play) {
    console.warn('Invalid instrument', instrument)
    return null
  }
  
  try {
    console.log(`Playing SoundFont note: ${noteName}, duration: ${duration}s, volume: ${volume}`)
    
    // soundfont-player uses note names like "C4", "A#5"
    // The library handles audio routing internally and connects to the audioContext.destination
    // We use when=0 to play immediately, or use audioContext.currentTime for precise timing
    const audioNode = instrument.play(noteName, 0, {
      duration: duration,
      gain: volume
    })
    
    console.log('SoundFont note triggered:', audioNode)
    
    // Return a compatible object for cleanup
    return {
      source: audioNode,
      gain: null,
      stop: () => {
        if (audioNode && audioNode.stop) {
          try {
            audioNode.stop()
          } catch (e) {
            // Already stopped
          }
        }
      }
    }
  } catch (error) {
    console.error('Error playing SoundFont note:', error)
    return null
  }
}

/**
 * Stop all playing notes
 * @param {Array} activeSources - Array of active source objects
 */
export function stopAllNotes(activeSources) {
  activeSources.forEach(sourceObj => {
    try {
      if (sourceObj && sourceObj.stop) {
        sourceObj.stop()
      } else if (sourceObj && sourceObj.source && sourceObj.source.stop) {
        sourceObj.source.stop()
      }
    } catch (e) {
      // Already stopped
    }
  })
  activeSources.length = 0
}

/**
 * Clear the instrument cache
 */
export function clearInstrumentCache() {
  instrumentCache.clear()
}
