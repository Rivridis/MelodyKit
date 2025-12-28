cmake_minimum_required(VERSION 3.20)
project(MelodyKitBackend VERSION 0.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# JUCE is vendored inside Backend/JUCE
add_subdirectory(JUCE)

juce_add_console_app(Backend
    PRODUCT_NAME "MelodyKit Backend"
)

target_sources(Backend PRIVATE
    src/Main.cpp
    src/BackendHost.cpp
)

target_compile_definitions(Backend
    PRIVATE
        JUCE_PLUGINHOST_VST3=1
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_DISPLAY_SPLASH_SCREEN=0
        JUCE_VST3_CAN_REPLACE_VST2=0
)

target_link_libraries(Backend
    PRIVATE
        juce::juce_core
        juce::juce_audio_devices
        juce::juce_audio_formats
        juce::juce_audio_processors
        juce::juce_gui_basics
        juce::juce_audio_utils
)

# Emit the executable next to this CMakeLists.txt so Electron can spawn it at Backend/Backend.exe
set_target_properties(Backend PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_SOURCE_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_SOURCE_DIR}"
)
