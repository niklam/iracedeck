> **Issue:** [#912](https://github.com/niklam/iracedeck/issues/912) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: repeating audio cue while speeding on pit road

## The problem

A pit-road speeding penalty is one of the cheapest ways to throw away a race, and iRacing gives the driver almost nothing to act on: the speed readout is on a display you are not looking at while judging a pit box, and by the time the penalty appears it is already too late. Rafter asked for an audio warning on Discord, and the shape of the request matters — a beeper, like a road car's over-speed chime, not a sentence. The driver needs to know *within a tenth of a second* that their right foot is wrong, and to keep knowing it until they fix it.

That rules out the Race Engineer's normal delivery. A voice callout is scheduled through the interpreter, framed with radio-open and radio-close ticks, and weighed against everything else queued on the Voice bus — the mechanism exists to stop the engineer talking over himself, and it is exactly wrong for a warning whose entire value is being instantaneous and continuous.

### The premise the issue got wrong

The issue records, as an agreed decision, that *"the existing voice line stays: `pit-crew.limiter-speeding` keeps firing as today. The two complement each other."* It does not fire, and never has. `packages/audio-scenarios/src/catalog/pit-crew/pit-limiter.ts` defines four scenarios — `limiter-on-track`, `limiter-missing`, `limiter-dropped`, `limiter-speeding` — and nothing registers any of them: no reference to that module exists anywhere outside the module itself and its own unit test. The translator has been emitting `limiter.speeding`, `limiter.missing` and `limiter.dropped` into a bus with no subscriber.

So this is not the instant half of a pair. **It is the only pit-road speeding feedback iRaceDeck has ever given.** Two consequences run through the rest of this document: there is no voice line to coexist with, tune against, or defer to; and the manual test carries more weight than it would for a feature with a working sibling to compare against.

Waking the dormant limiter family is deliberately **out of scope**. It needs its own opt-in keys, PI rows, clip verification, and a decision about whether "limiter missing" and "limiter dropped" are wanted at all — and `limiter-speeding` carries the #639 `hasPitLimiter` gate, which directly contradicts this issue's decision that the cue is *not* limiter-gated. Registering it here would ship two speeding warnings with different eligibility rules under one spec that covers neither pairing. It gets its own issue.

That scoping is the one call in this document still open at the time of writing. If it is reversed and the limiter family is woken alongside the cue, only this section and the follow-up list change: nothing below depends on the voice line existing, because the cue was designed against a bus with no subscriber on it. What *would* need writing then is the pairing rule the two warnings share — which one speaks first, and whether a car with no limiter hearing only the tick is acceptable — and that belongs in whichever spec covers both.

## What ships

While the player is over the posted pit-lane speed limit on pit road, a short tick repeats at a fixed interval until the speed drops back under. It is gated by the Race Engineer master and one new per-callout opt-in, default on. The clip is the existing radar tick as a placeholder; replacing it with a purpose-made tone is a follow-up that touches one constant.

## Decisions

### 1. Direct playback, not interpreter-scheduled — and what that settles for free

`radar-engine.ts` is the model: an imperative module that calls `getAudio().playOnChannel(...)` itself. The #651 spotter engine is *not* the model, despite the issue naming both. The spotter is imperative in its state machine but routes every clip through `getScenarioEngine().fire(...)`, so it inherits weights, families and the focus floor. Copying it would reintroduce the scheduling latency this feature exists to avoid.

This choice answers the issue's second open question — *should the tick duck under a `PROXIMITY` spotter call?* — structurally rather than by policy. **No.** With no interpreter fire there is no weight, no family and no focus contest to arbitrate; the tick and a "Car left." call are on different buses and simply coexist. There is no knob here to get wrong later, which is the point.

The trade being accepted: a tick every second will overlap the words of a spotter call. That is judged correct — both are proximity-class safety signals with independent volume controls, and a driver at speed on pit road wants both — but it is the kind of thing that can only really be judged by ear, so it is explicitly on the manual-test list.

### 2. Channel: `AudioChannel.Radar`

The mixer has four channels, and the choice is forced once you look at what occupies each *on pit road specifically*:

| Channel | Bus | Occupant | Verdict |
|---|---|---|---|
| `Voice` | Voice | every engineer line | no |
| `SFX` | Background | the walkie-talkie open/close ticks framing **every** radio callout | contended |
| `Ambient` | Background | the pit ambient bed | contended |
| `Radar` | Alerts | the radar engine, which force-clears itself on pit road | free |

`playOnChannel` replaces whatever is playing on that channel, so `SFX` or `Ambient` would have the cue and the engineer's own radio framing cutting each other roughly once a second — and both are busiest exactly during a pit stop. `Radar` is the only channel whose sole other producer is *guaranteed silent* where this cue lives, because the radar engine suppresses itself on pit road by design. That the placeholder clip happens to be a radar tick is a convenience, not the reason.

Two consequences follow and are accepted:

- The cue rides the **Radar volume slider** on the Alerts bus. A user who zeroes radar because they dislike proximity ticks silences this too. Documented on the website rather than worked around; a fifth channel would mean changing the native four-channel mixer.
- `applyRaceEngineerAudio()` mutes the Voice and Background buses when the Race Engineer master is off and **deliberately leaves Alerts alone**. So the engine's own master-gate check is load-bearing, not defence in depth — without it the cue would keep beeping with the engineer switched off. This is the same reason `radar-engine` reads its master getter inside every scheduled tick.

A residual, accepted: radar's `forceClear()` and `setRadarEnabled(false)` call `stopChannel(AudioChannel.Radar)`, so a radar teardown landing mid-tick can truncate one clip. The loop reschedules, so the cost is at most one shortened tick, and it can only happen at the instant the car reaches pit road.

### 3. The trigger is level-driven, and that is why there is no seed flag

The issue's first open question is whether connecting mid-speeding should start the cue immediately or seed silently like other diffs. **Immediately**, and the argument is not the radar analogy the issue offers — it is the general rule #951 paid a review catch for: *a repeating callout must be driven by current state; only a one-shot may be edge-driven.*

The pit-status nags shipped edge-armed, so anything that re-seeded the diff mid-stop left a latched error with no edge to arm on and went permanently silent. Those re-seed paths are ordinary, not exotic — a plugin restart from a deck-host auto-update, an SDK reconnect, a one-tick `IsOnTrack: false` blip, the replay flip — and every one of them is reachable while a car is on pit road. Seeding silently here rebuilds exactly that hole: a driver already over the limit when the plugin restarts hears nothing until they slow down and speed up again.

The encoding is pleasingly small. The correct baseline on a fresh state *is* "not speeding", which is the natural initial value of the one boolean this diff owns, so there is **no `pitSpeedingInitialized` flag at all**. The absence of a seed flag is not an oversight — it is how the level-driven decision is written down, and a future reader adding one would silently reintroduce #951's bug.

### 4. A separate diff module, not an extension of `limiter.ts`

`diffLimiter` is an early-return ladder, and on any tick where `limiter.missing` or `limiter.dropped` fires it returns before reaching its speeding check. A start edge placed after those returns would be swallowed on precisely the ticks a driver is most likely to be speeding — arriving on pit road with the limiter off. `diff/pit-speeding.ts` is therefore its own module.

It reads `PlayerCarInPitStall` from telemetry directly rather than from `state.lastInPitStall`, so unlike `diffLimiter` it does not need the must-run-before-`diffPitLane` slot; it sits next to `diffLimiter` for readability, not for ordering.

Its condition is `IsOnTrack && OnPitRoad && !PlayerCarInPitStall && pitSpeedLimitMps > 0 && Speed > pitSpeedLimitMps`. Note it deliberately differs from the dormant voice line's in three ways: no `+1.0 m/s` margin (the limiter holds cars slightly *under* the limit, so riding it stays silent and anything above it is a real offence), no creep guard, and no `hasPitLimiter` gate — pit-road penalties apply to every car, and a car without a limiter is the one that most needs telling.

The `pitSpeedLimitMps > 0` term is mandatory rather than defensive: `resolvePitSpeedLimit` returns `0` for an unparsed or missing `WeekendInfo.TrackPitSpeedLimit`, and resets to `0` on a track or session change before re-parsing. Without the term, a track whose YAML we cannot read would beep continuously.

**Hysteresis on the end edge only.** The episode starts strictly above the limit and ends at or below `limit - PIT_SPEEDING_HYSTERESIS_MPS` (0.2 m/s, ≈0.7 km/h), so GPS jitter sitting exactly on the limit cannot flutter start/end at tick rate. The other four terms end the episode with no hysteresis — there is nothing noisy about leaving pit road.

### 5. The episode must always end — three independent layers

This is the failure that matters. Everything else about this feature degrades into silence, which is merely disappointing; a lost end edge leaves a tick beeping over a race with no way to stop it short of restarting the plugin. One mechanism is not enough, so there are three, and they fail independently.

**Layer 1 — the diff's own ineligibility branch.** Any term of the condition ceasing to hold ends the episode: slowed down, left pit road, entered the stall, left the car, limit became unknown. This is the `offTrack.started`/`ended` shape in `diff/incidents.ts`, which is the closest in-diff precedent.

**Layer 2 — the translator teardown publishes.** `offTrack` is the *wrong* model for this half: it silently drops its `ended` on replay, session change and disconnect, because the state is wiped without emitting and the edge is gone. Survivable for a one-shot; fatal for a loop. The correct model is `radar`, and the extension point is already documented in the code — `handleDisconnect`, `resetPerSessionState` and the replay-entry guard in `handleTick` each publish a `radar.changed → clear` teardown *before* wiping state, and the comment there says in as many words that other active-state subsystems should plug in the same way. `pitSpeeding.ended` joins all three. The ordering is load-bearing: published after the wipe, the state already reads inactive and the emit is skipped.

**Layer 3 — the engine's own level check.** Every scheduled tick re-reads `getLatestTelemetry()` and stops the loop on a positive `OnPitRoad === false`. This is the same idiom `radar-engine` uses to suppress itself on pit road, and it means a runaway loop dies within one tick interval even if layers 1 and 2 both failed. It is checked as a *positive* false, not as "not true": missing or unknown telemetry keeps playing, following the #574 / #951 precedent that unknown data must not silence a warning — and, usefully, that is also what keeps the cue auditionable from the scenario harness, where there is no real telemetry behind the shortcut buttons.

Layer 3's cost is stated plainly: in the harness, firing the `started` shortcut against a mock snapshot that positively reports `OnPitRoad: false` will stop the cue after one tick. QA sets `OnPitRoad` on the telemetry panel first; the shortcut's description says so.

### 6. Gate latency is one tick interval, and that is the precedent

The master gate and the opt-in are re-read live inside every scheduled tick, not captured at registration. Toggling either off mid-episode therefore silences the cue within at most one interval (~1 s), which is what the issue means by "the spotter-engine force-clear shape" — the spotter is likewise not instantaneous, since nothing calls into it on a settings change.

No push path (radar's `setRadarEnabled` shape, driven from `feature-gates.ts`) is added. Radar needs one because its tick interval is 180–250 ms and its state machine is driven by an event that may not arrive for minutes; here the loop is already re-evaluating everything once a second, so a push would buy under a second of latency in exchange for another cross-package coupling and another way for the two paths to disagree.

The in-flight clip is not cut on a gate-off — the loop simply stops scheduling. This matches radar's documented choice to let a clip finish naturally, and at ~100 ms per tick there is nothing to gain by cutting it.

### 7. Settings: one opt-in, default on, no standalone master

`calloutEnabledPitSpeedingCue`, following `callout<Polarity><Family><Subject>`. Default `true` — new Race Engineer functionality ships on. Gated additionally by the existing `pitCrewRaceEngineerEnabled` master; no `pitCrewPitSpeedingEnabled` toggle of its own, per the #651 precedent that a callout family is not a mode.

The field uses the union-plus-transform chain every other `calloutEnabled*` field uses and, like all 82 of them, does **not** carry a `.catch(...)`. That chain has no throw path — every input coerces — which is the exemption `global-settings.md` names explicitly. The `.catch` requirement still binds any plain-value field, and this change adds none.

Because there are no scenarios, there is no `SCENARIO_ID_TO_*` map and no `wrapCalloutScenario` registration loop. The opt-in is read by the engine directly, exactly as the spotter's two opt-ins are. The new `getPitSpeedingCalloutEnabled` parameter goes immediately before the two master gates in `registerPitCrew`, which stay last.

## Alternatives rejected

**A diff-owned cadence (the #951 pit-status-repeat shape).** The diff would re-emit a `pitSpeeding.repeat` event every interval while the condition held, and the engine would play one tick per event. This is attractive because it makes the loop impossible to orphan — no timer outlives its condition, because the condition *is* the timer. Rejected on latency and noise: the cadence would be quantised to the tick rate and the bus would carry a fabricated event every second of every pit stop, for a consumer that needs no payload. Layer 3 above recovers most of the robustness at a fraction of the traffic.

**A dedicated SFX channel.** The native mixer is four channels; a fifth means changing `audio-native`. Not justified by one cue, especially when `Radar` is provably free on pit road.

**A grace margin on the start edge.** The dormant voice line uses `+1.0 m/s`. Rejected per the issue: the pit limiter holds cars *below* the limit, so a margin only delays telling a driver who is already committing an offence.

**Ducking or pausing under a `PROXIMITY` spotter call.** Nothing to implement — see decision 1. Reconsidering it would mean giving up direct playback.

**Waking `pit-crew.limiter-speeding` in the same change.** See the premise section above.

## Follow-ups

- A purpose-made warning tone to replace the radar-tick placeholder. One constant; no mechanism change.
- The dormant limiter voice family (`limiter-on-track`, `limiter-missing`, `limiter-dropped`, `limiter-speeding`) — register, or delete as dead code. Its own issue.
- The website has never documented pit-road speeding at all, because the voice line never fired. The docs written for this change cover the cue; if the limiter family is later woken, that section grows rather than being written from scratch.
