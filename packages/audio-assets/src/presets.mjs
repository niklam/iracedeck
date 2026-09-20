/**
 * Canonical radio-effect filter applied to voice clips at build time.
 *
 * 250-3500 Hz bandpass + 8 dB pre-gain into a `tanh` soft-clip (smoother
 * than `hard`), then a brick-wall limiter at -0.5 dBFS. The limiter catches
 * the peaks the pre-gain pushes past 0 dBFS while the rest of the signal
 * stays uncompressed — louder than dry TTS, but the voice's natural
 * dynamics are preserved.
 *
 * Applied to every voice source clip under voice/ at build time. Anything
 * outside voice/ (currently only sfx/) is copied unchanged — SFX tones,
 * ticks and squelch beeps should not be radio-filtered.
 *
 * **There is deliberately no trailing pad, and that is a reversal (#1108).**
 * #1127 appended `apad=pad_dur=0.09` here, reasoning that `interpreter.ts`
 * chains a callout's clips on the "clip finished" callback with no gap, so a
 * native end-callback firing a hair before the buffer drains would clip the
 * final consonant. Nothing ever recorded a word that came out wrong — not the
 * spec, not the PR, not a test, not an issue — so the pad was a 90 ms margin
 * on every clip against a defect nobody had heard.
 *
 * What it cost was audible. A clip conditioned to run into the next one ends
 * mid-phrase by design: `session-start-temp-numbers/28` stops on the closure
 * of the "d" that starts "degrees", and the temperature line then spoke it as
 * "twenty eight" — pause — "degrees Celsius". The maintainer heard the join,
 * the pad came off, and every seam tightened. The rule it broke: **some clips
 * must carry no padding at all.** A clip generated with `next_text` is cut to
 * run straight into the words that follow — it ends on a consonant that has
 * not finished, and any silence appended to it is a stutter in the middle of
 * a phrase. A filter applied to every clip cannot know which ones those are,
 * so it must add nothing. Spacing between two spoken words belongs to the
 * clips themselves (a value and its unit recorded as one line, as
 * `numbers-percent` and `car-number` do) or to a `pause` step where a script
 * wants one — never to silence smeared across all of them.
 *
 * If a final consonant IS ever swallowed, fix it where it happens — in the
 * audio service's end-callback handling — rather than padding 2800 clips.
 *
 * Changing this string automatically invalidates the processed-asset cache
 * (the cache path embeds a hash of the filter chain), so the next plugin
 * or harness build reprocesses every voice clip from source. That is what
 * makes the pad free to tune: no clip is re-generated from the TTS API,
 * and the committed sources are never touched.
 */
export const RADIO_ENGINEER_FILTER =
  "highpass=f=250,lowpass=f=3500,volume=8dB,asoftclip=type=tanh,alimiter=limit=0.95";
