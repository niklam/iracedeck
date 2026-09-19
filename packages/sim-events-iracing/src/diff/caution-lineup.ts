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
 * - **double file** — ONE combined order: every lined-up car is keyed
 *   `(R, 0)` on line 0 and `(R + 1, 1)` on line 1, the keys are sorted, and a
 *   car's position is its place in that order.
 *
 * The combined order reproduces `line 0, row R → 2R − 1` and
 * `line 1, row R → 2R + 2` exactly while the two lanes pair off evenly — which
 * is what the closed formulas were first written as, checked against every
 * tick of the 2026-09-17 fixture: on all 193 ticks where the pace car holds
 * line 0 row 0 they yield a contiguous 1..N with no gap and no car claiming a
 * position twice (141 single-file, 52 double-file). What the formulas assumed,
 * and the fixture never contradicted, is that the lanes ARE even. The
 * 2026-09-19 snapshot (`__fixtures__/caution-lineup-20260919.json`) is the one
 * where they are not: a lapped car and the waved-around player had gone to the
 * tail of ONE lane, so line 0 held 11 cars (rows 1..11) and line 1 held 9
 * (rows 0..8), and `2R − 1` handed the player, at line 0 row 11, position 21
 * in a 20-car field. The combined order counts what is actually there and gives
 * 20. Reading rows without their lines is not a near-miss but an arbitrary pick
 * — two cars share row 1 for 98 of the fixture's 284 ticks.
 *
 * **What the restart position is NOT is the spoken race position.** The
 * lineup is the restart ORDER — who you follow, which lane, whether you lead —
 * and a lapped car lined up ahead of you is behind you in the race. The
 * position call therefore speaks the canonical live position
 * (`getLivePosition`, `@.claude/rules/race-positions.md`); the same snapshot
 * has the player 20th in the lineup and 19th in the race, and 19 is what his
 * display showed.
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
 * **The car to follow is the nearest IN-WORLD car in your line with a lower
 * row; if there is none, or it is the pace car, it is the pace car you are
 * following.** That rule is right for both shapes — the outside front car
 * sits at line 1 row 0, has no row below it, and follows the pace car, which
 * is what happens on track. Note what that does NOT make it: leading.
 * Following the pace car and running first are two different questions
 * double file, and they get two fields — `followsPaceCar` and `isLeader` —
 * because each becomes a script condition a pack author can only write or
 * negate.
 *
 * "In world" is the repo's one shared predicate for it, `carInWorld` from
 * `@iracedeck/iracing-sdk` — a valid `CarIdxLapDistPct` and a track surface
 * other than `NotInWorld` — and it is here because a car that has left the
 * world can HOLD ITS PACE ROW FOR A TICK. The 2026-09-18 road capture shows
 * it at 548.33 s: car 8 reads `NotInWorld` and still holds line 0 row 6, and
 * only at 548.37 s does it drop to −1/−1 and the rows close up. A "one row
 * lower" rule names that car as the one to follow for that tick, and the same
 * ghost row would count towards `restartPosition`. Narrow in that capture
 * (car 8 was BEHIND the player), real when the departing car is directly
 * ahead, and cheap to close: the search walks down the rows past any car that
 * is not in the world, and the restart count skips them too. With no
 * `CarIdxLapDistPct` at all the predicate counts every car as present, which
 * is what the fixtures cut without it rely on.
 */
import type { CautionLine } from "@iracedeck/event-bus";
import { carInWorld, getCarNumberFromSessionInfo, type TelemetryData } from "@iracedeck/iracing-sdk";

import { resolvePaceCarIdx } from "./pace-laps.js";

