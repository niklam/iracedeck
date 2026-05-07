/**
 * Canonical radio-effect filter applied to voice MP3s at build time.
 *
 * 250-3500 Hz bandpass shapes the radio character. A `tanh` soft-clip and
 * a brick-wall limiter at -0.5 dBFS sit at unity gain afterwards purely as
 * peak safety — they don't engage on a typical voice signal. No bake-in
 * makeup gain (issue #522): the user's `raceEngineerVolume` slider is the
 * sole loudness control, with full headroom in both directions.
 *
 * Applied to every .mp3 under voice/ at build time. Anything outside voice/
 * (currently only sfx/) is copied unchanged — SFX tones, ticks and squelch
 * beeps should not be radio-filtered.
 *
 * Changing this string automatically invalidates the processed-asset cache
 * (the cache path embeds a hash of the filter chain), so the next plugin
 * or harness build reprocesses every voice clip from source.
 */
export const RADIO_ENGINEER_FILTER = "highpass=f=250,lowpass=f=3500,asoftclip=type=tanh,alimiter=limit=0.95";
