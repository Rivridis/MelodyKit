#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_dsp/juce_dsp.h>
#include <memory>
#include <map>

// Base class for all DSP effects
class DspEffect : public juce::AudioProcessor {
public:
    explicit DspEffect(const juce::String& effectId);
    virtual ~DspEffect();

    // AudioProcessor overrides
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;
    void processBlockBypassed(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    // Parameter management
    int getNumParameters() const { return static_cast<int>(parameters.size()); }
    float getParameter(int index) const;
    void setParameter(int index, float newValue);
    const juce::String getParameterName(int index) const;
    const juce::String getParameterText(int index) const;
    bool isParameterAutomatable(int index) const { return true; }

    // Plugin description
    const juce::String getName() const override;
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool hasEditor() const override { return false; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return "Default"; }
    void changeProgramName(int, const juce::String&) override {}
    void getStateInformation(juce::MemoryBlock&) override {}
    void setStateInformation(const void*, int) override {}

    juce::String getEffectId() const { return effectId; }

    // Bypass handling
    void setBypassed(bool shouldBeBypassed) noexcept { bypassed = shouldBeBypassed; }
    bool isBypassed() const noexcept { return bypassed; }

protected:
    struct ParameterInfo {
        juce::String name;
        float value = 0.5f;
        float minValue = 0.0f;
        float maxValue = 1.0f;
        float defaultValue = 0.5f;
    };

    std::vector<ParameterInfo> parameters;
    juce::String effectId;
    bool bypassed = false;
    double currentSampleRate = 44100.0;
    int currentBlockSize = 512;

    // Protected helper for subclasses
    void addParameter(const juce::String& name, float defaultValue = 0.5f, float minValue = 0.0f, float maxValue = 1.0f);
};

//===========================================
// Concrete Effect Implementations
//===========================================

class ReverbEffect : public DspEffect {
public:
    ReverbEffect();
    ~ReverbEffect() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

private:
    juce::dsp::Reverb::Parameters reverbParams;
    juce::dsp::Reverb reverb;
};

class DelayEffect : public DspEffect {
public:
    DelayEffect();
    ~DelayEffect() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

private:
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> delayLine;
    float wetGain = 0.5f;
    float dryGain = 0.5f;
};

class ChorusEffect : public DspEffect {
public:
    ChorusEffect();
    ~ChorusEffect() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

private:
    juce::dsp::Chorus<float> chorus;
};

class DistortionEffect : public DspEffect {
public:
    DistortionEffect();
    ~DistortionEffect() override;

    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

private:
    float softClip(float sample) const;
};

class CompressorEffect : public DspEffect {
public:
    CompressorEffect();
    ~CompressorEffect() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

private:
    juce::dsp::Compressor<float> compressor;
};

class PhaserEffect : public DspEffect {
public:
    PhaserEffect();
    ~PhaserEffect() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

private:
    juce::dsp::Phaser<float> phaser;
};

class FlangerEffect : public DspEffect {
public:
    FlangerEffect();
    ~FlangerEffect() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

private:
    // Manual flanger implementation using delay line
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> delayLine;
    float lfo = 0.0f;
    float lfoPhase = 0.0f;
    float lfoFreq = 0.5f;
    float lfoDepth = 0.5f;
    float wetGain = 0.5f;
};
