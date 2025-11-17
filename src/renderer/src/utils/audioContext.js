// Shared AudioContext for the renderer so instruments persist across views
let sharedAudioContext = null

export function getSharedAudioContext() {
  if (!sharedAudioContext) {
    const Ctor = window.AudioContext || window.webkitAudioContext
    sharedAudioContext = new Ctor()
  }
  return sharedAudioContext
}

export function ensureAudioContextRunning(ctx = getSharedAudioContext()) {
  if (ctx && ctx.state === 'suspended') {
    return ctx.resume()
  }
  return Promise.resolve()
}
