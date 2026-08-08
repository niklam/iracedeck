# Opponent-Pit Callouts (#622) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Race Engineer announces when other drivers enter the pits — the leader plus same-lap competitors within ±2 effective positions — with 12 s burst aggregation so oval caution pit trains collapse to one line.

**Architecture:** A new translator diff detects per-car `CarIdxTrackSurface` transitions into `TrkLoc.AproachingPits`, classifies each car against the canonical frozen order, and emits one `opponentPit.entered` bus event with a `relation` payload. Five scenarios (two families, so the aggregate can't preempt the leader line) speak the lines; the ±2 position number resolves at speak time via a new `getLiveCarPosition` translator export. Two default-on opt-ins wired in all three plugins.

**Tech Stack:** TypeScript monorepo (pnpm + turbo), Vitest, Zod, EJS PI templates, ElevenLabs TTS generation.

**Spec:** `docs/superpowers/specs/2026-08-06-opponent-pit-callouts-design.md` (approved). Worktree: `C:\Users\Niklas\Projects\iRaceDeck\ir-622`, branch `ir-622`.

## Global Constraints

- Sessions: races only — diff gates on `isRaceSession && !replayOnlySession && !preGreen`; baselines advance every tick so gated transitions are absorbed, never replayed.
- Multi-class: class space — only same-class cars qualify; positions via `classPositionFromOrder` on the frozen order; "the leader" = class P1.
- Constants: `OPPONENT_PIT_AGGREGATE_WINDOW_MS = 12_000`, `OPPONENT_PIT_AGGREGATE_THRESHOLD = 3`, `OPPONENT_PIT_CAR_COOLDOWN_MS = 30_000`, scenario `weight: 65`, `interrupt: false`, `queueable: true`.
- Setting keys: `calloutEnabledOpponentPitLeader`, `calloutEnabledOpponentPitNearby` — both default `true`.
- Scenario ids: `pit-crew.opponent-pit-{leader|ahead|behind|nearby|others}`; families `opponent-pit-leader` (leader only) and `opponent-pit` (the other four).
- Never use `CarIdxOnPitRoad` for detection (documented unreliable in `diff/race-finish.ts`); never compute positions outside the canonical frozen order (`race-positions.md`).
- The sim enum member is spelled `AproachingPits` (one "p") — preserve it.
- `pnpm build` (tsc) catches what vitest misses — run it per task where types shift; run `pnpm build --force` after the `GlobalSettingsSchema` change (turbo caches deck-core). Full builds may fail with EPERM if UlanziStudio/Stream Deck is running (native `.node` lock) — quit the host app first.
- All commits happen in the `ir-622` worktree (`git -C C:/Users/Niklas/Projects/iRaceDeck/ir-622 …` or run from that cwd). Conventional commit prefixes.
- ElevenLabs generation is paid: dry-run first, **stop for Niklas's wording review** before `generate` (Task 8).
- Markdown: fenced blocks need language identifiers; no hard-wrapped paragraphs in docs.

---

### Task 1: Bus event + harness event template

The scenario-harness has a compile-time completeness check over `SimEventMap`, so the catalog entry and the harness template must land in the same commit or `pnpm build` fails.

**Files:**
- Modify: `packages/event-bus/src/event-catalog.ts` (union near `RadarState` ~line 44; map entry in the §6.1 transition section near `"pitBox.countdown"` ~line 304)
- Modify: `packages/event-bus/src/index.ts` (export the new type)
- Modify: `packages/scenario-harness/src/event-names.ts` (new template)

**Interfaces:**
- Produces: `OpponentPitRelation = "leader" | "ahead" | "behind" | "nearby" | "others"`; `SimEventMap["opponentPit.entered"]` with payload `{ relation: OpponentPitRelation; carIdx?: number; position?: number; isMultiClass?: boolean }`.

- [ ] **Step 1: Add the relation union + map entry to `event-catalog.ts`**

Next to the other string unions (after `FlagScope`):

```typescript
/**
 * Who a pitting opponent is relative to the player (issue #622). `"others"`
 * is the aggregate tail once 3+ qualifying cars entered within the window.
 */
export type OpponentPitRelation = "leader" | "ahead" | "behind" | "nearby" | "others";
```

In the §6.1 transition-events section, after the `"pitBox.countdown"` entry:

```typescript
  /**
   * Another driver is entering the pits (issue #622): a car's
   * `CarIdxTrackSurface` transitioned INTO `TrkLoc.AproachingPits`. Announced
   * for the leader plus same-lap cars within ±2 effective positions of the
   * player (class space in multi-class, #588). `position` is the car's
   * effective position at emit time — consumers prefer a live speak-time read
   * and use this as the fallback. `carIdx`/`position` are absent for the
   * `"others"` aggregate.
   */
  "opponentPit.entered": SimEvent<
    "opponentPit.entered",
    {
      relation: OpponentPitRelation;
      carIdx?: number;
      position?: number;
      isMultiClass?: boolean;
    }
  >;
```

- [ ] **Step 2: Export the type from `packages/event-bus/src/index.ts`**

Find the existing catalog type exports (grep `RadarState`) and add `OpponentPitRelation` alongside (type-only union, so a `type` export is correct).

- [ ] **Step 3: Add the harness event template**

In `packages/scenario-harness/src/event-names.ts`, in the transition-events section (the `── Pit lane / stall ──` banner group is the natural home):

```typescript
  {
    name: "opponentPit.entered",
    description: "Another driver is entering the pits (issue #622) — relation: leader / ahead / behind / nearby / others",
    data: { relation: "leader", carIdx: 3, position: 1 },
  },
```

- [ ] **Step 4: Verify the completeness check passes**

Run: `pnpm --filter @iracedeck/event-bus build && pnpm --filter @iracedeck/scenario-harness build`
Expected: both succeed. (Before Step 3 the harness build would fail with the missing-name type error — that failure IS the test for the mechanism.)

- [ ] **Step 5: Commit**

```bash
git add packages/event-bus/src/event-catalog.ts packages/event-bus/src/index.ts packages/scenario-harness/src/event-names.ts
git commit -m "feat(event-bus): add opponentPit.entered event (#622)"
```

---

### Task 2: Translator state + opponent-pit diff + handleTick wiring

**Files:**
- Modify: `packages/sim-events-iracing/src/state.ts` (TranslatorState type AND `createInitialState()` — keep in sync)
- Create: `packages/sim-events-iracing/src/diff/opponent-pit.ts`
- Create: `packages/sim-events-iracing/src/diff/opponent-pit.test.ts`
- Modify: `packages/sim-events-iracing/src/translator.ts` (call site after `calculateFrozenRacePositions` ~line 1458; `resolvePaceCarIdx` helper near `resolvePlayerCarIdx` ~line 1587)
- Modify: `packages/sim-events-iracing/src/index.ts` (export the new constants alongside `PIT_APPROACH_COOLDOWN_MS`)

**Interfaces:**
- Consumes: `SimEventMap["opponentPit.entered"]` (Task 1); `calculateFrozenRacePositions(state, telemetry): number[]` and `classPositionFromOrder(positions, carIdxClass, carIdx): number` (existing); `isPreGreen(telemetry)` from `@iracedeck/iracing-sdk`.
- Produces: `diffOpponentPit(state, telemetry, playerCarIdx, paceCarIdx, isRaceSession, replayOnlySession, preGreen, isMultiClass, frozenPositions, now, emit): void`; state fields `opponentPitInitialized`, `opponentPitLastSurface`, `opponentPitCarCooldownUntil`, `opponentPitRecentEntries`, `opponentPitAggregateAnnounced`; constants `OPPONENT_PIT_AGGREGATE_WINDOW_MS`, `OPPONENT_PIT_AGGREGATE_THRESHOLD`, `OPPONENT_PIT_CAR_COOLDOWN_MS`.

- [ ] **Step 1: Add state fields**

In `TranslatorState` (after the self-managed running-order block ~line 526):

```typescript
  // ── Opponent pit entries (issue #622) ──
  /** First eligible tick seeds the per-car surface baseline silently. */
  opponentPitInitialized: boolean;
  /** Previous-tick `CarIdxTrackSurface` per carIdx. */
  opponentPitLastSurface: number[];
  /** Per-car re-announce cooldown deadlines (epoch ms), indexed by carIdx. */
  opponentPitCarCooldownUntil: number[];
  /** Timestamps (epoch ms) of qualifying pit entries in the rolling window. */
  opponentPitRecentEntries: number[];
  /** Whether the aggregate tail already fired for the current episode. */
  opponentPitAggregateAnnounced: boolean;
```

In `createInitialState()` (matching position):

```typescript
    opponentPitInitialized: false,
    opponentPitLastSurface: [],
    opponentPitCarCooldownUntil: [],
    opponentPitRecentEntries: [],
    opponentPitAggregateAnnounced: false,
```

No `wipeStateForReplay` / `resetPerSessionState` preservation — a wholesale reset is correct (baselines reseed on the next live tick).

- [ ] **Step 2: Write the failing diff tests**

Create `packages/sim-events-iracing/src/diff/opponent-pit.test.ts`, calling the diff directly with explicit `now` (the `pit-lane.test.ts` pattern — the only way to advance simulated time). Helper + representative cases (implement all listed):

```typescript
import { TrkLoc } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import {
  diffOpponentPit,
  OPPONENT_PIT_AGGREGATE_THRESHOLD,
  OPPONENT_PIT_AGGREGATE_WINDOW_MS,
  OPPONENT_PIT_CAR_COOLDOWN_MS,
} from "./opponent-pit.js";
import type { PendingEvent } from "./types.js";

const PLAYER = 0;

/** 8-car field: player P4; positions by carIdx = [4, 1, 2, 3, 5, 6, 7, 8]. */
function makeField(overrides: Partial<Record<string, unknown>> = {}) {
  const n = 8;
  return {
    CarIdxTrackSurface: Array<number>(n).fill(TrkLoc.OnTrack),
    CarIdxLapCompleted: Array<number>(n).fill(10),
    CarIdxLapDistPct: [0.4, 0.9, 0.8, 0.6, 0.3, 0.2, 0.1, 0.05],
    CarIdxClass: Array<number>(n).fill(100),
    ...overrides,
  } as never;
}

/** frozenPositions indexed by carIdx (1-based ranks). */
const POSITIONS = [4, 1, 2, 3, 5, 6, 7, 8];

function run(
  state: TranslatorState,
  telemetry: never,
  now: number,
  opts: Partial<{ isRace: boolean; replay: boolean; preGreen: boolean; multi: boolean; pace: number | null }> = {},
): PendingEvent[] {
  const out: PendingEvent[] = [];
  diffOpponentPit(
    state,
    telemetry,
    PLAYER,
    opts.pace ?? null,
    opts.isRace ?? true,
    opts.replay ?? false,
    opts.preGreen ?? false,
    opts.multi ?? false,
    POSITIONS,
    now,
    (ev) => out.push(ev),
  );
  return out;
}

describe("diffOpponentPit", () => {
  let state: TranslatorState;

  beforeEach(() => {
    state = createInitialState();
  });

  it("seeds silently on the first tick, even with a car already approaching", () => {
    const t = makeField();
    (t as { CarIdxTrackSurface: number[] }).CarIdxTrackSurface[3] = TrkLoc.AproachingPits;
    expect(run(state, t, 1000)).toEqual([]);
    expect(state.opponentPitInitialized).toBe(true);
  });

  it("emits ahead for the car one effective position ahead", () => {
    run(state, makeField(), 1000);
    const t = makeField();
    (t as { CarIdxTrackSurface: number[] }).CarIdxTrackSurface[3] = TrkLoc.AproachingPits; // carIdx 3 = P3, player P4
    const out = run(state, t, 2000);
    expect(out).toEqual([
      { event: "opponentPit.entered", data: { relation: "ahead", carIdx: 3, position: 3, isMultiClass: false } },
    ]);
  });
});
```

Full case list to implement (one `it` each):

1. First-tick silent seed (above).
2. Relation mapping: carIdx 3 (P3) → `ahead`; carIdx 4 (P5) → `behind`; carIdx 2 (P2) → `nearby` with `position: 2`; carIdx 5 (P6) → `nearby` with `position: 6`; carIdx 1 (P1) → `leader`.
3. Out of window: carIdx 6 (P7) and carIdx 7 (P8) → no emission.
4. Leader exempt from same-lap: leader with `CarIdxLapCompleted[1] = 20` (10 laps ahead) still emits `leader`.
5. Same-lap filter: carIdx 2 (P2, nearby) with `CarIdxLapCompleted[2] = 11` and player at 10 with `CarIdxLapDistPct` making score gap ≥ 1.0 → silent; gap < 1.0 (e.g. lc 11/dp 0.1 vs lc 10/dp 0.4 → 11.1 − 10.4 = 0.7) → emits.
6. Multi-class: `multi: true`, other-class car (different `CarIdxClass`) at ±1 → silent; same-class car → emits with class-space position.
7. Player and pace car skipped: transitions on `PLAYER` and on `opts.pace` carIdx → silent.
8. Not-in-world skipped: `CarIdxLapCompleted[i] = -1` → silent.
9. Per-car cooldown: same car re-enters approach state at `+5_000` (after leaving) → silent; at `+OPPONENT_PIT_CAR_COOLDOWN_MS + 1` → emits again.
10. No re-emit while staying in the state: consecutive ticks with the car still `AproachingPits` → one emission total.
11. Aggregation: three different qualifying cars entering at t, t+1000, t+2000 → first two individual, third emits exactly `{ relation: "others" }` (no `carIdx`/`position`); a fourth at t+3000 → silent.
12. Leader mid-aggregation: cars A, B enter, then C (non-leader) → aggregate; then the leader enters at t+4000 → `leader` emitted individually.
13. Episode reset: after 11, advance `now` past `OPPONENT_PIT_AGGREGATE_WINDOW_MS` of quiet (run a tick with no transitions), then a new entry → individual again and a later third entry re-aggregates (flag lowered).
14. Gating: `isRace: false`, `replay: true`, or `preGreen: true` → silent, and the baseline still advances (a transition during the gate does not replay when the gate opens).
15. Missing arrays: telemetry without `CarIdxTrackSurface` → no crash, no emission.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm exec vitest run packages/sim-events-iracing/src/diff/opponent-pit.test.ts`
Expected: FAIL — module `./opponent-pit.js` not found.

- [ ] **Step 4: Implement `diff/opponent-pit.ts`**

```typescript
/**
 * Opponent pit-entry callouts (issue #622).
 *
 * Detects each car's `CarIdxTrackSurface` transition INTO
 * `TrkLoc.AproachingPits` against a per-car previous-tick baseline and emits
 * `opponentPit.entered` for the cars that matter: the (class) leader, and
 * same-lap cars within ±2 effective positions of the player. Never keys on
 * `CarIdxOnPitRoad` — real telemetry shows it reading true for on-track cars
 * (see the header of `race-finish.ts`).
 *
 * **Effective positions.** Ranks come from the canonical frozen order
 * (`calculateFrozenRacePositions`, threaded in by the translator — the
 * `diffOvertakes` slot) per `race-positions.md`; class ranks derive from the
 * same order via `classPositionFromOrder` (#588's class space).
 *
 * **Aggregation (the oval safety valve).** The incident-burst shape: a rolling
 * list of qualifying-entry timestamps pruned to the last 12 s on every tick.
 * Entries 1–2 in a window announce individually; a 3rd non-leader entry emits
 * one `"others"` aggregate per episode; later entries stay silent until the
 * window has been quiet for 12 s. The leader always announces individually
 * (leader-first, per the issue) and still counts toward the window total.
 *
 * **Gating in the diff** (the `diffPitsOpen` precedent): race sessions only,
 * replay-only sessions suppressed (#604), pre-green suppressed (#647 — grid
 * shuffles produce meaningless positions). Baselines advance every tick so a
 * gated transition is absorbed, never replayed when the gate opens.
 */
import { classPositionFromOrder, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/** Rolling window for counting near-simultaneous qualifying pit entries. */
export const OPPONENT_PIT_AGGREGATE_WINDOW_MS = 12_000;

/** Qualifying entries within the window at which enumeration collapses. */
export const OPPONENT_PIT_AGGREGATE_THRESHOLD = 3;

/** Per-car re-announce cooldown — a car crawling across the approach-zone boundary can't re-fire. */
export const OPPONENT_PIT_CAR_COOLDOWN_MS = 30_000;

type Classification = {
  relation: "leader" | "ahead" | "behind" | "nearby";
  position: number;
};

function classify(
  telemetry: TelemetryData,
  positions: number[],
  playerCarIdx: number,
  carIdx: number,
  isMultiClass: boolean,
): Classification | null {
  const carClasses = telemetry.CarIdxClass;

  // Multi-class: only same-class cars are rivals; positions are class space.
  if (isMultiClass) {
    const playerClass = carClasses?.[playerCarIdx];
    const carClass = carClasses?.[carIdx];

    if (playerClass === undefined || carClass === undefined || playerClass !== carClass) return null;
  }

  const carPos = isMultiClass ? classPositionFromOrder(positions, carClasses, carIdx) : (positions[carIdx] ?? 0);

  if (carPos <= 0) return null;

  // The (class) leader always qualifies — no same-lap or window check.
  if (carPos === 1) return { relation: "leader", position: 1 };

  const playerPos = isMultiClass
    ? classPositionFromOrder(positions, carClasses, playerCarIdx)
    : (positions[playerCarIdx] ?? 0);

  if (playerPos <= 0) return null;

  // Same lap: lap-progress scores within one full lap. Raw `CarIdxLap`
  // equality misbehaves around S/F crossings; the score form is what the
  // position machinery ranks by.
  const lc = telemetry.CarIdxLapCompleted;
  const dp = telemetry.CarIdxLapDistPct;
  const carLc = lc?.[carIdx] ?? -1;
  const playerLc = lc?.[playerCarIdx] ?? -1;

  if (carLc < 0 || playerLc < 0) return null;

  const scoreGap = Math.abs(carLc + (dp?.[carIdx] ?? 0) - (playerLc + (dp?.[playerCarIdx] ?? 0)));

  if (scoreGap >= 1.0) return null;

  const delta = carPos - playerPos;

  if (delta === -1) return { relation: "ahead", position: carPos };
  if (delta === 1) return { relation: "behind", position: carPos };
  if (delta === -2 || delta === 2) return { relation: "nearby", position: carPos };

  return null;
}

export function diffOpponentPit(
  state: TranslatorState,
  telemetry: TelemetryData,
  playerCarIdx: number,
  paceCarIdx: number | null,
  isRaceSession: boolean,
  replayOnlySession: boolean,
  preGreen: boolean,
  isMultiClass: boolean,
  frozenPositions: number[],
  now: number,
  emit: EmitFn,
): void {
  // Prune the aggregation window every tick; 12 s of quiet ends the episode.
  if (state.opponentPitRecentEntries.length > 0) {
    state.opponentPitRecentEntries = state.opponentPitRecentEntries.filter(
      (t) => now - t <= OPPONENT_PIT_AGGREGATE_WINDOW_MS,
    );

    if (state.opponentPitRecentEntries.length === 0) {
      state.opponentPitAggregateAnnounced = false;
    }
  }

  const ts = telemetry.CarIdxTrackSurface as number[] | undefined;

  if (!ts) return;

  // First tick — seed the per-car baseline without firing.
  if (!state.opponentPitInitialized) {
    state.opponentPitInitialized = true;
    state.opponentPitLastSurface = ts.slice();

    return;
  }

  const prev = state.opponentPitLastSurface;

  // Advance the baseline every tick, even when gated, so a transition during a
  // non-race / replay / pre-green window never replays once the gate opens.
  state.opponentPitLastSurface = ts.slice();

  const gated = !isRaceSession || replayOnlySession || preGreen;

  if (gated) return;

  const lc = telemetry.CarIdxLapCompleted;
  const dp = telemetry.CarIdxLapDistPct;

  for (let i = 0; i < ts.length; i++) {
    if (i === playerCarIdx || i === paceCarIdx) continue;
    if (ts[i] !== TrkLoc.AproachingPits || prev[i] === TrkLoc.AproachingPits || prev[i] === undefined) continue;
    // In-world test (the race-finish.ts shape) — blipped/vanished cars skip.
    if ((lc?.[i] ?? -1) < 0 || (dp?.[i] ?? -1) < 0) continue;
    if (now < (state.opponentPitCarCooldownUntil[i] ?? 0)) continue;

    const c = classify(telemetry, frozenPositions, playerCarIdx, i, isMultiClass);

    if (!c) continue;

    state.opponentPitCarCooldownUntil[i] = now + OPPONENT_PIT_CAR_COOLDOWN_MS;
    state.opponentPitRecentEntries.push(now);

    if (c.relation === "leader") {
      // Leader-first: always individual, even mid-aggregation.
      emit({
        event: "opponentPit.entered",
        data: { relation: "leader", carIdx: i, position: c.position, isMultiClass },
      });
      continue;
    }

    if (state.opponentPitRecentEntries.length < OPPONENT_PIT_AGGREGATE_THRESHOLD) {
      emit({
        event: "opponentPit.entered",
        data: { relation: c.relation, carIdx: i, position: c.position, isMultiClass },
      });
    } else if (!state.opponentPitAggregateAnnounced) {
      // 3rd+ qualifying entry: collapse to the aggregate tail, once per episode.
      state.opponentPitAggregateAnnounced = true;
      emit({ event: "opponentPit.entered", data: { relation: "others" } });
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/sim-events-iracing/src/diff/opponent-pit.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Wire into `handleTick` + add `resolvePaceCarIdx`**

In `translator.ts`, immediately after `const frozenPositions = calculateFrozenRacePositions(self.state, telemetry);` (~line 1458, BEFORE `diffOvertakes` is fine — both only read the vector):

```typescript
    // Opponent pit entries (issue #622) — consumes the same canonical frozen
    // order as diffOvertakes on the same tick.
    diffOpponentPit(
      self.state,
      telemetry,
      playerCarIdx,
      resolvePaceCarIdx(sessionInfo),
      isRaceSession,
      replayOnlySession,
      isPreGreen(telemetry),
      resolveIsMultiClass(sessionInfo) === true,
      frozenPositions,
      now,
      emit,
    );
```

Add the import of `diffOpponentPit` next to the other diff imports, and `isPreGreen` to the existing `@iracedeck/iracing-sdk` import (grep — it may already be imported for the overtake gate). Add the helper near `resolvePlayerCarIdx` (~line 1587), unless one already exists (grep `CarIsPaceCar` in `translator.ts` first and reuse):

```typescript
/**
 * CarIdx of the pace car from session YAML (`DriverInfo.Drivers[].CarIsPaceCar`),
 * or null when unresolvable. The pace car drives into the pits when picking up
 * the field, which must never announce as an opponent pit entry (issue #622).
 */
function resolvePaceCarIdx(sessionInfo: Record<string, unknown> | null): number | null {
  const drivers = (
    sessionInfo as { DriverInfo?: { Drivers?: Array<{ CarIdx?: number; CarIsPaceCar?: number }> } } | null
  )?.DriverInfo?.Drivers;

  if (!Array.isArray(drivers)) return null;

  for (const d of drivers) {
    if (d?.CarIsPaceCar === 1 && typeof d.CarIdx === "number") return d.CarIdx;
  }

  return null;
}
```

Re-export the three constants from `packages/sim-events-iracing/src/index.ts` next to `PIT_APPROACH_COOLDOWN_MS` (grep it, ~line 52).

- [ ] **Step 7: Build + full package tests**

Run: `pnpm --filter @iracedeck/sim-events-iracing build && pnpm exec vitest run packages/sim-events-iracing`
Expected: build green (state type + init in sync), all tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/sim-events-iracing/src/state.ts packages/sim-events-iracing/src/diff/opponent-pit.ts packages/sim-events-iracing/src/diff/opponent-pit.test.ts packages/sim-events-iracing/src/translator.ts packages/sim-events-iracing/src/index.ts
git commit -m "feat(sim-events): detect opponent pit entries with burst aggregation (#622)"
```

---

### Task 3: `getLiveCarPosition` translator export

**Files:**
- Modify: `packages/sim-events-iracing/src/translator.ts` (after `getLivePosition`, ~line 764)
- Modify: `packages/sim-events-iracing/src/index.ts` (export)
- Modify: `packages/sim-events-iracing/src/translator.test.ts` (new describe block — mirror the existing `getLivePosition` tests; grep `getLivePosition` there for the setup pattern)
- Modify: `.claude/rules/race-positions.md` (consumer list)

**Interfaces:**
- Produces: `getLiveCarPosition(carIdx: number): LivePosition | null` — the per-car sibling of `getLivePosition()`; same `{ position, classPosition, isMultiClass }` shape.

- [ ] **Step 1: Write the failing test**

In `translator.test.ts`, next to the `getLivePosition` tests (reuse their initialize/teardown helpers verbatim — grep `describe("getLivePosition"` and mirror the telemetry fixture):

```typescript
describe("getLiveCarPosition", () => {
  it("returns the live position of an arbitrary car from the canonical order", () => {
    // Same fixture as the getLivePosition happy-path test; assert on a
    // NON-player carIdx whose rank the fixture establishes.
    // expect(getLiveCarPosition(otherCarIdx)).toEqual({ position: <rank>, classPosition: <rank>, isMultiClass: false });
  });

  it("returns null for an unranked car and for invalid indices", () => {
    // expect(getLiveCarPosition(63)).toBeNull();  // not in world in the fixture
    // expect(getLiveCarPosition(-1)).toBeNull();
  });
});
```

(The comment placeholders above are for the fixture values the existing test file provides — copy the concrete numbers from the neighbouring `getLivePosition` test when writing it; the assertions themselves must be real.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/sim-events-iracing/src/translator.test.ts`
Expected: FAIL — `getLiveCarPosition` is not exported.

- [ ] **Step 3: Implement**

After `getLivePosition` in `translator.ts`:

```typescript
/**
 * Live position of an ARBITRARY car from the same canonical frozen order as
 * {@link getLivePosition} (issue #622 — the opponent-pit "P{n}" number resolves
 * at speak time). Returns `null` when telemetry isn't resolvable, `carIdx` is
 * invalid, or the car has no rank in the order. `classPosition` is `0` when
 * underivable (no `CarIdxClass`) — there is no official per-car fallback here;
 * consumers fall back to their emit-time payload instead.
 */
export function getLiveCarPosition(carIdx: number): LivePosition | null {
  if (!instance || !instance.latestTelemetry) return null;
  if (!Number.isInteger(carIdx) || carIdx < 0) return null;

  const telemetry = instance.latestTelemetry;
  const positions = calculateFrozenRacePositions(instance.state, telemetry);
  const position = positions[carIdx] ?? 0;

  if (position <= 0) return null;

  const classPosition = classPositionFromOrder(positions, telemetry.CarIdxClass, carIdx);
  const sessionInfo = instance.controller.getSessionInfo() as Record<string, unknown> | null;

  return {
    position,
    classPosition: classPosition > 0 ? classPosition : 0,
    isMultiClass: resolveIsMultiClass(sessionInfo) === true,
  };
}
```

Export from `src/index.ts` next to `getLivePosition`.

- [ ] **Step 4: Run tests, then update `race-positions.md`**

Run: `pnpm exec vitest run packages/sim-events-iracing/src/translator.test.ts`
Expected: PASS.

Append to the "Current consumers" list in `.claude/rules/race-positions.md`: `- **Opponent-pit callouts** (#622) — the diff classifies pitting cars against the frozen order; the spoken "P{n}" resolves at speak time via getLiveCarPosition(carIdx) (the per-car sibling of getLivePosition).`

- [ ] **Step 5: Commit**

```bash
git add packages/sim-events-iracing/src/translator.ts packages/sim-events-iracing/src/index.ts packages/sim-events-iracing/src/translator.test.ts .claude/rules/race-positions.md
git commit -m "feat(sim-events): getLiveCarPosition export for speak-time reads (#622)"
```

---

### Task 4: Audio scenarios — pools, scenario file, vars, family wiring

**Files:**
- Create: `packages/audio-scenarios/src/catalog/pit-crew/opponent-pit.ts`
- Create: `packages/audio-scenarios/src/catalog/pit-crew/opponent-pit.test.ts`
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/pools.ts` (6 entries)
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/index.ts` (imports, params 41+42, registration loop, re-exports)
- Modify: `packages/audio-scenarios/src/index.ts` (public re-exports — mirror how `CORNER_NAME_CALLOUT_SETTING_KEYS` reaches plugins; grep it)
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/register-pit-crew.test.ts` (insert 2 args + new family coverage)
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/rolling-start.test.ts`, `start-lights.test.ts` (insert 2 `undefined,` lines each)

**Interfaces:**
- Consumes: `SimEventOf<"opponentPit.entered">` (Task 1); `poolRef`, `Scenario`, `Step`, `IScenarioEngine`, `wrapWithMaster`/`wrapCalloutScenario` (existing).
- Produces: `OpponentPitSnapshot = { position: number }`; `OpponentPitSnapshotResolver = () => OpponentPitSnapshot | null`; `OpponentPitCalloutId = "leader" | "nearby"`; `OPPONENT_PIT_CALLOUT_SETTING_KEYS`; `OPPONENT_PIT_ALERTS`; `registerOpponentPitVars(engine, getSnapshot)`; `registerPitCrew` params 41 `getOpponentPitCalloutEnabled` + 42 `getOpponentPitSnapshot` (masters shift to 43/44).

- [ ] **Step 1: Write the failing scenario test**

`opponent-pit.test.ts` — mirror `pit-window`'s catalog test style (grep an existing family test for the engine/manifest fixtures). Cases:

1. `OPPONENT_PIT_ALERTS` has 5 scenarios with the exact ids; leader has `family: "opponent-pit-leader"`, the other four `family: "opponent-pit"`; all have `weight: 65`, `interrupt: false`, `queueable: true`.
2. Each scenario's `where:` accepts only its own relation (feed each of the 5 relations through each `where:`).
3. `registerOpponentPitVars` + a snapshot `{ position: 4 }` → the `opponentPit.number` var resolves to `pool:position-number/4`; snapshot `null` → var returns `null`.
4. `SCENARIO_ID_TO_OPPONENT_PIT_ID` maps leader → `"leader"` and the other four → `"nearby"`; `OPPONENT_PIT_CALLOUT_SETTING_KEYS` matches the two Zod key names.
5. Nearby sequence order is exactly `["@pit-crew.radio-open", "pool:opponent-pit-car-in", { var: "opponentPit.number" }, "pool:opponent-pit-is-pitting", "@pit-crew.radio-close"]`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/audio-scenarios/src/catalog/pit-crew/opponent-pit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `opponent-pit.ts`**

```typescript
/**
 * Opponent pit-entry family (issue #622) — "The leader is pitting.", "The car
 * ahead/behind is pitting.", "The car in, P4, is pitting.", and the aggregate
 * "other cars pitting as well" tail. Fired off `opponentPit.entered`, branched
 * on `relation` (one event, five scenarios — the flag-family shape, keeping
 * every variant firable from the scenario harness).
 *
 * **Two families.** The leader scenario is `family: "opponent-pit-leader"`;
 * the other four share `family: "opponent-pit"`. Family preemption replaces an
 * in-flight family-mate regardless of weight, and a caution pit train emits
 * leader + aggregate in the same flush — one family would cut the leader line
 * mid-sentence. Separate families play the issue's desired sequence: leader
 * first, aggregate appended. (race-status / race-end set the two-families-one-
 * trigger precedent.)
 *
 * **Weight 65, interrupt false, queueable true** — the pit-window scheduling:
 * strategic info above chatter, below flags; never cuts; defers rather than
 * drops.
 *
 * **Speak-time number.** The nearby scenario's position resolves through the
 * `opponentPit.number` var from a plugin-owned snapshot (live canonical read
 * with emit-time payload fallback, composed in the plugin resolver). A null
 * snapshot aborts the whole callout at expansion (#835) — never a fragment.
 *
 * Session gating (race-only / replay-only / pre-green) lives in the translator
 * diff, NOT here, so the scenarios stay harness-firable.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario, Step } from "../../dsl.js";
import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/** Snapshot the nearby scenario's number resolver reads at expansion time. */
export type OpponentPitSnapshot = { position: number };

/** Resolver for the most recent opponent-pit position (live-preferred). */
export type OpponentPitSnapshotResolver = () => OpponentPitSnapshot | null;

const OPPONENT_PIT_WEIGHT = 65;
const POSITION_NUMBER_GROUP = "position-number";

/**
 * Register the speak-time number resolver. Must run before the scenarios are
 * defined — load-time validation rejects an unregistered `{ var }` name.
 */
export function registerOpponentPitVars(engine: IScenarioEngine, getSnapshot: OpponentPitSnapshotResolver): void {
  engine.defineVar("opponentPit.number", () => {
    const s = getSnapshot();

    if (!s || !Number.isInteger(s.position) || s.position <= 0) return null;

    return poolRef(POSITION_NUMBER_GROUP, String(s.position));
  });
}

function opponentPitScenario(
  subject: "leader" | "ahead" | "behind" | "nearby" | "others",
  family: string,
  body: Step[],
): Scenario {
  return {
    id: `pit-crew.opponent-pit-${subject}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: OPPONENT_PIT_WEIGHT,
    interrupt: false,
    queueable: true,
    family,
    sequence: ["@pit-crew.radio-open", ...body, "@pit-crew.radio-close"],
    when: {
      event: "opponentPit.entered",
      where: (e) => (e as SimEventOf<"opponentPit.entered">).data.relation === subject,
    },
  };
}

export const OPPONENT_PIT_ALERTS: readonly Scenario[] = [
  opponentPitScenario("leader", "opponent-pit-leader", ["pool:opponent-pit-leader"]),
  opponentPitScenario("ahead", "opponent-pit", ["pool:opponent-pit-ahead"]),
  opponentPitScenario("behind", "opponent-pit", ["pool:opponent-pit-behind"]),
  opponentPitScenario("nearby", "opponent-pit", [
    "pool:opponent-pit-car-in",
    { var: "opponentPit.number" },
    "pool:opponent-pit-is-pitting",
  ]),
  opponentPitScenario("others", "opponent-pit", ["pool:opponent-pit-others"]),
];

/** Stable identifiers for the two opponent-pit opt-ins (issue #622). */
export type OpponentPitCalloutId = "leader" | "nearby";

/** Canonical id↔setting-key map plugins read the live opt-in through. */
export const OPPONENT_PIT_CALLOUT_SETTING_KEYS: Record<OpponentPitCalloutId, string> = {
  leader: "calloutEnabledOpponentPitLeader",
  nearby: "calloutEnabledOpponentPitNearby",
};

export const SCENARIO_ID_TO_OPPONENT_PIT_ID: Record<string, OpponentPitCalloutId> = {
  "pit-crew.opponent-pit-leader": "leader",
  "pit-crew.opponent-pit-ahead": "nearby",
  "pit-crew.opponent-pit-behind": "nearby",
  "pit-crew.opponent-pit-nearby": "nearby",
  "pit-crew.opponent-pit-others": "nearby",
};

export const OPPONENT_PIT_SCENARIO_IDS: readonly string[] = OPPONENT_PIT_ALERTS.map((s) => s.id);

export const OPPONENT_PIT_POOL_NAMES: readonly string[] = [
  "opponent-pit-leader",
  "opponent-pit-ahead",
  "opponent-pit-behind",
  "opponent-pit-car-in",
  "opponent-pit-is-pitting",
  "opponent-pit-others",
];
```

- [ ] **Step 4: Add the six `POOL_REGISTRY` entries in `pools.ts`**

```typescript
  // Opponent pit entries (issue #622)
  "opponent-pit-leader": { group: "opponent-pit", base: "leader" },
  "opponent-pit-ahead": { group: "opponent-pit", base: "ahead" },
  "opponent-pit-behind": { group: "opponent-pit", base: "behind" },
  "opponent-pit-car-in": { group: "opponent-pit", base: "car-in" },
  "opponent-pit-is-pitting": { group: "opponent-pit", base: "is-pitting" },
  "opponent-pit-others": { group: "opponent-pit", base: "others" },
```

- [ ] **Step 5: Wire `registerPitCrew` in `index.ts`**

Insert two parameters between `getCornerNameSnapshot` (line ~921) and `getRaceEngineerMasterEnabled`:

```typescript
  // User opt-ins for the opponent-pit callouts (issue #622). Two subjects —
  // `leader` (the race/class leader entering the pits) and `nearby` (same-lap
  // cars within ±2 effective positions, incl. the aggregate tail). Same
  // gate-at-event-arrival shape as the other families. Placed before the
  // master gate so the master stays the last per-callout opt-in. Default
  // `() => true` preserves legacy behavior for tests that don't supply one.
  getOpponentPitCalloutEnabled: (id: OpponentPitCalloutId) => boolean = () => true,
  // Opponent-pit snapshot (issue #622). Plugins cache the latest
  // `opponentPit.entered` payload and compose a live `getLiveCarPosition`
  // read with the emit-time payload as fallback; the number var reads it at
  // expansion time. Default `() => null` aborts the nearby callout — a safe
  // stub for tests.
  getOpponentPitSnapshot: OpponentPitSnapshotResolver = () => null,
```

In the body, after the pit-window loop (~line 1036):

```typescript
  // Opponent-pit family (issue #622). Pools registered en masse above via
  // `registerPools(engine)`; `OPPONENT_PIT_POOL_NAMES` exists for catalog
  // tests. Two subjects gate the five scenarios via
  // `SCENARIO_ID_TO_OPPONENT_PIT_ID`; the leader scenario's separate family
  // keeps the aggregate tail from preempting the leader line.
  registerOpponentPitVars(engine, getOpponentPitSnapshot);
  for (const s of OPPONENT_PIT_ALERTS) {
    engine.defineScenario(
      wrapWithMaster(
        wrapCalloutScenario(
          s,
          SCENARIO_ID_TO_OPPONENT_PIT_ID,
          getOpponentPitCalloutEnabled,
          "opponent-pit callout",
          logger,
        ),
      ),
    );
  }
```

Add the imports at the top of `index.ts` (mirror the corner-name import block) and re-export the public pieces (`OpponentPitCalloutId`, `OPPONENT_PIT_CALLOUT_SETTING_KEYS`, `OpponentPitSnapshot`, `OpponentPitSnapshotResolver`, `OPPONENT_PIT_ALERTS`, `OPPONENT_PIT_SCENARIO_IDS`, `OPPONENT_PIT_POOL_NAMES`, `registerOpponentPitVars`) wherever `CORNER_NAME_CALLOUT_SETTING_KEYS` is re-exported (grep — the plugins import from `@iracedeck/audio-scenarios`).

- [ ] **Step 6: Fix the three positional callers**

In `register-pit-crew.test.ts` (~line 478), `rolling-start.test.ts` (~line 291), and `start-lights.test.ts` (~line 400): insert immediately after the `undefined, // getCornerNameSnapshot (issue #888)` line and before the master args:

```typescript
    undefined, // getOpponentPitCalloutEnabled (issue #622)
    undefined, // getOpponentPitSnapshot (issue #622)
```

In `register-pit-crew.test.ts` also add registration coverage: a test asserting the five `pit-crew.opponent-pit-*` scenario ids are defined after `registerPitCrew` runs, and that flipping a stubbed `getOpponentPitCalloutEnabled` to false for `"nearby"` suppresses a `relation: "ahead"` fire while `"leader"` still fires (mirror how `pitWindowEnabled` is exercised in that file).

- [ ] **Step 7: Run tests + build**

Run: `pnpm exec vitest run packages/audio-scenarios && pnpm --filter @iracedeck/audio-scenarios build`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add packages/audio-scenarios/src
git commit -m "feat(audio-scenarios): opponent-pit callout family (#622)"
```

---

### Task 5: deck-core settings + test fixtures + PI row

**Files:**
- Modify: `packages/deck-core/src/global-settings.ts` (two Zod fields after `calloutEnabledPitOpenClosed`, ~line 406)
- Modify: `packages/deck-core/src/simhub-service.test.ts` (BOTH literals: after `calloutEnabledPitOpenClosed: true` at ~line 83 AND ~line 271)
- Modify: `packages/iracing-actions/src/actions/pit-crew/pit-crew.ejs` (array block + accordion item after Pit Window)

**Interfaces:**
- Produces: `GlobalSettingsSchema` fields `calloutEnabledOpponentPitLeader` / `calloutEnabledOpponentPitNearby` (both default `true`).

- [ ] **Step 1: Add the Zod fields**

After `calloutEnabledPitOpenClosed` in `global-settings.ts`:

```typescript
    // Opponent-pit callout opt-ins (issue #622). Two subjects — the race
    // leader entering the pits, and same-lap competitors within ±2 effective
    // positions (class space in multi-class, incl. the aggregate tail).
    // Canonical id↔key mapping in `OPPONENT_PIT_CALLOUT_SETTING_KEYS`.
    calloutEnabledOpponentPitLeader: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledOpponentPitNearby: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
```

- [ ] **Step 2: Add both keys to BOTH `simhub-service.test.ts` literals**

After each `calloutEnabledPitOpenClosed: true,` line (two places — ~line 83 and ~line 271):

```typescript
    calloutEnabledOpponentPitLeader: true,
    calloutEnabledOpponentPitNearby: true,
```

(Indentation differs between the two literals — match each neighbour.)

- [ ] **Step 3: Add the PI checkbox block in `pit-crew.ejs`**

In the data script block, after the `pitWindowCheckboxes` definition (~line 138):

```text
			// Opponent-pit callouts (issue #622). Two subjects — the leader
			// entering the pits, and nearby (±2 positions, same lap) competitors.
			// Same 2-column auto-balancing grid as above.
			var opponentPitCallouts = [
				{ setting: "calloutEnabledOpponentPitLeader", label: "Leader pitting" },
				{ setting: "calloutEnabledOpponentPitNearby", label: "Nearby competitor pitting" },
			];
			var opponentPitRowCount = Math.ceil(opponentPitCallouts.length / 2);
			var opponentPitCheckboxes = opponentPitCallouts.map(function (c) {
				return '<sdpi-checkbox setting="' + c.setting + '" label="' + c.label + '" global default="true"></sdpi-checkbox>';
			}).join('');
```

In the accordion `content:` string, after the `'Pit Window'` `sdpi-item`:

```text
				'<sdpi-item label="Opponent Pits">' +
					'<div style="display:grid;grid-template-rows:repeat(' + opponentPitRowCount + ',auto);grid-auto-flow:column;gap:4px 12px;width:100%;">' +
						opponentPitCheckboxes +
					'</div>' +
				'</sdpi-item>' +
```

- [ ] **Step 4: Force-build deck-core + run its tests**

Run: `pnpm build --force` (turbo caches deck-core after schema changes — a plain build can falsely pass) — if the host app locks the native addon, quit UlanziStudio/Stream Deck first. Then `pnpm exec vitest run packages/deck-core`.
Expected: green; a missing fixture key fails the BUILD (tsc), not the tests.

- [ ] **Step 5: Commit**

```bash
git add packages/deck-core/src/global-settings.ts packages/deck-core/src/simhub-service.test.ts packages/iracing-actions/src/actions/pit-crew/pit-crew.ejs
git commit -m "feat(deck-core): opponent-pit callout opt-ins + PI toggles (#622)"
```

---

### Task 6: Plugin wiring — all THREE plugins

**Files:**
- Modify: `packages/iracing-plugin-stream-deck/src/plugin.ts`
- Modify: `packages/iracing-plugin-mirabox/src/plugin.ts`
- Modify: `packages/iracing-plugin-ulanzi/src/plugin.ts`

The three call sites are byte-identical in code — apply the same edit to each.

**Interfaces:**
- Consumes: `OpponentPitCalloutId`, `OPPONENT_PIT_CALLOUT_SETTING_KEYS`, `OpponentPitSnapshot` from `@iracedeck/audio-scenarios` (Task 4); `getLiveCarPosition` and `OpponentPitRelation`-typed event payload (Tasks 1+3).

- [ ] **Step 1: Add the payload cache (each plugin)**

Next to the `lastCornerName` cache (stream-deck ~line 351):

```typescript
// Cache the most recent `opponentPit.entered` payload so the nearby
// scenario's position number can resolve at speak time (issue #622) — the
// corner-name subscription pattern. Subscribed BEFORE registerPitCrew so the
// cache is fresh when the scenario evaluates.
let lastOpponentPit: SimEventOf<"opponentPit.entered">["data"] | null = null;
eventBus.subscribe("opponentPit.entered", (ev) => {
  lastOpponentPit = ev.data;
});
```

(`SimEventOf` is already imported in each plugin for the other caches — verify with grep, add to the import if absent.)

- [ ] **Step 2: Add the two args to `registerPitCrew` (each plugin)**

After `() => lastCornerName,` and before the Race Engineer master-gate arrow:

```typescript
  // Opponent-pit callout opt-ins (issue #622). Live-read, two subjects.
  (id: OpponentPitCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[OPPONENT_PIT_CALLOUT_SETTING_KEYS[id]] !== false,
  // Opponent-pit snapshot resolver (issue #622) — prefer the live canonical
  // position at speak time; fall back to the emit-time payload position.
  (): OpponentPitSnapshot | null => {
    if (!lastOpponentPit || typeof lastOpponentPit.carIdx !== "number") return null;

    const live = getLiveCarPosition(lastOpponentPit.carIdx);
    const liveN = live ? (live.isMultiClass ? live.classPosition : live.position) : 0;
    const n = liveN > 0 ? liveN : (lastOpponentPit.position ?? 0);

    return n > 0 ? { position: n } : null;
  },
```

Add `OpponentPitCalloutId`, `OPPONENT_PIT_CALLOUT_SETTING_KEYS`, `OpponentPitSnapshot` to each plugin's `@iracedeck/audio-scenarios` import block, and `getLiveCarPosition` to the `@iracedeck/sim-events-iracing` import (next to `getLiveRacePositions`).

- [ ] **Step 3: Build all three plugins**

Run: `pnpm build` (workspace — topological)
Expected: green. (If EPERM on the native addon: quit the deck host app and rerun.)

- [ ] **Step 4: Commit**

```bash
git add packages/iracing-plugin-stream-deck/src/plugin.ts packages/iracing-plugin-mirabox/src/plugin.ts packages/iracing-plugin-ulanzi/src/plugin.ts
git commit -m "feat(plugins): wire opponent-pit callouts in all three plugins (#622)"
```

---

### Task 7: Scenario-harness shortcuts + snapshot resolver

**Files:**
- Modify: `packages/scenario-harness/src/scenario-shortcuts.ts` (5 shortcuts, new category)
- Modify: `packages/scenario-harness/src/main.ts` (payload cache + 2 trailing args on `registerPitCrew`)

**Interfaces:**
- Consumes: `opponentPit.entered` (Task 1); `registerPitCrew` params 41/42 (Task 4).

- [ ] **Step 1: Add the shortcuts**

After the Pit Window block (~line 362):

```typescript
  // ── Opponent Pit (issue #622) ──
  // `opponentPit.entered` directly — bypasses the diff's race-only /
  // aggregation gating so each relation line is auditionable on demand. The
  // nearby number speaks the payload position (the harness snapshot resolver
  // reads the cached payload; there's no live telemetry read here).
  {
    id: "opponent-pit-leader",
    category: "Opponent Pit",
    label: "Leader pitting",
    description: 'The race leader dives into the pits — "The leader is pitting."',
    event: "opponentPit.entered",
    data: { relation: "leader", carIdx: 3, position: 1 },
  },
  {
    id: "opponent-pit-ahead",
    category: "Opponent Pit",
    label: "Car ahead pitting",
    description: 'The car directly ahead pits — "The car ahead is pitting."',
    event: "opponentPit.entered",
    data: { relation: "ahead", carIdx: 11, position: 4 },
  },
  {
    id: "opponent-pit-behind",
    category: "Opponent Pit",
    label: "Car behind pitting",
    description: 'The car directly behind pits — "The car behind is pitting."',
    event: "opponentPit.entered",
    data: { relation: "behind", carIdx: 12, position: 6 },
  },
  {
    id: "opponent-pit-nearby",
    category: "Opponent Pit",
    label: "P7 pitting (±2)",
    description: 'A car two positions away pits — "The car in, P7, is pitting."',
    event: "opponentPit.entered",
    data: { relation: "nearby", carIdx: 13, position: 7 },
  },
  {
    id: "opponent-pit-others",
    category: "Opponent Pit",
    label: "Several cars pitting",
    description: 'The aggregate tail — "And it seems there are other cars pitting as well."',
    event: "opponentPit.entered",
    data: { relation: "others" },
  },
```

- [ ] **Step 2: Wire the harness snapshot resolver in `main.ts`**

Near the other caches (grep `lastCornerName` in `main.ts`, mirror placement):

```typescript
// Latest opponent-pit payload — the harness snapshot resolver speaks the
// payload position directly (no live telemetry read, issue #622).
let lastOpponentPit: SimEventOf<"opponentPit.entered">["data"] | null = null;
eventBus.subscribe("opponentPit.entered", (ev) => {
  lastOpponentPit = ev.data;
});
```

Append to the `registerPitCrew(...)` call after `() => lastCornerName, // getCornerNameSnapshot (issue #888)`:

```typescript
    undefined, // getOpponentPitCalloutEnabled (issue #622)
    () =>
      lastOpponentPit && typeof lastOpponentPit.position === "number" && lastOpponentPit.position > 0
        ? { position: lastOpponentPit.position }
        : null, // getOpponentPitSnapshot (issue #622)
```

- [ ] **Step 3: Build + smoke the harness**

Run: `pnpm --filter @iracedeck/scenario-harness build`
Expected: green (the shortcut/event-name types are compile-checked). Optionally boot `pnpm --filter @iracedeck/scenario-harness dev` and confirm the five buttons appear under "Opponent Pit" (audio needs Task 8's clips — buttons will abort per #835 until then, which is correct).

- [ ] **Step 4: Commit**

```bash
git add packages/scenario-harness/src/scenario-shortcuts.ts packages/scenario-harness/src/main.ts
git commit -m "feat(scenario-harness): opponent-pit shortcuts (#622)"
```

---

### Task 8: Voice lines — config, dry-run gate, generation, manifest

**HUMAN GATE:** show Niklas the dry-run wording list and get approval BEFORE running `generate`. ElevenLabs is paid.

**Files:**
- Modify: `packages/audio-assets/configs/default.voice.json` (new `opponent-pit` group)
- Generated: `packages/audio-assets/voice/default/opponent-pit/*.mp3`, `generate.manifest.json`, `manifest.json`
- Copy first: `.env.local` from the master checkout into the worktree (same relative location — check where it lives in `C:/Users/Niklas/Projects/iRaceDeck/master`, likely `packages/audio-assets/.env.local`).

**Interfaces:**
- Produces: clips resolving the six pools from Task 4 (`opponent-pit/{leader|ahead|behind|car-in|is-pitting|others}-NN.mp3`).

- [ ] **Step 1: Add the group to `default.voice.json`**

After the `pit-window` group (keeping the file's family ordering):

```json
"opponent-pit": [
  { "name": "leader-01", "text": "The leader is pitting.", "seed": 1 },
  { "name": "leader-02", "text": "Leader's coming in.", "seed": 1 },
  { "name": "leader-03", "text": "Heads up. <break time=\"0.3s\" /> The leader is pitting.", "seed": 1 },
  { "name": "ahead-01", "text": "The car ahead is pitting.", "seed": 1 },
  { "name": "ahead-02", "text": "Car ahead's coming into the pits.", "seed": 1 },
  { "name": "ahead-03", "text": "The car ahead is peeling in.", "seed": 1 },
  { "name": "behind-01", "text": "The car behind is pitting.", "seed": 1 },
  { "name": "behind-02", "text": "Car behind's coming into the pits.", "seed": 1 },
  { "name": "behind-03", "text": "The car behind is heading for the pits.", "seed": 1 },
  { "name": "car-in-01", "text": "The car in", "seed": 1, "next_request_ids": ["position-number/4"] },
  { "name": "is-pitting-01", "text": "is pitting.", "seed": 1, "previous_request_ids": ["position-number/4"] },
  { "name": "others-01", "text": "And it seems there are other cars pitting as well.", "seed": 1 },
  { "name": "others-02", "text": "Looks like more cars are coming in too.", "seed": 1 }
]
```

(`previous_request_ids`/`next_request_ids` use the `"group/name"` reference form — position-number entries are named bare `"1"`…`"64"`.)

- [ ] **Step 2: Dry-run and STOP for review**

Run: `pnpm --filter @iracedeck/audio-assets generate:dry-run --group opponent-pit`
Expected: lists ONLY the 13 new entries. Present the wording list to Niklas and WAIT for approval — he may adjust texts/variant counts.

- [ ] **Step 3: Generate + manifest (after approval)**

```bash
pnpm --filter @iracedeck/audio-assets generate --group opponent-pit
pnpm --filter @iracedeck/audio-assets generate:manifest
```

Expected: 13 mp3s under `voice/default/opponent-pit/`; `manifest.json` gains the paths. Listen-check at least the `car-in` + number + `is-pitting` splice (harness or a media player).

- [ ] **Step 4: Commit (clips + BOTH manifests)**

```bash
git add packages/audio-assets/configs/default.voice.json packages/audio-assets/generate.manifest.json packages/audio-assets/manifest.json packages/audio-assets/voice/default/opponent-pit
git commit -m "feat(audio-assets): opponent-pit voice lines (#622)"
```

---

### Task 9: Docs, website, skills, rules, changelog

**Files:**
- Modify: `packages/website/src/content/docs/docs/actions/audio-voice/pit-crew.md`
- Modify: `packages/website/src/content/docs/changelog.mdx`
- Modify: `docs/plugins/core/actions/pit-crew.md`
- Modify: `.claude/skills/iracedeck-actions/SKILL.md` (Pit Crew row, ~line 87)
- Modify: `.claude/rules/race-engineer-callouts.md` (step 8: "BOTH plugins" → all three, adding Ulanzi)
- Modify: `.claude/rules/race-engineer-callout-examples.md` (new #622 entry)

- [ ] **Step 1: Website pit-crew page**

Behaviour section (after the Spotter section, matching the house style — one paragraph, no hard wraps): the engineer announces the leader and same-lap cars within two positions entering the pits (races only; class rivals in multi-class); three or more near-simultaneous entries collapse into a single "other cars pitting as well" call; the ±2 line speaks the car's live position ("The car in, P4, is pitting").

Opt-in section (the per-subject list starting ~line 298): `Under **Opponent Pits**, two callouts are toggleable, both enabled by default:` with bullets for `calloutEnabledOpponentPitLeader` (Leader pitting) and `calloutEnabledOpponentPitNearby` (Nearby competitor pitting).

- [ ] **Step 2: Changelog**

Under `## 2.4.0` (`_Unreleased_`), add a `**Features**` header if absent (fixed category order: Features before Improvements/Bug Fixes) with:

```markdown
- The Race Engineer now announces when other drivers enter the pits — the race leader plus same-lap competitors within two positions of you (your class in multi-class) — collapsing caution pit trains into a single "other cars pitting as well" call. Two new per-callout toggles, both on by default.
```

- [ ] **Step 3: Internal action doc + skill + rules**

- `docs/plugins/core/actions/pit-crew.md`: one paragraph in the voice-coverage section (~line 63 area, after corner names): trigger (`CarIdxTrackSurface` → `AproachingPits`), who's announced, aggregation, the two setting keys, races-only.
- `.claude/skills/iracedeck-actions/SKILL.md` line ~87: extend the Pit Crew blurb's callout-family enumeration with opponent-pit (same "voice callout family, not a mode" framing).
- `.claude/rules/race-engineer-callouts.md` step 8 heading and body: "BOTH plugins" → "ALL THREE plugins (`iracing-plugin-stream-deck`, `iracing-plugin-mirabox`, `iracing-plugin-ulanzi`)".
- `.claude/rules/race-engineer-callout-examples.md`: append the entry:

```markdown
- **Opponent pit entries — per-car array diff + burst aggregation + two-family preemption split** — issue #622. Demonstrates diffing a PER-CAR telemetry array (`CarIdxTrackSurface` → `TrkLoc.AproachingPits` against a per-car previous-tick baseline, the first opponent-state diff), classifying against the canonical frozen order (`classPositionFromOrder` for class space, #588), the incident-burst aggregation shape applied to N independent actors (rolling 12 s timestamp window + once-per-episode aggregate + per-car 30 s `<x>CooldownUntil[]`), and SPLITTING one feature across two families (`opponent-pit-leader` vs `opponent-pit`) so family preemption can't let the aggregate tail cut the leader line emitted in the same flush. The spoken "P{n}" resolves at speak time via `getLiveCarPosition(carIdx)` (the per-car sibling of `getLivePosition`) with emit-time payload fallback, composed in the plugin snapshot resolver. Reach for this pattern when a callout tracks OTHER cars' state transitions: per-car baseline arrays on `TranslatorState`, gate race-only/replay-only/pre-green in the diff, and let same-flush ordering constraints pick the family boundaries.
```

- [ ] **Step 4: Verify website build**

Run: `pnpm --filter @iracedeck/website build`
Expected: green; changelog page renders (MDX: no bare `<` outside backticks).

- [ ] **Step 5: Commit**

```bash
git add packages/website docs/plugins/core/actions/pit-crew.md .claude/skills/iracedeck-actions/SKILL.md .claude/rules/race-engineer-callouts.md .claude/rules/race-engineer-callout-examples.md
git commit -m "docs: opponent-pit callouts across website, docs, skills, rules (#622)"
```

---

### Task 10: Full verification

- [ ] **Step 1: Full build + tests + hygiene** (quit the deck host app first if it's running)

```bash
set -o pipefail
pnpm install
pnpm build --force
pnpm test
pnpm lint:fix
pnpm format:fix
```

Expected: everything green — check the actual exit codes, not just the tail of the log. Fix ALL failures, including any that look pre-existing.

- [ ] **Step 2: Commit any lint/format fallout**

```bash
git status
git add -A && git commit -m "chore: lint/format fallout (#622)"   # only if there is fallout
```

- [ ] **Step 3: Stop for manual testing**

Do NOT push or open a PR. Hand over to Niklas for the manual test plan in the spec (harness first, then iRacing road race + oval caution train). After manual testing passes, ask about running `code-review xhigh --fix`, and only then — with explicit approval — create the PR (repo PR template, title `feat(audio): announce opponents entering the pits (#622)`).
