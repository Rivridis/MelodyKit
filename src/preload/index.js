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
  openAudioFiles: () => ipcRenderer.invoke('audio:open'),
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
  // load an SF2 from resources (relative path under resources/)
  loadSF2: (relativePath) => ipcRenderer.invoke('backend:load-sf2', relativePath),
  // load a VST/VST3 plugin by absolute path for a specific track
  loadVST: (trackId, pluginPath) => ipcRenderer.invoke('backend:load-vst', { trackId, pluginPath }),
  // scan for available VST3 plugins
  scanVSTs: () => ipcRenderer.invoke('backend:scan-vsts'),
  // send a live note on/off pair to the plugin for a specific track
  noteOn: (opts) => ipcRenderer.invoke('backend:note-on', opts),
  // set track volume via MIDI CC (0-127, where 100 is default)
  setVolume: (trackId, volume, channel) => ipcRenderer.invoke('backend:set-volume', { trackId, volume, channel }),
  // optional helpers
  panic: (trackId) => ipcRenderer.invoke('backend:panic', trackId),
  status: () => ipcRenderer.invoke('backend:status'),
  openEditor: (trackId) => ipcRenderer.invoke('backend:open-editor', trackId),
  closeEditor: (trackId) => ipcRenderer.invoke('backend:close-editor', trackId),
  // render current state for durationMs (legacy stub)
  render: (opts) => ipcRenderer.invoke('backend:render', opts),
  // render MIDI notes to WAV using VST processing
  renderWav: (notes, sampleRate, bitDepth) => ipcRenderer.invoke('backend:render-wav', { notes, sampleRate, bitDepth }),
  // render MIDI notes to temporary WAV file (no dialog, for mixing)
  renderWavTemp: (notes, sampleRate, bitDepth) => ipcRenderer.invoke('backend:render-wav-temp', { notes, sampleRate, bitDepth }),
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
