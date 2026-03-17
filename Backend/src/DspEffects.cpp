#include "DspEffects.h"
#include <cmath>

//===========================================
// Base DspEffect Class Implementation
//===========================================

DspEffect::DspEffect(const juce::String& id)
    : effectId(id), juce::AudioProcessor() {
    // Set default BusesProperties (stereo input/output)
    setRateAndBufferSizeDetails(44100.0, 512);
}

DspEffect::~DspEffect() {}

void DspEffect::addParameter(const juce::String& name, float defaultValue, float minValue, float maxValue) {
    ParameterInfo info;
    info.name = name;
    info.value = defaultValue;
    info.defaultValue = defaultValue;
    info.minValue = minValue;
    info.maxValue = maxValue;
    parameters.push_back(info);
}

void DspEffect::prepareToPlay(double sampleRate, int samplesPerBlock) {
    currentSampleRate = sampleRate;
    currentBlockSize = samplesPerBlock;
    setRateAndBufferSizeDetails(sampleRate, samplesPerBlock);
}

void DspEffect::releaseResources() {}

void DspEffect::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) {
    juce::ignoreUnused(buffer, midi);
}

void DspEffect::processBlockBypassed(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) {
    juce::ignoreUnused(buffer, midi);
}

float DspEffect::getParameter(int index) const {
    if (index >= 0 && index < static_cast<int>(parameters.size())) {
        return (parameters[index].value - parameters[index].minValue) 
             / (parameters[index].maxValue - parameters[index].minValue);
    }
    return 0.0f;
}

void DspEffect::setParameter(int index, float newValue) {
    if (index >= 0 && index < static_cast<int>(parameters.size())) {
        const float clipped = juce::jlimit(0.0f, 1.0f, newValue);
        const float minVal = parameters[index].minValue;
        const float maxVal = parameters[index].maxValue;
        parameters[index].value = minVal + clipped * (maxVal - minVal);
    }
}

const juce::String DspEffect::getParameterName(int index) const {
    if (index >= 0 && index < static_cast<int>(parameters.size())) {
        return parameters[index].name;
    }
    return juce::String();
}

const juce::String DspEffect::getParameterText(int index) const {
    if (index >= 0 && index < static_cast<int>(parameters.size())) {
        return juce::String(parameters[index].value, 2);
    }
    return juce::String();
}

const juce::String DspEffect::getName() const {
    return effectId;
}

//===========================================
// Reverb Effect
//===========================================

ReverbEffect::ReverbEffect()
    : DspEffect("reverb") {
    addParameter("Room Size", 0.5f, 0.0f, 1.0f);
    addParameter("Damping", 0.5f, 0.0f, 1.0f);
    addParameter("Wet Level", 0.3f, 0.0f, 1.0f);
    addParameter("Dry Level", 0.4f, 0.0f, 1.0f);
    addParameter("Width", 1.0f, 0.0f, 1.0f);
    addParameter("Freeze", 0.0f, 0.0f, 1.0f);
}

ReverbEffect::~ReverbEffect() {}

void ReverbEffect::prepareToPlay(double sampleRate, int samplesPerBlock) {
    DspEffect::prepareToPlay(sampleRate, samplesPerBlock);
    
    juce::dsp::ProcessSpec spec;
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
    spec.numChannels = 2;
    
    reverb.prepare(spec);
}

void ReverbEffect::releaseResources() {
    reverb.reset();
}

void ReverbEffect::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) {
    if (bypassed) {
        processBlockBypassed(buffer, midi);
        return;
    }

    // Update reverb parameters
    reverbParams.roomSize = parameters[0].value;
    reverbParams.damping = parameters[1].value;
    reverbParams.wetLevel = parameters[2].value;
    reverbParams.dryLevel = parameters[3].value;
    reverbParams.width = parameters[4].value;
    reverbParams.freezeMode = parameters[5].value > 0.5f ? 1.0f : 0.0f;
    reverb.setParameters(reverbParams);
    
    juce::dsp::AudioBlock<float> block(buffer);
    juce::dsp::ProcessContextReplacing<float> context(block);
    reverb.process(context);
}

//===========================================
// Delay Effect
//===========================================

DelayEffect::DelayEffect()
    : DspEffect("delay") {
    addParameter("Time (ms)", 500.0f, 10.0f, 2000.0f);
    addParameter("Feedback", 0.4f, 0.0f, 0.99f);
    addParameter("Wet Level", 0.3f, 0.0f, 1.0f);
}

DelayEffect::~DelayEffect() {}