export type CautionLineup = {
  /** The car to follow — the car in your line one row lower, or the pace car. */
  followCarIdx: number | null;
  /** Its car number exactly as the sim spells it ("09" stays "09"). `null` when unknown. */
  followCarNumber: string | null;
  /** Which lane you line up in. `null` when single file or the track is not an oval. */
  line: CautionLine | null;
  /**
   * You are restarting FIRST — `restartPosition === 1`, and nothing looser.
   *
   * It is not "nobody is ahead of you in your line", which running double file
   * is true of BOTH front cars: the leader at line 0 row 1 and the outside
   * front car at line 1 row 0, who is P2. That reading shipped briefly and
   * would have told P2 it was leading at every double-file restart, because
   * this value becomes a SCRIPT CONDITION and the script grammar's only
   * operator is `!` — a pack author can write `isLeader` or `!isLeader` and has
   * no way to narrow it further, so the narrowing has to be here. Use
   * {@link CautionLineup.followsPaceCar} for the looser question.
   *
   * False when the position cannot be read at all: claiming the lead is not
   * something to do on a guess.
   */
  isLeader: boolean;
  /**
   * There is nobody ahead of you in your own line, so the only car in front of
   * you is the pace car. True for the leader AND for the outside front car on a
   * double-file restart — it is what a line naming the pace car instead of a
   * car number should be conditioned on, which is why it survives beside
   * {@link CautionLineup.isLeader} rather than being folded into it.
   */
  followsPaceCar: boolean;
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

/**
 * How many lined-up cars a pace line must hold before it counts as a column
 * of the field rather than a stray value. See {@link isDoubleFile}.
 */
export const MIN_LINE_POPULATION = 2;

/**
 * Whether the field is in two columns: at least two pace lines each hold
 * {@link MIN_LINE_POPULATION} lined-up cars.
 *
 * The bare "more than one distinct line value" reading is not robust, and
 * the cost of getting it wrong is the whole field's arithmetic: `doubleFile`
 * switches every restart position from `row` to the interleave, so ONE car
 * carrying a stray or mid-transition line value would tell a driver sitting
 * seventh in a single-file queue that they restart thirteenth, and would move
 * `isLeader` off the real leader. A column is a population, not a value. The
 * committed fixture supports the bar: iRacing re-forms the field in a single
 * tick (415.10 and 793.92), and on all 52 anchored double-file ticks line 1
 * holds at least ten cars — a lone car on a second line never occurs while
 * the pace car leads. Where it does occur is the post-green unwind, which is
 * exactly a place no lineup should be read from.
 *
 * What the bar costs is a two-car field, whose genuine double-file re-form
 * puts one car on line 1 and therefore reads single file here: the leader's
 * position is still right (line 0 row 1 → 1), and P2's is withheld rather
 * than wrong — `null` is the documented "cannot read", never a guess.
 */
function isDoubleFile(lines: unknown[], rows: unknown[]): boolean {
  const population = new Map<number, number>();

  for (let carIdx = 0; carIdx < rows.length; carIdx++) {
    const line = lines[carIdx];

    if (isLinedUp(line, rows[carIdx])) population.set(line, (population.get(line) ?? 0) + 1);
  }

  let columns = 0;

  for (const count of population.values()) {
    if (count >= MIN_LINE_POPULATION) columns++;
  }

  return columns > 1;
}

/**
 * The player's own car index from session YAML, or `null` when it cannot be
 * read. Exported (via the package index) because the scenario harness refuses
 * to start a caution shortcut against a session THIS reader would reject — a
 * restated rule there would drift the moment this one tightened, and admit
 * the half-silent run the precondition exists to prevent.
 */
export function resolvePlayerCarIdx(sessionInfo: Record<string, unknown> | null): number | null {
  const driverInfo = sessionInfo?.DriverInfo as Record<string, unknown> | undefined;
  const idx = driverInfo?.DriverCarIdx;

  return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
}

/**
 * The follow car's number as the sim spells it, through the SDK's own reader
 * rather than a private one. That reader is what knows the shapes session YAML
 * actually emits: a quoted `"09"`, an UNQUOTED `42` that arrives as a number
 * (issue #869), or a blank that arrives as `null`. A hand-rolled string-only
 * read would hand back nothing for the unquoted shape, and every caution line
 * in such a session would quietly drop to its numberless wording.
 */
function resolveFollowCarNumber(sessionInfo: Record<string, unknown> | null, carIdx: number | null): string | null {
  return carIdx === null ? null : getCarNumberFromSessionInfo(sessionInfo, carIdx);
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
  const doubleFile = isDoubleFile(lines, rows);
  const inWorld = carInWorld(telemetry);

  // Only a car that is ITSELF in the lineup can be the one ahead. The filter is
  // load-bearing rather than tidy: a car sitting the re-form out carries −1, and
  // the front row's `myRow - 1` is −1 too, so a slot that ever reported a line
  // without a row would be handed back as the car in front of the leader.
  //
  // And only a car that is in the WORLD: the nearest lower row in the line
  // whose holder is still there, not the row directly below — a car that has
  // left the world keeps its row for a tick (module comment). The player's own
  // slot is skipped by the strict `<`.
  let aheadCarIdx: number | null = null;
  let aheadRow = -1;

  for (let carIdx = 0; carIdx < rows.length; carIdx++) {
    const row = rows[carIdx];

    if (!isLinedUp(lines[carIdx], row) || lines[carIdx] !== myLine) continue;

    if (row < myRow && row > aheadRow && inWorld(carIdx)) {
      aheadCarIdx = carIdx;
      aheadRow = row;
    }
  }

  const followsPaceCar = aheadCarIdx === null || aheadCarIdx === paceCarIdx;
  const followCarIdx = aheadCarIdx ?? paceCarIdx;
  const restartPosition = resolveRestartPosition(lines, rows, paceCarIdx, myLine, myRow, doubleFile, inWorld);

  return {
    followCarIdx,
    followCarNumber: resolveFollowCarNumber(sessionInfo, followCarIdx),
    line: resolveLine(myLine, doubleFile, isOval),
    isLeader: restartPosition === 1,
    followsPaceCar,
    doubleFile,
    restartPosition,
  };
}

/** Line 0 is the inside, line 1 the outside — named only on an oval running double file. */
function resolveLine(myLine: number, doubleFile: boolean, isOval: boolean): CautionLine | null {
  if (!isOval || !doubleFile) return null;

  if (myLine === 0) return "inside";

  if (myLine === 1) return "outside";

  return null;
}

/**
 * The sort key of a lined-up car in the combined double-file order, or `null`
 * for a line the capture has never shown. Line 1's rows sit one behind line
 * 0's because the pace car consumes line 0's row 0; the line breaks the tie so
 * the inside car of a row sorts first. See the module comment.
 */
function combinedOrderKey(line: number, row: number): number | null {
  if (line === 0) return 2 * row;

  if (line === 1) return 2 * (row + 1) + 1;

  return null;
}

/**
 * The restart position, anchored on the pace car holding line 0 row 0. Single
 * file it is the row; double file it is the player's place in the combined
 * order of every lined-up car — counted, not computed from the row, so two
 * lanes of uneven length still yield 1..N. See the module comment.
 */
function resolveRestartPosition(
  lines: unknown[],
  rows: unknown[],
  paceCarIdx: number | null,
  myLine: number,
  myRow: number,
  doubleFile: boolean,
  inWorld: (carIdx: number) => boolean,
): number | null {
  if (paceCarIdx === null || lines[paceCarIdx] !== 0 || rows[paceCarIdx] !== 0) return null;

  const myKey = doubleFile ? combinedOrderKey(myLine, myRow) : myRow;

  // A line the capture has never shown, or the pace car's own slot (line 0
  // row 0 — the anchor, so only the pace car ever holds it): not a position.
  // Single file that slot is row 0 itself.
  if (myKey === null || myKey === 0) return null;

  // Counted rather than read off the row, single file as well as double: a
  // car that has left the world keeps its row for a tick (module comment),
  // and counting who is actually there is what keeps it from inflating the
  // position by one on that tick. Single file the count of in-world cars
  // ahead is the row when every row is held, which is every measured tick.
  let ahead = 0;

  for (let carIdx = 0; carIdx < rows.length; carIdx++) {
    if (carIdx === paceCarIdx || !inWorld(carIdx)) continue;

    const line = lines[carIdx];
    const row = rows[carIdx];

    // `isLinedUp` narrows the line; it checked the row is a number too.
    if (!isLinedUp(line, row)) continue;

    if (!doubleFile) {
      if (line === myLine && (row as number) < myRow) ahead++;

      continue;
    }

    const key = combinedOrderKey(line, row as number);

    if (key !== null && key < myKey) ahead++;
  }

  return ahead + 1;
}
