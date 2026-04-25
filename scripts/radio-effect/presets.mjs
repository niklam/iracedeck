/**
 * Radio-effect ffmpeg presets.
 *
 * Each preset is an object:
 *   - name:         folder name under output/
 *   - description:  one-line intent
 *   - filterChain:  ffmpeg `-af` string applied to a single input
 *
 * Add / edit presets freely; process.mjs iterates this array.
 */

export const presets = [
  {
    name: "00-control-nofilter",
    description: "No filter, just re-encode. Sanity check — should sound like the input.",
    filterChain: "anull",
  },

  // Final winner after the spike.
  // 500-2400 Hz bandpass + 22 dB pre-gain into a hard soft-clipper,
  // attenuated 16 dB and bumped 4 dB back for output level.
  {
    name: "radio-engineer",
    description:
      "Primary radio effect — narrow bandpass + hard soft-clip overdrive. Tinny, bitey, clearly 'radio'.",
    filterChain:
      "highpass=f=500,lowpass=f=2400,volume=22dB,asoftclip=type=hard,volume=-16dB,volume=4dB",
  },

  // Alternate — same chain, hotter pre-gain. Kept as a second option if the
  // primary is ever judged too tame.
  {
    name: "radio-engineer-hot",
    description: "Same as radio-engineer but with 26 dB pre-gain. More squash at the peaks.",
    filterChain:
      "highpass=f=500,lowpass=f=2400,volume=26dB,asoftclip=type=hard,volume=-20dB,volume=4dB",
  },
];