void DelayEffect::prepareToPlay(double sampleRate, int samplesPerBlock) {
    DspEffect::prepareToPlay(sampleRate, samplesPerBlock);
    
    // Set max delay time to 2 seconds
    delayLine.setMaximumDelayInSamples(static_cast<int>(sampleRate * 2.0));
    delayLine.prepare({sampleRate, static_cast<juce::uint32>(samplesPerBlock), 2});
}

void DelayEffect::releaseResources() {
    delayLine.reset();
}

void DelayEffect::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) {
    if (bypassed) {
        processBlockBypassed(buffer, midi);
        return;
    }

    const float delayTimeMs = parameters[0].value;
    const float feedback = parameters[1].value;
    const float wet = parameters[2].value;
    const float dry = 1.0f - wet;
    
    const int delaySamples = static_cast<int>((delayTimeMs / 1000.0f) * currentSampleRate);
    delayLine.setDelay(static_cast<float>(delaySamples));

    for (int ch = 0; ch < buffer.getNumChannels(); ++ch) {
        for (int i = 0; i < buffer.getNumSamples(); ++i) {
            const float inSample = buffer.getSample(ch, i);
            const float delayedSample = delayLine.popSample(ch);
            const float outSample = inSample * dry + delayedSample * wet;
            
            delayLine.pushSample(ch, inSample + delayedSample * feedback);
            buffer.setSample(ch, i, outSample);
        }
    }
}

//===========================================
// Chorus Effect
//===========================================

ChorusEffect::ChorusEffect()
    : DspEffect("chorus") {
    addParameter("Rate (Hz)", 1.5f, 0.5f, 5.0f);
    addParameter("Depth", 0.5f, 0.0f, 1.0f);
    addParameter("Wet Level", 0.3f, 0.0f, 1.0f);
}

ChorusEffect::~ChorusEffect() {}

void ChorusEffect::prepareToPlay(double sampleRate, int samplesPerBlock) {
    DspEffect::prepareToPlay(sampleRate, samplesPerBlock);
    
    juce::dsp::ProcessSpec spec;
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
    spec.numChannels = 2;
    
    chorus.prepare(spec);
}

void ChorusEffect::releaseResources() {
    chorus.reset();
}

void ChorusEffect::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) {
    if (bypassed) {
        processBlockBypassed(buffer, midi);
        return;
    }

    chorus.setRate(parameters[0].value);
    chorus.setDepth(parameters[1].value);
    chorus.setMix(parameters[2].value);
    
    juce::dsp::AudioBlock<float> block(buffer);
    juce::dsp::ProcessContextReplacing<float> context(block);
    chorus.process(context);
}

//===========================================
// Distortion Effect
//===========================================

DistortionEffect::DistortionEffect()
    : DspEffect("distortion") {
    addParameter("Drive", 0.5f, 0.0f, 1.0f);
    addParameter("Tone", 0.5f, 0.0f, 1.0f);
}

DistortionEffect::~DistortionEffect() {}

float DistortionEffect::softClip(float sample) const {
    const float drive = parameters[0].value;
    const float driven = sample * (1.0f + drive * 50.0f);
    
    // Soft clipping using tanh
    if (driven > 1.0f) return 1.0f - 0.1f / (1.0f + std::exp(-2.0f * (driven - 1.0f)));
    if (driven < -1.0f) return -1.0f + 0.1f / (1.0f + std::exp(2.0f * (driven + 1.0f)));
    return driven;
}

void DistortionEffect::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) {
    if (bypassed) {
        processBlockBypassed(buffer, midi);
        return;
    }

    for (int ch = 0; ch < buffer.getNumChannels(); ++ch) {
        for (int i = 0; i < buffer.getNumSamples(); ++i) {
            const float sample = buffer.getSample(ch, i);
            buffer.setSample(ch, i, softClip(sample));
        }
    }
}

//===========================================
// Compressor Effect
//===========================================

CompressorEffect::CompressorEffect()
    : DspEffect("compressor") {
    addParameter("Threshold (dB)", 0.5f, 0.0f, 1.0f);  // -60 to 0 dB
    addParameter("Ratio", 4.0f, 1.0f, 20.0f);
    addParameter("Attack (ms)", 5.0f, 0.1f, 100.0f);
    addParameter("Release (ms)", 100.0f, 10.0f, 3000.0f);
}

CompressorEffect::~CompressorEffect() {}

void CompressorEffect::prepareToPlay(double sampleRate, int samplesPerBlock) {
    DspEffect::prepareToPlay(sampleRate, samplesPerBlock);
    
    juce::dsp::ProcessSpec spec;
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
    spec.numChannels = 2;
    
    compressor.prepare(spec);
}

