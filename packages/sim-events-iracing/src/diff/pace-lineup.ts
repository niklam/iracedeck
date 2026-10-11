/**
 * Who to follow behind the pace car, which lane you line up in, and your place
 * in the lineup — under a full-course caution (issue #1127) and in a
 * rolling-start formation (issue #1167). A pure reader over
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
 * whole lap. The formation before a rolling start is the same exception for
 * the same reason: the pace rows are what iRacing forms the grid up by. There
 * the two have agreed on every formation measured — three, on two grids, each
 * equal to `QualifyResultsInfo` car for car — and where iRacing publishes no
 * pace rows this reader answers nothing rather than falling back to the grid,
 * which cannot say single or double file.
 *
 * **Pace rows are numbered PER LINE, and the two lines interleave.** This is
 * the rule everything else here rests on, and it is not what "your pace row"
 * suggests. Measured under a caution, from the committed fixture at t=415.1:
 *
 * ```text
 * car 20 (the PACE CAR)  line 0  row 0
 * car 17 (P1)            line 0  row 1
 * car 16 (P2)            line 1  row 0
 * car 11 (P4)            line 1  row 1
 * ```
 *
 * The pace car consumes line 0's row 0, so line 1's rows sit one behind line
 * 0's. Hence, while the pace car is there:
 *
 * - **single file** — position = row (the pace car is row 0, the leader row 1);
 * - **double file** — ONE combined order: every lined-up car is keyed
 *   `(R, 0)` on line 0 and `(R + 1, 1)` on line 1, the keys are sorted, and a
 *   car's position is its place in that order.
 *
 * **Line 1 is offset by one exactly when the pace car occupies line 0's row
 * 0**, because that car is the whole reason for the offset. In a rolling-start
 * formation it does not: the pace car leads from the road without a row, and
 * the pole sits where the pace car would. Measured on every pre-green tick of
 * the 2026-09-17 formation (`__fixtures__/rolling-start-formation-20260917.json`),
 * the same field the caution above later re-formed:
 *
 * ```text
 * car 20 (the PACE CAR)  line −1  row −1
 * car 17 (P1, the pole)  line 0   row 0
 * car 16 (P2)            line 1   row 0
 * car 18 (P3)            line 0   row 1
 * ```
 *
 * So there line 1 is keyed `(R, 1)` and the order is simply `(row, line)`. It
 * equals the qualifying grid, and the official `CarIdxPosition` iRacing first
 * published two seconds after that green, for all 20 cars. The caution's
 * keying applied to the same rows misplaces 18 of the 20 — the player's P11
 * reads P10, the outside pole's P2 reads P3 — which is what reading the rows
 * in the wrong frame of reference costs. The order is COUNTED the same way in
 * both frames, so single file needs no case of its own: counting gives the
 * caution's `row` and the formation's `row + 1` from one rule.
 *
 * With the offset, the combined order reproduces `line 0, row R → 2R − 1` and
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
 * **The rows need an anchor, and the tick's own data names it — never the
 * caller.** A row is a place in a queue, and only two shapes say where that
 * queue starts ({@link PaceLineupAnchor}):
 *
 * - `pace-car` — session info names the pace car and it holds line 0 row 0.
 *   Line 1 is offset by one and the leader is line 0 row 1: every caution.
 * - `grid` — the session is before its green (`isPreGreen`), session info
 *   names the pace car, the pace car holds no row, and a car holds line 0
 *   row 0. No offset, and that car is the pole.
 *
 * The two exclude each other by the pace car's slot, and a lineup matching
 * neither has no absolute position: {@link resolvePaceLineup} then withholds
 * `lineupPosition` (only that field — who is ahead of you in your own line is
 * still true). That is what a green leaves behind in either phase. Once the
 * pace car pulls off at a restart the whole of line 0 shifts down a row while
 * line 1 does not, and the lineup then renumbers from 0 among whoever is left
 * as cars accelerate away — so a row is a place in a shrinking queue rather
 * than a position. The 60 ticks of the caution fixture that fail the anchor
 * are all under green with no caution bit set, so nothing is withheld during a
 * caution.
 *
 * The `grid` anchor needs the PHASE as well as the shape, because that unwind
 * has the formation's shape exactly. At 203.87 s in the formation fixture,
 * 2.7 s after the green, the pace car reads −1/−1, car 18 — the grid's THIRD
 * car — holds line 0 row 0 and car 16 holds line 1 row 0: read by shape alone,
 * the third car would be told it leads. `isPreGreen` is the predicate
 * `race-order.ts` serves the qualifying grid on, so the canonical order and
 * the lineup leave the grid on the same tick. The position is withheld from
 * the green tick itself (201.18 s), though the rows stay intact for another
 * 2.7 s: the phase decides, not a guess at when the unwind begins.
 *
 * The anchor is read rather than passed because a caller choosing the offset
 * is how the off-by-one gets written — at a phase boundary, in a harness, in a
 * test. A second resolver for the formation and a mode parameter were both
 * rejected for it: the pace car's slot is on the same tick as the rows, so the
 * reader cannot disagree with the data it counts. Reading also keeps the
 * shapes nobody has captured safe. A rolling start whose pace car DID take
 * line 0 row 0 gets the caution's arithmetic, which is right for that shape by
 * construction, and any other shape withholds.
 *
 * **A single stray line value is protected against twice, because it can sit
 * on either side of the question.** On another car's slot it must not flip
 * the field's arithmetic — a column is a population, not a value
 * ({@link isDoubleFile}). On the PLAYER'S slot it must not answer "you
 * restart first, behind the pace car": every "in my line" question is then
 * asked of a line holding nobody else ({@link isOffTheField}), so the
 * answers that rest on the player's line are withheld for that tick.
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
 * ghost row would count towards `lineupPosition`. Narrow in that capture
 * (car 8 was BEHIND the player), real when the departing car is directly
 * ahead, and cheap to close: the search walks down the rows past any car that
 * is not in the world, and the restart count skips them too. With no
 * `CarIdxLapDistPct` at all the predicate counts every car as present, which
 * is what the fixtures cut without it rely on.
 */
