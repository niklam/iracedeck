> **Issue:** [#912](https://github.com/niklam/iracedeck/issues/912) · **Supersedes:** _none_ · **Superseded by:** [2026-08-30-issue-1059-pit-speeding-precision.md](2026-08-30-issue-1059-pit-speeding-precision.md) (in part — the end-edge hysteresis and the start-margin rejection)
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

**Ruled, after this section was first written: all four limiter scenarios ship.** The scoping above was the one call left open here, and it went the way this section anticipated for the split but not for the outcome — the family is not deleted and not deferred. It is issue **#1051**, owned by another maintainer stream, and `limiter-speeding` ships alongside this cue rather than being dissolved by it.

The reasoning above is left standing rather than rewritten, because it is what produced #1051 and a reader wondering why there are two pit-speeding warnings should be able to see the case that was made for one. Two things it got right survive the ruling: the pairing rule is real design work rather than a problem that went away, and it belongs to whichever spec covers both — which is now #1051's, not this one's. The shape proposed there is escalation: the tick is the reflex signal at any overage on any car, and the voice line is the escalation past `limiter.speeding`'s existing `+1.0 m/s` margin that says what the beep means.

**The cue's design is unchanged by the ruling, which is the property this section was structured to buy.** Not limiter-gated, no margin, direct playback on Radar, instant. Everything below was specified against a bus with no subscriber precisely so that the limiter decision could go either way without reopening it, and it did go the other way.

One question this spec raised and did not settle has since been answered, and the answer took neither option that was on the table. The problem: `limiter-speeding` carries the #639 `hasPitLimiter` gate while this cue deliberately has none, so a car *with* a limiter gets a tick and a sentence while a car *without* gets only the tick — and that is the driver with no dashboard cue at all. The two options put up were to keep the gate (leaving that driver with only the beep) or to drop it from that one scenario (making a #639-shaped wording decision for a line whose wording does not actually depend on a limiter).

**Niklas ruled for a third: two callout families, one for cars with a limiter and one for cars without, each worded for its own audience.** Family A is the existing limiter family with its gate untouched — #639 needs no amendment at all. Family B is new, gated on the negation, speeding-only (the other three scenarios are impossible or meaningless without a limiter), and never mentions a limiter. #1051 owns the design.

**The argument was accepted and the fix was rejected, and the distinction is the part worth keeping.** The diagnosis was right: #639's gate is about wording. The proposed remedy then sent limiter-framed content *across* that gate to cars with no limiter — the same wording problem pointed the other way. Ungating removed the asymmetry's symptom while keeping its cause. Two families keep the insight and drop the mistake.

What makes them worth their cost rather than duplication is that the families differ by **remedy**, not merely by phrasing. A limiter car that is speeding is usually speeding because the limiter is off, and the fix is a button; a limiter-less car has to lift. No single sentence carries both instructions honestly.

The shape that results is symmetric, and it is the one this spec should be read against: **the tick is the layer common to every car, and each family adds the spoken half worded for its own equipment.** Nobody hears a warning aimed at hardware they do not have, and nobody is left with only a beep.

Recorded because it generalises past this issue: when a capability gate produces an asymmetry, "gate or no gate" is a false pair. Removing a gate moves content to an audience it was not written for; the real question is whether the *condition* is universal while only the *sentence* is not — and if so, the answer is a second sentence, not a wider gate.

## What ships

While the player is over the posted pit-lane speed limit on pit road, a short tick repeats at a fixed interval until the speed drops back under. It is gated by the Race Engineer master and one new per-callout opt-in, default on. It ships with a purpose-made tone at a 300 ms cadence — see the amendment below; the radar tick this was specified against was only ever a stand-in.

## Decisions

### 1. Direct playback, not interpreter-scheduled — and what that settles for free

`radar-engine.ts` is the model: an imperative module that calls `getAudio().playOnChannel(...)` itself. The #651 spotter engine is *not* the model, despite the issue naming both. The spotter is imperative in its state machine but routes every clip through `getScenarioEngine().fire(...)`, so it inherits weights, families and the focus floor. Copying it would reintroduce the scheduling latency this feature exists to avoid.

This choice answers the issue's second open question — *should the tick duck under a `PROXIMITY` spotter call?* — structurally rather than by policy. **No.** With no interpreter fire there is no weight, no family and no focus contest to arbitrate; the tick and a "Car left." call are on different buses and simply coexist. There is no knob here to get wrong later, which is the point.

The trade being accepted: a tick three times a second will overlap the words of a spotter call. That is judged correct — both are proximity-class safety signals with independent volume controls, and a driver at speed on pit road wants both — but it is the kind of thing that can only really be judged by ear, so it is explicitly on the manual-test list.

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

## Amended after hardware testing: a purpose-made tone at 300 ms

Two things this spec specified provisionally were settled by ear on hardware, and both landed inside the issue rather than after it.

**The tone.** The spec called the radar tick a placeholder and listed a purpose-made tone as a follow-up. Niklas auditioned six candidates against 250 ms and 500 ms loop previews and picked one, so the follow-up is retired and `sfx/IRD-pit-speed-warning.wav` ships instead — mono, 48 kHz, 160 ms. **It was not replaced because the placeholder failed**; it was replaced because a purpose-made tone became available while the issue was still open, which is a better outcome than the follow-up it displaced.

The clip was **generated for this feature**, not sourced from anywhere, so it carries no third-party licence obligation and needs no `THIRD-PARTY-LICENSES.md` entry. Recorded because an unattributed binary appearing in `sfx/` invites exactly that question, and the answer is otherwise unrecoverable from the file — it has no metadata chunks at all.

**Level: the shipped asset is that generated source at −6 dB**, which was the last tuning item and the only one after the tone and cadence were settled. Two decisions inside that are worth keeping. The gain is **baked into the asset** rather than applied at playback, because `playOnChannel` takes no per-play volume — it uses the channel's — so the alternatives were widening a shared API or bracketing each play with `setChannelVolume(Radar, …)`, which would fight both the radar engine and the user's own Radar slider. And the figure is **absolute against the source**, not a delta against the committed file: a further adjustment re-renders from the source with a new absolute number, because re-attenuating the shipped file works once and then compounds, each pass drifting further from anything reproducible. A consequence to know rather than to "fix": the repo asset is deliberately **no longer byte-identical** to the generated source, and the verification that replaces that is the three plugins carrying the same post-gain file as the repo.

It is kept as `.wav` where its `sfx/` neighbours are `.mp3`. At 15 KB the size argument does not arise, and an mp3 decoder's priming delay is a real cost on a 160 ms clip fired three times a second where the attack *is* the signal. The build copies everything outside `voice/` verbatim and miniaudio decodes wav natively, so nothing else in the pipeline cares. It sits at the `sfx/` root rather than in `sfx/radar/`, because it is not a radar sound — the cue only borrowed one while it had no tone of its own.

**The cadence: 300 ms**, not the ~1 s this spec was written against. 1 s read as "lazy" for a warning you are meant to react to immediately; 500 ms was the first correction and 300 ms the one that stuck. At a 160 ms tone that still leaves ~140 ms of silence between ticks, so the cue cannot overlap itself and reads as a beeper rather than a buzz.

**A fixture lesson the cadence changes paid for twice.** The engine tests advance a mock `SessionTick` to stand for a live sim, and the amount was originally hardcoded — 60 per read, encoding "60 Hz sim, 1 Hz cue". When the cadence became 500 ms that same 60 silently began describing a sim running at twice real speed, and **every assertion still passed**, because they are written against the symbolic interval and scale with it correctly. A test that scales around a fixture whose premise has stopped being true is the same failure in a new costume, and nothing fails to announce it. The fixture is now DERIVED from the cadence (`SIM_TICKS_PER_CUE_TICK = round(IRACING_TICK_HZ × interval)`), which retired the problem rather than documenting it: the 500 → 300 change needed no edit there at all. Generalising: when a test constant encodes a *ratio* between two things the code knows, derive it — a stated one is correct only until either side moves, and its being wrong is invisible.

Two consequences worth having written down rather than rediscovered. The interval doubles as the **worst-case latency of every live check in the loop** — a gate switched off, a driver leaving pit road, a frozen sim — so shortening it sharpened all three; that is why the constant is not purely a matter of taste, and why a later request to make the beeping less frequent is a safety change rather than a comfort one. And the coexistence decision in §1 was judged at the original cadence: at three times the rate there is three times the overlap with a spoken call, so that judgement is re-taken rather than assumed to carry.

### 6. Gate latency is one tick interval, and that is the precedent

The master gate and the opt-in are re-read live inside every scheduled tick, not captured at registration. Toggling either off mid-episode therefore silences the cue within at most one interval (300 ms), which is what the issue means by "the spotter-engine force-clear shape" — the spotter is likewise not instantaneous, since nothing calls into it on a settings change.

No push path (radar's `setRadarEnabled` shape, driven from `feature-gates.ts`) is added. Radar needs one because its tick interval is 180–250 ms and its state machine is driven by an event that may not arrive for minutes; here the loop is already re-evaluating everything three times a second, so a push would buy under a second of latency in exchange for another cross-package coupling and another way for the two paths to disagree.

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

- The dormant limiter voice family (`limiter-on-track`, `limiter-missing`, `limiter-dropped`, `limiter-speeding`) — **issue #1051, ruled: all four ship.** It also owns the pairing rule between the voice line and this cue, and the `hasPitLimiter` question above.
- The website has never documented pit-road speeding at all, because the voice line never fired. The docs written for this change cover the cue; if the limiter family is later woken, that section grows rather than being written from scratch.
