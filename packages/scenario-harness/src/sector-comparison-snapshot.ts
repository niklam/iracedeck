/**
 * Harness-side store for the sector comparison (issue #1572).
 *
 * The sector-comparison family reads `PitCrewDeps.getSectorComparison()`: the
 * track's sector count and, for the player, the class leader and the two
 * neighbours, each car's recorded laps with their measured sector times. The
 * production translator builds it from a lap timer over live telemetry, which
 * the harness does not run, so (like the three other snapshots) the harness
 * holds the fully composed input: a shortcut posts it to
 * `/api/sector-comparison/snapshot` before publishing its `lap.completed`, and
 * `race-engineer-overrides.ts` answers the dependency from here.
 *
 * {@link composeSectorComparison} builds those inputs from the picture a
 * button is meant to produce: per-sector deltas, player minus target, so a
 * positive delta is a sector the player is slower in.
 */
import type { SectorCarInput, SectorComparisonInput, SectorLapInput } from "@iracedeck/audio-scenarios/pit-crew";

let current: SectorComparisonInput | null = null;

/** The comparison the sector-comparison family reads at fire time, or null. */
export function getHarnessSectorComparison(): SectorComparisonInput | null {
  return current;
}

/** Replace the harness sector comparison (called by the snapshot endpoint); null clears it. */
export function setHarnessSectorComparison(input: SectorComparisonInput | null): void {
  current = input;
}

function validateLap(lap: unknown, where: string): string | null {
  if (typeof lap !== "object" || lap === null) return `${where} must be an object`;

  const l = lap as Record<string, unknown>;

  if (typeof l.lap !== "number" || !Number.isInteger(l.lap) || l.lap < 1) {
    return `${where}.lap must be a positive integer`;
  }

  if (
    !Array.isArray(l.sectorTimes) ||
    l.sectorTimes.some((t) => t !== null && (typeof t !== "number" || !Number.isFinite(t)))
  ) {
    return `${where}.sectorTimes must be an array of finite numbers or null`;
  }

  if (typeof l.clean !== "boolean") return `${where}.clean must be a boolean`;

  return null;
}

function validateCar(car: unknown, where: string): string | null {
  if (typeof car !== "object" || car === null) return `${where} must be an object`;

  const c = car as Record<string, unknown>;

  if (typeof c.carIdx !== "number" || !Number.isInteger(c.carIdx) || c.carIdx < 0) {
    return `${where}.carIdx must be a non-negative integer`;
  }

  if (c.carNumber !== null && typeof c.carNumber !== "string") return `${where}.carNumber must be a string or null`;

  if (c.gapSeconds !== null && (typeof c.gapSeconds !== "number" || !Number.isFinite(c.gapSeconds))) {
    return `${where}.gapSeconds must be a finite number or null`;
  }

  if (
    c.lapsCompleted !== null &&
    (typeof c.lapsCompleted !== "number" || !Number.isInteger(c.lapsCompleted) || c.lapsCompleted < 0)
  ) {
    return `${where}.lapsCompleted must be a non-negative integer or null`;
  }

  if (!Array.isArray(c.recentLaps)) return `${where}.recentLaps must be an array`;

  for (const [i, lap] of c.recentLaps.entries()) {
    const error = validateLap(lap, `${where}.recentLaps[${i}]`);

    if (error !== null) return error;
  }

  return null;
}

/**
 * Shape-check an incoming `/api/sector-comparison/snapshot` body. Returns the
 * input on success, `null` when the caller wants to clear the stored one, or a
 * user-facing error string on the first failed field. Same lightweight style
 * as the other harness snapshot endpoints.
 */
export function validateSectorComparison(body: unknown): SectorComparisonInput | null | string {
  if (body === null) return null;

  if (typeof body !== "object") return "body must be an object or null";

  const b = body as Record<string, unknown>;

  if (typeof b.sectorCount !== "number" || !Number.isInteger(b.sectorCount) || b.sectorCount < 0) {
    return "sectorCount must be a non-negative integer";
  }

  const playerError = validateCar(b.player, "player");

  if (playerError !== null) return playerError;

  for (const key of ["leader", "ahead", "behind"] as const) {
    if (b[key] === null) continue;

    const error = validateCar(b[key], key);

    if (error !== null) return error;
  }

  return body as SectorComparisonInput;
}

/** The sector times of the player's laps in a composed picture, every lap alike (up to four sectors). */
export const PLAYER_SECTOR_TIMES: readonly number[] = [30, 40, 25, 20];

/** How many clean recent laps each car carries: the family's recent window. */
const COMPOSED_LAPS = 5;

function composedLaps(lap: number, sectorTimes: readonly number[]): SectorLapInput[] {
  return Array.from({ length: COMPOSED_LAPS }, (_, k) => ({
    lap: lap - (COMPOSED_LAPS - 1) + k,
    sectorTimes: [...sectorTimes],
    clean: true,
  }));
}

/**
 * One composed target: its car, its live gap to the player (null for the
 * leader, who is not a neighbour) and the per-sector deltas the picture is
 * built on, player minus target, so a positive delta is a sector the target
 * is quicker in.
 */
export type ComposedTarget = {
  carIdx: number;
  carNumber: string;
  gapSeconds: number | null;
  deltas: readonly number[];
};

/**
 * A comparison whose reference gaps are exactly `deltas` (player minus target,
 * per sector), the player's newest lap being `lap`.
 *
 * Every car has completed `lap` laps and carries five clean laps ending on
 * it, its last five completed, so each reference is the
 * median of three identical laps and the delta of a sector is the difference
 * of the two cars' times. `sectorCount` sectors use the first `sectorCount` of
 * {@link PLAYER_SECTOR_TIMES}. A target left out is `null`.
 */
export function composeSectorComparison(options: {
  lap: number;
  sectorCount: number;
  player: { carIdx: number; carNumber: string };
  leader?: ComposedTarget;
  ahead?: ComposedTarget;
  behind?: ComposedTarget;
}): SectorComparisonInput {
  const playerTimes = PLAYER_SECTOR_TIMES.slice(0, options.sectorCount);

  const car = (target: ComposedTarget | undefined): SectorCarInput | null => {
    if (target === undefined) return null;

    // Rounded to the millisecond: a time such as 29.4 is not the sum its operands suggest.
    const times = playerTimes.map((t, k) => Math.round((t - target.deltas[k]) * 1000) / 1000);

    return {
      carIdx: target.carIdx,
      carNumber: target.carNumber,
      gapSeconds: target.gapSeconds,
      // Every car is on the player's lap, so its five recorded laps are its last five completed.
      lapsCompleted: options.lap,
      recentLaps: composedLaps(options.lap, times),
    };
  };

  return {
    sectorCount: options.sectorCount,
    player: {
      carIdx: options.player.carIdx,
      carNumber: options.player.carNumber,
      gapSeconds: null,
      lapsCompleted: options.lap,
      recentLaps: composedLaps(options.lap, playerTimes),
    },
    leader: car(options.leader),
    ahead: car(options.ahead),
    behind: car(options.behind),
  };
}
