import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  getInstruments: () => ipcRenderer.invoke('get-instruments'),
  getResourcePath: (relativePath) => ipcRenderer.invoke('get-resource-path', relativePath),
  saveWav: (bytes, defaultFileName) => ipcRenderer.invoke('save-wav', { bytes, defaultFileName }),
  saveProject: (project, defaultFileName) => ipcRenderer.invoke('project:save', { project, defaultFileName }),
  openProject: () => ipcRenderer.invoke('project:open'),
  saveProjectToPath: (project, filePath) => ipcRenderer.invoke('project:save-to-path', { project, filePath }),
  openMidi: () => ipcRenderer.invoke('midi:open'),
  readAudioFile: (filePath) => ipcRenderer.invoke('audio:read', filePath),
  writeTempWav: (bytes, name) => ipcRenderer.invoke('audio:write-temp-wav', { bytes, name }),
  openAudioFiles: () => ipcRenderer.invoke('audio:open'),
  openSampleFile: () => ipcRenderer.invoke('audio:open-sample'),
  sequencer: {
    listSounds: () => ipcRenderer.invoke('sequencer:listSounds')
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    close: () => ipcRenderer.invoke('window:close')
  }
}

// Backend bridge API (talks to native C++ backend spawned by main)
api.backend = {
  // send raw line to backend
  send: (line) => ipcRenderer.invoke('backend:send', line),
  // load an SF2 from resources (relative path under resources/) for a specific track
  loadSF2: (trackId, relativePath) => ipcRenderer.invoke('backend:load-sf2', { trackId, relativePath }),
  // set SF2 preset (bank and preset number) for a specific track
  setSF2Preset: (trackId, bank, preset) => ipcRenderer.invoke('backend:set-sf2-preset', { trackId, bank, preset }),
  // load a VST/VST3 plugin by absolute path for a specific track
  loadVST: (trackId, pluginPath) => ipcRenderer.invoke('backend:load-vst', { trackId, pluginPath }),
  // scan for available VST3 plugins
  scanVSTs: () => ipcRenderer.invoke('backend:scan-vsts'),
  // send a live note on/off pair to the plugin for a specific track
  noteOn: (opts) => ipcRenderer.invoke('backend:note-on', opts),
  // set track volume via MIDI CC (0-127, where 100 is default)
  setVolume: (trackId, volume, channel) => ipcRenderer.invoke('backend:set-volume', { trackId, volume, channel }),
  // beat sampler controls
  loadBeatSample: (trackId, rowId, path) => ipcRenderer.invoke('backend:load-beat-sample', { trackId, rowId, path }),
  triggerBeat: (trackId, rowId, gain) => ipcRenderer.invoke('backend:trigger-beat', { trackId, rowId, gain }),
  clearBeat: (trackId, rowId) => ipcRenderer.invoke('backend:clear-beat', { trackId, rowId }),
  // sampler controls
  loadSamplerSample: (trackId, path) => ipcRenderer.invoke('backend:load-sampler-sample', { trackId, path }),
  triggerSampler: (trackId, note, velocity, durationMs) => ipcRenderer.invoke('backend:trigger-sampler', { trackId, note, velocity, durationMs }),
  stopSamplerNote: (trackId, note) => ipcRenderer.invoke('backend:stop-sampler-note', { trackId, note }),
  clearSampler: (trackId) => ipcRenderer.invoke('backend:clear-sampler', { trackId }),
  // optional helpers
  panic: (trackId) => ipcRenderer.invoke('backend:panic', trackId),
  status: () => ipcRenderer.invoke('backend:status'),
  openEditor: (trackId) => ipcRenderer.invoke('backend:open-editor', trackId),
  closeEditor: (trackId) => ipcRenderer.invoke('backend:close-editor', trackId),
  // render current state for durationMs (legacy stub)
  render: (opts) => ipcRenderer.invoke('backend:render', opts),
  // Render tracks to WAV using backend processing (structured payload)
  renderWav: (payload, sampleRate, bitDepth) => ipcRenderer.invoke('backend:render-wav', { payload, sampleRate, bitDepth }),
  // Render to temporary WAV file (no dialog, for internal mixing)
  renderWavTemp: (payload, sampleRate, bitDepth) => ipcRenderer.invoke('backend:render-wav-temp', { payload, sampleRate, bitDepth }),
  // Get VST plugin preset state (base64-encoded binary data)
  getVSTState: (trackId) => ipcRenderer.invoke('backend:get-vst-state', trackId),
  // Set VST plugin preset state (from base64-encoded binary data)
  setVSTState: (trackId, state) => ipcRenderer.invoke('backend:set-vst-state', { trackId, state }),
  // listen to backend events coming from stdout lines
  onEvent: (cb) => {
    const listener = (ev, payload) => cb(payload)
    ipcRenderer.on('backend:event', listener)
    return () => ipcRenderer.removeListener('backend:event', listener)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
