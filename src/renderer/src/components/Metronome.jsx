import { useState, useEffect, useRef } from 'react'

function Metronome({ bpm, isPlaying, onPlayingChange }) {
  const [beat, setBeat] = useState(0) // Current beat (0-3 for 4/4 time)
  const intervalRef = useRef(null)
  const audioContextRef = useRef(null)

  // Initialize audio context
  useEffect(() => {
    audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)()
    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close()
      }
    }
  }, [])

  // Play metronome tick sound - wooden metronome style
  const playTick = (isAccent = false) => {
    if (!audioContextRef.current) return
    
    const ctx = audioContextRef.current
    const now = ctx.currentTime
    
    // Create a short, sharp wooden "clack" sound
    // Mix of noise and pitched component for mechanical feel
    
    // Pitched component (lower frequencies for wooden sound)
    const oscillator = ctx.createOscillator()
    const oscGain = ctx.createGain()
    
    oscillator.type = 'triangle' // Warmer than sine
    oscillator.frequency.value = isAccent ? 1200 : 900
    
    oscillator.connect(oscGain)
    oscGain.connect(ctx.destination)
    
    // Sharp attack and decay for wooden clack
    oscGain.gain.setValueAtTime(isAccent ? 0.3 : 0.18, now)
    oscGain.gain.exponentialRampToValueAtTime(0.01, now + 0.02)
    
    oscillator.start(now)
    oscillator.stop(now + 0.02)
    
    // Add noise burst for mechanical texture
    const bufferSize = ctx.sampleRate * 0.03
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
    const output = noiseBuffer.getChannelData(0)
    
    for (let i = 0; i < bufferSize; i++) {
      output[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.1))
    }
    
    const noise = ctx.createBufferSource()
    const noiseGain = ctx.createGain()
    const filter = ctx.createBiquadFilter()
    
    noise.buffer = noiseBuffer
    filter.type = 'highpass'
    filter.frequency.value = 2000 // High-frequency click for wood texture
    
    noise.connect(filter)
    filter.connect(noiseGain)
    noiseGain.connect(ctx.destination)
    
    noiseGain.gain.setValueAtTime(isAccent ? 0.25 : 0.15, now)
    noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.015)
    
    noise.start(now)
    noise.stop(now + 0.03)
  }

  // Handle metronome timing
  useEffect(() => {
    if (isPlaying) {
      // Calculate interval in milliseconds (60000ms per minute / BPM)
      const interval = 60000 / bpm
      
      let currentBeat = 0
      playTick(true) // Play first beat immediately
      
      intervalRef.current = setInterval(() => {
        currentBeat = (currentBeat + 1) % 4
        setBeat(currentBeat)
        playTick(currentBeat === 0) // Accent first beat
      }, interval)
      
      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current)
        }
      }
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
      setBeat(0)
    }
  }, [isPlaying, bpm])

  return (
    <div className="flex items-center gap-2 px-3 border-l border-zinc-800">
      <button
        onClick={() => onPlayingChange?.(!isPlaying)}
        className={`flex items-center justify-center w-7 h-7 rounded transition ${
          isPlaying 
            ? 'bg-zinc-800 text-amber-300 hover:bg-zinc-700' 
            : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
        }`}
        title={isPlaying ? 'Stop metronome' : 'Start metronome'}
      >
        {isPlaying ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <rect x="2" y="2" width="2" height="6"/>
            <rect x="6" y="2" width="2" height="6"/>
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <path d="M2 2l6 3.5L2 9V2z"/>
          </svg>
        )}
      </button>
      
      {/* Beat indicator */}
      <div className="flex items-center gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`w-1.5 h-1.5 rounded-full transition-all ${
              isPlaying && beat === i
                ? i === 0 
                  ? 'bg-amber-300 scale-125' 
                  : 'bg-amber-400 scale-125'
                : 'bg-zinc-700'
            }`}
          />
        ))}
      </div>
      
      <span className="text-xs text-zinc-400 ml-1">{bpm} BPM</span>
    </div>
  )
}

export default Metronome
