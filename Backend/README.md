# MelodyKit JUCE Backend

Console JUCE host that loads a VST/VST3 instrument, accepts simple text commands from stdin, and plays MIDI notes in real time. Electron spawns this executable and relays commands/events over stdio.

## Build (Windows)
1. Install CMake and a recent MSVC toolchain (Visual Studio 2022 recommended).
2. From the repository root run:
   - `cmake -B Backend/build -S Backend -G "Visual Studio 17 2022"`
   - `cmake --build Backend/build --config Release`
3. The binary `Backend.exe` is emitted directly under `Backend/` so Electron can find it.

## Commands (stdin)
- `PING` → responds with `EVENT PONG`.
- `LOAD_VST <absolute path>` → loads the plugin; also accepts `LOAD`. Paths with spaces should be quoted.
- `NOTE_ON <midi> <velocity> <durationMs> [channel]` → velocity accepts 0..1 or 0..127; a note-off is scheduled automatically.
- `PANIC` / `ALL_OFF` → sends all-notes-off on all channels.
- `STATUS` → prints sample rate, block size, and loaded plugin name.
- `SHOW_UI` / `OPEN_EDITOR` → opens the plugin's native editor window (non-blocking).
- `CLOSE_UI` / `CLOSE_EDITOR` → closes the plugin's editor window.
- `QUIT` / `EXIT` → stops the server.

Stdout lines beginning with `EVENT` are forwarded to the renderer via `backend:event` IPC. Errors are prefixed with `ERROR`.
