# The rolling-start formation, narrated

> **Issue:** [#1167](https://github.com/niklam/iracedeck/issues/1167) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

The rolling-start formation reuses #1127's lineup machinery rather than growing a second one. The pace lineup reader learns to tell the two lineups apart **from the data itself** — where the pace car sits — so no caller can hand it the wrong frame of reference. On top of it, three calls name the car to form up behind and, on an oval running double file, the lane: the existing "Pace car moving" call gains the car, the existing rolling-start "one pace lap to go" call becomes "One lap to green" in the caution's exact words, and one new call reports a change to the car ahead during the formation. Nothing new is said at a standing start.

This builds on #1127 (`docs/superpowers/specs/2026-09-17-issue-1127-oval-caution-restart.md`) and is implemented after it merges. Every name below from that branch — `resolveCautionLineup`, the memoised `getCautionLineup()`, `getCautionPhase()`, `buildCautionContracts(deps)`, the `caution.*` vocabulary, the `caution/one-to-go-*` and `caution/lineup-changed-*` pools — is as it stood at `ir-1127` `7a1c6e53c`, after that branch's second review.

The #1127 rulings carry over unchanged: the engineer is standalone; a spoken position is the canonical race position and never a pace-row place; inside and outside are named only on an oval running double file, with line 0 taken as the inside; a car number is spoken as "car <reading>" through `getCarNumberFromSessionInfo`; calls are queueable and never dropped for a busy bus; an `optional` clause is safe only when something outside it still speaks. The settled wording is "One lap to green", which supersedes the issue's "One to green".

## What was measured

Three formations were read, on two grids, all at Homestead: the one continuous capture of a rolling start, `local/telemetry-watch-20260917-191825-092.jsonl` (ARCA, AI, 20 cars; the formation runs 107.38–201.18 s, before the committed #1127 fixture begins at 218.88), and three `pnpm telemetry-snapshot` files taken during `ParadeLaps` with full session YAML — `local/telemetry-snapshot-20260917-190240-301.json` from an earlier start the same day, and `…-20260918-182126-794.json` / `…-20260918-182157-608.json`, two moments of one formation on a second grid. The standing start is `local/telemetry-watch-20260918-185032-545.jsonl` (road course, the #1127 road capture).

| `SessionTime` | Oval formation (watch) |
| --- | --- |
| 107.38 | first record: `GetInCar`, `OneLapToGreen \| StartHidden`; the whole lineup already assigned, pace car −1/−1 |
| 116.08 | `Warmup`, `StartReady` |
| 126.67 | `ParadeLaps` — `rollingStart.pace-car-moving.raised` fires here |
| 132.35 | the pace car's surface AproachingPits → OnTrack (`paceCar.deployed`) |
| 133.98–142.48 | the field rolls onto the track car by car; the player at 138.87 |
| 186.28 | `GreenHeld`, 14.9 s before the green |
| 196.53 | the pace car back to AproachingPits (`paceCar.off`), 4.65 s before the green |
| 201.18 | `Green \| StartGo`, `SessionState` Racing; `OneLapToGreen` drops on the next tick |
| 203.22 | `CarIdxPosition` populated for the first time |
| 203.87 | the lineup starts to unwind |

Findings:

1. **The formation lineup exists from the first `GetInCar` record and never moved**: 20 cars on lines 0 and 1, rows 0–9 on each, the pace car at −1/−1, identical on all 35 pre-green ticks. The watch's lineup is car-for-car the one in the 19:02 snapshot of the same day, so that snapshot's session YAML is the watch's too — the player (car index 0) sits at line 0 row 5 behind car index 9, `"07"`.
2. **The formation order is `(row, line)`: pole L0R0 = 1, L1R0 = 2, L0R1 = 3, and so on.** That order equals the official `CarIdxPosition` iRacing first published at 203.22 for all 20 cars, and equals `QualifyResultsInfo` in all three snapshots across both grids. The caution keying applied to the same lineup misplaces 18 of the 20 — the player's P11 reads P10, the outside pole's P2 reads P3 — which is the issue's off-by-one, measured.
3. **"The pace car is unplaced and the rows start at 0" is not a formation.** From 203.87, under green, the lineup unwinds with exactly that shape: the pace car −1/−1, car index 18 (grid P3) at L0R0 and car 16 at L1R0. An anchor that ignored the session phase would call the grid's third car the leader.
4. **`OneLapToGreen` is set on the first `GetInCar` record in both captures and drops only after the green** (201.28 oval, 57.10 road). The road start was a standing one — `GetInCar` → `Warmup` → `Racing`, no `ParadeLaps` — so that capture confirms "from `GetInCar` to the green", not "through a parade".
5. **The captured formation was ONE pace lap.** The pace car was on the road from 132.35 to 196.53 s — about three quarters of a lap at the 82 s pace lap the 2026-09-18 snapshots measure — leaving from the pit-approach surface (AproachingPits, where the whole field was gridded) and returning to it; its `CarIdxLapCompleted` stayed −1 throughout, and the player's lap counters did not move until the green. So `flag.one-pace-lap-to-go.raised` (#657 / #773) has never fired in a capture beside a lineup, and would not have fired on this one.
6. **No start setting says what shape the formation is.** `WeekendOptions.StartingGrid` read `"single file"` in every snapshot while the formation ran double file (`PaceMode` DoubleFileStart, two populated lines, cars side by side), and `PaceMode` read DoubleFileStart on the road course's standing start. `ShortParadeLap` read 0 in every snapshot, in sessions set up like the one-lap formation above. The pace arrays are the only source.
7. **Lap distance cannot tell the lanes apart either**: in the 19:02 snapshot the inside car of rows 0–4 is further round the lap than its outside partner and the outside car of rows 5–9 is — the #974 swap, but depending on where on the track the row is.
8. **A car can hold a pace row while not in the world.** The player held L0R5 at 107.38 with surface NotInWorld (not yet in the car); in the road capture at 548.33 car 8 left the world and kept L0R6 for one tick, and at 548.37 the rows behind it closed up. The next ticks there show the other way a lineup moves: the player, stopped off track under caution, was passed car by car and his row rose from 6 to 17 in about seven seconds.
9. **A standing start has no lineup**: every pace row −1 from `GetInCar` until the first caution, the pace car parked and reading OnTrack.

## What the driver hears

| Moment | Call |
| --- | --- |
| Pace car moving (`ParadeLaps` entry) | "Pace car's rolling. Inside line, behind car oh seven." |
| … on pole | "Pace car's rolling. You're on pole — just you and the pace car." |
| … outside pole | "Pace car's rolling. Front row — nothing ahead but the pace car." |
| … no readable lineup | today's five lines ("…follow the car ahead.") |
| The car ahead changes during the formation | "Change — you're on the inside behind car twelve." |
| The pace car begins the last of two pace laps | "One lap to green. Take the inside line behind car oh seven." — on pole "One lap to green. You're leading them away." |
| Green held | unchanged |
| Go | unchanged ("Go, go, go!") |

The lane is named only on an oval running double file; anywhere else the numbered lines say "Form up behind" / "Line up behind". Final wording is settled at clip-generation time from a reviewed dry run.

**On a one-lap formation — the only kind captured — "One lap to green" has no moment, and stays unsaid.** Nothing tells a one-lap formation from the first lap of two at the moment the field rolls, and the #1127 rule stands: no lap count is spoken that no signal supports. The car and lane are named once, as the pace car moves, and again only if they change. The ≤2-pace-lap assumption of #657 is inherited as-is: a three-lap formation, never observed, would hear "One lap to green" a lap early, once, and the existing per-formation latch keeps it to that.

There is no position call at the start. The race-start brief (#568) already speaks the grid slot from the canonical order when the race session begins, and a formation is that grid; a second reading of the same number a minute later tells the driver nothing.

**Standing starts: nothing to narrate, and nothing added.** A standing grid carries no pace rows (finding 9), never enters `ParadeLaps`, and is already excluded by `resolveStandingStart` in both formation diffs; the start-light gantry and countdown own it.

## The pace lineup at a start

### One reader, anchored by the data

`resolveCautionLineup` becomes the pace lineup reader for both phases, and says which frame of reference it read the rows in:

| Anchor | Holds when | Line 1's row offset | Positions |
| --- | --- | --- | --- |
| `pace-car` | the pace car holds line 0 row 0 | +1 | leader L0R1 = 1, L1R0 = 2 (caution, unchanged) |
| `grid` | `isPreGreen(telemetry)`, session info names the pace car, the pace car holds no row, and a car holds line 0 row 0 | 0 | pole L0R0 = 1, L1R0 = 2, L0R1 = 3 |
| none | anything else | — | position withheld; the car ahead and the lane still answered |

The combined-order count stays exactly the #1127 one — every lined-up car keyed, sorted, counted, so uneven lanes still yield 1..N — and the only thing the anchor changes is whether line 1's rows are shifted by one. In words: **line 1 is offset by one exactly when the pace car occupies line 0's row 0**, which is the physical reason the offset exists. Single file needs no special case: counting gives the caution's `row` and the formation's `row + 1` from the same rule.

**Why read, not passed.** The alternatives were a second resolver for the formation, or a `mode` parameter. Both let a caller choose the offset, and a caller choosing it is how the off-by-one gets written — at a phase boundary, in a harness, in a test. The pace car's slot is on the same tick as the rows, so the reader can never disagree with the data it counts. The two anchors are mutually exclusive by that slot, and a lineup matching neither is withheld rather than guessed. The `grid` anchor needs the phase as well as the shape because of finding 3; `isPreGreen` is the predicate `race-order.ts` already uses to serve the qualifying grid, so the canonical order and the lineup change source on the same tick.

The same rule keeps the shapes nobody has captured safe: a rolling start whose pace car took line 0 row 0 would get the caution arithmetic, which is correct for that shape by construction, and any other shape withholds.

### Who you follow — inherited

#1127 ships the rule the formation needs, as a property of the shared reader: the car to follow is **the nearest in-world car in your own line with a lower row** (the shared `carInWorld` predicate), the pace car when there is none, and the lineup count is taken over in-world cars only, single file included. The formation inherits it unchanged and re-derives none of it; the `grid` anchor changes the offset, never the walk or the filter. At a start it earns its place for the same reasons it did under a caution: it skips a car that has left the world but still holds its row for a tick (finding 8, 548.33), and it survives a numbering with gaps, where "row − 1" would find nobody and tell a mid-pack car it had only the pace car ahead. The filter reads the other cars only — whether the player is in the car is the contracts' question (`isLiveOnTrack`) — and a capture cut without `CarIdxLapDistPct` counts every car as present, which the formation fixture relies on exactly as #1127's do.

### The pace rows or the grid, where they differ

They have not differed yet: three formations, two grids, pace-row order identical to `QualifyResultsInfo` every time. They would differ for a car sent to the tail, a driver who joined late and starts at the back, or a no-show. The design splits the question exactly as #1127 did:

- **Who you form up behind, which lane, whether you lead** — the pace rows, because they are what iRacing forms the field up by. The `race-positions.md` carve-out widens from "the caution lineup" to "the pace lineup, under a caution or in a rolling-start formation", and nothing else.
- **Any spoken number** — the canonical order, which before the green is the grid (#974). None of the new calls speaks one, and the formation publishes no lineup-place var (see Vocabulary), so the pace-row place can never be spoken by the bundled voice or a pack.
- **No grid fallback for naming a car.** Where iRacing publishes no pace rows, the grid cannot say single or double file (finding 6), cannot place a tail-ender or a no-show, and a guessed car number is the one failure this design must not have. The numberless line is the answer there.

### Naming

The reader is renamed to what it now is — `resolvePaceLineup` (still exported from the package index, as `resolveCautionLineup` is) / the memoised `getPaceLineup()` / `PaceLineup` in `diff/pace-lineup.ts`, with `restartPosition` becoming `lineupPosition` and a new `anchor` field — in one mechanical first commit. These are TypeScript exports of `@iracedeck/sim-events-iracing`, not ids or keys: every published name keeps its spelling — the `caution.*` vocabulary including `caution.restartPosition`, the `caution.lineup.changed` event and its `CautionLine` payload type, every scenario id and settings key. A function named for the caution that answers at the start is the trap the next reader would fall into.

## The road-course rolling start, either way

Never captured, so the design is decided for both outcomes:

- **Pace arrays populated as on the oval** — the `grid` anchor holds; the car is named, no lane is named (`isOvalTrack` is false), the pole-sitter hears the pole line.
- **Pace arrays held at −1, as at the standing start** — the player is not lined up, so the reader returns `null`: "Pace car moving" speaks today's five lines, "One lap to green" speaks the plain "One lap to green.", and the lineup-change call never fires, having no car to hold.

Either way no car is named that the pace rows do not name. The capture below decides which one holds; neither answer needs a code change.

## The events

| Event | Fires when | Change |
| --- | --- | --- |
| `rollingStart.pace-car-moving.raised` | the `ParadeLaps` entry edge of a rolling start | unchanged |
| `flag.one-pace-lap-to-go.raised` | the pace car's start/finish crossing that completes the first pace lap, green not held (#657 / #773) | unchanged |
| `rollingStart.lineup.changed` | the car to follow changes during a rolling-start formation | **new**, no payload |

`OneLapToGreen` cannot be the start's trigger: it has no rising edge in a formation (finding 4). The pace-car crossing heuristic stays exactly as #773 left it; this issue changes what is said at it, not when.

`rollingStart.lineup.changed` is emitted from `diff/rolling-start.ts`, beside the entry edge it already detects, mirroring `diffLineup` in `diff/caution.ts`: the follow car is read on the `ParadeLaps` entry tick as the silent baseline, a change is reported while the formation is running, a tick that cannot read the lineup is a gap rather than a change, and the state clears when the formation ends. It seeds silently on the first tick and is not preserved across a replay glance — a missed change costs one call, a replayed one would be worse.

**"The formation is running" is one translator state, read by everything.** The rolling-start diff already owns the `ParadeLaps` entry edge; it holds the formation from that edge until the session leaves `ParadeLaps` or `GreenHeld` or `Green` rises, and exposes it as `isRollingStartFormation()`, the formation's counterpart of #1127's `getCautionPhase()`. The lineup-change diff reports only inside it, and the three formation contracts ask it (below) — one derivation, so the diff that emits and the gate that speaks cannot disagree, which is the lesson #1127's second review drew when it replaced three private readings of the raw `OneLapToGreen` bit with the phase reader.

**How the formation diff reads the lineup.** Exactly as `diffLineup` does since #1127's review: it calls the pure reader itself, and only after its own early returns — outside the formation it resolves nothing, so on every racing tick the pace arrays are not walked at all. The vocabulary reads through the memoised `getPaceLineup()`. Two resolutions on one tick would need a caution during a formation, which no capture shows, and even then the reader is a pure function of that tick's telemetry and session info, so the two cannot disagree.

It carries no payload. The call reads the lineup live at speak time, and #1127 removed its own unread payload fields on the ground that a published field nothing reads is a contract maintained for no one.

**The start's go does not meet #1127's restart path.** The restart is `Green` rising while a caution phase runs with neither caution bit set, and it stamps `cautionRestartedAt` so `diffStartLights` holds the go line down for `RESTART_GO_GRACE_MS` (1000 ms) against a trailing `StartGo`. A formation carries no caution bit (the watch: `OneLapToGreen \| GreenHeld \| Servicible \| StartReady` up to the green), so the phase is `"none"` on the green tick of 201.18, no restart is announced, the stamp is not set, and `startLight.start-go.raised` fires as today. Nothing in this design touches either path. The one case that would cross them — a caution thrown during a formation — is unobserved, and would announce the caution's restart rather than the start's go, which is the right call for a green that ends a caution.

## The contracts

- **`pit-crew.rolling-start-pace-car`** (existing id and opt-in) — rescripted to name the car. It stays one call rather than gaining a follow call a few seconds later, as the caution has. The caution's follow call is separate and held 2.5 s for two reasons, and neither holds at a start: its rows land 50 ms after the flag, while a formation's are readable from the first `GetInCar` record, twenty seconds before this call fires; and its announcement is safety-first and must never be evicted from the single pending slot, whereas "Pace car's rolling" is itself the navigational cue. One call also means no second fire contesting that slot. It becomes queueable, and gains the formation speak gate below.
- **`pit-crew.flag-one-pace-lap-to-go`** (existing id and opt-in) — rescripted to the caution's one-to-go sentence, drawing on the same `caution/one-to-go-*` pools, so the start and the restart say the same words for the same moment. It becomes queueable and gains the formation speak gate; its `family` stays `flag`.
- **`pit-crew.rolling-start-lineup-changed`** (new) — weight `WEIGHT.SAFETY - 1` (69, the notch #1127's follow and position calls sit at), no `family`, queueable, `triggerDelay` 1.5 s. No family, because same-family preemption is wholesale and a change arriving while "Pace car's rolling" is playing would cut it mid-word. One notch below `SAFETY`, because the single pending slot replaces on a tie: the pace-car call waiting behind the spotter must never be evicted by a change, and losing the change instead costs nothing — the pace-car call reads the lineup live and names the new car anyway. The hold coalesces a renumbering spread over several ticks (finding 8's 40 ms close-up, or a car passing through several slots) into one decision.

**The formation speak gate**, on all three: `isRollingStartFormation()` is true. A queued formation call must never drain into the launch, and once the green is held the green-held line owns the moment. The gate asks the translator's state rather than live telemetry, so the property #1127's removed tri-state helpers gave — a missing telemetry read silences nothing — survives in the form #1127 now uses: a state reader holds its last value through a tick that cannot read telemetry, since no diff runs on it, and never answers "unknown". The contracts take the reader as a dependency, `buildCautionContracts(deps)`'s shape: the rolling-start family becomes a builder over `{ isRollingStartFormation, getPaceLineup }`, the flag family's one-pace-lap-to-go contract takes the same reader, and `PitCrewDeps` gains `isRollingStartFormation` with a `() => false` default — as `getCautionPhase` defaults to `"none"`, a consumer that does not wire it hears no formation call rather than an ungated one — wired in all three plugins and the harness.

**The pace-row re-check follows #1127's split exactly.** There, the follow and lineup-changed calls also re-check at speak time that the player still holds a pace row, and the one-to-go call deliberately does not, because it must never come out as nothing and has a numberless branch for a player with no row. At the start the lineup-change call carries the same re-check (`getPaceLineup() !== null`, read live after the hold): a change to a lineup the player is no longer in is no news. The pace-car call and the one-lap-to-green call deliberately do not, for the one-to-go reason — each has a numberless branch that must still speak, and the road-course outcome with no pace rows depends on it.

Descriptions, rewritten or new, for the published reference: the pace-car call names who you form up behind and the lane on an oval; the one-pace-lap-to-go call says it fires only on a formation of two pace laps and that a one-lap formation has no such moment.

## Vocabulary

Registered under the rolling-start family's prefix, from the **same builder** that registers the `caution.*` names, so the two families can never answer differently about one tick:

- `rollingStart.followCarNumber` — the car to form up behind, from the `car-number` group; null while only the pace car is ahead.
- `rollingStart.hasFollowCarNumber`, `rollingStart.followsPaceCar`, `rollingStart.isLeader`, `rollingStart.isDoubleFile` — conditions.
- `rollingStart.line` — a case: `inside` / `outside` / absent.

Deliberately **no** `rollingStart.lineupPosition` and no start position var. The lineup place feeds `rollingStart.isLeader` only; a spoken start position belongs to the race-start brief and the canonical order, and a pack author offered the pace-row place would reproduce #1127's "P21".

Reusing the `caution.*` names at the start was rejected: they are described as answering under a caution, and a pack author writing a start callout would have to learn that they also answer somewhere their names deny.

**A known limitation, inherited rather than re-discovered.** `caution.hasFollowCarNumber` asks the SESSION whether it can spell the car's number, not the VOICE whether it has that number's clip, because a vocabulary resolver receives only the fire's `ScenarioContext`. `rollingStart.hasFollowCarNumber` comes from the same builder and inherits it. It bites only a third-party pack whose `car-number` group is partial: such a pack takes the numbered branch for a number it cannot say, and that branch's `optional` clause drops to silence rather than to the numberless wording. The reference voice ships every number iRacing can issue, so it is unaffected; fixing it is a change to the vocabulary seam, and belongs to neither issue.

## Changes to behaviour that already ships

- "Pace car moving" names the car and, on an oval, the lane; with no readable lineup it says what it says today.
- The rolling-start "one pace lap to go" line says "One lap to green" with the car and lane, in place of its five tyre-warming lines. Those five clips leave the reference voice: once the entry no longer draws on them they are orphans the script-coverage test refuses. Other voice packs keep whatever they script for the id.
- Both of those calls become queueable, so neither is dropped behind the spotter as the field rolls out side by side, and both gain the formation speak gate.

The in-world follow rule and count are not in this list: they ship with #1127, and the formation inherits them.

## Settings

- `calloutEnabledRollingStartPaceCar` — unchanged key and label, "Pace car moving".
- `calloutEnabledFlagOnePaceLapToGo` — unchanged key. Its row moves from the Flags group to the Rolling start group, relabelled "One lap to green", matching the caution group's label for the same sentence.
- `calloutEnabledRollingStartLineupChanged` — new, default true, labelled "Car ahead changed" as in the caution group, wired through `ROLLING_START_CALLOUT_SETTING_KEYS`.

The caution opt-ins are not reused: turning off the caution narration is not a request to silence the start.

## Clips

Five new `rolling-start` entries, one take each: `pace-car-moving-inside-01`, `-outside-01` and `-behind-01` — lead-ins that stop before "car" and carry `next_text: "car ninety five"`, never `next_request_ids` — and `pace-car-moving-leader-01` and `pace-car-moving-front-row-01`. The dry run must list exactly these five before anything is recorded. Reused unchanged: `rolling-start/pace-car-moving-01`…`05` as the numberless branch, `caution/one-to-go*`, `caution/lineup-changed-*` and the `car-number` group — none of the frozen `one-to-go-*` entries is edited, so none of the 1,110 number clips is re-cut. Removed: `flags/one-pace-lap-to-go-01`…`05`. The number clips were conditioned to follow the caution's one-to-go lead-in (`previous_request_ids: ["caution/one-to-go-outside-01"]`), so the new seams are listened to before they are accepted; the car-number reference is never re-pointed to fix one, since that re-cuts all 1,110.

**Shipping the pack.** The default pack's archive changes, so it takes a version bump and a regenerated catalog entry. Its script also names vocabulary no earlier plugin registers (`rollingStart.*`), and an earlier plugin that fetches it cannot compile the two rescripted entries — it skips them with a warn, and the pace-car call it speaks today goes silent. So if this ships in any release after 3.3.0, the release that introduced the launch step, the `default` catalog entry carries `minPluginVersion` (`deck-core/src/voice-pack-catalog.ts`) set to the release this ships in. If it ships in 3.3.0 itself, no plugin that fetches packs predates it, and nothing is needed.

## Testing

- **A committed formation fixture** cut from the watch's 107.38–206.80 s, with the session YAML fields it needs taken from the 19:02 snapshot (finding 1 shows it is the same grid). Asserted: on every pre-green tick the `grid` anchor holds and the whole field's positions equal both `QualifyResultsInfo` and the `CarIdxPosition` of 203.22; the player follows car `"07"` on the inside; car 17 (`"96"`) is the leader; car 16 (`"37"`) follows the pace car and is not the leader; every tick from 201.18 on — the unwind at 203.87 included — is withheld. Replayed through the translator it emits the pace-car-moving event, `paceCar.deployed`, green held, `paceCar.off` and the start's go, and asserts the silence of `rollingStart.lineup.changed` across a formation whose lineup never moved. The watch recorded no lap distance, so the fixture cannot exercise the pace-lap diff: its silence there would be for want of data rather than because the formation was one lap, and is not asserted — the two-lap capture below is what tests that call.
- **The three snapshots** as single-tick fixtures: pace-row order equals `QualifyResultsInfo` for every car, on two grids.
- **A positive control**: the same assertions run with the offset forced to the caution's must fail — 18 of 20 cars misplaced — so the fixture is proven able to catch the bug it exists for.
- **The three #1127 caution fixtures and its lineup tests unchanged** under the anchored reader — the 548.33 not-in-world case included, which #1127 already tests — with the formation's `grid` anchor never holding on any of their ticks, since every one is under `Racing`.
- Synthetic unit tests for what no capture holds: a single-file formation, a lineup change during the formation, `isRollingStartFormation()` ending when `GreenHeld` rises and holding through a tick with no telemetry, the lineup-change call refused once the player holds no row, the three contracts' branches and speak gate, the queue order of pace-car call and change.
- **Harness**: `rollingStart.lineup.changed` joins `event-names.ts`; a "Rolling Start → Car ahead changed" shortcut; and a `telemetrySequence` "Rolling Start → Formation (oval, two laps)" modelled on the watch — the lineup at `GetInCar`, `Warmup`, the `ParadeLaps` entry, a pace-car lap-distance wrap with more than half a lap accrued so the real #773 decision fires, a car ahead dropping out, green held, the go, the unwind — ending on sane flags, and requiring the race-oval preset through a `requires` precondition. The flag shortcut "One Pace Lap to Go" is relabelled to match the switch.

## Documentation

The Pit Crew page's Rolling Start section and callout switch list, the changelog line, `race-positions.md` (the widened carve-out and its consumer entry), a #1167 entry in `race-engineer-callout-examples.md` — its reusable lesson: let the data say which frame of reference it is in, never the caller — the harness `CLAUDE.md`, the rolling-start family in `packages/audio-scenarios/CLAUDE.md`, and the regenerated pack reference.

## Rejected alternatives

- **A separate formation resolver, or a mode parameter.** Both let a caller pick the offset; see *Why read, not passed*.
- **Anchoring on "the pace car is unplaced and the rows start at 0".** The green unwind satisfies it (finding 3).
- **Naming the car from the qualifying grid when the pace rows are empty.** See *The pace rows or the grid*.
- **A separate follow call after "Pace car's rolling".** See *The contracts*.
- **A position call on the formation.** The race-start brief speaks the canonical grid slot already, and the pace-row place is the number that must never be spoken.
- **`OneLapToGreen` as the start's trigger, or a lap count from session info.** The bit is held from `GetInCar`; no field carries the count, and `ShortParadeLap` read 0 in sessions set up like the one-lap formation.
- **"Two to green" as the field rolls on a two-lap formation.** At that moment a one-lap and a two-lap formation look identical.
- **Naming the car again in the green-held line** as the one-lap formation's last-lap mention. That line lands 15 s before the launch at restarts too, and it is the moment for the launch, not for a car number.
- **New pools for "One lap to green" at a start.** The caution's lines are the words, and re-cutting would touch frozen clips.
- **Reusing the caution opt-ins or the `caution.*` names.** See Settings and Vocabulary.

## Unverified, and what would settle it

None of these blocks implementation; each is a capture confirming a branch the design already takes.

- **A road-course rolling start.** An AI race on a road course with a rolling start (`StandingStart` 0). Record `pnpm telemetry-watch --vars=SessionFlags,SessionState,PaceMode,PlayerCarIdx,CarIdxPaceLine,CarIdxPaceRow,CarIdxTrackSurface,CarIdxLapCompleted,CarIdxLapDistPct,CarIdxPosition` from `GetInCar` until 30 s after the green, and take one `pnpm telemetry-snapshot` during `ParadeLaps`. Read: whether the pace rows are populated or −1; where the pace car sits; whether rows count from 0; whether the order matches `QualifyResultsInfo`. Decides which branch of *The road-course rolling start, either way* runs.
- **A two-pace-lap formation.** Any rolling start that runs two pace laps (#657 recorded one, driver-reported), recorded with the same variables. Read: the pace car's `CarIdxLapDistPct` wrap, that `flag.one-pace-lap-to-go.raised` lands on it, and that the lineup is intact on that tick. This is the first time "One lap to green" at a start would be heard against real data.
- **A lineup change during the formation.** In an AI formation on an oval, during `ParadeLaps`, send the car directly ahead of you in your line to the end with the Race Admin `!eol <car>` command; if the command is refused before the green, lift and let the car behind pass. Same recording. Read: whether the rows close up on the next tick, as they did under caution in the road capture, and how many ticks a renumbering spans against the 1.5 s hold.
- **Which physical side line 0 is** — shared with #1127, and cheapest here: sitting in the formation, look out of the window at the car alongside and note your own `CarIdxPaceLine` from a snapshot.

## Confirmed by the maintainer

Niklas confirmed five of these decisions on 2026-09-19: "Pace car moving" names the car in one call; a one-lap formation never hears "One lap to green"; the five tyre-warming lines are retired; the one-lap-to-green switch moves to the Rolling start group, relabelled "One lap to green"; and the formation lineup-change call gets its own opt-in, on by default.

## Order of work, and review

After #1127 merges: the rename, as its own mechanical commit; the reader's `grid` anchor with every fixture — the seam everything else consumes, reviewed on its own before anything builds on it; the rolling-start diff with `isRollingStartFormation()`, the new event and its harness entry; the vocabulary, contracts, script entries and the five clips; the settings, checkbox rows and the three plugins; the documentation last.

The change adds an event to the published `@iracedeck/event-bus` catalog and changes a published script contract, so the branch takes an `xhigh` code review at the end, per `@.claude/rules/code-review.md`.
