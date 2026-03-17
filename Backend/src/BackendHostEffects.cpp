// BackendHost Effect Chain Management Implementation
#include "BackendHost.h"
#include "DspEffects.h"
#include <iostream>

namespace {
void emit(const juce::String& msg) {
    std::cout << msg << std::endl;
    std::cout.flush();
}

std::unique_ptr<DspEffect> createDspEffect(const juce::String& effectType, double sampleRate, int blockSize) {
    std::unique_ptr<DspEffect> effect;
    
    if (effectType == "reverb") {
        effect = std::make_unique<ReverbEffect>();
    } else if (effectType == "delay") {
        effect = std::make_unique<DelayEffect>();
    } else if (effectType == "chorus") {
        effect = std::make_unique<ChorusEffect>();
    } else if (effectType == "distortion") {
        effect = std::make_unique<DistortionEffect>();
    } else if (effectType == "compressor") {
        effect = std::make_unique<CompressorEffect>();
    } else if (effectType == "phaser") {
        effect = std::make_unique<PhaserEffect>();
    } else if (effectType == "flanger") {
        effect = std::make_unique<FlangerEffect>();
    }
    
    if (effect) {
        effect->prepareToPlay(sampleRate, blockSize);
    }
    
    return effect;
}
}

juce::String BackendHost::addEffect(const juce::String& trackId, 
                                    const juce::String& effectType,
                                    juce::String& errorMessage) {
    const juce::ScopedLock sl(tracksLock);
    
    auto it = tracks.find(trackId);
    if (it == tracks.end()) {
        errorMessage = "track-not-found";
        return {};
    }
    
    // Create the effect
    auto effect = createDspEffect(effectType, getSampleRate(), getBlockSize());
    if (!effect) {
        errorMessage = "unknown-effect-type: " + effectType;
        return {};
    }
    
    // Generate unique effect ID
    const juce::String effectId = "eff-" + juce::String(juce::Time::currentTimeMillis()) + "-" + juce::String(juce::Random::getSystemRandom().nextInt());
    
    // Add to track's effect chain
    TrackState::EffectEntry entry;
    entry.id = effectId;
    entry.effect = std::move(effect);
    entry.bypassed = false;
    
    it->second.effectChain.push_back(std::move(entry));
    
    emit("EVENT EFFECT_ADDED " + trackId + " " + effectId + " " + effectType);
    return effectId;
}

bool BackendHost::removeEffect(const juce::String& trackId,
                              const juce::String& effectId,
                              juce::String& errorMessage) {
    const juce::ScopedLock sl(tracksLock);
    
    auto it = tracks.find(trackId);
    if (it == tracks.end()) {
        errorMessage = "track-not-found";
        return false;
    }
    
    auto& effectChain = it->second.effectChain;
    
    for (size_t i = 0; i < effectChain.size(); ++i) {
        if (effectChain[i].id == effectId) {
            effectChain.erase(effectChain.begin() + i);
            emit("EVENT EFFECT_REMOVED " + trackId + " " + effectId);
            return true;
        }
    }
    
    errorMessage = "effect-not-found: " + effectId;
    return false;
}

bool BackendHost::setEffectParameter(const juce::String& trackId,
                                    const juce::String& effectId,
                                    int parameterIndex,
                                    float value,
                                    juce::String& errorMessage) {
    const juce::ScopedLock sl(tracksLock);
    
    auto it = tracks.find(trackId);
    if (it == tracks.end()) {
        errorMessage = "track-not-found";
        return false;
    }
    
    auto& effectChain = it->second.effectChain;
    
    for (auto& entry : effectChain) {
        if (entry.id == effectId) {
            if (!entry.effect) {
                errorMessage = "effect-invalid";
                return false;
            }
            
            if (parameterIndex < 0 || parameterIndex >= entry.effect->getNumParameters()) {
                errorMessage = "parameter-out-of-range: " + juce::String(parameterIndex);
                return false;
            }
            
            entry.effect->setParameter(parameterIndex, juce::jlimit(0.0f, 1.0f, value));
            return true;
        }
    }
    
    errorMessage = "effect-not-found: " + effectId;
    return false;
}

