#include <juce_gui_basics/juce_gui_basics.h>

#include <atomic>
#include <iostream>
#include <string>
#include <thread>

#include "BackendHost.h"

namespace {
void emit(const juce::String& msg) {
    std::cout << msg << std::endl;
    std::cout.flush();
}

struct CommandContext {
    BackendHost host;
    std::atomic<bool> running { true };
};

bool handleCommand(const juce::String& rawLine, CommandContext& ctx) {
    const juce::String line = rawLine.trim();
    if (line.isEmpty()) return true;

    const juce::String command = line.upToFirstOccurrenceOf(" ", false, false).toUpperCase();
    const juce::String args = line.fromFirstOccurrenceOf(" ", false, false).trim();

    if (command == "PING") {
        emit("EVENT PONG");
        return true;
    }

    if (command == "LOAD" || command == "LOAD_VST") {
        juce::StringArray tokens;
        tokens.addTokens(args, " ", "\"'");
        tokens.removeEmptyStrings();
        
        if (tokens.size() < 2) {
            emit("ERROR LOAD missing-track-id-or-path");
            return true;
        }
        
        const juce::String trackId = tokens[0];
        const juce::String path = tokens[1];
        const juce::File file(path.unquoted());
        
        juce::String err;
        if (!ctx.host.loadPlugin(trackId, file, err)) {
            emit("ERROR LOAD " + trackId + " " + err);
        } else {
            emit("EVENT READY " + trackId + " " + ctx.host.getLoadedPluginName(trackId));
        }
        return true;
    }

    if (command == "NOTE" || command == "NOTE_ON") {
        juce::StringArray tokens;
        tokens.addTokens(args, " ", "\"'");
        tokens.removeEmptyStrings();

        if (tokens.size() < 2) {
            emit("ERROR NOTE missing-track-id-or-midi-note");
            return true;
        }

        const juce::String trackId = tokens[0];
        const int midiNote = tokens[1].getIntValue();
        float velocity = tokens.size() > 2 ? tokens[2].getFloatValue() : 0.8f;
        const int durationMs = tokens.size() > 3 ? tokens[3].getIntValue() : 400;
        const int channel = tokens.size() > 4 ? tokens[4].getIntValue() : 1;

        // Accept velocity in 0..1 or 0..127 range
        if (velocity > 1.5f) velocity = juce::jlimit(0.0f, 1.0f, velocity / 127.0f);

        if (!ctx.host.playNote(trackId, midiNote, velocity, durationMs, channel)) {
            emit("ERROR NOTE " + trackId + " no-plugin-loaded");
        } else {
            emit("EVENT NOTE " + trackId + " " + juce::String(midiNote));
        }
        return true;
    }

    if (command == "PANIC" || command == "ALL_OFF") {
        const juce::String trackId = args.trim();
        ctx.host.allNotesOff(trackId);
        emit("EVENT PANIC " + (trackId.isEmpty() ? "ALL" : trackId));
        return true;
    }

    if (command == "STATUS") {
        emit("EVENT STATUS rate=" + juce::String(ctx.host.getSampleRate()) +
             " block=" + juce::String(ctx.host.getBlockSize()));
        return true;
    }
    
    if (command == "SHOW_UI" || command == "OPEN_EDITOR") {
        const juce::String trackId = args.trim();
        if (trackId.isEmpty()) {
            emit("ERROR EDITOR missing-track-id");
            return true;
        }
        
        juce::String err;
        if (!ctx.host.openEditor(trackId, err)) {
            emit("ERROR EDITOR " + trackId + " " + err);
        } else {
            emit("EVENT EDITOR_OPENED " + trackId);
        }
        return true;
    }
    
    if (command == "CLOSE_UI" || command == "CLOSE_EDITOR") {
        const juce::String trackId = args.trim();
        if (trackId.isEmpty()) {
            emit("ERROR EDITOR missing-track-id");
            return true;
        }
        
        ctx.host.closeEditor(trackId);
        emit("EVENT EDITOR_CLOSED " + trackId);
        return true;
    }

    if (command == "QUIT" || command == "EXIT") {
        ctx.running = false;
        juce::MessageManager::getInstance()->stopDispatchLoop();
        return false;
    }

    emit("ERROR UNKNOWN " + command);
    return true;
}
}

int main(int argc, char* argv[]) {
    juce::ScopedJuceInitialiser_GUI juceInit;

    CommandContext ctx;
    emit("EVENT READY");

    // Optional: auto-load plugin if path is passed as first two arguments (trackId and path)
    if (argc > 2) {
        juce::String trackId = juce::String(argv[1]);
        juce::String pathArg = juce::String(argv[2]);
        juce::String err;
        ctx.host.loadPlugin(trackId, juce::File(pathArg), err);
        if (err.isNotEmpty()) emit("ERROR LOAD " + trackId + " " + err);
    }

    // Run stdin reading on a separate thread so the main thread can run the message loop
    std::thread stdinThread([&ctx]() {
        std::string line;
        while (ctx.running && std::getline(std::cin, line)) {
            // Post command handling to message thread for thread safety
            juce::MessageManager::callAsync([&ctx, cmd = juce::String(line)]() {
                handleCommand(cmd, ctx);
            });
        }
        // When stdin closes (parent process exits), stop gracefully
        juce::MessageManager::callAsync([&ctx]() {
            ctx.running = false;
            juce::MessageManager::getInstance()->stopDispatchLoop();
        });
    });

    // Main thread runs the JUCE message loop to keep GUI responsive
    // This will block until stopDispatchLoop() is called
    juce::MessageManager::getInstance()->runDispatchLoop();

    // Wait for stdin thread to finish
    if (stdinThread.joinable()) {
        stdinThread.join();
    }

    ctx.host.allNotesOff();
    emit("EVENT EXIT");
    return 0;
}
