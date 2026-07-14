# Estimated iRating Gain/Loss (#268) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the estimated iRating change ("if the race ended now") on a Session Info mode and expose `irating_change` / `irating_new` (all driver prefixes) + `session.sof` as template variables.

**Architecture:** A pure, memoized calculator in `@iracedeck/iracing-sdk` (`irating-utils.ts`, beside `position-utils.ts`) consumed by (1) `buildTemplateContextFromData` in the template context and (2) a new `irating` mode in the Session Info action. The canonical live order arrives as a function argument — no `SDKController` changes, no plugin wiring. Spec: `docs/superpowers/specs/2026-07-12-irating-estimate-design.md`.

**Tech Stack:** TypeScript, Zod, Vitest, EJS PI templates. Reference algorithm: [Turbo87/irating-rs](https://github.com/Turbo87/irating-rs) `src/lib.rs` (MIT/Apache-2.0).

## Global Constraints

- Race-positions rule: consume the canonical live order (`order` argument / `getLiveRacePositions()`), never recompute or blend orders (`.claude/rules/race-positions.md`).
- Field membership: rank > 0 in the order, `CarIsPaceCar !== 1`, `IsSpectator !== 1`, `IRating > 0`. Class fields with < 2 cars → `null` estimates.
- Multiclass: group by `CarIdxClass`; class rank derived from the same canonical order.
- Display forms: change `+31` / `-15` / `0` (signed, rounded); SOF rounded int. Raw values unrounded; `irating_new = Math.round(irating + change)` (integer, matches the reference).
- Blank (empty display / absent raw / empty key value) when: non-race session, no live order, car not in field, class field < 2 cars.
- All commits local; **no push, no PR** (user tests manually first).
- After edits: `pnpm lint:fix`, `pnpm format:fix`, `pnpm build`, `pnpm test` at repo root (`C:/Users/Niklas/Projects/iRaceDeck/ir-268`).

---

### Task 1: Core formula — `calculateIRatingChanges` + `calculateSof`

**Files:**
- Create: `packages/iracing-sdk/src/irating-utils.ts`
- Create: `packages/iracing-sdk/src/irating-utils.test.ts`
- Modify: `packages/iracing-sdk/src/index.ts:120` (add export line next to position-utils)

**Interfaces:**
- Produces: `calculateIRatingChanges(results: IRatingRaceResult[]): number[]` where `IRatingRaceResult = { finishRank: number; startIRating: number; started: boolean }`; `calculateSof(iratings: number[]): number`. Both exported from `@iracedeck/iracing-sdk`.

- [ ] **Step 1: Write the failing test** — `packages/iracing-sdk/src/irating-utils.test.ts` with the 28-driver reference vectors (from `irating-rs` snapshot; f32→f64 tolerance ±0.05):

```typescript
import { describe, expect, it } from "vitest";

import { calculateIRatingChanges, calculateSof } from "./irating-utils.js";

/**
 * Reference vectors from Turbo87/irating-rs (src/snapshots/irating__tests__it_works.snap):
 * [finishRank, startIRating, started, expectedChange]. Driver 14 is the one non-starter.
 * The reference uses f32; we compute in f64, so changes are compared with ±0.05 tolerance.
 */
const REFERENCE_FIELD: [number, number, boolean, number][] = [
  [1, 7526, true, 17.63672],
  [2, 5982, true, 25.833923],
  [3, 5463, true, 25.432884],
  [4, 4279, true, 37.92791],
  [5, 4137, true, 33.394478],
  [6, 4044, true, 27.948332],
  [7, 3891, true, 23.814116],
  [8, 3612, true, 22.626814],
  [9, 3147, true, 26.485985],
  [10, 2823, true, 27.702335],
  [11, 2715, true, 23.36419],
  [12, 2603, true, 19.21653],
  [13, 2512, true, 14.53251],
  [14, 2352, false, 10.437519],
  [15, 2227, true, 8.5288105],
  [16, 2195, true, 2.2037997],
  [17, 2166, true, -4.2093577],
  [18, 2089, true, -9.06982],
  [19, 1773, true, -5.7882223],
  [20, 1772, true, -13.086736],
  [21, 1752, true, -19.722021],
  [22, 1748, true, -26.915356],
  [23, 1705, true, -32.73568],
  [24, 1662, true, -38.54108],
  [25, 1622, true, -44.439545],
  [26, 1537, true, -48.679874],
  [27, 1464, true, -53.308353],
  [28, 1203, true, -50.590836],
];

describe("calculateIRatingChanges", () => {
  it("matches the reference implementation's 28-driver vectors", () => {
    const changes = calculateIRatingChanges(
      REFERENCE_FIELD.map(([finishRank, startIRating, started]) => ({ finishRank, startIRating, started })),
    );

    for (const [i, [, , , expected]] of REFERENCE_FIELD.entries()) {
      expect(Math.abs(changes[i] - expected)).toBeLessThan(0.05);
    }
  });

  it("returns an empty array for an empty field", () => {
    expect(calculateIRatingChanges([])).toEqual([]);
  });

  it("is zero-sum for an all-starter field (within float tolerance of the fudge)", () => {
    const changes = calculateIRatingChanges([
      { finishRank: 1, startIRating: 2000, started: true },
      { finishRank: 2, startIRating: 2000, started: true },
    ]);

    // Equal ratings: winner gains what the loser roughly loses; both non-zero.
    expect(changes[0]).toBeGreaterThan(0);
    expect(changes[1]).toBeLessThan(0);
  });
});

describe("calculateSof", () => {
  it("equals the rating for a uniform field", () => {
    expect(calculateSof([2000, 2000, 2000])).toBeCloseTo(2000, 6);
  });

  it("sits between min and max, below the arithmetic mean (log-mean weights lower ratings)", () => {
    const sof = calculateSof([1000, 2000]);

    expect(sof).toBeGreaterThan(1000);
    expect(sof).toBeLessThan(1500);
  });

  it("increases when a driver is replaced by a stronger one", () => {
    expect(calculateSof([1000, 3000])).toBeGreaterThan(calculateSof([1000, 2000]));
  });

  it("returns 0 for an empty field", () => {
    expect(calculateSof([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/iracing-sdk/src/irating-utils.test.ts`
Expected: FAIL — cannot resolve `./irating-utils.js`.

- [ ] **Step 3: Write the implementation** — `packages/iracing-sdk/src/irating-utils.ts`:

```typescript
/**
 * iRating estimation utilities (issue #268).
 *
 * Faithful port of the community-documented Elo-style iRating model
 * (reference: Turbo87/irating-rs, itself derived from the iRacing SOF/iRating
 * calculator spreadsheet). Pure functions — the canonical live race order is
 * passed in as data, never computed here (see .claude/rules/race-positions.md).
 */

/** Elo-style base factor: 1600 / ln(2). */
const BR1 = 1600 / Math.LN2;

export interface IRatingRaceResult {
  /** 1-based finishing rank within the field. */
  finishRank: number;
  startIRating: number;
  /** Non-starters get the reference model's DNS penalty distribution. */
  started: boolean;
}

/** Probability that a driver rated `a` beats a driver rated `b`. */
function chance(a: number, b: number): number {
  const expA = Math.exp(-a / BR1);
  const expB = Math.exp(-b / BR1);

  return ((1 - expA) * expB) / ((1 - expB) * expA + (1 - expA) * expB);
}

/**
 * Per-entry estimated iRating change for a finished (or as-if-finished) field.
 * Direct port of the reference `calculate()`; result order matches input order.
 */
export function calculateIRatingChanges(results: IRatingRaceResult[]): number[] {
  const numRegistrations = results.length;

  if (numRegistrations === 0) return [];

  const numStarters = results.filter((r) => r.started).length;
  const numNonStarters = numRegistrations - numStarters;

  const expectedScores = results.map(
    (self) => results.reduce((sum, other) => sum + chance(self.startIRating, other.startIRating), 0) - 0.5,
  );

  const changesStarters = results.map((result, i) => {
    if (!result.started) return null;

    const x = numRegistrations - numNonStarters / 2;
    const fudge = (x / 2 - result.finishRank) / 100;

    return ((numRegistrations - result.finishRank - expectedScores[i] - fudge) * 200) / numStarters;
  });

  if (numNonStarters === 0) return changesStarters as number[];

  const sumChangesStarters = changesStarters.reduce<number>((sum, c) => sum + (c ?? 0), 0);
  const sumExpectedNonStarters = results.reduce(
    (sum, result, i) => sum + (result.started ? 0 : expectedScores[i]),
    0,
  );

  return results.map((result, i) => {
    const starterChange = changesStarters[i];

    if (starterChange !== null) return starterChange;

    return ((-sumChangesStarters / numNonStarters) * expectedScores[i]) / (sumExpectedNonStarters / numNonStarters);
  });
}

/**
 * Strength of Field: the 1600/ln(2) log-mean of the field's iRatings.
 * A uniform field's SOF equals that rating. Returns 0 for an empty field.
 */
export function calculateSof(iratings: number[]): number {
  if (iratings.length === 0) return 0;

  const sum = iratings.reduce((acc, ir) => acc + Math.exp(-ir / BR1), 0);

  return BR1 * Math.log(iratings.length / sum);
}
```

- [ ] **Step 4: Export from the package index** — in `packages/iracing-sdk/src/index.ts`, directly below the `position-utils` export line (`:120`):

```typescript
export {
  calculateIRatingChanges,
  calculateSof,
  estimateIRatingChanges,
  type IRatingEstimateInput,
  type IRatingEstimates,
  type IRatingRaceResult,
} from "./irating-utils.js";
```

(Note: `estimateIRatingChanges` / its types land in Task 2 — add the full export block now and let Task 2 fill the module; or export only the Task 1 names now and extend in Task 2. Either way the final state is this block.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/iracing-sdk/src/irating-utils.test.ts`
Expected: PASS (all vectors within tolerance).

- [ ] **Step 6: Commit**

```bash
git add packages/iracing-sdk/src/irating-utils.ts packages/iracing-sdk/src/irating-utils.test.ts packages/iracing-sdk/src/index.ts
git commit -m "feat(iracing-sdk): add iRating change + SOF calculator (#268)"
```

---

### Task 2: Field estimator — `estimateIRatingChanges` (grouping, exclusions, memo)

**Files:**
- Modify: `packages/iracing-sdk/src/irating-utils.ts` (append)
- Modify: `packages/iracing-sdk/src/irating-utils.test.ts` (append)

**Interfaces:**
- Consumes: `calculateIRatingChanges`, `calculateSof` (Task 1).
- Produces:

```typescript
export interface IRatingFieldDriver {
  CarIdx: number;
  IRating?: number;
  CarIsPaceCar?: number;
  IsSpectator?: number;
}

export interface IRatingEstimateInput {
  drivers: IRatingFieldDriver[];
  /** Canonical live order: 1-based rank by carIdx, 0 = not classified. */
  order: number[];
  /** Per-car class id (telemetry CarIdxClass). Missing → single-class field. */
  carIdxClass?: number[];
}

export interface IRatingEstimates {
  /** Estimated (unrounded) iRating change by carIdx; null = not in the field. */
  changes: (number | null)[];
  /** SOF of the car's class field by carIdx; null = not in the field. */
  sofs: (number | null)[];
}

export function estimateIRatingChanges(input: IRatingEstimateInput): IRatingEstimates;
```

- Memoized on a value signature of (order, drivers' iRating/flags, classes): repeated calls with equal inputs return the **same object**.

- [ ] **Step 1: Write the failing tests** (append to `irating-utils.test.ts`):

```typescript
import { calculateIRatingChanges, calculateSof, estimateIRatingChanges } from "./irating-utils.js";
// (merge into the existing import statement)

function makeFieldDriver(carIdx: number, irating: number, overrides: Record<string, number> = {}) {
  return { CarIdx: carIdx, IRating: irating, CarIsPaceCar: 0, IsSpectator: 0, ...overrides };
}

describe("estimateIRatingChanges", () => {
  it("maps class-field changes back by carIdx (single class)", () => {
    // carIdx 0 leads, carIdx 2 second, carIdx 1 third.
    const drivers = [makeFieldDriver(0, 3000), makeFieldDriver(1, 2000), makeFieldDriver(2, 2500)];
    const order = [1, 3, 2];

    const result = estimateIRatingChanges({ drivers, order });

    const expected = calculateIRatingChanges([
      { finishRank: 1, startIRating: 3000, started: true },
      { finishRank: 3, startIRating: 2000, started: true },
      { finishRank: 2, startIRating: 2500, started: true },
    ]);

    expect(result.changes[0]).toBeCloseTo(expected[0], 10);
    expect(result.changes[1]).toBeCloseTo(expected[1], 10);
    expect(result.changes[2]).toBeCloseTo(expected[2], 10);

    const sof = calculateSof([3000, 2000, 2500]);

    expect(result.sofs[0]).toBeCloseTo(sof, 10);
    expect(result.sofs[1]).toBeCloseTo(sof, 10);
  });

  it("groups by class and uses class-relative ranks", () => {
    // Class 100: carIdx 0 (overall 1) and carIdx 2 (overall 3) → class ranks 1, 2.
    // Class 200: carIdx 1 (overall 2) and carIdx 3 (overall 4) → class ranks 1, 2.
    const drivers = [
      makeFieldDriver(0, 3000),
      makeFieldDriver(1, 2100),
      makeFieldDriver(2, 2900),
      makeFieldDriver(3, 2000),
    ];
    const order = [1, 2, 3, 4];
    const carIdxClass = [100, 200, 100, 200];

    const result = estimateIRatingChanges({ drivers, order, carIdxClass });

    const class100 = calculateIRatingChanges([
      { finishRank: 1, startIRating: 3000, started: true },
      { finishRank: 2, startIRating: 2900, started: true },
    ]);
    const class200 = calculateIRatingChanges([
      { finishRank: 1, startIRating: 2100, started: true },
      { finishRank: 2, startIRating: 2000, started: true },
    ]);

    expect(result.changes[0]).toBeCloseTo(class100[0], 10);
    expect(result.changes[2]).toBeCloseTo(class100[1], 10);
    expect(result.changes[1]).toBeCloseTo(class200[0], 10);
    expect(result.changes[3]).toBeCloseTo(class200[1], 10);

    expect(result.sofs[0]).toBeCloseTo(calculateSof([3000, 2900]), 10);
    expect(result.sofs[1]).toBeCloseTo(calculateSof([2100, 2000]), 10);
  });

  it("excludes pace car, spectators, invalid iRatings, and unclassified cars", () => {
    const drivers = [
      makeFieldDriver(0, 3000),
      makeFieldDriver(1, 2500),
      makeFieldDriver(2, 2400, { CarIsPaceCar: 1 }),
      makeFieldDriver(3, 2300, { IsSpectator: 1 }),
      makeFieldDriver(4, 0), // invalid iRating
      makeFieldDriver(5, 2200), // rank 0 — not classified
    ];
    const order = [1, 2, 3, 4, 5, 0];

    const result = estimateIRatingChanges({ drivers, order });

    expect(result.changes[2]).toBeNull();
    expect(result.changes[3]).toBeNull();
    expect(result.changes[4]).toBeNull();
    expect(result.changes[5]).toBeNull();
    expect(result.sofs[2]).toBeNull();

    // The remaining 2-car field still computes.
    expect(result.changes[0]).not.toBeNull();
    expect(result.changes[1]).not.toBeNull();
  });

  it("returns null for class fields with fewer than 2 cars", () => {
    const drivers = [makeFieldDriver(0, 3000), makeFieldDriver(1, 2000)];
    const order = [1, 2];
    const carIdxClass = [100, 200]; // each alone in its class

    const result = estimateIRatingChanges({ drivers, order, carIdxClass });

    expect(result.changes[0]).toBeNull();
    expect(result.changes[1]).toBeNull();
    expect(result.sofs[0]).toBeNull();
  });

  it("returns all-null shells for an empty order", () => {
    const result = estimateIRatingChanges({ drivers: [makeFieldDriver(0, 3000)], order: [] });

    expect(result.changes.every((c) => c === null)).toBe(true);
  });

  it("memoizes: equal inputs return the same object, changed order recomputes", () => {
    const drivers = [makeFieldDriver(0, 3000), makeFieldDriver(1, 2000)];

    const a = estimateIRatingChanges({ drivers, order: [1, 2] });
    const b = estimateIRatingChanges({ drivers: [...drivers.map((d) => ({ ...d }))], order: [1, 2] });
    const c = estimateIRatingChanges({ drivers, order: [2, 1] });

    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run packages/iracing-sdk/src/irating-utils.test.ts`
Expected: FAIL — `estimateIRatingChanges` not exported.

- [ ] **Step 3: Implement** (append to `irating-utils.ts`):

```typescript
export interface IRatingFieldDriver {
  CarIdx: number;
  IRating?: number;
  CarIsPaceCar?: number;
  IsSpectator?: number;
}

export interface IRatingEstimateInput {
  drivers: IRatingFieldDriver[];
  /** Canonical live order: 1-based rank by carIdx, 0 = not classified. */
  order: number[];
  /** Per-car class id (telemetry CarIdxClass). Missing → single-class field. */
  carIdxClass?: number[];
}

export interface IRatingEstimates {
  /** Estimated (unrounded) iRating change by carIdx; null = not in the field. */
  changes: (number | null)[];
  /** SOF of the car's class field by carIdx; null = not in the field. */
  sofs: (number | null)[];
}

/** Single-entry memo — inputs rarely change between ticks (only on overtakes / session updates). */
let memoSignature: string | null = null;
let memoResult: IRatingEstimates | null = null;

function inputSignature(input: IRatingEstimateInput): string {
  const drivers = input.drivers
    .map((d) => `${d.CarIdx}:${d.IRating ?? ""}:${d.CarIsPaceCar ?? ""}:${d.IsSpectator ?? ""}`)
    .join(",");

  return `${input.order.join(",")}|${drivers}|${input.carIdxClass?.join(",") ?? ""}`;
}

/**
 * Estimated iRating change + class SOF per car, treating the canonical live
 * order as the finishing order ("if the race ended now"). Cars are grouped by
 * class and scored within their class field (iRacing scores classes
 * separately); class rank is derived from the same canonical order. Excluded
 * from the field: pace car, spectators, cars with no valid iRating, and cars
 * not in the order (rank 0). Class fields with fewer than 2 cars yield null.
 */
export function estimateIRatingChanges(input: IRatingEstimateInput): IRatingEstimates {
  const signature = inputSignature(input);

  if (memoResult && memoSignature === signature) return memoResult;

  const size = Math.max(input.order.length, ...input.drivers.map((d) => d.CarIdx + 1), 0);
  const changes: (number | null)[] = new Array(size).fill(null);
  const sofs: (number | null)[] = new Array(size).fill(null);

  // Field membership + class grouping.
  const byClass = new Map<number, { carIdx: number; rank: number; irating: number }[]>();

  for (const driver of input.drivers) {
    const rank = input.order[driver.CarIdx] ?? 0;
    const irating = driver.IRating ?? 0;

    if (rank <= 0 || irating <= 0 || driver.CarIsPaceCar === 1 || driver.IsSpectator === 1) continue;

    const classId = input.carIdxClass?.[driver.CarIdx] ?? -1;
    const group = byClass.get(classId) ?? [];
    group.push({ carIdx: driver.CarIdx, rank, irating });
    byClass.set(classId, group);
  }

  for (const group of byClass.values()) {
    if (group.length < 2) continue;

    // Class rank = position within the class, ordered by the canonical overall rank.
    group.sort((a, b) => a.rank - b.rank);

    const groupChanges = calculateIRatingChanges(
      group.map((entry, i) => ({ finishRank: i + 1, startIRating: entry.irating, started: true })),
    );
    const sof = calculateSof(group.map((entry) => entry.irating));

    for (const [i, entry] of group.entries()) {
      changes[entry.carIdx] = groupChanges[i];
      sofs[entry.carIdx] = sof;
    }
  }

  memoSignature = signature;
  memoResult = { changes, sofs };

  return memoResult;
}
```

- [ ] **Step 4: Run to verify all pass**

Run: `npx vitest run packages/iracing-sdk/src/irating-utils.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-sdk/src/irating-utils.ts packages/iracing-sdk/src/irating-utils.test.ts packages/iracing-sdk/src/index.ts
git commit -m "feat(iracing-sdk): add per-class live iRating estimator with memoization (#268)"
```

---

### Task 3: Template variables — `irating_change` / `irating_new` (all prefixes) + `session.sof`

**Files:**
- Modify: `packages/iracing-sdk/src/template-context.ts`
- Modify: `packages/iracing-sdk/src/template-context.test.ts` (append)

**Interfaces:**
- Consumes: `estimateIRatingChanges`, `IRatingEstimates` from `./irating-utils.js` (Task 2).
- Produces: template keys `self.irating_change`, `self.irating_new` (likewise on `track_ahead`, `track_behind`, `race_ahead`, `race_behind`, `focused`), `session.sof`. Display: `+31` / `-15` / `0` (rounded) and rounded SOF; raw: unrounded change / unrounded SOF; `irating_new` integer in both.

- [ ] **Step 1: Write the failing tests** (append inside the existing `describe("buildTemplateContextFromData", …)` — the existing `makeDriver`/`makeSessionInfo`/`makeTelemetry` helpers already produce a Race session):

```typescript
  describe("iRating estimate variables (#268)", () => {
    const IRATING_DRIVERS = [
      makeDriver({ CarIdx: 0, UserName: "Player One", IRating: 3000 }),
      makeDriver({ CarIdx: 1, UserName: "Rival Two", CarNumber: "2", IRating: 2500 }),
      makeDriver({ CarIdx: 2, UserName: "Rival Three", CarNumber: "3", IRating: 2000 }),
    ];
    // Live order: carIdx1 leads, player second, carIdx2 third.
    const IRATING_ORDER = [2, 1, 3];
    const IRATING_TELEMETRY = makeTelemetry({ CarIdxClass: [100, 100, 100] } as Partial<TelemetryData>);

    it("exposes irating_change and irating_new on self and relative prefixes", () => {
      const ctx = buildTemplateContextFromData(IRATING_TELEMETRY, makeSessionInfo(IRATING_DRIVERS, 0), IRATING_ORDER);

      // Player runs P2 of 3 with the middle rating: some change is defined.
      expect(ctx.raw["self.irating_change"]).toBeTypeOf("number");
      expect(ctx.raw["self.irating_new"]).toBeTypeOf("number");
      expect(ctx.raw["race_ahead.irating_change"]).toBeTypeOf("number");
      expect(ctx.raw["race_behind.irating_change"]).toBeTypeOf("number");

      const change = ctx.raw["self.irating_change"] as number;

      expect(ctx.raw["self.irating_new"]).toBe(Math.round(3000 + change));
    });

    it("formats the display form signed and rounded", () => {
      const ctx = buildTemplateContextFromData(IRATING_TELEMETRY, makeSessionInfo(IRATING_DRIVERS, 0), IRATING_ORDER);

      const change = ctx.raw["self.irating_change"] as number;
      const rounded = Math.round(change);
      const expected = rounded > 0 ? `+${rounded}` : String(rounded);

      expect(ctx.display["self.irating_change"]).toBe(expected);
    });

    it("exposes session.sof as the player's class SOF", () => {
      const ctx = buildTemplateContextFromData(IRATING_TELEMETRY, makeSessionInfo(IRATING_DRIVERS, 0), IRATING_ORDER);

      const sof = ctx.raw["session.sof"] as number;

      expect(sof).toBeGreaterThan(2000);
      expect(sof).toBeLessThan(3000);
      expect(ctx.display["session.sof"]).toBe(String(Math.round(sof)));
    });

    it("renders blank with no live order (non-race / pre-init)", () => {
      const nonRace = makeSessionInfo(IRATING_DRIVERS, 0);
      (nonRace as unknown as { SessionInfo: { Sessions: { SessionType: string }[] } }).SessionInfo.Sessions = [
        { SessionType: "Practice" },
      ];

      const ctx = buildTemplateContextFromData(IRATING_TELEMETRY, nonRace, IRATING_ORDER);

      expect(ctx.display["self.irating_change"]).toBe("");
      expect(ctx.raw["self.irating_change"]).toBeUndefined();
      expect(ctx.display["session.sof"]).toBe("");
      expect(ctx.raw["session.sof"]).toBeUndefined();
    });

    it("renders blank for a driver excluded from the field", () => {
      const drivers = [...IRATING_DRIVERS, makeDriver({ CarIdx: 3, UserName: "No Rating", IRating: 0 })];
      // Focus the camera on the no-rating car.
      const telemetry = makeTelemetry({ CamCarIdx: 3, CarIdxClass: [100, 100, 100, 100] } as Partial<TelemetryData>);

      const ctx = buildTemplateContextFromData(telemetry, makeSessionInfo(drivers, 0), [2, 1, 3, 4]);

      expect(ctx.display["focused.irating_change"]).toBe("");
      expect(ctx.raw["focused.irating_change"]).toBeUndefined();
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/iracing-sdk/src/template-context.test.ts`
Expected: FAIL — new keys missing (raw undefined but display keys absent too).

- [ ] **Step 3: Implement in `template-context.ts`:**

3a. Import (top of file):

```typescript
import { estimateIRatingChanges, type IRatingEstimates } from "./irating-utils.js";
```

3b. Extend `DriverFields` (after `irating: number | undefined;`):

```typescript
  irating_change: number | undefined;
  irating_new: number | undefined;
```

and `EMPTY_DRIVER_FIELDS`:

```typescript
  irating_change: undefined,
  irating_new: undefined,
```

3c. Signed display formatting in `fieldsToMaps` — replace the loop body:

```typescript
/** Fields whose display form is the signed, rounded integer (+31 / -15 / 0). */
const SIGNED_INT_DISPLAY_FIELDS = new Set(["irating_change"]);

function fieldsToMaps(fields: Record<string, DriverFieldValue>): FieldMaps {
  const display: Record<string, string> = {};
  const raw: Record<string, TemplateValue> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value != null && typeof value === "number" && SIGNED_INT_DISPLAY_FIELDS.has(key)) {
      const rounded = Math.round(value);
      display[key] = rounded > 0 ? `+${rounded}` : String(rounded);
    } else {
      display[key] = value != null ? String(value) : "";
    }

    if (value != null) {
      raw[key] = value;
    }
  }

  return { display, raw };
}
```

3d. Thread the estimates through the builders. In `buildTemplateContextFromData`, after the `order` line:

```typescript
  // Estimated iRating change per car ("if the race ended now", #268) — computed
  // from the same canonical order; memoized inside the estimator so the O(n²)
  // math only re-runs when positions actually change.
  const estimates = order
    ? estimateIRatingChanges({ drivers, order, carIdxClass: telemetry?.CarIdxClass as number[] | undefined })
    : undefined;
```

Pass `estimates` as a new trailing argument to `buildSelfFields(selfDriver, playerCarIdx, telemetry, order, estimates)` and every `driverMaps(…, telemetry, order, playerCarIdx, estimates)` call (trackAhead, trackBehind, raceAhead, raceBehind, focused), and to `buildSessionFields(sessionInfo, telemetry, estimates, playerCarIdx)`.

3e. `driverMaps` / `buildSelfFields` / `buildDriverFields` signatures gain `estimates?: IRatingEstimates`; `buildDriverFields` adds (using its existing `isCompetitor`):

```typescript
    // Estimated iRating change (#268): null/undefined → blank. irating_new is
    // the projected post-race rating, integer like the reference implementation.
    irating_change: isCompetitor ? (estimates?.changes[carIdx] ?? undefined) : undefined,
    irating_new:
      isCompetitor && estimates?.changes[carIdx] != null && driver.IRating > 0
        ? Math.round(driver.IRating + estimates.changes[carIdx])
        : undefined,
```

(TypeScript narrowing: capture `const change = estimates?.changes[carIdx];` above the return and use it in both fields to satisfy strict null checks.)

3f. `buildSessionFields(sessionInfo, telemetry, estimates?, playerCarIdx?)` adds the SOF (only when the player is in a computed field):

```typescript
  const sof = playerCarIdx !== undefined && playerCarIdx >= 0 ? (estimates?.sofs[playerCarIdx] ?? null) : null;

  // …into raw (conditionally) and display:
  if (sof !== null) {
    raw.sof = sof;
  }
  // display: sof: sof !== null ? String(Math.round(sof)) : "",
```

- [ ] **Step 4: Run the package tests**

Run: `npx vitest run packages/iracing-sdk`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-sdk/src/template-context.ts packages/iracing-sdk/src/template-context.test.ts
git commit -m "feat(iracing-sdk): expose irating_change/irating_new/session.sof template variables (#268)"
```

---

### Task 4: Session Info `irating` mode + PI option

**Files:**
- Modify: `packages/iracing-actions/src/actions/session-info/session-info.ts`
- Modify: `packages/iracing-actions/src/actions/session-info/session-info.ejs`
- Modify: `packages/iracing-actions/src/actions/session-info/session-info.test.ts`

**Interfaces:**
- Consumes: `estimateIRatingChanges` from `@iracedeck/iracing-sdk` (Task 2), `getLiveRacePositions` from `@iracedeck/sim-events-iracing` (existing translator accessor).
- Produces: mode value `"irating"` in `SessionInfoSettings.mode`; value string `+31`/`-15`/`0`/`""`; green/red value coloring via a new optional `valueColor` argument on `generateSessionInfoSvg`.

- [ ] **Step 1: Write the failing tests** (append to `session-info.test.ts`; also update the module mocks: add `"irating"` to the mock schema's `validModes` array, and add `getLiveRacePositions: vi.fn(() => null)` to the `vi.mock("@iracedeck/sim-events-iracing", …)` factory, importing it alongside the other mocked accessors):

```typescript
describe("irating mode", () => {
  // Race session with a 3-car single-class field; the player (carIdx 0) runs P2.
  const IRATING_SESSION_INFO = {
    DriverInfo: {
      DriverCarIdx: 0,
      Drivers: [
        { CarIdx: 0, UserName: "Player", CarNumber: "1", IRating: 3000, CarIsPaceCar: 0, IsSpectator: 0 },
        { CarIdx: 1, UserName: "Leader", CarNumber: "2", IRating: 2500, CarIsPaceCar: 0, IsSpectator: 0 },
        { CarIdx: 2, UserName: "Trailer", CarNumber: "3", IRating: 2000, CarIsPaceCar: 0, IsSpectator: 0 },
      ],
    },
    SessionInfo: { Sessions: [{ SessionType: "Race" }] },
  };

  function makeIratingAction(order: number[] | null, sessionInfo: unknown = IRATING_SESSION_INFO) {
    vi.mocked(getLiveRacePositions).mockReturnValue(order);
    const action = new SessionInfoAction(mockLogger());
    (action as unknown as { sdkController: unknown }).sdkController = {
      getCurrentTelemetry: vi.fn(() => ({ SessionNum: 0, CarIdxClass: [100, 100, 100] })),
      getSessionInfo: vi.fn(() => sessionInfo),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };

    return action;
  }
  // NOTE: reuse this file's existing action-construction/mocking helpers if present —
  // match the surrounding tests' pattern for instantiating SessionInfo with a mocked
  // sdkController rather than introducing a parallel one.

  it("shows a signed negative value when the player runs below expectation", () => {
    // Player has the highest rating but runs P2 → expected to lose points.
    const action = makeIratingAction([2, 1, 3]);
    const value = (action as never as { extractDisplayValue: (s: unknown, t: unknown) => string })[
      "extractDisplayValue"
    ]({ mode: "irating" }, { SessionNum: 0, CarIdxClass: [100, 100, 100] });

    expect(value).toMatch(/^-\d+$/);
  });

  it("shows a plus-signed value when the player runs above expectation", () => {
    // Lowest-rated player (carIdx 2 perspective isn't possible — player is DriverCarIdx 0),
    // so give the player the lowest rating and the lead.
    const sessionInfo = {
      DriverInfo: {
        DriverCarIdx: 0,
        Drivers: [
          { CarIdx: 0, UserName: "Player", CarNumber: "1", IRating: 2000, CarIsPaceCar: 0, IsSpectator: 0 },
          { CarIdx: 1, UserName: "Rival", CarNumber: "2", IRating: 3000, CarIsPaceCar: 0, IsSpectator: 0 },
        ],
      },
      SessionInfo: { Sessions: [{ SessionType: "Race" }] },
    };
    const action = makeIratingAction([1, 2], sessionInfo);
    const value = (action as never as { extractDisplayValue: (s: unknown, t: unknown) => string })[
      "extractDisplayValue"
    ]({ mode: "irating" }, { SessionNum: 0, CarIdxClass: [100, 100] });

    expect(value).toMatch(/^\+\d+$/);
  });

  it("renders blank when there is no live order", () => {
    const action = makeIratingAction(null);
    const value = (action as never as { extractDisplayValue: (s: unknown, t: unknown) => string })[
      "extractDisplayValue"
    ]({ mode: "irating" }, { SessionNum: 0 });

    expect(value).toBe("");
  });

  it("renders blank in a non-race session", () => {
    const sessionInfo = { ...IRATING_SESSION_INFO, SessionInfo: { Sessions: [{ SessionType: "Practice" }] } };
    const action = makeIratingAction([2, 1, 3], sessionInfo);
    const value = (action as never as { extractDisplayValue: (s: unknown, t: unknown) => string })[
      "extractDisplayValue"
    ]({ mode: "irating" }, { SessionNum: 0, CarIdxClass: [100, 100, 100] });

    expect(value).toBe("");
  });
});

describe("iratingValueColor", () => {
  it("is green for gains, red for losses, undefined at zero/blank", () => {
    expect(iratingValueColor("+31")).toBe("#2ecc71");
    expect(iratingValueColor("-15")).toBe("#e74c3c");
    expect(iratingValueColor("0")).toBeUndefined();
    expect(iratingValueColor("")).toBeUndefined();
  });
});
```

(Import `iratingValueColor` from `./session-info.js`; adjust the action-instantiation pattern to the file's existing helper — the tests above show intent, use the established mock shape.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run packages/iracing-actions/src/actions/session-info/session-info.test.ts`
Expected: FAIL — `"irating"` invalid mode / `iratingValueColor` not exported.

- [ ] **Step 3: Implement in `session-info.ts`:**

3a. Imports: add `estimateIRatingChanges` to the `@iracedeck/iracing-sdk` import; add `getLiveRacePositions` to the `@iracedeck/sim-events-iracing` import.

3b. Mode enum (line ~54): add `"irating"` after `"position"`:

```typescript
    .enum(["incidents", "time-remaining", "laps", "position", "irating", "fuel", "flags", "track-wetness", "laps-to-empty"])
```

3c. Value color helper + constants (near `BACKGROUND_FLASH`):

```typescript
const IRATING_GAIN_COLOR = "#2ecc71";
const IRATING_LOSS_COLOR = "#e74c3c";

/**
 * @internal Exported for testing
 *
 * Value color for the irating mode: green for a gain, red for a loss,
 * undefined (theme text color) for zero or blank.
 */
export function iratingValueColor(value: string): string | undefined {
  if (value.startsWith("+")) return IRATING_GAIN_COLOR;

  if (value.startsWith("-")) return IRATING_LOSS_COLOR;

  return undefined;
}
```

3d. `generateSessionInfoSvg` — add trailing optional param `valueColor?: string` and use it for the value text only (title keeps `textColor`): in the `renderIconTemplate` data change `textColor` to `textColor: valueColor ?? textColor`. (The title fill was already resolved into `titleContent` beforehand, so this only affects the value element.) Add `irating: "IRATING"` to `titleLabels`.

3e. `extractDisplayValue` — add before the `if (!telemetry)` block (mirroring the `track-wetness` early case):

```typescript
    // Estimated iRating change (#268): "+31" / "-15" / "0", blank when no
    // estimate is possible (non-race, no live order, player not in the field).
    if (settings.mode === "irating") {
      return this.extractIRatingValue(telemetry);
    }
```

and the private method (near `countActiveCars`):

```typescript
  private extractIRatingValue(telemetry: TelemetryData | null): string {
    if (!this.isRaceSession(telemetry)) return "";

    const order = getLiveRacePositions();

    if (!order) return "";

    const sessionInfo = this.sdkController.getSessionInfo();
    const driverInfo = sessionInfo?.DriverInfo as
      | { Drivers?: Array<Record<string, unknown>>; DriverCarIdx?: number }
      | undefined;
    const drivers = driverInfo?.Drivers;
    const playerCarIdx = driverInfo?.DriverCarIdx;

    if (!Array.isArray(drivers) || playerCarIdx === undefined) return "";

    const estimates = estimateIRatingChanges({
      drivers: drivers as unknown as Parameters<typeof estimateIRatingChanges>[0]["drivers"],
      order,
      carIdxClass: telemetry?.CarIdxClass as number[] | undefined,
    });
    const change = estimates.changes[playerCarIdx];

    if (change == null) return "";

    const rounded = Math.round(change);

    return rounded > 0 ? `+${rounded}` : String(rounded);
  }
```

3f. Wire the color into both render paths. In `updateDisplay` and `updateDisplayFromTelemetry`, compute and pass:

```typescript
    const valueColor = settings.mode === "irating" ? iratingValueColor(value) : undefined;
    // …
    generateSessionInfoSvg(settings, value, isFlashing, colorOverride, trackWetnessState, valueColor);
```

(The flash/pulse paths only run for `incidents`/`flags` modes and stay unchanged.) `buildStateKey` already includes `value`, and the color is a pure function of the value, so no state-key change is needed.

3g. PI (`session-info.ejs`): add after the Position option (line ~14):

```html
				<option value="irating">iRating Gain/Loss</option>
```

No new sub-settings and no visibility JS (Font Size already applies to all modes). Display-only mode → no comms-catalog entry, no `ird-binding-status`.

- [ ] **Step 4: Run the action tests**

Run: `npx vitest run packages/iracing-actions/src/actions/session-info/session-info.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-actions/src/actions/session-info/
git commit -m "feat(actions): add estimated iRating gain/loss mode to Session Info (#268)"
```

---

### Task 5: Docs, changelog, skill, rules + full verification

**Files:**
- Modify: `packages/website/src/content/docs/docs/actions/display-session/session-info.md`
- Modify: `packages/website/src/content/docs/docs/features/template-variables.md`
- Modify: `packages/website/src/content/docs/changelog.mdx`
- Modify: `.claude/skills/iracedeck-actions/SKILL.md`
- Modify: `.claude/rules/race-positions.md`

**Interfaces:** documentation only.

- [ ] **Step 1: Website Session Info page** — bump frontmatter badge to `"9 modes"`, extend the `description` to mention the iRating estimate, and insert a new mode section after **Position** (before **Fuel**), following the page's existing Details-block shape:

```markdown
### iRating Gain/Loss

Show your estimated iRating change if the race ended now — e.g. `+31` in green when you're gaining, `-15` in red when you're losing. The estimate uses the community-documented formula over your class's field (each car class is scored separately, exactly like iRacing does) and the live running order. It already shows a value on the grid and through the pace lap — "what you'd get finishing where you are". The value is blank outside race sessions, and whenever no estimate is possible.

:::note
This is an **estimate**, not the official post-race value — iRacing does not expose the official iRating change in real time. Retired and towed cars stay frozen at their last position, mirroring how iRacing scores a retirement.
:::

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the value updates live as positions change, green for a gain and red for a loss

#### Setting: Font Size

Size of the rendered value, in PI units (5–36, doubled for SVG render). Defaults to `14`.

---
```

- [ ] **Step 2: Template variables page** — in the Driver Info table (after the `{{self.irating}}` row):

```markdown
| `{{self.irating_change}}` | Estimated iRating change if the race ended now (e.g., `+31` / `-15`; race sessions only) |
| `{{self.irating_new}}` | Projected post-race iRating (current + estimated change; race sessions only) |
```

and after the Driver Info intro paragraphs, a short note:

```markdown
`irating_change` and `irating_new` are **estimates** computed from the live running order and the field's iRatings (per car class, like iRacing scores them) — not official post-race values. They render blank outside race sessions, before a live order exists, and for cars excluded from scoring (pace car, spectators, missing iRating). In expressions, `irating_change` is the unrounded value — wrap it in `round(...)` to match the displayed number.
```

In the Session table (after `{{session.time_remaining}}`):

```markdown
| `{{session.sof}}` | Strength of Field of your class (estimated, race sessions only) |
```

- [ ] **Step 3: Changelog** — add under `## 2.1.0` → `**Features**`:

```markdown
- Session Info gained an **iRating Gain/Loss** mode showing your estimated iRating change if the race ended now — green when gaining, red when losing, live from the grid onward. The same estimate is available as template variables — `irating_change` and `irating_new` on every driver prefix, plus `session.sof` for your class's Strength of Field — for Telemetry Display, Chat, and Race Admin templates, expressions included.
```

- [ ] **Step 4: Skill + rules** — in `.claude/skills/iracedeck-actions/SKILL.md`, update the Session Info row: mode count `8` → `9`, add `irating (estimated gain/loss if the race ended now, green/red value; #268)` to the mode list; check the JSON block near line 18 for a mode count to bump. In `.claude/rules/race-positions.md`, add to **Current consumers**:

```markdown
- **iRating estimate (#268)** — `estimateIRatingChanges` (`@iracedeck/iracing-sdk` `irating-utils.ts`): the template variables (`irating_change` / `irating_new` / `session.sof`) consume the injected order in `buildTemplateContextFromData`; the Session Info → iRating mode consumes `getLiveRacePositions()` directly.
```

Also grep for other stale mode counts: `grep -rn "8 modes\|eight modes" packages/website docs .claude` and fix any hits.

- [ ] **Step 5: Full verification**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-268
pnpm lint:fix && pnpm format:fix
pnpm build
pnpm test
pnpm --filter @iracedeck/website build
```

Expected: all pass; website build renders `/changelog/` and the updated pages.

- [ ] **Step 6: Commit**

```bash
git add packages/website .claude/skills/iracedeck-actions/SKILL.md .claude/rules/race-positions.md
git commit -m "docs: document iRating estimate mode and template variables (#268)"
```
