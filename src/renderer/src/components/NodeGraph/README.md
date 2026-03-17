# MelodyKit Node-Based Effects Editor

## Overview

The Node-Based Effects Editor provides a professional, Blender-like interface for mixing and routing effects across tracks. This document explains how to use the system.

## Key Features

### 1. **Default Nodes**
- **Master Node**: Always visible on the right side. All audio ultimately mixes to the master.
- **Track Nodes**: One node per track, positioned on the left. Shows track name and color matching the track list.

### 2. **Effect Nodes**
- Add effect nodes by selecting a track and clicking "+ Add Effect"
- Available effects:
  - **Reverb**: Adds spacious ambience (wet, decay)
  - **Delay**: Time-based feedback effect (time, feedback, wet)
  - **Chorus**: Modulation effect (rate, depth, wet)
  - **Distortion**: Drive signal for grit (drive, tone)
  - **Compressor**: Dynamic range control (threshold, ratio, attack, release)
  - **EQ (Low/Mid/High)**: Frequency-specific gain boost/cut (frequency, gain)
  - **Phaser**: Phase-based modulation (rate, depth)
  - **Flanger**: Flanging effect (rate, depth)

### 3. **Controls Panel**
- Click any effect node to show the Controls Panel (bottom-left)
- Adjust effect parameters with sliders
- Changes persist until you delete the node

## How to Use

### Accessing the Node Editor

1. **From Timeline View**: Click the "node editor" button at the top of the track timeline
2. **Return to Timeline**: Click "← Back to Timeline" in the node editor header

### Creating Effect Chains

**Example: Adding reverb to a track**

1. Click a track node to select it
2. Click "+ Add Effect" button
3. Select "Reverb" from the menu
4. A new Reverb node appears connected between the track and master
5. Click the Reverb node to show its controls
6. Adjust the "Wet" and "Decay" sliders

**Example: Layering multiple effects**

1. Create the first effect (e.g., Delay)
2. With Delay selected, click "+ Add Effect" again
3. Select another effect (e.g., Reverb)
4. The new effect is now inserted after Delay in the chain

### Managing Nodes and Connections

**Move a Node**
- Click and drag any node to reposition it on the canvas

**Delete a Node**
- Click the red "×" button in the top-right corner of the node
- The connection chain is automatically reconnected (previous → next)

**Remove a Connection**
- Click on the blue connecting line between two nodes
- The connection is removed

**Manually Connect Nodes**
- Drag from the blue output socket (right side) of one node
- Drop on the green input socket (left side) of another node
- Only valid connections are allowed (output to input)

### Canvas Navigation

**Panning**: Right-click and drag to move the canvas
**Zooming**: Scroll wheel to zoom in/out
**Selecting**: Click any node to select it and show its controls

## Node Structure

```
Track Node (colored, left side)
    ↓
Effect Node 1 (yellow, draggable) — controls shown on click
    ↓
Effect Node 2 (yellow, draggable) — controls shown on click
    ↓
... (chain as many as needed) ...
    ↓
Master Node (purple, right side, locked)
```

## Effect Parameters Guide

### Reverb
- **Wet**: 0–1 (dry to fully wet, typically 0.3)
- **Decay**: 0.1–5 seconds (room size, typically 2)

### Delay
- **Time**: 0.01–2 seconds (delay in time)
- **Feedback**: 0–0.99 (how much repeats, typically 0.4)
- **Wet**: 0–1 (mix, typically 0.3)

### Chorus/Phaser/Flanger
- **Rate**: 0.1–10 Hz (modulation speed)
- **Depth**: 0–1 (modulation amount)
- **Wet** (Chorus): 0–1 (mix)

### Distortion
- **Drive**: 0–1 (amount of saturation)
- **Tone**: 0–1 (brightness of distortion)

### Compressor
- **Threshold**: -60–0 dB (level above which compression kicks in)
- **Ratio**: 1–20 (compression ratio, 4:1 is typical)
- **Attack**: 0.001–0.5 seconds (how quickly it engages)
- **Release**: 0.01–3 seconds (how quickly it releases)

### EQ (Low/Mid/High)
- **Frequency**: 20–20000 Hz (target frequency)
- **Gain**: -24–24 dB (boost or cut at that frequency)

## Tips & Tricks

1. **Subtle Effects**: Start with low wet values (0.2–0.4) for most effects
2. **Feedback Chains**: Be careful with delay feedback to avoid infinite loops
3. **Compression First**: In mastering chains, place compressor before EQ
4. **Multiple Tracks**: Create identical chains on different tracks for cohesion
5. **Organization**: Arrange nodes spatially to represent your mix visually

## Limitations & Notes

- Effect nodes are visual/organizational only; actual audio processing depends on VST integration
- Master node cannot be deleted or moved
- Track nodes update automatically when you add/remove tracks in the timeline
- Node graph state is saved with your project

## Future Enhancements

Potential improvements could include:
- Preset saving/loading for effect chains
- Automation UI for effect parameters over time
- Waveform visualization at connection points
- More advanced effect types (convolver, granular, etc.)
- Node grouping/organization folders

## Troubleshooting

**Nodes not connecting?**
- Connections only work from output (blue, right) to input (green, left)
- Cannot connect a node to itself
- Existing connections redirect when inserting nodes

**Controls not showing?**
- Click on an effect node to display its control panel
- Only effect nodes show parameters; track and master nodes don't have controls

**Visual glitches?**
- Try zooming out and back in to refresh the canvas
- Right-click to pan if nodes go off-screen
