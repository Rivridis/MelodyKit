import { useState, useEffect, useRef, useMemo } from 'react'

function InstrumentSelector({ isOpen, onClose, onSelectInstrument, currentInstrument, isLoadingInstrument }) {
  const [instruments, setInstruments] = useState([])
  const [selectedCategory, setSelectedCategory] = useState(null)
  const [isLoading, setIsLoading] = useState(true)

  // Helper to strictly derive the folder name from each instrument
  const getFolderName = (instrument) => {
    if (!instrument) return ''
    if (instrument.folderName) return instrument.folderName
    if (instrument.samplePath) {
      // samplePath expected format: resources/<Folder>/<File>
      const normalized = instrument.samplePath.replaceAll('\\', '/')
      const parts = normalized.split('/')
      if (parts.length >= 3) return parts[1]
    }
    // Fallback to category if provided
    return instrument.category || ''
  }

  // Load available instruments from resources folder
  useEffect(() => {
    if (isOpen) {
      loadInstruments()
    }
  }, [isOpen])

  const loadInstruments = async () => {
    setIsLoading(true)
    try {
      // Use electron API to read resources folder
      const instrumentList = await window.api.getInstruments()
      setInstruments(instrumentList)
    } catch (error) {
      console.error('Failed to load instruments:', error)
      // Fallback to hardcoded list if API not available
      setInstruments([
        {
          name: 'Grand Piano',
          category: 'Piano',
          icon: '🎹',
          samplePath: 'resources/Piano/Grand Piano.sf2'
        }
      ])
    }
    setIsLoading(false)
  }

  const categories = useMemo(() => {
    const unique = Array.from(new Set(instruments.map(i => getFolderName(i))))
    unique.sort((a, b) => a.localeCompare(b))
    return unique
  }, [instruments])

  const filteredInstruments = selectedCategory
    ? instruments.filter(i => getFolderName(i) === selectedCategory)
    : []

  const handleInstrumentClick = (instrument) => {
    onSelectInstrument(instrument)
    // Don't close immediately - let the loading state show
  }

  const handleCategoryClick = (category) => {
    setSelectedCategory(category)
  }

  const handleBackToCategories = () => {
    setSelectedCategory(null)
  }

  if (!isOpen) return null

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div 
        className="w-[800px] h-[600px] bg-gradient-to-br from-zinc-900 to-zinc-950 rounded-2xl shadow-2xl border border-zinc-700 flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-700 bg-zinc-800/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {selectedCategory && (
                <button
                  onClick={handleBackToCategories}
                  className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors"
                  title="Back to categories"
                >
                  ←
                </button>
              )}
              <h2 className="text-2xl font-bold text-white">
                {selectedCategory ? selectedCategory : 'Choose Category'}
              </h2>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors"
              title="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content Grid */}
        <div className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-zinc-500 text-lg">Loading...</div>
            </div>
          ) : !selectedCategory ? (
            /* Categories Grid */
            categories.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-zinc-500 text-lg">No categories found</div>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-4">
                {categories.map((category) => {
                  const categoryInstruments = instruments.filter(i => getFolderName(i) === category)
                  const icon = categoryInstruments[0]?.icon || '🎵'
                  const count = categoryInstruments.length
                  
                  return (
                    <button
                      key={category}
                      onClick={() => handleCategoryClick(category)}
                      className="group relative p-6 rounded-xl transition-all duration-200 flex flex-col items-center gap-3 bg-zinc-800/80 hover:bg-zinc-700/80 cursor-pointer hover:scale-105"
                    >
                      {/* Icon */}
                      <div className="text-5xl transition-transform group-hover:scale-110">
                        {icon}
                      </div>

                      {/* Category Name */}
                      <div className="text-center">
                        <div className="font-semibold text-sm text-zinc-200 group-hover:text-white">
                          {category}
                        </div>
                        <div className="text-xs mt-1 text-zinc-500 group-hover:text-zinc-400">
                          {count} {count === 1 ? 'instrument' : 'instruments'}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )
          ) : (
            /* Instruments Grid */
            filteredInstruments.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-zinc-500 text-lg">No instruments found</div>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-4">
                {filteredInstruments.map((instrument) => (
                  <button
                    key={
                      instrument.samplePath ||
                      (instrument.folderName && instrument.fileName
                        ? `${instrument.folderName}/${instrument.fileName}`
                        : `${getFolderName(instrument)}:${instrument.name}`)
                    }
                    onClick={() => handleInstrumentClick(instrument)}
                    disabled={isLoadingInstrument}
                    className={`group relative p-6 rounded-xl transition-all duration-200 flex flex-col items-center gap-3 ${
                      currentInstrument?.name === instrument.name
                        ? 'bg-blue-600 shadow-lg shadow-blue-500/50 scale-105'
                        : 'bg-zinc-800/80 hover:bg-zinc-700/80'
                    } ${isLoadingInstrument ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
                  >
                    {/* Selection indicator */}
                    {currentInstrument?.name === instrument.name && !isLoadingInstrument && (
                      <div className="absolute top-2 right-2 w-5 h-5 bg-white rounded-full flex items-center justify-center">
                        <span className="text-blue-600 text-xs">✓</span>
                      </div>
                    )}

                    {/* Loading indicator for currently loading instrument */}
                    {isLoadingInstrument && currentInstrument?.name === instrument.name && (
                      <div className="absolute top-2 right-2">
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      </div>
                    )}

                    {/* Icon */}
                    <div className="text-5xl transition-transform">
                      {instrument.icon}
                    </div>

                    {/* Name */}
                    <div className="text-center">
                      <div className={`font-semibold text-sm ${
                        currentInstrument?.name === instrument.name
                          ? 'text-white'
                          : 'text-zinc-200 group-hover:text-white'
                      }`}>
                        {instrument.name}
                      </div>
                    </div>

                    {/* Loading text */}
                    {isLoadingInstrument && currentInstrument?.name === instrument.name && (
                      <div className="absolute bottom-2 left-0 right-0 text-center text-xs text-white font-medium">
                        Loading...
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-zinc-800 bg-zinc-900/50">
          <div className="text-xs text-zinc-500 text-center">
            {isLoadingInstrument 
              ? 'Loading instrument...' 
              : selectedCategory 
                ? 'Click an instrument to select' 
                : 'Click a category to browse instruments'}
          </div>
        </div>
      </div>
    </div>
  )
}

export default InstrumentSelector
