/**
 * Canonical radio-effect filter applied to voice MP3s at build time.
 *
 * 300-3000 Hz bandpass + 14 dB pre-gain into a hard soft-clip, attenuated
 * 10 dB and bumped 3 dB for output level. Wider band + lighter drive than
 * the original 500-2400 Hz / 22 dB tune — sounds like modern team radio
 * instead of vintage AM, so it doesn't grate during a race.
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
  "highpass=f=300,lowpass=f=3000,volume=14dB,asoftclip=type=hard,volume=-10dB,volume=3dB";
