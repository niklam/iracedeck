# Voice clips are loudness-normalized in the audio pipeline

> **Issue:** [#1657](https://github.com/niklam/iracedeck/issues/1657) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Decision

Every voice clip gets one static gain, measured from its own source, before `RADIO_ENGINEER_FILTER`. The gain moves the clip's integrated loudness (ITU-R BS.1770, the `ebur128` measurement ffmpeg ships) to one fixed target. It runs inside the one function that already produces every processed clip, `processClipIntoCache` in `packages/audio-assets/src/build/index.mjs`, so the plugin build, `pack:voice`, the development voice staging and the scenario harness all get it, with no separate step anyone has to remember.

### How a clip is processed

1. `processClipIntoCache` reads the source into memory and writes the snapshot, as it does today (#1143).
2. **New:** it measures the snapshot's integrated loudness with a second ffmpeg run, `-stream_loop 7 -i <snapshot> -af ebur128=framelog=quiet -f null -`, and reads the summary's `I:` value. The loop makes eight copies of the clip, so even the shortest clip covers the meter's 3 s window and the 400 ms gating blocks. Looping does not change a signal's mean energy, so the measured value is still the clip's own.
3. **New:** the gain is `target − measured`, rounded to 0.1 dB and clamped to ±12 dB. The rounding keeps tiny float differences between machines from changing the encoded bytes. The clamp stops a bad clip (near-silent, or mostly noise) from being boosted into a blast. A clip that hits the clamp, or that measures below −50 LUFS (taken as silence and given 0 dB), gets a `warn` from the build naming the clip and its measured value. Under the build-output rule (`build-and-commit.md`) such a warning is fixed at the clip, never waved through.
4. The encode runs with `volume=<gain>dB,` in front of `RADIO_ENGINEER_FILTER`, then `ENCODE_ARGS`, unchanged.

The measurement runs on the snapshot, the same bytes that get hashed and encoded, so the #1143 rule still holds: a sidecar never vouches for audio it did not produce. A clip is measured only when it is re-encoded, so the measurement needs no cache of its own. The processed-clip cache stays fresh by content exactly as before.

### The target

The target is the **median integrated loudness of the Default voice's source clips**, measured once at implementation and rounded to a whole LU. It is written as a named constant beside `RADIO_ENGINEER_FILTER` in `src/presets.mjs`, with the measured value and its date in the comment. Sampling while this spec was written put Default's groups between −19 and −22 LUFS, so the constant is expected near −20 LUFS. Pinning the target to Default's own median leaves the voice most users hear at about the level it has today, so nobody has to re-set their Race Engineer volume. The Terse voice's quiet batches come up and its loud ones come down.

### The cache key

`pipelineHash` takes the normalization descriptor (target, clamp, rounding, the measurement filter string) beside the filter chain and the encode args. Changing any of them invalidates every processed clip once. The first build after this change reprocesses every voice clip of every voice. That costs time, since each clip now gets two ffmpeg runs instead of one, but no TTS call.

### Why before the radio filter

The filter's 8 dB pre-gain feeds a `tanh` soft clip and a limiter, and both act according to level. With mismatched levels going in, a loud clip is driven harder into saturation than a quiet one, so clips differ in tone as well as volume. Normalizing in front of the filter gives every clip the same drive, so the radio sound itself is consistent across the voice. Normalizing after the filter would even out the volume but keep the tone difference. It could also push peaks back past the limiter's ceiling.

### Why a static gain

A static gain keeps each clip's dynamics exactly as recorded, and it is the only kind of correction that keeps a seam between two clips clean: the clip keeps its own envelope, just shifted. ffmpeg's `loudnorm` filter in its default single-pass mode is a dynamic compressor tuned for programme material. On a 0.6 s clip it pumps, and it cannot reach linear mode without a measured first pass, which is what this design does more simply with `ebur128` and `volume`.

## What this changes for users

Every first-party pack's clip bytes change, so every pack in `VOICE_PACKS` (`default`, `iracedeck-terse` today) gets a `version` bump in the same change and a regenerated `catalog/<id>.json` from a flagless `pack:voice`. Each user downloads each pack once when the release ships. Callouts assembled from clips of different batches (the every-lap time `intro + lap-time-clock + lap-time-thousandths` in the Terse voice is the reported one) play at one level.

## Alternatives rejected

- **Normalize at generation time, rewriting the committed source clips.** This misses the clips that never pass through the generator: a clip copied from another voice (the Terse pack's 1000 thousandths), a clip Niklas edits by hand, a take replaced in Explorer. Normalization would then be one more step to remember, and forgetting it is exactly how the reported mismatch shipped. It would also throw away the dry sources, which are the input everything else is rebuilt from.
- **Gain only the quiet batch.** That fixes the one report and nothing like it. ElevenLabs output loudness varies between generation runs, so the next batch would bring the same problem back.
- **Normalize per group, or per voice to that voice's own median.** A per-group target keeps a mismatch wherever a callout joins two groups, which is the reported case. A per-voice median would hold each voice to itself but leave the two first-party voices at different levels, and with separate voice roles (#1642) two voices can play in one session.
- **RMS (`volumedetect`'s mean) instead of BS.1770.** RMS weights every frequency equally. BS.1770 applies the K-weighting curve that approximates how loud speech sounds, and it gates out the silence at a clip's ends, so a short line with a long tail is not read as quieter than it sounds.
- **Normalize at playback, in the plugin.** This would cover third-party packs too. But it needs either a per-clip gain field in the pack format, which is a published contract, or a loudness measurement at install time in the plugin, plus a gain stage in the native mixer path. That is a much larger change for packs whose loudness is their author's choice (below).

## Out of scope

- **Third-party packs.** A pack someone builds plays exactly what its author recorded. The radio filter is iRaceDeck's own pipeline, not theirs (`voice-packs/first-pack.md`), and so is this step. The tutorial gets one sentence recommending consistent export levels, nothing more.
- **A per-entry loudness offset** for a line that should deliberately sit louder or quieter than the rest. No line needs one today: urgency in these clips comes from the delivery, not the level. If one ever does, a per-entry field in the voice config can add an offset to the target without changing this design.
- **Sound effects (`sfx/`).** They are copied unchanged, as today. The ticks, the ambience bed and the radar tones have levels chosen against the voice on purpose, and the user's Background volume governs them.
- **Changing `RADIO_ENGINEER_FILTER` itself** or the encode arguments.
- **Re-cutting any clip.** No ElevenLabs call is part of this.

## Testing

Unit, in `packages/audio-assets/src/build/index.test.ts`, on clips the test synthesizes with ffmpeg's `lavfi` source (no committed fixture):

- Two speech-band tone bursts at −32 and −14 LUFS come out within 0.5 LU of each other after processing, measured on the processed mp3.
- A burst shorter than 400 ms gets a finite gain and comes out within 1 LU of the target, which shows that looping covers the gating window.
- Digital silence gets 0 dB and a `warn` naming the clip. A clip that would need more than 12 dB gets exactly 12 dB and a `warn`.
- Changing the target constant changes `pipelineHash`, so every cached clip is stale again.
- The existing determinism test in `src/pack-voice.test.ts`, which packs twice through separate caches and compares hashes, still passes. That shows the measurement adds no variation between runs.

Measured on the real voices, recorded in the PR body: the integrated loudness of every processed clip of both first-party voices, before and after, as the median and the 5th–95th percentile spread per voice. The spread is expected to close to within about ±1 LU, and Default's median to move by less than 1 LU. For the reported line, the Terse voice's `lap-time-clock/1m23` and `lap-time-thousandths/456` are processed and their loudness compared; they are expected within 1 LU of each other, against 2.8 LU today.

Reproducibility on the release runner: the release and publish workflows run on `windows-latest` (`release-pack.yml`, `publish-voice-packs.yml`) and verify their own archive against the committed catalog entry, so before tagging, the *Publish voice packs* workflow runs with `publish` off on the branch's packs. A sha mismatch there means the measurement or the rounding is not reproducible between the author's machine and the runner, and it is fixed before release, never by regenerating the entry on one machine. (Amended 2026-11-09: the spec said the runner is Linux.)

Listening, by Niklas, on a `review-page` artifact: before and after for each voice, covering the every-lap time 1:23.456 in both voices, a flag line, a pit readback and a spotter call. Then in the sim through the development voice root (`pnpm stage:voices`, Rescan voices), with lap times read across several laps.
