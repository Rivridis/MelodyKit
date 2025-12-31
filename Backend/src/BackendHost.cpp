#define TSF_IMPLEMENTATION
#include "../TinySoundFont/tsf.h"

#include "BackendHost.h"

#include <juce_core/juce_core.h>
#include <algorithm>
#include <iostream>
#include <cmath>

// SF2 audio callback for TinySoundFont rendering
class SF2AudioCallback : public juce::AudioIODeviceCallback {
public:
    SF2AudioCallback(tsf* soundFont, float* gainPtr, double sampleRate)
        : sf(soundFont), gainLinearPtr(gainPtr), bufferSampleRate(sampleRate) {
        if (sf) {
            tsf_set_output(sf, TSF_STEREO_INTERLEAVED, (int)sampleRate, 0.0f);
            tsf_set_max_voices(sf, 256); // Pre-allocate voices for thread safety
        }
    }
    
    void audioDeviceIOCallbackWithContext(const float* const* inputChannelData,
                                          int numInputChannels,
                                          float* const* outputChannelData,
                                          int numOutputChannels,
                                          int numSamples,
                                          const juce::AudioIODeviceCallbackContext& context) override {
        if (!sf || numOutputChannels < 1) {
            // Clear output
            for (int ch = 0; ch < numOutputChannels; ++ch) {
                if (outputChannelData[ch]) {
                    juce::FloatVectorOperations::clear(outputChannelData[ch], numSamples);
                }
            }
            return;
        }
        
        // Render SF2 audio (interleaved stereo)
        tempBuffer.resize(numSamples * 2); // stereo interleaved
        tsf_render_float(sf, tempBuffer.data(), numSamples, 0);
        
        // Deinterleave and apply gain
        const float gain = *gainLinearPtr;
        if (numOutputChannels >= 2) {
            // Stereo output
            for (int i = 0; i < numSamples; ++i) {
                outputChannelData[0][i] = tempBuffer[i * 2] * gain;
                outputChannelData[1][i] = tempBuffer[i * 2 + 1] * gain;
            }
        } else {
            // Mono output - mix stereo to mono
            for (int i = 0; i < numSamples; ++i) {
                outputChannelData[0][i] = (tempBuffer[i * 2] + tempBuffer[i * 2 + 1]) * 0.5f * gain;
            }
        }
        
        // Clear additional channels
        for (int ch = 2; ch < numOutputChannels; ++ch) {
            if (outputChannelData[ch]) {
                juce::FloatVectorOperations::clear(outputChannelData[ch], numSamples);
            }
        }
    }
    
    void audioDeviceAboutToStart(juce::AudioIODevice* device) override {
        if (device && sf) {
            double newRate = device->getCurrentSampleRate();
            if (newRate != bufferSampleRate) {
                bufferSampleRate = newRate;
                tsf_set_output(sf, TSF_STEREO_INTERLEAVED, (int)newRate, 0.0f);
            }
        }
    }
    
    void audioDeviceStopped() override {
        if (sf) {
            tsf_note_off_all(sf);
        }
    }
    
    tsf* getSoundFont() const { return sf; }
    
private:
    tsf* sf;
    float* gainLinearPtr;
    double bufferSampleRate;
    std::vector<float> tempBuffer;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(SF2AudioCallback)
};

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

// Shared beat-sample mixer across all beat tracks
class BeatAudioCallback : public juce::AudioIODeviceCallback {
public:
    BeatAudioCallback(
        std::map<juce::String, std::map<juce::String, std::shared_ptr<BeatSample>>>& samples,
        std::map<juce::String, std::vector<BackendHost::BeatVoice>>& voices,
        juce::CriticalSection& lock)
        : sampleMap(samples), voiceMap(voices), mapLock(lock) {}

