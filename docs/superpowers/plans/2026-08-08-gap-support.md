# Gap Support (Session Info mode + Race Engineer callouts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement issue #933 — live time gaps to the class-standings neighbors (car one class position ahead/behind), shown on a new Session Info "Gaps" mode with trend colors and announced by the Race Engineer on trend flips and threshold crossings.

**Architecture:** A crossing-time trace engine: every car's `lapCompleted + lapDistPct` progress is recorded against `SessionTime` in a rolling ~1.15-lap trace; the gap between two cars is the time difference between their crossings of the same track position (interpolated). Pure math (neighbor resolution, trace interpolation, trend classification) lives in `@iracedeck/iracing-sdk`; the stateful trace store, live-gap accessors (`getLiveGaps()` + the reusable `getLiveGapBetween(aheadCarIdx, behindCarIdx)`), and the trend/threshold event emitter live in a new `diff/gaps.ts` module in `@iracedeck/sim-events-iracing`. Two new bus events (`gap.trendChanged`, `gap.thresholdCrossed`) drive a new `gap` callout family in `@iracedeck/audio-scenarios`.

**Tech Stack:** TypeScript, Zod, Vitest, pnpm/turbo monorepo. No new dependencies.

## Global Constraints

- Issue #933 is the spec. Accuracy target ~±0.1 s via crossing-time traces; `CarIdxEstTime` is cold-start fallback only; forward-only gap math (never a ±half-lap wrap); explicit pace-car exclusion; two-sided suppression; trend has two bases (continuous for display, lap-over-lap for callouts).
- Race positions MUST come from the canonical order (`calculateFrozenRacePositions` via the translator) — never recompute or blend with `CarIdxPosition` (`.claude/rules/race-positions.md`). Add the new consumer to that rule's list.
- New Race Engineer functionality defaults ON (`calloutEnabledGap*` default `true`).
- Every new `GlobalSettingsSchema` plain-value field ends in `.catch(<default>)` (#896). After schema changes run `pnpm build --force` (turbo caches deck-core) and update BOTH `simhub-service.test.ts` literals.
- Settings: `calloutEnabledGapTrend`, `calloutEnabledGapThreshold` (booleans, default true), `gapAlertThresholdSeconds` (0.5–3.0, default 1.0), `gapCalloutCooldownSeconds` (1–360, default 30).
- Conventional commits, issue ref `(#933)` in PR title, one commit per task. Run `pnpm lint:fix` + `pnpm format:fix` before each commit. No watcher — build manually.
- All three plugins (`iracing-plugin-stream-deck`, `iracing-plugin-mirabox`, `iracing-plugin-ulanzi`) update in lockstep for `registerPitCrew` and translator-options wiring.
- Voice-line generation is gated on a user checkpoint (scoped dry-run of wordings first). `.env.local` must be copied from the master checkout.
- Never reference any external project in code, comments, docs, or commits.
- Working dir: `C:/Users/Niklas/Projects/iRaceDeck/ir-933` (shell cwd resets between commands — always `cd` first or use absolute paths).

---

### Task 1: Pure gap primitives in `@iracedeck/iracing-sdk`

**Files:**
- Create: `packages/iracing-sdk/src/gap-utils.ts`
- Create: `packages/iracing-sdk/src/gap-utils.test.ts`
- Modify: `packages/iracing-sdk/src/index.ts` (add exports)

**Interfaces:**
- Consumes: nothing new (`TelemetryData` from `./types.js`).
- Produces (all exported, used by Tasks 3/4/9):
  - `type ProgressSample = { progress: number; time: number }`
  - `type ProgressTrace = ProgressSample[]`
  - `GAP_TRACE_SPAN_LAPS = 1.15`, `GAP_TRACE_MIN_STEP = 0.002`
  - `appendProgressSample(trace: ProgressTrace, progress: number, time: number): void`
  - `crossingTimeAt(trace: ProgressTrace, progress: number): number | null`
  - `type StandingsNeighbors = { aheadIdx: number; behindIdx: number; leaderIdx: number }` (−1 = none)
  - `resolveClassNeighbors(positions: number[], carIdxClass: number[] | undefined, carIdx: number, excludeIdx?: number | null): StandingsNeighbors`
  - `type GapTrendDirection = "closing" | "opening" | "steady"`
  - `classifyGapTrend(deltaSeconds: number | null, deadbandSeconds: number): GapTrendDirection | null`
  - `lapDeltaBetween(progressAhead: number, progressBehind: number): number`

- [ ] **Step 1: Write failing tests** in `packages/iracing-sdk/src/gap-utils.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  appendProgressSample,
  classifyGapTrend,
  crossingTimeAt,
  GAP_TRACE_MIN_STEP,
  GAP_TRACE_SPAN_LAPS,
  lapDeltaBetween,
  type ProgressTrace,
  resolveClassNeighbors,
} from "./gap-utils.js";

describe("appendProgressSample", () => {
  it("appends monotonically advancing samples and skips sub-step advances", () => {
    const trace: ProgressTrace = [];
    appendProgressSample(trace, 5.0, 100);
    appendProgressSample(trace, 5.001, 100.1); // < GAP_TRACE_MIN_STEP advance — skipped
    appendProgressSample(trace, 5.003, 100.3);

    expect(trace).toEqual([
      { progress: 5.0, time: 100 },
      { progress: 5.003, time: 100.3 },
    ]);
  });

  it("clears the trace on a backwards jump (tow/teleport/session reset)", () => {
    const trace: ProgressTrace = [];
    appendProgressSample(trace, 5.0, 100);
    appendProgressSample(trace, 4.2, 20); // progress went backwards by > MIN_STEP

    expect(trace).toEqual([{ progress: 4.2, time: 20 }]);
  });

  it("prunes samples older than GAP_TRACE_SPAN_LAPS behind the head", () => {
    const trace: ProgressTrace = [];

    for (let p = 0; p <= 1.5; p += 0.01) {
      appendProgressSample(trace, p, p * 90);
    }

    expect(trace[0]!.progress).toBeGreaterThanOrEqual(1.5 - GAP_TRACE_SPAN_LAPS - 0.011);
    expect(trace[trace.length - 1]!.progress).toBeCloseTo(1.5, 5);
  });
});

describe("crossingTimeAt", () => {
  const trace: ProgressTrace = [
    { progress: 2.0, time: 180.0 },
    { progress: 2.1, time: 189.0 },
    { progress: 2.2, time: 198.0 },
  ];

  it("interpolates linearly between bracketing samples", () => {
    // Halfway between 2.1 (189 s) and 2.2 (198 s) → 193.5 s
    expect(crossingTimeAt(trace, 2.15)).toBeCloseTo(193.5, 6);
  });

  it("returns the exact sample time at a sample point", () => {
    expect(crossingTimeAt(trace, 2.1)).toBeCloseTo(189.0, 6);
  });

  it("returns null outside the trace span (never extrapolates)", () => {
    expect(crossingTimeAt(trace, 1.99)).toBeNull();
    expect(crossingTimeAt(trace, 2.21)).toBeNull();
    expect(crossingTimeAt([], 2.0)).toBeNull();
  });
});

describe("resolveClassNeighbors", () => {
  // positions: carIdx → 1-based overall rank (0 = unclassified)
  // classes:   carIdx → class id
  // Field: idx0=P3 cls10 (player), idx1=P1 cls10, idx2=P2 cls20, idx3=P4 cls10, idx4=P5 cls20
  const positions = [3, 1, 2, 4, 5];
  const classes = [10, 10, 20, 10, 20];

  it("resolves class neighbors skipping other-class cars", () => {
    const n = resolveClassNeighbors(positions, classes, 0);

    expect(n.aheadIdx).toBe(1); // P1 is the class-10 car directly ahead in class standings
    expect(n.behindIdx).toBe(3); // P4 is class-10 directly behind
    expect(n.leaderIdx).toBe(1);
  });

  it("returns -1 for a missing neighbor (class leader / last in class)", () => {
    const n = resolveClassNeighbors(positions, classes, 1); // player is class leader

    expect(n.aheadIdx).toBe(-1);
    expect(n.leaderIdx).toBe(1); // the leader of your class is yourself when you lead
    expect(n.behindIdx).toBe(0);
  });

  it("excludes the pace car index explicitly", () => {
    // Pace car idx1 would otherwise be the class-10 car ahead
    const n = resolveClassNeighbors(positions, classes, 0, 1);

    expect(n.aheadIdx).toBe(-1);
    expect(n.leaderIdx).toBe(0); // best-ranked non-excluded class-10 car is the player
  });

  it("returns all -1 when the player is unclassified or class data is missing", () => {
    expect(resolveClassNeighbors([0, 1], [10, 10], 0)).toEqual({ aheadIdx: -1, behindIdx: -1, leaderIdx: -1 });
    expect(resolveClassNeighbors(positions, undefined, 0)).toEqual({ aheadIdx: -1, behindIdx: -1, leaderIdx: -1 });
  });
});

describe("classifyGapTrend", () => {
  it("classifies by sign outside the deadband", () => {
    expect(classifyGapTrend(-0.5, 0.2)).toBe("closing");
    expect(classifyGapTrend(0.5, 0.2)).toBe("opening");
    expect(classifyGapTrend(0.1, 0.2)).toBe("steady");
    expect(classifyGapTrend(-0.2, 0.2)).toBe("steady"); // boundary is inclusive-steady
  });

  it("returns null for null/non-finite input", () => {
    expect(classifyGapTrend(null, 0.2)).toBeNull();
    expect(classifyGapTrend(Number.NaN, 0.2)).toBeNull();
  });
});

describe("lapDeltaBetween", () => {
  it("is 0 for same-lap cars and counts whole laps otherwise", () => {
    expect(lapDeltaBetween(5.8, 5.2)).toBe(0);
    expect(lapDeltaBetween(6.3, 5.2)).toBe(1);
    expect(lapDeltaBetween(7.1, 5.2)).toBe(1); // 1.9 laps ahead → floor = 1
    expect(lapDeltaBetween(8.2, 5.2)).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /c/Users/Niklas/Projects/iRaceDeck/ir-933 && pnpm exec vitest run packages/iracing-sdk/src/gap-utils.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `packages/iracing-sdk/src/gap-utils.ts`:

```typescript
/**
 * Pure gap-math primitives (issue #933): crossing-time traces, class-standings
 * neighbor resolution, and trend classification. Stateless — the rolling trace
 * store that OWNS the arrays lives in the sim translator's state; these
 * functions only read/append.
 *
 * The gap model is forward-only: the gap from a chasing car to the car ahead
 * is "how long ago did the car ahead cross the chaser's current position",
 * read from the ahead car's progress→time trace. There is deliberately no
 * ±half-lap wrapping delta anywhere in this module — a wrap-relative delta
 * returns the complement (a plausible-looking, wrong number) whenever the
 * standings neighbor is more than half a lap away on track.
 */

/** One recorded point of a car's progress (laps, `lapCompleted + lapDistPct`) at a session time (s). */
export type ProgressSample = { progress: number; time: number };

/** Rolling per-car trace, ascending by progress. Owned by translator state. */
export type ProgressTrace = ProgressSample[];

/** How much history each trace keeps, in laps. Covers same-lap gaps plus margin. */
export const GAP_TRACE_SPAN_LAPS = 1.15;

/**
 * Minimum progress advance between recorded samples, in laps. 0.002 lap is
 * ~12 m on a 6 km track — linear interpolation between samples this close is
 * comfortably inside the ±0.1 s accuracy target at racing speeds.
 */
export const GAP_TRACE_MIN_STEP = 0.002;

/**
 * Append a progress sample to a trace, keeping it ascending and pruned to
 * {@link GAP_TRACE_SPAN_LAPS}. A backwards progress jump (tow, teleport,
 * session reset) resets the trace — stale pre-jump samples would lie about
 * crossing times.
 */
export function appendProgressSample(trace: ProgressTrace, progress: number, time: number): void {
  const last = trace.length > 0 ? trace[trace.length - 1]! : null;

  if (last !== null) {
    if (progress < last.progress - GAP_TRACE_MIN_STEP) {
      trace.length = 0;
    } else if (progress - last.progress < GAP_TRACE_MIN_STEP) {
      return;
    }
  }

  trace.push({ progress, time });

  const minProgress = progress - GAP_TRACE_SPAN_LAPS;
  let drop = 0;

  while (drop < trace.length - 1 && trace[drop]!.progress < minProgress) drop++;

  if (drop > 0) trace.splice(0, drop);
}

/**
 * Session time (s) at which the traced car crossed `progress`, linearly
 * interpolated between the bracketing samples. `null` when the trace doesn't
 * cover the point — callers fall back (cold start) rather than extrapolate.
 */
export function crossingTimeAt(trace: ProgressTrace, progress: number): number | null {
  if (trace.length === 0) return null;

  if (progress < trace[0]!.progress || progress > trace[trace.length - 1]!.progress) return null;

  // Binary search for the last sample with sample.progress <= progress.
  let lo = 0;
  let hi = trace.length - 1;

  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;

    if (trace[mid]!.progress <= progress) lo = mid;
    else hi = mid - 1;
  }

  const a = trace[lo]!;

  if (a.progress === progress || lo === trace.length - 1) return a.time;

  const b = trace[lo + 1]!;
  const span = b.progress - a.progress;

  if (span <= 0) return a.time;

  return a.time + ((progress - a.progress) / span) * (b.time - a.time);
}

