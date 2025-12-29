#include "BackendHost.h"

#include <juce_core/juce_core.h>
#include <iostream>

// Custom audio callback that wraps AudioProcessorPlayer and applies gain
class GainAudioCallback : public juce::AudioIODeviceCallback {
public:
    GainAudioCallback(juce::AudioProcessorPlayer* player, float* gainPtr)
        : player(player), gainLinearPtr(gainPtr) {}
    
    void audioDeviceIOCallbackWithContext(const float* const* inputChannelData,
                                          int numInputChannels,
                                          float* const* outputChannelData,
                                          int numOutputChannels,
                                          int numSamples,
                                          const juce::AudioIODeviceCallbackContext& context) override {
        // Let the player process audio
        player->audioDeviceIOCallbackWithContext(inputChannelData, numInputChannels,
                                                  outputChannelData, numOutputChannels,
                                                  numSamples, context);
        
        // Apply gain to output
        const float gain = *gainLinearPtr;
        if (gain != 1.0f) {
            for (int ch = 0; ch < numOutputChannels; ++ch) {
                if (outputChannelData[ch]) {
                    juce::FloatVectorOperations::multiply(outputChannelData[ch], gain, numSamples);
                }
            }
        }
    }
    
    void audioDeviceAboutToStart(juce::AudioIODevice* device) override {
        player->audioDeviceAboutToStart(device);
    }
    
    void audioDeviceStopped() override {
        player->audioDeviceStopped();
    }
    
private:
    juce::AudioProcessorPlayer* player;
    float* gainLinearPtr;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(GainAudioCallback)
};

// Simple window to host the plugin's editor
class PluginEditorWindow : public juce::DocumentWindow {
public:
    PluginEditorWindow(juce::AudioProcessor* proc)
        : juce::DocumentWindow(proc->getName(), 
                                juce::Colours::black, 
                                juce::DocumentWindow::closeButton | juce::DocumentWindow::minimiseButton),
          processor(proc)
    {
        if (auto* editor = proc->createEditorIfNeeded()) {
            setContentOwned(editor, true);
            setResizable(false, false);
            centreWithSize(getWidth(), getHeight());
            setVisible(true);
            setUsingNativeTitleBar(true);
        }
    }

    ~PluginEditorWindow() override {
        // Clear content component before destruction to avoid double-deletion
        clearContentComponent();
    }

    void closeButtonPressed() override {
        setVisible(false);
    }

private:
    juce::AudioProcessor* processor;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PluginEditorWindow)
};

namespace {
// Utility to emit structured logs to stdout for the Electron bridge
void emit(const juce::String& msg) {
    std::cout << msg << std::endl;
    std::cout.flush();
}
}

BackendHost::BackendHost() {
    // Manually register VST3 format (addDefaultFormats is deleted in console builds)
#if JUCE_PLUGINHOST_VST3
    formatManager.addFormat(std::make_unique<juce::VST3PluginFormat>());
#endif
    prepareDevice();
}

BackendHost::~BackendHost() {
    const juce::ScopedLock sl(tracksLock);
    for (auto& [trackId, track] : tracks) {
        if (track.editorWindow) {
            track.editorWindow->setVisible(false);
            track.editorWindow.reset();
        }
        if (track.gainCallback) {
            deviceManager.removeAudioCallback(track.gainCallback.get());
        }
        if (track.player) {
            track.player->setProcessor(nullptr);
        }
    }
    tracks.clear();
}

void BackendHost::prepareDevice() {
    if (deviceManager.getCurrentAudioDevice() != nullptr) return;

    juce::String error = deviceManager.initialise(0, 2, nullptr, true, {}, nullptr);
    if (error.isNotEmpty()) {
        emit("ERROR AUDIO " + error);
    }
}

double BackendHost::getSampleRate() const {
    if (auto* device = deviceManager.getCurrentAudioDevice()) {
        return device->getCurrentSampleRate();
    }
    return 44100.0;
}

int BackendHost::getBlockSize() const {
    if (auto* device = deviceManager.getCurrentAudioDevice()) {
        return device->getCurrentBufferSizeSamples();
    }
    return 512;
}

