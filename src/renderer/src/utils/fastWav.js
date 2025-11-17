// Minimal WAV encoder wrapper using our PCM16 path only.
// Removed optional spessasynth_lib audioToWav usage to avoid build-time export errors.
//
// API:
//   encodeToWav({ channels: Float32Array[], sampleRate: number }): Uint8Array

import { interleave, encodeWavPCM16 } from './wavEncoder'

export function encodeToWav({ channels, sampleRate }) {
  const numChannels = Math.max(1, (channels && channels.length) || 0)
  if (numChannels === 0) {
    // Empty WAV
    return encodeWavPCM16({ samples: new Float32Array(), sampleRate: sampleRate || 44100, numChannels: 1 })
  }
  // Encode using our PCM16 encoder
  const inter = interleave(channels)
  return encodeWavPCM16({ samples: inter, sampleRate, numChannels })
}

export default { encodeToWav }
