// Simple WAV encoder for Float32 PCM to 16-bit PCM WAV
// Exports:
// - interleave(channels: Float32Array[]): Float32Array
// - encodeWavPCM16({ samples: Float32Array, sampleRate: number, numChannels: number }): Uint8Array

function clampTo16Bit(n) {
	// Clamp to [-1, 1] and convert to 16-bit signed int
	const x = Math.max(-1, Math.min(1, n))
	return x < 0 ? x * 0x8000 : x * 0x7fff
}

export function interleave(channels) {
	if (!channels || channels.length === 0) return new Float32Array()
	if (channels.length === 1) return channels[0]

	const length = channels[0].length
	const numChannels = channels.length
	const out = new Float32Array(length * numChannels)
	let offset = 0
	for (let i = 0; i < length; i++) {
		for (let c = 0; c < numChannels; c++) {
			out[offset++] = channels[c][i] || 0
		}
	}
	return out
}

export function encodeWavPCM16({ samples, sampleRate, numChannels }) {
	// samples: interleaved Float32
	const bytesPerSample = 2
	const blockAlign = numChannels * bytesPerSample
	const byteRate = sampleRate * blockAlign
	const dataSize = samples.length * bytesPerSample
	const buffer = new ArrayBuffer(44 + dataSize)
	const view = new DataView(buffer)

	// RIFF header
	writeString(view, 0, 'RIFF')
	view.setUint32(4, 36 + dataSize, true)
	writeString(view, 8, 'WAVE')

	// fmt chunk
	writeString(view, 12, 'fmt ')
	view.setUint32(16, 16, true) // PCM chunk size
	view.setUint16(20, 1, true) // audio format PCM
	view.setUint16(22, numChannels, true)
	view.setUint32(24, sampleRate, true)
	view.setUint32(28, byteRate, true)
	view.setUint16(32, blockAlign, true)
	view.setUint16(34, 16, true) // bits per sample

	// data chunk
	writeString(view, 36, 'data')
	view.setUint32(40, dataSize, true)

	// PCM samples
	let offset = 44
	for (let i = 0; i < samples.length; i++) {
		const s = clampTo16Bit(samples[i])
		view.setInt16(offset, s, true)
		offset += 2
	}

	return new Uint8Array(buffer)
}

function writeString(view, offset, str) {
	for (let i = 0; i < str.length; i++) {
		view.setUint8(offset + i, str.charCodeAt(i))
	}
}

export default { interleave, encodeWavPCM16 }
