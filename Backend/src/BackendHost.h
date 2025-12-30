#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_gui_basics/juce_gui_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <atomic>
#include <map>
#include <memory>
#include <string>
#include <vector>

// Forward declare TSF type
typedef struct tsf tsf;

// Forward declaration
class PluginEditorWindow;
class GainAudioCallback;
class SF2AudioCallback;
class BeatAudioCallback;

// MIDI note event for rendering
struct MidiNoteEvent {
    juce::String trackId;
    double startTimeSeconds;
    double durationSeconds;
    int midiNote;
    float velocity01;
    int channel;
    
    MidiNoteEvent(const juce::String& tid, double start, double duration, 
                  int note, float vel, int ch = 1)
        : trackId(tid), startTimeSeconds(start), durationSeconds(duration),
          midiNote(note), velocity01(vel), channel(ch) {}
};

// Simple PCM buffer for beat samples
struct BeatSample {
    juce::AudioBuffer<float> buffer;
    double sampleRate = 44100.0;
};

// Offline render event for beat sampler rows
struct BeatRenderEvent {
    juce::String trackId;
    juce::String rowId;
    double startTimeSeconds = 0.0;
    float gainLinear = 1.0f;
};

// Offline render event for audio clips placed on the timeline
struct AudioClipRenderEvent {
    juce::String trackId;
    juce::File file;
    double startTimeSeconds = 0.0;
    float gainLinear = 1.0f;
};

// Multi-track JUCE host that manages multiple VST3 instances per track
class BackendHost {
public:
    BackendHost();
    ~BackendHost();

    // Loads a plugin for a specific track ID. Returns false and fills errorMessage on failure.
    bool loadPlugin(const juce::String& trackId, const juce::File& file, juce::String& errorMessage);
    
    // Loads a SoundFont2 (.sf2) file for a specific track ID
    bool loadSF2(const juce::String& trackId, const juce::File& file, juce::String& errorMessage);
    
    // Set the preset/bank for an SF2 track
    bool setSF2Preset(const juce::String& trackId, int bank, int preset, juce::String& errorMessage);

    bool isPluginLoaded(const juce::String& trackId) const;
    bool isSF2Loaded(const juce::String& trackId) const;
    juce::String getLoadedPluginName(const juce::String& trackId) const;

    // Sends a note on + scheduled note off to the track's plugin.
    bool playNote(const juce::String& trackId, int midiNote, float velocity01, int durationMs, int channel = 1);

    // Sends all-notes-off for a specific track, or all tracks if trackId is empty
    void allNotesOff(const juce::String& trackId = "");
    
    // Set track volume via MIDI CC 7 (0-127, where 100 is default)
    bool setTrackVolume(const juce::String& trackId, int volume, int channel = 1);

    // Opens the plugin's native editor window (non-blocking)
    bool openEditor(const juce::String& trackId, juce::String& errorMessage);
    
    // Closes the plugin's editor window if open
    void closeEditor(const juce::String& trackId);
    
    // Check if editor window is currently open for a track
    bool isEditorOpen(const juce::String& trackId) const;
    
    // Unload a track's plugin
    void unloadPlugin(const juce::String& trackId);

    // Get plugin state as base64-encoded data for saving presets
    // Returns empty string if no plugin loaded or state cannot be retrieved
    juce::String getPluginState(const juce::String& trackId) const;
    
    // Set plugin state from base64-encoded data to restore presets
    // Returns true on success, false if no plugin loaded or data invalid
    bool setPluginState(const juce::String& trackId, const juce::String& base64State);

    // Beat sampler controls
    bool loadBeatSample(const juce::String& trackId,
                        const juce::String& rowId,
                        const juce::File& file,
                        juce::String& errorMessage);
    void triggerBeat(const juce::String& trackId,
                     const juce::String& rowId,
                     float gainLinear = 1.0f);
    void clearBeatTrack(const juce::String& trackId);
    void clearBeatRow(const juce::String& trackId, const juce::String& rowId);

    // Beat voice used by the shared mixer callback
    struct BeatVoice {
        std::shared_ptr<BeatSample> sample;
        double position = 0.0; // position in source samples
        float gain = 1.0f;
    };

    // Render MIDI notes to WAV file using realtime processing
    // notes: array of MIDI events sorted by startTimeSeconds
    // outputPath: output WAV file path
    // sampleRate: output sample rate (default 44100)
    // bitDepth: bit depth (16, 24, or 32)
    // Returns true on success, false on failure (fills errorMessage)
    bool renderToWav(const std::vector<MidiNoteEvent>& notes,
                     const juce::File& outputPath,
                     juce::String& errorMessage,
                     double sampleRate = 44100.0,
                     int bitDepth = 24,
                     const std::vector<BeatRenderEvent>& beatEvents = {},
                     const std::vector<AudioClipRenderEvent>& audioClips = {});

    double getSampleRate() const;
    int getBlockSize() const;

private:
    void prepareDevice();
    std::unique_ptr<juce::AudioPluginInstance> createPlugin(const juce::File& file, double sampleRate, int blockSize, juce::String& errorMessage);
    void sendNoteOff(const juce::String& trackId, int midiNote, int channel);

    juce::AudioDeviceManager deviceManager;
    juce::AudioPluginFormatManager formatManager;
    juce::AudioFormatManager beatFormatManager;
    
    // Per-track plugin state
    struct TrackState {
        std::unique_ptr<juce::AudioPluginInstance> plugin;
        std::unique_ptr<juce::AudioProcessorPlayer> player;
        std::unique_ptr<GainAudioCallback> gainCallback;
        std::unique_ptr<PluginEditorWindow> editorWindow;
        float gainLinear = 1.0f; // Linear gain multiplier (0.0 to ~2.0)
        
        // SF2 SoundFont support
        tsf* soundFont = nullptr;
        std::unique_ptr<SF2AudioCallback> sf2Callback;
        juce::String sf2Name;
        int sf2CurrentBank = 0;
        int sf2CurrentPreset = 0;
        
        // Track active timers for scheduled note-offs
        struct NoteOffTimer {
            std::unique_ptr<juce::Timer> timer;
        };
        std::map<int, NoteOffTimer> activeNoteTimers; // key: (channel << 8) | midiNote
    };
    
    std::map<juce::String, TrackState> tracks;
    mutable juce::CriticalSection tracksLock;

    std::map<juce::String, std::map<juce::String, std::shared_ptr<BeatSample>>> beatSamples; // trackId -> rowId -> sample
    std::map<juce::String, std::vector<BeatVoice>> beatVoices; // trackId -> active voices
    mutable juce::CriticalSection beatLock;
    std::unique_ptr<BeatAudioCallback> beatCallback;
};
