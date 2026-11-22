# Replay race order across the start/finish line

> **Issue:** [#1682](https://github.com/niklam/iracedeck/issues/1682) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

On a replay frame the canonical order is the raw lap-progress ranking (`lc + dp`). The replay guard returns before `updatePositionTracking`, by design since #603, so no freeze holds a car whose sum jumps. At the line iRacing's `CarIdxLapCompleted` and `CarIdxLapDistPct` disagree for a tick (#1572). The sum is then a lap off, and the car ranks a lap ahead or behind for that tick. In Niklas's capture (`local/telemetry-watch-20261110-193856-818.jsonl`, 2475 replay ticks, camera car 6) the camera car blinks P5 → P6 → P5 nine times.

Three facts from the capture shape the design:

- **The capture rewinds and pauses between the crossings.** Eight of the nine blinks are on forward ticks (+1/60 s), but the capture rewinds at 12 frames a tick (`SessionTime` −0.2 s a tick) and sits paused for long stretches. A forward-only span (the live step's rule, `0 <= since <= 0.5`) breaks every car's chain at each rewind tick. When play resumes, the cars about to cross are already inside the line guard band, so the band-exit confirmation never confirms them. With the live policy, 8 of the 9 blinks remain. With both-ways span but no run, 1 remains (car 4). With the full replay policy, none remain.
- **Car 4's crossing is on pit road at pit speed.** It sits inside the line guard band (0.05 lap) for the whole 400 ticks before it. Under the live step's confirmation rule, a run of readings that began inside the band confirms only once it leaves the band. So car 4 is never confirmed and never corrected.
- **Car 4 reads a lap fraction of −0.00004 on the frame after its crossing.** iRacing's not-in-world sentinel is −1. The raw order drops the car for two ticks, and the cars behind it move up.

## Decision

On replay frames, the canonical order ranks every car by its progress, read through the same line-progress core as the live step but under a replay policy. The readings are taken against a per-car memory kept for replay frames only.

1. **One line-progress reading core, two policies.** `diff/car-progress.ts` keeps the one per-car reading core, exported as three functions:
   - the span check: may a reading be corrected against the last;
   - the confirmation predicate: is a reading a confirmed baseline for the next;
   - the line-fraction reading: validity plus `readCarProgress` against the confirmed last.

   `stepCarProgress` and the replay step both call them. Each passes a policy:
   - **live:** forward-only span, band-exit confirmation, fraction `>= 0`. This is today's rule, and the live step's output stays byte-identical.
   - **replay:** span in both directions, run confirmation on, near-zero fraction.

   `diff/replay-progress.ts` holds only the replay step's ordering and its slice handling, and has no second rule loop. The replay exception and its reason are written beside each "one rule" claim: `sim-events-iracing/CLAUDE.md` (the car-progress bullet), `confirmedLastProgress` in `car-progress.ts`, and `race-positions.md`.
2. **Span in both directions on replay.** A reading may be corrected against the confirmed last when `|SessionTime − last read| <= 0.5 s`. `readCarProgress` is symmetric: rewinding across the line (7.0001, then lc 7 with dp 0.9999) is corrected to 6.9999, as the forward case is. A jump past 0.5 s either way is a seek. It leaves every reading uncorrected and unconfirmed, because a reading after it continues nothing.
3. **Confirmation by a run (replay policy).** A reading is confirmed when it continues the last one (within half a lap) and one of these holds:
   - the last reading was confirmed;
   - this reading was taken clear of the band;
   - it is the third consecutive continuing reading at a distinct `SessionTime`.

   The disagreement lasts one tick in every capture, so three agreeing readings cannot all be a lap off. A repeated reading adds nothing to the run, whatever the clock does: a paused saved replay repeats its `SessionTime`, and an in-session replay paused at its live edge (where the per-car arrays are the replay's while `SessionTime` stays live, #1426) repeats the reading with the clock running on. So the run grows only on a reading at a distinct `SessionTime` that also moved, and a pause on the disagreeing frame cannot confirm it. After a seek the run rebuilds in three ticks.
4. **The near-zero lap fraction is one reader in `@iracedeck/iracing-sdk`.** `readLapFraction` sits in `track-utils.ts` beside `carInWorld`. It returns the fraction when it is finite and above −0.001, and `null` otherwise. The replay policy uses it: 7 + (−0.00004) = 6.99996 is continuous with the readings either side. Beside it, and in `race-positions.md`, the live readers that deliberately keep `>= 0` are named: the live car-progress step, `updatePositionTracking` / `calculateFrozenRacePositions`, `calculateRacePositions` and `carInWorld`. They keep it because the live order's freeze already holds such a car, and changing what "in the world" means live is #1742's call. `readCarProgress`'s "finite and non-negative" doc is corrected.
5. **Memory on the state, the pairing on the instance.** The `replayProgress` slice of `TranslatorState` holds only per-car memory: the last reading, whether it is confirmed, the run length, and the last `SessionTime` read. It is wiped whole at both replay edges, by the wipe that already recreates the state. No `TelemetryData` goes into `TranslatorState`, where it would also land in every Telemetry Snapshot's `raw.state`. The readings for a particular telemetry object live on the `TranslatorInstance`, next to `canonicalOrderMemo`. The step clears that pairing when it starts and writes it last, so a throw leaves no readings that match any telemetry.
6. **A third source for the order, passed as a value.** `readCanonicalOrder` / `resolveCanonicalOrder` pass the readings into `calculateCanonicalRacePositions`: the instance's readings when their telemetry is the object being ordered, `null` otherwise. `race-order.ts` stays a pure choice between sources: the qualifying grid pre-green, then the replay readings when given, then `calculateFrozenRacePositions`. A live tick never sees replay readings. Neither does a replay tick the step threw on.
7. **The step's place.** `handleTick` runs `steps.run("stepReplayProgress", …)` inside the replay guard. It runs after the entry wipe, on every tick the guard swallows: an in-session replay, the seek grace and a saved replay. It runs whether or not anything reads the order, so the memory has no gaps that depend on how often a dial renders. It then clears `canonicalOrderMemo`, as the memo's invariant requires of any writer of the order's inputs. `tick-steps.source.test.ts` accepts it, `TRANSLATOR_REPORTER_MAX_KEYS` rises by one, and it gets no `TICK_ORDER` row, since it publishes nothing. It is the translator's step and not the replay recorder's (#1468): it feeds the canonical order, which the translator owns. The recorder only publishes `replay.*` events.
8. **One ranking.** `rankRaceScores(scores)` in `@iracedeck/iracing-sdk` `position-utils.ts` is the one sort: score descending, then carIdx ascending (`b.score - a.score || a.idx - b.idx`), rank `0` for no score, and an array as long as the scores. `calculateRacePositions` and `calculateFrozenRacePositions` call it, with their output unchanged, and the replay order calls it too.

Measured by simulating the replay policy over the capture:

| Measure | Before | After |
| --- | --- | --- |
| Camera-car blinks | 9 | 0 |
| One-tick rank changes, any car | 136 | 0 |

The two-tick drop from car 4's −0.00004 frame is gone too.

### Why not the live freeze

The live order holds a car whose sum jumps past `TELEPORT_THRESHOLD`, and releases it on forward motion off pit road. A scrubbed timeline breaks both assumptions, since a rewind is all backward motion. That is why #603 kept the freeze out. The replay memory corrects only the one-tick disagreement at the line, and holds nothing.

### Why the live step keeps its policy, and what #1742 gets

The live step's forward-only span is right live. Its band-exit confirmation has a documented cost: a run of readings that began inside the band is not corrected until it leaves the band. Such a run begins after a blink, a gate flicker or a span past 0.5 s, and a crossing inside it costs a trace reset, a missing lap for the sector timer. This change leaves that unchanged and hands #1742 two questions:

- Should the live step adopt the run-of-three confirmation?
- Should the live readers adopt `readLapFraction`'s near-zero fraction?

#1742 also keeps its own open question: whether the live order and standings read `readCarProgress`.

## Out of scope

- Any change to the live order, the live car-progress step or the live readers' `>= 0` rule (#1742).
- Fast-forward beyond 0.01 lap a tick, which is all `readCarProgress` allows. A car covering more than that per tick at the line is not corrected and may still blink for a tick.
- The official `CarIdxPosition` fallback on Replay Control's dial, which is used only when there is no canonical order.

## Documentation

- `.claude/rules/race-positions.md`:
  - the canonical-source paragraph (`:20`): the replay readings as the order's third source;
  - the lap-progress bullet (`:22`): the primitive is now `rankRaceScores`, and that bullet is already wrong to call `calculateRacePositions` the only place;
  - the replay exception beside the one-rule claim;
  - the live readers that keep `>= 0`.
- `packages/sim-events-iracing/CLAUDE.md`: the canonical-order bullet (`:12`), and the car-progress bullet (`:17`) with its replay exception.
- The `getLiveRacePositions` JSDoc (`translator.ts`, the "during replay" note) and the `canonicalOrderMemo` invariant doc (the step as a second writer).
- The `race-order.ts` header and the `calculateCanonicalRacePositions` doc.
- `confirmedLastProgress` / `readCarProgress` docs in `car-progress.ts`, and `readLapFraction` beside `carInWorld`.
- A changelog fragment, under Bug Fixes.

## Testing

- **Unit tests for the replay step:**
  - forward and backward crossings, with the counter leading and lagging;
  - a pause on the disagreeing frame;
  - a seek in either direction;
  - a first reading inside the band, confirmed by the run;
  - a throw that leaves no readings paired;
  - the −0.00004 fraction.
- **Live step output unchanged:** its existing tests pass unchanged.
- **Unit tests in `@iracedeck/iracing-sdk`:** `rankRaceScores`, and `calculateRacePositions` with output unchanged.
- **Unit tests for `readLapFraction`.**
- **A capture fixture** cut from Niklas's recording around the nine crossings, car 4's pit-lane one included:
  - positive control: the raw ranking blinks at those frames;
  - through the replay step, the camera car never blinks, and no car changes rank for one to four ticks and back.
- **A translator test:** replay ticks through `handleTick`, with `getLiveRacePositions()` read between them, then a live tick after the exit wipe ranking from the live path.
- **Manual:** a saved replay with a Stream Deck+ dial on Replay Control's Cars by Position, played forwards and backwards across several line crossings.
