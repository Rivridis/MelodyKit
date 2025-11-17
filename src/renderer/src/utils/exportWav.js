// Real-time recorder for Web Audio graph using ScriptProcessorNode
// Collects Float32 PCM from a source node and returns merged channel data

/**
 * Start recording audio from a node in the given AudioContext.
 * Returns a function to stop and resolve recorded channels.
 * @param {AudioContext} audioContext
 * @param {AudioNode} sourceNode Typically your master gain node
 * @param {object} opts
 * @param {number} opts.bufferSize ScriptProcessor buffer size (default 4096)
 * @param {number} opts.numChannels Number of channels to capture (default 2)
 */
export function startRecording(audioContext, sourceNode, opts = {}) {
	const bufferSize = opts.bufferSize || 4096
	const numChannels = opts.numChannels || 2
	if (!audioContext || !sourceNode) throw new Error('startRecording requires audioContext and sourceNode')

	const processor = audioContext.createScriptProcessor(bufferSize, numChannels, numChannels)

	// Buffers per channel
	const chunks = Array.from({ length: numChannels }, () => [])
	let recording = true

		processor.onaudioprocess = (e) => {
		if (!recording) return
		const input = e.inputBuffer
			const inCh = input.numberOfChannels
			if (inCh === 0) {
				// Nothing connected; skip this frame
			} else {
				const chCount = Math.min(numChannels, inCh)
				for (let ch = 0; ch < numChannels; ch++) {
					const data = ch < chCount ? input.getChannelData(ch).slice() : new Float32Array(bufferSize)
					chunks[ch].push(data)
				}
			}
		// Ensure processor is pulled; we do not write output to avoid audible duplication
		const output = e.outputBuffer
		for (let ch = 0; ch < output.numberOfChannels; ch++) {
			const out = output.getChannelData(ch)
			out.fill(0)
		}
	}

	// Connect to graph; connect processor to destination to get callbacks, but it outputs silence
		sourceNode.connect(processor)
	processor.connect(audioContext.destination)

	function stop() {
		return new Promise((resolve) => {
			recording = false
			try { sourceNode.disconnect(processor) } catch {}
			try { processor.disconnect() } catch {}
			processor.onaudioprocess = null

			// Merge chunks per channel
			const channelData = chunks.map((arr) => {
				const length = arr.reduce((sum, a) => sum + a.length, 0)
				const out = new Float32Array(length)
				let offset = 0
				for (const a of arr) { out.set(a, offset); offset += a.length }
				return out
			})

			resolve({
				sampleRate: audioContext.sampleRate,
				channels: channelData
			})
		})
	}

	return { stop }
}

export default { startRecording }