float BackendHost::getEffectParameter(const juce::String& trackId,
                                     const juce::String& effectId,
                                     int parameterIndex) const {
    const juce::ScopedLock sl(tracksLock);
    
    auto it = tracks.find(trackId);
    if (it == tracks.end()) return 0.0f;
    
    const auto& effectChain = it->second.effectChain;
    
    for (const auto& entry : effectChain) {
        if (entry.id == effectId && entry.effect) {
            if (parameterIndex < 0 || parameterIndex >= entry.effect->getNumParameters()) {
                return 0.0f;
            }
            return entry.effect->getParameter(parameterIndex);
        }
    }
    
    return 0.0f;
}

bool BackendHost::getEffectParameterInfo(const juce::String& trackId,
                                        const juce::String& effectId,
                                        int parameterIndex,
                                        juce::String& paramName,
                                        float& paramValue) const {
    const juce::ScopedLock sl(tracksLock);
    
    auto it = tracks.find(trackId);
    if (it == tracks.end()) return false;
    
    const auto& effectChain = it->second.effectChain;
    
    for (const auto& entry : effectChain) {
        if (entry.id == effectId && entry.effect) {
            if (parameterIndex < 0 || parameterIndex >= entry.effect->getNumParameters()) {
                return false;
            }
            paramName = entry.effect->getParameterName(parameterIndex);
            paramValue = entry.effect->getParameter(parameterIndex);
            return true;
        }
    }
    
    return false;
}

juce::StringArray BackendHost::getTrackEffects(const juce::String& trackId) const {
    const juce::ScopedLock sl(tracksLock);
    
    juce::StringArray result;
    
    auto it = tracks.find(trackId);
    if (it == tracks.end()) return result;
    
    const auto& effectChain = it->second.effectChain;
    
    for (const auto& entry : effectChain) {
        result.add(entry.id);
    }
    
    return result;
}

bool BackendHost::setEffectBypassed(const juce::String& trackId,
                                   const juce::String& effectId,
                                   bool bypassed,
                                   juce::String& errorMessage) {
    const juce::ScopedLock sl(tracksLock);
    
    auto it = tracks.find(trackId);
    if (it == tracks.end()) {
        errorMessage = "track-not-found";
        return false;
    }
    
    auto& effectChain = it->second.effectChain;
    
    for (auto& entry : effectChain) {
        if (entry.id == effectId) {
            entry.bypassed = bypassed;
            if (entry.effect) {
                entry.effect->setBypassed(bypassed);
            }
            emit("EVENT EFFECT_BYPASSED " + trackId + " " + effectId + " " + (bypassed ? "on" : "off"));
            return true;
        }
    }
    
    errorMessage = "effect-not-found: " + effectId;
    return false;
}

// Master track effect management
juce::String BackendHost::addMasterEffect(const juce::String& effectType,
                                         juce::String& errorMessage) {
    const juce::ScopedLock sl(masterLock);
    
    auto effect = createDspEffect(effectType, getSampleRate(), getBlockSize());
    if (!effect) {
        errorMessage = "unknown-effect-type: " + effectType;
        return {};
    }
    
    const juce::String effectId = "master-eff-" + juce::String(juce::Time::currentTimeMillis()) + "-" + juce::String(juce::Random::getSystemRandom().nextInt());
    
    MasterTrackState::EffectEntry entry;
    entry.id = effectId;
    entry.effect = std::move(effect);
    entry.bypassed = false;
    
    masterTrack.effectChain.push_back(std::move(entry));
    
    emit("EVENT MASTER_EFFECT_ADDED " + effectId + " " + effectType);
    return effectId;
}

