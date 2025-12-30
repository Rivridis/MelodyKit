import React, { useEffect, useRef, useState } from 'react'

function TitleBar({ onNewProject, onLoadProject, onSaveAsProject, onExportWav, onImportAudio, currentProjectPath, loading, isAutosaving }) {
  const [fileOpen, setFileOpen] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    const onDocClick = (e) => {
      if (!menuRef.current) return
      if (!menuRef.current.contains(e.target)) setFileOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const fileItems = [
    { label: 'New', onClick: () => { setFileOpen(false); onNewProject?.() }, accel: 'Ctrl+N' },
    { label: 'Open…', onClick: () => { setFileOpen(false); onLoadProject?.() }, accel: 'Ctrl+O' },
    { label: 'Import Audio…', onClick: () => { setFileOpen(false); onImportAudio?.() }, accel: 'Ctrl+I' },
    { separator: true },
    { label: 'Save As…', onClick: () => { setFileOpen(false); onSaveAsProject?.() }, accel: 'Ctrl+Shift+S' },
    { label: 'Export WAV', onClick: () => { setFileOpen(false); onExportWav?.() }, accel: 'Ctrl+E' },
    { separator: true },
    { label: 'Exit', onClick: () => window.api?.window?.close?.() }
  ]

  return (
    <div className="w-full h-10 flex items-center justify-between bg-zinc-900 border-b border-zinc-800 select-none" style={{ WebkitAppRegion: 'drag' }}>
      {/* Left: Menus + title */}
      <div className="flex items-center h-full" style={{ WebkitAppRegion: 'no-drag' }}>
        {/* File menu */}
        <div ref={menuRef} className="relative h-full">
          <button
            onClick={() => setFileOpen(o => !o)}
            className={`h-full px-3 text-sm ${fileOpen ? 'bg-zinc-800 text-white' : 'text-zinc-300 hover:bg-zinc-800 hover:text-white'}`}
          >
            File
          </button>
          {fileOpen && (
            <div className="absolute left-0 top-full mt-0.5 w-56 bg-zinc-900 border border-zinc-700 rounded-md shadow-lg z-50">
              <ul className="py-1">
                {fileItems.map((item, idx) => item.separator ? (
                  <li key={`sep-${idx}`} className="my-1 border-t border-zinc-700" />
                ) : (
                  <li key={item.label}>
                    <button
                      onClick={item.onClick}
                      className="w-full flex items-center justify-between px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
                    >
                      <span>{item.label}</span>
                      {item.accel && <span className="text-xs text-zinc-500 ml-8">{item.accel}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Import Audio now lives under File menu */}

        {/* App name and current file (drag area allowed except menu/button regions) */}
        <div className="ml-2 pl-2 border-l border-zinc-800 h-full flex items-center">
          <span className="text-zinc-100 font-semibold text-sm">MelodyKit</span>
          <span className="mx-2 text-zinc-600">•</span>
          {loading ? (
            <span className="text-amber-300 text-sm">Loading…</span>
          ) : (
            <span className="text-zinc-400 text-sm truncate max-w-[20rem]" title={currentProjectPath || 'Unsaved project'}>
              {currentProjectPath ? currentProjectPath.split('\\').pop() : 'Untitled'}
            </span>
          )}
        </div>
      </div>

      {/* Right: Window buttons */}
      <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' }}>
        {/* Autosave indicator */}
        {isAutosaving && (
          <div className="flex items-center gap-2 mr-3 px-2 py-1 text-xs text-amber-300">
            <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span>Saving...</span>
          </div>
        )}
        <button
          onClick={() => window.api?.window?.minimize?.()}
          className="w-10 h-10 flex items-center justify-center text-zinc-300 hover:bg-zinc-800"
          title="Minimize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="5" width="8" height="1"/></svg>
        </button>
        <button
          onClick={() => window.api?.window?.toggleMaximize?.()}
          className="w-10 h-10 flex items-center justify-center text-zinc-300 hover:bg-zinc-800"
          title="Maximize/Restore"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" fill="none"/></svg>
        </button>
        <button
          onClick={() => window.api?.window?.close?.()}
          className="w-12 h-10 flex items-center justify-center text-zinc-300 hover:bg-red-600 hover:text-white"
          title="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.5"/></svg>
        </button>
      </div>
    </div>
  )
}

export default TitleBar