/** Class-standings neighbor car indices; `-1` = no such car. */
export type StandingsNeighbors = {
  /** Car one class position ahead of `carIdx` (best-ranked same-class car worse than none). */
  aheadIdx: number;
  /** Car one class position behind `carIdx`. */
  behindIdx: number;
  /** Best-ranked car in the player's class (the player itself when leading). */
  leaderIdx: number;
};

const NO_NEIGHBORS: StandingsNeighbors = { aheadIdx: -1, behindIdx: -1, leaderIdx: -1 };

/**
 * Resolve the player's class-standings neighbors from the canonical order.
 *
 * `positions` is the 1-based overall rank array indexed by carIdx (`0` =
 * unclassified) — always the canonical live order per
 * `.claude/rules/race-positions.md`, never a local recomputation. Class
 * membership comes from `CarIdxClass`. `excludeIdx` removes the pace car
 * explicitly — the canonical order itself carries no pace-car filter, so
 * relying on class-id conventions alone is not a guarantee (issue #933).
 */
export function resolveClassNeighbors(
  positions: number[],
  carIdxClass: number[] | undefined,
  carIdx: number,
  excludeIdx?: number | null,
): StandingsNeighbors {
  if (!Array.isArray(carIdxClass)) return { ...NO_NEIGHBORS };

  if (carIdx < 0 || carIdx >= positions.length) return { ...NO_NEIGHBORS };

  const myRank = positions[carIdx];

  if (myRank === undefined || myRank <= 0) return { ...NO_NEIGHBORS };

  const myClass = carIdxClass[carIdx];

  if (myClass === undefined) return { ...NO_NEIGHBORS };

  let aheadIdx = -1;
  let aheadRank = -1;
  let behindIdx = -1;
  let behindRank = Number.POSITIVE_INFINITY;
  let leaderIdx = carIdx;
  let leaderRank = myRank;

  for (let i = 0; i < positions.length; i++) {
    if (i === carIdx || i === excludeIdx) continue;

    const rank = positions[i];

    if (rank === undefined || rank <= 0 || carIdxClass[i] !== myClass) continue;

    if (rank < myRank && rank > aheadRank) {
      aheadRank = rank;
      aheadIdx = i;
    }

    if (rank > myRank && rank < behindRank) {
      behindRank = rank;
      behindIdx = i;
    }

    if (rank < leaderRank) {
      leaderRank = rank;
      leaderIdx = i;
    }
  }

  return { aheadIdx, behindIdx, leaderIdx };
}

/** Direction the gap is moving. "closing" = shrinking, "opening" = growing. */
export type GapTrendDirection = "closing" | "opening" | "steady";

/**
 * Classify a gap change (seconds; negative = the gap shrank) against a
 * deadband. Returns `null` for missing/non-finite input so callers can
 * distinguish "no data" from "steady".
 */
export function classifyGapTrend(deltaSeconds: number | null, deadbandSeconds: number): GapTrendDirection | null {
  if (deltaSeconds === null || !Number.isFinite(deltaSeconds)) return null;

  if (deltaSeconds < -deadbandSeconds) return "closing";

  if (deltaSeconds > deadbandSeconds) return "opening";

  return "steady";
}

/**
 * Whole laps the ahead car is up on the behind car (`0` = same racing lap).
 * Uses total progress (`CarIdxLapCompleted + CarIdxLapDistPct`) — note
 * `CarIdxLap` differs from `CarIdxLapCompleted` by one at the line; the
 * position primitive and this module both use `LapCompleted`.
 */
export function lapDeltaBetween(progressAhead: number, progressBehind: number): number {
  return Math.max(0, Math.floor(progressAhead - progressBehind));
}
```

- [ ] **Step 4: Export from the package index.** In `packages/iracing-sdk/src/index.ts`, add to the existing export block (alphabetical position):

```typescript
export {
  appendProgressSample,
  classifyGapTrend,
  crossingTimeAt,
  GAP_TRACE_MIN_STEP,
  GAP_TRACE_SPAN_LAPS,
  type GapTrendDirection,
  lapDeltaBetween,
  type ProgressSample,
  type ProgressTrace,
  resolveClassNeighbors,
  type StandingsNeighbors,
} from "./gap-utils.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /c/Users/Niklas/Projects/iRaceDeck/ir-933 && pnpm exec vitest run packages/iracing-sdk/src/gap-utils.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Lint, format, commit**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-933 && pnpm lint:fix && pnpm format:fix
git -C /c/Users/Niklas/Projects/iRaceDeck/ir-933 add packages/iracing-sdk docs/superpowers/plans
git -C /c/Users/Niklas/Projects/iRaceDeck/ir-933 commit -m "feat(sdk): add pure crossing-time gap primitives (#933)"
```

---

### Task 2: `gap.trendChanged` / `gap.thresholdCrossed` events + harness event templates

**Files:**
- Modify: `packages/event-bus/src/event-catalog.ts` (two `SimEventMap` entries + one exported type)
- Modify: `packages/event-bus/src/index.ts` (export `GapSide` type)
- Modify: `packages/scenario-harness/src/event-names.ts` (two `EVENT_TEMPLATES` entries — the compile-time exhaustiveness check fails the build without them)

**Interfaces:**
- Produces: `type GapSide = "ahead" | "behind"` (exported from `@iracedeck/event-bus`); events `gap.trendChanged` with data `{ side: GapSide; direction: "closing" | "opening"; gapSeconds: number; previousGapSeconds: number; carIdx: number; lap: number }` and `gap.thresholdCrossed` with data `{ side: GapSide; gapSeconds: number; thresholdSeconds: number; carIdx: number }`.

- [ ] **Step 1: Add the catalog entries.** In `packages/event-bus/src/event-catalog.ts`, near the other shared enums (by `RadarState`), add:

```typescript
/** Which standings neighbor a gap event refers to (issue #933). */
export type GapSide = "ahead" | "behind";
```

In `SimEventMap`, after the `position.changed` entry, add:

```typescript
  /**
   * The lap-over-lap gap trend to a class-standings neighbor flipped
   * direction and held for 2 consecutive laps (issue #933). Emitted from the
   * gap diff at the player's lap completion; race sessions only, never for a
   * neighbor a lap or more apart, and suppressed while either car is on pit
   * road or off track. `gapSeconds` is the crossing-time gap at emission;
   * spoken numbers should read the LIVE gap at speak time instead (#574
   * pattern).
   */
  "gap.trendChanged": SimEvent<
    "gap.trendChanged",
    {
      /** Which neighbor the trend refers to. */
      side: GapSide;
      /** New sustained direction ("closing" = the gap is shrinking). */
      direction: "closing" | "opening";
      /** Gap in seconds at the emitting lap completion. */
      gapSeconds: number;
      /** Gap in seconds one lap earlier (the sample the flip was measured against). */
      previousGapSeconds: number;
      /** The neighbor's car index. */
      carIdx: number;
      /** Player lap (`LapCompleted`) at emission. */
      lap: number;
    }
  >;
  /**
   * The live gap to a class-standings neighbor first dropped below the
   * user's alert threshold (issue #933). Once per episode: re-arms only
   * after the gap has grown back beyond threshold + hysteresis. Same
   * suppression rules as `gap.trendChanged`.
   */
  "gap.thresholdCrossed": SimEvent<
    "gap.thresholdCrossed",
    {
      /** Which neighbor crossed inside the threshold. */
      side: GapSide;
      /** Live gap in seconds at the crossing. */
      gapSeconds: number;
      /** The configured alert threshold in seconds. */
      thresholdSeconds: number;
      /** The neighbor's car index. */
      carIdx: number;
    }
  >;