bool BackendHost::removeMasterEffect(const juce::String& effectId,
                                    juce::String& errorMessage) {
    const juce::ScopedLock sl(masterLock);
    
    auto& effectChain = masterTrack.effectChain;
    
    for (size_t i = 0; i < effectChain.size(); ++i) {
        if (effectChain[i].id == effectId) {
            effectChain.erase(effectChain.begin() + i);
            emit("EVENT MASTER_EFFECT_REMOVED " + effectId);
            return true;
        }
    }
    
    errorMessage = "effect-not-found: " + effectId;
    return false;
}

bool BackendHost::setMasterEffectParameter(const juce::String& effectId,
                                          int parameterIndex,
                                          float value,
                                          juce::String& errorMessage) {
    const juce::ScopedLock sl(masterLock);
    
    auto& effectChain = masterTrack.effectChain;
    
    for (auto& entry : effectChain) {
        if (entry.id == effectId) {
            if (!entry.effect) {
                errorMessage = "effect-invalid";
                return false;
            }
            
            if (parameterIndex < 0 || parameterIndex >= entry.effect->getNumParameters()) {
                errorMessage = "parameter-out-of-range: " + juce::String(parameterIndex);
                return false;
            }
            
            entry.effect->setParameter(parameterIndex, juce::jlimit(0.0f, 1.0f, value));
            return true;
        }
    }
    
    errorMessage = "effect-not-found: " + effectId;
    return false;
}

float BackendHost::getMasterEffectParameter(const juce::String& effectId,
                                           int parameterIndex) const {
    const juce::ScopedLock sl(masterLock);
    
    const auto& effectChain = masterTrack.effectChain;
    
    for (const auto& entry : effectChain) {
        if (entry.id == effectId && entry.effect) {
            if (parameterIndex < 0 || parameterIndex >= entry.effect->getNumParameters()) {
                return 0.0f;
            }
            return entry.effect->getParameter(parameterIndex);
        }
    }
    
    return 0.0f;
}

juce::StringArray BackendHost::getMasterEffects() const {
    const juce::ScopedLock sl(masterLock);
    
    juce::StringArray result;
    
    const auto& effectChain = masterTrack.effectChain;
    
    for (const auto& entry : effectChain) {
        result.add(entry.id);
    }
    
    return result;
}

bool BackendHost::setMasterEffectBypassed(const juce::String& effectId,
                                         bool bypassed,
                                         juce::String& errorMessage) {
    const juce::ScopedLock sl(masterLock);
    
    auto& effectChain = masterTrack.effectChain;
    
    for (auto& entry : effectChain) {
        if (entry.id == effectId) {
            entry.bypassed = bypassed;
            if (entry.effect) {
                entry.effect->setBypassed(bypassed);
            }
            emit("EVENT MASTER_EFFECT_BYPASSED " + effectId + " " + (bypassed ? "on" : "off"));
            return true;
        }
    }
    
    errorMessage = "effect-not-found: " + effectId;
    return false;
}

void BackendHost::processTrackEffectChain(const juce::String& trackId, juce::AudioBuffer<float>& buffer) {
    const juce::ScopedLock sl(tracksLock);
    
    auto it = tracks.find(trackId);
    if (it == tracks.end()) {
        return; // Track not found
    }
    
    TrackState& track = it->second;
    
    // Process the audio buffer through each effect in the chain
    juce::MidiBuffer emptyMidi; // No MIDI for effect processing
    for (auto& entry : track.effectChain) {
        if (!entry.bypassed && entry.effect) {
            entry.effect->processBlock(buffer, emptyMidi);
        }
    }
}

void BackendHost::processMasterEffectChain(juce::AudioBuffer<float>& buffer) {
    const juce::ScopedLock sl(masterLock);
    
    // Process the audio buffer through each master effect in the chain
    juce::MidiBuffer emptyMidi; // No MIDI for effect processing
    for (auto& entry : masterTrack.effectChain) {
        if (!entry.bypassed && entry.effect) {
            entry.effect->processBlock(buffer, emptyMidi);
        }
    }
}