    void audioDeviceIOCallbackWithContext(const float* const* /*inputChannelData*/,
                                          int /*numInputChannels*/,
                                          float* const* outputChannelData,
                                          int numOutputChannels,
                                          int numSamples,
                                          const juce::AudioIODeviceCallbackContext& /*context*/) override {
        if (!outputChannelData || numSamples <= 0 || numOutputChannels <= 0) return;

        // Clear output buffer before mixing beat voices to avoid stale data buzzing
        for (int ch = 0; ch < numOutputChannels; ++ch) {
            if (outputChannelData[ch]) {
                juce::FloatVectorOperations::clear(outputChannelData[ch], numSamples);
            }
        }

        const juce::ScopedLock sl(mapLock);
        juce::ignoreUnused(sampleMap);
        if (voiceMap.empty()) return;

        for (auto& [trackId, voices] : voiceMap) {
            juce::ignoreUnused(trackId);
            for (auto it = voices.begin(); it != voices.end();) {
                auto& voice = *it;
                auto samplePtr = voice.sample;
                if (!samplePtr || samplePtr->buffer.getNumSamples() == 0) {
                    it = voices.erase(it);
                    continue;
                }

                const int sourceSamples = samplePtr->buffer.getNumSamples();
                const int sourceChannels = samplePtr->buffer.getNumChannels();
                const double ratio = (currentRate > 0.0) ? (samplePtr->sampleRate / currentRate) : 1.0;

                double pos = voice.position;
                bool finished = false;

                for (int i = 0; i < numSamples; ++i) {
                    const int idx = static_cast<int>(pos);
                    if (idx >= sourceSamples) { finished = true; break; }

                    const double frac = pos - static_cast<double>(idx);

                    for (int ch = 0; ch < numOutputChannels; ++ch) {
                        if (!outputChannelData[ch]) continue;
                        const int srcCh = (sourceChannels == 1) ? 0 : juce::jmin(ch, sourceChannels - 1);
                        const float s0 = samplePtr->buffer.getSample(srcCh, idx);
                        const float s1 = (idx + 1 < sourceSamples) ? samplePtr->buffer.getSample(srcCh, idx + 1) : 0.0f;
                        const float blended = static_cast<float>((1.0 - frac) * s0 + frac * s1);
                        outputChannelData[ch][i] += blended * voice.gain;
                    }

                    pos += ratio;
                }

                voice.position = pos;
                if (finished || pos >= sourceSamples) {
                    it = voices.erase(it);
                } else {
                    ++it;
                }
            }
        }
    }

    void audioDeviceAboutToStart(juce::AudioIODevice* device) override {
        currentRate = device ? device->getCurrentSampleRate() : 44100.0;
    }

    void audioDeviceStopped() override {
        currentRate = 44100.0;
    }

private:
    std::map<juce::String, std::map<juce::String, std::shared_ptr<BeatSample>>>& sampleMap;
    std::map<juce::String, std::vector<BackendHost::BeatVoice>>& voiceMap;
    juce::CriticalSection& mapLock;
    double currentRate = 44100.0;
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
    beatFormatManager.registerBasicFormats();
    prepareDevice();

    // Shared beat mixer callback (handles all beat tracks)
    beatCallback = std::make_unique<BeatAudioCallback>(beatSamples, beatVoices, beatLock);
    deviceManager.addAudioCallback(beatCallback.get());
}

