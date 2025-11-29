import { app, shell, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

// Unified helper for resolving files in the resources directory
// Uses unpacked path in production and plain folder in development
const getResource = (file) => {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', file)
    : path.join(__dirname, '../../resources', file)
}

// Helper function to determine instrument icon
function getInstrumentIcon(folderName) {
  const name = folderName.toLowerCase()
  if (name.includes('piano')) return '🎹'
  if (name.includes('guitar')) return '🎸'
  if (name.includes('drum')) return '🥁'
  if (name.includes('bass')) return '🎸'
  if (name.includes('violin')) return '🎻'
  if (name.includes('trumpet') || name.includes('horn')) return '🎺'
  if (name.includes('sax')) return '🎷'
  if (name.includes('flute')) return '🎶'
  if (name.includes('organ')) return '🎹'
  if (name.includes('synth')) return '🎛️'
  return '🎵' // Default
}

function createWindow() {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    show: false,
    autoHideMenuBar: true,
    frame: false,
    fullscreen: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    backgroundColor: ' #232323', // Set background color to black to prevent white flash
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Remove native application menu (we'll provide a custom title bar in renderer)
  Menu.setApplicationMenu(null)

  // Window control IPC
  ipcMain.handle('window:minimize', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (win) win.minimize()
    return { ok: true }
  })
  ipcMain.handle('window:toggle-maximize', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return { ok: false }
    if (win.isMaximized()) win.unmaximize(); else win.maximize()
    return { ok: true, maximized: win.isMaximized() }
  })
  ipcMain.handle('window:is-maximized', () => {
    const win = BrowserWindow.getFocusedWindow()
    return { ok: true, maximized: !!win?.isMaximized() }
  })
  ipcMain.handle('window:close', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (win) win.close()
    return { ok: true }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // Backend process bridge
  let backendProc = null
  const spawnBackendIfAvailable = () => {
    if (backendProc) return backendProc
    const candidates = []
    // In development try relative to project root (two levels up from compiled main)
    candidates.push(path.join(__dirname, '../../Backend/Backend.exe'))
    candidates.push(path.join(__dirname, '../../Backend/Backend'))
    // Also try project workspace path (use resources folder in packaged builds)
    candidates.push(path.join(process.cwd(), 'Backend', 'Backend.exe'))
    candidates.push(path.join(process.cwd(), 'Backend', 'Backend'))

    let exe = null
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) { exe = c; break }
      } catch (e) {}
    }

    if (!exe) {
      console.warn('Backend executable not found in candidates:', candidates)
      return null
    }

    const { spawn } = require('child_process')
    backendProc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] })

    backendProc.stdout.on('data', (data) => {
      const s = data.toString().trim()
      console.log('[backend]', s)
      // Forward events to renderer(s)
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('backend:event', s)
      }
    })
    backendProc.stderr.on('data', (data) => {
      const s = data.toString().trim()
      console.error('[backend:err]', s)
    })
    backendProc.on('exit', (code, signal) => {
      console.log('Backend exited', code, signal)
      backendProc = null
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('backend:event', `EVENT EXIT ${code}`)
      }
    })

    return backendProc
  }

  const sendToBackend = (line) => {
    const p = spawnBackendIfAvailable()
    if (!p) return { ok: false, error: 'backend-not-found' }
    try {
      p.stdin.write(line + '\n')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  ipcMain.handle('backend:send', async (event, line) => {
    return sendToBackend(line)
  })

  // Higher-level helpers used by renderer
  ipcMain.handle('backend:load-sf2', async (event, relativePath) => {
    try {
      const normalized = relativePath.startsWith('resources/')
        ? relativePath.replace(/^resources\//, '')
        : relativePath
      const fullPath = getResource(normalized)
      if (!fs.existsSync(fullPath)) return { ok: false, error: 'file-not-found', path: fullPath }
      return sendToBackend(`LOAD ${fullPath}`)
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle('backend:note-on', async (event, { presetIndex = 0, note = 60, vel = 1.0, durationMs = 500 }) => {
    try {
      const tempName = `melodykit_note_${Date.now()}.wav`
      const outPath = path.join(app.getPath('temp'), tempName)
      const line = `NOTE_ON ${presetIndex} ${note} ${vel} ${durationMs} ${outPath}`
      const res = sendToBackend(line)
      res.outPath = outPath
      return res
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle('backend:render', async (event, { durationMs = 1000 }) => {
    try {
      const tempName = `melodykit_render_${Date.now()}.wav`
      const outPath = path.join(app.getPath('temp'), tempName)
      const line = `RENDER ${durationMs} ${outPath}`
      const res = sendToBackend(line)
      res.outPath = outPath
      return res
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })


  // IPC handler to get full path or bytes for a resource file (e.g., SF2)
  ipcMain.handle('get-resource-path', async (event, relativePath) => {
    try {
      // relativePath is expected relative to resources/ (e.g. "Piano/Grand Piano.sf2")
      // Backwards compatibility: if a consumer sends "resources/...", strip the prefix
      const normalized = relativePath.startsWith('resources/')
        ? relativePath.replace(/^resources\//, '')
        : relativePath

      const fullPath = getResource(normalized)
      console.log('Requested resource:', relativePath)
      console.log('Resolved full path:', fullPath)
      console.log('File exists:', fs.existsSync(fullPath))
      
      // For SF2 files, we need to read them as a buffer
      if (fullPath.endsWith('.sf2')) {
        const buffer = fs.readFileSync(fullPath)
        console.log('SF2 file read, buffer size:', buffer.length)
        // Return as Uint8Array which transfers better over IPC
        return Array.from(buffer)
      }
      
      return fullPath
    } catch (error) {
      console.error('Error resolving resource path:', error)
      console.error('Error stack:', error.stack)
      throw error
    }
  })

  // IPC handler to save WAV bytes with a system save dialog
  ipcMain.handle('save-wav', async (event, { bytes, defaultFileName }) => {
    try {
      const win = BrowserWindow.getFocusedWindow()
      const { canceled, filePath } = await dialog.showSaveDialog(win || undefined, {
        title: 'Save audio as WAV',
        defaultPath: defaultFileName || 'MelodyKit.wav',
        filters: [{ name: 'WAV Audio', extensions: ['wav'] }]
      })
      if (canceled || !filePath) {
        return { ok: false, canceled: true }
      }
      // bytes expected as array of numbers (Uint8Array-like)
      const buffer = Buffer.from(bytes)
      fs.writeFileSync(filePath, buffer)
      return { ok: true, path: filePath }
    } catch (error) {
      console.error('Error saving WAV:', error)
      return { ok: false, error: String(error) }
    }
  })

  // IPC: list available drum sounds under resources/Sequencer
  ipcMain.handle('sequencer:listSounds', async () => {
    try {
      const seqDir = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'Sequencer')
        : path.join(__dirname, '../../resources/Sequencer')

      if (!fs.existsSync(seqDir)) return []

      const files = fs.readdirSync(seqDir, { withFileTypes: true })
      const sounds = []
      for (const f of files) {
        if (!f.isFile()) continue
        if (!/\.(wav|mp3|ogg|flac|m4a|aac)$/i.test(f.name)) continue
        const filePath = path.join(seqDir, f.name)
        const fileUrl = pathToFileURL(filePath).href
        const baseName = f.name.replace(/\.(wav|mp3|ogg|flac|m4a|aac)$/i, '')
        sounds.push({
          name: baseName,
          fileName: f.name,
          filePath,
          fileUrl
        })
      }
      return sounds
    } catch (e) {
      console.error('sequencer:listSounds error', e)
      return []
    }
  })

  // IPC handler to get available instruments from resources folder
  ipcMain.handle('get-instruments', async () => {
    try {
      // Root of unpacked resources in prod or plain folder in dev
      const resourcesPath = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'resources')
        : path.join(__dirname, '../../resources')

      const items = fs.readdirSync(resourcesPath, { withFileTypes: true })
      const instruments = []

      // Scan each category folder in resources (e.g., Piano, Guitar, etc.)
      for (const item of items) {
        if (item.isDirectory()) {
          const categoryPath = join(resourcesPath, item.name)
          const categoryName = item.name
          const files = fs.readdirSync(categoryPath)
          
          // Find all SF2 soundfont files in this category
          const audioFiles = files.filter((f) => /\.sf2$/i.test(f))

          // Create an instrument entry for each SF2 file
          for (const audioFile of audioFiles) {
            // Use the filename (without extension) as the instrument name
            const instrumentName = audioFile.replace(/\.sf2$/i, '')
            
            // Store relative-to-resources path for lookups via get-resource-path
            const relativePath = `${categoryName}/${audioFile}`

            instruments.push({
              name: instrumentName,
              category: categoryName,
              icon: getInstrumentIcon(categoryName),
              samplePath: relativePath,
              folderName: categoryName,
              fileName: audioFile
            })
          }
        }
      }

      console.log('Loaded instruments:', instruments)
      return instruments
    } catch (error) {
      console.error('Error loading instruments:', error)
      return []
    }
  })

  // IPC handler to save a MelodyKit project to a file
  ipcMain.handle('project:save', async (event, { project, defaultFileName }) => {
    try {
      const win = BrowserWindow.getFocusedWindow()
      const { canceled, filePath } = await dialog.showSaveDialog(win || undefined, {
        title: 'Save MelodyKit Project',
        defaultPath: defaultFileName || 'MelodyKit_Project.melodykit',
        filters: [
          { name: 'MelodyKit Project', extensions: ['melodykit'] },
          { name: 'JSON', extensions: ['json'] }
        ]
      })
      if (canceled || !filePath) {
        return { ok: false, canceled: true }
      }
      const data = JSON.stringify(project, null, 2)
      fs.writeFileSync(filePath, data, 'utf-8')
      return { ok: true, path: filePath }
    } catch (error) {
      console.error('Error saving project:', error)
      return { ok: false, error: String(error) }
    }
  })

  // IPC handler to open a MelodyKit project from a file
  ipcMain.handle('project:open', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow()
      const { canceled, filePaths } = await dialog.showOpenDialog(win || undefined, {
        title: 'Open MelodyKit Project',
        filters: [
          { name: 'MelodyKit Project', extensions: ['melodykit'] },
          { name: 'JSON', extensions: ['json'] }
        ],
        properties: ['openFile']
      })
      if (canceled || !filePaths || filePaths.length === 0) {
        return { ok: false, canceled: true }
      }
      const filePath = filePaths[0]
  const content = fs.readFileSync(filePath, 'utf-8')
  // Support both .melodykit (JSON content) and .json
  const parsed = JSON.parse(content)
      return { ok: true, path: filePath, project: parsed }
    } catch (error) {
      console.error('Error opening project:', error)
      return { ok: false, error: String(error) }
    }
  })

  // IPC handler to save a project directly to a given path (no dialog)
  ipcMain.handle('project:save-to-path', async (event, { project, filePath }) => {
    try {
      if (!filePath) return { ok: false, error: 'No filePath provided' }
      const data = JSON.stringify(project, null, 2)
      fs.writeFileSync(filePath, data, 'utf-8')
      return { ok: true, path: filePath }
    } catch (error) {
      console.error('Error saving project to path:', error)
      return { ok: false, error: String(error) }
    }
  })

  // IPC handler to open a MIDI file and return its bytes
  ipcMain.handle('midi:open', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow()
      const { canceled, filePaths } = await dialog.showOpenDialog(win || undefined, {
        title: 'Import MIDI File',
        filters: [{ name: 'MIDI Files', extensions: ['mid', 'midi'] }],
        properties: ['openFile']
      })
      if (canceled || !filePaths || filePaths.length === 0) {
        return { ok: false, canceled: true }
      }
      const filePath = filePaths[0]
      const buffer = fs.readFileSync(filePath)
      // Return bytes as array for safe IPC transfer
      return { ok: true, path: filePath, bytes: Array.from(buffer) }
    } catch (error) {
      console.error('Error opening MIDI:', error)
      return { ok: false, error: String(error) }
    }
  })

  // IPC handler to open audio file(s) and return their bytes
  ipcMain.handle('audio:open', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow()
      const { canceled, filePaths } = await dialog.showOpenDialog(win || undefined, {
        title: 'Import Audio Files',
        filters: [
          { name: 'Audio Files', extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac'] }
        ],
        properties: ['openFile', 'multiSelections']
      })
      if (canceled || !filePaths || filePaths.length === 0) {
        return { ok: false, canceled: true }
      }
      const files = filePaths.map((p) => {
        try {
          const buffer = fs.readFileSync(p)
          return { path: p, name: path.basename(p), bytes: Array.from(buffer) }
        } catch (e) {
          console.error('Failed to read audio file:', p, e)
          return null
        }
      }).filter(Boolean)
      if (files.length === 0) return { ok: false, error: 'No readable files' }
      return { ok: true, files }
    } catch (error) {
      console.error('Error opening audio file(s):', error)
      return { ok: false, error: String(error) }
    }
  })

  // IPC handler to read an audio file's bytes from a known path
  ipcMain.handle('audio:read', async (event, filePath) => {
    try {
      if (!filePath || typeof filePath !== 'string') {
        return { ok: false, error: 'Invalid filePath' }
      }
      const buffer = fs.readFileSync(filePath)
      return { ok: true, bytes: Array.from(buffer) }
    } catch (error) {
      console.error('Error reading audio file:', filePath, error)
      return { ok: false, error: String(error) }
    }
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
