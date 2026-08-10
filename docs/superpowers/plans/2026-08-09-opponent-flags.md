# Opponent Penalty Flags + Leader White (#936) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Race Engineer callouts for penalty flags on nearby opponents (furled/black/meatball/DQ, from `CarIdxSessionFlags`) plus a leader's-final-lap callout, with the per-car flag data exposed as a reusable `getLiveOpponentFlags()` seam.

**Architecture:** Layered per the approved spec (`docs/superpowers/specs/2026-08-09-opponent-flags-design.md`): pure bit-decode + gap math in `@iracedeck/iracing-sdk`; a per-car flag-state store (truth) + callout qualifier (policy) in a new `sim-events-iracing` diff; canonical enum + events in `@iracedeck/event-bus`; a new family-less queueable scenario family in `@iracedeck/audio-scenarios`; opt-ins/PI/plugins/harness/docs per the race-engineer-callouts checklist.

**Tech Stack:** TypeScript strict, Zod, Vitest, pnpm + turbo monorepo. Worktree: `C:/Users/Niklas/Projects/iRaceDeck/ir-936`, branch `ir-936`.

## Global Constraints

- **No watcher is running** — every build/test/lint run is manual, from the worktree root.
- After ANY `GlobalSettingsSchema` change run `pnpm build --force` (turbo caches deck-core; a plain build can falsely pass).
- Verify with pipefail: `set -o pipefail` before piping build output through `tail`.
- `pnpm --filter` silently no-ops on packages without the script — run root `pnpm exec vitest run <path>` for single files and full `pnpm build` for type checks.
- Every commit message ends with the trailer line `Claude-Session: https://claude.ai/code/session_01SaaYVTosjHf8NU6WzvppQQ`.
- Commit messages use conventional prefixes; the shell cwd resets to the master checkout between tool calls — always `cd C:/Users/Niklas/Projects/iRaceDeck/ir-936` in the same command or use absolute paths.
- `pit-crew.ejs` uses TAB indentation; `changelog.mdx` is MDX (backtick-wrap literal `<name>`-style tokens).
- ElevenLabs generation is paid: only ever `generate --group opponent-flags` / `--group flags` after the dry-run checkpoint is user-approved. NEVER unscoped.
- New state fields go on `TranslatorState` **and** `createInitialState()` — only `pnpm build` catches a mismatch.
- Sizes of all per-car arrays come from the live `CarIdxSessionFlags` array length — never 64 (Step 0 capture: length 72, pace car at index 64).
- Do not touch `packages/*/dist`, `bin/`, generated files, or reformat unrelated code.

---

### Task 1: event-bus — canonical enum + two events

**Files:**
- Modify: `packages/event-bus/src/event-catalog.ts` (enum near `TrackWetness` ~line 111; events after `opponentPit.entered` ~line 340 and after `flag.white-last-lap.raised` ~line 384)
- Modify: `packages/event-bus/src/index.ts` (type + value export lists)

**Interfaces:**
- Produces: `OpponentPenaltyFlag` (string enum, VALUE export), `OpponentFlagRelation` type, `SimEventMap` entries `"opponentFlag.flagged"` and `"flag.white-leader.raised"`. Later tasks import `OpponentPenaltyFlag` and `SimEventOf<"opponentFlag.flagged">` from `@iracedeck/event-bus`.

- [ ] **Step 1: Add the enum + relation type to `event-catalog.ts`**

Near the other canonical enums (the `TrackWetness` value-enum precedent):

```typescript
/**
 * Penalty/status flags another car can carry in `CarIdxSessionFlags` (issue
 * #936). String-valued so payloads read naturally in logs and the harness;
 * `Repair` is the meatball — the canonical name follows the sim bit.
 */
export enum OpponentPenaltyFlag {
  Furled = "furled",
  Black = "black",
  Repair = "repair",
  Disqualify = "disqualify",
}

/** Who a flagged car is relative to the player. `"others"` is the aggregate tail. */
export type OpponentFlagRelation = "ahead" | "behind" | "track-ahead" | "others";
```

- [ ] **Step 2: Add the two `SimEventMap` entries**

After the `opponentPit.entered` entry:

```typescript
  /**
   * A penalty flag on another car matters to the player (issue #936):
   * either the flag rose on a car already in the qualification window
   * (`trigger: "raised"`), or a car with an active flag entered the window
   * (`trigger: "entered-range"`). `position` is the car's effective position
   * at emit time (class position in multi-class) — consumers prefer a live
   * speak-time read and use this as the fallback; `isMultiClass` records the
   * projection the classification ran in. `gapSeconds` is the coarse forward
   * track gap, present for `"track-ahead"` only. `carIdx`/`flag`/`trigger`
   * are absent for the `"others"` aggregate.
   */
  "opponentFlag.flagged": SimEvent<
    "opponentFlag.flagged",
    {
      relation: OpponentFlagRelation;
      carIdx?: number;
      flag?: OpponentPenaltyFlag;
      trigger?: "raised" | "entered-range";
      position?: number;
      gapSeconds?: number;
      isMultiClass?: boolean;
    }
  >;
```

After `flag.white-last-lap.raised`:

```typescript
  /**
   * The OVERALL race leader is starting their final lap (issue #936) —
   * detected from lap counting (leader-relative `SessionLapsRemainEx`, or the
   * leader's first scored crossing after clock expiry in timed races), never
   * from the unconfirmed per-car White bit. Once per race, re-armed by a
   * green rising edge. Suppressed when the player IS the leader or already
   * has their own White up (the #772 heads-up owns that moment).
   */
  "flag.white-leader.raised": SimEvent<"flag.white-leader.raised", EmptySimEventPayload>;
```

- [ ] **Step 3: Export from `index.ts`** — add `OpponentFlagRelation` to the `export type { ... }` block (alphabetical slot near `OpponentPitRelation`) and `OpponentPenaltyFlag` to the `export { TrackWetness }` value line.

- [ ] **Step 4: Build + commit**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-936 && set -o pipefail && pnpm --filter @iracedeck/event-bus build 2>&1 | tail -3
git add packages/event-bus && git commit -m "feat(event-bus): opponent penalty-flag enum + opponentFlag.flagged / flag.white-leader.raised events (#936)" -m "Claude-Session: https://claude.ai/code/session_01SaaYVTosjHf8NU6WzvppQQ"
```

Note: `pnpm build` at the root will fail from here until Task 11 adds the harness `event-names.ts` entries (the compile-time completeness check) — that is expected; per-package builds and the harness task close the gap. Run the root build only from Task 11 on.

---

### Task 2: iracing-sdk — `penalty-flag-utils.ts` (pure decode)

**Files:**
- Create: `packages/iracing-sdk/src/penalty-flag-utils.ts`
- Test: `packages/iracing-sdk/src/penalty-flag-utils.test.ts`
- Modify: `packages/iracing-sdk/src/index.ts` (export, mirroring the `flag-utils` export line)

**Interfaces:**
- Produces: `decodePenaltyFlags(bits: number | undefined): CarPenaltyFlags` with `CarPenaltyFlags = { furled: boolean; black: boolean; repair: boolean; disqualify: boolean }`; `PENALTY_FLAG_MASK: number`. iracing-sdk speaks sim bits only — no event-bus import.

- [ ] **Step 1: Write the failing test**

```typescript
import { Flags } from "@iracedeck/iracing-native";
import { describe, expect, it } from "vitest";

import { decodePenaltyFlags, PENALTY_FLAG_MASK } from "./penalty-flag-utils.js";

