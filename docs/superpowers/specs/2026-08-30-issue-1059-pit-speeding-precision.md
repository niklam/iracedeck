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
