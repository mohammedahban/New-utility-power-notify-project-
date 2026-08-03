#!/usr/bin/env python3
"""
Generate a real alarm.wav file (44100Hz, 16-bit, mono, 3 seconds).
Alternating 880Hz/440Hz beeps with fade envelope.
"""
import wave
import struct
import math

SAMPLE_RATE = 44100
DURATION = 3.0  # seconds
VOLUME = 0.5

def generate_tone(frequency, duration, sample_rate, volume=1.0, fade_in=0.01, fade_out=0.05):
    """Generate a sine wave tone with fade in/out."""
    samples = int(duration * sample_rate)
    wave_data = []
    for i in range(samples):
        t = i / sample_rate
        # Sine wave
        value = math.sin(2 * math.pi * frequency * t)
        # Fade envelope
        if i < fade_in * sample_rate:
            value *= i / (fade_in * sample_rate)
        elif i > samples - fade_out * sample_rate:
            value *= (samples - i) / (fade_out * sample_rate)
        wave_data.append(int(value * volume * 32767))
    return wave_data

# Generate alternating 880Hz and 440Hz beeps (each 0.25s with 0.05s gap)
beep_duration = 0.25
gap_duration = 0.05
total_beep_cycle = beep_duration + gap_duration
num_cycles = int(DURATION / total_beep_cycle)

all_samples = []
for cycle in range(num_cycles):
    freq = 880 if cycle % 2 == 0 else 440
    all_samples.extend(generate_tone(freq, beep_duration, SAMPLE_RATE, VOLUME))
    # Gap (silence)
    gap_samples = int(gap_duration * SAMPLE_RATE)
    all_samples.extend([0] * gap_samples)

# Fill remaining time with silence if needed
remaining = int(DURATION * SAMPLE_RATE) - len(all_samples)
if remaining > 0:
    all_samples.extend([0] * remaining)

# Write WAV file
with wave.open('assets/sounds/alarm.wav', 'wb') as wav_file:
    wav_file.setnchannels(1)  # mono
    wav_file.setsampwidth(2)  # 16-bit
    wav_file.setframerate(SAMPLE_RATE)
    wav_file.writeframes(struct.pack('<' + 'h' * len(all_samples), *all_samples))

print(f"Generated alarm.wav: {len(all_samples)} samples, {len(all_samples)/SAMPLE_RATE:.2f}s")

# Also copy to Android raw resources
import shutil, os
os.makedirs('android/app/src/main/res/raw', exist_ok=True)
shutil.copy2('assets/sounds/alarm.wav', 'android/app/src/main/res/raw/alarm.wav')
print("Copied to android/app/src/main/res/raw/alarm.wav")