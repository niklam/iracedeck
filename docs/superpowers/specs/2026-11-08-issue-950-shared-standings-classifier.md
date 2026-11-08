> **Issue:** [#950](https://github.com/niklam/iracedeck/issues/950) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# One standings check for the opponent-pit and opponent-flag diffs

## What the code says today

The issue was filed against #936's `opponent-flags.ts`. #1274 (#1308) and #1559 (#1603) have rewritten that module since, so its claims were checked against `master` at `bfe873059`:

- **The duplication is still there, but it has already drifted.** `opponent-pit.ts`'s `classify()` and `opponent-flags.ts`'s `assess()` both resolve a class-space position (`classPositionFromOrder` in multi-class, the overall rank otherwise), both test same-lap as `|carProgress − playerProgress| < 1.0`, and both screen class first. Their class rules now differ. `classify()` checks class only when `isMultiClass` is true, and rejects an `undefined` class. `assess()` rejects a readable class that differs from the player's in any session, because `isMultiClass` reads false while session info is missing (pinned by "never qualifies a readable different class, even while the session does not read multi-class"). In multi-class it rejects an unreadable class. So when session info is missing and the classes are readable but differ, opponent-pit announces an other-class car as a rival, ranked in overall space, and opponent-flags does not. That is the drift the issue warned about.
- **The fall-through the issue protects no longer exists.** #1274 deleted the `track-ahead` relation: the module header now says there is "deliberately no class-blind or track-relative path". When standings cannot qualify a car, `assess()` returns a held-back **reason**, which the #1273 debug line logs once per (car, flag) episode. The helper therefore has to return a reason, not a `null`.
- **The optional hoist is half done.** `opponent-flags.ts` already resolves the player once per announce pass (`resolvePlayerStanding`, lazily through `player ??=`). The third `classPositionFromOrder` scan on the track-ahead path went with that path. `opponent-pit.ts` still recomputes the player's position inside `classify()`, but `classify()` runs only for a car whose surface moved onto `AproachingPits` this tick, so in practice that is zero or one car per tick.
- **There is a third copy of the projection.** `fastest-lap.ts` (#1571) has a private `effectivePosition()`, which is the same one-line class-space-or-overall choice.
- **The missing-data guards are equivalent.** `classify()` guards the car's `CarIdxLapCompleted` and `CarIdxLapDistPct` with `?? -1`. `assess()` reads them with `?? 0`. Both callers have already rejected a car whose readings are negative or missing (the in-world test before `classify()` at `opponent-pit.ts:207`, and before `assess()` in `qualify`), so neither guard can fire for the car. They differ only for an input no caller passes.
- `handleTick` threads the canonical order into both diffs through `handleOrderSteps` as `canonicalPositions` (the frozen order, or the qualifying grid before the green, per `race-positions.md`). Nothing about that changes here.

## Decision

Create a new pure module, `packages/sim-events-iracing/src/diff/standings.ts`. It owns every rule the two classifiers share: the class screen, the class-space projection, the player's standing, and the same-lap test. Each caller keeps its own relation policy on top of it. The module imports no `TranslatorState`, so the slice guard's rule C has nothing to read, and it consumes the order it is handed. It never computes positions itself (`race-positions.md`).

```typescript
/** Lap-progress scores at least this far apart are on different laps (S/F-crossing safe; raw `CarIdxLap` equality is not). */
export const SAME_LAP_SPAN = 1.0;

/** A car's position in the canonical order: class space in a multi-class race, overall otherwise; `0` when unresolved. */
export function standingPosition(
  positions: number[],
  carClasses: number[] | undefined,
  carIdx: number,
  isMultiClass: boolean,
): number;

/** `CarIdxLapCompleted + CarIdxLapDistPct`, or `null` when either is missing or negative. */
export function lapProgress(telemetry: TelemetryData, carIdx: number): number | null;

/** The player's side of every check, the same for every car on a tick. */
export type PlayerStanding = { pos: number; progress: number | null };

export function resolvePlayerStanding(
  telemetry: TelemetryData,
  positions: number[],
  playerCarIdx: number,
  isMultiClass: boolean,
): PlayerStanding;

/** Why standings cannot place a car against the player. Spelled as opponent-flags' held-back reasons are today. */
export type StandingMiss =
  | "class-unreadable"
  | "different-class"
  | "position-unresolved"
  | "player-progress-unreadable"
  | "car-progress-unreadable"
  | "different-lap";

export type Standing =
  | { reason: null; carPos: number; playerPos: number; placesAhead: number }
  | { reason: StandingMiss; carPos: number; playerPos: number };

export function resolveStanding(
  telemetry: TelemetryData,
  positions: number[],
  player: PlayerStanding,
  playerCarIdx: number,
  carIdx: number,
  isMultiClass: boolean,
): Standing;
```

`resolveStanding` runs its checks in this order, and the first one that fails names the reason:

1. **Class.** In a multi-class session, if either class is unreadable, the reason is `class-unreadable`. In any session, if both classes are readable and they differ, the reason is `different-class`. Readable means `typeof … === "number"`.
2. **Positions.** If `carPos` or `playerPos` is `≤ 0`, the reason is `position-unresolved`.
3. **Player progress.** If `player.progress === null`, the reason is `player-progress-unreadable`.
4. **Car progress.** If `lapProgress(car) === null`, the reason is `car-progress-unreadable`.
5. **Same lap.** If `|car − player| >= SAME_LAP_SPAN`, the reason is `different-lap`.

If every check passes, the result is `placesAhead = playerPos − carPos`, where a positive value means the car is ahead.

A miss still carries `carPos` and `playerPos`, set from step 2 onward and `0` before that. Two callers depend on that. Opponent-flags' debug line needs both positions. Opponent-pit's leader rule needs `carPos`, because that rule is decided after the class screen and before any check on the player.

### "Standings not applicable" is a non-null `reason`

- **Opponent-flags.** `assess()` calls `resolveStanding` and maps a miss straight onto its existing `NotQualified` result, `{ reason, carPos, playerPos, gapSeconds: null }`. `HeldBackReason` becomes `StandingMiss | …the flag-only reasons`, and every existing reason string stays as it is. The ahead window (1–3 places) and the behind window (exactly 1), `needGap`, the race-gap lookup and the range bound stay in `assess()`. Its private `resolvePlayerStanding` and `PlayerStanding` move into the new module unchanged.
- **Opponent-pit.** `classify()` keeps its leader special case and its ±2 window:

```typescript
const s = resolveStanding(telemetry, positions, player, playerCarIdx, carIdx, isMultiClass);

if (s.carPos <= 0) return null;
if (s.carPos === 1) return { relation: "leader", position: 1 }; // no player, same-lap or window check
if (s.reason !== null) return null;
if (s.placesAhead === 1) return { relation: "ahead", position: s.carPos };
if (s.placesAhead === -1) return { relation: "behind", position: s.carPos };
if (s.placesAhead === 2 || s.placesAhead === -2) return { relation: "nearby", position: s.carPos };
return null;
```

- **Fastest lap.** `fastest-lap.ts` deletes `effectivePosition()` and calls `standingPosition()`, which has the same arguments and body. Its policy is untouched.

`car-progress-unreadable` cannot happen from either caller today, because both screen the car's in-world state first. The helper owns the reason anyway, because a pure function should not assume that its caller screened. That also turns `assess()`'s `?? 0` into an explicit refusal.

### The one behaviour change: opponent-pit takes the #1274 class rule

The helper has one class rule, #1274's, and opponent-pit inherits it. Only one case changes: session info is missing (so `isMultiClass` reads false), both classes are readable, and they differ. Opponent-pit used to rank such a car in overall space and could call it "P4 ahead pitting". Now it stays silent, as opponent-flags already does. In every other case the result is identical, including a single-class session without `CarIdxClass`, which still qualifies. No existing `opponent-pit.test.ts` case reaches this path: `makeField()` fills every class with `100`, and the class-split test passes `multi: true`. So the existing suite passes unchanged, and one new case pins the new behaviour.

Rejected alternatives:

- **A class-rule parameter that keeps the old pit behaviour.** It would bring back the two copies as a flag, so the next fix to one rule would again miss the other. The rule this would preserve is the latent bug the extraction exists to prevent.
- **The issue's sketch, `{ carPos, playerPos, sameLap } | null`.** A `null` cannot carry the reason the #1273 held-back line logs. A `sameLap` boolean would also leave each caller to order the lap check against the position check, which is part of what drifted.
- **One helper that also returns the relation.** The windows are policy and they really differ: ±2 with a leader exemption against 1–3 ahead and 1 behind. Folding them in would mean a mode switch per caller.
- **The helper in `@iracedeck/iracing-sdk`, beside `classPositionFromOrder`.** The reason vocabulary is the translator's announce policy, and the SDK holds only the primitive. Keeping the helper in `src/diff/` beside its three callers also keeps #950 independent of #711.

### The player's standing: hoisted per tick inside each diff, not in `handleTick`

Opponent-flags keeps what it already does: `player ??= resolvePlayerStanding(...)` inside the per-car unit, so the player is resolved at most once per pass and only when some car is pending. Opponent-pit takes the same shape. It resolves `player ??=` in `detect` just before `classify()`, so the player is resolved at most once per tick and only on a tick with a qualifying pit entry. The value does not change within a tick and the function is pure, so moving it earlier cannot be observed. The point is a shared signature, not speed: the saving is at most one O(field) walk per tick, and only on a pit-entry tick. If one unit throws, the `??=` has not been assigned, so the next car retries, as it does in opponent-flags now.

Rejected: resolving the player once in `handleOrderSteps` and passing it to both diffs. That would add a new `steps.value` with a stated fallback, grow `TRANSLATOR_REPORTER_MAX_KEYS` and change the `tick-steps.source.test.ts` frame. It would also touch the `translator.ts` region that #711 is respeccing in parallel, and all of that to save one walk on a rare tick.

## Affected artifacts

- **Code.** Add `src/diff/standings.ts`. Edit `src/diff/opponent-pit.ts`: `classify()`, plus the header's *Effective positions* paragraph, which names the shared module. Edit `src/diff/opponent-flags.ts`: `assess()`, the moved `resolvePlayerStanding`, the `HeldBackReason` union, and the header's *Qualification* paragraph ("the #622 `classify` structure" becomes the shared module). Edit `src/diff/fastest-lap.ts`: replace `effectivePosition()`. `translator.ts` does not change, and neither do `TICK_ORDER` or the step boundary.
- **Tests.** Add `src/diff/standings.test.ts`. Add one new case to `opponent-pit.test.ts`. `opponent-flags.test.ts` and `fastest-lap.test.ts` stay unchanged.
- **`packages/sim-events-iracing/CLAUDE.md`.** Add one bullet under *What it owns besides the events*, in the pit-lap-rule shape: the standing of a car against the player (`diff/standings.ts`, #950), shared by opponent-pit, opponent-flags and fastest-lap. A change to the class screen, the projection or the same-lap span is made there.
- **`.claude/rules/race-positions.md`.** In the *Opponent-pit callouts (#622)* and *Opponent-flag callouts (#936)* consumer bullets, replace "uses `classPositionFromOrder` for its class-space relations" with the shared `resolveStanding`, which reads the same order.
- **`.claude/rules/race-engineer-callout-examples.md`.** In the #622 entry, "classifying each transitioning car against the canonical frozen order (`classPositionFromOrder` …)" gains a pointer to `diff/standings.ts` (#950). The #936 entry describes no copied classifier and stays as it is.
- **No changelog fragment.** The only behaviour change covers a car of another class during the ticks before session info resolves, which no user can tell apart. Per `changelog.md`, internal work gets no fragment. There are no plugin, PI, manifest, website or Architecture-page changes, because no package boundary moves.

## Out of scope

- #711: computing the canonical order once per tick and caching it for `getLivePosition` / `getLiveRacePositions`. This spec stays inside `src/diff/`. It reads whatever array `handleOrderSteps` passes in and works the same whether or not #711 lands first.
- Changing any relation window, the leader exemption, the race-gap range, the hold, the cooldowns or the burst aggregation.
- `getLiveCarPosition` in `translator.ts`, which derives overall and class positions for a different purpose and has no class screen.
- Any other `classPositionFromOrder` caller outside `src/diff/`.
- Hoisting the player's standing into `handleTick` (rejected above).

## Testing

- **The existing suites are the spec.** `opponent-flags.test.ts` (67 cases) and `fastest-lap.test.ts` pass with no edit. `opponent-pit.test.ts` (29 cases) passes with no edit to any existing case. Record each suite's test count before and after: the counts must match, plus the one new pit case. A green run alone is not enough.
- **New pit case.** Use `multi: false` and readable classes that differ. A car of the other class entering the pits at an overall rank that would read "ahead" is not announced, and neither is one at overall P1.
- **`standings.test.ts`, table-driven over `resolveStanding`:**
  - each miss, at the step that names it;
  - `carPos` and `playerPos` carried on `position-unresolved` and on later misses, and `0` on a class miss;
  - `placesAhead`'s sign;
  - the class-space projection in multi-class and the overall projection otherwise;
  - single-class with no `CarIdxClass`, which qualifies;
  - multi-class with one unreadable class, which misses;
  - a readable class that differs while `isMultiClass` is false, which misses;
  - the lap boundary: a gap of `0.999` is the same lap, `1.0` is `different-lap`, and a pair straddling S/F (`lc 4 + dp 0.98` against `lc 5 + dp 0.01`) is the same lap;
  - `lapProgress` returning `null` for a missing value and for a negative `CarIdxLapCompleted` or `CarIdxLapDistPct`.
- **`resolvePlayerStanding` and `standingPosition` tests.** The cases now covered only through opponent-flags move here.
- **Positive controls.** These are run once by the implementer and recorded in the PR body, each with the test that failed, then reverted:
  - change `>= SAME_LAP_SPAN` to `>`; the `1.0` boundary case must fail;
  - set `SAME_LAP_SPAN` to `2.0`; the boundary case must fail;
  - replace `lapProgress`'s null guard with `?? 0`; the missing-player-distance case must fail (`player-progress-unreadable` read as the same lap) and the opponent-flags "player-progress-unreadable, not as a different lap" case must fail;
  - restrict the `different-class` check to `isMultiClass`, the old pit rule; the new helper case, the new pit case and opponent-flags' "even while the session does not read multi-class" case must all fail.
- **Gates.** Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm test packages/sim-events-iracing/` and then the full `pnpm test`. The `state-slices` guard must stay green: the new module imports no `TranslatorState`. So must `tick-steps.source.test.ts`, since no call is added to a tick.
- **Manual.** None beyond the suites. This is a refactor with no audible change outside the edge case, and the scenario harness publishes the events directly, bypassing both diffs.
