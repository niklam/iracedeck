# Issue #1515: Session Info Gaps shows the cars ahead and behind on track outside a race

> **Issue:** [#1515](https://github.com/niklam/iracedeck/issues/1515) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

The race gaps (#933) have no spec of their own; their design lives in `packages/sim-events-iracing/src/diff/gaps.ts` and the #1285, #1171 and #1311 specs that amended it. What this spec builds on:

- `diffGaps` (`gaps.ts:257`) returns before it records anything unless `isRaceSession` holds and the race is past the green (`gaps.ts:327-345`). `isRaceSession` is `sessionType === "Race"` (`translator.ts:2590`). So outside a race no trace is recorded and `getLiveGaps()` (`translator.ts:1104`) is `null`, which is why both rows read `–`.
- The gap is a crossing time: the leading car's progress→time trace read at the chaser's progress (`readPairGap`, `gaps.ts:203`), switching to the chaser's ETA when the leader crawls (#933 follow-up, #1285). Traces are keyed on total progress, `CarIdxLapCompleted + CarIdxLapDistPct` (`gaps.ts:353-367`), kept to `GAP_TRACE_SPAN_LAPS` = 1.15 laps (`gap-utils.ts:22`) and reset on any discontinuity (`appendProgressSample`, `gap-utils.ts:50`).
- The neighbours are class-standings neighbours from the canonical order (`resolveClassNeighbors`, `gaps.ts:387`). A car physically ahead on the road is a different concept, with its own single primitive, `findNearestCarOnTrack` (`iracing-sdk/src/track-utils.ts:88`), per the "Physical track order" rule in `.claude/rules/race-positions.md`.
- The Race Engineer's gap callouts read `getLiveGaps()` at speak time (`audio-scenarios/src/catalog/pit-crew/gaps.ts:207`, wired in `race-engineer-wiring/src/pit-crew-deps.ts:145` through `SimRuntime`). The opponent-flag range reads the race gap through `readPairGap` too.

## Decisions

### 1. Which sessions get track-order gaps

Track-order gaps run in **practice, warmup, testing and qualifying**, and in no other session. The test is a predicate over the existing `classifySessionKind` (`sim-events-iracing/src/session-kind.ts:41`): its kind is `test`, `practice` or `qualifying` (its table already maps `Warmup` to `practice`), and the raw session type is not `"Lone Qualify"` or `"Lone Practice"`. No fifth classifier is written: the kinds are the profile classifier's, and the lone exclusion is the exact-string comparison the radar (`radar-engine.ts:162`) and spotter (`spotter-engine.ts:365`) already make for Lone Qualify.

- **Qualifying is in.** Open qualifying is where traffic matters most: finding a gap for a flying lap is the whole session.
- **Lone sessions are out, by name and not by an empty field.** The issue assumed a lone qualifying session has no other cars in telemetry. It does: `local/telemetry-snapshot-20260705-155434-282.json` (a Lone Qualify, player car 4) has seven cars with valid `CarIdxLapDistPct` and `CarIdxTrackSurface` `OnTrack`, each on its own run. They are not on the player's road, so a track-order gap to them would be traffic that does not exist. Lone Practice is excluded on the same reading; no capture of one exists, so that half rests on the name (see the open decisions).
- **A race is unchanged.** It shows the class-standings neighbours exactly as today, `–` pre-green included. The positive allow-list, rather than "anything that is not `Race`", is deliberate: `"Heat Race"` or a future session-type string classifies to `null` and keeps showing `–` instead of quietly presenting track neighbours where standings neighbours are meant.

### 2. How the neighbours are picked

The neighbours are `findNearestCarOnTrack(telemetry, playerCarIdx, "ahead" | "behind", { skipIdx })`, the one track-order primitive, called once per side per tick. It already does lap-distance circular order with the wrap at the line and the shared `carInWorld` presence rule (`track-utils.ts:65`, which needs no `CarIdxLapCompleted`), and a car at exactly the player's distance is neither neighbour. `skipIdx` rejects:

- the pace car (`resolvePaceCarIdx`, `diff/pace-laps.ts:86`) and spectators (`IsSpectator === 1` in `DriverInfo.Drivers`), the filter `findNearestDriverOnTrack` uses (`template-context.ts:649`). iRacing's own Next / Previous Car (V / Shift+V) is spatial and does include the pace car; this key does not, because a pace car is not traffic;
- a car on pit road, judged by `CarIdxTrackSurface` `InPitStall` or `AproachingPits`, never `CarIdxOnPitRoad`, which real telemetry shows wrong in both directions (`diff/race-finish.ts:151`). A car towed back is `NotInWorld` and then `InPitStall`, so it is skipped throughout.

A car that is `OffTrack` stays a candidate: a car spun off ahead is exactly the traffic the driver needs to know about.

**No class filter.** In practice and qualifying traffic is traffic whatever its class, and the faster-class car closing from behind is the one a driver most needs to see. This is the opposite of the race rule (class neighbours) on purpose: the race key answers "who am I racing", this one "who is near me".

With one other car on track it is both the car ahead and the car behind, and both rows show it (ahead `x`, behind roughly a lap minus `x`). That is the true picture on a circuit, so it is not special-cased. With no other candidate the side is `null` and shows `–`.

The player must be in the world and off pit road (`PlayerTrackSurface` / `CarIdxTrackSurface[playerCarIdx]` not `InPitStall`, `AproachingPits` or `NotInWorld`, and `IsOnTrack` not `false`); otherwise there are no track gaps at all. In the pit lane a "car behind" read from the player's pit-lane passage would be badly wrong, and in the garage there is no road position.

### 3. The gap: seconds, by the same crossing-time measurement as the race

The gap is **seconds**, measured as the race's crossing time: ahead, how long ago the car ahead passed the player's current spot (its trace); behind, how long ago the player passed the spot the car behind is at now (the player's trace). The race's ETA switch for a crawling leader applies unchanged, which matters more here than in a race: a car coasting back on a cool-down lap is common in practice, and the ETA reading counts down as you close on it.

Two things differ from the race path, both because the cars are not compared by lap count.

- **Traces are keyed on a per-car odometer, not on `CarIdxLapCompleted`.** Each car's progress is an unwrapped lap-distance count kept in translator state: the per-tick change in `CarIdxLapDistPct`, folded across the line (the accrual shape of `diff/pace-laps.ts`, #657 / #773). Whether `CarIdxLapCompleted` reads `-1` on a practice out-lap before the first crossing is unmeasured (it does through a formation lap, #307); with an odometer the answer does not matter. A tick on which a car is on pit road (the surfaces above), or is the pace car or a spectator, records nothing and clears that car's trace at once. A tick on which it is not in the world records nothing, but its trace and odometer are kept for a short grace (`TRACK_GAP_ABSENCE_GRACE_S`, about 0.5 s of session time) and cleared only when the absence outlasts it. So a one-tick `NotInWorld` / `-1` blink, which `race-finish.ts`, `overtakes.ts` and the position last-known code already tolerate, is bridged, while a tow (`NotInWorld` for seconds, then the pit stall) still clears. While a side's neighbour is inside the grace, the side keeps that neighbour and its last reading; while the player is inside it, the whole tick is skipped. No sample bridges a pit-lane passage or a real absence, which `appendProgressSample`'s step guard alone would not catch for a car that re-enters at a plausible distance (amended 2026-10-31 from #1515's code review).
- **The lookup point is given by the caller.** For the car ahead, the lookup on its trace is its odometer minus the forward lap fraction from the player to it; for the car behind, the player's odometer minus the forward fraction from that car to the player; the ETA separation is that fraction. `readPairGap` is generalised to take the lookup point and the separation from its caller, so the race calls it exactly as now (`chaserProgress`, `leaderProgress − chaserProgress`) and both paths share one regime rule. Its race behaviour must not change by a byte: the existing `gaps.test.ts` passes untouched.

`lapDelta` is always `0`: a track neighbour is less than a lap away by construction, so the `NL` form never appears.

**Cold start** is short and honest: a side shows `–` until the trace it reads covers the lookup point, which takes about as long as the gap itself (a 3 s gap is covered once the car has been seen for 3 s). After the player leaves the pits, the car behind reads `–` until it passes the pit-exit point, because the player's trace starts there. That is correct: before it, any number would be measured against the pit lane.

### 4. Where it lives

A new diff module, `packages/sim-events-iracing/src/diff/track-gaps.ts`, with its own state cluster in `TranslatorState` (type and `createInitialState`): the per-car odometer, its last distance, the per-car traces, and per side the neighbour index and the display-trend chain. It runs in `handleTick` after the replay guard, beside `diffGaps`, and is gated by Decision 1's predicate. It publishes no bus event. The race store (`gapTraces`) and this one never grow in the same session, since the two gates are disjoint.

The accessor is a new **`getTrackGaps(): LiveGaps | null`** exported beside `getLiveGaps`. `getLiveGaps` is not widened. Three reasons:

- **The Race Engineer stays race-only by construction.** `SimRuntime` (`race-engineer-wiring/src/sim-runtime.ts`) gains nothing, so no callout can read a track-order gap; the gap callouts, the opponent-flag range and their speak-time readouts are untouched. Widening `getLiveGaps` would have made "race-only" depend on every reader remembering to check the session.
- **The two concepts keep two names.** A track neighbour is not a standings neighbour (`race-positions.md`), and a getter whose name and comment say "track order" cannot be mistaken for the canonical order's neighbour.
- **No new leak above the seam.** Session Info already imports `getLiveGaps` from `@iracedeck/sim-events-iracing` (`session-info.ts:52-63`); `getTrackGaps` arrives the same way, so the action's dependency on the translator is the one the Architecture page already lists, not a new kind.

The two getters are mutually exclusive: `getLiveGaps` is non-null only in a race past the green, `getTrackGaps` only in Decision 1's sessions. Session Info shows `getLiveGaps() ?? getTrackGaps()` through one small resolver used both by the state key (`session-info.ts:1047`) and by the render pass (`session-info.ts:1516`), so the key and the drawing can never pick different sources.

`LiveGaps` is reused as the return type rather than a parallel type, so `formatGapValue` and `gapRowColor` need no change; its `lapDelta` comment gains "always 0 for track-order gaps".

### 5. Display

The rows are the race's: the same triangles, value format (`formatGapValue`, `session-info.ts:287`) and trend colours (`gapRowColor`, `session-info.ts:304`). The colour keeps its race meaning, which reads the same in practice: green means you are faster than the car on that side (ahead closing, behind dropping back), red that it is faster than you. The trend is the race's display trend, a checkpoint EMA with `GAP_DISPLAY_TREND_DEADBAND_S`, the same alpha, minimum samples and checkpoint step, sampled at the player's odometer. The chain is extracted from `gaps.ts` into one helper both modules call with their own state slot, so the colour cannot come to mean different rates in the two sessions. A neighbour identity change resets that side's chain (the row goes to the text colour for about a tenth of a lap), as in the race.

**No "track order" marker on the key.** The session a driver is in is not something they need reminding of, and the title stays `GAPS` (`session-info.ts:671`). What the rows mean in each session is said in the PI help text and on the website.

### 6. No new setting

None. The behaviour follows the session, and a setting is a persisted contract. The issue's optional "track-order gaps in a race too" (to see a lapped car you are catching) would need one and is out of scope.

### 7. Affected artifacts

- `packages/sim-events-iracing`: `diff/track-gaps.ts` and its test, `state.ts`, `translator.ts` (the call, `getTrackGaps`, the snapshot's `sim` section beside `gaps` at `translator.ts:1797`), `index.ts`, the `readPairGap` generalisation and the trend-chain extraction in `diff/gaps.ts`, and `CLAUDE.md` ("What it owns").
- `packages/iracing-actions/src/actions/session-info/`: the gap-source resolver in `session-info.ts` and its tests; the help text in `session-info.ejs:73-75`, which today says "race sessions only". No option is added to the PI.
- `.claude/rules/race-positions.md`: the "Physical track order" paragraph names the new `findNearestCarOnTrack` consumer and states that it is not a race position.
- Website: the Gaps section of `docs/actions/display-session/session-info.md` (lines 136-157, which promise `–` in practice and qualifying) and the page's description line; a changelog fragment `changelog.d/1515-practice-track-gaps.md` (`Improvements`, weight 50).
- `.claude/skills/iracedeck-actions/SKILL.md`, the Session Info row's gaps entry.
- No `docs/` action reference exists for Session Info's Gaps mode, so there is nothing to change there. No scenario-harness entry, since no bus event is added. The Architecture page is unchanged: no package, seam or dependency moves.

## Alternatives rejected

- **Widen `getLiveGaps` to answer outside races.** Rejected for Decision 4's first two reasons: the Race Engineer would read track gaps the moment a race-gated path slipped, and one name would mean two orders.
- **`CarIdxEstTime` difference.** Instant, no cold start, no history. Rejected as the measurement because it is the car's class reference-lap time at its position, not elapsed time: it does not know the car ahead is on an out-lap or crawling, it compares two classes' reference laps when classes mix, and the same key would show one kind of number in a race and another in practice. Kept as an option for the pit-exit blind spot (see Out of scope).
- **Distance in metres.** Drivers think about traffic in seconds, a metre gap means different things at different speeds, and a key that switches unit by session is confusing. Seconds also keep the row format identical.
- **Reuse the race traces (`lc + pct`).** They are recorded only in a race past the green, and `CarIdxLapCompleted` can be `-1` before a car's first crossing (#307), which would drop out-lap cars from the store exactly where practice traffic comes from.
- **Sort cars by lap distance in the diff.** Forbidden by `race-positions.md`; `findNearestCarOnTrack` with a `skipIdx` covers every filter needed.
- **"Not a race" as the gate.** Would present track neighbours in a heat race or under an unknown session string; Decision 1's allow-list shows `–` there instead.

## Out of scope

- Track-order gaps in a race, as an option or by default. That needs a setting, and a decision about how the key tells the two apart there.
- Gaps while the player is on pit road, including the car approaching as you leave the pit lane. A `CarIdxEstTime` reading would serve that moment; it is a different measurement and a separate decision.
- The Race Engineer: no callout, readout or Speak-on-press reads track gaps, and the gap callouts stay race-only.
- The `track_ahead` / `track_behind` template variables keep their own filter (pace car and spectators only), so a car in the pits can be the template's `track_ahead` while the Gaps key skips it. Aligning them is not part of this issue.
- Showing which car a row refers to (number or name). The rows stay gap-only, as in the race.
- The standings gaps in a heat race (`"Heat Race"`), which already show `–` because `isRaceSession` is an exact match on `"Race"`.

## Testing

Unit tests in `packages/sim-events-iracing/src/diff/track-gaps.test.ts`:

- Gate: a practice, warmup, testing and open-qualifying session produce gaps; `Race`, `"Heat Race"`, an empty session type, `"Lone Qualify"` and `"Lone Practice"` produce `null`.
- Neighbours: pace car, spectator, `InPitStall`, `AproachingPits` and `NotInWorld` cars are skipped; an `OffTrack` car is not; a car across the line from the player (player at 0.98, car at 0.02) is the car ahead; a field longer than 64 entries is walked to its end; one other car fills both sides; none leaves both `null`.
- Measurement: the gap ahead and behind equal the crossing times of a scripted constant-speed pair, across the start/finish line and regardless of the cars' `CarIdxLapCompleted` (including `-1`); a car leaving the world or entering pit road clears its trace and reads `–` again after it returns until its trace covers the lookup; the player on pit road or out of the car yields `null`; a crawling car ahead switches to the ETA reading and counts down.
- Trend: the colour chain goes live within the race's sample count and resets on a neighbour change.

Elsewhere:

- `diff/gaps.test.ts` passes unchanged after the `readPairGap` generalisation and the trend-chain extraction, which is the proof the race path did not move.
- A translator test that a practice tick leaves `getLiveGaps()` `null` while `getTrackGaps()` answers, and a race tick the reverse; this pins the Race Engineer's source as race-only.
- `session-info.test.ts`: the resolver prefers the race gaps, falls back to the track gaps, and the state key and graphic read the same source.

Manual, in iRacing:

- A busy official practice: both rows follow the cars physically around you, skip a car diving into the pits, and colour as you close or drop back; one row reads `–` when you are alone on that side.
- Open qualifying and a warmup behave the same.
- A Lone Qualify shows `–` on both rows although other cars appear in telemetry.
- A race is indistinguishable from today: class neighbours, `–` before the green, `NL` for a lapped neighbour.
- Before implementation, a `pnpm telemetry-watch` capture of a practice out-lap (`CarIdxLapCompleted`, `CarIdxLapDistPct`, `CarIdxTrackSurface`) is worth recording into `local/`; the odometer design does not depend on it, but it settles whether the `-1` concern is real and gives the diff test a real fixture.
