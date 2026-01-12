import React, { useEffect, useMemo, useState } from 'react'

// Simple drum sequencer panel for editing a beat track
// Props:
// - trackId
// - pattern: { steps: number, rows: Array<{ id: string, name: string, filePath?: string, fileUrl?: string, steps: boolean[] }> }
// - onChange(pattern)
// - onBack()
// - bpm
export default function SequencerPanel({ trackId, pattern, onChange, onBack, bpm }) {
  const [available, setAvailable] = useState([])
  const [local, setLocal] = useState(() => normalizePattern(pattern))
  const isPlayingRef = React.useRef(false)
  const timerRef = React.useRef(null)
  const lastSubdivisionRef = React.useRef(-1)
  const loadedPathsRef = React.useRef({}) // { rowId: filePath }
  const syncingFromPropRef = React.useRef(false)
  const onChangeRef = React.useRef(onChange)
  // Keep a live ref of the current pattern so the preview loop always sees updates
  const currentPatternRef = React.useRef(local)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    syncingFromPropRef.current = true
    setLocal(normalizePattern(pattern))
  }, [pattern])

  // Keep the live pattern ref in sync so the scheduler reads fresh data
  useEffect(() => {
    currentPatternRef.current = local

    // Propagate changes to parent after render to avoid setState during render warnings
    if (syncingFromPropRef.current) {
      syncingFromPropRef.current = false
      return
    }
    onChangeRef.current?.(local)
  }, [local])

  const loadSamplesForPattern = React.useCallback(async (p) => {
    if (!trackId || !p || !Array.isArray(p.rows)) return
    for (const row of p.rows) {
      if (!row?.id || !row?.filePath) continue
      if (loadedPathsRef.current[row.id] === row.filePath) continue
      try {
        await window.api?.backend?.loadBeatSample?.(String(trackId), String(row.id), row.filePath)
        loadedPathsRef.current[row.id] = row.filePath
      } catch (e) {
        console.error('Failed to load beat sample into backend', row.filePath, e)
      }
    }
  }, [trackId])

  useEffect(() => {
    loadSamplesForPattern(local)
  }, [local, loadSamplesForPattern])

  // Persistence is driven by App state + project autosave; no localStorage here

  useEffect(() => {
    let mounted = true
    const load = async () => {
      try {
        const list = await window.api?.sequencer?.listSounds?.()
        if (mounted && Array.isArray(list)) setAvailable(list)
      } catch (e) {
        console.error('Failed to list sequencer sounds', e)
      }
    }
    load()
    return () => { mounted = false }
  }, [])

  const stepsCount = local.steps
  const stepsIdx = useMemo(() => Array.from({ length: stepsCount }, (_, i) => i), [stepsCount])
  
  // Stop preview on unmount
  useEffect(() => {
    return () => {
      try { stopPreview(timerRef, isPlayingRef) } catch {}
    }
  }, [])

  const toggleStep = (rowId, idx) => {
    setLocal((prev) => {
      const rows = prev.rows.map((r) => {
        if (r.id !== rowId) return r
        const next = { ...r, steps: [...r.steps] }
        next.steps[idx] = !next.steps[idx]
        return next
      })
      return { ...prev, rows }
    })
  }

  const setRowSound = (rowId, fileName) => {
    const sound = available.find((s) => s.fileName === fileName)
    if (!sound) return
    setLocal((prev) => {
      const rows = prev.rows.map((r) => r.id === rowId ? { ...r, name: sound.name, filePath: sound.filePath, fileUrl: sound.fileUrl } : r)
      try { delete loadedPathsRef.current[rowId] } catch {}
      return { ...prev, rows }
    })
  }

  const addRow = () => {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const first = available[0]
    const newRow = {
      id,
      name: first ? first.name : 'Row',
      filePath: first?.filePath,
      fileUrl: first?.fileUrl,
      steps: Array.from({ length: stepsCount }, () => false)
    }
    const next = { ...local, rows: [...local.rows, newRow] }
    setLocal(next)
  }

  const removeRow = (rowId) => {
    const next = { ...local, rows: local.rows.filter((r) => r.id !== rowId) }
    setLocal(next)
    try { delete loadedPathsRef.current[rowId] } catch {}
    window.api?.backend?.clearBeat?.(String(trackId), String(rowId)).catch(() => {})
  }

  const setSteps = (n) => {
    const count = Number(n)
    if (!count || count < 8 || count > 32) return
    const rows = local.rows.map((r) => ({
      ...r,
      steps: resizeBooleanArray(r.steps, count)
    }))
    const next = { steps: count, rows, lengthBeats: local.lengthBeats }
    setLocal(next)
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-zinc-900">
      <div className="flex items-center gap-3 px-4 py-2 bg-zinc-900 border-b border-zinc-800">
        <button
          onClick={onBack}
          className="inline-flex items-center justify-center h-9 px-3 rounded-md bg-zinc-800 hover:bg-zinc-700 text-white"
        >
          ← Back
        </button>
        <h2 className="text-white font-semibold">Beat Sequencer</h2>
        <button
          onClick={() => window.api?.sequencer?.openFolder?.()}
          className="inline-flex items-center justify-center h-8 w-8 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors"
          title="Open beats folder"
        >
          📁
        </button>
        <div className="flex-1" />
        <div className="flex items-center gap-2 text-sm">
          {/* Play/Stop */}
          <SequencerPlayButton
            getIsPlaying={() => !!isPlayingRef.current}
            onToggle={async () => {
              if (isPlayingRef.current) {
                stopPreview(timerRef, isPlayingRef)
              } else {
                await loadSamplesForPattern(currentPatternRef.current)
                startPreview({
                  bpm,
                  getCurrentPattern: () => currentPatternRef.current,
                  trackId,
                  timerRef,
                  lastSubdivisionRef,
                  isPlayingRef
                })
              }
            }}
          />
          <span className="text-zinc-400">Steps</span>
          <select
            value={local.steps}
            onChange={(e) => setSteps(e.target.value)}
            className="h-9 px-2 bg-zinc-800 text-white rounded-md border border-zinc-700"
          >
            {[8, 16, 24, 32].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <span className="text-zinc-400 ml-4">BPM</span>
          <span className="text-white">{bpm}</span>
          <button
            onClick={addRow}
            className="ml-4 inline-flex items-center justify-center h-9 px-3 rounded-md bg-amber-600 hover:bg-amber-500 text-white shadow-sm"
          >
            + Row
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {local.rows.length === 0 ? (
          <div className="text-zinc-400 text-sm">No rows yet. Click + Row to add a drum.</div>
        ) : (
          <div className="space-y-3">
            {local.rows.map((row) => (
              <div key={row.id} className="flex items-center gap-3">
                <div className="w-56 flex items-center gap-2">
                  <select
                    value={row.fileName || available.find(a => a.filePath === row.filePath)?.fileName || ''}
                    onChange={(e) => setRowSound(row.id, e.target.value)}
                    className="h-9 w-44 px-2 bg-zinc-800 text-white rounded-md border border-zinc-700"
                  >
                    {available.map((s) => (
                      <option key={s.fileName} value={s.fileName}>{s.name}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => removeRow(row.id)}
                    className="inline-flex items-center justify-center h-9 px-2 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                    title="Remove row"
                  >
                    ✕
                  </button>
                </div>
                <div className="flex-1 grid gap-1" style={{ gridTemplateColumns: `repeat(${stepsCount}, minmax(22px, 1fr))` }}>
                  {stepsIdx.map((i) => (
                    <button
                      key={i}
                      onClick={() => toggleStep(row.id, i)}
                      className={`h-8 rounded-sm border ${row.steps[i] ? 'bg-amber-600 border-amber-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function normalizePattern(p) {
  const steps = Math.min(32, Math.max(8, Number(p?.steps) || 16))
  const rows = Array.isArray(p?.rows) ? p.rows.map((r) => ({
    id: r.id || `${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    name: r.name || 'Row',
    filePath: r.filePath,
    fileUrl: r.fileUrl,
    steps: resizeBooleanArray(r.steps || [], steps)
  })) : []
  const lengthBeats = typeof p?.lengthBeats === 'number' ? p.lengthBeats : undefined
  return { steps, rows, lengthBeats }
}

function resizeBooleanArray(arr, size) {
  const out = Array.from({ length: size }, (_, i) => !!arr[i])
  return out
}

function SequencerPlayButton({ getIsPlaying, onToggle }) {
  const [spin, setSpin] = React.useState(false)
  const isPlaying = getIsPlaying()
  return (
    <button
      onClick={async () => {
        setSpin(true)
        try { await onToggle?.() } finally { setSpin(false) }
      }}
      className={`inline-flex items-center justify-center h-9 px-3 rounded-md ${isPlaying ? 'bg-amber-700 hover:bg-amber-600' : 'bg-amber-600 hover:bg-amber-500'} text-white shadow-sm`}
      title={isPlaying ? 'Stop' : 'Play'}
    >
      {isPlaying ? (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
      ) : (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7-11-7z"/></svg>
      )}
    </button>
  )
}

function startPreview({ bpm, getCurrentPattern, trackId, timerRef, lastSubdivisionRef, isPlayingRef }) {
  const beatDurationMs = 60000 / bpm
  const regionBeats = 4

  isPlayingRef.current = true
  lastSubdivisionRef.current = -1
  const startTime = Date.now()

  timerRef.current = setInterval(() => {
    if (!isPlayingRef.current) return
    const pattern = getCurrentPattern?.() || {}
    const steps = Math.max(1, Number(pattern.steps) || 16)
    const rows = pattern.rows || []
    const elapsed = Date.now() - startTime
    const beat = elapsed / beatDurationMs
    const beatInRegion = beat % regionBeats
    const phase = beatInRegion / regionBeats
    const stepIndex = Math.floor(phase * steps)
    if (stepIndex === lastSubdivisionRef.current) return
    lastSubdivisionRef.current = stepIndex

    rows.forEach((row) => {
      if (row?.steps?.[stepIndex]) {
        window.api?.backend?.triggerBeat?.(String(trackId), String(row.id), 0.8)
      }
    })
  }, 20)
}

function stopPreview(timerRef, isPlayingRef) {
  if (timerRef.current) {
    clearInterval(timerRef.current)
    timerRef.current = null
  }
  if (isPlayingRef) isPlayingRef.current = false
}
