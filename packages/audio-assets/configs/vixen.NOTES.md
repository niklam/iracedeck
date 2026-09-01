# Vixen — notes attached to the artifact

Not a config. The generator loads only `*.voice.json` (`generate/config.ts`
filters on that suffix), so this file is inert to it.

## Vixen is not a quiet voice — a pack built from these sources will be

Measured 2026-09-01 with the repo's own ffmpeg, `volumedetect`, mean volume:

| clip | Vixen raw | Vixen **processed** | `default` processed |
| --- | --- | --- | --- |
| `welcome/hello` | −19.5 dB | −13.9 dB | −10.9 dB |
| `openers/hi` | −24.8 dB | −18.7 dB | −20.9 dB |
| `session-start/wetness-dry` | −30.4 dB | −24.5 dB | −26.8 dB |

Once processed, Vixen sits within ~3 dB of `default` and is **louder** on two
of the three. Raw, it is 4–9 dB below what a user hears from the bundled voice.

**The cause is pack construction, not generation.** The committed
`voice/**/*.mp3` are dry TTS sources; every bundled clip is run through
`RADIO_ENGINEER_FILTER` at plugin build time
(`highpass=250,lowpass=3500,volume=8dB,asoftclip=tanh,alimiter=0.95`, then
16 kHz mono 32 kbps), which adds roughly +6 dB mean. The first hand-made
sideload pack from this branch skipped that step and was reported in testing as
"way too quiet" — correctly, and for that reason.

**Any pack built from these sources must run them through that pipeline first.**
The #1034 spec says the eventual packer does exactly this, so a clip in a real
pack is "byte-identical to what the plugin would otherwise have shipped". That
packer does not exist yet, so a hand-built pack has to do it by hand.

## What this branch is

A holding branch. Vixen exists to test that a sideloaded voice plays its **own**
recordings — the one #1034 item no automated test could stand in for. It passed.

`packages/audio-assets/voice/vixen/` is the **bundled**-voice location, so
merging this branch would be the decision to bundle Vixen, which is a different
decision from releasing it as a downloadable pack. Neither has been taken.

Scope is 28 clips: the sim-start brief, the radio check, and three greeting
names (`niklas`, `ant`, `lorenzo`). Widening it is additive — add entries to the
existing groups, or add groups; nothing here needs restructuring first.
