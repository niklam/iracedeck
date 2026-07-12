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
