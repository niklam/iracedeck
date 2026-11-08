# The canonical race order, once per tick

> **Issue:** [#711](https://github.com/niklam/iracedeck/issues/711) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## What the code does today (measured 2026-11-08)

**Sequencing.** This lands after #950 (`docs/superpowers/specs/2026-11-08-issue-950-shared-standings-classifier.md`) merges, and the branch is rebased onto it: #950 moves the standings classification into `src/diff/standings.ts`, whose signatures this change widens.

The issue predates #974's grid phase, #1339's lazy template context and #1559's step boundary, so its count of "three times per tick" is restated here against `master`.

**Inside the tick.** `handleLiveSteps` computes the order once, as the `resolveCanonicalOrder` value step, after `updatePositionTracking`, and hands that one array (`canonicalPositions`) to all six order consumers in `handleOrderSteps`. One more in-tick computation remains: `resolvePlayerIsLeader` (#771) calls `resolveCanonicalOrder` itself in race sessions, deliberately *before* the tracking update, because the checkered winner grace must run ahead of `diffLaps` (#1278).

**Between ticks.** The three public readers recompute on every call: `getLiveRacePositions()` and `getLiveCarPosition(carIdx)` each call `resolveCanonicalOrder` → `calculateCanonicalRacePositions` (a frozen-score sort of up to 64 cars plus an allocation, or a `QualifyResultsInfo` parse pre-green), and `getLivePosition()` goes through `getLiveCarPosition`, so it costs one computation as well. Their callers:

| Reader | Caller | Rate |
| --- | --- | --- |
| `getLiveRacePositions` | template context provider (Telemetry Display, Chat, Race Admin, templated titles) | at most once per tick: the context is cached per tick and asks only when a driver or `session` namespace is read (#1339) |
| `getLivePosition` | Session Info, Position mode | once per refresh per key, ≤ 10 Hz each (`IconUpdateThrottle`), in a race on track past the grid phase |
| `getLiveRacePositions` | Session Info, iRating mode and the session-limit display | once per refresh per key, ≤ 10 Hz each |
| `getLiveRacePositions` | Camera Controls and Replay Control dials (`resolveRaceOrder`) | once per carousel render and per detent |
| `getLivePosition` / `getLiveCarPosition` | Race Engineer (`race-engineer-wiring` → `audio-scenarios`) | event-driven, not per tick: a position-family expansion reads `getLivePosition` two or three times (speak gate plus vocabulary), an opponent-pit, opponent-flag or fastest-lap expansion `getLiveCarPosition` once |
| both | `readSimState` (Telemetry Snapshot) | two per snapshot |

So a race with a Telemetry Display and k Session Info position keys computes the order about 60 (tick) + 60 (leader) + 60 (template) + 10k times a second, plus the callouts.

**Do the readers disagree with the tick?** Not in value, today. `calculateCanonicalRacePositions` is pure; its inputs are the latest telemetry, the session-info object, `TranslatorState`'s two anchor fields and the derived `isRaceSession`; and the anchors change in place only inside `updatePositionTracking`, which precedes the tick's own computation. A reader between ticks therefore recomputes the same array the diffs saw. The exceptions are a reader running *inside* the tick before the tracking update (a pre-guard `publishNow` subscriber, the replay-entry teardown's subscribers) and the tick's `isRaceSession` falling back to its last value when `resolveSessionType` throws. The problem #711 names is real as cost and as a missing guarantee — "the same frame" holds by coincidence of inputs, not by construction — rather than as a present wrong answer.

## Decision

### 1. Option A: memoise the tick's order on the translator instance

The readers return the order the tick computed, through one memo on `TranslatorInstance`, beside `paceLineupMemo` and `cautionGapMemo` (#1127, #1168), whose pattern it follows:

```typescript
/**
 * The canonical order last resolved, keyed on the identity of every input it
 * was computed from (#711). `handleLiveSteps` writes it from its own order
 * step; `readCanonicalOrder` reuses it on a key match and otherwise computes
 * and stores. `null` until first resolved and after a disconnect.
 *
 * Invariant: the key catches a replaced state object, never an in-place
 * write. `positionLastKnownScores` and `positionFrozen` are written in place
 * only by `updatePositionTracking`, before the order step writes this memo;
 * any other writer of the order's inputs must set the memo to `null`.
 */
canonicalOrderMemo: {
  telemetry: TelemetryData;
  sessionInfo: Record<string, unknown> | null;
  state: TranslatorState;
  positions: readonly number[];
} | null;
```

- **Key: identity of telemetry, session info and `self.state`, not `SessionTick`.** The SDK builds a fresh telemetry object per frame and hands back the same parsed session-info object until the YAML changes — the same argument `paceLineupMemo` rests on — so a matching pair means matching inputs. `self.state` is in the key because every reset (`handleDisconnect`, `resetPerSessionState`, `wipeStateForReplay`) replaces the state object rather than clearing it, so a reset invalidates the memo with no code at the reset sites. `SessionTick` is rejected as the key: it repeats on a paused replay frame and restarts across sessions, and it says nothing about the anchors or the session info.
- **The invariant the key rests on is written down.** Identity catches whole-state replacement, not an in-place write to the order's inputs. Today the two anchor fields are written in place only by `updatePositionTracking`, before the order step, so the tick's write always follows the last change. The `canonicalOrderMemo` JSDoc states that invariant: any other writer of `positionLastKnownScores` or `positionFrozen` must clear the memo. A one-line cross-reference beside `updatePositionTracking` (`diff/race-finish.ts`) points back to it. This matters more over time because #1588's slice rules make in-place clearing the norm (`Object.assign(slice, create<Family>State())`, never a new object). If the anchors move into a slice, or a new reset clears them in place, the state object keeps its identity and a stale memo would match.
- **The tick writes, unconditionally, after the tracking update.** Once the `resolveCanonicalOrder` step returns, the frame assigns the memo from `order.value` with this tick's telemetry, session info and state. That overwrites any entry a mid-tick reader stored from pre-tracking anchors for the same telemetry object. When the step is skipped or throws (`!order.ok`, #1559 decision 3), the frame sets the memo to `null`, so no pre-tracking entry survives and a reader recomputes, exactly as it does today. Both are plain assignments in the frame, not calls, so `tick-steps.source.test.ts` and `TRANSLATOR_REPORTER_MAX_KEYS` are unchanged: the step id stays `translator:resolveCanonicalOrder`.
- **One private lazy reader.** `readCanonicalOrder(self)` (in `translator.ts`) returns the memo on a key match against `latestTelemetry`, the current `getSessionInfo()` and `self.state`; otherwise it calls `resolveCanonicalOrder` and stores the result. `getLiveRacePositions` returns it; `getLiveCarPosition` (and so `getLivePosition`) indexes it; `readSimState` already goes through `getLiveRacePositions`. `resolveCanonicalOrder` stays the one caller of `calculateCanonicalRacePositions`.
- **`resolvePlayerIsLeader` keeps its own computation** and never reads or writes the memo. It runs before `updatePositionTracking`, by #1278's ordering, so its order is the one-tick-stale-anchors order the code documents; storing it would let a between-tick reader see it, and reading the previous tick's memo instead would change which telemetry it ranks.

What the readers return in each phase:

| Phase | Return |
| --- | --- |
| Before the first tick, after a disconnect | `null`, as today: `latestTelemetry` is `null`. `handleDisconnect` also sets the memo to `null`, so it holds no old telemetry |
| A live tick, between ticks | the array the tick's six order consumers received — the same object |
| A replay tick (the guard returns before the order step) | computed on the first read of that frame and shared by every later read of it: the plain lap-progress order, or the grid pre-green, as today (`getLiveRacePositions`' replay note stays true) |
| A session-change tick | the order from the fresh state: the reset replaces `self.state` before the order step, so the key cannot match an older entry |
| A tick whose order step threw | recomputed per frame on read, as today |

### 2. The shared array is frozen and typed `readonly`

After A, the array a reader gets is shared: the tick's diffs hold it, and `diffOvertakes` keeps it as `state.lastFrozenPositions`, its baseline for the next tick. Today every reader gets a private copy, so a consumer's write is harmless; after A it would silently corrupt the next tick's overtake detection. No consumer writes to it today (searched across `packages/*/src`), so the protection costs nothing:

- `resolveCanonicalOrder` returns `readonly number[]`: `Object.freeze(...)` of what `calculateCanonicalRacePositions` built. A write then throws a `TypeError` in the repo's strict-mode ES modules rather than corrupting state. A copy per read is rejected: it allocates on every call, which is half of what this issue removes, and still lets the tick's diffs and the readers see different objects.
- **The order is `readonly number[]` everywhere it travels, in this change**, so the freeze needs no `as number[]` cast anywhere and the compiler catches a write before the runtime does. Widening a parameter to `readonly` breaks no caller. The places:
  - **Translator.** `resolveCanonicalOrder`'s return type, `OrderStepValues.canonicalPositions` (`translator.ts:3412`), `resolveLeaderLapTimeS` (1773), the order parameters at 1847 and `fuelLeaderFinish` (2147), the public `getLiveRacePositions(): readonly number[] | null`, and `state.lastFrozenPositions` (`state.ts:1530`). `resolveLeaderFinish` (`leader-finish.ts`) and `SimState.order.positions` (`sim-state.ts`) follow.
  - **`src/diff/`.** Every order parameter: `caution.ts` (925, 949, 1042, 1393), `gaps.ts` (390), `leader-white.ts` (122), `opponent-flags.ts` (406, 469, 588), `opponent-pit.ts` (87, 159) and `overtakes.ts` (136, 475, 547). #950's new `standingPosition`, `resolvePlayerStanding` and `resolveStanding` in `diff/standings.ts`, which `fastest-lap.ts` reaches through `standingPosition`, also take the readonly array. Line numbers are `master`'s at 2026-11-08 and will move on the rebase onto #950; `pnpm typecheck` finds any order parameter the list misses.
  - **`@iracedeck/iracing-sdk`.** `classPositionFromOrder`, `findDriverByRacePosition`, `resolveClassNeighbors`, `resolveIRatingEstimateOrder` (its `liveOrder` and return), `estimateIRatingChanges`' `order`, `LivePositionsSource`, and `SDKController`'s provider and `getLiveRacePositions`.
  - **`iracing-actions`.** `computeRacePositionTarget`, `carIdxAtPosition`, `carNumberRawAtPosition`, `resolveRaceOrder`, and the dial hosts' `getRacePositions` / `racePositions`.

### 3. One class-position policy: `classPositionOrOfficial`

`getLivePosition` and the template's `resolveClassPosition` each implement "derive class position from the order, else iRacing's official counter". They agree on every real input and differ in one edge, which the shared helper settles. It goes in `@iracedeck/iracing-sdk` `position-utils.ts` beside `classPositionFromOrder`, exported from the package index:

```typescript
/**
 * A car's class position: derived from the canonical order when the order and
 * the car's class are known, else the official counter. 0 = unknown.
 */
export function classPositionOrOfficial(
  order: readonly number[] | null | undefined,
  carIdxClass: number[] | undefined,
  carIdx: number,
  official: number | undefined,
): number;
```

- **No order** → `official` when it is a positive number, else `0`.
- **An order, and the car's class id is known** (`carIdxClass[carIdx] !== undefined`) → `classPositionFromOrder`, and nothing else: a car the order does not rank reads `0` (blank), never the official counter. That is `race-positions.md`'s "an order is authoritative".
- **An order, and the car's class id is not known** (no `CarIdxClass`, or an array without that car's entry) → `official` when positive, else `0`: the class cannot be derived, which is not the same as the car being absent.
- **The official source stays the caller's.** `getLivePosition` passes `PlayerCarClassPosition`, the template `CarIdxClassPosition[carIdx]`, as each does today; unifying them would be a behaviour change.

`getLivePosition` calls it with the memoised order; `resolveClassPosition` in `template-context.ts` becomes a one-line call mapping `0` to `undefined`. `getLiveCarPosition` deliberately does not use it: it has no official fallback by design, and its consumers fall back to their emit-time payload.

**The edge it settles.** With a `CarIdxClass` array that lacks the car's entry, `getLivePosition` falls back to `PlayerCarClassPosition` today while the template renders blank. The helper takes `getLivePosition`'s answer. Real telemetry cannot reach it — `CarIdxClass` is a 64-slot array and a car index is below 64 — so no key or callout changes; only a test fixture with a short array could see the difference, and the helper's own test pins the chosen answer.

## Alternatives rejected

- **Option B, a "running order changed" bus event.** It removes no pull reader. The Race Engineer reads the position at speak time on purpose, so a callout played seconds after its trigger says the position now; Session Info, the template and the dials render on their own clocks. Each would keep a cache of the event, which is N copies of the order, each with its own reset to get wrong at a session change, a replay and a disconnect, where A has one memo whose key resets itself. The bus also goes silent in a replay — the guard suppresses every live event — yet the camera and replay dials need the order there, so B would need an exception to the guard or a second path. The catalog is a sim-neutral published contract reviewed at `xhigh`; a `carIdx`-indexed array is an iRacing shape to put in it for a cache's sake. And the grid-to-live handover at the green is an order change every consumer is deliberately silent about (#647), so a semantic "changed" event would have to explain itself there too.
- **Caching on `TranslatorState`, as the issue suggests.** The memo is keyed on the state object, so it cannot live inside it; a member there would also be a slice under #1588's guard and appear a second time in every Telemetry Snapshot's `raw.state`. The instance is where the two existing per-frame memos live.
- **Memoising on telemetry identity alone.** A replay-entry teardown subscriber can read the order before `wipeStateForReplay` on the same telemetry object; keyed on telemetry only, readers would then see the pre-wipe order until the next tick, where today they see the wiped one.
- **Moving `updatePositionTracking` ahead of `diffLifecycle`** so the leader check could read the memo. It would remove the last duplicate computation but changes which anchors the winner grace ranks by, and with it the `TICK_ORDER` reasoning #1278 depends on — a behaviour change, out of this issue.

## Out of scope

- Any change to what a key shows or a callout says, including Session Info's own phase polish (the grid held to the line, the official counters on pit road, the finish result).
- `resolvePlayerIsLeader`'s pre-tracking computation (above).
- An official fallback in `getLiveCarPosition`, and unifying `PlayerCarClassPosition` with `CarIdxClassPosition`.
- The template context's own per-tick cache (#1339), unchanged; it now simply receives the memoised array.
- A bus event for the order (Option B).

## Affected artifacts

- `packages/sim-events-iracing/src/translator.ts`: `canonicalOrderMemo` with its invariant JSDoc, `readCanonicalOrder`, the frame's write and clear after the order step, the clear in `handleDisconnect`, the freeze and readonly return in `resolveCanonicalOrder`, `getLivePosition` on the helper, the readonly types, and the readers' JSDoc (drop "computed … at the exact moment the caller asks"). `src/state.ts` (`lastFrozenPositions`), `src/sim-state.ts` and `src/leader-finish.ts` need the readonly types.
- `packages/sim-events-iracing/src/diff/`: the readonly order parameters in `caution.ts`, `gaps.ts`, `leader-white.ts`, `opponent-flags.ts`, `opponent-pit.ts`, `overtakes.ts` and #950's `standings.ts`. `race-finish.ts` gets the one-line cross-reference beside `updatePositionTracking`.
- `packages/iracing-sdk/src/position-utils.ts` (+ `index.ts`), `template-context.ts`, `SDKController.ts`, `irating-utils.ts`, `gap-utils.ts`: the helper and the readonly widening.
- `packages/iracing-actions/src/shared/race-position-cycling.ts` and the Camera Controls and Replay Control dial host types — readonly widening.
- Tests, below.
- `.claude/rules/race-positions.md` — *The canonical source*: the readers return the tick's memoised order, frozen and `readonly`, and only `readCanonicalOrder` and the leader check call `resolveCanonicalOrder`; the class-position paragraph names `classPositionOrOfficial` as the one derive-else-official policy.
- `packages/sim-events-iracing/CLAUDE.md` — the canonical-order bullet names `translator.ts` (it says `race-order.ts`, which holds only the source choice) and the memo in one clause.
- No website Architecture page change (no seam, event or package boundary moves), no changelog fragment (no user-visible change).

## Testing

Behaviour must not move, so the proof is that every existing reader test passes unchanged, plus new tests that pin the memo's guarantees and are seen failing first.

**Unchanged and green** — `translator.test.ts` (`getLivePosition`, including "falls back to PlayerCarClassPosition when CarIdxClass is unavailable"; `getLiveCarPosition`; `getLiveRacePositions`; "pre-green grid order (issue #974)"), `race-order.test.ts`, `sim-state.test.ts`, `translator-step-isolation.test.ts`, `tick-order.test.ts`, `tick-steps.source.test.ts`, `replay-recorder.equivalence.test.ts` (the bus stream is the golden's), `template-context.test.ts` (`class_position` cases), `SDKController.test.ts`, `position-utils.test.ts`, `session-info.test.ts`, `camera-controls.test.ts`, `pit-crew-deps.test.ts`, `sim-runtime.test.ts`, and the `audio-scenarios` `position`, `race-status`, `overtake`, `caution` and `fastest-lap` tests. `pnpm typecheck` covers the readonly widening.

**New, in `translator.test.ts` (`describe("canonical order memo (#711)")`)**:

1. **Once per tick.** Spy `calculateCanonicalRacePositions` (a pass-through `vi.mock` of `./race-order.js`); one live race tick, then five reads across `getLiveRacePositions`, `getLivePosition` and `getLiveCarPosition`: the count is 2 (the order step and the leader check), not 7. Written first and seen failing on `master`'s code at 7 — the positive control that the counter counts reads.
2. **Same frame.** The array `getLiveRacePositions()` returns is the object the tick's order step computed (`toBe` against the spy's recorded result for that call, not the leader check's) and the one `readSimState().order.positions` reports.
3. **Fresh per tick.** A second tick with a changed order returns the new order; a session-info object swapped between ticks forces a recompute (the count rises), as does a reset.
4. **Resets.** A car frozen before a session change, a replay wipe or a disconnect-and-reconnect is not frozen in the order read after it.
5. **Failure.** With `updatePositionTracking` throwing (`onStepError: "report"`), a mid-tick read from a `session.changed` subscriber does not survive the tick: the between-tick read equals a fresh `calculateCanonicalRacePositions` on the post-tick state.
6. **Replay.** Two reads of one replay frame compute once and equal the plain lap-progress order.
7. **Frozen.** `Object.isFrozen(getLiveRacePositions())`, and an indexed write throws `TypeError`.

**Equivalence over a capture.** Its description names the invariant it guards: the anchors are written in place only by `updatePositionTracking`, before the memo is written. Drive a `src/diff/__fixtures__/` capture in which a car freezes (a tow or a finish) through the translator and assert, on every tick, that `getLiveRacePositions()` deep-equals a fresh `calculateCanonicalRacePositions` on that tick's inputs. Positive control: seed the memo before `updatePositionTracking` in a scratch edit and see the test fail on the freezing tick, then revert.

**New, in `position-utils.test.ts`** — `classPositionOrOfficial`: no order → official; a non-positive official → `0`; order with class → derived; a car the order does not rank → `0` with a positive official (the order is authoritative); no `CarIdxClass` → official; a `CarIdxClass` lacking the car's entry → official (the settled edge).

**Manual.** None for Niklas beyond a sanity look, since nothing user-visible moves: in a race, Session Info Position (overall and class), a Telemetry Display with `race_ahead` / `self.class_position`, and a Race Engineer position callout read as before.