std::unique_ptr<juce::AudioPluginInstance> BackendHost::createPlugin(
    const juce::File& file,
    double sampleRate,
    int blockSize,
    juce::String& errorMessage) {

    if (formatManager.getNumFormats() == 0) {
        errorMessage = "No plugin formats available (VST3 support may not be compiled)";
        return {};
    }

    juce::OwnedArray<juce::PluginDescription> types;
    for (int i = 0; i < formatManager.getNumFormats(); ++i) {
        if (auto* format = formatManager.getFormat(i)) {
            format->findAllTypesForFile(types, file.getFullPathName());
        }
    }

    if (types.isEmpty()) {
        errorMessage = "No plugin types found in file";
        return {};
    }

    return formatManager.createPluginInstance(*types[0], sampleRate, blockSize, errorMessage);
}

bool BackendHost::loadPlugin(const juce::String& trackId, const juce::File& file, juce::String& errorMessage) {
    prepareDevice();

    // Accept both files and directories (VST3 bundles are folders on Windows/macOS)
    if (!file.exists()) {
        errorMessage = "Path not found: " + file.getFullPathName();
        return false;
    }

    const double sr = getSampleRate();
    const int blockSize = getBlockSize();

    auto instance = createPlugin(file, sr, blockSize, errorMessage);
    if (instance == nullptr) {
        if (errorMessage.isEmpty()) errorMessage = "Unknown plugin load failure";
        return false;
    }

    const juce::ScopedLock sl(tracksLock);
    
    // Unload existing plugin for this track if any
    auto it = tracks.find(trackId);
    if (it != tracks.end()) {
        if (it->second.player) {
            deviceManager.removeAudioCallback(it->second.player.get());
            it->second.player->setProcessor(nullptr);
        }
        it->second.editorWindow.reset();
        it->second.plugin.reset();
        it->second.activeNoteTimers.clear();
    }
    
    // Create new track state
    TrackState& track = tracks[trackId];
    track.plugin = std::move(instance);
    track.player = std::make_unique<juce::AudioProcessorPlayer>();
    track.player->setProcessor(track.plugin.get());
    track.player->getMidiMessageCollector().reset(sr);
    track.gainLinear = 1.0f; // Default unity gain
    
    // Create gain wrapper callback
    track.gainCallback = std::make_unique<GainAudioCallback>(track.player.get(), &track.gainLinear);
    
    // Add the gain callback as an audio callback (not the player directly)
    deviceManager.addAudioCallback(track.gainCallback.get());

    emit("EVENT LOADED " + trackId + " " + file.getFullPathName());
    return true;
}

void BackendHost::unloadPlugin(const juce::String& trackId) {
    const juce::ScopedLock sl(tracksLock);
    
    auto it = tracks.find(trackId);
    if (it == tracks.end()) return;
    
    if (it->second.editorWindow) {
        it->second.editorWindow->setVisible(false);
        it->second.editorWindow.reset();
    }
    
    if (it->second.gainCallback) {
        deviceManager.removeAudioCallback(it->second.gainCallback.get());
    }
    
    if (it->second.player) {
        it->second.player->setProcessor(nullptr);
    }
    
    tracks.erase(it);
}

bool BackendHost::isPluginLoaded(const juce::String& trackId) const {
    const juce::ScopedLock sl(tracksLock);
    auto it = tracks.find(trackId);
    return it != tracks.end() && it->second.plugin != nullptr;
}

juce::String BackendHost::getLoadedPluginName(const juce::String& trackId) const {
    const juce::ScopedLock sl(tracksLock);
    auto it = tracks.find(trackId);
    if (it == tracks.end() || it->second.plugin == nullptr) return {};
    return it->second.plugin->getName();
}