```

- [ ] **Step 2: Export the type.** In `packages/event-bus/src/index.ts`, add `GapSide,` to the `export type {...} from "./event-catalog.js";` list (alphabetical).

- [ ] **Step 3: Add harness event templates.** In `packages/scenario-harness/src/event-names.ts`, after the `position.changed` entry, add:

```typescript
  {
    name: "gap.trendChanged",
    description: "Gap trend to a standings neighbor flipped and held 2 laps (issue #933)",
    data: {
      side: "ahead",
      direction: "closing",
      gapSeconds: 1.8,
      previousGapSeconds: 2.4,
      carIdx: 3,
      lap: 7,
    },
  },
  {
    name: "gap.thresholdCrossed",
    description: "Live gap to a standings neighbor dropped under the alert threshold (issue #933)",
    data: { side: "behind", gapSeconds: 0.9, thresholdSeconds: 1.0, carIdx: 5 },
  },
```

- [ ] **Step 4: Build the two packages to verify the exhaustiveness check passes**

Run: `cd /c/Users/Niklas/Projects/iRaceDeck/ir-933 && pnpm --filter @iracedeck/event-bus build && pnpm --filter @iracedeck/scenario-harness build`
Expected: both succeed. (If scenario-harness has no build script, run `pnpm build` at the root instead.)

- [ ] **Step 5: Lint, format, commit**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-933 && pnpm lint:fix && pnpm format:fix
git -C /c/Users/Niklas/Projects/iRaceDeck/ir-933 add packages/event-bus packages/scenario-harness/src/event-names.ts
git -C /c/Users/Niklas/Projects/iRaceDeck/ir-933 commit -m "feat(events): add gap.trendChanged and gap.thresholdCrossed catalog events (#933)"
```

---

### Task 3: Trace store, live gaps, and accessors in `@iracedeck/sim-events-iracing`

**Files:**
- Create: `packages/sim-events-iracing/src/diff/gaps.ts`
- Create: `packages/sim-events-iracing/src/diff/gaps.test.ts`
- Modify: `packages/sim-events-iracing/src/state.ts` (new state section + `createInitialState` entries)
- Modify: `packages/sim-events-iracing/src/translator.ts` (call `diffGaps` in `handleTick`; add `getLiveGaps`/`getLiveGapBetween`; add `getGapAlertThresholdSeconds` to `SimEventsIracingOptions`)
- Modify: `packages/sim-events-iracing/src/index.ts` (export accessors + types)
- Modify: `.claude/rules/race-positions.md` (add consumer)

**Interfaces:**
- Consumes: Task 1 primitives; Task 2 events; existing `resolvePaceCarIdx` (`diff/pace-laps.ts`), `resolveTrackLengthMeters` pattern, `calculateFrozenRacePositions` (passed in from `handleTick` as `frozenPositions` — same array already computed for `diffOvertakes`).
- Produces:
  - `type GapNeighbor = { carIdx: number; gapSeconds: number | null; lapDelta: number; trend: GapTrendDirection | null }`
  - `type LiveGaps = { ahead: GapNeighbor | null; behind: GapNeighbor | null }`
  - `getLiveGaps(): LiveGaps | null` (null outside race sessions / pre-green / no data)
  - `getLiveGapBetween(aheadCarIdx: number, behindCarIdx: number): number | null` — the reusable any-two-cars accessor (future "N seconds behind the leader")
  - `diffGaps(state, telemetry, isRaceSession, playerCarIdx, paceCarIdx, frozenPositions, getThresholdSeconds, emit): void`
  - `SimEventsIracingOptions.getGapAlertThresholdSeconds?: () => number`
  - Constants exported for tests: `GAP_DISPLAY_TREND_DEADBAND_S = 0.3`, `GAP_CALLOUT_TREND_DEADBAND_S = 0.2`, `GAP_THRESHOLD_HYSTERESIS_S = 0.5`, `GAP_CHECKPOINT_STEP = 0.02`, `GAP_DEFAULT_ALERT_THRESHOLD_S = 1.0`

