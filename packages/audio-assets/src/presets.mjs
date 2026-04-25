/**
 * Canonical radio-effect filter applied to voice MP3s at build time.
 *
 * Tuned during the radio-effect spike (see scripts/radio-effect/ and commit
 * 5a3ff314). 500-2400 Hz bandpass + 22 dB pre-gain into a hard soft-clip,
 * attenuated 16 dB and bumped 4 dB for output level — tinny + bitey race
 * engineer character.
 *
 * Changing this string automatically invalidates the processed-asset cache
 * (the cache path embeds a hash of the filter chain).
 */
export const RADIO_ENGINEER_FILTER =
  "highpass=f=500,lowpass=f=2400,volume=22dB,asoftclip=type=hard,volume=-16dB,volume=4dB";

/**
 * Subfolders of packages/audio-assets/pit-crew/ whose MP3s should be processed
 * through RADIO_ENGINEER_FILTER. Anything outside pit-crew/ (currently just
 * sfx/) is copied unchanged — SFX tones, ticks and squelch beeps should not
 * be radio-filtered.
 */
export const VOICE_CATEGORIES = new Set([
  "acknowledgment",
  "connector",
  "flags",
  "fuel",
  "greeting",
  "incidents",
  "names",
  "overtake",
  "pitlane",
  "radar",
  "reminder",
  "tips",
  "toggle",
]);
