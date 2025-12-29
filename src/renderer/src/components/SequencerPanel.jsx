import React, { useEffect, useMemo, useState } from 'react'
import { getSharedAudioContext } from '@renderer/utils/audioContext'

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
  const audioContextRef = useState(() => getSharedAudioContext())[0]
  const loadedBuffersRef = React.useRef({}) // { rowId: AudioBuffer }
  const isPlayingRef = React.useRef(false)
  const timerRef = React.useRef(null)
  const lastSubdivisionRef = React.useRef(-1)
  // Keep a live ref of the current pattern so the preview loop always sees updates
  const currentPatternRef = React.useRef(local)

  useEffect(() => {
    setLocal(normalizePattern(pattern))
  }, [pattern])

  // Keep the live pattern ref in sync so the scheduler reads fresh data
  useEffect(() => {
    currentPatternRef.current = local
  }, [local])

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
      const next = { ...prev, rows }
      onChange?.(next)
      return next
    })
  }

  const setRowSound = (rowId, fileName) => {
    const sound = available.find((s) => s.fileName === fileName)
    if (!sound) return
    setLocal((prev) => {
      const rows = prev.rows.map((r) => r.id === rowId ? { ...r, name: sound.name, filePath: sound.filePath, fileUrl: sound.fileUrl } : r)
      const next = { ...prev, rows }
      onChange?.(next)
      // Invalidate cached buffer for this row so new sample is used
      try { delete loadedBuffersRef.current[rowId] } catch {}
      // If currently playing, eagerly (re)load the new buffer so switches take effect immediately
      if (isPlayingRef.current && audioContextRef) {
        ensureBuffersLoaded(next, loadedBuffersRef, audioContextRef).catch((e) => console.error('reload buffer after switch failed', e))
      }
      return next
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
    onChange?.(next)
    // If playing, ensure any new row buffer is preloaded so it can sound immediately
    if (isPlayingRef.current && audioContextRef) {
      ensureBuffersLoaded(next, loadedBuffersRef, audioContextRef).catch((e) => console.error('preload after add row failed', e))
    }
  }

  const removeRow = (rowId) => {
    const next = { ...local, rows: local.rows.filter((r) => r.id !== rowId) }
    setLocal(next)
    onChange?.(next)
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
    onChange?.(next)
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
        <div className="flex-1" />
        <div className="flex items-center gap-2 text-sm">
          {/* Play/Stop */}
          <SequencerPlayButton
            getIsPlaying={() => !!isPlayingRef.current}
            onToggle={async () => {
              if (!audioContextRef) return
              if (isPlayingRef.current) {
                stopPreview(timerRef, isPlayingRef)
              } else {
                try { if (audioContextRef.state === 'suspended') await audioContextRef.resume() } catch {}
                await ensureBuffersLoaded(local, loadedBuffersRef, audioContextRef)
                startPreview({
                  bpm,
                  // Use a function to fetch the freshest pattern inside the loop
                  getCurrentPattern: () => currentPatternRef.current,
                  audioContext: audioContextRef,
                  loaded: loadedBuffersRef,
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
            className="ml-4 inline-flex items-center justify-center h-9 px-3 rounded-md bg-blue-500 hover:bg-blue-600 text-white"
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
                      className={`h-8 rounded-sm border ${row.steps[i] ? 'bg-emerald-500 border-emerald-400' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}
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
      className={`inline-flex items-center justify-center h-9 px-3 rounded-md ${isPlaying ? 'bg-zinc-700 hover:bg-zinc-600' : 'bg-green-600 hover:bg-green-500'} text-white`}
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

async function ensureBuffersLoaded(local, loadedBuffersRef, audioContext) {
  const rows = local?.rows || []
  for (const row of rows) {
    if (!row?.id || !row?.filePath) continue
    if (loadedBuffersRef.current[row.id]) continue
    try {
      const res = await window.api?.readAudioFile?.(row.filePath)
      if (res && res.ok && Array.isArray(res.bytes)) {
        const uint8 = Uint8Array.from(res.bytes)
        const ab = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength)
        const buffer = await audioContext.decodeAudioData(ab)
        loadedBuffersRef.current[row.id] = buffer
      }
    } catch (e) {
      console.error('Sequencer decode error', row.filePath, e)
    }
  }
}

function startPreview({ bpm, getCurrentPattern, audioContext, loaded, timerRef, lastSubdivisionRef, isPlayingRef }) {
  // Phase-based scheduler: evenly distribute all steps across the region length (1 bar by default)
  const beatDurationMs = 60000 / bpm
  // Always map steps across a single bar (4 beats) for preview; if the region is expanded in track view,
  // the pattern should loop per bar rather than stretch.
  const regionBeats = 4

  isPlayingRef.current = true
  // Reuse this ref to store lastStepIndex to avoid duplicate triggers in tight intervals
  lastSubdivisionRef.current = -1
  const startTime = Date.now()

  timerRef.current = setInterval(() => {
    if (!isPlayingRef.current) return
    // Always read the latest pattern so edits apply immediately
    const pattern = getCurrentPattern?.() || {}
    const steps = Math.max(1, Number(pattern.steps) || 16)
    const rows = pattern.rows || []
    const elapsed = Date.now() - startTime
    const beat = elapsed / beatDurationMs
    // Normalize to [0, regionBeats)
  const beatInRegion = beat % regionBeats
  const phase = beatInRegion / regionBeats // 0..1 within the bar
    const stepIndex = Math.floor(phase * steps) // 0..steps-1
    if (stepIndex === lastSubdivisionRef.current) return
    lastSubdivisionRef.current = stepIndex

    // trigger rows
    rows.forEach((row) => {
      if (!row?.steps?.[stepIndex]) return
      const buf = loaded.current[row.id]
      if (!buf) return
      try {
        const src = audioContext.createBufferSource()
        src.buffer = buf
  // Gentle fixed preview volume (independent of track slider)
  const g = audioContext.createGain()
  g.gain.value = 0.8
        src.connect(g)
        g.connect(audioContext.destination)
        src.start()
        src.onended = () => {
          try { src.disconnect(); g.disconnect() } catch {}
        }
      } catch (e) {
        console.error('sequencer preview play error', e)
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
