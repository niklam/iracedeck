/**
 * The QUALIFYING GRID — the starting order iRacing publishes in session YAML,
 * and the shape knowledge needed to read it.
 *
 * `QualifyResultsInfo.Results` is a **top-level** session-YAML key (a sibling of
 * `SessionInfo`, not nested inside it). iRacing populates it the moment the grid
 * is set — for standing and rolling starts alike, and even for race-only events
 * where there was no qualifying session (the grid is seeded from iRating there).
 * That makes it the only order that exists before the green flag: both
 * `CarIdxPosition` and the lap-progress order read empty through the whole
 * formation phase, because iRacing scores positions at start/finish and no car
 * has crossed it yet (issues #647, #974).
 *
 * Two consumers read it through this module — the canonical race order's
 * pre-green source (`@iracedeck/sim-events-iracing` `race-order.ts`) and the
 * iRating estimate's last-resort order (`irating-utils.ts`) — so the parsing
 * rules live in exactly one place.
 */

/**
 * One `QualifyResultsInfo.Results[]` entry. `Position` is **0-indexed** (the
 * pole sitter reads `0`), matching iRacing's `ResultsPositions` convention;
 * `-1` is its "no result" sentinel. Only the two fields the grid order needs
 * are modelled — the raw entry also carries `ClassPosition`, `FastestLap` and
 * `FastestTime`, which no consumer reads (class position is derived from the
 * order via `classPositionFromOrder`, never sourced independently — see
 * `.claude/rules/race-positions.md`).
 */
export interface QualifyResult {
  CarIdx?: number;
  Position?: number;
}

/** Upper bound for a plausible carIdx — guards corrupt session YAML from sizing huge arrays. */
const MAX_QUALIFY_CAR_IDX = 255;

/**
 * Extract the qualifying grid from parsed session info — the top-level
 * session-YAML `QualifyResultsInfo.Results` key.
 *
 * @returns The raw entries, or `undefined` when the key is absent or not a list.
 */
export function extractQualifyResults(sessionInfo: unknown): QualifyResult[] | undefined {
  const qualifyInfo = (sessionInfo as Record<string, unknown> | null | undefined)?.QualifyResultsInfo as
    Record<string, unknown> | undefined;
  const results = qualifyInfo?.Results;

  return Array.isArray(results) ? (results as QualifyResult[]) : undefined;
}

/**
 * Build a race-order array from the qualifying grid: 1-based rank indexed by
 * `carIdx`, `0` for every car with no grid entry — the same shape
 * `calculateRacePositions` returns, so consumers can't tell the two apart.
 *
 * Session YAML can contain null list items, fractional or absurd indices, and
 * NaN positions, and this runs inside the per-tick render path — every
 * malformed entry is skipped and nothing throws. Two uniqueness rules keep the
 * result a valid race order rather than a transcription of the YAML:
 *
 * - **One rank per grid slot.** A `Position` already claimed by another car is
 *   dropped. Duplicate ranks would break position-relative selection
 *   (`findDriverByRacePosition` resolving `race_ahead` / `race_behind`), the
 *   very property `.claude/rules/race-positions.md` requires of the canonical
 *   order.
 * - **One rank per car.** A repeated `CarIdx` keeps its first (best) slot.
 *
 * Ranks are NOT compacted: a grid with an unusable entry keeps a hole in the
 * numbering rather than renumbering everyone behind it, so every car that IS
 * listed reports its true grid slot. Consumers already tolerate holes — they
 * look up "who is at rank N" and get nothing.
 *
 * @returns The order, or `null` when no entry was usable (the caller then falls
 *          back to whatever live order it has).
 */
export function calculateGridPositions(results: QualifyResult[]): number[] | null {
  const ranks = new Map<number, number>();
  const claimed = new Set<number>();

  for (const entry of results as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;

    const { CarIdx: carIdx, Position: position } = entry as QualifyResult;

    if (!Number.isInteger(carIdx) || (carIdx as number) < 0 || (carIdx as number) > MAX_QUALIFY_CAR_IDX) continue;

    if (!Number.isInteger(position) || (position as number) < 0) continue;

    if (ranks.has(carIdx as number) || claimed.has(position as number)) continue;

    claimed.add(position as number);
    ranks.set(carIdx as number, (position as number) + 1); // Position is 0-indexed
  }

  if (ranks.size === 0) return null;

  const order = new Array<number>(Math.max(...ranks.keys()) + 1).fill(0);

  for (const [carIdx, rank] of ranks) order[carIdx] = rank;

  return order;
}
