# MelodyKit - AI Coding Agent Instructions

## Project Overview
MelodyKit is an Electron desktop application built with React 19, Vite, and Tailwind CSS v4. The app follows the electron-vite template structure with a clear separation between main process, preload, and renderer processes.

## Architecture

### Three-Process Model
- **Main Process** (`src/main/index.js`): Node.js environment, handles window creation, app lifecycle, and IPC handlers
- **Preload Script** (`src/preload/index.js`): Bridge layer using `contextBridge` to safely expose APIs to renderer
- **Renderer Process** (`src/renderer/`): React app running in Chromium, isolated from Node.js for security

### Key Patterns

**IPC Communication**: Use the established pattern for main-renderer communication:
```javascript
// Main process (src/main/index.js)
ipcMain.on('ping', () => console.log('pong'))

// Renderer (src/renderer/src/App.jsx)
window.electron.ipcRenderer.send('ping')
```

**Preload API Exposure**: Extend the `api` object in `src/preload/index.js` to expose new functions to the renderer. The `electronAPI` from `@electron-toolkit/preload` is already exposed as `window.electron`.

**Path Aliases**: Use `@renderer` alias for imports within the renderer process (configured in `electron.vite.config.mjs`):
```javascript
import Component from '@renderer/components/Component'
```

## Development Workflow

### Commands
- `npm run dev` - Start dev server with hot reload (HMR for renderer)
- `npm run build` - Build for production (outputs to `out/`)
- `npm run build:win` - Build Windows installer
- `npm run build:mac` - Build macOS .dmg
- `npm run build:linux` - Build Linux AppImage/snap/deb
- `npm run lint` - Run ESLint with caching
- `npm run format` - Format code with Prettier

### Build System
- **electron-vite**: Handles bundling for all three processes separately
- Each process has its own Vite config section in `electron.vite.config.mjs`
- Tailwind CSS v4 is configured via `@tailwindcss/vite` plugin for all processes

## Technology Stack

### Core Dependencies
- **Electron 38.x**: Desktop app framework
- **React 19.x**: UI library (using new `createRoot` API)
- **Tailwind CSS 4.x**: Utility-first CSS (v4 syntax with `@` prefix)
- **electron-vite**: Build tool optimized for Electron
- **@electron-toolkit/utils**: Electron utilities (optimizer, platform detection via `is.dev`)

### Code Quality
- **ESLint**: Uses flat config format (`eslint.config.mjs`) with React, React Hooks, and React Refresh plugins
- **Prettier**: Code formatting enforced via `@electron-toolkit/eslint-config-prettier`
- Ignore patterns: `node_modules/`, `dist/`, `out/`

## Project Conventions

### File Structure
- Main process code: `src/main/*.js`
- Preload scripts: `src/preload/*.js`
- Renderer React app: `src/renderer/src/` (note the nested `src/`)
- Components: `src/renderer/src/components/`
- Assets: `src/renderer/src/assets/`
- Build resources: `build/` (icons, entitlements)

### Styling
- Use Tailwind CSS utility classes directly in JSX
- Tailwind v4 syntax (e.g., `@tailwindcss/vite` plugin)
- Global styles in `src/renderer/src/assets/main.css` and `base.css`

### React Patterns
- Functional components with hooks (no class components)
- React 19 with StrictMode enabled
- Use `window.electron` and `window.api` for Electron APIs (exposed via preload)

## Security Notes
- Context isolation is enabled (`contextIsolated: true`)
- Sandbox mode is disabled (`sandbox: false`) - be cautious with untrusted content
- CSP configured in `src/renderer/index.html`
- Always use `contextBridge` to expose APIs, never attach directly to `window`

## Distribution
- Uses `electron-builder` for packaging
- Configured in `electron-builder.yml`
- Auto-updater configured (generic provider at `https://example.com/auto-updates`)
- App ID: `com.electron.app`

## Common Tasks

**Add new IPC channel**: 
1. Define handler in `src/main/index.js` with `ipcMain.on()` or `ipcMain.handle()`
2. Optionally expose wrapper in `src/preload/index.js` via `api` object
3. Call from renderer using `window.electron.ipcRenderer.send()` or `window.api.yourMethod()`

**Add new React component**: Create in `src/renderer/src/components/`, import in `App.jsx` or other components

**Modify window properties**: Edit `createWindow()` in `src/main/index.js` (size, frame, transparency, etc.)
