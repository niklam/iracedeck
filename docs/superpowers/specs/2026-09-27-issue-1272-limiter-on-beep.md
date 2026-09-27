# Limiter on beep

> **Issue:** [#1272](https://github.com/niklam/iracedeck/issues/1272) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

The Race Engineer plays one short tone the moment the player's pit limiter engages, anywhere on track, the pit box included.

- **When.** On `carControl.limiterToggled` with `on: true`, the `EngineWarnings.PitSpeedLimiter` bit's off→on edge in `diff/toggles.ts`. The event already exists and has no subscriber. The translator changes in one place: the edge now also fires in the pit stall, outside pit service (below). Off→on only: the off edge is silent.
- **What.** A new tone, a short falling two-note (under 250 ms), at `packages/audio-assets/sfx/IRD-pit-limiter-on.wav`. It is the mirror of #1161's rising exit chirp: rising means the limit is off and you can go, falling means you are now held. Neither may sound like `IRD-pit-speed-warning.wav`, the single repeating "too fast" tick.
- **How it plays.** A code-owned cue engine beside the pit-road speeding engine (#912) and the pit exit beep (#1161), calling `getAudio().playOnChannel(AudioChannel.Cue, …)` directly. Not a scripted contract, for #912's reasons: a tone has no wording for a voice pack to own, and a scriptless voice must not silence it.
- **Which channel and volume.** A new fifth mixer channel, `AudioChannel.Cue`, for one-shot pit-lane tones, routed to the Alerts bus at the Radar channel's mix ratio. It follows the Radar Volume slider like every other pit-lane tone, so the user sees no new setting, but it mixes alongside the radar and speeding ticks instead of replacing them (below).
- **The switch.** `calloutEnabledLimiterEngagedCue`, "Limiter on beep", in the Pit Limiter row of the Race Engineer callouts; default `true` (new Race Engineer functionality ships on), read live on each event. The engine checks the Race Engineer master itself: `applyRaceEngineerAudio()` leaves the Alerts bus unmuted when the engineer is off, so that check is load-bearing, exactly as in #912.

## When it stays silent

`diffToggles` seeds its baselines silently on the first tick and on any tick with `IsOnTrack` false, and `handleTick` returns at the replay guard before any diff and wipes state on both replay edges. So:

- **Connect, plugin restart, session change.** First tick after the wipe is a seed. A limiter already on when the engineer starts listening does not beep: unlike #912's level-driven tick, this is a one-shot about a moment, and the moment has passed.
- **Out of the car, tow, reset.** `IsOnTrack` is false on those ticks, so the baseline follows the bit and there is no edge when the car comes back.
- **Replay.** No diff runs, and the first live tick after it re-seeds.
- **Pit service.** While `PitstopActive` is true, and for `LIMITER_SERVICE_SETTLE_MS` (500 ms) after it falls, the limiter baseline follows the bit silently. This is the one new rule, and the next section says why.

Every other engagement beeps, the pit box included: a press in the stall after the car has been placed there at the start of a session or reset to it, and a press after a stop, before pulling away.

The engine therefore trusts the event and re-checks nothing in telemetry. That also keeps the harness shortcut audible without a telemetry patch.

## The translator change: the limiter leaves the stall seed

Today `diffToggles` also seeds on every tick with `PlayerCarInPitStall` true, for every signal it owns: the pit-service bits, the tire bits and compound, auto-fuel, DRS, P2P and the limiter. It returns before any edge is looked at, so a limiter press in the box can never publish. The seed exists for the pit-service bits, which iRacing flips one by one as each task completes, and for those it stays exactly as it is.

The limiter moves out of it. Its step is extracted into one function called from both the stall branch and the normal path, so the stall has one limiter rule rather than a copy: publish `carControl.limiterToggled` on a change, except while service is active or settling, when the baseline follows silently. DRS and P2P stay in the stall seed; nothing asked for them there.

**Why gate on service rather than on the stall.** `diff/limiter.ts` suppresses its warnings in the stall because "limiter state is noisy during service". That claim came in with the original pit-engineer import (`e60d1d7fe`, 2026-04-19, as "In pit stall (being serviced) — limiter state is noisy, suppress") with no capture or test behind it, and no capture in `local/` can confirm or refute it: the 2026-08-31 captures record `EngineWarnings` but contain no serviced stop and no stall flag, and the 2026-09-19 capture has a serviced stop and the stall and service flags but not `EngineWarnings`. So the guard takes the claim as stated, noise during service, and silences exactly that window instead of the whole stall. `PitstopActive` is the service window: in the 2026-09-19 capture it rises about 0.2 s before `PlayerCarInPitStall` and falls about 1.7 s before the car leaves the stall, and it never rises on the stop that took no service. The guard therefore reads `PitstopActive` wherever the car is, not only in the stall. The 500 ms tail after it falls absorbs a bit change landing on the tick service ends; a press inside that half second is silent, which costs nothing because the driver is still waiting for the crew to finish.

The capture that settles the model is one recording `EngineWarnings`, `dcPitSpeedLimiterToggle`, `PlayerCarInPitStall`, `PitstopActive` and `PlayerCarPitSvStatus` through a serviced stop with the limiter on, a stop with no service, and a press in the box. If it shows the bit steady through service, the tail can go; if it shows noise outside service in the stall, the guard widens to cover it.

**Rejected: a separate path on `dcPitSpeedLimiterToggle` in the stall.** The driver control is plausibly immune to whatever service does to the engaged bit, but it would give one event two sources whose baselines must agree at every stall boundary, or the car beeps twice or not at all on the way in and out. It could also miss the pit-limiter helper's automatic engagement, which the maintainer wants to beep: nothing says the helper moves the driver control rather than only the engaged bit.

**What this does to the published event.** `carControl.limiterToggled` gains emissions it never had: both edges in the pit stall outside service. It loses at most a tick or two on pit road where `PitstopActive` leads the stall flag. On track nothing changes. It has no consumers today: the grep finds only the emitter, the catalog type, the scenario-harness name list and a comment in pit-crew `index.ts`. The #639 entry in `race-engineer-callout-examples.md` still names it as a pit-limiter trigger, which has not been true since #1051 moved `limiter-on-track` to `pitLane.exited`; that line is corrected in the same change. The catalog entry has no JSDoc today and gets one saying when the event fires. Because the event catalog is a published contract, this puts the branch in the `xhigh` row of the review table.

## Rapid toggles

One beep per off→on edge, no debounce. The pit-service bits debounce 300 ms because they settle over several ticks; a wheel-button limiter bit flips in one, and a debounce would delay the confirmation by exactly the time the driver uses to press again. A quick on→off→on gives two beeps, which is true: it engaged twice. A double press that ends off gives one beep and then nothing, and on pit road the delayed "Limiter off on pit road" warning follows, so the case the requester worries about is still caught.

A second beep landing while the first is still sounding simply restarts it, since `playOnChannel` replaces the channel.

## A fifth mixer channel for one-shot cues

#912's tick is safe on Radar because the proximity radar clears itself on pit road. This beep plays on the circuit, where the radar ticks every 180–250 ms while a car is alongside, and on pit road, where #912's speeding tick loops every 300 ms. `playOnChannel` replaces whatever is playing on a channel, so on Radar a tick scheduled a few milliseconds after the beep starts would cut it to nothing. With a car alongside that is roughly one press in five losing its beep entirely, and a missing beep is read as "not engaged", which sends the driver back to the button.

**Decision: a new channel, `AudioChannel.Cue = 4`, for one-shot pit-lane tones.** It is routed to the Alerts bus at the Radar channel's mix ratio (1.0), so it follows the same Radar Volume slider and the settings window gains nothing. On its own channel the beep mixes alongside a radar or speeding tick instead of replacing it or being replaced. `radar-engine.ts` and `pit-speeding-engine.ts` are untouched.

What changes:

- `@iracedeck/audio-native`: `IRD_MAX_CHANNELS` goes from 4 to 5 in `addon.cc`, which sizes the fixed `g_channels`, `g_completionTSFN` and `g_tsfnRegistered` arrays; `Cue = 4` in the enum in `src/index.ts`; the mock takes channel 4 like any other (it does no range check today, and a test pins that).
- `@iracedeck/audio-service`: `Cue = 4` in the duplicated enum, `[AudioChannel.Cue]: AudioBus.Alerts` in the routing table, `1.0` in the mix-ratio table, and the three places that assume four channels: the end-callback registration loop in the constructor, the `stopAllChannels` loop, and the four-element `channelVolumes`, `channelCallbacks` and `channelActive` arrays. The last one is not cosmetic. The on-demand device lifecycle (#849) stops the stream only once every channel is idle, and it learns that a channel is idle from the end callback; a channel whose end callback is never registered would hold the device open and block PC sleep.
- Docs that state the count: `packages/audio-native/CLAUDE.md` (the "4-channel mixer" and "4 independent channels" wording, the `playOnChannel` range 0–3, and the Channel enum section), `packages/audio-native/README.md`, the header comments in `addon.cc` and `src/index.ts`, and the `audio-native` line in `.claude/CLAUDE.md`. The #912 entry in `race-engineer-callout-examples.md` says "the mixer has four channels" of a point in time and stays as it is.

**A stale binary degrades to silence.** Every native entry point checks `channel >= IRD_MAX_CHANNELS` and returns false, so a `.node` built before this change rejects channel 4: `playOnChannel` returns false, the service never marks the channel active, and the beep is silent rather than a crash or a stuck device. That binary is a real state, not a theoretical one: `pnpm build:ts` skips the native build, and a rebuild while a deck host holds the DLL reuses the existing `audio_native.node` (the Build behavior notes in `packages/audio-native/CLAUDE.md`, and the same caveat on `setSessionIdentity` there). The manual test therefore needs a full native rebuild with the deck host closed.

**The speeding tick stays on Radar.** It shares the channel only with the proximity radar, which is silent on pit road where the tick plays, and it repeats every 300 ms, so even a tick cut by a radar teardown restates itself a moment later. It is the one-shot that cannot afford to be cut, and that is the only thing the new channel is for.

**#1161's exit chirp moves to `Cue` too.** It has the same exposure — the radar resumes the moment the car leaves pit road — though its spec did not name it. The two one-shots share the channel and can cut each other, but they cannot realistically coincide: one follows a limiter press, typically on the approach or between the cones, the other the pit exit line. Whichever of the two issues lands first adds the channel; the other uses it.

## The setting's name and row

`calloutEnabledLimiterEngagedCue` follows `callout<Polarity><Family><Subject>` with the Pit Limiter family's `Limiter` prefix. `calloutEnabledLimiterOnCue` was rejected because it shares the `calloutEnabledLimiterOn` stem with `calloutEnabledLimiterOnTrack`, the kind of grep collision #1051 already paid for once. `Cue` as the subject matches `calloutEnabledPitSpeedingCue` and `calloutEnabledPitExitCue`, so `grep Cue` lists the tones.

The row is Pit Limiter, not Pit Speeding (settled by the maintainer, 2026-09-27): a driver looking for a limiter beep looks under the limiter. The Pit Limiter row's comment says its lines are gated on `hasPitLimiter`; this cue is not (next section), but it can only fire on a car whose limiter bit moves, which is the same population, so the row's promise holds.

## Not gated on `hasPitLimiter`

#912 recorded that the #639 gate is about wording: it keeps a sentence about a limiter away from a car without one. A tone has no wording, and the edge is its own capability check — a car that cannot engage a limiter never produces it. Gating on `dcPitSpeedLimiterToggle` would add a second, different source of truth for the same bit (the event reads `EngineWarnings`, the gate reads a driver control) and could only ever silence a real engagement.

## Why a tone contradicts #1051 without overturning it

#1051 stopped `limiter-on-track` firing on the toggle edge because "the only reachable case was pressing the button out on track, which a driver already knows they did". This request is the counter-case: at speed on the pit approach, the driver does not know. The #1051 reasoning still holds for a sentence, which would arrive after the moment and speak over the pit entry readback; it does not hold for a sub-250 ms tone that arrives with the press.

## What is already on the approach, and why nothing collides

The pit entry readback ("Remember the pit limiter", skipped when the limiter is already engaged) and the delayed "Limiter off on pit road" warning are both Voice-bus contracts. The beep is on the Cue channel with no family or weight, so it neither preempts them nor waits for them. The delayed warning re-checks the live limiter state when it speaks (#1138), so a press inside its 2.5 s window produces the beep and silences the warning, which is the pairing wanted.

## Alternatives rejected

- **A spoken confirmation.** Too slow for the moment it describes, and it collides with the pit entry readback.
- **A beep on off as well.** Not asked for; two tones to tell apart under braking is worse than one yes.
- **Only in the pit approach zone or on pit road.** The requester asked for anywhere, and a zone gate silences the early press a careful driver makes before the zone.
- **Playing on Radar and accepting the collision.** Leaves about one press in five silent with a car alongside, which is the failure the feature exists to remove.
- **Playing on Radar with a hold.** A shared module records "Radar held until t", and the radar and pit-speeding engines each defer a tick that falls inside the hold. It works, but it couples two unrelated engines to a shared timing module for the sake of a third, and it still delays their ticks. The fifth channel is a constant bump and touches neither engine.
- **An existing channel other than Radar.** `SFX` carries the radio open/close ticks that frame the readback speaking at that very moment, and `Ambient` the pit bed; both would cut the beep and put it on the Background slider, which users turn down to quiet ambience. `Voice` goes through the interpreter's queue.
- **A polyphonic pool of one-shot voices.** Considered and deferred. It would let any number of one-shots overlap, but the only two it would serve cannot coincide. Revisit if a third one-shot cue appears that can overlap one of them.

## Sim facts

Recorded from the maintainer, 2026-09-27:

- `EngineWarnings.PitSpeedLimiter` does not flicker on track. The Car Control action's key state already reads the same bit.
- A car does engage the limiter by itself when the driver has iRacing's pit-limiter helper (a driving aid) switched on. The beep fires then too, and that is wanted: it confirms the engagement whoever made it.

## Out of scope

- A tone for the limiter switching off.
- A pit-entry beep or distance cue tied to the entry line.
- A volume of its own for the pit-lane tones, separate from Radar.
- Renaming or regrouping the Pit Speeding and Pit Limiter settings rows.

## Testing

Suite:

- Engine: beeps on `on: true`, silent on `on: false`; silent with the toggle off and with the Race Engineer master off, both read live at the event; plays on `AudioChannel.Cue` with the new file.
- Channel: `AudioChannel.Cue` routes to the Alerts bus at the Radar channel's mix ratio, and a Radar Volume change reaches it; an end callback is registered for it, so the device-idle release still fires after a beep; `stopAllChannels` clears it; the mock accepts channel 4.
- Translator (`toggles`): no `limiterToggled { on: true }` on the first tick with the bit set, after `IsOnTrack` false→true with the bit set, on leaving the stall with the bit set, or on the first live tick after a replay; exactly one per off→on edge on track, on pit road and in the pit stall, including two for on→off→on.
- Translator, service: no `limiterToggled` for a bit change while `PitstopActive` is true, on the tick it falls, or within `LIMITER_SERVICE_SETTLE_MS` after; one for the first change after the tail; the pit-service, tire, DRS and P2P bits still seed silently in the stall, as before.
- Settings: the schema default is `true`, and each plugin's closure reads the key.

By hand, in iRacing, on a full native rebuild with the deck host closed:

- Engage the limiter on the circuit, on the approach, between the cones and stopped in the pit box: one beep each; disengage: nothing.
- A serviced stop with the limiter left on: no beep while the crew works or as the car pulls away.
- With iRacing's pit-limiter helper switched on: the automatic engagement beeps.
- Engage it with a car alongside (radar ticking): the beep is heard whole.
- Enter pit road over the limit without it (speeding tick running), then engage it: the beep is heard whole over the tick.
- Press twice quickly on the approach: one beep, then "Limiter off on pit road" on pit road.
- Tow, reset, a replay and a reconnect with the limiter on: no beep.
- The falling two-note reads as distinct from the speeding tick and the exit chirp; the final render is picked by ear from candidates as #912's was, with its gain baked into the asset.
