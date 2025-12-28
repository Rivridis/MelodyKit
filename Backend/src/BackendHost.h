#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_gui_basics/juce_gui_basics.h>
#include <atomic>
#include <map>
#include <string>

// Forward declaration
class PluginEditorWindow;

// Multi-track JUCE host that manages multiple VST3 instances per track
class BackendHost {
public:
    BackendHost();
    ~BackendHost();

    // Loads a plugin for a specific track ID. Returns false and fills errorMessage on failure.
    bool loadPlugin(const juce::String& trackId, const juce::File& file, juce::String& errorMessage);

    bool isPluginLoaded(const juce::String& trackId) const;
    juce::String getLoadedPluginName(const juce::String& trackId) const;

    // Sends a note on + scheduled note off to the track's plugin.
    bool playNote(const juce::String& trackId, int midiNote, float velocity01, int durationMs, int channel = 1);

    // Sends all-notes-off for a specific track, or all tracks if trackId is empty
    void allNotesOff(const juce::String& trackId = "");

    // Opens the plugin's native editor window (non-blocking)
    bool openEditor(const juce::String& trackId, juce::String& errorMessage);
    
    // Closes the plugin's editor window if open
    void closeEditor(const juce::String& trackId);
    
    // Check if editor window is currently open for a track
    bool isEditorOpen(const juce::String& trackId) const;
    
    // Unload a track's plugin
    void unloadPlugin(const juce::String& trackId);

    double getSampleRate() const;
    int getBlockSize() const;

private:
    void prepareDevice();
    std::unique_ptr<juce::AudioPluginInstance> createPlugin(const juce::File& file, double sampleRate, int blockSize, juce::String& errorMessage);
    void sendNoteOff(const juce::String& trackId, int midiNote, int channel);

    juce::AudioDeviceManager deviceManager;
    juce::AudioPluginFormatManager formatManager;
    
    // Per-track plugin state
    struct TrackState {
        std::unique_ptr<juce::AudioPluginInstance> plugin;
        std::unique_ptr<juce::AudioProcessorPlayer> player;
        std::unique_ptr<PluginEditorWindow> editorWindow;
        
        // Track active timers for scheduled note-offs
        struct NoteOffTimer {
            std::unique_ptr<juce::Timer> timer;
        };
        std::map<int, NoteOffTimer> activeNoteTimers; // key: (channel << 8) | midiNote
    };
    
    std::map<juce::String, TrackState> tracks;
    mutable juce::CriticalSection tracksLock;
};