void CompressorEffect::releaseResources() {
    compressor.reset();
}

void CompressorEffect::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) {
    if (bypassed) {
        processBlockBypassed(buffer, midi);
        return;
    }

    // Map parameters to compressor values
    const float threshold = -60.0f + parameters[0].value * 60.0f; // -60 to 0 dB
    const float ratio = parameters[1].value;
    const float attack = parameters[2].value;
    const float release = parameters[3].value;
    
    compressor.setThreshold(threshold);
    compressor.setRatio(ratio);
    compressor.setAttack(attack);
    compressor.setRelease(release);
    
    juce::dsp::AudioBlock<float> block(buffer);
    juce::dsp::ProcessContextReplacing<float> context(block);
    compressor.process(context);
}

//===========================================
// Phaser Effect
//===========================================

PhaserEffect::PhaserEffect()
    : DspEffect("phaser") {
    addParameter("Rate (Hz)", 0.5f, 0.1f, 10.0f);
    addParameter("Depth", 0.5f, 0.0f, 1.0f);
    addParameter("Feedback", 0.5f, -0.95f, 0.95f);
    addParameter("Wet Level", 0.5f, 0.0f, 1.0f);
}

PhaserEffect::~PhaserEffect() {}

void PhaserEffect::prepareToPlay(double sampleRate, int samplesPerBlock) {
    DspEffect::prepareToPlay(sampleRate, samplesPerBlock);
    
    juce::dsp::ProcessSpec spec;
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(samplesPerBlock);
    spec.numChannels = 2;
    
    phaser.prepare(spec);
}

void PhaserEffect::releaseResources() {
    phaser.reset();
}

void PhaserEffect::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) {
    if (bypassed) {
        processBlockBypassed(buffer, midi);
        return;
    }

    phaser.setRate(parameters[0].value);
    phaser.setDepth(parameters[1].value);
    phaser.setFeedback(parameters[2].value);
    phaser.setMix(parameters[3].value);
    
    juce::dsp::AudioBlock<float> block(buffer);
    juce::dsp::ProcessContextReplacing<float> context(block);
    phaser.process(context);
}

//===========================================
// Flanger Effect
//===========================================

FlangerEffect::FlangerEffect()
    : DspEffect("flanger") {
    addParameter("Rate (Hz)", 0.5f, 0.1f, 5.0f);
    addParameter("Depth", 0.5f, 0.0f, 1.0f);
    addParameter("Wet Level", 0.5f, 0.0f, 1.0f);
}

FlangerEffect::~FlangerEffect() {}

void FlangerEffect::prepareToPlay(double sampleRate, int samplesPerBlock) {
    DspEffect::prepareToPlay(sampleRate, samplesPerBlock);
    
    // Set max delay to 20ms for flanger effect
    delayLine.setMaximumDelayInSamples(static_cast<int>(sampleRate * 0.02));
    delayLine.prepare({sampleRate, static_cast<juce::uint32>(samplesPerBlock), 2});
}

void FlangerEffect::releaseResources() {
    delayLine.reset();
}

void FlangerEffect::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) {
    if (bypassed) {
        processBlockBypassed(buffer, midi);
        return;
    }

    lfoFreq = parameters[0].value;
    lfoDepth = parameters[1].value;
    const float wet = parameters[2].value;
    const float dry = 1.0f - wet;
    
    const float lfoIncrement = (lfoFreq / currentSampleRate) * 2.0f * juce::MathConstants<float>::pi;
    const float minDelayMs = 0.5f;
    const float maxDelayMs = 5.0f;
    
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch) {
        for (int i = 0; i < buffer.getNumSamples(); ++i) {
            // Update LFO
            lfoPhase += lfoIncrement;
            if (lfoPhase > 2.0f * juce::MathConstants<float>::pi) {
                lfoPhase -= 2.0f * juce::MathConstants<float>::pi;
            }
            lfo = std::sin(lfoPhase);
            
            // Calculate modulated delay time
            const float delayMs = minDelayMs + (maxDelayMs - minDelayMs) * (0.5f + 0.5f * lfo * lfoDepth);
            const int delaySamples = static_cast<int>((delayMs / 1000.0f) * currentSampleRate);
            delayLine.setDelay(static_cast<float>(delaySamples));
            
            const float inSample = buffer.getSample(ch, i);
            const float delayedSample = delayLine.popSample(ch);
            const float outSample = inSample * dry + delayedSample * wet;
            
            delayLine.pushSample(ch, inSample);
            buffer.setSample(ch, i, outSample);
        }
    }
}
