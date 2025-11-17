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
  // note on that renders to a temporary wav and returns { ok, outPath }
  noteOn: (opts) => ipcRenderer.invoke('backend:note-on', opts),
  // render current state for durationMs
  render: (opts) => ipcRenderer.invoke('backend:render', opts),
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