bool BackendHost::playNote(const juce::String& trackId, int midiNote, float velocity01, int durationMs, int channel) {
    const juce::ScopedLock sl(tracksLock);
    
    auto it = tracks.find(trackId);
    if (it == tracks.end() || !it->second.plugin) return false;
    
    TrackState& track = it->second;
    velocity01 = juce::jlimit(0.0f, 1.0f, velocity01);
    
    // Send note-on immediately
    juce::MidiMessage on = juce::MidiMessage::noteOn(channel, midiNote, velocity01);
    track.player->getMidiMessageCollector().addMessageToQueue(on);

    // Schedule note-off using a Timer for reliable timing
    const int key = (channel << 8) | midiNote;
    
    // Cancel any existing timer for this note/channel
    track.activeNoteTimers.erase(key);
    
    // Create a lambda-based timer for the note-off
    class NoteOffTimerCallback : public juce::Timer {
    public:
        NoteOffTimerCallback(BackendHost* host, juce::String tid, int note, int chan, int timerKey)
            : hostPtr(host), trackId(tid), midiNote(note), channel(chan), key(timerKey) {}
        
        void timerCallback() override {
            if (hostPtr) {
                hostPtr->sendNoteOff(trackId, midiNote, channel);
                // Remove self from active timers
                const juce::ScopedLock sl(hostPtr->tracksLock);
                auto it = hostPtr->tracks.find(trackId);
                if (it != hostPtr->tracks.end()) {
                    it->second.activeNoteTimers.erase(key);
                }
            }
        }
        
    private:
        BackendHost* hostPtr;
        juce::String trackId;
        int midiNote;
        int channel;
        int key;
    };
    
    auto timer = std::make_unique<NoteOffTimerCallback>(this, trackId, midiNote, channel, key);
    timer->startTimer(durationMs);
    track.activeNoteTimers[key].timer = std::move(timer);

    return true;
}

void BackendHost::sendNoteOff(const juce::String& trackId, int midiNote, int channel) {
    const juce::ScopedLock sl(tracksLock);
    
    auto it = tracks.find(trackId);
    if (it == tracks.end() || !it->second.player) return;
    
    juce::MidiMessage off = juce::MidiMessage::noteOff(channel, midiNote);
    it->second.player->getMidiMessageCollector().addMessageToQueue(off);
}

void BackendHost::allNotesOff(const juce::String& trackId) {
    const juce::ScopedLock sl(tracksLock);
    
    if (trackId.isEmpty()) {
        // All tracks
        for (auto& [tid, track] : tracks) {
            track.activeNoteTimers.clear();
            for (int ch = 1; ch <= 16; ++ch) {
                auto msg = juce::MidiMessage::allNotesOff(ch);
                track.player->getMidiMessageCollector().addMessageToQueue(msg);
            }
        }
    } else {
        // Specific track
        auto it = tracks.find(trackId);
        if (it == tracks.end()) return;
        
        it->second.activeNoteTimers.clear();
        for (int ch = 1; ch <= 16; ++ch) {
            auto msg = juce::MidiMessage::allNotesOff(ch);
            it->second.player->getMidiMessageCollector().addMessageToQueue(msg);
        }
    }
}

bool BackendHost::setTrackVolume(const juce::String& trackId, int volume, int channel) {
    const juce::ScopedLock sl(tracksLock);
    
    auto it = tracks.find(trackId);
    if (it == tracks.end() || !it->second.player) return false;
    
    // Clamp volume to MIDI range 0-127
    volume = juce::jlimit(0, 127, volume);
    
    // Convert MIDI 0-127 to linear gain (0.0 to 2.0)
    // MIDI 0 = silent, 64 = unity (1.0), 127 = +6dB (~2.0)
    it->second.gainLinear = (volume / 64.0f);
    
    // Also send MIDI CC 7 for plugins that support it
    juce::MidiMessage volumeMsg = juce::MidiMessage::controllerEvent(channel, 7, volume);
    it->second.player->getMidiMessageCollector().addMessageToQueue(volumeMsg);
    
    return true;
}

bool BackendHost::openEditor(const juce::String& trackId, juce::String& errorMessage) {
    const juce::ScopedLock sl(tracksLock);
    
    auto it = tracks.find(trackId);
    if (it == tracks.end() || !it->second.plugin) {
        errorMessage = "No plugin loaded for track " + trackId;
        return false;
    }
    
    TrackState& track = it->second;
    
    if (!track.plugin->hasEditor()) {
        errorMessage = "Plugin does not have an editor";
        return false;
    }
    
    if (track.editorWindow && track.editorWindow->isVisible()) {
        track.editorWindow->toFront(true);
        return true;
    }
    
    // Close any existing window first
    if (track.editorWindow) {
        track.editorWindow.reset();
    }
    
    try {
        track.editorWindow = std::make_unique<PluginEditorWindow>(track.plugin.get());
        if (!track.editorWindow->isVisible()) {
            errorMessage = "Failed to make editor window visible";
            track.editorWindow.reset();
            return false;
        }
        return true;
    } catch (const std::exception& e) {
        errorMessage = juce::String("Failed to create editor window: ") + e.what();
        track.editorWindow.reset();
        return false;
    }
}

