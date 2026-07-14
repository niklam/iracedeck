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
  const sumExpectedNonStarters = results.reduce((sum, result, i) => sum + (result.started ? 0 : expectedScores[i]), 0);

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
 * from the field: the pace car, spectators, cars with no valid iRating, and
 * cars not in the order (rank 0). Class fields with fewer than 2 cars yield
 * null. Memoized on the input values, so repeated per-tick calls are free
 * until positions or the field actually change.
 */
export function estimateIRatingChanges(input: IRatingEstimateInput): IRatingEstimates {
  const signature = inputSignature(input);

  if (memoResult && memoSignature === signature) return memoResult;

  const size = Math.max(input.order.length, ...input.drivers.map((d) => d.CarIdx + 1), 0);
  const changes: (number | null)[] = new Array<number | null>(size).fill(null);
  const sofs: (number | null)[] = new Array<number | null>(size).fill(null);

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
