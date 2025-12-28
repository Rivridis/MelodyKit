import { useState, useEffect } from 'react'
import { loadVST, unloadVST, backendStatus } from '@renderer/utils/vstBackend'

export default function VSTSelector({ trackId, currentVSTPath, useVSTBackend, onVSTLoaded, onVSTUnloaded, onClose }) {
  const [vstPath, setVstPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(true)
  const [availableVSTs, setAvailableVSTs] = useState([])
  const [selectedVST, setSelectedVST] = useState(null)
  const [error, setError] = useState(null)
  const [status, setStatus] = useState(null)
  const [showManualInput, setShowManualInput] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    // Scan for available VSTs on mount
    const scanVSTs = async () => {
      try {
        const result = await window.api.backend.scanVSTs()
        if (result.ok && result.vsts) {
          setAvailableVSTs(result.vsts)
          setStatus(`Found ${result.vsts.length} VST(s)`)
        }
      } catch (e) {
        console.error('Failed to scan VSTs:', e)
        setError('Failed to scan VST folders')
      } finally {
        setScanning(false)
      }
    }
    
    scanVSTs()
    
    // Check backend status
    backendStatus().then(res => {
      if (res.ok && availableVSTs.length === 0) {
        setStatus('Backend ready')
      }
    })
  }, [])

  const handleLoadVST = async (pathToLoad) => {
    const finalPath = pathToLoad || vstPath.trim() || selectedVST?.path

    if (!finalPath) {
      setError('Please select or enter a VST path')
      return
    }

    setLoading(true)
    setError(null)

    const success = await loadVST(trackId, finalPath)
    
    setLoading(false)

    if (success) {
      setStatus('VST loaded successfully')
      // Call onVSTLoaded immediately before closing to ensure state updates
      if (onVSTLoaded) onVSTLoaded(finalPath)
      // Close modal after brief delay for user feedback
      setTimeout(() => {
        if (onClose) onClose()
      }, 300)
    } else {
      setError('Failed to load VST. Check console for details.')
    }
  }

  const handleUnloadVST = async () => {
    setLoading(true)
    setError(null)

    const success = await unloadVST(trackId)
    
    setLoading(false)

    if (success) {
      setStatus('VST unloaded')
      if (onVSTUnloaded) onVSTUnloaded()
      setTimeout(() => {
        if (onClose) onClose()
      }, 500)
    } else {
      setError('Failed to unload VST')
    }
  }

  const filteredVSTs = searchQuery
    ? availableVSTs.filter(vst =>
        vst.name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : availableVSTs

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-gradient-to-b from-[#2d2d2d] to-[#1f1f1f] rounded-xl shadow-2xl w-[680px] max-h-[85vh] overflow-hidden border border-gray-700/50">
        {/* Header */}
        <div className="bg-gradient-to-r from-[#3a3a3a] to-[#2d2d2d] px-6 py-4 border-b border-gray-700/50">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-xl font-semibold text-white">Audio Unit Manager</h2>
              <p className="text-xs text-gray-400 mt-1">Select and manage VST3 instruments</p>
            </div>
            {onClose && (
              <button
                onClick={onClose}
                className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
              >
                <span className="text-2xl leading-none">×</span>
              </button>
            )}
          </div>
        </div>

        <div className="p-6 overflow-y-auto max-h-[calc(85vh-140px)]">
          {/* Current VST Status */}
          {useVSTBackend && currentVSTPath && (
            <div className="mb-6 p-4 bg-emerald-600/20 border border-emerald-500/50 rounded-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-emerald-600/40 rounded-lg flex items-center justify-center text-xl">
                    🎛️
                  </div>
                  <div>
                    <p className="text-sm font-medium text-emerald-300">Currently Loaded</p>
                    <p className="text-xs text-gray-300 truncate max-w-[400px]">
                      {currentVSTPath.split('\\').pop().replace('.vst3', '')}
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleUnloadVST}
                  disabled={loading}
                  className="px-4 py-2 bg-red-600/80 hover:bg-red-600 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? 'Unloading...' : 'Unload'}
                </button>
              </div>
            </div>
          )}

          {status && (
            <div className="mb-4 p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-300 text-sm flex items-center gap-2">
              <span>✓</span>
              <span>{status}</span>
            </div>
          )}

          {error && (
            <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-300 text-sm flex items-center gap-2">
              <span>⚠</span>
              <span>{error}</span>
            </div>
          )}

          {scanning ? (
            <div className="text-center py-12">
              <div className="animate-spin inline-block w-10 h-10 border-4 border-gray-700 border-t-emerald-500 rounded-full mb-4"></div>
              <p className="text-gray-400">Scanning for VST plugins...</p>
            </div>
          ) : (
            <>
              {!showManualInput && availableVSTs.length > 0 && (
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-3">
                    <label className="text-sm font-medium text-gray-300">
                      Available Plugins
                    </label>
                    <span className="text-xs text-gray-500">{filteredVSTs.length} of {availableVSTs.length}</span>
                  </div>
                  
                  {/* Search Input */}
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search plugins..."
                    className="w-full bg-[#1a1a1a] text-white px-4 py-2.5 rounded-lg border border-gray-700 focus:outline-none focus:border-emerald-500 mb-3 text-sm"
                  />

                  <div className="max-h-[320px] overflow-y-auto rounded-lg border border-gray-700 bg-[#1a1a1a]">
                    {filteredVSTs.length > 0 ? (
                      filteredVSTs.map((vst, index) => (
                        <button
                          key={index}
                          onClick={() => {
                            setSelectedVST(vst)
                            setError(null)
                          }}
                          className={`w-full text-left px-4 py-3 border-b border-gray-800 last:border-b-0 transition-all ${
                            selectedVST?.path === vst.path
                              ? 'bg-emerald-600/30 border-l-4 border-l-emerald-500'
                              : 'hover:bg-gray-800/50 border-l-4 border-l-transparent'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-lg ${
                              selectedVST?.path === vst.path ? 'bg-emerald-600/40' : 'bg-gray-700/50'
                            }`}>
                              🎹
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-white text-sm">{vst.name}</div>
                              <div className="text-xs text-gray-500 truncate">{vst.path}</div>
                            </div>
                            {selectedVST?.path === vst.path && (
                              <div className="text-emerald-400 text-lg">✓</div>
                            )}
                          </div>
                        </button>
                      ))
                    ) : (
                      <div className="p-8 text-center text-gray-500 text-sm">
                        No plugins match your search
                      </div>
                    )}
                  </div>
                </div>
              )}

              {(showManualInput || availableVSTs.length === 0) && (
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    {availableVSTs.length === 0 ? 'No VSTs found - Enter path manually' : 'Custom Path'}
                  </label>
                  <input
                    type="text"
                    value={vstPath}
                    onChange={(e) => setVstPath(e.target.value)}
                    placeholder="C:\\Program Files\\Common Files\\VST3\\YourPlugin.vst3"
                    className="w-full bg-[#1a1a1a] text-white px-4 py-2.5 rounded-lg border border-gray-700 focus:outline-none focus:border-emerald-500 text-sm font-mono"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleLoadVST()
                    }}
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="bg-[#2d2d2d] px-6 py-4 border-t border-gray-700/50 flex justify-between items-center">
          <div className="flex gap-2">
            {!showManualInput && availableVSTs.length > 0 && (
              <button
                onClick={() => setShowManualInput(true)}
                className="px-4 py-2 bg-gray-700/50 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors text-sm font-medium"
              >
                Custom Path
              </button>
            )}
            {showManualInput && availableVSTs.length > 0 && (
              <button
                onClick={() => {
                  setShowManualInput(false)
                  setVstPath('')
                }}
                className="px-4 py-2 bg-gray-700/50 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors text-sm font-medium"
              >
                Show List
              </button>
            )}
          </div>
          <div className="flex gap-3">
            {onClose && (
              <button
                onClick={onClose}
                className="px-5 py-2.5 bg-gray-700/50 hover:bg-gray-700 text-white rounded-lg transition-colors font-medium"
              >
                Cancel
              </button>
            )}
            <button
              onClick={() => handleLoadVST()}
              disabled={loading || (!selectedVST && !vstPath.trim())}
              className="px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-600 text-white rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed font-medium shadow-lg shadow-emerald-600/20"
            >
              {loading ? 'Loading...' : 'Load Plugin'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
