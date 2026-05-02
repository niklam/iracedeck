/**
 * Canonical radio-effect filter applied to voice MP3s at build time.
 *
 * 250-3500 Hz bandpass + 8 dB pre-gain into a `tanh` soft-clip (smoother
 * than `hard`), then a 3:1 compressor with 4 dB makeup gain into a
 * brick-wall limiter at -0.5 dBFS. The compressor squashes dynamics so
 * the perceived loudness sits closer to the SFX bed without spiky peaks
 * fighting the limiter; the limiter catches whatever the compressor
 * lets through. Reads as "two-way radio" — a touch more pinned than
 * dry TTS, but still kind to long-session listening.
 *
 * Applied to every .mp3 under voice/ at build time. Anything outside voice/
 * (currently only sfx/) is copied unchanged — SFX tones, ticks and squelch
 * beeps should not be radio-filtered.
 *
 * Changing this string automatically invalidates the processed-asset cache
 * (the cache path embeds a hash of the filter chain), so the next plugin
 * or harness build reprocesses every voice clip from source.
 */
export const RADIO_ENGINEER_FILTER =
  "highpass=f=250,lowpass=f=3500,volume=8dB,asoftclip=type=tanh,volume=-6dB,acompressor=threshold=-20dB:ratio=3:attack=5:release=50:makeup=4,alimiter=limit=0.95";
