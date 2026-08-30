> **Issue:** [#1059](https://github.com/niklam/iracedeck/issues/1059) · **Supersedes:** [2026-08-28-issue-912-pit-speeding-cue.md](2026-08-28-issue-912-pit-speeding-cue.md) (in part) · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Pit-speeding cue: exact thresholds, with flutter damped in time

## What this supersedes

Two decisions in the [#912 spec](2026-08-28-issue-912-pit-speeding-cue.md), which otherwise stands unchanged:

- **"Hysteresis on the end edge only"** — the episode ending at or below `limit - PIT_SPEEDING_HYSTERESIS_MPS` (0.2 m/s).
- **"A grace margin on the start edge"**, listed there as rejected. The rejection is upheld in substance but its reasoning no longer generalises, and this spec says why.

Everything else #912 decided survives: direct playback on the Radar channel, no limiter gate, no creep guard, no seed branch, and the three independent layers that guarantee the episode ends.

**The reasoning that turned out to be incomplete is mine, from #912.** I also found and named the gap, which is worth recording only because the failure is instructive: every individual step of the original argument was correct, and the conclusion was still wrong. A superseding spec that quietly improves on its predecessor teaches nobody why the first answer looked right.

## The defect

The shipped thresholds are asymmetric:

- start: `speed > pitSpeedLimitMps`
- end: `speed <= pitSpeedLimitMps - 0.2`

Between them sits a **0.72 km/h dead band immediately below the posted limit** in which an in-flight episode can neither end nor restart. Measured, from a live capture at Charlotte (`local/telemetry-snapshot-20260830-180251-898.json`, `OnPitRoad: true`):

```text
Speed                19.979461669921875 m/s   = 71.93 km/h
TrackPitSpeedLimit   "72.42 kph"              = 20.1167 m/s

start   19.9795 >  20.1167   -> false   (no new episode)
end     19.9795 <= 19.9167   -> false   (in-flight episode cannot end)
                 ^ 71.70 km/h
```

At 0.49 km/h **under** the posted limit, a cue already sounding cannot stop. To silence it the driver must shed a further 0.72 km/h — that is, drive appreciably under the limit. The engine loops a 300 ms tick for the episode's duration, so this is continuous beeping for the rest of the pit approach.

The band sits exactly where a driver *obeying* the limit holds their speed. The most correct behaviour available to the user sustains the alarm.

## Why the first answer looked right

Three true statements, and a conclusion that does not follow from them:

1. **No start-edge margin.** Correct, and still correct — the pit limiter holds cars *below* the limit, so a margin only delays telling a driver already committing an offence.
2. **Flutter is real.** A speed hovering at the limit can cross it repeatedly at tick rate. Each `pitSpeeding.started` calls `playOnChannel`, which replaces whatever is playing, so a flapping episode is audibly a stutter rather than a tone.
3. **Hysteresis damps flutter.** It does.

The missed step is what a *speed* band costs. Hysteresis in speed necessarily declares a range of **genuine speeds** silent — that is the mechanism by which it works. #912 asked where to put that range so jitter could not flutter, and never asked who else lives in it. The answer is: the compliant driver, because the band was placed immediately below the limit, and just below the limit is precisely where someone trying to obey it aims.

Stated generally, and this is the transferable part: **damping a threshold in the same dimension the threshold measures always buys quiet by making some real values indistinguishable from the other side.** If those values matter — and here they are the target behaviour — the damping has to move to a different dimension.

## The contract

Niklas's constraint, verbatim: *"The beep needs to be VERY precise."* That fixes the contract:

- The cue sounds **whenever** the car is over the posted pit limit.
- The cue is silent **at or under** the posted limit.
- **At exactly the limit it is silent.** `speed > limit` is false there, which was #912's intent from the start; the shipped hysteresis broke it only for an episode already in flight.

There is no tolerance in speed, in either direction. A band above the limit is rejected below for the same reason a band below it is: both make genuine speeds silent, and one of them lets a driver exceed the posted limit unwarned.

**Amended after the manual test** — see *Tested against the sim* below. The contract above holds **for a car whose pit limiter is not engaged**, which is the case it was written for and where "VERY precise" is the whole point. A car under an engaged limiter gets a 0.3 km/h buffer at the start edge, because its driver has no remedy left to apply. And "the posted limit" turned out to be a lossier quantity than this section assumed.

## Acceptance criterion

Given after the manual test, verbatim: *"The blimping can't happen while driver is within speed limit with a limiter car."*

**In a limiter-equipped car, while the driver is at or under the speed limit, the cue must never sound.** Not intermittently, not briefly, not as a blink. "Within the speed limit" **includes sitting exactly on it**.

Two consequences, because this is an absolute rather than a "mostly quiet":

- **It makes the quantisation fix mandatory, not optional.** A car held at the limit is *within* the limit, so it must be silent. A buffer that merely masks a threshold placed 0.00048 kph too low does not satisfy an absolute — it satisfies it by accident, for limiter cars only, until some track's rounding goes the other way. The threshold must actually **be** the limit, with the buffer sitting above a correct threshold rather than compensating for an incorrect one. Two fixes, both required.
- **It defines what the test must demonstrate.** Not "it sounded less" but: *limiter car, held at the limit, sustained — silence throughout*. A blink is a failure. A single tick is a failure. The test must run long enough that an intermittent fault would surface, because the difficulty of this bug is that the failure is brief **and the correct behaviour is also brief-looking** — over a short sample, silence and a missed beep are indistinguishable.

## The design: damp in time, not in speed

Keep the comparisons exact:

- start: `speed > pitSpeedLimitMps`
- end: `speed <= pitSpeedLimitMps`

and stop flutter with a **hold on the end edge only** — an in-flight episode ends when the speed has been at or under the limit continuously for `PIT_SPEEDING_END_HOLD_MS`. Brief dips below the limit no longer end it, so a speed oscillating across the limit produces one continuous tone rather than a stutter. Jitter dies because it is brief, not because a range of speeds has been ruled silent.

`PIT_SPEEDING_HYSTERESIS_MPS` is removed.

### End-tail, not start-hold — and not both

A time guard can be placed on either edge, and the two are **not** equivalent with respect to what #912 cared about:

- A **start-hold** — requiring the over-limit condition to persist before sounding — reintroduces, in time, exactly the delay #912 rejected in speed. A driver committing an offence is told later. It buys nothing the end-tail does not already buy.
- An **end-tail** delays no warning at all. The cue still starts on the first tick over the limit. It only extends slightly past the moment of compliance, and it damps flutter fully, because the flapping that matters is the *end* edge repeatedly firing.

So: end-tail only. An implementer reading "damp it in time" will otherwise reach for both, and the start-hold is the half that quietly undoes the feature's stated value.

The other four eligibility terms (`IsOnTrack`, `OnPitRoad`, `!PlayerCarInPitStall`, `pitSpeedLimitMps > 0`) keep ending the episode with **no** hold, exactly as in #912 — there is nothing noisy about leaving pit road, and #912's decision 5 (the episode must always end) depends on those exits being immediate.

## The hold duration is a measurement, not a taste

`PIT_SPEEDING_END_HOLD_MS` is deliberately **not** proposed here. Its cost function is sharp in both directions:

- too short → the restart-stutter returns, which is the defect the hysteresis existed to prevent;
- too long → the cue keeps sounding after the driver has complied, which is this issue's complaint in time form.

So it wants the **smallest value that eliminates restart-stutter**, and that is an empirical question about how long sub-limit excursions last while a driver rides the limit. It also interacts with the 300 ms cue loop, since a hold shorter than one loop interval can elide at most one tick of audio.

**What settles it.** A per-tick capture of a real pit approach, using the tooling already in the repo (#938):

```bash
pnpm telemetry-watch -- --vars=Speed,OnPitRoad,PlayerCarInPitStall,IsOnTrack --mode=all
```

Drive a pit lane holding as close to the limit as possible, including deliberately touching over it and backing off. Then, over the frames where `OnPitRoad` is true, measure the durations of the sub-limit excursions that occur *between* over-limit frames. `PIT_SPEEDING_END_HOLD_MS` is the smallest value exceeding those excursions.

Note the capture must come from a real sim session — the scenario harness feeds synthetic telemetry and cannot produce the physical oscillation being measured, so it can validate the logic but not size the constant.

**A prior worth testing rather than assuming.** #912 called the phenomenon "GPS jitter". iRacing's `Speed` is a physics-engine value, not a GPS-derived one, so what oscillates around the limit is genuine speed under throttle or limiter control rather than measurement noise. The capture should therefore be read for how *drivers* behave near the limit, and it may show the excursions are long enough that any acceptable hold cannot bridge them — in which case the honest outcome is a very short hold that damps only single-tick flapping, and the residual is accepted.

## Tested against the sim — two further defects, and a premise that failed

Everything above was designed, reviewed and shipped to a test build before anyone drove it. One lap produced two defects and killed a premise that **two** specs had carried. Recording that plainly is the point of this section: #912 and the first draft of this spec both reasoned confidently about how a pit limiter behaves, neither measured it, and one lap settled it.

### The limiter premise was wrong, and wrong in a way that mattered

#912 rejected a start-edge margin on this basis, and the first draft of this spec upheld it:

> *"the pit limiter holds cars below the limit, so a margin only delays telling a driver who is already committing an offence."*

Observed: a limiter car sits **at** the limit, not below it. But the deeper error is the second clause, not the first. **A driver whose limiter is engaged has no remedy.** They cannot lift; the car is already doing the only thing available. So the cue there is not a warning, it is noise about a condition the driver has already handled. The rejected margin was about not *delaying* a warning to someone who could act on it — a different question from warning someone who cannot act at all, which is what the premise silently assumed away.

This lands beside #1051's equipment split for the same reason: **the remedy differs by equipment.** Limiter engaged → the car is handling it → buffer. Limiter not engaged → the driver must lift → exact, no grace, which is what "VERY precise" was asked for and what stays untouched.

**Design: at the start edge, a car under an engaged limiter gets a 0.3 km/h buffer; every other car keeps the exact comparison.** Key it on `EngineWarnings & PitSpeedLimiter` — *currently limiting* — and never on `hasPitLimiter` (`dcPitSpeedLimiterToggle !== undefined`), which only says the car HAS the system. Conflating them would buffer every limiter-equipped car whether or not it was using one. The end edge is unchanged.

### Why the buffer, and the rule that decided it

Gating the cue entirely on the limiter was the alternative, and the argument against it is that a limiter is engaged *before* the car has slowed: a driver presses it approaching pit entry at speed, and the car then decelerates to the limit. Through that window the limiter is ON and the car is substantially over — the single moment the warning is worth most. A gate would silence exactly the stretch where the penalty is earned.

That argument is **reasoning, not measurement** — nobody has captured the bit's timing. Which is why the rule that actually decided it is worth stating separately, because it generalises:

> **Prefer the option that is correct under both readings of an unmeasured premise, over the one that needs the premise settled first.**

If the bit sets early, gating is actively harmful and the buffer is required. If the bit only sets once the car is already at the limit, gating becomes viable but the buffer still behaves correctly — steady-state at the limit is silent either way. The buffer is right under both readings, so the uncertainty need not be resolved to proceed. Two further points against the gate: it is unbounded, so a faulty or mismatched limiter speeds in total silence; and it changes behaviour in cases the reporter never complained about.

### The posted limit is a rounded string, and we were reading it as exact

**A separate defect, and it must not be treated as fixed by the buffer above.** The buffer swallows this for limiter cars, which is precisely the trap — the exact path would still be wrong.

`WeekendInfo.TrackPitSpeedLimit` is published as a 2-decimal kph string. At an imperial-native track that string is a *converted* value, so parsing it back does not recover the limit:

```text
45.00 mph            = 20.116800000 m/s = 72.420480 kph
published string     = "72.42 kph"
parsed back          = 20.116666667 m/s = 72.420000 kph
parsed sits BELOW the true limit by 0.000133 m/s (0.00048 kph)

a car held at the TRUE limit:  speed > parsed  ->  fires
```

Worst case for any 2dp kph value is ±0.005 kph (±0.00139 m/s).

**This is not a tolerance, and the distinction is load-bearing.** Two specs now argue against grace margins, so an epsilon here reads like a reintroduced one and is at real risk of being deleted by a later reader on exactly those grounds. It is not a margin: the parsed number **is not the limit**, it is the limit ±0.005 kph, and correcting for the publisher's rounding recovers the threshold we were always trying to compare against. A margin makes a known-genuine speed silent; this makes an unknown speed knowable. Fix it on its own terms so the no-limiter path is genuinely exact.

Metric-native tracks publish round values — an earlier capture shows `"60.00 kph"` — so the artefact is specific to imperial-native tracks, and a metric track is therefore a useful control case rather than merely another test.

**The evidence is predictive, not merely consistent.** A later report says *"It works fine with a non-limiter car."* That is exactly what this hypothesis requires: the failure needs a speed that can *sit* on a threshold 0.0005 kph below the true limit, and a human on the throttle cannot hold that precision — the speed wanders across it and the episode resolves normally. A limiter holds the car there indefinitely. So the hypothesis says in advance **which configuration fails and which passes**, and both halves were then observed. That is a different quality of evidence from an explanation that merely accounts for the failure it was invented for, and it is worth distinguishing: the second kind is nearly free to produce and nearly worthless.

The same report also confirms, in the field rather than in tests, that the parts of this spec already implemented are correct — exact comparisons at both edges, the removed dead band, and the time-damped end all behave on the path where nothing masks them. **The original 71.93 km/h defect is fixed and confirmed by the person who reported it.** The equipment-conditional buffer below is an addition to a working mechanism, not a rescue of a broken one.

**Open question, not to be guessed:** whether iRacing *enforces* at the published string value or at the underlying imperial one. That decides whether the correct threshold is `72.42` or `72.420480`, and the difference is the whole defect. It would be settled by holding a car just above the string value at an imperial-native track and observing whether a penalty is issued.

### "Blink" may be literal, and if so it was already the answer

The report was *"it still blink AT the speed limit"*. Read as a figure of speech that is just "it fires when it shouldn't". Read literally it is more informative: a threshold sitting 0.0005 kph below where a limiter holds, with a speed that micro-oscillates across it, produces repeated start/end cycles — and against the 300 ms end hold that is audibly a **blink rather than a tone**.

If that is what happened, the quantisation defect and the review's case-4 concern (an end→restart inside the 160 ms clip truncating it into a click) are **the same observation**, and it arrived self-reported without anyone running case 4. It would also mean the 300 ms hold has been exercised in the field and did not prevent the flapping — which bears directly on the unvalidated constant above.

**Under the acceptance criterion this stops being an aside and becomes the thing to disprove.** If an episode can start and end repeatedly around a threshold that is now placed *correctly*, the criterion fails even with both fixes in — and the hold's job then extends from damping jitter to guaranteeing an absolute silence it was never sized for.

**What would demonstrate it**, and it is the same instrument as the hold duration:

```bash
pnpm telemetry-watch -- --vars=Speed,OnPitRoad,EngineWarnings --mode=all
```

Hold a limiter car at the limit on pit road for several seconds. The question is narrow and answerable from the capture: does `Speed` actually oscillate at tick rate, or is it steady? If it is steady, a correctly-placed threshold is sufficient on its own and the hold never comes into it. If it oscillates, the amplitude tells you whether any correct threshold can be quiet without the hold covering the excursions — and that is a much stronger requirement on `PIT_SPEEDING_END_HOLD_MS` than "damp the flutter".

The general lesson is cheap to state and easy to miss: **a reporter's word choice can be data.** "Blink" rather than "beep" or "fires" describes a rhythm, and the rhythm was diagnostic.

## Alternatives considered

**A speed band above the limit** (start at `> limit + h`, end at `<= limit`). Fixes this symptom and fails the contract: a driver could exceed the posted limit by the band width in silence. Trades a false positive for a false negative, and the constraint says which way that trade falls.

**Shrinking the existing band.** Reduces the symptom without removing it. The band still sits below the limit, so there is still a range of compliant speeds that sustains the alarm — only a narrower one.

**Debouncing at the audio layer instead** — letting the episode flap but ignoring a `started` that arrives while the clip is mid-play. Tempting, because the stutter is literally a restart artefact. Rejected: it leaves the bus events flapping, which #912's decision 5 relies on being meaningful, and it puts the fix in the engine where a future change to the clip or loop would silently alter threshold behaviour. Damp the condition, not its symptom.

**Both a start-hold and an end-tail.** See above — the start-hold reintroduces the rejected delay.

## Code and tests

The change is confined to `packages/sim-events-iracing/src/diff/pit-speeding.ts`. `diff/limiter.ts` is untouched: `limiter.speeding` is a separate path with its own `+1.0 m/s` start margin, and nothing here applies to it.

Boundary tests must use a **non-round** limit — `72.42 kph`, the converted 45.00 mph value from the capture above. A tidy `60.00 kph` would hide a rounding assumption, since the failure being guarded against is arithmetic near an exact comparison. Required cases:

- speed above the limit → starts;
- speed **exactly** at the limit → does not start, and ends an in-flight episode once the hold elapses;
- speed just under → does not start; ends an in-flight episode once the hold elapses;
- speed inside the **old** dead band (71.70–72.42 km/h) → ends an in-flight episode, the regression this spec exists for;
- a brief dip below the limit shorter than the hold → episode does **not** end;
- each non-speed eligibility term dropping → ends immediately, with no hold.

**Added by the manual test.** The parse now belongs to the change too — `resolvePitSpeedLimit` in `translator.ts` is where the rounding is recovered, so the diff module is no longer the only file touched. Further required cases:

- **the quantisation case**: a limit published as `"72.42 kph"` with the car at the true 45.00 mph (20.1168 m/s) → does **not** start. This is the one that fails today, and it fails on the *exact* path, so it must be tested with the limiter inactive;
- a metric-native `"60.00 kph"` limit, where no rounding loss exists → behaviour unchanged, which is the control proving the correction is not a blanket margin;
- **limiter active** (`EngineWarnings & PitSpeedLimiter`) at the limit, and up to 0.3 km/h over → silent;
- limiter active, well over the buffer → still sounds, which is what distinguishes the buffer from the rejected gate;
- **limiter inactive** at the same speeds → exact, no buffer. The pair is the point: the same speed must behave differently by equipment;
- `hasPitLimiter` true but the limiter **not** engaged → treated as inactive, guarding the conflation of "has one" with "using one".

The manual test is the acceptance criterion, and it is not a single-press check: hold a limiter car at the limit on pit road **sustained**, and confirm silence throughout. A blink or a single tick is a failure.
