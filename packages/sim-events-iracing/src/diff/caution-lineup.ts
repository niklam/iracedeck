/**
 * Who to follow under a full-course caution, which lane you line up in, and
 * where you would restart (issue #1127). A pure reader over
 * `CarIdxPaceLine` / `CarIdxPaceRow` — no state, no emission — so the caller
 * can ask it at SPEAK time rather than freezing an answer into a payload the
 * field has already moved past.
 *
 * **The lineup, not the running order, is the restart order.** This is a
 * deliberate, documented exception to `@.claude/rules/race-positions.md`: the
 * pace row *is* what iRacing lines the field up by, and the 2026-09-17 capture
 * shows the two disagreeing — early in the first caution the player's pace row
 * said 14 while the official position still read 11, converging a lap later. A
 * follow-car call built on the running order would name the wrong car for that
 * whole lap.
 *
 * **Pace rows are numbered PER LINE, and the two lines interleave.** This is
 * the rule everything else here rests on, and it is not what "your pace row"
 * suggests. Measured from the committed fixture at t=415.1:
 *
 * ```text
 * car 20 (the PACE CAR)  line 0  row 0
 * car 17 (P1)            line 0  row 1
 * car 16 (P2)            line 1  row 0
 * car 11 (P4)            line 1  row 1
 * ```
 *
 * The pace car consumes line 0's row 0, so line 1's rows sit one behind line
 * 0's. Hence:
 *
 * - **single file** — position = row (the pace car is row 0, the leader row 1);
 * - **double file** — `line 0, row R` → `2R − 1`; `line 1, row R` → `2R + 2`.
 *
 * Both were checked against every tick of the fixture: on all 193 ticks where
 * the pace car holds line 0 row 0 the formula yields a contiguous 1..N with no
 * gap and no car claiming a position twice (141 single-file, 52 double-file).
 * Reading rows without their lines is not a near-miss but an arbitrary pick —
 * two cars share row 1 for 98 of the fixture's 284 ticks.
 *
 * **The pace car at line 0 row 0 is the anchor, and without it no absolute
 * position can be read.** Once it pulls off at the green the whole of line 0
 * shifts down a row while line 1 does not, and the lineup then renumbers from 0
 * among whoever is left as cars accelerate away — so a row is a place in a
 * shrinking queue rather than a restart position. {@link resolveCautionLineup}
 * therefore withholds `restartPosition` (only that field — who is ahead of you
 * in your own line is still true) unless session info names a pace car AND that
 * car holds line 0 row 0. The 60 fixture ticks that fail the anchor are all
 * under green with no caution bit set, so nothing is withheld during a caution.
 *
 * **The car to follow is the car in your line one row lower; if that slot is
 * empty, or holds the pace car, it is the pace car you are following.** That
 * rule is right for both shapes — the outside front car sits at line 1 row 0,
 * has no row −1, and follows the pace car, which is what happens on track.
 */
import type { CautionLine } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import { resolvePaceCarIdx } from "./pace-laps.js";

export type CautionLineup = {
  /** The car to follow — the car in your line one row lower, or the pace car. */
  followCarIdx: number | null;
  /** Its car number exactly as the sim spells it ("09" stays "09"). `null` when unknown. */
  followCarNumber: string | null;
  /** Which lane you line up in. `null` when single file or the track is not an oval. */
  line: CautionLine | null;
  /**
   * There is nobody ahead of you in your own line, so the only car in front is
   * the pace car.
   *
   * Read it as exactly that, and NOT as "you are P1": running double file BOTH
   * front cars satisfy it — the leader at line 0 row 1 and the outside front
   * car at line 1 row 0, who is P2. A caller that wants the race leader tests
   * `restartPosition === 1`.
   */
  isLeader: boolean;
  /** The field is in two columns. */
  doubleFile: boolean;
  /**
   * The position you would restart in. `null` when the rows carry no absolute
   * position — the pace car does not head the lineup, or session info does not
   * say which car it is (see the module comment's anchor paragraph).
   */
  restartPosition: number | null;
};

/**
 * A car is in the lineup when it holds a real line AND a real row — both read
 * −1 otherwise. Narrows the LINE, which is the value every caller goes on to
 * use; the row is checked here and read separately.
 */
function isLinedUp(line: unknown, row: unknown): line is number {
  return typeof line === "number" && line >= 0 && typeof row === "number" && row >= 0;
}

/** The player's own car index from session YAML, or `null` when it cannot be read. */
function resolvePlayerCarIdx(sessionInfo: Record<string, unknown> | null): number | null {
  const driverInfo = sessionInfo?.DriverInfo as Record<string, unknown> | undefined;
  const idx = driverInfo?.DriverCarIdx;

  return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
}

/**
 * A car's number as the sim spells it. Strings only, deliberately: `"09"` and
 * `"9"` are different cars, and a driver list that handed back the number 9
 * could not tell us which one it meant — so an unusable entry is reported as
 * unknown rather than guessed at, and the sentence drops to its numberless
 * wording.
 */
