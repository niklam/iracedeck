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
 * The trailing `apad` is the one part that is about SEQUENCING rather than
 * tone (issue #1127). A callout is several clips played back to back, and
 * `interpreter.ts` chains them on the "clip finished" callback with no gap
 * at all — so the spacing between two spoken words is whatever silence the
 * clips happen to carry. Measured across the reference voice, that is
 * essentially none: trailing silence is 0.000 s on every clip sampled, and
 * leading silence averages ~20 ms. Words therefore butt straight into one
 * another, and a native end-callback that fires a hair before the buffer
 * drains clips the final consonant outright. 90 ms of digital silence on
 * the tail buys the breath the recordings do not have and gives that
 * callback somewhere harmless to land. It is deliberately NOT a `pause` op
 * in each script: the gap is a property of how clips are joined, so a fix
 * per script would have to be repeated in every voice pack anyone writes.
 *
 * Changing this string automatically invalidates the processed-asset cache
 * (the cache path embeds a hash of the filter chain), so the next plugin
 * or harness build reprocesses every voice clip from source. That is what
 * makes the pad free to tune: no clip is re-generated from the TTS API,
 * and the committed sources are never touched.
 */
export const RADIO_ENGINEER_FILTER =
  "highpass=f=250,lowpass=f=3500,volume=8dB,asoftclip=type=tanh,alimiter=limit=0.95,apad=pad_dur=0.09";
