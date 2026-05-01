/**
 * Canonical radio-effect filter applied to voice MP3s at build time.
 *
 * 250-3500 Hz bandpass + 8 dB pre-gain into a `tanh` soft-clip (smoother
 * than `hard`), attenuated 6 dB and bumped 2 dB for output level. Light
 * touch — just enough band-limiting and saturation to read as "team
 * radio" rather than dry TTS, without the bitey character that grates
 * across a long race session.
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
  "highpass=f=250,lowpass=f=3500,volume=8dB,asoftclip=type=tanh,volume=-6dB,volume=2dB";
