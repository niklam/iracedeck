/**
 * The standing of a car against the player (issue #950): the one rule set the
 * opponent-pit (#622) and opponent-flag (#936, #1274) classifiers share, and
 * the class-space projection fastest-lap (#1571) reads too.
 *
 * It owns the class screen, the class-space-or-overall projection, the
 * player's standing and the same-lap test. Each caller keeps its own relation
 * policy on top — opponent-pit's leader exemption and ±2 window, opponent-
 * flags' 1–3 ahead / 1 behind window and race-gap range — because those
 * genuinely differ. A change to the class screen, the projection or the
 * same-lap span is made here, so the callers cannot drift apart again (the
 * two copies this replaces had already disagreed on the class rule).
 *
 * Pure: it reads the canonical order it is handed (`race-positions.md`; the
 * frozen order, or the grid before the green, threaded in by the translator)
 * and never computes positions itself, and it imports no `TranslatorState`.
 *
 * The decision record is
 * `docs/superpowers/specs/2026-11-08-issue-950-shared-standings-classifier.md`.
 */
import { classPositionFromOrder, type TelemetryData } from "@iracedeck/iracing-sdk";

/**
 * Lap-progress scores at least this far apart are on different laps.
 *
 * The test is on the lap-progress score (`CarIdxLapCompleted +
 * CarIdxLapDistPct`), not on raw `CarIdxLap` equality: around the S/F line a
 * car just across it and one just short of it read different lap numbers
 * while being metres apart, and the score form is what the position machinery
 * ranks by. A pair straddling the line (`4 + 0.98` against `5 + 0.01`) is
 * therefore the same lap, and one a full lap apart is not.
 */
export const SAME_LAP_SPAN = 1.0;

/**
 * A car's position in the canonical order: its class position
 * (`classPositionFromOrder`, #588's class space) in a multi-class race, its
 * overall rank otherwise.
 *
 * @param positions - The canonical order, 1-based ranks indexed by carIdx (`0` unranked)
 * @param carClasses - `CarIdxClass`; read only in a multi-class race
 * @returns The position, or `0` when it cannot be resolved
 */
export function standingPosition(
  positions: number[],
  carClasses: number[] | undefined,
  carIdx: number,
  isMultiClass: boolean,
): number {
  return isMultiClass ? classPositionFromOrder(positions, carClasses, carIdx) : (positions[carIdx] ?? 0);
}

/**
 * A car's lap-progress score, `CarIdxLapCompleted + CarIdxLapDistPct`.
 *
 * @returns The score, or `null` when either reading is missing or negative —
 * never a `0` stand-in, which could misread a lapped car as on the same lap
 */
export function lapProgress(telemetry: TelemetryData, carIdx: number): number | null {
  const lc = telemetry.CarIdxLapCompleted?.[carIdx];
  const dp = telemetry.CarIdxLapDistPct?.[carIdx];

  if (typeof lc !== "number" || typeof dp !== "number" || lc < 0 || dp < 0) return null;

  return lc + dp;
}

/**
 * The player's side of every check, the same for every car on a tick — so a
 * caller resolves it once per pass (the class position is an O(field) walk).
 */
export type PlayerStanding = {
  /** The player's position from {@link standingPosition}; `0` when unresolved. */
  pos: number;
  /** The player's {@link lapProgress}; `null` when unreadable. */
  progress: number | null;
};

/**
 * Resolve the player's {@link PlayerStanding} from this tick's telemetry and
 * canonical order.
 */
export function resolvePlayerStanding(
  telemetry: TelemetryData,
  positions: number[],
  playerCarIdx: number,
  isMultiClass: boolean,
): PlayerStanding {
  return {
    pos: standingPosition(positions, telemetry.CarIdxClass as number[] | undefined, playerCarIdx, isMultiClass),
    progress: lapProgress(telemetry, playerCarIdx),
  };
}

/**
 * Why standings cannot place a car against the player. Spelled as
 * opponent-flags' #1273 held-back reasons, which log them as they are.
 */
export type StandingMiss =
  | "class-unreadable"
  | "different-class"
  | "position-unresolved"
  | "player-progress-unreadable"
  | "car-progress-unreadable"
  | "different-lap";

/**
 * A car's standing against the player. Placed (`reason: null`) with
 * `placesAhead = playerPos − carPos`, positive for a car ahead; or a miss with
 * the first check that failed. A miss carries both positions from the position
 * step on, and `0` for both on a class miss, before they are resolved.
 */
export type Standing =
  | { reason: null; carPos: number; playerPos: number; placesAhead: number }
  | { reason: StandingMiss; carPos: number; playerPos: number };

/**
 * Place a car against the player. The checks run in this order, and the
 * first that fails names the miss:
 *
 * 1. **Class.** In a multi-class session an unreadable class — the car's or
 *    the player's — is `class-unreadable`, since the class decides the class
 *    positions too. In ANY session two readable classes that differ are
 *    `different-class`: `isMultiClass` reads false while session info is
 *    missing, and a single-class session's classes are all equal anyway, so a
 *    single-class session without `CarIdxClass` still places (#1274's rule).
 *    Readable means a number.
 * 2. **Positions.** A car or player position `≤ 0` is `position-unresolved`.
 * 3. **Player progress.** An unreadable player lap progress is
 *    `player-progress-unreadable` — nothing is known about the lap then.
 * 4. **Car progress.** An unreadable car lap progress is
 *    `car-progress-unreadable`. Both callers screen the car's in-world state
 *    first, so they never reach it; a pure function does not assume that.
 * 5. **Same lap.** Lap-progress scores {@link SAME_LAP_SPAN} or more apart
 *    are `different-lap`.
 *
 * @param player - The player's standing this tick, from {@link resolvePlayerStanding}
 */
export function resolveStanding(
  telemetry: TelemetryData,
  positions: number[],
  player: PlayerStanding,
  playerCarIdx: number,
  carIdx: number,
  isMultiClass: boolean,
): Standing {
  const carClasses = telemetry.CarIdxClass as Array<number | undefined> | undefined;
  const playerClass = carClasses?.[playerCarIdx];
  const carClass = carClasses?.[carIdx];
  const classesReadable = typeof playerClass === "number" && typeof carClass === "number";

  if (isMultiClass && !classesReadable) return { reason: "class-unreadable", carPos: 0, playerPos: 0 };

  if (classesReadable && playerClass !== carClass) return { reason: "different-class", carPos: 0, playerPos: 0 };

  const carPos = standingPosition(positions, carClasses as number[] | undefined, carIdx, isMultiClass);
  const playerPos = player.pos;

  if (carPos <= 0 || playerPos <= 0) return { reason: "position-unresolved", carPos, playerPos };

  if (player.progress === null) return { reason: "player-progress-unreadable", carPos, playerPos };

  const carProgress = lapProgress(telemetry, carIdx);

  if (carProgress === null) return { reason: "car-progress-unreadable", carPos, playerPos };

  if (Math.abs(carProgress - player.progress) >= SAME_LAP_SPAN) return { reason: "different-lap", carPos, playerPos };

  return { reason: null, carPos, playerPos, placesAhead: playerPos - carPos };
}