**Design (implements the spec's semantics):**
- Per tick (race or not — traces record whenever cars are live so a race that follows practice starts warm... **no**: keep recording race-only to avoid cross-session garbage; traces reset on session change anyway since state is recreated. Record when `isRaceSession && !isPreGreen(telemetry) && LapCompleted >= 0` for the player-gating, but record ALL cars whose `CarIdxLapCompleted[i] >= 0 && CarIdxLapDistPct[i] >= 0`).
- Live gap ahead = `SessionTime − crossingTimeAt(trace[aheadIdx], playerProgress)`; live gap behind = `SessionTime − crossingTimeAt(trace[playerIdx], behindProgress)`. `null` when the trace doesn't cover the point (cold start; EstTime fallback comes in a later refinement if manual testing shows lap-1 matters — the spec lists lap-one fallback quality as an open question; do NOT build it yet, YAGNI, the display shows `–` on lap 1).
- Display trend: on every `GAP_CHECKPOINT_STEP` advance of player progress, push `{ progress, gapSeconds }` per side into a ring capped at `Math.ceil(1.05 / GAP_CHECKPOINT_STEP) + 2` entries; trend = `classifyGapTrend(gapNow − gapAtProgressMinusOneLap, GAP_DISPLAY_TREND_DEADBAND_S)`; ring resets when the side's neighbor identity changes.
- Neighbor identity per side is cached in state; change → reset that side's ring, lap samples, direction memory, threshold episode.
- Suppression state per side: `pausedByPit = OnPitRoad(player) || neighborOnPitRoad || neighborNotInWorld || playerNotOnTrack`; while paused, no checkpoints, no lap samples, no threshold emissions; threshold re-arms require unpaused.
- `getLiveGaps()` reads the state the diff wrote this tick (`state.gapLiveAhead/Behind`), so the accessor is O(1); returns null when not in a race session (the diff clears the fields when not racing).

- [ ] **Step 1: Add state fields.** In `packages/sim-events-iracing/src/state.ts` add a new section to `TranslatorState` (after the Overtakes section):

```typescript
  // ── Gaps (issue #933) ───────────────────────────────────────────────────
  /**
   * Per-car crossing-time traces (issue #933): rolling ~1.15-lap history of
   * `lapCompleted + lapDistPct` progress against `SessionTime`, sparse-indexed
   * by carIdx. Owned here; all math on them lives in
   * `@iracedeck/iracing-sdk` `gap-utils.ts`.
   */
  gapTraces: (ProgressTrace | undefined)[];
  /** Cached class-neighbor car indices from the last tick (−1 = none). */
  gapAheadIdx: number;
  gapBehindIdx: number;
  /** Live gap snapshots the accessor reads; null = not computable this tick. */
  gapLiveAhead: GapNeighborState | null;
  gapLiveBehind: GapNeighborState | null;
  /** Display-trend checkpoint rings: { progress, gapSeconds } per side. */
  gapCheckpointsAhead: { progress: number; gapSeconds: number }[];
  gapCheckpointsBehind: { progress: number; gapSeconds: number }[];
  /** Player progress at the last recorded checkpoint. */
  gapLastCheckpointProgress: number;
  /** Lap-over-lap callout samples: gap at each player lap completion (per side). */
  gapLapSampleAhead: number | null;
  gapLapSampleBehind: number | null;
  /** Direction of the previous lap's delta (per side), for the 2-lap confirmation. */
  gapPrevLapDirectionAhead: GapTrendDirection | null;
  gapPrevLapDirectionBehind: GapTrendDirection | null;
  /** Last direction announced via gap.trendChanged (per side). */
  gapAnnouncedDirectionAhead: GapTrendDirection | null;
  gapAnnouncedDirectionBehind: GapTrendDirection | null;
  /** Threshold episode armed flags — arm only after the gap has been observed
   *  beyond threshold + hysteresis, so a nose-to-tail race start can't fire
   *  a crossing on the first green-flag tick. */
  gapThresholdArmedAhead: boolean;
  gapThresholdArmedBehind: boolean;
  /** Player LapCompleted at the last lap-sample capture (−1 before seeding). */
  gapLastLapCompleted: number;
```

with the supporting type near the top of state.ts:

```typescript
/** Live gap snapshot for one side (issue #933). */
export type GapNeighborState = {
  carIdx: number;
  gapSeconds: number | null;
  lapDelta: number;
  trend: GapTrendDirection | null;
};
```

Imports: add `import type { GapTrendDirection, ProgressTrace } from "@iracedeck/iracing-sdk";` to state.ts. `createInitialState` entries:

```typescript
    gapTraces: [],
    gapAheadIdx: -1,
    gapBehindIdx: -1,
    gapLiveAhead: null,
    gapLiveBehind: null,
    gapCheckpointsAhead: [],
    gapCheckpointsBehind: [],
    gapLastCheckpointProgress: -1,
    gapLapSampleAhead: null,
    gapLapSampleBehind: null,
    gapPrevLapDirectionAhead: null,
    gapPrevLapDirectionBehind: null,
    gapAnnouncedDirectionAhead: null,
    gapAnnouncedDirectionBehind: null,
    gapThresholdArmedAhead: false,
    gapThresholdArmedBehind: false,
    gapLastLapCompleted: -1,
```

- [ ] **Step 2: Write failing tests** in `packages/sim-events-iracing/src/diff/gaps.test.ts`. Follow the `overtakes.test.ts` shape (synthetic `TelemetryData`, `createInitialState`, collected `PendingEvent[]`). Core cases for THIS task (trend/threshold events come in Task 4 — here test recording + live gaps only):

```typescript
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffGaps, GAP_DEFAULT_ALERT_THRESHOLD_S } from "./gaps.js";
import type { PendingEvent } from "./types.js";

const PLAYER = 0;
const AHEAD = 1;
const BEHIND = 2;

/**
 * Three-car single-class field. Progress in laps; SessionTime in seconds.
 * All cars run identical 90 s laps offset by fixed time gaps, so crossing-time
 * gaps are exact and assertable.
 */
function tick(sessionTime: number, progressByCar: number[], overrides: Partial<TelemetryData> = {}): TelemetryData {
  const n = progressByCar.length;

  return {
    SessionTime: sessionTime,
    SessionState: 4, // racing
    OnPitRoad: false,
    IsOnTrack: true,
    LapCompleted: Math.floor(progressByCar[PLAYER]!),
    CarIdxLapCompleted: progressByCar.map((p) => Math.floor(p)),
    CarIdxLapDistPct: progressByCar.map((p) => p - Math.floor(p)),
    CarIdxClass: new Array(n).fill(10),
    CarIdxOnPitRoad: new Array(n).fill(false),
    CarIdxTrackSurface: new Array(n).fill(3), // TrkLoc.OnTrack
    ...overrides,
  } as unknown as TelemetryData;
}

function collect(): { events: PendingEvent[]; emit: (e: PendingEvent) => void } {
  const events: PendingEvent[] = [];

  return { events, emit: (e) => events.push(e) };
}

/**
 * Drive the diff through a constant-speed run: every car advances
 * `lapsPerTick` per tick, AHEAD leads the player by `aheadGapS` seconds and
 * BEHIND trails by `behindGapS` (converted to progress via 90 s/lap).
 */
function run(
  state: TranslatorState,
  emit: (e: PendingEvent) => void,
  opts: { fromLap: number; toLap: number; aheadGapS: number; behindGapS: number; lapTimeS?: number },
): void {
  const lapTime = opts.lapTimeS ?? 90;
  const step = 0.005; // laps per tick

  for (let p = opts.fromLap; p <= opts.toLap; p += step) {
    const t = p * lapTime;
    const positions = [2, 1, 3];
    diffGaps(
      state,
      tick(t, [p, p + opts.aheadGapS / lapTime, p - opts.behindGapS / lapTime]),
      true,
      PLAYER,
      null,
      positions,
      () => GAP_DEFAULT_ALERT_THRESHOLD_S,
      emit,
    );
  }
}

describe("diffGaps — live gaps", () => {
  it("computes crossing-time gaps to both class neighbors after warm-up", () => {
    const state = createInitialState();
    const { emit } = collect();

    run(state, emit, { fromLap: 1, toLap: 2.5, aheadGapS: 2.0, behindGapS: 3.5 });

    expect(state.gapLiveAhead?.carIdx).toBe(AHEAD);
    expect(state.gapLiveAhead?.gapSeconds).toBeCloseTo(2.0, 1);
    expect(state.gapLiveAhead?.lapDelta).toBe(0);
    expect(state.gapLiveBehind?.carIdx).toBe(BEHIND);
    expect(state.gapLiveBehind?.gapSeconds).toBeCloseTo(3.5, 1);
  });

  it("reports null gapSeconds before the traces cover the lookup point (cold start)", () => {
    const state = createInitialState();
    const { emit } = collect();

    // Single tick — no history at all.
    diffGaps(state, tick(90, [1.0, 1.02, 0.98]), true, PLAYER, null, [2, 1, 3], () => 1.0, emit);

    expect(state.gapLiveAhead?.gapSeconds).toBeNull();
  });

  it("reports lapDelta and keeps gapSeconds null for a neighbor a full lap up", () => {
    const state = createInitialState();
    const { emit } = collect();

    run(state, emit, { fromLap: 1, toLap: 2.5, aheadGapS: 100, behindGapS: 2 }); // 100 s ≈ 1.1 laps

    expect(state.gapLiveAhead?.lapDelta).toBe(1);
  });

  it("clears live gaps outside race sessions", () => {
    const state = createInitialState();
    const { emit } = collect();

    run(state, emit, { fromLap: 1, toLap: 1.5, aheadGapS: 2, behindGapS: 2 });
    diffGaps(state, tick(200, [1.5, 1.52, 1.48]), false, PLAYER, null, [2, 1, 3], () => 1.0, emit);

    expect(state.gapLiveAhead).toBeNull();
    expect(state.gapLiveBehind).toBeNull();
  });

  it("excludes the pace car from neighbor resolution", () => {
    const state = createInitialState();
    const { emit } = collect();
    const positions = [2, 1, 3];

    // paceCarIdx = AHEAD → the ahead slot must be empty (no other class car ahead).
    diffGaps(state, tick(90, [1.0, 1.02, 0.98]), true, PLAYER, AHEAD, positions, () => 1.0, emit);

    expect(state.gapAheadIdx).toBe(-1);
    expect(state.gapBehindIdx).toBe(BEHIND);
  });

  it("resets a side's trend state when the neighbor's identity changes", () => {
    const state = createInitialState();
    const { emit } = collect();

    run(state, emit, { fromLap: 1, toLap: 2.2, aheadGapS: 2, behindGapS: 2 });
    expect(state.gapCheckpointsAhead.length).toBeGreaterThan(0);

    // Swap the ahead neighbor: positions now rank car 2 ahead of the player.
    diffGaps(state, tick(200, [2.2, 2.25, 2.22]), true, PLAYER, null, [2, 3, 1], () => 1.0, emit);

    expect(state.gapAheadIdx).toBe(BEHIND);
    expect(state.gapCheckpointsAhead.length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail** (module not found).

- [ ] **Step 4: Implement `diffGaps`** in `packages/sim-events-iracing/src/diff/gaps.ts`. Structure:

```typescript
import {
  appendProgressSample,
  classifyGapTrend,
  crossingTimeAt,
  type GapTrendDirection,
  isPreGreen,
  lapDeltaBetween,
  resolveClassNeighbors,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";

import type { GapNeighborState, TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

export const GAP_DISPLAY_TREND_DEADBAND_S = 0.3;
export const GAP_CALLOUT_TREND_DEADBAND_S = 0.2;
export const GAP_THRESHOLD_HYSTERESIS_S = 0.5;
export const GAP_CHECKPOINT_STEP = 0.02;
export const GAP_DEFAULT_ALERT_THRESHOLD_S = 1.0;

export function diffGaps(
  state: TranslatorState,
  telemetry: TelemetryData,
  isRaceSession: boolean,
  playerCarIdx: number,
  paceCarIdx: number | null,
  frozenPositions: number[] | null,
  getThresholdSeconds: () => number,
  emit: EmitFn,
): void {
  // 1) Hard gates: race session, green, player racing, arrays present.
  //    On failure: clear gapLiveAhead/Behind and return (keep traces — a
  //    brief SessionState flicker must not wipe a lap of history; session
  //    change recreates the whole state anyway).
  // 2) Record traces for every car with lapCompleted >= 0 && lapDistPct >= 0
  //    using appendProgressSample(trace, lc + pct, SessionTime).
  // 3) Resolve neighbors via resolveClassNeighbors(frozenPositions,
  //    telemetry.CarIdxClass, playerCarIdx, paceCarIdx). On identity change
  //    per side → resetSide(state, side).
  // 4) Compute live gap per side (forward-only crossing-time):
  //      ahead:  gap = SessionTime − crossingTimeAt(traces[aheadIdx], playerProgress)
  //      behind: gap = SessionTime − crossingTimeAt(traces[playerIdx], behindProgress)
  //    lapDelta = lapDeltaBetween(aheadProgress, playerProgress) (and mirror).
  //    Suppression flags: player OnPitRoad / !IsOnTrack, neighbor
  //    CarIdxOnPitRoad[idx] / CarIdxTrackSurface[idx] === TrkLoc.NotInWorld.
  // 5) Display checkpoints + display trend (per side, when not suppressed and
  //    lapDelta === 0): every GAP_CHECKPOINT_STEP of player progress, push
  //    { progress, gapSeconds }; trend = classifyGapTrend(gapNow − gapOneLapAgo,
  //    GAP_DISPLAY_TREND_DEADBAND_S) where gapOneLapAgo is the checkpoint with
  //    progress closest to (playerProgress − 1), or null if none.
  // 6) Write state.gapLiveAhead / gapLiveBehind (GapNeighborState objects).
  // 7) Lap-over-lap callout sampling + threshold episodes → Task 4 (leave
  //    a `maybeEmitCalloutEvents(...)` stub called here, implemented next task).
}
```

Write the real implementation (not the comment skeleton) following exactly that sequence; keep helpers module-private (`resetSide`, `neighborSuppressed`, `computeAheadGap`, `computeBehindGap`, `updateCheckpoints`). The full behavior contract is the test file.

- [ ] **Step 5: Wire into the translator.** In `packages/sim-events-iracing/src/translator.ts`:
  - Add to `SimEventsIracingOptions`:

```typescript
  /**
   * Live resolver for the gap alert threshold in seconds (issue #933).
   * Plugins wire this to the `gapAlertThresholdSeconds` global setting;
   * read per tick so a slider change re-arms/fires without a restart.
   */
  getGapAlertThresholdSeconds?: () => number;
```

  - Add instance field `getGapAlertThresholdSeconds` defaulting to `() => GAP_DEFAULT_ALERT_THRESHOLD_S` (mirror `getFuelLapsLeftMarginLaps`).
  - In `handleTick`, after the `diffOvertakes(...)` call (frozenPositions + paceCarIdx are in scope; resolve paceCarIdx with the existing `resolvePaceCarIdx(sessionInfo)` from `./diff/pace-laps.js`):

```typescript
  // Gap tracking (issue #933): crossing-time traces + class-neighbor live
  // gaps + trend/threshold callout events. Consumes the same canonical
  // frozen order as diffOvertakes; the pace car is excluded explicitly.
  diffGaps(
    self.state,
    telemetry,
    isRaceSession,
    playerCarIdx,
    resolvePaceCarIdx(sessionInfo),
    frozenPositions,
    self.getGapAlertThresholdSeconds,
    emit,
  );
```

  - Add the accessors next to `getLivePosition`:

```typescript
/** Live gap snapshot for one class-standings neighbor (issue #933). */
export type GapNeighbor = {
  carIdx: number;
  gapSeconds: number | null;
  lapDelta: number;
  trend: GapTrendDirection | null;
};

/** Live gaps to the class-standings neighbors (issue #933). */
export type LiveGaps = { ahead: GapNeighbor | null; behind: GapNeighbor | null };

/**
 * Live crossing-time gaps to the cars one class position ahead and behind
 * (issue #933). `null` when unavailable (not initialized, no telemetry, not
 * a race session). Sides are `null` when there is no such neighbor; a side's
 * `gapSeconds` is `null` while the traces can't cover the lookup (cold start)
 * or the neighbor is a lap or more away (`lapDelta` then carries the count).
 */
export function getLiveGaps(): LiveGaps | null {
  if (!instance || !instance.latestTelemetry) return null;

  if (!instance.state.gapLiveAhead && !instance.state.gapLiveBehind) return null;

  return { ahead: instance.state.gapLiveAhead, behind: instance.state.gapLiveBehind };
}

/**
 * Crossing-time gap in seconds between any two cars (issue #933): how long
 * ago `aheadCarIdx` crossed `behindCarIdx`'s current track position. The
 * reusable primitive behind future consumers ("we're N seconds behind the
 * leader") — resolve the target from the canonical order, then call this.
 * `null` when the traces don't cover the lookup.
 */
export function getLiveGapBetween(aheadCarIdx: number, behindCarIdx: number): number | null {
  if (!instance || !instance.latestTelemetry) return null;

  const t = instance.latestTelemetry;
  const lc = t.CarIdxLapCompleted as number[] | undefined;
  const pct = t.CarIdxLapDistPct as number[] | undefined;
  const sessionTime = typeof t.SessionTime === "number" ? t.SessionTime : null;

  if (!lc || !pct || sessionTime === null) return null;

  const behindLc = lc[behindCarIdx];
  const behindPct = pct[behindCarIdx];

  if (typeof behindLc !== "number" || behindLc < 0 || typeof behindPct !== "number" || behindPct < 0) return null;

  const trace = instance.state.gapTraces[aheadCarIdx];

  if (!trace) return null;

  const crossed = crossingTimeAt(trace, behindLc + behindPct);

  return crossed === null ? null : sessionTime - crossed;
}
```

  - Export `diffGaps` constants nothing; export from `packages/sim-events-iracing/src/index.ts`: `getLiveGaps`, `getLiveGapBetween`, `type GapNeighbor`, `type LiveGaps`.

- [ ] **Step 6: Run tests**

Run: `cd /c/Users/Niklas/Projects/iRaceDeck/ir-933 && pnpm exec vitest run packages/sim-events-iracing`
Expected: new tests PASS, all existing translator tests still PASS.

- [ ] **Step 7: Update `.claude/rules/race-positions.md`** — add to "Current consumers":

```markdown
- **Gap tracking (#933)** — `diffGaps` receives the frozen order from `handleTick` (the same array passed to `diffOvertakes`) and resolves class-standings neighbors from it via `resolveClassNeighbors` (`@iracedeck/iracing-sdk` `gap-utils.ts`, with explicit pace-car exclusion); Session Info's Gaps mode consumes `getLiveGaps()`, and `getLiveGapBetween()` is the reusable any-two-cars gap accessor.
```

- [ ] **Step 8: Build, lint, format, commit**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-933 && set -o pipefail && pnpm build 2>&1 | tail -5 && pnpm lint:fix && pnpm format:fix
git -C /c/Users/Niklas/Projects/iRaceDeck/ir-933 add packages/sim-events-iracing packages/iracing-sdk .claude/rules/race-positions.md
git -C /c/Users/Niklas/Projects/iRaceDeck/ir-933 commit -m "feat(sim-events): crossing-time gap traces, live class-neighbor gaps, reusable gap accessors (#933)"
```

---

### Task 4: Trend-flip + threshold episode events in the gap diff

**Files:**
- Modify: `packages/sim-events-iracing/src/diff/gaps.ts` (implement `maybeEmitCalloutEvents`)
- Modify: `packages/sim-events-iracing/src/diff/gaps.test.ts` (add event tests)

**Interfaces:**
- Consumes: Task 2 events, Task 3 state fields.
- Produces: `gap.trendChanged` / `gap.thresholdCrossed` emissions per the spec.

**Behavior contract (write these as tests first):**
1. **Lap sampling:** when `telemetry.LapCompleted` increments past `state.gapLastLapCompleted` (and the side is unsuppressed, `lapDelta === 0`, gap non-null), capture the side's gap as the lap sample; compute `delta = sample_n − sample_{n−1}`; `direction = classifyGapTrend(delta, GAP_CALLOUT_TREND_DEADBAND_S)`.
2. **Trend flip:** emit `gap.trendChanged` when `direction` is `"closing"` or `"opening"`, differs from `gapAnnouncedDirection<Side>`, AND equals `gapPrevLapDirection<Side>` (two consecutive laps in the new direction). On emit, set `gapAnnouncedDirection<Side> = direction`. Always roll `gapPrevLapDirection<Side> = direction` after comparing. First-ever direction (announced still null) counts as a flip once sustained 2 laps — the engineer's first trend read.
3. **Threshold:** per tick, per side, unsuppressed, `lapDelta === 0`, gap non-null: if `!armed && gap > threshold + GAP_THRESHOLD_HYSTERESIS_S` → arm; if `armed && gap < threshold` → emit `gap.thresholdCrossed`, disarm. (Starting disarmed means a nose-to-tail start never fires until the gap has first opened beyond ~1.5 s.)
4. **No events** for a lapped neighbor, while suppressed, outside race, or pre-green; neighbor identity change resets samples/directions/armed for that side.

Tests to add (same harness as Task 3's `run()` helper — vary `aheadGapS` per segment):

```typescript
describe("diffGaps — trend flip events", () => {
  it("emits gap.trendChanged after two consecutive closing laps and not before", () => { /* run 3 laps at 5.0s, then laps at 4.0s, 3.0s, 2.0s — expect exactly one ahead/closing event, at the second closing lap */ });
  it("does not re-emit while the direction holds", () => { /* continue closing a further 2 laps — still one event */ });
  it("emits the opposite flip after two opening laps", () => { /* then 2 growing laps → one ahead/opening event */ });
  it("stays silent inside the deadband", () => { /* deltas of ±0.1 s/lap → no events */ });
});

describe("diffGaps — threshold events", () => {
  it("arms only after the gap exceeds threshold + hysteresis, then fires once on crossing", () => { /* start at 0.8 s (no fire), open to 2.0 s (arms), close to 0.9 s → exactly one gap.thresholdCrossed */ });
  it("does not re-fire until re-armed", () => { /* oscillate 0.9 → 1.2 → 0.9 (below re-arm) → no second event; open to 1.6+ then close → second event */ });
  it("suppresses while the neighbor is on pit road", () => { /* CarIdxOnPitRoad[ahead]=true during the crossing → no event */ });
});
```

- [ ] **Step 1: Write the failing tests** (concrete versions of the sketches above — drive `run()` in segments and filter `events` by name).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** `maybeEmitCalloutEvents` per the contract (helpers per side; keep per-side logic in one parameterized function `processSide(state, side, ...)` to avoid ahead/behind copy-paste divergence).
- [ ] **Step 4: Run tests — all green.** `pnpm exec vitest run packages/sim-events-iracing`
- [ ] **Step 5: Lint, format, commit**

```bash
git -C /c/Users/Niklas/Projects/iRaceDeck/ir-933 commit -am "feat(sim-events): emit gap trend-flip and threshold-crossing events (#933)"
```

---

### Task 5: Global settings fields in `@iracedeck/deck-core`

**Files:**
- Modify: `packages/deck-core/src/global-settings.ts`
- Modify: `packages/deck-core/src/global-settings.test.ts`
- Modify: `packages/deck-core/src/simhub-service.test.ts` (BOTH literals, ~line 39 and ~line 227)

**Interfaces:**
- Produces schema fields: `calloutEnabledGapTrend` (bool, default true), `calloutEnabledGapThreshold` (bool, default true), `gapAlertThresholdSeconds` (0.5–3, default 1, `.catch(1)`), `gapCalloutCooldownSeconds` (1–360, default 30, `.catch(30)`).

- [ ] **Step 1: Write failing tests** in `global-settings.test.ts` (mirror the `spotterStillThereSeconds` precedent):

```typescript
  it("gap callout settings default on with threshold 1.0 and cooldown 30", () => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;

    expect(parsed.calloutEnabledGapTrend).toBe(true);
    expect(parsed.calloutEnabledGapThreshold).toBe(true);
    expect(parsed.gapAlertThresholdSeconds).toBe(1);
    expect(parsed.gapCalloutCooldownSeconds).toBe(30);
  });

  it("gap numeric settings coerce strings and fall back on malformed values", () => {
    const parsed = GlobalSettingsSchema.parse({
      gapAlertThresholdSeconds: "2.5",
      gapCalloutCooldownSeconds: "junk",
    }) as Record<string, unknown>;

    expect(parsed.gapAlertThresholdSeconds).toBe(2.5);
    expect(parsed.gapCalloutCooldownSeconds).toBe(30);
  });
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Add the schema fields** next to `calloutEnabledRaceStatus` (booleans) and `spotterStillThereSeconds` (numerics):

```typescript
    /**
     * Opt-ins for the gap callout family (issue #933): the sustained
     * trend-flip announcement and the threshold-crossing alert. Defaults
     * `true`. Canonical id↔key mapping in `GAP_CALLOUT_SETTING_KEYS`
     * (in `@iracedeck/audio-scenarios`).
     */
    calloutEnabledGapTrend: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledGapThreshold: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    // `.catch(...)` per #896 — a malformed persisted value must not abort the parse.
    /** Gap alert threshold in seconds (issue #933): the engineer calls out when a neighbor's gap first drops below this. 0.5–3.0, default 1.0. Read live by the translator's gap diff. */
    gapAlertThresholdSeconds: z.coerce.number().min(0.5).max(3).default(1).catch(1),
    /** Shared cooldown between gap callouts in seconds (issue #933). 1–360, default 30. Read live at event arrival. */
    gapCalloutCooldownSeconds: z.coerce.number().min(1).max(360).default(30).catch(30),
```

- [ ] **Step 4: Add all four keys to BOTH `simhub-service.test.ts` literals** (values: `true`, `true`, `1`, `30`).
- [ ] **Step 5: Force-build + test** (turbo caches deck-core):

Run: `cd /c/Users/Niklas/Projects/iRaceDeck/ir-933 && set -o pipefail && pnpm build --force 2>&1 | tail -5 && pnpm exec vitest run packages/deck-core`
Expected: build green, tests PASS.

- [ ] **Step 6: Commit** — `feat(settings): gap callout toggles, alert threshold, and cooldown (#933)`

---

### Task 6: Voice lines (USER CHECKPOINT before generation)

**Files:**
- Modify: `packages/audio-assets/configs/default.voice.json` (new `gap` group)
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/pools.ts` (POOL_REGISTRY entries)
- Generated: `packages/audio-assets/voice/default/gap/*.mp3` + both manifests

**Interfaces:**
- Produces clip groups consumed by Task 7's vars: group `gap`, bases `ahead-closing`, `ahead-opening`, `behind-closing`, `behind-opening`, `threshold-ahead`, `threshold-behind`, `readout-intro`. The spoken gap number reuses the existing `lap-time-second` + `lap-time-decimal` groups via `poolRef` — no new number clips.

- [ ] **Step 1: Add the `gap` group** to `configs/default.voice.json` (no `seed` on new entries; `previous_request_ids` chain the readout intro into the number groups):

```json
    "gap": [
      { "name": "ahead-closing-01", "text": "We're gaining on the car ahead." },
      { "name": "ahead-closing-02", "text": "Good pace — we're closing on the car ahead." },
      { "name": "ahead-opening-01", "text": "The car ahead is pulling away from us." },
      { "name": "ahead-opening-02", "text": "We're losing time to the car ahead." },
      { "name": "behind-closing-01", "text": "The car behind is closing in on us." },
      { "name": "behind-closing-02", "text": "The car behind is gaining. Keep your head down." },
      { "name": "behind-opening-01", "text": "We're pulling away from the car behind." },
      { "name": "behind-opening-02", "text": "Good — we're dropping the car behind." },
      { "name": "threshold-ahead-01", "text": "We've caught the car ahead." },
      { "name": "threshold-behind-01", "text": "The car behind is right with us." },
      { "name": "readout-intro", "text": "Gap is", "next_request_ids": ["lap-time-second/1"] }
    ],
```

- [ ] **Step 2: Register the pools.** In `packages/audio-scenarios/src/catalog/pit-crew/pools.ts` `POOL_REGISTRY`:

```typescript
  // Gap callout pools (issue #933): trend-flip lines per side/direction,
  // threshold alerts per side, and the "Gap is" intro for the number readout
  // (the number itself reuses the lap-time-second / lap-time-decimal groups).
  "gap-ahead-closing": { group: "gap", base: "ahead-closing" },
  "gap-ahead-opening": { group: "gap", base: "ahead-opening" },
  "gap-behind-closing": { group: "gap", base: "behind-closing" },
  "gap-behind-opening": { group: "gap", base: "behind-opening" },
  "gap-threshold-ahead": { group: "gap", base: "threshold-ahead" },
  "gap-threshold-behind": { group: "gap", base: "threshold-behind" },
  "gap-readout-intro": { group: "gap", base: "readout-intro" },
```

- [ ] **Step 3: Dry-run and STOP for user approval.**

```bash
cp /c/Users/Niklas/Projects/iRaceDeck/master/.env.local /c/Users/Niklas/Projects/iRaceDeck/ir-933/.env.local
cd /c/Users/Niklas/Projects/iRaceDeck/ir-933 && pnpm --filter @iracedeck/audio-assets generate:dry-run --group gap
```

Present the dry-run output (the exact wordings that WOULD generate) to the user. **Do not generate until the user approves the wordings.**

- [ ] **Step 4 (after approval): Generate + manifest**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-933 && pnpm --filter @iracedeck/audio-assets generate --group gap && pnpm --filter @iracedeck/audio-assets generate:manifest
```

- [ ] **Step 5: Commit clips + config + both manifests + pools**

```bash
git -C /c/Users/Niklas/Projects/iRaceDeck/ir-933 add packages/audio-assets packages/audio-scenarios/src/catalog/pit-crew/pools.ts
git -C /c/Users/Niklas/Projects/iRaceDeck/ir-933 commit -m "feat(audio): gap callout voice lines and pools (#933)"
```

---

### Task 7: Gap callout catalog module + registration

**Files:**
- Create: `packages/audio-scenarios/src/catalog/pit-crew/gaps.ts`
- Create: `packages/audio-scenarios/src/catalog/pit-crew/gaps.test.ts`
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/index.ts` (params + registration; new params go BEFORE the two master gates)
- Modify: `packages/audio-scenarios/src/index.ts` (export setting-key map + types if the package re-exports others' — mirror `RACE_STATUS_CALLOUT_SETTING_KEYS` handling)
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/register-pit-crew.test.ts` (registration contract)

**Interfaces:**
- Consumes: Task 2 events, Task 6 pools, `WEIGHT`/`poolRef`/`Scenario` from `../../dsl.js`, `overtakeContextAllows` + `OvertakeGateResolver` from `./overtake-gate.js`.
- Produces:
  - `type GapCalloutId = "trend" | "threshold"`
  - `GAP_CALLOUT_SETTING_KEYS: Record<GapCalloutId, string>` = `{ trend: "calloutEnabledGapTrend", threshold: "calloutEnabledGapThreshold" }`
  - `GAP_SCENARIO_IDS = ["pit-crew.gap-trend", "pit-crew.gap-threshold"] as const` + `SCENARIO_ID_TO_GAP_ID`
  - `GAP_CALLOUT_DEFAULT_COOLDOWN_MS = 30_000`, `resolveGapCooldownMs(rawSeconds: unknown): number` (clamp 1–360 s, default 30)
  - `type LiveGapsResolver = () => { ahead: { gapSeconds: number | null } | null; behind: { gapSeconds: number | null } | null } | null` (structural — keeps audio-scenarios sim-agnostic)
  - `registerGapVars(engine, getLiveGaps: LiveGapsResolver)` + `buildGapTrendScenario(...)` + `buildGapThresholdScenario(...)`
  - Three new `registerPitCrew` params (before the master gates): `getGapCalloutEnabled: (id: GapCalloutId) => boolean = () => true`, `getGapCooldownMs: () => number = () => GAP_CALLOUT_DEFAULT_COOLDOWN_MS`, `getLiveGaps: LiveGapsResolver = () => null`.

**Module design (`gaps.ts`):**
- Module-level `lastGapEvent: { side, direction? } | null` stash + `lastGapCalloutAtMs = 0`; `tryClaimGapCallout(now, cooldownMs)` claims the shared cooldown as the LAST `where:` gate (the `tryClaimPositionAnnouncement` pattern — deferred queueable replays never re-run `where:`).
- Vars:
  - `gap.line` → for a trend event: `poolRef("gap", \`${side}-${direction}\`)` — wait, pools are registered by NAME (`gap-ahead-closing`), and `poolRef(group, base)` builds `pool:gap/ahead-closing` dynamically from the manifest; use `poolRef("gap", `${side}-${direction}`)` directly (no POOL_REGISTRY need for var-driven refs — the registry entries from Task 6 additionally make the static pools available; keep both consistent).
  - `gap.thresholdLine` → `poolRef("gap", \`threshold-${side}\`)`.
  - `gap.readoutIntro` → `poolRef("gap", "readout-intro")`.
  - `gap.second` / `gap.decimal` → read the LIVE gap for the stashed side via `getLiveGaps()`; `null` unless `0 <= gap < 60`; split with `Math.round(gap*10)` into whole seconds + tenths; return `poolRef("lap-time-second", String(sec))` / `poolRef("lap-time-decimal", String(tenths))`.
- Scenarios (both `family: "gap"`, `channel: AudioChannel.Voice`, `bus: AudioBus.Voice`, `base: "voice/{voice}"`, `queueable: true`):
  - `pit-crew.gap-trend` — `when: { event: "gap.trendChanged", where }`, `weight: WEIGHT.CHATTER`, sequence `["@pit-crew.radio-open", { var: "gap.line" }, { optional: [{ var: "gap.readoutIntro" }, { var: "gap.second" }, { var: "gap.decimal" }] }, "@pit-crew.radio-close"]`.
  - `pit-crew.gap-threshold` — `when: { event: "gap.thresholdCrossed", where }`, `weight: WEIGHT.NORMAL`, sequence `["@pit-crew.radio-open", { var: "gap.thresholdLine" }, { optional: [{ var: "gap.readoutIntro" }, { var: "gap.second" }, { var: "gap.decimal" }] }, "@pit-crew.radio-close"]`.
  - Shared `where:` body: stash the event payload → `if (getRaceFinishedFired()) return false;` → `if (!overtakeContextAllows(getGate())) return false;` (player-side gate; the diff already gated the neighbor side at emission) → `return tryClaimGapCallout(Date.now(), getGapCooldownMs());`.
- Registration in `index.ts` (next to race-status):

```typescript
  // Gap callouts (issue #933): sustained trend flips + threshold crossings
  // against the class-standings neighbors. Numbers are read LIVE at speak
  // time; the shared gap cooldown is claimed as the last where: gate.
  registerGapVars(engine, getLiveGaps);
  for (const s of [
    buildGapTrendScenario(getRaceFinishedFired, getOvertakeGate, getGapCooldownMs, getLiveGaps),
    buildGapThresholdScenario(getRaceFinishedFired, getOvertakeGate, getGapCooldownMs, getLiveGaps),
  ]) {
    engine.defineScenario(
      wrapWithMaster(wrapCalloutScenario(s, SCENARIO_ID_TO_GAP_ID, getGapCalloutEnabled, "gap callout", logger)),
    );
  }
```

- [ ] **Step 1: Write failing tests** (`gaps.test.ts`): cooldown claim behavior (first claim passes, second within cooldown fails, passes after), `resolveGapCooldownMs` clamping, var resolvers (trend line pool ref per side/direction; second/decimal null when gap null/≥60/negative; correct split at 1.55 → second "1" decimal "6"), threshold `where:` gate (disabled opt-in → false; gate suppressed → false). Also extend `register-pit-crew.test.ts` with the gap scenarios' registration assertions (mirror the race-status entries).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `gaps.ts` + wire `index.ts`.** Keep exports mirrored through the package's public surface the same way `RACE_STATUS_CALLOUT_SETTING_KEYS` is (check `packages/audio-scenarios/src/index.ts` and re-export `GAP_CALLOUT_SETTING_KEYS`, `type GapCalloutId`, `resolveGapCooldownMs`, `GAP_CALLOUT_DEFAULT_COOLDOWN_MS`).
- [ ] **Step 4: Run the package tests.** `pnpm exec vitest run packages/audio-scenarios` — all green.
- [ ] **Step 5: Commit** — `feat(audio): gap trend and threshold Race Engineer callouts (#933)`

---

### Task 8: Plugin wiring (all three plugins, lockstep)

**Files:**
- Modify: `packages/iracing-plugin-stream-deck/src/plugin.ts`
- Modify: `packages/iracing-plugin-mirabox/src/plugin.ts`
- Modify: `packages/iracing-plugin-ulanzi/src/plugin.ts`

**Interfaces:**
- Consumes: `GAP_CALLOUT_SETTING_KEYS`, `resolveGapCooldownMs`, `GapCalloutId` from `@iracedeck/audio-scenarios`; `getLiveGaps` from `@iracedeck/sim-events-iracing`; the `gapAlertThresholdSeconds` global setting.

In each `plugin.ts`:
- [ ] **Step 1:** Add to the `initializeSimEventsIracing(...)` options object (mirror `getFuelLapsLeftMarginLaps`):

```typescript
  // Gap alert threshold (issue #933) — read live so a PI slider change
  // takes effect on the next tick without a restart.
  getGapAlertThresholdSeconds: () => {
    const raw = (getGlobalSettings() as Record<string, unknown>).gapAlertThresholdSeconds;
    const n = Number(raw);

    return Number.isFinite(n) && n >= 0.5 && n <= 3 ? n : 1;
  },
```

(If the existing options wiring pattern centralizes clamping elsewhere, follow that pattern; otherwise inline as above, identically in all three plugins.)

- [ ] **Step 2:** Add the three new `registerPitCrew` args in each plugin, immediately BEFORE the two master-gate args (mirror the comment style of the neighboring args):

```typescript
  // Gap callout opt-ins (issue #933). Live-read per event arrival.
  (id: GapCalloutId) => (getGlobalSettings() as Record<string, unknown>)[GAP_CALLOUT_SETTING_KEYS[id]] !== false,
  // Shared gap-callout cooldown (issue #933) — 1–360 s, default 30.
  () => resolveGapCooldownMs((getGlobalSettings() as Record<string, unknown>).gapCalloutCooldownSeconds),
  // Live gaps resolver (issue #933) — spoken numbers read at speak time.
  () => getLiveGaps(),
```

- [ ] **Step 3:** Update imports in each plugin. Build everything:

Run: `cd /c/Users/Niklas/Projects/iRaceDeck/ir-933 && set -o pipefail && pnpm build 2>&1 | tail -5`
Expected: 22/22 green. (If a deck host app is running and the native build fails with EPERM, ask the user to quit it.)

- [ ] **Step 4: Commit** — `feat(plugins): wire gap callout settings, cooldown, and live-gaps resolver (#933)`

---

### Task 9: Session Info "Gaps" mode

**Files:**
- Modify: `packages/iracing-actions/src/actions/session-info/session-info.ts`
- Modify: `packages/iracing-actions/src/actions/session-info/session-info.test.ts`

**Interfaces:**
- Consumes: `getLiveGaps`, `type LiveGaps` from `@iracedeck/sim-events-iracing` (mock in tests like `getLivePosition`).
- Produces: mode value `"gaps"`; settings `gapShowAhead`/`gapShowBehind` (booleans, default true); `@internal` exports `formatGapValue(side: GapNeighbor | null): string` and `generateGapsGraphic(gaps: LiveGaps | null, showAhead: boolean, showBehind: boolean, fontSize: number | undefined, textColor: string): string`.

**Behavior:**
- Schema: add `"gaps"` to the mode enum; add both booleans with the union/transform pattern, `.default(true)`.
- `titleLabels`: add `gaps: "GAPS"`.
- `extractDisplayValue`: `gaps` branch returns a compact state string used ONLY for the state-key cache (the graphic carries the display, like track-wetness): `` `${fmt(ahead)}|${fmt(ahead.trend)}|${fmt(behind)}|${fmt(behind.trend)}` `` — build from `getLiveGaps()`; outside race/null → `"–|–"`. Null-telemetry default: `"–|–"`.
- `formatGapValue(side)`: `null` side → `"–"`; `lapDelta >= 1` → `` `${lapDelta}L` ``; `gapSeconds === null` → `"–"`; `< 99.95` → `gapSeconds.toFixed(1)`; else `String(Math.round(gapSeconds))`.
- `generateGapsGraphic`: two rows centered in the graphic area (row y's follow the telemetry-display `baseY = 88 + (size − 44) / 3`, `lineHeight = size * 1.2` two-line math from `generateValueContent`); each visible row = `▲`/`▼` marker + value in one `<text>`; row fill = `#2ecc71` when trend favors the player (`ahead` closing / `behind` opening), `#e74c3c` when against (`ahead` opening / `behind` closing), `textColor` when steady/null. One visible row renders at full `fontSize` (default 28), two rows at `Math.min(size, 30)`. Escape nothing dynamic (values are digits/`–`/`L`).
- `generateSessionInfoSvg`: route `settings.mode === "gaps"` through `graphicContent` (pass `gaps` data through the same optional-parameter channel as `trackWetnessState` — add a `liveGaps?: LiveGaps | null` parameter) and blank the value slot.
- `updateDisplayFromTelemetry`: fetch `getLiveGaps()` once per tick when mode is `gaps`, thread into the state key + svg call.

- [ ] **Step 1: Write failing tests**: schema accepts the mode + checkbox defaults (extend the CommonSettings mock's `defaults`/`validModes`); `formatGapValue` table (null side, lap marker, `1.2`, `–` cold start, `102` rounding); `generateGapsGraphic` (two rows when both on; one full-size row when one off; green fill for ahead-closing, red for behind-closing, plain for steady; `–` rows); `generateSessionInfoSvg` blanks the value slot for gaps (mirror the track-wetness test); an integration test driving the subscribe callback with mocked `getLiveGaps` (mirror `triggerPositionUpdate`).
- [ ] **Step 2: Verify failure.** `pnpm exec vitest run packages/iracing-actions/src/actions/session-info`
- [ ] **Step 3: Implement.** Update the `vi.mock("@iracedeck/sim-events-iracing")` block to add `getLiveGaps: vi.fn(() => null)`.
- [ ] **Step 4: Tests green.** Same command.
- [ ] **Step 5: Commit** — `feat(actions): Session Info Gaps mode with trend-colored rows (#933)`

---

### Task 10: Property Inspectors (session-info mode UI + pit-crew callout UI)

**Files:**
- Modify: `packages/iracing-actions/src/actions/session-info/session-info.ejs`
- Modify: `packages/iracing-actions/src/actions/pit-crew/pit-crew.ejs`

- [ ] **Step 1: session-info.ejs** — add `<option value="gaps">Gaps (Ahead/Behind)</option>` after the `irating` option; add the sub-settings block after `flags-settings`:

```html
		<sdpi-item id="gaps-settings" label="Show" class="hidden">
			<sdpi-checkbox setting="gapShowAhead" label="Gap ahead" default="true"></sdpi-checkbox>
			<sdpi-checkbox setting="gapShowBehind" label="Gap behind" default="true"></sdpi-checkbox>
		</sdpi-item>
		<div id="gaps-help" class="ird-supporting-text hidden">
			Time gap to the car one class position ahead/behind (race sessions only). Green = the gap is moving your way, red = against you.
		</div>
```

Extend `updateVisibility()`: `gapsSettings`/`gapsHelp` toggle on `mode !== "gaps"`.

- [ ] **Step 2: pit-crew.ejs** — add the family array next to `overtakeCallouts`:

```ejs
			// Gap callouts (issue #933). Trend flips + threshold crossings
			// against the class-standings neighbors, independently toggleable.
			var gapCallouts = [
				{ setting: "calloutEnabledGapTrend",     label: "Gap trend (gaining/losing)" },
				{ setting: "calloutEnabledGapThreshold", label: "Gap under threshold" },
			];
			var gapRowCount = Math.ceil(gapCallouts.length / 2);
			var gapCheckboxes = gapCallouts.map(function (c) {
				return '<sdpi-checkbox setting="' + c.setting + '" label="' + c.label + '" global default="true"></sdpi-checkbox>';
			}).join('');
```

And in the `Race Engineer Callouts` accordion content, after the `Overtakes` item:

```ejs
				'<sdpi-item label="Gaps">' +
					'<div style="display:grid;grid-template-rows:repeat(' + gapRowCount + ',auto);grid-auto-flow:column;gap:4px 12px;width:100%;">' +
						gapCheckboxes +
					'</div>' +
				'</sdpi-item>' +
				'<sdpi-item label="Gap alert threshold (s)">' +
					'<ird-range-input setting="gapAlertThresholdSeconds" min="0.5" max="3" step="0.1" default="1" global showlabels></ird-range-input>' +
				'</sdpi-item>' +
				'<div class="ird-supporting-text">The engineer calls out when the gap to the car ahead or behind first drops under this. Re-arms once the gap opens ~half a second beyond it.</div>' +
				'<sdpi-item label="Gap callout cooldown (s)">' +
					'<ird-range-input setting="gapCalloutCooldownSeconds" min="1" max="360" step="1" default="30" global showlabels></ird-range-input>' +
				'</sdpi-item>' +
				'<div class="ird-supporting-text">Minimum quiet time between any two gap callouts.</div>' +
```

- [ ] **Step 3: Build the Stream Deck plugin to compile the PI HTML** and eyeball the generated `ui/session-info.html` + `ui/pit-crew.html` for the new blocks:

Run: `cd /c/Users/Niklas/Projects/iRaceDeck/ir-933 && pnpm --filter @iracedeck/iracing-plugin-stream-deck build 2>&1 | tail -3 && grep -c "gapShowAhead" packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/ui/session-info.html && grep -c "calloutEnabledGapTrend" packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/ui/pit-crew.html`
Expected: both greps ≥ 1.

- [ ] **Step 4: Commit** — `feat(pi): Gaps mode settings and gap callout controls (#933)`

---

### Task 11: Scenario-harness shortcuts

**Files:**
- Modify: `packages/scenario-harness/src/scenario-shortcuts.ts`

- [ ] **Step 1:** Add a `Gaps` category with one shortcut per callout path:

```typescript
  // ── Gaps (issue #933) ──
  {
    id: "gap-trend-ahead-closing",
    category: "Gaps",
    label: "Trend: closing on car ahead",
    description: "Lap-over-lap gap ahead flipped to closing and held 2 laps.",
    event: "gap.trendChanged",
    data: { side: "ahead", direction: "closing", gapSeconds: 1.8, previousGapSeconds: 2.4, carIdx: 3, lap: 7 },
  },
  {
    id: "gap-trend-ahead-opening",
    category: "Gaps",
    label: "Trend: car ahead pulling away",
    event: "gap.trendChanged",
    data: { side: "ahead", direction: "opening", gapSeconds: 3.1, previousGapSeconds: 2.2, carIdx: 3, lap: 9 },
  },
  {
    id: "gap-trend-behind-closing",
    category: "Gaps",
    label: "Trend: car behind gaining",
    event: "gap.trendChanged",
    data: { side: "behind", direction: "closing", gapSeconds: 1.4, previousGapSeconds: 2.0, carIdx: 5, lap: 8 },
  },
  {
    id: "gap-trend-behind-opening",
    category: "Gaps",
    label: "Trend: dropping the car behind",
    event: "gap.trendChanged",
    data: { side: "behind", direction: "opening", gapSeconds: 2.8, previousBapSeconds: 2.0, carIdx: 5, lap: 8 },
  },
  {
    id: "gap-threshold-ahead",
    category: "Gaps",
    label: "Caught the car ahead (threshold)",
    event: "gap.thresholdCrossed",
    data: { side: "ahead", gapSeconds: 0.9, thresholdSeconds: 1.0, carIdx: 3 },
  },
  {
    id: "gap-threshold-behind",
    category: "Gaps",
    label: "Car behind within threshold",
    event: "gap.thresholdCrossed",
    data: { side: "behind", gapSeconds: 0.8, thresholdSeconds: 1.0, carIdx: 5 },
  },
```

(Note: fix the deliberate typo `previousBapSeconds` → `previousGapSeconds` when writing — it is here to remind the implementer to type-check payloads against the catalog rather than paste blindly.)

- [ ] **Step 2:** Build the harness; run it briefly if practical (`pnpm --filter @iracedeck/scenario-harness dev`) to confirm the buttons appear. Otherwise the compile-time `SimEventName` typing on `event` is the safety net.
- [ ] **Step 3: Commit** — `feat(harness): gap callout shortcut buttons (#933)`

---### Task 12: Docs, website, changelog, rules, skill data

**Files:**
- Modify: `packages/website/src/content/docs/docs/actions/display-session/session-info.md`
- Modify: `packages/website/src/content/docs/docs/actions/audio-voice/pit-crew.md`
- Modify: `packages/website/src/content/docs/changelog.mdx`
- Modify: `docs/reference/actions.json`
- Modify: `README.md`
- Modify: `.claude/rules/race-engineer-callout-examples.md`

- [ ] **Step 1: session-info.md** — badge `"9 modes"` → `"10 modes"`; add `gaps` to the description list; add a `### Gaps` mode section (before Track Wetness, following the Position section's format exactly): what it shows (time gap to the car one class position ahead/behind, race only, `–` otherwise, `NL` lap marker), trend colors (green = moving your way), `#### Details` bullets (Dial: No rotation support / Default binding: No keyboard binding / Telemetry-aware icon: Yes), `#### Setting: Show` (two checkboxes, both default on), `#### Setting: Font Size` (standard wording).
- [ ] **Step 2: pit-crew.md** — add a `## Gap callouts (car ahead / car behind)` family section (near Overtakes/Race Position Status) describing both callouts, the threshold + hysteresis + cooldown model, the two-sided suppression, and the settings (`calloutEnabledGapTrend`, `calloutEnabledGapThreshold`, `gapAlertThresholdSeconds` 0.5–3 default 1.0, `gapCalloutCooldownSeconds` 1–360 default 30); add the two checkboxes to the `## Race Engineer Callouts (per-subject opt-in/out)` list.
- [ ] **Step 3: changelog.mdx** — add a `**Features**` group above the existing `**Bug Fixes**` in the `## 2.4.0` section:

```markdown
**Features**

- Session Info gains a Gaps mode showing the live time gap to the car one class position ahead and behind, color-coded green or red by whether each gap is moving in your favor, and the Race Engineer announces sustained gap-trend changes and when a gap first closes under a configurable threshold — with a configurable cooldown between gap callouts.
```

- [ ] **Step 4: actions.json** — in the session-info modes array: add the missing `irating` entry (`{ "value": "irating", "label": "iRating Gain/Loss", "description": "Estimated iRating change for the current race, green for gain / red for loss" }`, after `position`) AND the new `{ "value": "gaps", "label": "Gaps", "description": "Live time gap to the car one class position ahead/behind with gaining/losing trend colors (race sessions only)" }`.
- [ ] **Step 5: README.md** — line 29 `**265+ modes**` → recount is not tracked precisely; bump the Display & Session row `8` → `10` and adjust the total (+2 for irating already shipped but uncounted, +1 gaps → verify arithmetic against the row values and keep `265+` unless the real sum is now higher; update Examples cell to mention gaps).
- [ ] **Step 6: race-engineer-callout-examples.md** — add an entry: `#933 — gap trend/threshold callouts: first source-side episodic emitter (hysteresis + arming in the diff, cooldown claimed audio-side); reuses lap-time number pools for spoken seconds; two-sided suppression (neighbor gating at emission, player gating via overtake-gate at where:)`. Follow the file's existing entry format.
- [ ] **Step 7: Verify website builds**: `pnpm --filter @iracedeck/website build` — must pass (MDX is strict).
- [ ] **Step 8: Commit** — `docs: gap support documentation, changelog, and action catalog (#933)`

---

### Task 13: Full verification + spec self-review

- [ ] **Step 1:** `cd /c/Users/Niklas/Projects/iRaceDeck/ir-933 && set -o pipefail && pnpm build --force 2>&1 | tail -5` — 22/22 green (force: deck-core schema changed).
- [ ] **Step 2:** `pnpm test 2>&1 | tail -6` — all green.
- [ ] **Step 3:** `pnpm lint 2>&1 | tail -5 && pnpm format:check 2>&1 | tail -5` (or the repo's equivalents) — clean.
- [ ] **Step 4:** Re-read issue #933 top to bottom; check every Behavior bullet against the code. Known intentional deviations to confirm are documented: no EstTime cold-start estimate in v1 (display shows `–` on lap 1; the issue lists lap-one fallback quality as an open question — record the decision in the PR body).
- [ ] **Step 5:** Commit any fixes; report to the user for manual iRacing testing. **Do not push or open a PR** — after manual testing the user will be asked about `code-review xhigh --fix`, and PR creation only happens on explicit approval.
