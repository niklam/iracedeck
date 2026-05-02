/**
 * Canonical radio-effect filter applied to voice MP3s at build time.
 *
 * 250-3500 Hz bandpass + 8 dB pre-gain into a `tanh` soft-clip (smoother
 * than `hard`), pulled back 6 dB to a working level and then bumped 6 dB
 * makeup into a brick-wall limiter at -0.5 dBFS. The limiter catches the
 * peaks the makeup gain pushes past 0 dBFS while the rest of the signal
 * stays uncompressed — louder than dry TTS, but the voice's natural
 * dynamics are preserved.
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
  "highpass=f=250,lowpass=f=3500,volume=8dB,asoftclip=type=tanh,volume=-6dB,volume=6dB,alimiter=limit=0.95";
