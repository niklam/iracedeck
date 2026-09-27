# Pit exit beep

> **Issue:** [#1161](https://github.com/niklam/iracedeck/issues/1161) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

The Race Engineer plays one short tone the moment the player crosses the pit exit line.

- **When.** On `pitLane.exited`, the player's `OnPitRoad` on→off edge, which is where the pit speed limit ends. It plays only while the player is in the car (`IsOnTrack` on that tick) and not in a replay, so leaving the car, a tow or a reset is silent. There is no speed threshold: a car queueing out of a closed exit still crosses the line.
- **What.** A new tone, a short rising two-note chirp (under 250 ms), added under `packages/audio-assets/sfx/`. It must not sound like `IRD-pit-speed-warning.wav`: that tone means "too fast", and this one means "limit's off".
- **How it plays.** A code-owned cue engine beside the pit-road speeding engine (#912), calling `getAudio().playOnChannel(AudioChannel.Cue, …)` directly. It is not a scripted contract, for the reasons #912 gave: a tone has no wording for a voice pack to own, and a scriptless voice must not silence a safety cue.
- **Which channel and volume.** `AudioChannel.Cue`, a fifth mixer channel for one-shot pit-lane tones, routed to the Alerts bus at the Radar channel's mix ratio, so the beep follows the Radar Volume slider like the speeding tick and the user sees no new setting. Not the Radar channel itself: the proximity radar resumes the moment the car leaves pit road, and `playOnChannel` replaces whatever is playing on a channel, so a radar tick landing just after the edge would cut the beep to nothing. The channel is added by whichever of this issue and the limiter-on beep lands first; its design, and why a hold on Radar was rejected, are in `2026-09-27-issue-1272-limiter-on-beep.md` (#1272).
- **The switch.** `calloutEnabledPitExitCue`, "Pit exit beep", in the same settings-window section as "Pit road speeding"; default `true` (new Race Engineer functionality ships on), read live on each event, and inert while the Race Engineer gate is off.

## What is already at pit exit, and why nothing collides

"Limiter still on after pit exit" follows the same edge by about 1.5 s, and the "To confirm: …" exit readback by 4.5 s. Both are Voice-bus contracts in their own families. The beep is on the Cue channel with no family or weight, so it neither preempts them nor waits for them.

## Alternatives rejected

- **A spoken line.** It lands a second or more after the moment it describes, and it would crowd the limiter line and the readback that follow.
- **The end of the exit blend.** That point is not in telemetry; it needs the learned landmarks of #1112. The speed-limit line is available now and is the moment the driver acts on. Should a blend-end cue be wanted later, it belongs to #1113's pit-exit traffic work, not here.
- **A pit-entry twin.** Not asked for, and the pit entry speed reminder already covers entry.

## Sim facts this rests on

Settled with the maintainer on 2026-09-13: `OnPitRoad` falls exactly where the pit speed limit ends, and a driver cannot leave a moving car, so leaving the car never produces the edge the cue listens for.
