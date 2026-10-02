# The Race Engineer talks a pit starter through the Missed Start hold

> **Issue:** [#1301](https://github.com/niklam/iracedeck/issues/1301) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

A driver who missed the grid gets their own start sequence, and none of the gridded driver's. The translator decides "pit starter" from the sim's pace order at the start of the formation lap, and drives a hold-and-release countdown from the sim's own hold timer at the green. Four lines, one family, one opt-in:

| Moment | Event | Default voice, roughly |
| --- | --- | --- |
| ParadeLaps entry, driver not gridded | `pitStart.missed-grid.raised` | "We missed the grid, so we start from pit lane. Stay in the box and wait for my call." |
| The green, hold timer running | `pitStart.hold.raised` `{ seconds }` | "Green flag. Hold in the box, I'll count you down." |
| Hold timer crossing 3, 2, 1 | `pitStart.countdown.raised` `{ seconds: 3 \| 2 \| 1 }` | "Three." / "Two." / "One." |
| Hold timer reaching 0 | `pitStart.release.raised` | "Go, go!" |

No line mentions the pit limiter (maintainer, 2026-10-02). Leaving the pits is already covered by the pit-speeding cue.

## What the sim exposes

Measured from the 2026-10-02 snapshots (ARCA, Autódromo Hermanos Rodríguez oval, offline vs 19 AI, two races with the driver in the pit stall through the start), compared against all 85 snapshots then in `local/`.

**Not gridded.** At `SessionState = ParadeLaps` with `PaceMode` a start mode (single- or double-file start), the other 19 cars carry `CarIdxPaceLine` / `CarIdxPaceRow` ≥ 0 and the driver carries `-1 / -1`. Every earlier ParadeLaps snapshot with the driver on the grid shows them a row (`row 1–5`). The only other "field has rows, player -1" snapshot is the driver out of the car watching a replay, which the live-in-car gate already excludes. While racing (`PaceMode = 4`) every car reads `-1`, so "the field has rows" is what tells a formation from a race in progress.

**The hold is `PlayerCarTowTime`.** In the stall it reads exactly `1` from the formation lap to the green (the black box shows "Missed Start — Waiting"), jumps to the hold length at the green (`8.03` at 0.5 s after green; the black box showed "Missed Start 7.0" moments later) and counts down. Of the 85 snapshots it is non-zero only in these five, including none of the several taken in the pit stall mid-race. No session flag, `CarIdxSessionFlags` bit or session-info field marks the penalty.

## Detection

A new `diff/pit-start.ts` in `sim-events-iracing` owns the pit-start state; the rolling-start diff consults it.

**Pit starter** (a live read, exported as `isPitStarter()` beside `getSessionType()` for contract gates):

> race session ∧ `SessionState` ∈ {GetInCar, Warmup, ParadeLaps} ∧ `PaceMode` ∈ {SingleFileStart, DoubleFileStart} ∧ some other car has `CarIdxPaceRow ≥ 0` ∧ `CarIdxPaceRow[me] === -1`

or, once the green has flown, a missed-start hold armed this session (below) whose timer has not yet reached 0. The pace row decides; `PlayerCarInPitStall` / `OnPitRoad` are not required, since the pace row is the sim's own statement and covers a car anywhere on pit road.

**Missed grid, at ParadeLaps entry.** The rolling-start diff's entry edge decides between the two formation lines — `rollingStart.pace-car-moving.raised` for a gridded driver, `pitStart.missed-grid.raised` for a pit starter, never both. If no other car carries a row on the edge tick, the decision waits, re-reading every tick, until one does or 2 s have passed; at the deadline with still no rows it falls back to the pace-car line, today's behaviour. Whether the rows lag the edge at all is unmeasured — the snapshots are 7 s after it; the capture below sets the 2 s.

**The hold.** The hold is *armed* when, in a race session before the green, the driver is in the pit stall with `PlayerCarTowTime === 1`. Arming is what keeps a mid-race tow — which also counts `PlayerCarTowTime` down — out of this family. An armed hold:

- emits `pitStart.hold.raised { seconds: ceil(PlayerCarTowTime) }` on the first tick after the green with `PlayerCarTowTime > 1`;
- emits `pitStart.countdown.raised { seconds }` each time `ceil(PlayerCarTowTime)` drops to 3, 2 and 1 — a hold that starts at or under 3 s begins the countdown at its current second;
- emits `pitStart.release.raised` when `PlayerCarTowTime` reaches 0 with the driver still in the stall, and disarms.

The hold also disarms, silently, on a session change, on the driver leaving the car or the stall, or when the session leaves the start phase without a green. The diff seeds on the first tick like its siblings, so connecting mid-hold says nothing.

## The contracts

A new `pit-start` family in `audio-scenarios`, four contracts, all gated on the existing `liveRaceCar` predicate (race session, live in the car):

- `pit-crew.pit-start-missed-grid` — `WEIGHT.SAFETY`, as the pace-car line it replaces.
- `pit-crew.pit-start-hold` — `WEIGHT.SAFETY`. It speaks only when the hold is long enough to finish before the countdown: `seconds > 4`; a shorter hold goes straight to the countdown.
- `pit-crew.pit-start-countdown-3/2/1` and `pit-crew.pit-start-release` — `WEIGHT.CRITICAL` with `interrupt: true`, as `start-light-go` is: a late "go" is worse than a clipped line. None of them is `queueable`; a countdown number that cannot play on time is dropped.

Gridded-driver lines stay silent for a pit starter, gated by `!isPitStarter()` in their `where:`:

- `pit-crew.flag-green-held` — "get ready to launch".
- `pit-crew.start-light-go`.
- `pit-crew.rolling-start-pace-car` needs no gate: the translator never emits its event for a pit starter.

`caution-pace-car-off`, which also played at both starts, is unchanged — see Out of scope.

**Pools.** The script addresses `pool:pit-start/missed-grid`, `pit-start/hold`, `pit-start/countdown-3`, `countdown-2`, `countdown-1` and `pit-start/release`; the start-light countdown pools (`countdown-90/60/30/10`) have no 3-2-1, so the family carries its own. Both first-party voices (`default` and `shawn`) get script entries and clips; both packs bump and their catalog entries regenerate. The new events need a plugin that emits them, so both catalog entries carry the `minPluginVersion` of the release this ships in, as #1284 did.

**Opt-in.** One per-callout key for the family, `calloutEnabledPitStart`, default `true` (new Race Engineer functionality defaults on). It gates the four new lines only; the suppression of `green-held` and `start-light-go` for a pit starter is unconditional, since it removes a wrong call rather than adding one.

## Out of scope

- **Standing starts.** No capture shows whether a standing-start grid populates pace rows or arms the same hold. The hold half may already work there; the missed-grid line is wired to the rolling-start entry edge only.
- **The race-start brief.** It said "qualifying put us to 12" to a driver who then started from the pits. Whether a driver sitting in the pits during GetInCar can still grid is unestablished, so the brief cannot know in advance.
- **`caution-pace-car-off` at a rolling start.** Asked on 2026-10-02 whether it is wanted at every start; unanswered, and it is information rather than an instruction, so it is not gated here.
- **A mid-race tow countdown.** Same timer, different situation; the arming rule keeps it out, and a tow callout would be its own issue.
- **Leaving before release.** Whether leaving the stall early draws a further penalty is unestablished; the lines say "hold" without claiming one.
- **"Pit Lane Closed".** The black box showed it during the hold while `PitsOpen` read `true` 0.5 s after the green. The countdown follows the hold timer, not `PitsOpen`.
- **`fuel-laps.ts`.** It reads `PlayerCarTowTime > 0` as "towed this lap"; a missed-start lap is an out-lap and already excluded, so nothing changes.

## Testing

Automated:

- `diff/pit-start.ts`: synthetic ticks shaped on the 2026-10-02 snapshots — field rows ≥ 0, player `-1`, ParadeLaps, `PlayerCarTowTime = 1` in the stall; then the green with the timer at 8.03 falling to 0. Assert the event sequence `hold { 9 }` → `countdown 3` → `2` → `1` → `release`, exactly once each. Also: a hold starting at 2.4 s emits `countdown 2`, `1`, `release` and no 3; a mid-race tow (`PlayerCarTowTime` counting without arming) emits nothing; leaving the stall mid-hold disarms; a session change disarms; a first tick mid-hold seeds silently.
- Rolling-start diff: a gridded driver at the entry edge emits only the pace-car event; a pit starter emits only the missed-grid event; rows that appear 1 s after the edge are waited for; no rows by 2 s falls back to the pace-car event.
- `isPitStarter()`: true in each start-phase state for a `-1` row against a gridded field; false while racing with every row `-1`; true after the green until release, false after.
- Contracts: `green-held` and `start-light-go` are rejected for a pit starter and admitted for a gridded driver; the hold line is rejected at `seconds ≤ 4`; the opt-in gates the four new lines and not the suppression.
- `bundled-scripts.test.ts` and `script-coverage.test.ts` over both voices' new entries and clips; `pnpm generate:pack-reference` freshness.

Manual: an offline AI race joined from the pits (or reset to the pits before the grid closes) — the missed-grid line at the formation start, none of the gridded lines, the hold line at the green, the countdown in step with the black box's "Missed Start" timer, and "go" as it reaches 0. Then the same race from the grid: today's sequence, unchanged.

Capture that sets the 2 s row wait and confirms the countdown: `pnpm telemetry-watch` at full rate across a missed start, recording `SessionState`, `PaceMode`, `SessionFlags`, `CarIdxPaceRow`, `PlayerCarTowTime`, `PlayerCarInPitStall`, `OnPitRoad` and `PitsOpen` from GetInCar to the driver leaving pit lane.
