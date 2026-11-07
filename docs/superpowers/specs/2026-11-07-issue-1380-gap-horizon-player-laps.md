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
4. **By lap count**, when the player is within a lap of the leader on distance now and is projected to stay so at the leader's flag, the same test the fuel estimate makes (#1405): `|g| < 1` and `g + T · (1/L − 1/P) < 1`, with `g` from `readLeaderGap` and `P` the player's validated average lap (`computeFuelStats(…).avgLapTime`, which leaves out caution and pit laps). Then `C_p = LC_L + C_L − LC_p`. Every car within a lap of the leader at the flag finishes on the lap count the leader's chequered brings up, so this needs no pace and no tolerance.
5. **By time** otherwise, when `T`, `P` and `f_p` are known: the player's k-th crossing is at `(k − f_p) · P`, and the chequered is their first at or after the leader's, so `C_p = max(1, ceil(T / P + f_p))`. No near-tie tolerance: for the gap horizon a crossing counted one too few only withholds an announcement on the last lap.
6. **Otherwise** (no leader pace, no leader fraction, no player average, or the lap counters unreadable near the line with no pace to fall back on): `C_L`, today's behaviour. It overstates for a lapped or slower-class player, as before, and never mutes.

When `C_L` is `null` (neither limit known), the horizon is `null`, no cap, as today.

### 3. Shared with the fuel estimate

The lap-count test and count of step 4 are the fuel estimate's, so they move into `leader-finish.ts` as two pure helpers both consumers call: whether a player stays within a lap at the leader's flag, and the player's crossings by lap count. The fuel estimate keeps its own inputs (the pace capped at `min(L, P)` and its tolerance on the time path) and its own fallbacks. The two consumers' safe directions are opposite: for fuel a count too low silences a warning, for the gap horizon a count too high announces a catch that cannot happen. So the gap horizon uses the raw leader pace and no tolerance.

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
