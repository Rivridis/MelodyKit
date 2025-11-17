// Worker script for spessasynth_lib WorkerSynthesizer
// This file runs inside a Web Worker. It wires messages to WorkerSynthesizerCore.
import { WorkerSynthesizerCore } from 'spessasynth_lib'

/** @type {import('spessasynth_lib').WorkerSynthesizerCore | undefined} */
let workerSynthCore

// In a worker, self is the global scope
// eslint-disable-next-line no-undef
self.onmessage = (e) => {
  // If a MessagePort is provided, this is the initialization message
  if (e.ports && e.ports[0]) {
    workerSynthCore = new WorkerSynthesizerCore(
      e.data,
      e.ports[0],
      // eslint-disable-next-line no-undef
      postMessage.bind(self)
    )
    return
  }
  if (workerSynthCore) {
    // Forward runtime messages
    void workerSynthCore.handleMessage(e.data)
  }
}