BackendHost::~BackendHost() {
    if (beatCallback) {
        deviceManager.removeAudioCallback(beatCallback.get());
        beatCallback.reset();
    }
    const juce::ScopedLock sl(tracksLock);
    for (auto& [trackId, track] : tracks) {
        if (track.editorWindow) {
            track.editorWindow->setVisible(false);
            track.editorWindow.reset();
        }
        if (track.sf2Callback) {
            deviceManager.removeAudioCallback(track.sf2Callback.get());
        }
        if (track.gainCallback) {
            deviceManager.removeAudioCallback(track.gainCallback.get());
        }
        if (track.player) {
            track.player->setProcessor(nullptr);
        }
        if (track.soundFont) {
            tsf_close(track.soundFont);
            track.soundFont = nullptr;
        }
    }
    tracks.clear();

    {
        const juce::ScopedLock bl(beatLock);
        beatSamples.clear();
        beatVoices.clear();
    }
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
        // IMPORTANT: Remove audio callbacks BEFORE freeing resources they depend on
        if (it->second.gainCallback) {
            deviceManager.removeAudioCallback(it->second.gainCallback.get());
            it->second.gainCallback.reset(); // Clear the callback
        }
        if (it->second.player) {
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
    
    // IMPORTANT: Remove audio callbacks BEFORE freeing resources they depend on
    if (it->second.sf2Callback) {
        deviceManager.removeAudioCallback(it->second.sf2Callback.get());
    }
    
    if (it->second.gainCallback) {
        deviceManager.removeAudioCallback(it->second.gainCallback.get());
    }
    
    if (it->second.player) {
        it->second.player->setProcessor(nullptr);
    }
    
    // Now safe to close the SoundFont after callback is removed
    if (it->second.soundFont) {
        tsf_close(it->second.soundFont);
    }
    
    tracks.erase(it);
}

juce::String BackendHost::getPluginState(const juce::String& trackId) const {
    const juce::ScopedLock sl(tracksLock);
    auto it = tracks.find(trackId);
    if (it == tracks.end() || !it->second.plugin) {
        emit("DEBUG GET_STATE: No plugin found for track " + trackId);
        return {};
    }
    
    emit("DEBUG GET_STATE: Found plugin for track " + trackId + ": " + it->second.plugin->getName());
    
    juce::MemoryBlock stateData;
    it->second.plugin->getStateInformation(stateData);
    
    emit("DEBUG GET_STATE: Retrieved " + juce::String((int)stateData.getSize()) + " bytes");
    
    if (stateData.getSize() == 0) {
        emit("DEBUG GET_STATE: State data is empty");
        return {};
    }
    
    auto base64 = stateData.toBase64Encoding();
    emit("DEBUG GET_STATE: Encoded to base64, length: " + juce::String(base64.length()));
    return base64;
}

bool BackendHost::setPluginState(const juce::String& trackId, const juce::String& base64State) {
    const juce::ScopedLock sl(tracksLock);
    auto it = tracks.find(trackId);
    if (it == tracks.end() || !it->second.plugin) {
        emit("DEBUG SET_STATE: No plugin found for track " + trackId);
        return false;
    }
    
    emit("DEBUG SET_STATE: Found plugin for track " + trackId + ": " + it->second.plugin->getName());
    
    if (base64State.isEmpty()) {
        emit("DEBUG SET_STATE: Base64 state is empty");
        return false;
    }
    
    emit("DEBUG SET_STATE: Decoding base64, length: " + juce::String(base64State.length()));
    
    juce::MemoryBlock stateData;
    if (!stateData.fromBase64Encoding(base64State)) {
        emit("DEBUG SET_STATE: Failed to decode base64");
        return false;
    }
    
    emit("DEBUG SET_STATE: Decoded to " + juce::String((int)stateData.getSize()) + " bytes");
    
    auto& plugin = it->second.plugin;
    
    // Suspend processing before setting state
    emit("DEBUG SET_STATE: Suspending processing");
    plugin->suspendProcessing(true);
    
    // Release resources temporarily
    emit("DEBUG SET_STATE: Releasing resources");
    plugin->releaseResources();
    
    // Set the plugin state
    emit("DEBUG SET_STATE: Calling setStateInformation");
    plugin->setStateInformation(stateData.getData(), (int)stateData.getSize());
    
    // Re-prepare the plugin with current settings to ensure state is applied
    emit("DEBUG SET_STATE: Re-preparing plugin");
    plugin->prepareToPlay(getSampleRate(), getBlockSize());
    
    // Resume processing to ensure plugin updates its parameters
    emit("DEBUG SET_STATE: Resuming processing");
    plugin->suspendProcessing(false);
    
    // Notify the plugin and host that parameters have changed
    emit("DEBUG SET_STATE: Updating host display");
    plugin->updateHostDisplay(juce::AudioProcessorListener::ChangeDetails().withParameterInfoChanged(true)
                                                                           .withProgramChanged(true));
    
    emit("DEBUG SET_STATE: Successfully set state for track " + trackId);
    return true;
}

bool BackendHost::loadBeatSample(const juce::String& trackId,
                                 const juce::String& rowId,
                                 const juce::File& file,
                                 juce::String& errorMessage) {
    if (trackId.isEmpty() || rowId.isEmpty()) {
        errorMessage = "missing-track-or-row";
        return false;
    }

    if (!file.existsAsFile()) {
        errorMessage = "file-not-found: " + file.getFullPathName();
        return false;
    }

    std::unique_ptr<juce::AudioFormatReader> reader(beatFormatManager.createReaderFor(file));
    if (!reader) {
        errorMessage = "unsupported-format";
        return false;
    }

    const int numSamples = static_cast<int>(reader->lengthInSamples);
    auto sample = std::make_shared<BeatSample>();
    sample->sampleRate = reader->sampleRate;
    sample->buffer.setSize(static_cast<int>(reader->numChannels), juce::jmax(1, numSamples));
    reader->read(&sample->buffer, 0, numSamples, 0, true, true);

    {
        const juce::ScopedLock slb(beatLock);
        beatSamples[trackId][rowId] = sample;
    }

    emit("EVENT BEAT_LOADED " + trackId + " " + rowId + " " + file.getFileName());
    return true;
}

void BackendHost::triggerBeat(const juce::String& trackId,
                              const juce::String& rowId,
                              float gainLinear) {
    const juce::ScopedLock sl(beatLock);
    auto trackIt = beatSamples.find(trackId);
    if (trackIt == beatSamples.end()) return;
    auto rowIt = trackIt->second.find(rowId);
    if (rowIt == trackIt->second.end()) return;
    auto sample = rowIt->second;
    if (!sample || sample->buffer.getNumSamples() <= 0) return;

    BeatVoice voice;
    voice.sample = sample;
    voice.position = 0.0;
    voice.gain = juce::jlimit(0.0f, 4.0f, gainLinear);
    beatVoices[trackId].push_back(voice);
}

void BackendHost::clearBeatTrack(const juce::String& trackId) {
    const juce::ScopedLock sl(beatLock);
    beatSamples.erase(trackId);
    beatVoices.erase(trackId);
}

void BackendHost::clearBeatRow(const juce::String& trackId, const juce::String& rowId) {
    const juce::ScopedLock sl(beatLock);
    auto trackIt = beatSamples.find(trackId);
    if (trackIt != beatSamples.end()) {
        trackIt->second.erase(rowId);
    }
    auto voiceIt = beatVoices.find(trackId);
    if (voiceIt != beatVoices.end()) {
        auto& v = voiceIt->second;
        v.erase(std::remove_if(v.begin(), v.end(), [&](const BeatVoice& bv) { return bv.sample && trackIt != beatSamples.end() && (!trackIt->second.count(rowId) || trackIt->second.at(rowId) != bv.sample); }), v.end());
    }
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

bool BackendHost::loadSF2(const juce::String& trackId, const juce::File& file, juce::String& errorMessage) {
    prepareDevice();
    
    if (!file.existsAsFile()) {
        errorMessage = "SF2 file not found: " + file.getFullPathName();
        return false;
    }
    
    // Load the SoundFont using TinySoundFont
    tsf* sf = tsf_load_filename(file.getFullPathName().toRawUTF8());
    if (!sf) {
        errorMessage = "Failed to load SF2 file (invalid format or corrupted)";
        return false;
    }
    
    const juce::ScopedLock sl(tracksLock);
    
    // Unload existing plugin/SF2 for this track if any
    auto it = tracks.find(trackId);
    if (it != tracks.end()) {
        // IMPORTANT: Remove audio callbacks BEFORE freeing resources they depend on
        if (it->second.sf2Callback) {
            deviceManager.removeAudioCallback(it->second.sf2Callback.get());
            it->second.sf2Callback.reset(); // Clear the callback
        }
        if (it->second.gainCallback) {
            deviceManager.removeAudioCallback(it->second.gainCallback.get());
            it->second.gainCallback.reset(); // Clear the callback
        }
        if (it->second.player) {
            it->second.player->setProcessor(nullptr);
        }
        // Now safe to close the SoundFont after callback is removed
        if (it->second.soundFont) {
            tsf_close(it->second.soundFont);
            it->second.soundFont = nullptr;
        }
        it->second.editorWindow.reset();
        it->second.plugin.reset();
        it->second.activeNoteTimers.clear();
    }
    
    // Create new track state for SF2
    TrackState& track = tracks[trackId];
    track.soundFont = sf;
    track.sf2Name = file.getFileNameWithoutExtension();
    track.gainLinear = 1.0f;
    
    // Configure TinySoundFont
    const double sr = getSampleRate();
    track.sf2Callback = std::make_unique<SF2AudioCallback>(sf, &track.gainLinear, sr);
    
    // Find and set the first available preset
    int presetIndex = tsf_get_presetindex(sf, 0, 0);
    if (presetIndex < 0) {
        // Bank 0, Preset 0 doesn't exist, use the first available preset
        int presetCount = tsf_get_presetcount(sf);
        if (presetCount > 0) {
            presetIndex = 0;
            const char* presetName = tsf_get_presetname(sf, 0);
            emit("EVENT SF2_USING_FIRST_PRESET " + trackId + " " + juce::String(presetName ? presetName : "Unknown"));
        }
    }
    
    if (presetIndex >= 0) {
        // Set preset for all channels
        for (int ch = 0; ch < 16; ++ch) {
            tsf_channel_set_presetindex(sf, ch, presetIndex);
        }
        track.sf2CurrentBank = 0;
        track.sf2CurrentPreset = 0;
    }
    
    // Add to audio device
    deviceManager.addAudioCallback(track.sf2Callback.get());
    
    emit("EVENT LOADED_SF2 " + trackId + " " + track.sf2Name);
    return true;
}

bool BackendHost::setSF2Preset(const juce::String& trackId, int bank, int preset, juce::String& errorMessage) {
    const juce::ScopedLock sl(tracksLock);
    
    auto it = tracks.find(trackId);
    if (it == tracks.end() || !it->second.soundFont) {
        errorMessage = "No SF2 loaded for track " + trackId;
        return false;
    }
    
    TrackState& track = it->second;
    int presetIndex = tsf_get_presetindex(track.soundFont, bank, preset);
    
    // If exact preset not found, try to use first available preset
    if (presetIndex < 0) {
        int presetCount = tsf_get_presetcount(track.soundFont);
        if (presetCount > 0) {
            presetIndex = 0;
            const char* presetName = tsf_get_presetname(track.soundFont, 0);
            emit("EVENT SF2_PRESET_FALLBACK " + trackId + " requested_bank=" + juce::String(bank) + 
                 " requested_preset=" + juce::String(preset) + " using_preset=0 " + 
                 juce::String(presetName ? presetName : "Unknown"));
            
            // Set the first available preset
            for (int ch = 0; ch < 16; ++ch) {
                tsf_channel_set_presetindex(track.soundFont, ch, 0);
            }
            track.sf2CurrentBank = 0;
            track.sf2CurrentPreset = 0;
            return true;
        } else {
            errorMessage = "Preset not found: bank=" + juce::String(bank) + " preset=" + juce::String(preset) + " and no presets available";
            return false;
        }
    }
    
    // Set preset for all channels (typically use channel 0 for single-track playback)
    for (int ch = 0; ch < 16; ++ch) {
        tsf_channel_set_bank_preset(track.soundFont, ch, bank, preset);
    }
    
    track.sf2CurrentBank = bank;
    track.sf2CurrentPreset = preset;
    
    const char* presetName = tsf_get_presetname(track.soundFont, presetIndex);
    emit("EVENT SF2_PRESET " + trackId + " " + juce::String(bank) + " " + juce::String(preset) + " " + juce::String(presetName ? presetName : "Unknown"));
    
    return true;
}

bool BackendHost::isSF2Loaded(const juce::String& trackId) const {
    const juce::ScopedLock sl(tracksLock);
    auto it = tracks.find(trackId);
    return it != tracks.end() && it->second.soundFont != nullptr;
}

bool BackendHost::playNote(const juce::String& trackId, int midiNote, float velocity01, int durationMs, int channel) {
    const juce::ScopedLock sl(tracksLock);
    
    auto it = tracks.find(trackId);
    if (it == tracks.end()) return false;
    
    TrackState& track = it->second;
    velocity01 = juce::jlimit(0.0f, 1.0f, velocity01);
    
    // Handle SF2 playback
    if (track.soundFont) {
        // Play note on SF2
        tsf_channel_note_on(track.soundFont, channel - 1, midiNote, velocity01); // TSF uses 0-based channels
        
        // Schedule note-off using a Timer
        const int key = (channel << 8) | midiNote;
        track.activeNoteTimers.erase(key);
        
        class SF2NoteOffTimer : public juce::Timer {
        public:
            SF2NoteOffTimer(tsf* sf, int note, int chan) : soundFont(sf), midiNote(note), tsfChannel(chan) {}
            void timerCallback() override {
                if (soundFont) {
                    tsf_channel_note_off(soundFont, tsfChannel, midiNote);
                }
            }
        private:
            tsf* soundFont;
            int midiNote;
            int tsfChannel;
        };
        
        auto timer = std::make_unique<SF2NoteOffTimer>(track.soundFont, midiNote, channel - 1);
        timer->startTimer(durationMs);
        track.activeNoteTimers[key].timer = std::move(timer);
        return true;
    }
    
    // Handle VST plugin playback
    if (!track.plugin) return false;
    
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
    if (it == tracks.end()) return;
    
    // Handle SF2
    if (it->second.soundFont) {
        tsf_channel_note_off(it->second.soundFont, channel - 1, midiNote);
        return;
    }
    
    // Handle VST plugin
    if (!it->second.player) return;
    juce::MidiMessage off = juce::MidiMessage::noteOff(channel, midiNote);
    it->second.player->getMidiMessageCollector().addMessageToQueue(off);
}

void BackendHost::allNotesOff(const juce::String& trackId) {
    const juce::ScopedLock sl(tracksLock);
    
    if (trackId.isEmpty()) {
        // All tracks
        for (auto& [tid, track] : tracks) {
            track.activeNoteTimers.clear();
            
            if (track.soundFont) {
                // SF2 all notes off
                for (int ch = 0; ch < 16; ++ch) {
                    tsf_channel_note_off_all(track.soundFont, ch);
                }
            } else if (track.player) {
                // VST plugin all notes off
                for (int ch = 1; ch <= 16; ++ch) {
                    auto msg = juce::MidiMessage::allNotesOff(ch);
                    track.player->getMidiMessageCollector().addMessageToQueue(msg);
                }
            }
        }
    } else {
        // Specific track
        auto it = tracks.find(trackId);
        if (it == tracks.end()) return;
        
        it->second.activeNoteTimers.clear();
        
        if (it->second.soundFont) {
            // SF2 all notes off
            for (int ch = 0; ch < 16; ++ch) {
                tsf_channel_note_off_all(it->second.soundFont, ch);
            }
        } else if (it->second.player) {
            // VST plugin all notes off
            for (int ch = 1; ch <= 16; ++ch) {
                auto msg = juce::MidiMessage::allNotesOff(ch);
                it->second.player->getMidiMessageCollector().addMessageToQueue(msg);
            }
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
                               int bitDepth,
                               const std::vector<BeatRenderEvent>& beatEvents,
                               const std::vector<AudioClipRenderEvent>& audioClips) {
    // Validate bit depth
    if (bitDepth != 16 && bitDepth != 24 && bitDepth != 32) {
        errorMessage = "Invalid bit depth. Must be 16, 24, or 32";
        return false;
    }

    if (notes.empty() && beatEvents.empty() && audioClips.empty()) {
        errorMessage = "Nothing to render";
        return false;
    }

    const juce::ScopedLock sl(tracksLock);

    // Determine total duration from notes first
    double totalDuration = 0.0;
    for (const auto& note : notes) {
        const double endTime = note.startTimeSeconds + note.durationSeconds;
        if (endTime > totalDuration) totalDuration = endTime;
    }

    // Preload beat samples referenced by beatEvents and account for their duration
    struct BeatJob {
        std::shared_ptr<BeatSample> sample;
        double startTimeSeconds = 0.0;
        float gain = 1.0f;
    };
    std::vector<BeatJob> beatJobs;
    {
        const juce::ScopedLock bl(beatLock);
        for (const auto& ev : beatEvents) {
            auto trackIt = beatSamples.find(ev.trackId);
            if (trackIt == beatSamples.end()) {
                emit("WARNING: Beat track " + ev.trackId + " not loaded; skipping");
                continue;
            }
            auto rowIt = trackIt->second.find(ev.rowId);
            if (rowIt == trackIt->second.end() || !rowIt->second) {
                emit("WARNING: Beat row " + ev.rowId + " missing for track " + ev.trackId);
                continue;
            }
            auto samplePtr = rowIt->second;
            if (!samplePtr || samplePtr->buffer.getNumSamples() == 0) continue;
            const double sampleDuration = samplePtr->buffer.getNumSamples() / samplePtr->sampleRate;
            const double endTime = ev.startTimeSeconds + sampleDuration;
            if (endTime > totalDuration) totalDuration = endTime;
            beatJobs.push_back({samplePtr, ev.startTimeSeconds, ev.gainLinear});
        }
    }

    // Preload audio clips referenced by export payload and compute duration
    struct LoadedAudioClip {
        AudioClipRenderEvent event;
        juce::AudioBuffer<float> buffer;
        double sourceRate = 44100.0;
    };
    std::vector<LoadedAudioClip> loadedClips;
    for (const auto& clip : audioClips) {
        if (!clip.file.existsAsFile()) {
            emit("WARNING: Audio clip missing file " + clip.file.getFullPathName());
            continue;
        }

        std::unique_ptr<juce::AudioFormatReader> reader(beatFormatManager.createReaderFor(clip.file));
        if (!reader) {
            emit("WARNING: Unsupported audio format for clip " + clip.file.getFullPathName());
            continue;
        }

        const auto numSamples = reader->lengthInSamples;
        if (numSamples <= 0) continue;

        juce::AudioBuffer<float> buffer((int)reader->numChannels, (int)numSamples);
        if (!reader->read(&buffer, 0, (int)numSamples, 0, true, true)) {
            emit("WARNING: Failed to read audio clip " + clip.file.getFullPathName());
            continue;
        }

        const double clipDuration = (double)numSamples / reader->sampleRate;
        const double endTime = clip.startTimeSeconds + clipDuration;
        if (endTime > totalDuration) totalDuration = endTime;

        LoadedAudioClip loaded;
        loaded.event = clip;
        loaded.buffer = std::move(buffer);
        loaded.sourceRate = reader->sampleRate;
        loadedClips.push_back(std::move(loaded));
    }

    // Add 2 seconds of tail for reverb/delay effects
    totalDuration += 2.0;

    const int blockSize = 512;
    const int totalSamples = juce::jmax(1, static_cast<int>(totalDuration * sampleRate));
    const int numChannels = 2; // Stereo output

    // Create output buffer
    juce::AudioBuffer<float> renderBuffer(numChannels, totalSamples);
    renderBuffer.clear();

    // Group MIDI notes by track ID
    std::map<juce::String, std::vector<const MidiNoteEvent*>> notesByTrack;
    for (const auto& note : notes) {
        notesByTrack[note.trackId].push_back(&note);
    }

    // Process each track separately, then mix
    for (const auto& [trackId, trackNotes] : notesByTrack) {
        auto trackIt = tracks.find(trackId);
        if (trackIt == tracks.end()) {
            emit("WARNING: Track " + trackId + " not found, skipping");
            continue;
        }

        TrackState& track = trackIt->second;

        // Sort notes by start time for this track
        std::vector<const MidiNoteEvent*> sortedNotes = trackNotes;
        std::sort(sortedNotes.begin(), sortedNotes.end(),
                  [](const MidiNoteEvent* a, const MidiNoteEvent* b) {
                      return a->startTimeSeconds < b->startTimeSeconds;
                  });

        // Common buffer for this track
        juce::AudioBuffer<float> trackBuffer(numChannels, totalSamples);
        trackBuffer.clear();

        if (track.plugin) {
            auto* plugin = track.plugin.get();

            // Prepare plugin for rendering
            plugin->prepareToPlay(sampleRate, blockSize);
            plugin->setNonRealtime(true); // Enable offline rendering mode

            juce::MidiBuffer midiBuffer;

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
                        ++midiIndex;
                        continue;
                    }

                    if (samplePos >= currentSample + samplesThisBlock) {
                        break;
                    }

                    // Add message at relative position within block
                    const int relativePos = samplePos - currentSample;
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
        } else if (track.soundFont) {
            // Offline render for SF2 tracks using TinySoundFont
            tsf* sf = track.soundFont;
            tsf_set_output(sf, TSF_STEREO_INTERLEAVED, (int)sampleRate, 0.0f);

            struct SF2Event { int samplePos; bool noteOn; int midiNote; float velocity; int channel; };
            std::vector<SF2Event> timeline;
            for (const auto* note : sortedNotes) {
                int samplePos = static_cast<int>(note->startTimeSeconds * sampleRate);
                int noteOffPos = static_cast<int>((note->startTimeSeconds + note->durationSeconds) * sampleRate);
                samplePos = juce::jlimit(0, totalSamples - 1, samplePos);
                noteOffPos = juce::jlimit(0, totalSamples - 1, noteOffPos);

                float velocity = juce::jlimit(0.0f, 1.0f, note->velocity01);
                timeline.push_back({samplePos, true, note->midiNote, velocity, note->channel});
                timeline.push_back({noteOffPos, false, note->midiNote, velocity, note->channel});
            }

            std::sort(timeline.begin(), timeline.end(), [](const SF2Event& a, const SF2Event& b) {
                return a.samplePos < b.samplePos;
            });

            std::vector<float> tempInterleaved;
            tempInterleaved.resize((size_t)blockSize * (size_t)numChannels);

            int currentSample = 0;
            size_t eventIndex = 0;

            auto dispatchEventsUpTo = [&](int samplePos) {
                while (eventIndex < timeline.size() && timeline[eventIndex].samplePos <= samplePos) {
                    const auto& ev = timeline[eventIndex];
                    const int tsfChannel = juce::jlimit(0, 15, ev.channel - 1);
                    if (ev.noteOn) {
                        tsf_channel_note_on(sf, tsfChannel, ev.midiNote, ev.velocity);
                    } else {
                        tsf_channel_note_off(sf, tsfChannel, ev.midiNote);
                    }
                    ++eventIndex;
                }
            };

            // Fire any events at time 0
            dispatchEventsUpTo(0);

            while (currentSample < totalSamples) {
                const int nextEventSample = (eventIndex < timeline.size()) ? timeline[eventIndex].samplePos : totalSamples;
                const int remaining = totalSamples - currentSample;
                const int untilNext = juce::jmax(1, nextEventSample - currentSample);
                const int samplesThisBlock = juce::jmin(blockSize, juce::jmin(remaining, untilNext));

                // Render block
                tempInterleaved.resize((size_t)samplesThisBlock * (size_t)numChannels);
                tsf_render_float(sf, tempInterleaved.data(), samplesThisBlock, 0);

                // Deinterleave and copy
                for (int i = 0; i < samplesThisBlock; ++i) {
                    const float l = tempInterleaved[(size_t)i * 2];
                    const float r = tempInterleaved[(size_t)i * 2 + 1];
                    trackBuffer.setSample(0, currentSample + i, l);
                    trackBuffer.setSample(1, currentSample + i, r);
                }

                currentSample += samplesThisBlock;

                // Dispatch any events scheduled at or before the new time
                dispatchEventsUpTo(currentSample);
            }
        } else {
            emit("WARNING: Track " + trackId + " has no plugin or SF2 loaded; skipping");
            continue;
        }

        // Apply track gain to the rendered audio
        const float trackGain = track.gainLinear;
        if (trackGain != 1.0f) {
            trackBuffer.applyGain(trackGain);
        }

        // Mix track buffer into main render buffer
        for (int ch = 0; ch < numChannels; ++ch) {
            renderBuffer.addFrom(ch, 0, trackBuffer, ch, 0, totalSamples);
        }
    }

    // Mix beat events (already prepared as beatJobs)
    for (const auto& job : beatJobs) {
        auto samplePtr = job.sample;
        if (!samplePtr) continue;

        const int srcChannels = samplePtr->buffer.getNumChannels();
        const int srcSamples = samplePtr->buffer.getNumSamples();
        if (srcSamples == 0) continue;

        const double ratio = samplePtr->sampleRate / sampleRate;
        const int startSample = juce::jlimit(0, totalSamples - 1, (int)std::floor(job.startTimeSeconds * sampleRate));

        for (int dest = startSample; dest < totalSamples; ++dest) {
            const double srcPos = (dest - startSample) * ratio;
            const int idx = (int)srcPos;
            if (idx >= srcSamples) break;
            const double frac = srcPos - (double)idx;

            for (int ch = 0; ch < numChannels; ++ch) {
                const int srcCh = (srcChannels == 1) ? 0 : juce::jmin(ch, srcChannels - 1);
                const float s0 = samplePtr->buffer.getSample(srcCh, idx);
                const float s1 = (idx + 1 < srcSamples) ? samplePtr->buffer.getSample(srcCh, idx + 1) : 0.0f;
                const float blended = (float)((1.0 - frac) * s0 + frac * s1);
                renderBuffer.addSample(ch, dest, blended * job.gain);
            }
        }
    }

    // Mix audio clips
    for (const auto& clip : loadedClips) {
        const int srcChannels = clip.buffer.getNumChannels();
        const int srcSamples = clip.buffer.getNumSamples();
        if (srcSamples == 0) continue;

        const double ratio = clip.sourceRate / sampleRate;
        const int startSample = juce::jlimit(0, totalSamples - 1, (int)std::floor(clip.event.startTimeSeconds * sampleRate));
        const float gain = clip.event.gainLinear;

        for (int dest = startSample; dest < totalSamples; ++dest) {
            const double srcPos = (dest - startSample) * ratio;
            const int idx = (int)srcPos;
            if (idx >= srcSamples) break;
            const double frac = srcPos - (double)idx;

            for (int ch = 0; ch < numChannels; ++ch) {
                const int srcCh = (srcChannels == 1) ? 0 : juce::jmin(ch, srcChannels - 1);
                const float s0 = clip.buffer.getSample(srcCh, idx);
                const float s1 = (idx + 1 < srcSamples) ? clip.buffer.getSample(srcCh, idx + 1) : 0.0f;
                const float blended = (float)((1.0 - frac) * s0 + frac * s1);
                renderBuffer.addSample(ch, dest, blended * gain);
            }
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
    const int bitsPerSample = bitDepth;

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