describe("PENALTY_FLAG_MASK", () => {
  it("covers exactly the four penalty bits", () => {
    expect(PENALTY_FLAG_MASK).toBe(Flags.Furled | Flags.Black | Flags.Repair | Flags.Disqualify);
  });
});

describe("decodePenaltyFlags", () => {
  it("decodes each bit independently", () => {
    expect(decodePenaltyFlags(Flags.Black)).toEqual({ furled: false, black: true, repair: false, disqualify: false });
    expect(decodePenaltyFlags(Flags.Furled | Flags.Repair)).toEqual({
      furled: true,
      black: false,
      repair: true,
      disqualify: false,
    });
  });

  it("ignores non-penalty bits (the Step 0 capture: 0x50000 = Black + Servicible)", () => {
    expect(decodePenaltyFlags(0x50000)).toEqual({ furled: false, black: true, repair: false, disqualify: false });
    expect(decodePenaltyFlags(0x40000)).toEqual({ furled: false, black: false, repair: false, disqualify: false });
  });

  it("treats undefined as no flags", () => {
    expect(decodePenaltyFlags(undefined)).toEqual({ furled: false, black: false, repair: false, disqualify: false });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd C:/Users/Niklas/Projects/iRaceDeck/ir-936 && pnpm exec vitest run packages/iracing-sdk/src/penalty-flag-utils.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
import { Flags } from "@iracedeck/iracing-native";

import { hasFlag } from "./utils.js";

/** The four per-driver penalty/status bits `CarIdxSessionFlags` can carry. */
export const PENALTY_FLAG_MASK: number = Flags.Furled | Flags.Black | Flags.Repair | Flags.Disqualify;

/** Decoded penalty bits for one car. Pure — no translator state involved. */
export type CarPenaltyFlags = {
  furled: boolean;
  black: boolean;
  repair: boolean;
  disqualify: boolean;
};

/**
 * Decode a car's `CarIdxSessionFlags` value into its penalty bits (issue
 * #936). Missing telemetry decodes as no flags — don't punish missing data.
 */
export function decodePenaltyFlags(bits: number | undefined): CarPenaltyFlags {
  return {
    furled: hasFlag(bits, Flags.Furled),
    black: hasFlag(bits, Flags.Black),
    repair: hasFlag(bits, Flags.Repair),
    disqualify: hasFlag(bits, Flags.Disqualify),
  };
}
```

Check `hasFlag`'s parameter type in `utils.ts:31` — it takes `number | undefined` and returns false for undefined.

- [ ] **Step 4: Export from `index.ts`, run test → PASS, build the package**
- [ ] **Step 5: Commit** — `feat(iracing-sdk): decodePenaltyFlags + PENALTY_FLAG_MASK (#936)` (+ session trailer)

---

### Task 3: iracing-sdk — coarse forward-gap helper

**Files:**
- Modify: `packages/iracing-sdk/src/gap-utils.ts` (append; sits beside `lapDeltaBetween`)
- Test: `packages/iracing-sdk/src/gap-utils.test.ts` (append a describe block)

**Interfaces:**
- Produces: `coarseForwardGapSeconds(playerLapDistPct, carLapDistPct, trackLengthMeters, playerSpeedMps, minSpeedMps): number | null`

- [ ] **Step 1: Write the failing tests**

```typescript
describe("coarseForwardGapSeconds", () => {
  it("computes the folded forward gap at speed", () => {
    // Car 2% ahead on a 5000 m track at 50 m/s → 100 m / 50 = 2 s.
    expect(coarseForwardGapSeconds(0.5, 0.52, 5000, 50, 10)).toBeCloseTo(2, 5);
  });

  it("folds around the start/finish line", () => {
    // Player at 0.99, car at 0.01 → forward 2%.
    expect(coarseForwardGapSeconds(0.99, 0.01, 5000, 50, 10)).toBeCloseTo(2, 5);
  });

  it("a car just behind reads as nearly a full lap ahead (never negative)", () => {
    const gap = coarseForwardGapSeconds(0.5, 0.49, 5000, 50, 10);
    expect(gap).toBeCloseTo(4900 / 50, 5);
  });

  it("floors the player speed so a stationary player cannot divide by zero", () => {
    expect(coarseForwardGapSeconds(0.5, 0.52, 5000, 0, 10)).toBeCloseTo(10, 5);
    expect(coarseForwardGapSeconds(0.5, 0.52, 5000, null, 10)).toBeCloseTo(10, 5);
  });

  it("returns null without a track length or with invalid progress", () => {
    expect(coarseForwardGapSeconds(0.5, 0.52, null, 50, 10)).toBeNull();
    expect(coarseForwardGapSeconds(0.5, 0.52, 0, 50, 10)).toBeNull();
    expect(coarseForwardGapSeconds(-1, 0.52, 5000, 50, 10)).toBeNull();
    expect(coarseForwardGapSeconds(0.5, Number.NaN, 5000, 50, 10)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify FAIL**
- [ ] **Step 3: Implement**

```typescript
/**
 * Coarse forward track gap from the player to a car ahead, in seconds (issue
 * #936): the forward `LapDistPct` delta folded around the lap × track length
 * ÷ the player's speed, floored at `minSpeedMps` so a stationary player
 * can't divide by zero. Deliberately NOT the crossing-time trace model (#933)
 * — this is a window boundary, never a spoken value, and it must cover
 * track-relative traffic on any lap. `null` when the track length or either
 * progress value is unusable; a missing/invalid speed uses the floor.
 */
export function coarseForwardGapSeconds(
  playerLapDistPct: number,
  carLapDistPct: number,
  trackLengthMeters: number | null,
  playerSpeedMps: number | null | undefined,
  minSpeedMps: number,
): number | null {
  if (typeof trackLengthMeters !== "number" || !Number.isFinite(trackLengthMeters) || trackLengthMeters <= 0) {
    return null;
  }

  if (
    !Number.isFinite(playerLapDistPct) ||
    !Number.isFinite(carLapDistPct) ||
    playerLapDistPct < 0 ||
    carLapDistPct < 0
  ) {
    return null;
  }

  const forwardFraction = (((carLapDistPct - playerLapDistPct) % 1) + 1) % 1;
  const speed =
    typeof playerSpeedMps === "number" && Number.isFinite(playerSpeedMps)
      ? Math.max(playerSpeedMps, minSpeedMps)
      : minSpeedMps;

  return (forwardFraction * trackLengthMeters) / speed;
}
```

- [ ] **Step 4: Run test → PASS; build package**
- [ ] **Step 5: Commit** — `feat(iracing-sdk): coarseForwardGapSeconds window estimate (#936)` (+ trailer)

---

### Task 4: translator — state fields, flag-state store, `getLiveOpponentFlags()`

**Files:**
- Modify: `packages/sim-events-iracing/src/state.ts` (fields after the opponentPit block ~line 643; initializers after ~line 921)
- Create: `packages/sim-events-iracing/src/diff/opponent-flags.ts` (store responsibility only in this task)
- Test: `packages/sim-events-iracing/src/diff/opponent-flags.test.ts`
- Modify: `packages/sim-events-iracing/src/translator.ts` (call in `handleTick` directly after the `diffOpponentPit(...)` call ~line 1624; accessor near `getLiveGaps` ~line 867; preserved cluster in `wipeStateForReplay` ~line 1160)
- Modify: `packages/sim-events-iracing/src/index.ts` (export accessor + types)

**Interfaces:**
- Consumes: `decodePenaltyFlags`, `PENALTY_FLAG_MASK` (Task 2); `OpponentPenaltyFlag` (Task 1).
- Produces: `diffOpponentFlags(state, telemetry, playerCarIdx, paceCarIdx, isRaceSession, replayOnlySession, preGreen, postRace, isMultiClass, frozenPositions, trackLengthMeters, now, emit): void`; `getLiveOpponentFlags(): LiveOpponentFlags | null` with `LiveOpponentFlags = { cars: LiveOpponentFlagCar[] }`, `LiveOpponentFlagCar = { carIdx: number; flags: OpponentPenaltyFlag[] }`. Constants exported for tests: `OPPONENT_FLAG_AGGREGATE_WINDOW_MS = 12_000`, `OPPONENT_FLAG_AGGREGATE_THRESHOLD = 3`, `OPPONENT_FLAG_CAR_COOLDOWN_MS = 30_000`, `OPPONENT_FLAG_FURLED_DEBOUNCE_MS = 1_000`, `OPPONENT_FLAG_TRACK_GAP_ENTER_S = 10`, `OPPONENT_FLAG_TRACK_GAP_EXIT_S = 12`, `OPPONENT_FLAG_AHEAD_WINDOW = 3`, `OPPONENT_FLAG_MIN_PLAYER_SPEED_MPS = 10`.

- [ ] **Step 1: State fields** — add to `TranslatorState` (JSDoc in the opponentPit style) AND `createInitialState()`:

```typescript
  // ── Opponent penalty flags (issue #936) ───────────────────────────────
  /** First tick seeds the per-car penalty-bit store silently. */
  opponentFlagsInitialized: boolean;
  /**
   * Masked penalty bits (`PENALTY_FLAG_MASK`) per carIdx as of the last
   * tick — the flag-state STORE `getLiveOpponentFlags()` reads (truth), and
   * the edge baseline the qualifier diffs against (policy). Advances every
   * tick even when the callout gates are closed.
   */
  opponentFlagBits: number[];
  /** Epoch ms the car's Furled bit rose; 0 while down. Debounces flicker (#669). */
  opponentFlagFurledSinceAt: number[];
  /** Penalty bits already announced for the current episode, per car. Cleared per bit as the bit drops. */
  opponentFlagAnnouncedMask: number[];
  /** Per-car, per-flag re-announce cooldown deadlines (epoch ms) — per-flag so an escalation (black → DQ) is never suppressed. */
  opponentFlagCooldownUntil: { furled: number[]; black: number[]; repair: number[]; disqualify: number[] };
  /** Whether the car was inside the qualification window last tick (trigger classification + hysteresis). */
  opponentFlagInWindow: boolean[];
  /** Timestamps of announced entries inside the rolling aggregation window (the #622 burst shape). */
  opponentFlagRecentEntries: number[];
  /** Whether the aggregate tail already fired for the current episode. */
  opponentFlagAggregateAnnounced: boolean;
```

Initializers: `false`, `[]`, `[]`, `[]`, `{ furled: [], black: [], repair: [], disqualify: [] }`, `[]`, `[]`, `false`.

- [ ] **Step 2: Failing tests for store + seed** (new test file; copy the `diff/opponent-pit.test.ts` harness shape — `makeField()` returning `{ CarIdxSessionFlags, CarIdxLapCompleted, CarIdxLapDistPct, CarIdxClass, LapDistPct?, Speed?, SessionFlags? }`, a `run(state, t, now, opts)` wrapper passing `positions`/`trackLength` defaults):

```typescript
import { Flags } from "@iracedeck/iracing-native";

it("seeds the store silently on the first tick, flags included", () => {
  const t = makeField();
  t.CarIdxSessionFlags[3] = 0x50000; // Black + Servicible (the Step 0 capture value)

  expect(run(state, t, 1000)).toEqual([]);
  expect(state.opponentFlagsInitialized).toBe(true);
  expect(state.opponentFlagBits[3]).toBe(Flags.Black);
});

it("keeps the store truthful even when the callout gates are closed", () => {
  const t = makeField();
  run(state, t, 1000);
  t.CarIdxSessionFlags[3] = Flags.Repair;

  expect(run(state, t, 2000, { isRace: false })).toEqual([]);
  expect(state.opponentFlagBits[3]).toBe(Flags.Repair);
});

it("sizes per-car state from the live array length (72 cars, pace car at 64)", () => {
  const t = makeField(72);
  t.CarIdxSessionFlags[70] = Flags.Black;
  run(state, t, 1000);

  expect(state.opponentFlagBits.length).toBe(72);
  expect(state.opponentFlagBits[70]).toBe(Flags.Black);
});
```

- [ ] **Step 3: Implement the diff skeleton (store only)** — full callout logic lands in Tasks 5–6; this task ships the module with: constants, the signature above, aggregation-window pruning stub omitted, first-tick seed, per-tick store advance (masked bits, element-wise, `prev.length = raw.length`), level-based cleanup (`opponentFlagAnnouncedMask[i] &= bits`, `opponentFlagFurledSinceAt[i] = furled still up ? kept/seeded : 0`). The module header documents the truth/policy split (crib the spec's wording).

- [ ] **Step 4: Wire `handleTick`** — directly after the `diffOpponentPit(...)` call:

```typescript
  diffOpponentFlags(
    self.state,
    telemetry,
    playerCarIdx,
    resolvePaceCarIdx(sessionInfo),
    isRaceSession,
    replayOnlySession,
    isPreGreen(telemetry),
    isPostRace(telemetry),
    resolveIsMultiClass(sessionInfo) === true,
    frozenPositions,
    trackLengthMeters,
    now,
    emit,
  );
```

(`trackLengthMeters` is already resolved at ~line 1585, before this slot.)

- [ ] **Step 5: Accessor + exports**

```typescript
export type LiveOpponentFlagCar = { carIdx: number; flags: OpponentPenaltyFlag[] };
export type LiveOpponentFlags = { cars: LiveOpponentFlagCar[] };

/**
 * Cars currently showing any penalty flag (issue #936) — the reusable
 * flag-data seam. Raw decoded truth from the store (no debounce/episodes —
 * announcement policy stays private to the diff). `null` before the store's
 * first tick. Consumers read this; never re-derive from `CarIdxSessionFlags`.
 */
export function getLiveOpponentFlags(): LiveOpponentFlags | null {
  if (!instance || !instance.state.opponentFlagsInitialized) return null;

  const bits = instance.state.opponentFlagBits;
  const cars: LiveOpponentFlagCar[] = [];

  for (let i = 0; i < bits.length; i++) {
    const d = decodePenaltyFlags(bits[i]);
    const flags: OpponentPenaltyFlag[] = [];

    if (d.furled) flags.push(OpponentPenaltyFlag.Furled);
    if (d.black) flags.push(OpponentPenaltyFlag.Black);
    if (d.repair) flags.push(OpponentPenaltyFlag.Repair);
    if (d.disqualify) flags.push(OpponentPenaltyFlag.Disqualify);

    if (flags.length > 0) cars.push({ carIdx: i, flags });
  }

  return { cars };
}
```

Export `getLiveOpponentFlags` + both types from `src/index.ts` (value line beside `getLiveGaps`, types beside `LiveGaps`). Add accessor tests in `translator.test.ts` only if an existing accessor has them there — otherwise the diff tests + a store assertion suffice.

- [ ] **Step 6: Run tests → PASS; `pnpm --filter @iracedeck/sim-events-iracing build`**
- [ ] **Step 7: Commit** — `feat(sim-events): per-car penalty-flag store + getLiveOpponentFlags seam (#936)` (+ trailer)

---

### Task 5: translator — qualification window + announce machinery

**Files:**
- Modify: `packages/sim-events-iracing/src/diff/opponent-flags.ts`
- Test: `packages/sim-events-iracing/src/diff/opponent-flags.test.ts`

**Interfaces:**
- Consumes: Task 4's module skeleton, `classPositionFromOrder`, `coarseForwardGapSeconds`, `OpponentPenaltyFlag`.
- Produces: `opponentFlag.flagged` emissions (individual lines; aggregation is Task 6).

**Model (from the spec, refined):** the announce condition is **level-triggered with a per-episode latch** — both spec triggers fall out of one rule. Per car (skip player/pace/not-in-world), per flag:

- *Effectively active*: bit up; for Furled, up for ≥ `OPPONENT_FLAG_FURLED_DEBOUNCE_MS` (from `opponentFlagFurledSinceAt`).
- *In window* (any of): same class + same lap (lap-progress score `|Δ| < 1.0`) + class-position delta `playerPos − carPos ∈ [1..OPPONENT_FLAG_AHEAD_WINDOW]` → relation `"ahead"`; delta `carPos − playerPos === 1` → `"behind"`; else coarse forward gap ≤ enter/exit hysteresis bound → `"track-ahead"` (uses `OPPONENT_FLAG_TRACK_GAP_ENTER_S` when the car was outside last tick, `OPPONENT_FLAG_TRACK_GAP_EXIT_S` when inside — hysteresis; standings membership has no hysteresis). Standings relations use single-class `frozenPositions[carIdx]` when not multi-class (the #622 `classify` shape — copy its structure).
- *Announce* when: effectively active ∧ in window ∧ episode bit not in `opponentFlagAnnouncedMask` ∧ per-(car,flag) cooldown expired. On announce: set episode bit, stamp that flag's cooldown, push the aggregation timestamp (Task 6), emit with `trigger: activatedThisTick ? "raised" : "entered-range"` (`activatedThisTick` = became effectively-active on this tick).
- Gates (`!isRaceSession || replayOnlySession || preGreen || postRace || playerCarIdx < 0`) suppress the whole announce pass; the store/baselines still advance (Task 4 already does).
- The #846 escalation transition (Furled clears + Black sets in one tick) needs no special case: the furled episode ends via the level cleanup, the black announce is its own flag's first announce, and no cleared callouts exist. Add the test anyway.

- [ ] **Step 1: Write the failing tests** — drive `diffOpponentFlags` directly with explicit `now` (the harness from Task 4; `POSITIONS = [4, 1, 2, 3, 5, 6, 7, 8]`, player carIdx 0 = P4). Cases (each a real `it(...)` with exact emission assertions):

```typescript
it("announces a black flag rising on the car directly ahead (raised trigger)", () => {
  const t = makeField();
  run(state, t, 1000);
  t.CarIdxSessionFlags[3] = 0x50000; // carIdx 3 = P3, directly ahead of P4

  expect(run(state, t, 2000)).toEqual([
    {
      event: "opponentFlag.flagged",
      data: {
        relation: "ahead",
        carIdx: 3,
        flag: OpponentPenaltyFlag.Black,
        trigger: "raised",
        position: 3,
        isMultiClass: false,
      },
    },
  ]);
});
```

Plus (same structure, assert full emission or `[]`):
- ahead window spans 1–3 class positions (carIdx 2 = P2 qualifies; carIdx 1 = P1 also qualifies at delta 3); a 4-ahead car does not.
- behind is P+1 only (carIdx 4 = P5 qualifies; P6 does not).
- multi-class: an other-class car ahead in standings does NOT qualify via standings, still can via track-ahead; positions map through `classPositionFromOrder`.
- same-lap gate: a car with `CarIdxLapCompleted` one lower and score gap ≥ 1.0 fails standings qualification.
- furled debounce: rise at t=2000 → no emission; still up at t=3100 → emission with `trigger: "raised"`; flicker (down at t=2500) → nothing ever.
- furled escalation (#846): furled up (announced after debounce), then one tick clears Furled + sets Black → exactly ONE emission (black raised), furled episode latch cleared, no furled re-announce when furled rises again later (fresh episode → announces).
- entered-range: car at P+5 with active meatball → nothing; positions shift so it becomes P+1 → emission `trigger: "entered-range"`.
- track-ahead: flagged car 8 s ahead on track (use `LapDistPct`, `Speed: 50`, trackLength 5000 → car at player+0.08 = 400 m = 8 s) on a different lap → `relation: "track-ahead"`, `gapSeconds` ≈ 8, no `position` when the frozen order gives none... (assert `position` present only when > 0).
- hysteresis: car hovers at 10.5 s (inside 12 s exit bound after entering at ≤10 s) → stays "in window", no re-announce (episode latch covers it); car leaves to 13 s, flag clears + re-raises, re-enters at 9 s → announces again.
- episode latch across triggers: announced via raise, car leaves + re-enters window with the same flag episode → silent.
- per-(car,flag) cooldown: black announced at t=0, DQ rises on the same car at t=5000 → DQ announces immediately (escalation not suppressed); the same flag re-raised within 30 s → suppressed until its cooldown expires.
- gates: each of non-race / replay-only / pre-green / post-race / `playerCarIdx: -1` suppresses; a rise absorbed under a gate does not replay when the gate opens **as a raise** — but a still-active flag on an in-window car announces as `entered-range`-style level trigger once gates open (assert the emission exists and the trigger value is `"entered-range"`).
- pace car excluded (flag on `paceCarIdx` car → nothing); player excluded (own carIdx never announces).
- not-in-world cars skipped (`CarIdxLapCompleted`/`CarIdxLapDistPct` negative).

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** — extend the Task 4 module. Structure: `type FlagKey = "furled" | "black" | "repair" | "disqualify"`; a module-level `const FLAG_DEFS: Array<{ key: FlagKey; bit: number; flag: OpponentPenaltyFlag }>` table driving the per-flag loop (no copy-paste per flag); an internal `classify(telemetry, positions, playerCarIdx, carIdx, isMultiClass, trackLengthMeters, wasInWindow)` returning `{ relation: "ahead" | "behind" | "track-ahead"; position: number; gapSeconds?: number } | null` (copy the #622 `classify` structure for the class/same-lap part; append the track-ahead branch with hysteresis bound selection).
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** — `feat(sim-events): opponent penalty-flag callout qualifier (#936)` (+ trailer)

---

### Task 6: translator — burst aggregation + replay-wipe preservation

**Files:**
- Modify: `packages/sim-events-iracing/src/diff/opponent-flags.ts`
- Modify: `packages/sim-events-iracing/src/translator.ts` (`wipeStateForReplay` preserved cluster)
- Test: `packages/sim-events-iracing/src/diff/opponent-flags.test.ts`

- [ ] **Step 1: Failing tests**
- Three announces inside 12 s: first two individual, third emits `{ event: "opponentFlag.flagged", data: { relation: "others" } }` once; fourth+ silent.
- The episode flag (not the live count) holds the collapse: prune below threshold mid-episode → still silent; 12 s of quiet resets → individual lines resume.
- Preservation: run announces, call the real `wipeStateForReplay` path indirectly is not testable here — instead assert the preserved keys list in a translator test if one exists for #622's cluster (grep `translator.test.ts` for `opponentPitAggregateAnnounced`; mirror that test's shape for `opponentFlagAnnouncedMask`, `opponentFlagCooldownUntil`, `opponentFlagInWindow`, `opponentFlagRecentEntries`, `opponentFlagAggregateAnnounced`, `opponentFlagFurledSinceAt`). If no such test exists, cover it as: build state, snapshot fields, simulate the wipe body (create fresh + assign preserved) — or skip the unit test and rely on the review of the preserved-cluster edit.

- [ ] **Step 2: Run → FAIL; Step 3: Implement** — prune `opponentFlagRecentEntries` at tick start (the #622 lines 131–140 shape, with `opponentFlagAggregateAnnounced` reset on empty); in the announce path push `now` and branch: below threshold → individual emit; at threshold → set flag + emit `others`; flag set → silent. Extend `wipeStateForReplay`'s `preservedAcrossReplay` with the six fields above (comment: the #622 rationale verbatim-adapted; `opponentFlagBits`/`opponentFlagsInitialized` deliberately re-seed).
- [ ] **Step 4: Run full sim-events tests → PASS; build package**
- [ ] **Step 5: Commit** — `feat(sim-events): opponent-flag burst aggregation + replay preservation (#936)` (+ trailer)

---

### Task 7: translator — leader-white diff

**Files:**
- Create: `packages/sim-events-iracing/src/diff/leader-white.ts`
- Test: `packages/sim-events-iracing/src/diff/leader-white.test.ts`
- Modify: `packages/sim-events-iracing/src/state.ts` (4 fields), `packages/sim-events-iracing/src/translator.ts` (wire after `diffOpponentFlags`; add `leaderWhiteFired` to the preserved cluster), `packages/sim-events-iracing/src/diff/flags.ts` (green re-arm)

**Interfaces:**
- Produces: `diffLeaderWhite(state, telemetry, playerCarIdx, isRaceSession, replayOnlySession, preGreen, postRace, frozenPositions, emit): void`; emits `flag.white-leader.raised`.

State fields (+ initializers `-1`, `-1`, `null`, `false`):

```typescript
  // ── Leader's white flag (issue #936) ──────────────────────────────────
  /** Leader carIdx observed last tick (re-baselines silently on leader change). */
  leaderWhiteLastLeaderIdx: number;
  /** The leader's `CarIdxLapCompleted` last tick (timed-race crossing detection). */
  leaderWhiteLastLeaderLap: number;
  /** `SessionLapsRemainEx` last tick (lap-limited falling-to-1 edge); null until seeded. */
  leaderWhiteLastLapsRemainEx: number | null;
  /** Once-per-race latch. STICKY: preserved across the replay wipe; cleared per-session and by a GREEN rising edge (the #880 lesson). */
  leaderWhiteFired: boolean;
```

- [ ] **Step 1: Failing tests** (explicit telemetry; `POSITIONS` with a known leader):
- Lap-limited: `SessionLapsRemainEx` 3 → 2 ticks silent; 2 → 1 → emits `flag.white-leader.raised` once; 1 → 1 silent; latch blocks a later re-edge.
- Seed: first tick with `SessionLapsRemainEx: 1` (connect mid-final-lap) → silent forever this race.
- Timed: `SessionTimeRemain: 0`, leader's `CarIdxLapCompleted` increments (same leader) → emits; increment while `SessionTimeRemain > 0` → silent; leader change between ticks re-baselines silently (no emit on the new leader's next crossing unless clock expired and it's a genuine increment of the SAME tracked leader).
- Unlimited sentinels: `SessionLapsRemainEx >= IRSDK_UNLIMITED_LAPS` and `SessionTimeRemain >= IRSDK_UNLIMITED_TIME` are ignored (guard the reads like `translator.ts:1646–1664`).
- Suppression: leader === player → no emit, latch set; player's own `SessionFlags & Flags.White` up at the detection tick → no emit, latch set.
- Green re-arm: latch set, then `diffFlags` green rising edge clears it (test in `flags.test.ts`: extend the existing #880 green-case test asserting `playerFinalLapStarted` reset — add `leaderWhiteFired`).
- Gates: non-race / replay-only / pre-green / post-race → silent, baselines still advance.

- [ ] **Step 2: Run → FAIL; Step 3: Implement**

```typescript
export function diffLeaderWhite(
  state: TranslatorState,
  telemetry: TelemetryData,
  playerCarIdx: number,
  isRaceSession: boolean,
  replayOnlySession: boolean,
  preGreen: boolean,
  postRace: boolean,
  frozenPositions: number[],
  emit: EmitFn,
): void {
  const leaderIdx = frozenPositions.findIndex((p) => p === 1);
  const leaderLap = leaderIdx >= 0 ? (telemetry.CarIdxLapCompleted?.[leaderIdx] ?? -1) : -1;

  const rawLapsRemain = telemetry.SessionLapsRemainEx;
  const lapsRemain =
    typeof rawLapsRemain === "number" &&
    Number.isFinite(rawLapsRemain) &&
    rawLapsRemain >= 0 &&
    rawLapsRemain < IRSDK_UNLIMITED_LAPS
      ? rawLapsRemain
      : null;

  const timeRemain = telemetry.SessionTimeRemain;
  const clockExpired =
    typeof timeRemain === "number" && Number.isFinite(timeRemain) && timeRemain <= 0 && timeRemain > -IRSDK_UNLIMITED_TIME;

  const prevLapsRemain = state.leaderWhiteLastLapsRemainEx;
  const sameLeader = leaderIdx >= 0 && leaderIdx === state.leaderWhiteLastLeaderIdx;
  const leaderCrossed = sameLeader && leaderLap >= 0 && state.leaderWhiteLastLeaderLap >= 0 && leaderLap > state.leaderWhiteLastLeaderLap;

  const gated = !isRaceSession || replayOnlySession || preGreen || postRace || playerCarIdx < 0;

  if (!gated && !state.leaderWhiteFired) {
    const lapEdge = lapsRemain === 1 && prevLapsRemain !== null && prevLapsRemain >= 2;
    const timedEdge = clockExpired && leaderCrossed;

    if (lapEdge || timedEdge) {
      state.leaderWhiteFired = true;

      const playerWhiteUp = hasFlag(telemetry.SessionFlags, Flags.White);

      if (leaderIdx !== playerCarIdx && !playerWhiteUp) {
        emit({ event: "flag.white-leader.raised", data: {} });
      }
    }
  }

  state.leaderWhiteLastLeaderIdx = leaderIdx;
  state.leaderWhiteLastLeaderLap = leaderLap;
  state.leaderWhiteLastLapsRemainEx = lapsRemain;
}
```

(Adjust the `clockExpired` guard to whatever sentinel handling the tests pin down — `IRSDK_UNLIMITED_TIME` is a large positive; a plain `timeRemain <= 0 && timeRemain > -1e9` guard is acceptable if simpler.) Wire into `handleTick` after `diffOpponentFlags`; add the `diffFlags` green-case line `state.leaderWhiteFired = false;` beside the `playerFinalLapStarted` reset with a `// #936: overtime/admin-restart re-arm` comment; add `leaderWhiteFired: self.state.leaderWhiteFired,` to `preservedAcrossReplay`.

- [ ] **Step 4: Run sim-events + flags tests → PASS; build; Step 5: Commit** — `feat(sim-events): leader white-flag detection (#936)` (+ trailer)

---

### Task 8: audio-scenarios — opponent-flags catalog module + wiring

**Files:**
- Create: `packages/audio-scenarios/src/catalog/pit-crew/opponent-flags.ts`
- Test: `packages/audio-scenarios/src/catalog/pit-crew/opponent-flags.test.ts`
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/pools.ts` (14 registry entries)
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/index.ts` (imports/re-exports, two `registerPitCrew` params between `getLiveGaps` and `getRaceEngineerMasterEnabled`, registration loop block after the opponent-pit block)
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/register-pit-crew.test.ts:477`, `rolling-start.test.ts:291`, `start-lights.test.ts:400` (two `undefined` slots before the masters)

**Interfaces:**
- Consumes: `OpponentPenaltyFlag`, `SimEventOf<"opponentFlag.flagged">` (Task 1).
- Produces: `OPPONENT_FLAG_ALERTS` (13 scenarios), `OpponentFlagCalloutId = "furled" | "black" | "meatball" | "disqualify"`, `OPPONENT_FLAG_CALLOUT_SETTING_KEYS`, `SCENARIO_ID_TO_OPPONENT_FLAG_ID`, `OpponentFlagPending`, `OpponentFlagLivePositionResolver`, `registerOpponentFlagVars(engine, resolver)`, `_resetOpponentFlagPending()`, `OPPONENT_FLAG_SCENARIO_IDS`, `OPPONENT_FLAG_POOL_NAMES`. `registerPitCrew` params #46/#47 (before the masters): `getOpponentFlagCalloutEnabled: (id: OpponentFlagCalloutId) => boolean = () => true`, `getOpponentFlagLivePosition: OpponentFlagLivePositionResolver = () => null`.

**Scenario structure (one scenario per flag × relation, 12 + aggregate):** ids `pit-crew.opponent-flag-<subject>-<relation>` with subjects `furled|black|meatball|disqualify` and relations `ahead|behind|track-ahead`, plus `pit-crew.opponent-flag-others`. Weight by relation: `track-ahead` = `WEIGHT.SAFETY` (the approaching-an-impaired-car safety case), `ahead`/`behind`/aggregate = `WEIGHT.NORMAL`. All: no `family`, `interrupt: false`, `queueable: true`, radio-framed sequences (mirror `opponent-pit.ts` including its header rationale, adapted). `where:` checks relation + flag (`SUBJECT_TO_FLAG: Record<subject, OpponentPenaltyFlag>` with `meatball → OpponentPenaltyFlag.Repair`); `trigger` is deliberately ignored (same wording either way — the payload keeps it for the harness/future). The `ahead` scenarios validate `carIdx`/`position` integers exactly like opponent-pit's nearby and stash `pendingAhead` AFTER all checks; sequence `["pool:opponent-flag-car-in", { var: "opponentFlag.number" }, "pool:opponent-flag-<subject>-ahead-tail"]`. `behind`/`track-ahead`: single full-line pool. Var `opponentFlag.number` mirrors `opponentPit.number` byte-for-byte apart from names.

**Pool registry entries:**

```typescript
  "opponent-flag-car-in": { group: "opponent-pit", base: "car-in" },
  "opponent-flag-furled-ahead-tail": { group: "opponent-flags", base: "furled-ahead-tail" },
  "opponent-flag-black-ahead-tail": { group: "opponent-flags", base: "black-ahead-tail" },
  "opponent-flag-meatball-ahead-tail": { group: "opponent-flags", base: "meatball-ahead-tail" },
  "opponent-flag-disqualify-ahead-tail": { group: "opponent-flags", base: "disqualify-ahead-tail" },
  "opponent-flag-furled-behind": { group: "opponent-flags", base: "furled-behind" },
  "opponent-flag-black-behind": { group: "opponent-flags", base: "black-behind" },
  "opponent-flag-meatball-behind": { group: "opponent-flags", base: "meatball-behind" },
  "opponent-flag-disqualify-behind": { group: "opponent-flags", base: "disqualify-behind" },
  "opponent-flag-furled-track": { group: "opponent-flags", base: "furled-track" },
  "opponent-flag-black-track": { group: "opponent-flags", base: "black-track" },
  "opponent-flag-meatball-track": { group: "opponent-flags", base: "meatball-track" },
  "opponent-flag-disqualify-track": { group: "opponent-flags", base: "disqualify-track" },
  "opponent-flag-others": { group: "opponent-flags", base: "others" },
```

(`opponent-flag-car-in` deliberately REUSES the existing `opponent-pit/car-in` clip — the #568 clip-group-reuse precedent; pool names are distinct, the `(group, base)` source is shared.)

**Maps:** `OPPONENT_FLAG_CALLOUT_SETTING_KEYS = { furled: "calloutEnabledOpponentFlagFurled", black: "calloutEnabledOpponentFlagBlack", meatball: "calloutEnabledOpponentFlagMeatball", disqualify: "calloutEnabledOpponentFlagDisqualify" }`; `SCENARIO_ID_TO_OPPONENT_FLAG_ID` covers all 13 ids — each `<subject>-<relation>` to its subject, and `"pit-crew.opponent-flag-others": "black"` (the #622 aggregate-rides-a-subject shape; wording is penalty-generic and black is the central subject).

**index.ts registration block** (after the opponent-pit block, same shape):

```typescript
  // Opponent-flag family (issue #936). One scenario per flag × relation so
  // every line is individually harness-firable and the safety-relevant
  // track-ahead lines carry SAFETY weight; both diff triggers ride the same
  // scenarios. Family-less + queueable for the same reason as opponent-pit:
  // the lines describe DIFFERENT cars — queue, never chop.
  registerOpponentFlagVars(engine, getOpponentFlagLivePosition);

  for (const s of OPPONENT_FLAG_ALERTS) {
    engine.defineScenario(
      wrapWithMaster(
        wrapCalloutScenario(
          s,
          SCENARIO_ID_TO_OPPONENT_FLAG_ID,
          getOpponentFlagCalloutEnabled,
          "opponent-flag callout",
          logger,
        ),
      ),
    );
  }
```

- [ ] **Step 1: Write the failing tests** — mirror `opponent-pit.test.ts` (the fork report has its harness verbatim): scenario lookup helper, `flagged(relation, flag, overrides)` event factory; cases: relation+flag routing (a black event fires only the black scenario of its relation), trigger is ignored (`raised` and `entered-range` both pass), ahead validity rejection (missing/fractional position), stash written only after checks + not clobbered by a suppressed different-relation event, var prefers live resolver in the stashed projection with payload fallback, aggregate maps to `"black"` in `SCENARIO_ID_TO_OPPONENT_FLAG_ID`, every scenario id present in the map, weights (`track-ahead` scenarios at `WEIGHT.SAFETY`, others `WEIGHT.NORMAL`), all scenarios `queueable: true` + no `family`, pool-name list matches the registry entries.
- [ ] **Step 2: Run → FAIL; Step 3: Implement module + pools + index wiring; Step 4: Update the three positional test callers** (add `undefined /* getOpponentFlagCalloutEnabled */, undefined /* getOpponentFlagLivePosition */,` before the master args at the exact lines listed above).
- [ ] **Step 5: Run the audio-scenarios package tests → PASS; build package; Step 6: Commit** — `feat(audio): opponent-flag scenario family (#936)` (+ trailer)

---

### Task 9: audio-scenarios — leader-white scenario

**Files:**
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/flag-alerts.ts` (scenario after `WHITE_LAST_LAP`, added to `FLAG_ALERTS`)
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/pools.ts` (`"flag-white-leader": { group: "flags", base: "white-leader" }` beside the other white entries)
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/index.ts` (`SCENARIO_ID_TO_FLAG_ID` entry — the map is module-private there, NOT in flag-alerts.ts)
- Test: `packages/audio-scenarios/src/catalog/pit-crew/flag-alerts.test.ts` (append)

- [ ] **Step 1: Failing tests** — WHITE_LEADER exists in `FLAG_ALERTS` with id `pit-crew.flag-white-leader`, `queueable: true`, `family: "flag"`, weight `WEIGHT.SAFETY` (inherited from `flagScenario`), `when.event === "flag.white-leader.raised"`, `where:` race-only (mock `getSessionType`); `FLAG_POOL_NAMES` picks up `flag-white-leader` automatically (prefix filter).
- [ ] **Step 2: Run → FAIL; Step 3: Implement**

```typescript
// The leader's final lap (issue #936, stage 3 of the white family): fired by
// the translator's lap-count detection — most valuable when we're far behind
// the leader and our own white is still minutes away. The diff latches once
// per race (green re-arms) and suppresses when the player IS the leader or
// already has their own white up, so this can never double up with the
// #772 heads-up. Rides `calloutEnabledFlagWhite` (one subject, the #772
// precedent); `queueable: true` for the same one-shot-latch reason as
// WHITE_LAST_LAP.
const WHITE_LEADER: Scenario = {
  ...flagScenario("white-leader", ["pool:flag-white-leader"]),
  queueable: true,
  when: { event: "flag.white-leader.raised", where: () => raceOnly() },
};
```

Add `WHITE_LEADER` to `FLAG_ALERTS` after `WHITE_LAST_LAP`; in `index.ts` add `"pit-crew.flag-white-leader": "white",` under the stage-2 line with a `// Stage 3 — the leader's final lap (issue #936), same subject/opt-in.` comment.

- [ ] **Step 4: Run → PASS; build; Step 5: Commit** — `feat(audio): leader final-lap white callout (#936)` (+ trailer)

---

### Task 10: opt-ins — schema, test literals, PI, all three plugins

**Files:**
- Modify: `packages/deck-core/src/global-settings.ts` (4 fields after `calloutEnabledOpponentPitNearby` ~line 418)
- Modify: `packages/deck-core/src/simhub-service.test.ts` (BOTH literals — after line 90 and after line 285)
- Modify: `packages/iracing-actions/src/actions/pit-crew/pit-crew.ejs` (array beside `opponentPitCallouts` ~line 151; item after the "Opponent Pits" block ~line 438; TABS)
- Modify: `packages/iracing-plugin-stream-deck/src/plugin.ts`, `packages/iracing-plugin-mirabox/src/plugin.ts`, `packages/iracing-plugin-ulanzi/src/plugin.ts` (imports + two closures between the `getLiveGaps` arg and the Race Engineer master arg)

- [ ] **Step 1: Schema fields** (the standard coercion, default true, one comment block):

```typescript
    // Opponent-flag callout opt-ins (issue #936). Four subjects — penalty
    // flags on cars that matter to us (standings neighbours + slow traffic
    // ahead). Canonical id↔key mapping in `OPPONENT_FLAG_CALLOUT_SETTING_KEYS`.
    calloutEnabledOpponentFlagFurled: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledOpponentFlagBlack: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledOpponentFlagMeatball: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    calloutEnabledOpponentFlagDisqualify: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
```

- [ ] **Step 2: Add the four keys (`: true,`) to BOTH `simhub-service.test.ts` literals** at the listed lines.
- [ ] **Step 3: PI item** — in `pit-crew.ejs`, beside the opponent-pit array (TAB indentation):

```javascript
			// Opponent-flag callouts (issue #936). Four subjects — penalty flags
			// on cars near us. Same 2-column auto-balancing grid as above.
			var opponentFlagCallouts = [
				{ setting: "calloutEnabledOpponentFlagFurled", label: "Furled black flag (warning)" },
				{ setting: "calloutEnabledOpponentFlagBlack", label: "Black flag" },
				{ setting: "calloutEnabledOpponentFlagMeatball", label: "Meatball (repairs)" },
				{ setting: "calloutEnabledOpponentFlagDisqualify", label: "Disqualified" },
			];
			var opponentFlagRowCount = Math.ceil(opponentFlagCallouts.length / 2);
			var opponentFlagCheckboxes = opponentFlagCallouts.map(function (c) {
				return '<sdpi-checkbox setting="' + c.setting + '" label="' + c.label + '" global default="true"></sdpi-checkbox>';
			}).join('');
```

And the item after the "Opponent Pits" item:

```javascript
				'<sdpi-item label="Opponent Flags">' +
					'<div style="display:grid;grid-template-rows:repeat(' + opponentFlagRowCount + ',auto);grid-auto-flow:column;gap:4px 12px;width:100%;">' +
						opponentFlagCheckboxes +
					'</div>' +
				'</sdpi-item>' +
```

- [ ] **Step 4: Plugin closures ×3** — extend the `@iracedeck/audio-scenarios` import block with `OPPONENT_FLAG_CALLOUT_SETTING_KEYS, type OpponentFlagCalloutId, type OpponentFlagPending,` and insert between the `() => getLiveGaps()` argument and the Race Engineer master argument. Stream-deck (verbose comment):

```typescript
  // Opponent-flag callout opt-ins (issue #936). Live-read, four subjects.
  (id: OpponentFlagCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[OPPONENT_FLAG_CALLOUT_SETTING_KEYS[id]] !== false,
  // Opponent-flag live position resolver (issue #936) — same shape as the
  // opponent-pit resolver above: canonical position at speak time, read in
  // the stash's projection, null → emit-time payload fallback.
  (pending: OpponentFlagPending): number | null => {
    const live = getLiveCarPosition(pending.carIdx);

    if (!live) return null;

    const n = pending.isMultiClass ? live.classPosition : live.position;

    return n > 0 ? n : null;
  },
```

Mirabox + ulanzi: identical code, abbreviated comments — and those two files must stay byte-identical to each other (diff them after editing).

- [ ] **Step 5: Build + test with the schema-change guard**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-936 && set -o pipefail && pnpm build --force 2>&1 | tail -5 && pnpm test 2>&1 | tail -5
```

Expected: build fails ONLY on the missing harness `event-names.ts` entries (Task 11) if it reaches that package — if so, note it and proceed; every other package must be green.

- [ ] **Step 6: Commit** — `feat(settings): opponent-flag opt-ins + PI + plugin wiring (#936)` (+ trailer)

---

### Task 11: scenario harness — event templates + shortcuts

**Files:**
- Modify: `packages/scenario-harness/src/event-names.ts` (two entries; `flag.white-leader.raised` in the `── Flags ──` section, `opponentFlag.flagged` near `opponentPit.entered`)
- Modify: `packages/scenario-harness/src/scenario-shortcuts.ts` (14 buttons)

- [ ] **Step 1: Event templates**

```typescript
  {
    name: "opponentFlag.flagged",
    description:
      "A penalty flag on another car matters to us (issue #936) — relation: ahead / behind / track-ahead / others",
    data: { relation: "ahead", carIdx: 7, flag: "black", trigger: "raised", position: 5 },
  },
```

```typescript
  { name: "flag.white-leader.raised", description: "The overall leader is starting their final lap (issue #936)", data: {} },
```

- [ ] **Step 2: Shortcuts** — category `"Opponent Flags"`, one per flag × relation (12) + aggregate, mirroring the opponent-pit block's comment style; payloads use `carIdx: 7, position: 5` for ahead (spliced number), `carIdx: 12` for behind, `carIdx: 13, gapSeconds: 8` for track-ahead. Labels like `"P5 ahead: black flag"`, `"Behind: meatball"`, `"Track ahead: DQ"`, `"Several cars flagged"`. Leader-white goes under the existing flags category: `{ id: "flag-white-leader", category: "Flags", label: "Leader's final lap", description: 'The overall leader starts their final lap — "The leader is about to start their final lap."', event: "flag.white-leader.raised", data: {} }`.
- [ ] **Step 3: Root build now must fully pass (the completeness check closes):**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-936 && set -o pipefail && pnpm build 2>&1 | tail -5 && pnpm test 2>&1 | tail -5
```

- [ ] **Step 4: Commit** — `feat(harness): opponent-flag + leader-white event templates and shortcuts (#936)` (+ trailer)

---

### Task 12: voice lines — config, DRY-RUN CHECKPOINT, generation

**Files:**
- Modify: `packages/audio-assets/configs/default.voice.json` (new `opponent-flags` group + `white-leader-01` in `flags`)
- Generated (committed after approval): `packages/audio-assets/voice/default/opponent-flags/*.mp3`, `packages/audio-assets/voice/default/flags/white-leader-01.mp3`, `generate.manifest.json`, `manifest.json`

- [ ] **Step 1: Copy `.env.local` from the master checkout into the worktree root** (`cp C:/Users/Niklas/Projects/iRaceDeck/master/.env.local C:/Users/Niklas/Projects/iRaceDeck/ir-936/.env.local`).
- [ ] **Step 2: Add the config entries** — `opponent-flags` group (ahead tails carry `previous_request_ids: ["position-number/4"]`, the `is-pitting-01` precedent; omit `seed` → defaults to 1):

```json
"opponent-flags": [
  { "name": "furled-ahead-tail-01", "text": "has a furled black flag. They're on notice.", "previous_request_ids": ["position-number/4"] },
  { "name": "black-ahead-tail-01", "text": "has a black flag. They'll be serving a penalty.", "previous_request_ids": ["position-number/4"] },
  { "name": "meatball-ahead-tail-01", "text": "has a meatball. Expect them to slow.", "previous_request_ids": ["position-number/4"] },
  { "name": "disqualify-ahead-tail-01", "text": "has been disqualified. They're out of the fight.", "previous_request_ids": ["position-number/4"] },
  { "name": "furled-behind-01", "text": "The car behind has a furled black flag." },
  { "name": "black-behind-01", "text": "The car behind has a black flag. That pressure should ease." },
  { "name": "meatball-behind-01", "text": "The car behind has a meatball. They'll be coming in for repairs." },
  { "name": "disqualify-behind-01", "text": "The car behind has been disqualified." },
  { "name": "furled-track-01", "text": "The car ahead on track has a furled black flag." },
  { "name": "black-track-01", "text": "The car ahead on track has a black flag." },
  { "name": "meatball-track-01", "text": "Careful. <break time=\"0.3s\" /> The car ahead on track has a meatball. They could be slow." },
  { "name": "disqualify-track-01", "text": "The car ahead on track has been disqualified. They may pull off." },
  { "name": "others-01", "text": "Several cars around us have penalty flags." }
]
```

`flags` group addition: `{ "name": "white-leader-01", "text": "The leader is about to start their final lap." }`.

The spliced ahead lines read: "The car in, P5, has a meatball. Expect them to slow."

- [ ] **Step 3: Scoped dry-runs**

```bash
pnpm --filter @iracedeck/audio-assets generate:dry-run --group opponent-flags
pnpm --filter @iracedeck/audio-assets generate:dry-run --group flags
```

Expected: exactly the 13 new opponent-flags entries + `white-leader-01` listed as WOULD GENERATE; everything else cache hits.

- [ ] **Step 4: CHECKPOINT — STOP. Show Niklas every wording + the dry-run output and wait for explicit approval.** Do not run `generate` before it. Adjust texts on feedback and re-dry-run.
- [ ] **Step 5 (after approval): Generate + manifest + audition**

```bash
pnpm --filter @iracedeck/audio-assets generate --group opponent-flags
pnpm --filter @iracedeck/audio-assets generate --group flags
pnpm --filter @iracedeck/audio-assets generate:manifest
```

- [ ] **Step 6: Commit clips + config + BOTH manifests** — `feat(audio): opponent-flag + leader-white voice clips (#936)` (+ trailer)

---

### Task 13: docs — website, changelog, rules

**Files:**
- Modify: `packages/website/src/content/docs/docs/actions/audio-voice/pit-crew.md` (new family section after "Opponent pit entries (races)"; new opt-in block in the per-subject list)
- Modify: `packages/website/src/content/docs/changelog.mdx` (`## 2.4.0` Features bullet)
- Modify: `.claude/rules/race-positions.md` (consumer list entry)
- Modify: `.claude/rules/race-engineer-callout-examples.md` (new entry)

- [ ] **Step 1: pit-crew.md** — prose section `## Opponent penalty flags (races)` in the established style: which flags, the two triggers in plain words, the window (1–3 ahead / directly behind / slow traffic within ~10 s), spoken-line examples in italics, aggregation paragraph, session gating paragraph, closing pointer to the opt-ins. Separate short section (or a paragraph in the white-flag section) for the leader's final lap noting it rides the White flag opt-in. Opt-in list block: four `calloutEnabledOpponentFlag*` bullets under **Opponent Flags**.
- [ ] **Step 2: changelog.mdx** — one Features bullet under `## 2.4.0`, e.g.: `- The Race Engineer now warns about penalty flags on cars around you — furled warnings, black flags, meatballs, and disqualifications for the cars you're racing or slow traffic you're catching — and announces when the race leader starts their final lap.`
- [ ] **Step 3: race-positions.md** — consumer bullet: opponent-flag callouts classify against the frozen order; `getLiveOpponentFlags()` is the flag-data seam.
- [ ] **Step 4: race-engineer-callout-examples.md** — entry for #936 naming the patterns: per-car flag-state store with a truth/policy split + reusable `getLiveOpponentFlags` accessor; level-triggered announce with per-episode latch unifying raise/range-entry triggers; per-(car,flag) cooldown so escalations never suppress; weight-by-relation on shared scenarios; clip reuse across groups (`opponent-pit/car-in`).
- [ ] **Step 5: Website build check** — `pnpm --filter @iracedeck/website build 2>&1 | tail -3` (MDX must pass).
- [ ] **Step 6: Commit** — `docs: opponent-flag callout documentation + changelog (#936)` (+ trailer)

---

### Task 14: full verification

- [ ] **Step 1:** `cd C:/Users/Niklas/Projects/iRaceDeck/ir-936 && set -o pipefail && pnpm install 2>&1 | tail -3 && pnpm build --force 2>&1 | tail -5 && pnpm test 2>&1 | tail -5 && pnpm lint:fix 2>&1 | tail -5 && pnpm format:fix 2>&1 | tail -5`
- [ ] **Step 2:** Fix EVERYTHING that surfaces (including pre-existing-looking issues — house rule), re-run until green, commit any fixes (`fix:`/`chore:` as appropriate, + trailer).
- [ ] **Step 3:** `git status` must be clean except intended changes; `git log --oneline master..ir-936` lists the task commits.
- [ ] **Step 4:** Report ready for manual testing (scenario harness first: `pnpm --filter @iracedeck/scenario-harness dev` → `127.0.0.1:5750`; then live iRacing). Do NOT push or open a PR — Niklas manually tests first, then asks for `/code-review xhigh --fix`, then the PR.
