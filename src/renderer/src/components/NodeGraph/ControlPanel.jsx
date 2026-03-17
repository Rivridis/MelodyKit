import { useState } from 'react'

const ControlPanel = ({ node, onParamChange }) => {
  const { label, params, type } = node

  if (type !== 'effect' || !params) return null

  const handleParamChange = (paramKey, value) => {
    const newParams = { ...params, [paramKey]: value }
    onParamChange?.(node.id, newParams)
  }

  const getParamConfig = (paramKey) => {
    const configs = {
      wet: { min: 0, max: 1, step: 0.01, label: 'Wet' },
      decay: { min: 0.1, max: 5, step: 0.1, label: 'Decay (s)' },
      time: { min: 0.01, max: 2, step: 0.01, label: 'Time (s)' },
      feedback: { min: 0, max: 0.99, step: 0.01, label: 'Feedback' },
      rate: { min: 0.1, max: 10, step: 0.1, label: 'Rate (Hz)' },
      depth: { min: 0, max: 1, step: 0.01, label: 'Depth' },
      drive: { min: 0, max: 1, step: 0.01, label: 'Drive' },
      tone: { min: 0, max: 1, step: 0.01, label: 'Tone' },
      threshold: { min: -60, max: 0, step: 1, label: 'Threshold (dB)' },
      ratio: { min: 1, max: 20, step: 0.5, label: 'Ratio' },
      attack: { min: 0.001, max: 0.5, step: 0.001, label: 'Attack (s)' },
      release: { min: 0.01, max: 3, step: 0.01, label: 'Release (s)' },
      frequency: { min: 20, max: 20000, step: 10, label: 'Frequency (Hz)' },
      gain: { min: -24, max: 24, step: 0.5, label: 'Gain (dB)' },
    }
    return configs[paramKey] || { min: 0, max: 1, step: 0.01, label: paramKey }
  }

  return (
    <div className="absolute bottom-6 left-6 bg-zinc-800 border border-zinc-700 rounded-lg p-4 shadow-lg z-20 w-80">
      <h3 className="text-sm font-bold text-gray-100 mb-4">{label} Controls</h3>
      
      <div className="space-y-4 max-h-96 overflow-y-auto">
        {Object.entries(params).map(([key, value]) => {
          const config = getParamConfig(key)
          const numValue = Number(value)

          return (
            <div key={key} className="space-y-2">
              <div className="flex justify-between items-center">
                <label className="text-xs font-semibold text-gray-300">
                  {config.label}
                </label>
                <span className="text-xs text-gray-400 bg-zinc-900 px-2 py-1 rounded">
                  {numValue.toFixed(config.step < 0.01 ? 3 : 2)}
                </span>
              </div>
              <input
                type="range"
                min={config.min}
                max={config.max}
                step={config.step}
                value={numValue}
                onChange={(e) => {
                  handleParamChange(key, parseFloat(e.target.value))
                }}
                className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
            </div>
          )
        })}
      </div>

      <div className="mt-6 pt-4 border-t border-zinc-700 text-xs text-gray-500">
        <p>Click on another node to switch controls</p>
      </div>
    </div>
  )
}

export default ControlPanel
