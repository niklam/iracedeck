# Gap closing-announcement horizon in the player's laps

> **Issue:** [#1380](https://github.com/niklam/iracedeck/issues/1380) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

The gap callouts announce a closing threat only when the projected contact falls inside a horizon: `lapsToContact ≤ min(GAP_CONTACT_HORIZON_LAPS, lapsRemaining)` in `diffGaps`. `lapsToContact` is `gap ÷ closingRate`, the player's distance to the catch in laps. `lapsRemaining` comes from `resolveGapLapsRemaining` (#1311), which counts the **leader's** remaining line crossings, the chequered one included, by whichever limit ends the race first. The two units differ whenever the player does not finish on the leader's lap count:

- **Multiclass or lapped player.** A GT4 player on 120 s laps behind a GTP leader on 90 s laps, 600 s left: the horizon allows about 9 leader crossings while the player runs 6 or 7. A catch 8 laps away is announced and can never happen before the player's flag.
- **Leader already finished.** `SessionLapsRemainEx` reads `0` once the leader has the chequered flag, so the horizon is `0` and every closing call is muted on the player's own last lap.
- **Crossings, not distance.** Even on the leader's lap, a count of crossings overstates the distance by the player's lap fraction. On the last lap at 90 %, a horizon of `1` admits a catch 0.95 laps away, which comes after the line.

## Decision

The horizon becomes **the player's distance to their own chequered flag, in laps**: `C_p − f_p`, where `C_p` is the player's remaining line crossings with the chequered one included and `f_p` their lap fraction (`CarIdxLapDistPct`, taken as `0` when unknown). `diffGaps` compares `lapsToContact` with it as before; only its meaning and its doc change.

### 1. The leader's crossings: unchanged

`C_L` is today's `resolveGapLapsRemaining`: `bindingLapsToGo(SessionLapsRemainEx, timeSideCrossings)`. The time side keeps #1311's exact crossing model (`leaderWhiteCrossingIndex` with no tolerance, an unknown leader fraction taken as `0`, an expired clock as `1` or `2` by the post-expiry crossing marker). The leader's chequered in seconds, where needed, is `T = (C_L − f_L) · L`, with `L` from `resolveLeaderLapTimeS` and `f_L` the leader's lap fraction.

### 2. From the leader's crossings to the player's

Taken in order; the first that applies decides `C_p`:

1. **The player has the chequered flag** (`state.raceFinish` is recorded, which `diffLaps` sets at the player's flag crossing earlier in the same tick, whether or not a position was read): `0`.
2. **The leader has the chequered flag** (`C_L = 0`, or `SessionState` reads `Checkered` or `CoolDown`): `1`. The player finishes at their next crossing, whatever lap they are on. This is the leader-finished window the issue names. `SessionState` is needed for a time-only race, whose lap counter reads the unlimited sentinel, so `C_L` stays at the clock side's `1` after the leader's flag.
3. **The player is the leader**: `C_L`.
4. **By lap count**, when the player is within a lap of the leader on distance now and is projected to stay so at the leader's flag, the same test the fuel estimate makes (#1405): `|g| < 1` and `g + T · (1/L − 1/P) < 1`, with `g` from `readLeaderGap` and `P` the player's validated average lap (`computeFuelStats(…).avgLapTime`, which leaves out caution and pit laps). Then `C_p = max(1, LC_L + C_L − LC_p)`: a player across the line just ahead of the leader on the last lap would otherwise read `0` and lose their last lap's calls, while step 1 has already ruled out a finished player. Every car within a lap of the leader at the flag finishes on the lap count the leader's chequered brings up, so this needs no pace and no tolerance.
5. **By time** otherwise, when `T`, `P` and `f_p` are known: the player's k-th crossing is at `(k − f_p) · P`, and the chequered is their first at or after the leader's, so `C_p = max(1, ceil(T / P + f_p))`. No near-tie tolerance: for the gap horizon a crossing counted one too few only withholds an announcement on the last lap.
6. **Otherwise** (no leader pace, no leader fraction, no player average, or the lap counters unreadable near the line with no pace to fall back on): `C_L`, today's behaviour. It overstates for a lapped or slower-class player, as before, and never mutes.

When `C_L` is `null` (neither limit known), the horizon is `null`, no cap, as today, unless step 1 applies. A finished player is `0` whatever the limits. Step 1's finish is `state.raceFinish` for the current `SessionNum`, the check `getRaceFinishResult` makes.

### 3. Shared with the fuel estimate

The lap-count test and count of step 4 are the fuel estimate's, so they move into `leader-finish.ts` as two pure helpers both consumers call: whether a player stays within a lap at the leader's flag, and the player's crossings by lap count. The fuel estimate keeps its own inputs (the pace capped at `min(L, P)` and its tolerance on the time path) and its own fallbacks. The two consumers' safe directions are opposite: for fuel a count too low silences a warning, for the gap horizon a count too high announces a catch that cannot happen. So the gap horizon uses the raw leader pace and no tolerance.

## Amendment during implementation (2026-11-07)

**No car finishes more than one crossing after the leader's count.** Only the leader can be ahead of the leader on distance, so any other car is either within a lap of them at the flag (and takes the flag on the lap count, at most `C_L + 1` crossings from now) or a lap or more down (and crosses fewer times). The time model can still exceed `C_L + 1`. One case is a player faster than the leader within a lap whose lap counters sit inside `LAP_LINE_GUARD_PCT` of the line, so `readLeaderGap` is unknown: about 3 % of every lap per car. The other is an inflated leader lap time, below. So the time model's result is capped at `C_L + 1`: `C_p = min(C_L + 1, max(1, ceil(T / P + f_p)))`.

**The leader's pace for the conversion is the faster of their last and best lap.** `resolveLeaderLapTimeS` gives the leader's last lap, which after a pit stop, a spin or the lap that ends a caution is slow. A slow `L` lengthens `T = (C_L − f_L) · L` and keeps a car that will be lapped on the lap count: both over-count, the gap horizon's unsafe direction. Section 3's claim that the raw pace errs safe for the gap horizon is wrong on the time path. Steps 4 and 5 therefore use `L = min(CarIdxLastLapTime, CarIdxBestLapTime)` of the leader, each when valid. A best lap faster than the current pace only shortens `T`, which withholds a call at worst. `C_L` itself (the #1311 time side) keeps `resolveLeaderLapTimeS`, where a slower lap already counts fewer crossings.

**The player's finish is read at the crossing, not from the finish record.** `state.raceFinish` is written in `diffLaps`' `lap.completed` path, after it has waited for the lap time and for the standings to sync, so up to about 5 s after the crossing. Through that window, step 2 gave a lap race's just-finished player `1 − f_p` ≈ 0.99, and a closing call could be spoken on the cool-down lap where #1311's horizon read `0`. Step 1 therefore uses the same test `diffLaps` applies at the crossing tick: the crossing record shows the player crossed under the chequered flag on the lap `LapCompleted` reads (`lapCrossing.underCheckered`), or the flag diff resolved the finish at this lap (`flagCheckeredTakenLap`). Both are written on the crossing tick, before `diffGaps` runs. It is one shared predicate, used by `diffLaps` and the horizon, plus the finish record for the current `SessionNum`.

**A leader just past the line is read cautiously.** In a lap race `C_L` is the lap counter, while `T = (C_L − f_L) · L` reads the leader's lap fraction. Around the leader's crossing the two can disagree for about a second: the fraction wraps before the counter moves (`LAP_LINE_GUARD_PCT`'s doc). That reads `T`, and the `C_L + 1` cap with it, one leader lap long, an over-count. So when the leader's fraction is below `LAP_LINE_GUARD_PCT`, steps 4 and 5 count one leader crossing fewer (`C_L − 1` in `T` and in the cap). Where the counter has in fact moved, this under-counts by a lap for those few seconds, which only delays a call.

## Alternatives rejected

- **A pace ratio against the leader** (`C_L × L / P`). It is right only for a player far from the leader; for a close follower it under- or over-counts by a lap at random as pace drifts, where the lap count is exact.
- **Keeping the horizon in crossings.** It overstates by up to a lap on every lap, including the leader's own, and the last lap is exactly where a call after the line is most wrong.
- **Reading the leader's finish from the per-car `Checkered` bit.** Like `White`, it is per car, so a lapped player may not see it at the leader's crossing; `SessionState` is session-wide.

## Out of scope

- **The fuel estimate's lap side.** It keeps reading the leader-relative counter with its `White` clamp (#1405 left it, and no report points at it). Only the shared lap-count helpers move.
- **The time-limited white-flag callout and the other end-of-race callouts.** They are leader-relative by design.
- **Tuning `GAP_CONTACT_HORIZON_LAPS` or the closing-rate gates.**

## Testing

- Unit tests on the player-crossings resolver: the issue's multiclass example (GT4 at 120 s behind a GTP leader at 90 s, 600 s left: about 6 or 7, not 9); a player a lap down within a lap on distance (`C_L + 1`), and one predicted to be lapped before the flag (the time model); the leader finished while the player is on their last lap (`1`, minus the lap fraction); the player finished (`0`); the player as leader; each fallback to `C_L`; and every #1311 case, unchanged for a player on the leader's lap at fraction `0`.
- The shared helpers keep the fuel estimate's existing tests green, unchanged.
- A translator-level test drives ticks through `initializeSimEventsIracing` with `diffGaps` spied and asserts the horizon it receives for a lapped player and in the leader-finished window.
- An end-to-end run of the real translator and Race Engineer engine on a synthetic multiclass tape (the #1405 harness pattern): a closing catch that completes after the player's flag is announced on `origin/master` and not on the branch, and one that completes before it is announced on both.
