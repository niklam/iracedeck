# Gap closing-announcement horizon: whichever limit ends the race, through the white and chequered laps

> **Issue:** [#1311](https://github.com/niklam/iracedeck/issues/1311) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

The gap callouts announce a closing threat only when the projected contact (`lapsToContact`, in `diffGaps`) falls inside a horizon: `min(GAP_CONTACT_HORIZON_LAPS, lapsRemaining)`. The `lapsRemaining` side exists so that a catch completing after the chequered flag is never announced. The translator built it by taking the lap cap whenever one existed, which is wrong for a timed race that also carries a larger cap. The issue's first fix, which composed `resolveLapsRemaining`, `resolveTimeRemainingS` / leader lap and `bindingLapsToGo`, was still wrong in two ways the code review found:

1. **The two sides were in different units.** `SessionLapsRemainEx` counts the leader's remaining line crossings including the chequered one (a reading of 1 means the current lap is the last). The clock divided by the leader's lap time leaves out the two crossings a timed race still runs after expiry: the white at the leader's first crossing after the clock reaches zero, and the chequered one lap later (the #880 model that `leader-white.ts` and the fuel callouts already use). So the comparison could pick the clock when the cap actually ends the race, and every timed race's last half-minute read a horizon of a fraction of a lap.
2. **An expired clock read as unknown.** `resolveTimeRemainingS` returns `null` for a negative `SessionTimeRemain`, so for the white and chequered laps the horizon fell back to the lap cap (dual-limit) or to no cap at all (time-only). That is the after-the-flag announcement the issue is about, on the very laps where it matters. A one-tick negative blip mid-race did the same for that tick.

## Decision

Express the time side in the lap counter's unit: **the leader's remaining line crossings, the chequered one included**, and let `bindingLapsToGo` pick between the two sides as before (a tie goes to the lap counter).

- **Clock running** (`resolveTimeRemainingS` ≥ 0, leader lap time `L` known, leader lap fraction `f`): the leader's k-th crossing from now is at `(k − f) · L`; the white is the first one at or after expiry, `k = ceil(t / L + f)`, and the chequered is the one after it. Time side = `ceil(t / L + f) + 1`. An unknown `f` (leader off-world) is taken as `0`, the smaller count.
- **Clock at or below zero** (a finite `SessionTimeRemain` of zero or less): `1` once `state.leaderWhitePostExpiryCrossed` says the leader has crossed since expiry, otherwise `2`. This needs no lap time, so the time side stays known through the last laps. The marker is the one `diffLeaderWhite` maintains (it runs earlier in the same tick); it can also be set by a leader change while expired, which makes the count `1` where `2` was true. That under-counts, which only withholds an announcement.
- **A mid-race blip** reads as the clock-at-zero case, `2`, for that tick. A smaller horizon for one tick only withholds announcements, so no two-tick confirmation is needed here, unlike `leader-white.ts`, which must not *fire* on a blip.
- **The lap side is unchanged**: `resolveLapsRemaining`, so a counter of `0` (the leader has taken the chequered) is a horizon of `0` rather than falling through to the clock.

The resolver is `resolveGapLapsRemaining(telemetry, positions, leaderCrossedSinceExpiry)` in `translator.ts`, beside `resolveLeaderLapTimeS`. The horizon shares the whichever-ends-sooner *rule* with the fuel callouts, not their operands: each consumer estimates its own two sides (the fuel estimate counts the player's laps after the current one, through the player's average), so the two can still disagree about which limit binds, as `resolveLeaderLapTimeS`' doc already says.

## Alternatives rejected

- **Raw clock divided by the leader's lap (the first fix).** Different unit from the counter, and blind after expiry; see Problem.
- **The fuel estimate's `timeRemain + 2 × leaderLap` upper bound.** The right magnitude but a bound rather than a count. The lap fraction gives the actual crossing count for the same cost.
- **Reading the expired clock as `0` laps (`resolveShownTimeRemainingS`).** Mutes every closing call for the white and chequered laps, when one to two laps still remain.
- **`SessionFlags & Flags.White` for "white is up".** The bit is per car (`leader-white.ts`' header), so a slower-class or lapped player does not see the leader's white. The post-expiry crossing marker is leader-relative.

## Out of scope

- **The horizon is in the leader's laps, while `lapsToContact` is in the player's.** A slower-class or lapped player completes fewer laps than the leader before the flag, so a catch the horizon admits can still come after the player's own chequered, and a leader who has already finished (`0`) mutes calls on the player's last lap. Both sides need converting to the player's laps; that touches the lap side too and is its own issue.
- Computing the leader lap time once per tick for both the gap horizon and the fuel getter. The fuel getter is lazy and the lookup is a `findIndex` over the order, so there is nothing measurable to save.

## Testing

- Unit tests on `resolveGapLapsRemaining`: a dual-limit race whose clock binds; one whose cap binds; one where the cap binds only because the clock side counts the white and chequered laps; lap-only; time-only; neither known; no leader pace with the clock running; an expired clock before and after the leader's crossing (time-only and dual-limit); a negative blip mid-race; a lap counter of `0`.
- A translator-level test that drives ticks through `initializeSimEventsIracing` with `diffGaps` spied, asserting the horizon it receives in a timed race carrying a larger lap cap: the clock-implied count while the clock runs, `2` once the clock has expired, `1` after the leader's post-expiry crossing.
- Manual: the scenario harness's gap shortcuts still produce their callouts (its mock sets neither limit, so the horizon is `null`, as before).
