#include "BackendHost.h"

#include <juce_core/juce_core.h>
#include <iostream>

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
        if (track.player) {
            deviceManager.removeAudioCallback(track.player.get());
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
    
    // Add this player as an audio callback
    deviceManager.addAudioCallback(track.player.get());

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
    
    if (it->second.player) {
        deviceManager.removeAudioCallback(it->second.player.get());
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
