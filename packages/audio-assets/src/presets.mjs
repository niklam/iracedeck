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
 * mid-phrase by design: `session-start-temp-numbers/28` (the bare-number
 * temperature group #1187 replaced) stopped on the closure of the "d" that
 * starts "degrees", and the temperature line then spoke it as
 * "twenty eight" — pause — "degrees Celsius". The maintainer heard the join,
 * the pad came off, and every seam tightened. The rule it broke: **some clips
 * must carry no padding at all.** A clip generated with `next_text` is cut to
 * run straight into the words that follow — it ends on a consonant that has
 * not finished, and any silence appended to it is a stutter in the middle of
 * a phrase. A filter applied to every clip cannot know which ones those are,
 * so it must add nothing. Spacing between two spoken words belongs to the
 * clips themselves (a value and its unit recorded as one line, as
 * `numbers-percent`, `numbers-degrees` and `car-number` do) or to a `pause` step where a script
 * wants one — never to silence smeared across all of them.
 *
 * If a final consonant IS ever swallowed, fix it where it happens — in the
 * audio service's end-callback handling — rather than padding 2800 clips.
 *
 * **Every clip reaches this chain already loudness-normalized (#1657).** The
 * build prepends a static `volume=<gain>dB` measured from the clip itself (see
 * `VOICE_LOUDNESS_NORMALIZATION` below), so the 8 dB pre-gain drives every
 * clip into the soft clip and the limiter equally hard. Without it a loud
 * batch of clips was saturated more than a quiet one, and two clips joined in
 * one callout differed in tone as well as in level.
 *
 * Changing this string automatically invalidates the processed-asset cache:
 * it is a field of the pipeline identity (`PIPELINE_IDENTITY` in
 * `src/build/index.mjs`), whose hash names the cache directory and is the pack
 * record's `inputs.pipeline`. So the next plugin or harness build reprocesses
 * every voice clip from source, and every committed pack reads as stale until
 * it is re-packed. That is what makes the filter free to tune: no clip is
 * re-generated from the TTS API, and the committed sources are never touched.
 */
export const RADIO_ENGINEER_FILTER = "highpass=f=250,lowpass=f=3500,volume=8dB,asoftclip=type=tanh,alimiter=limit=0.95";

/**
 * How every voice clip's level is evened out before `RADIO_ENGINEER_FILTER`
 * (#1657): one static gain per clip that moves its integrated loudness
 * (ITU-R BS.1770, as ffmpeg's `ebur128` filter measures it) to `targetLufs`.
 * The design and the alternatives it rejected are in
 * `docs/superpowers/specs/2026-11-08-issue-1657-voice-clip-loudness-normalization.md`.
 *
 * - `targetLufs` — the median integrated loudness of the Default voice's 4,810
 *   source clips, measured 2026-11-09 at -21.7 LUFS with ffmpeg-static 5.3.0
 *   (`ebur128` on each clip looped 8x, the method below), rounded to a whole
 *   LU. The Terse voice's median was -23.2 LUFS; the 5th-95th percentile
 *   spread was about -28.7 to -17 LUFS in both voices, so no clip there needs
 *   more than the clamp. Pinned to Default's own median so the voice most
 *   users hear keeps about the level it had, and nobody re-sets a volume.
 * - `maxGainDb` — the clamp, either way. A clip that needs more (near-silent,
 *   or mostly noise) gets exactly this and a build warning, so a bad clip is
 *   never boosted into a blast and is fixed at the clip.
 * - `gainStepDb` — the gain is rounded to this step, so float noise between
 *   machines can never change a clip's encoded bytes. The gain reaches ffmpeg
 *   printed with as many decimals as this step has.
 * - `silenceFloorLufs` — a clip measuring below it (ebur128 reports digital
 *   silence as -70 LUFS, or `-inf`) is taken as silence: 0 dB and a warning.
 * - `measurement` — how the source is measured: `loops` copies of the clip
 *   (`-stream_loop <loops - 1>`), so even the shortest clip fills the meter's
 *   3 s window and its 400 ms gating blocks (looping leaves the mean energy,
 *   and so the reading, unchanged), through `filter`.
 *
 * The whole object is a field of the pipeline identity, so changing any value
 * here re-encodes every clip once and marks every committed pack stale, as a
 * filter change does. The measurement's ffmpeg arguments are built from it, so
 * what is hashed and what runs cannot drift apart.
 */
export const VOICE_LOUDNESS_NORMALIZATION = Object.freeze({
  targetLufs: -22,
  maxGainDb: 12,
  gainStepDb: 0.1,
  silenceFloorLufs: -50,
  measurement: Object.freeze({ loops: 8, filter: "ebur128=framelog=quiet" }),
});