function resolveCarNumber(sessionInfo: Record<string, unknown> | null, carIdx: number | null): string | null {
  if (carIdx === null) return null;

  const driverInfo = sessionInfo?.DriverInfo as Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers;

  if (!Array.isArray(drivers)) return null;

  for (const driver of drivers as Array<Record<string, unknown> | null>) {
    if (driver?.CarIdx !== carIdx) continue;

    const number = driver.CarNumber;

    return typeof number === "string" && number !== "" ? number : null;
  }

  return null;
}

/**
 * Whether the session runs on an oval, which is the only discipline whose
 * restart lines are named inside and outside (the #1127 spec gates the wording
 * on it; line 0 is taken to be the inside, accepted on the grounds that no
 * right-handed oval is known).
 *
 * Measured once: Homestead-Miami reported `TrackType: "medium oval"` (with
 * `Category: "Oval"` beside it). The other readings come from iRacing's own
 * `TrackType` vocabulary rather than from a capture — `"short oval"` and
 * `"dirt oval"` say oval outright, `"superspeedway"` never does, which is why
 * the substring test carries both words. `Category` is deliberately NOT read as
 * a second signal: every value it would rescue is one `TrackType` already
 * names, so the branch could not be made to fail a test, and a term no test can
 * fail is one the next reader either trusts too far or deletes blind. Getting
 * this wrong costs a side name, not a car: everything else in the lineup is
 * discipline-agnostic.
 */
export function isOvalTrack(sessionInfo: Record<string, unknown> | null): boolean {
  const weekendInfo = sessionInfo?.WeekendInfo as Record<string, unknown> | undefined;
  const trackType = weekendInfo?.TrackType;

  if (typeof trackType !== "string") return false;

  const normalized = trackType.toLowerCase();

  return normalized.includes("oval") || normalized.includes("speedway");
}

/**
 * The player's place in the caution lineup for THIS tick, or `null` when there
 * is none to read — no pace arrays, no player index, or a player the field has
 * lined up without (a car in the pits during the re-form holds no row).
 * Returning `null` is what makes a `restartPosition: null` in a payload mean
 * "the field is not lined up" rather than "we forgot".
 */
export function resolveCautionLineup(
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  isOval: boolean,
): CautionLineup | null {
  const lines = telemetry.CarIdxPaceLine;
  const rows = telemetry.CarIdxPaceRow;

  if (!Array.isArray(lines) || !Array.isArray(rows)) return null;

  const playerCarIdx = resolvePlayerCarIdx(sessionInfo);

  if (playerCarIdx === null) return null;

  const myLine = lines[playerCarIdx];
  const myRow = rows[playerCarIdx];

  if (!isLinedUp(myLine, myRow)) return null;

  const paceCarIdx = resolvePaceCarIdx(sessionInfo);

  const distinctLines = new Set<number>();

  for (let carIdx = 0; carIdx < rows.length; carIdx++) {
    const line = lines[carIdx];

    if (isLinedUp(line, rows[carIdx])) distinctLines.add(line);
  }

  const doubleFile = distinctLines.size > 1;

  // Only a car that is ITSELF in the lineup can be the one ahead. The filter is
  // load-bearing rather than tidy: a car sitting the re-form out carries −1, and
  // the front row's `myRow - 1` is −1 too, so a slot that ever reported a line
  // without a row would be handed back as the car in front of the leader.
  let aheadCarIdx: number | null = null;

  for (let carIdx = 0; carIdx < rows.length; carIdx++) {
    if (!isLinedUp(lines[carIdx], rows[carIdx])) continue;

    if (lines[carIdx] === myLine && rows[carIdx] === myRow - 1) {
      aheadCarIdx = carIdx;
      break;
    }
  }

  const isLeader = aheadCarIdx === null || aheadCarIdx === paceCarIdx;
  const followCarIdx = aheadCarIdx ?? paceCarIdx;

  return {
    followCarIdx,
    followCarNumber: resolveCarNumber(sessionInfo, followCarIdx),
    line: resolveLine(myLine, doubleFile, isOval),
    isLeader,
    doubleFile,
    restartPosition: resolveRestartPosition(lines, rows, paceCarIdx, myLine, myRow, doubleFile),
  };
}

/** Line 0 is the inside, line 1 the outside — named only on an oval running double file. */
function resolveLine(myLine: number, doubleFile: boolean, isOval: boolean): CautionLine | null {
  if (!isOval || !doubleFile) return null;

  if (myLine === 0) return "inside";

  if (myLine === 1) return "outside";

  return null;
}

/** The interleave, anchored on the pace car holding line 0 row 0. See the module comment. */
function resolveRestartPosition(
  lines: unknown[],
  rows: unknown[],
  paceCarIdx: number | null,
  myLine: number,
  myRow: number,
  doubleFile: boolean,
): number | null {
  if (paceCarIdx === null || lines[paceCarIdx] !== 0 || rows[paceCarIdx] !== 0) return null;

  let position: number | null = null;

  if (!doubleFile) position = myRow;
  else if (myLine === 0) position = 2 * myRow - 1;
  else if (myLine === 1) position = 2 * myRow + 2;

  // Below 1 is the pace car's own slot, or a line the capture has never shown:
  // either way it is not a restart position.
  return position !== null && position >= 1 ? position : null;
}