import type { CautionLine } from "@iracedeck/event-bus";
import { carInWorld, getCarNumberFromSessionInfo, isPreGreen, type TelemetryData } from "@iracedeck/iracing-sdk";

import { resolvePaceCarIdx } from "./pace-laps.js";

/**
 * Which frame of reference a tick's pace rows are numbered in — where the
 * queue starts. `pace-car`: the pace car holds line 0 row 0 and line 1's rows
 * sit one behind line 0's (a caution). `grid`: before the green, with the
 * pace car holding no row and the pole at line 0 row 0 (a rolling-start
 * formation, issue #1167). Read from the tick by {@link resolvePaceLineup},
 * never chosen by a caller — see the module comment's anchor paragraph.
 */
export type PaceLineupAnchor = "pace-car" | "grid";

export type PaceLineup = {
  /** The car to follow — the car in your line one row lower, or the pace car. */
  followCarIdx: number | null;
  /** Its car number exactly as the sim spells it ("09" stays "09"). `null` when unknown. */
  followCarNumber: string | null;
  /** Which lane you line up in. `null` when single file or the track is not an oval. */
  line: CautionLine | null;
  /**
   * You are restarting FIRST — `lineupPosition === 1`, and nothing looser. In
   * a formation that is the pole.
   *
   * It is not "nobody is ahead of you in your line", which running double file
   * is true of BOTH front cars: the leader (line 0 row 1 behind the pace car,
   * line 0 row 0 on the grid) and the outside front car at line 1 row 0, who
   * is P2. That reading shipped briefly and
   * would have told P2 it was leading at every double-file restart, because
   * this value becomes a SCRIPT CONDITION and the script grammar's only
   * operator is `!` — a pack author can write `isLeader` or `!isLeader` and has
   * no way to narrow it further, so the narrowing has to be here. Use
   * {@link PaceLineup.followsPaceCar} for the looser question.
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
   * {@link PaceLineup.isLeader} rather than being folded into it.
   */
  followsPaceCar: boolean;
  /** The field is in two columns. */
  doubleFile: boolean;
  /**
   * Your place in the lineup: the position you would restart in under a
   * caution, your grid slot in a formation. `null` when the rows carry no
   * absolute position — {@link PaceLineup.anchor} is `null` — or your own slot
   * has none in that frame (the pace car's, or a line no capture has shown).
   */
  lineupPosition: number | null;
  /**
   * The frame of reference `lineupPosition` was counted in (issue #1167).
   * `null` when the tick matches neither — the post-green unwind, a session
   * that does not name its pace car — and on a tick where every answer is
   * withheld; `lineupPosition` is then `null` too, while the car ahead and
   * the lane are answered wherever they can be.
   */
  anchor: PaceLineupAnchor | null;
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
 * How many lined-up cars each pace line holds, keyed by line. One pass over
 * the slots that both {@link isDoubleFile} and {@link isOffTheField} read.
 */
function linePopulation(lines: unknown[], rows: unknown[]): Map<number, number> {
  const population = new Map<number, number>();

  for (let carIdx = 0; carIdx < rows.length; carIdx++) {
    const line = lines[carIdx];

    if (isLinedUp(line, rows[carIdx])) population.set(line, (population.get(line) ?? 0) + 1);
  }

  return population;
}

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
 * than wrong — `null` is the documented "cannot read", never a guess. Since
 * the stray-player rule ({@link isOffTheField}) P2's follow answer is withheld
 * too: with one car on line 1 and two on line 0, P2 IS the shape of a stray
 * reading, and the data cannot tell the two apart.
 */
function isDoubleFile(population: Map<number, number>): boolean {
  let columns = 0;

  for (const count of population.values()) {
    if (count >= MIN_LINE_POPULATION) columns++;
  }

  return columns > 1;
}

/**
 * Single file, and the PLAYER is the stray: some other pace line holds more
 * lined-up cars than the player's own.
 *
 * {@link isDoubleFile} protects the FIELD from one stray or mid-transition
 * line value, and it does — but not the driver whose own slot carries it.
 * With the field on line 0 and the player alone on line 1, every "in my
 * line" question below is asked of a line holding nobody else: no car ahead,
 * so the follow call would say it is just him and the pace car; nobody with
 * a lower row, so `lineupPosition` would be 1 and `isLeader` TRUE — the
 * lineup telling a mid-pack driver he restarts first, on a reading the field
 * itself says is wrong. Single file, the field's line is the line the field
 * is on, and a player off it is the stray value, not the field. What his row
 * MEANS on that line cannot be known either (a row in the old numbering, or
 * the first row of a re-form the rest of the field has not joined yet), so
 * counting him onto the field's line would be a guess wearing a number.
 * {@link resolvePaceLineup} therefore withholds every answer that rests
 * on the player's line — the car to follow, the position, the lead — and
 * `caution.lineup.changed` treats the tick as no news (`diff/caution.ts`
 * ignores a follow car it cannot name), so the next real reading is judged
 * against the last real one.
 *
 * Strictly MORE, never at-least-as-many: with every line holding one car
 * nothing marks the player's as the stray one, so a pace car alone on line 0
 * and a lone driver on line 1 still reads as before.
 */
function isOffTheField(population: Map<number, number>, myLine: number): boolean {
  const mine = population.get(myLine) ?? 0;

  for (const count of population.values()) {
    if (count > mine) return true;
  }

  return false;
}

/** Every answer withheld: the shape of "this cannot be read", never a guess. */
const WITHHELD: PaceLineup = {
  followCarIdx: null,
  followCarNumber: null,
  line: null,
  isLeader: false,
  followsPaceCar: false,
  doubleFile: false,
  lineupPosition: null,
  anchor: null,
};

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
 * Which frame of reference this tick's rows are numbered in, read off the pace
 * car's own slot and the session phase — the table in the module comment's
 * anchor paragraph, in code. `null` when the tick matches neither frame.
 *
 * "The pace car holds no row" is a row that READS below zero. A slot the
 * arrays do not carry at all is unknown rather than empty, and an unknown pace
 * car anchors nothing.
 */
function resolveAnchor(
  telemetry: TelemetryData,
  lines: unknown[],
  rows: unknown[],
  paceCarIdx: number | null,
): PaceLineupAnchor | null {
  // Both frames are judged against the pace car's slot, so a session that
  // does not say which car that is has neither.
  if (paceCarIdx === null) return null;

  const paceRow = rows[paceCarIdx];

  if (lines[paceCarIdx] === 0 && paceRow === 0) return "pace-car";

  // The phase, not only the shape: the post-green unwind has the formation's
  // shape exactly, with the grid's third car at line 0 row 0 (module comment).
  if (!isPreGreen(telemetry)) return null;

  if (typeof paceRow !== "number" || paceRow >= 0) return null;

  for (let carIdx = 0; carIdx < rows.length; carIdx++) {
    if (lines[carIdx] === 0 && rows[carIdx] === 0) return "grid";
  }

  return null;
}

/**
 * The player's place in the pace lineup for THIS tick — a caution's or a
 * rolling-start formation's, told apart by the tick's own data — or `null`
 * when there is none to read: no pace arrays, no player index, or a player the
 * field has lined up without (a car in the pits during the re-form holds no
 * row). Returning `null` is what makes a `lineupPosition: null` in a payload
 * mean "the field is not lined up" rather than "we forgot".
 */
export function resolvePaceLineup(
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  isOval: boolean,
): PaceLineup | null {
  const lines = telemetry.CarIdxPaceLine;
  const rows = telemetry.CarIdxPaceRow;

  if (!Array.isArray(lines) || !Array.isArray(rows)) return null;

  const playerCarIdx = resolvePlayerCarIdx(sessionInfo);

  if (playerCarIdx === null) return null;

  const myLine = lines[playerCarIdx];
  const myRow = rows[playerCarIdx];

  if (!isLinedUp(myLine, myRow)) return null;

  const paceCarIdx = resolvePaceCarIdx(sessionInfo);
  const population = linePopulation(lines, rows);
  const doubleFile = isDoubleFile(population);

  // The player's own slot carrying the stray line value (see `isOffTheField`):
  // every question below is asked of the player's line, and his is not the
  // field's. Withhold rather than answer "first".
  if (!doubleFile && isOffTheField(population, myLine)) return { ...WITHHELD };

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
  // Read here, from the same tick as the rows it frames, and handed to nothing
  // but the count: the walk above and the lane below do not depend on it.
  const anchor = resolveAnchor(telemetry, lines, rows, paceCarIdx);
  const lineupPosition = resolveLineupPosition(lines, rows, paceCarIdx, anchor, myLine, myRow, doubleFile, inWorld);

  return {
    followCarIdx,
    followCarNumber: resolveFollowCarNumber(sessionInfo, followCarIdx),
    line: resolveLine(myLine, doubleFile, isOval),
    isLeader: lineupPosition === 1,
    followsPaceCar,
    doubleFile,
    lineupPosition,
    anchor,
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
 * 0's exactly when the pace car consumes line 0's row 0 — the `pace-car`
 * anchor — and level with them on the grid; the line breaks the tie so the
 * inside car of a row sorts first. See the module comment.
 */
function combinedOrderKey(line: number, row: number, anchor: PaceLineupAnchor): number | null {
  if (line === 0) return 2 * row;

  if (line === 1) return 2 * (anchor === "pace-car" ? row + 1 : row) + 1;

  return null;
}

/**
 * The player's place in the lineup, in the frame the anchor names. Single file
 * it is the count of cars ahead in the line; double file it is the player's
 * place in the combined order of every lined-up car — counted, not computed
 * from the row, so two lanes of uneven length still yield 1..N. The anchor
 * changes one thing only, whether line 1's rows are shifted by one. See the
 * module comment.
 */
function resolveLineupPosition(
  lines: unknown[],
  rows: unknown[],
  paceCarIdx: number | null,
  anchor: PaceLineupAnchor | null,
  myLine: number,
  myRow: number,
  doubleFile: boolean,
  inWorld: (carIdx: number) => boolean,
): number | null {
  if (anchor === null) return null;

  const myKey = doubleFile ? combinedOrderKey(myLine, myRow, anchor) : myRow;

  // A line the capture has never shown: not a position.
  if (myKey === null) return null;

  // Behind the pace car, line 0 row 0 is the pace car's own slot — the anchor,
  // so only the pace car ever holds it — and not a position either. Single
  // file that slot is row 0 itself. On the grid the same slot is the pole.
  if (anchor === "pace-car" && myKey === 0) return null;

  // Counted rather than read off the row, single file as well as double: a
  // car that has left the world keeps its row for a tick (module comment),
  // and counting who is actually there is what keeps it from inflating the
  // position by one on that tick. Single file the count of in-world cars
  // ahead is the row when every row is held, which is every measured tick.
  // That is the same count in both frames: the pace car is skipped below, so
  // behind it the leader at row 1 has nobody ahead, and on the grid the pole
  // at row 0 has nobody ahead — the caution's `row`, the formation's `row + 1`.
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

    const key = combinedOrderKey(line, row as number, anchor);

    if (key !== null && key < myKey) ahead++;
  }

  return ahead + 1;
}
