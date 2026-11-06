# Fuel race coverage: the leader's actual finish, and a coverage check without the lap margin

> **Issue:** [#1405](https://github.com/niklam/iracedeck/issues/1405) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

The laps-of-fuel-left callouts stay silent when the tank covers what is left of the race (#866, #880). Two drivers' logs show the check failing on the last laps of a race:

- **Driver A**, fuel margin 0, 1-hour race: the "1 more lap" line played mid-lap 34, the leader's white flag a minute later, and the driver finished lap 35 without stopping.
- **Driver B**, margin 0.4: "Box this lap" played mid-lap 33, the white flag 40 s later, and the driver finished lap 34 without stopping.

`resolveFuelRaceCoverage` and the verdict that uses it have two faults:

1. **The timed side is a bound, not a count.** It places the leader's chequered flag at `timeRemain + 2 × leaderLap` (one leader lap until the white after expiry, one for the white lap), or at one leader lap once the `White` bit is up, and rounds the player's laps up from that. Near the end that overstates the race by up to a lap. That is driver A's call: with margin 0 the tank covered the one lap left, but the bound said two. The `White` bit is also per car (`leader-white.ts`' header): a lapped or slower-class player does not see the leader's white, so that branch fires late or never.
2. **Coverage is judged after the lap margin.** The verdict is `count >= remainingLaps`, where `count` has the user's margin taken off. The margin protects a pit decision against estimate error, but with a lap or two left there is no stop worth making, and the margin turns a covered finish into a warning. That is driver B's call.

#1311 (merged 2026-10-10) already models the leader's remaining crossings exactly for the gap horizon (`timeSideCrossings` in `translator.ts`). The fuel estimate kept the bound.

## Decision

### 1. Predict the leader's chequered flag, in seconds from now

A new pure helper in `translator.ts`, beside `timeSideCrossings`, returns the seconds until the leader takes the chequered flag in a timed race, or `null` when it cannot be predicted. It uses the same crossing model as #1311 so the gap horizon and the fuel estimate cannot disagree about when the race ends. Leader lap time `L` comes from `resolveLeaderLapTimeS`, leader lap fraction `f` from `CarIdxLapDistPct` of the canonical-order leader, `t` is the clock:

- **Clock running** (`t ≥ 0`): the leader's k-th crossing from now is at `(k − f) · L`. The white is the first at or after expiry, `k = ceil(t / L + f + ε)`, and the chequered is the one after it, at `(k + 1 − f) · L`.
- **Clock expired** (`SessionTimeRemain ≤ 0`): `(1 − f) · L` once `state.leaderWhitePostExpiryCrossed` says the leader has crossed since expiry (they are on the white lap), otherwise `(2 − f) · L`. `diffLeaderWhite` runs before `diffFuelLapsLeft` in the same tick, so the marker is current.
- **`null`** when the clock is unknown or unlimited, the leader is unresolved, has no lap time, has no usable lap fraction (off-world or `-1`), or is on pit road (`CarIdxOnPitRoad` is unreliable per `race-finish.ts`, so the leader's `CarIdxTrackSurface` reading `InPitStall` or `AproachingPits`). In each case the timed side falls back to today's bound, `timeRemain + 2 × leaderLap` with the player's own average standing in for an unknown leader lap. Unlike the gap horizon, an unknown fraction is not taken as `0`: for fuel, counting too few laps silences a warning the driver needs, so ignorance must keep the cautious answer.

The player's laps after the current one are then `max(0, ceil(T / P + f_p + ε) − 1)`, where `T` is the predicted chequered time (or the fallback bound), `P` the player's validated average lap time and `f_p` the player's lap fraction. This is today's formula with the bound replaced by the prediction. The player takes the chequered at their first crossing at or after the leader's.

**The tolerance `ε`** stops a near-tie from counting a lap too few. Pace drifts between now and the flag, so a leader predicted to cross half a second after expiry may cross half a second before it. `ε = FUEL_FINISH_TOLERANCE_LAPS + FUEL_FINISH_PACE_DRIFT × (t / L)`, applied in both ceilings: a fixed 0.03 laps (about 3 s on a 100 s lap) plus 1 % of the laps until expiry. It only ever adds a lap at a near-tie, which errs towards warning, the direction #880 chose. Both constants are first values to be checked against the testing below.

The overall leader decides the finish in multiclass races, as it does today, so a slower-class player still finishes at their first crossing after the overall leader's chequered.

The `White`-bit branch is removed from the timed side: the post-expiry crossing marker replaces it. The lap-counter side (`resolveLapsRemaining`, the `White` clamp on it, and `bindingLapsToGo`) is unchanged.

### 2. Judge coverage on the tank, not on the margin

The verdict moves into one pure function in `fuel-laps-left.ts`, used by `diffFuelLapsLeft` and by the Telemetry Snapshot's state reader (`sim-state.ts`), which today restates `count >= remainingLaps` on its own:

> The tank covers the race when `rawLapsLeft ≥ (lapFractionRemaining + remainingLaps) × (1 + FUEL_COVERAGE_ERROR)`.

That is the fuel for the rest of this lap and every lap after it, plus an allowance for the average being off, with no lap margin. `FUEL_COVERAGE_ERROR` is 0.05: 5 % of the distance left, so it grows with the laps to cover the way estimate error does (two laps left need a tenth of a lap in hand; ten laps, half a lap). It is a first value, well below the 0.3-lap margin a one-lap finish carries today; how much per-lap use actually varies has not been measured, and the manual test below is where it gets checked.

When #1401's fuel reserve lands, the verdict subtracts the effective reserve from the tank first. That is #1401's to wire, and its spec says so.

What does not change:

- **The final-lap and post-race silences** stay unconditional (the #866 review's trade-off).
- **The dedup floor** is still never advanced by a suppression, so a burn spike that breaks coverage still warns on the earlier laps.
- **The "enough fuel to finish" confirmation** keeps its own guard, the unclamped post-margin count with a lap in hand (#880). It is only reached when the new verdict says covered, and it is the stricter of the two, so a confirmation is never spoken on a tank the verdict calls short.

## Amendments during implementation (2026-11-02)

**Where the crossing model lives.** The helper did not go in `translator.ts`. The white-crossing index `k = ceil(t / L + f + ε)` lives in a new pure module, `packages/sim-events-iracing/src/leader-finish.ts`, together with the tolerance constants and `predictLeaderChequeredS`. `timeSideCrossings` (the #1311 gap horizon) calls the same index with `ε = 0` and keeps its own unknown-fraction-as-0 fallback, so the gap horizon and the fuel estimate share one function, not two copies of the formula. The module takes the leader's lap time as a parameter (`resolveLeaderLapTimeS` stays in `translator.ts`) so it imports nothing from the translator. The fuel diff's leader closure returns `{ lapTimeS, chequeredInS }` (`LeaderFinish`) instead of a lap time.

**The last lap stays silent whatever the tank.** When the binding race distance leaves no full lap after the current one (`remainingLaps === 0`), the verdict is "covered" whatever the tank holds. That keeps today's behaviour for a lapped or slower-class player whose own `playerFinalLapStarted` latch has not fired (the `White` bit is per car), and extends the #866 trade-off: on the final lap the estimate is too imprecise for a shortage call. The rule sits in the shared verdict (`isFuelRaceCovered`), so the diff and the Telemetry Snapshot agree. The reassurance keeps its own guard.

**An expired clock is confirmed over a second.** iRacing can blip `SessionTimeRemain ≤ 0` for a tick or two mid-race (the #666 transient). Read on the mid-lap sample tick, such a blip would end the race within two leader laps and under-count it by many laps: enough to suppress a real warning, or to speak the enough-fuel confirmation, which latches and clears the dedup floor. The fuel side therefore uses the expired-clock prediction only once the clock has read ≤ 0 for `CLOCK_EXPIRY_CONFIRM_TICKS` = 60 consecutive ticks, about one second at iRacing's 60 Hz. Two ticks, the confirmation `leader-white.ts` uses for its own callout, would not survive a two-tick blip whose second tick is the sample. An expired reading without a prediction, confirmed or not, leaves the timed side unknown, which keeps announcing; that is also what a real expiry reads in its first second. The `timeRemain + 2 × leaderLap` bound stands in only while the clock is still running. The count is a new flat `TranslatorState` field, `fuelCalloutClockExpiredTicks`: consecutive ticks with a finite `SessionTimeRemain ≤ 0`, updated first in `diffFuelLapsLeft` on every tick, and reset with the state on a replay visit or a session change. It is a counter rather than a "previous tick expired" boolean because the Telemetry Snapshot reads state after the tick, when such a boolean already holds the current tick; with a counter, the snapshot and the diff read the same threshold.

**A post-expiry crossing must agree with the clock.** `leader-white.ts` sets its post-expiry crossing marker on a lead change while the clock is expired as well as on an observed crossing, because it cannot see a crossing across the flip. Taken at its word, a change of leader after expiry but before the white would read the new leader as already on the white lap: one leader lap short, so "covered". The player's next sample then usually falls on their own final lap, which the final-lap gate silences, so the warning would be lost, not delayed. Once the clock has expired, the raw `SessionTimeRemain` reads −(seconds since expiry), and a leader at lap fraction `f` crossed the line about `f · L` seconds ago. So the fuel side counts the leader as crossed only when the marker is set and `f · L < secondsSinceExpiry − FUEL_FINISH_TOLERANCE_LAPS · L`; otherwise it predicts `(2 − f) · L`, one lap more, the cautious direction. Residual: a leader who did cross since expiry but whose `f · L` lies within that margin of it reads one lap long for a few seconds, which errs towards warning. A leader crossing on the very first expired tick, which `leader-white.ts`' own two-tick confirmation never marks, also reads one lap long through the white lap. That too errs towards warning, and on master the timed side was unknown there.

## Amendment during implementation (2026-11-06)

**The near-tie tolerance does not apply to a player close behind the leader.** An end-to-end run of the real translator and Race Engineer engine on a synthetic timed-race tape (evidence attached to the PR) found that the decision above still produced the reported symptom for a player racing close to the leader. The tolerance ε was applied in both ceilings, including the player's own: `ceil(T / P + f_p + ε) − 1`. A player `d` seconds behind the leader on the same lap crosses the line `d` seconds after the leader's chequered, so whenever `ε · P > d` they were counted one lap long. That covers at least the last 3 s of gap, and about 11 s a few laps before expiry. On the tape, P2 two seconds behind heard "1 more lap" before the white on a tank that covered the race. The tolerance has no job there. A car behind the leader on the same lap cannot cross the line before them, and if it passes them it becomes the leader and finishes at the same crossing count, so there is no near-tie to protect against.

**A player within a lap of the leader counts the leader's crossings.** The leader prediction also yields `N_L`, the leader's line crossings up to and including the chequered, derived from the same crossing model: the white index `k + 1` while the clock runs; after a confirmed expiry, 1 or 2 by the clock-checked crossing rule. When the player is within one lap of the leader on distance (`|(LC_L + f_L) − (LC_p + f_p)| < 1`, from `CarIdxLapCompleted` and `CarIdxLapDistPct`), the player's remaining crossings are `LC_L + N_L − LC_p`, and the laps after the current one that, minus one. That is exact without the player's pace:

- a same-lap follower takes the flag at the leader's crossing count;
- a car a lap down that has not yet crossed the line the leader last crossed, including one physically ahead on track, takes one more;
- the count does not move when the player passes the leader, whichever way the order reads at that instant.

A crossing tick on which the lap count and the lap fraction disagree is read so that it never counts low.

**The tolerance stays only for lapped and slower-class players.** For a player a lap or more from the leader, or when either car's lap data is missing, the timed side keeps the time model with ε. There the player's crossing near the leader's chequered is a genuine near-tie, decided by pace over the laps that remain, and ε moves it to the later crossing, the cautious direction. With no prediction, the fallback bound stands as before.

**Only while the player stays within a lap until the flag.** Being within a lap of the leader now is not enough: a slower car that the leader will lap before the chequered flag finishes one lap fewer than the leader's count. On the tape, a car on 115 s laps against the leader's 100 s was counted a lap long until it was lapped, and heard false "5 laps" and "3 laps" calls. So the lap count applies only while the player is predicted to still be within a lap at the leader's chequered: `g + T · (1/L − 1/P) < 1`, with `g` the distance gap now, `T` the predicted chequered time, and `L` and `P` the leader's and the player's lap times. Otherwise the time model with ε counts it. That model is exact for a lapped car, and its tolerance covers being lapped just before the flag. A player predicted just inside a lap who is in fact lapped is counted one lap long, and one predicted just outside who is not lapped falls to the tolerance. Both err towards warning. A player faster than the leader stays on the lap count: if they pass, they become the leader at the same crossing count.

**Rejected: dropping ε from the player's ceiling for everyone.** It is a smaller change, but it moves a lapped car whose crossing falls just after the leader's chequered into the unsafe direction: if pace drift brings its crossing just before the flag, it runs one more lap than counted, and a warning it needs is silenced. Keeping the tolerance only where the crossing order can flip, and counting exactly where it cannot, fixes the close-racing case without that risk.

**The -1 clock before the start.** Real captures show `SessionTimeRemain` reading -1 before the race clock starts (ParadeLaps, and Racing until the first line crossing), which the prediction reads as an expired clock. It is harmless because, in that window, the leader's racing lap time is unknown (pre-green) and the fuel tracker's pre-green session wipe leaves no average until the first Racing tick, so no sample reaches the verdict. That protection is documented in the code and covered by a test.

## Alternatives rejected

- **Keep the bound and only drop the margin from the verdict.** Fixes driver B, not driver A, whose margin was already 0.
- **Use #1311's crossing count directly.** It counts the leader's crossings and takes an unknown fraction as `0`, the smaller count. That is the safe direction for the gap horizon and the unsafe one for fuel. Sharing the crossing model and keeping separate fallbacks gives one end-of-race model with each consumer's own safe direction.
- **Raw tank with no allowance.** A tank that covers the finish by a hundredth of a lap would be called covered, and the driver could run dry on the last lap. Until #1401's reserve exists, the 5 % allowance is the only thing standing between the estimate and the empty tank.
- **Ask the driver to set the margin to 0.** The margin still has a job earlier in the stint; the coverage check needs a different one.

## Out of scope

- **The fuel reserve, the margin default, the lap-counting wording and the debug log line**: #1401.
- **The lap-counter side's per-car `White` clamp.** It is the lap-limited model, not the timed one, and no report points at it.
- **A pit-lane or splash-and-dash recommendation** when the tank is just short of the finish. The callout still says "box"; whether a splash is worth it is the driver's call.
- **Converting the gap horizon to the player's laps** (the #1311 spec's out-of-scope item). Separate issue.

## Testing

- Unit tests on the chequered-time helper: clock running with the leader mid-lap; the leader due to cross just before and just after expiry (with and without the tolerance tipping it); clock expired before and after the leader's post-expiry crossing; each `null` case (unknown clock, no leader, no lap time, off-world fraction, leader in the pit stall or approaching pits).
- Unit tests on the coverage verdict: covered with the margin set but the tank enough; one lap left with the tank 4 % over the need (not covered) and 6 % over (covered); the reserve-free form only.
- Tests on `diffFuelLapsLeft` that rebuild both reports: a timed race whose clock expires a lap before the player's mid-lap sample on their second-to-last lap with margin 0 (driver A), and a one-lap-to-go tank with margin 0.4 (driver B). Both stay silent; before the change both fire. A third keeps a genuine shortage loud: the tank runs out half a lap before the flag, and the warning plays.
- The Telemetry Snapshot test reads the same verdict as the diff for one tick.
- **Manual, in iRacing:** an offline AI timed race (15–20 minutes) with fuel set so the last stint just covers the finish. The fuel warnings stop once the tank covers the race, and the "enough fuel to finish" line plays inside the last 10 laps. A second run with fuel half a lap short of the finish still gets the box call. `pnpm telemetry-watch` capturing `SessionTimeRemain`, `CarIdxLapDistPct`, `CarIdxLastLapTime`, `FuelLevel` and the flags through the finish gives a fixture for the leader-prediction tests.