void BackendHost::closeEditor(const juce::String& trackId) {
    const juce::ScopedLock sl(tracksLock);
    
    auto it = tracks.find(trackId);
    if (it == tracks.end()) return;
    
    TrackState& track = it->second;
    
    if (track.editorWindow) {
        // Get the editor before destroying window
        auto* editor = track.plugin ? track.plugin->getActiveEditor() : nullptr;
        
        track.editorWindow->setVisible(false);
        track.editorWindow.reset();
        
        // Notify plugin that editor is being deleted
        if (track.plugin && editor) {
            track.plugin->editorBeingDeleted(editor);
        }
    }
}

bool BackendHost::isEditorOpen(const juce::String& trackId) const {
    const juce::ScopedLock sl(tracksLock);
    
    auto it = tracks.find(trackId);
    if (it == tracks.end()) return false;
    
    return it->second.editorWindow != nullptr && it->second.editorWindow->isVisible();
}

bool BackendHost::renderToWav(const std::vector<MidiNoteEvent>& notes,
                               const juce::File& outputPath,
                               juce::String& errorMessage,
                               double sampleRate,
                               int bitDepth) {
    if (notes.empty()) {
        errorMessage = "No MIDI notes to render";
        return false;
    }
    
    // Validate bit depth
    if (bitDepth != 16 && bitDepth != 24 && bitDepth != 32) {
        errorMessage = "Invalid bit depth. Must be 16, 24, or 32";
        return false;
    }
    
    const juce::ScopedLock sl(tracksLock);
    
    // Find the total duration needed (last note end time)
    double totalDuration = 0.0;
    for (const auto& note : notes) {
        double endTime = note.startTimeSeconds + note.durationSeconds;
        if (endTime > totalDuration) {
            totalDuration = endTime;
        }
    }
    
    // Add 2 seconds of tail for reverb/delay effects
    totalDuration += 2.0;
    
    const int blockSize = 512;
    const int totalSamples = static_cast<int>(totalDuration * sampleRate);
    const int numChannels = 2; // Stereo output
    
    // Create output buffer
    juce::AudioBuffer<float> renderBuffer(numChannels, totalSamples);
    renderBuffer.clear();
    
    // Group notes by track ID
    std::map<juce::String, std::vector<const MidiNoteEvent*>> notesByTrack;
    for (const auto& note : notes) {
        notesByTrack[note.trackId].push_back(&note);
    }
    
    // Process each track separately, then mix
    for (const auto& [trackId, trackNotes] : notesByTrack) {
        auto trackIt = tracks.find(trackId);
        if (trackIt == tracks.end() || !trackIt->second.plugin) {
            emit("WARNING: Track " + trackId + " not found or has no plugin loaded, skipping");
            continue;
        }
        
        auto* plugin = trackIt->second.plugin.get();
        
        // Prepare plugin for rendering
        plugin->prepareToPlay(sampleRate, blockSize);
        plugin->setNonRealtime(true); // Enable offline rendering mode
        
        // Create temporary buffer for this track
        juce::AudioBuffer<float> trackBuffer(numChannels, totalSamples);
        trackBuffer.clear();
        
        juce::MidiBuffer midiBuffer;
        
        // Sort notes by start time for this track
        std::vector<const MidiNoteEvent*> sortedNotes = trackNotes;
        std::sort(sortedNotes.begin(), sortedNotes.end(),
                  [](const MidiNoteEvent* a, const MidiNoteEvent* b) {
                      return a->startTimeSeconds < b->startTimeSeconds;
                  });
        
        // Build MIDI message timeline
        std::vector<std::pair<int, juce::MidiMessage>> midiTimeline;
        for (const auto* note : sortedNotes) {
            int samplePos = static_cast<int>(note->startTimeSeconds * sampleRate);
            int noteOffPos = static_cast<int>((note->startTimeSeconds + note->durationSeconds) * sampleRate);
            
            // Clamp to valid range
            samplePos = juce::jlimit(0, totalSamples - 1, samplePos);
            noteOffPos = juce::jlimit(0, totalSamples - 1, noteOffPos);
            
            float velocity = juce::jlimit(0.0f, 1.0f, note->velocity01);
            
            midiTimeline.push_back({samplePos, juce::MidiMessage::noteOn(note->channel, note->midiNote, velocity)});
            midiTimeline.push_back({noteOffPos, juce::MidiMessage::noteOff(note->channel, note->midiNote)});
        }
        
        // Sort MIDI timeline by sample position
        std::sort(midiTimeline.begin(), midiTimeline.end(),
                  [](const auto& a, const auto& b) { return a.first < b.first; });
        
        // Process audio in blocks
        int currentSample = 0;
        size_t midiIndex = 0;
        
        while (currentSample < totalSamples) {
            const int samplesThisBlock = juce::jmin(blockSize, totalSamples - currentSample);
            
            // Clear MIDI buffer for this block
            midiBuffer.clear();
            
            // Add MIDI messages that occur in this block
            while (midiIndex < midiTimeline.size()) {
                const auto& [samplePos, msg] = midiTimeline[midiIndex];
                
                if (samplePos < currentSample) {
                    // Skip past messages (shouldn't happen with sorted timeline)
                    ++midiIndex;
                    continue;
                }
                
                if (samplePos >= currentSample + samplesThisBlock) {
                    // Future message, process in next block
                    break;
                }
                
                // Add message at relative position within block
                int relativePos = samplePos - currentSample;
                midiBuffer.addEvent(msg, relativePos);
                ++midiIndex;
            }
            
            // Create a slice of the track buffer for this block
            juce::AudioBuffer<float> blockBuffer(
                trackBuffer.getArrayOfWritePointers(),
                numChannels,
                currentSample,
                samplesThisBlock
            );
            
            // Process the block
            plugin->processBlock(blockBuffer, midiBuffer);
            
            currentSample += samplesThisBlock;
        }
        
        // Reset plugin state
        plugin->setNonRealtime(false);
        plugin->releaseResources();
        plugin->prepareToPlay(getSampleRate(), getBlockSize());
        
        // Apply track gain to the rendered audio
        const float trackGain = trackIt->second.gainLinear;
        if (trackGain != 1.0f) {
            trackBuffer.applyGain(trackGain);
        }
        
        // Mix track buffer into main render buffer
        for (int ch = 0; ch < numChannels; ++ch) {
            renderBuffer.addFrom(ch, 0, trackBuffer, ch, 0, totalSamples);
        }
    }
    
    // Normalize the output to prevent clipping
    float maxLevel = renderBuffer.getMagnitude(0, totalSamples);
    if (maxLevel > 0.99f) {
        float gain = 0.99f / maxLevel;
        renderBuffer.applyGain(gain);
    }
    
    // Write to WAV file
    outputPath.deleteFile(); // Remove if exists
    
    std::unique_ptr<juce::FileOutputStream> outStream(outputPath.createOutputStream());
    if (!outStream) {
        errorMessage = "Failed to create output file: " + outputPath.getFullPathName();
        return false;
    }
    
    juce::WavAudioFormat wavFormat;
    int bitsPerSample = bitDepth;
    
    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFormat.createWriterFor(outStream.get(), sampleRate, numChannels,
                                  bitsPerSample, {}, 0)
    );
    
    if (!writer) {
        errorMessage = "Failed to create WAV writer";
        return false;
    }
    
    outStream.release(); // Writer now owns the stream
    
    if (!writer->writeFromAudioSampleBuffer(renderBuffer, 0, totalSamples)) {
        errorMessage = "Failed to write audio data to file";
        return false;
    }
    
    writer.reset(); // Flush and close
    
    emit("EVENT RENDERED " + outputPath.getFullPathName());
    return true;
}
