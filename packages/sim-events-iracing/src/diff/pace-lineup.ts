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
 * in the wrong frame of reference costs. The order is COUNTED in both frames,
 * and a field that is all on one line needs no arithmetic of its own: counting
 * the cars ahead gives the caution's `row` and the formation's `row + 1`.
 *
 * What the grid does need a rule of its own for is a field too THIN to say
 * whether it is in one column or two. A column is a population
 * ({@link isDoubleFile}), so a two-car grid — the pole at line 0 row 0, the
 * other car at line 1 row 0 — reads single file, and counting each car along
 * its own line would put BOTH first. Behind the pace car that cannot happen:
 * the pace car sits on line 0 and out-populates the lone car on line 1, which
 * the stray-player rule then withholds. On the grid the pace car holds no row,
 * so the count refuses instead: single file by population, with any lined-up
 * car on a line other than the player's, is no position at all. The pole is
 * the one exception, because it is first in either reading — see the anchor.
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
 * - `pace-car` — session info names the pace car, it holds line 0 row 0, and
 *   no other lined-up car does. Line 1 is offset by one and the leader is
 *   line 0 row 1: every caution.
 * - `grid` — a race session in a KNOWN state before its green, session info
 *   names the pace car, the pace car holds no row, and exactly one car holds
 *   line 0 row 0. No offset.
 *
 * Line 0 row 0 is the slot each frame is hung on, so it must have one holder.
 * A pace car and a racing car both reading line 0 row 0 contradict each
 * other — one of the two readings is wrong and nothing says which — and so do
 * two cars there on a grid; neither is a frame, and none of the 273 anchored
 * ticks of the three caution fixtures, nor any measured formation tick, shows
 * it. With one holder, "that car is the pole" is checked rather than assumed:
 * on the grid every car that holds a row is counted (below), so no car can
 * sort ahead of line 0 row 0, in the single-file reading or the double-file
 * one.
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
 * the third car would be told it leads. The phase is asked through
 * `isQualifyingGridPhase`, the one predicate `race-order.ts` serves the
 * qualifying grid on — a race session, before its green — so the lineup is
 * never a grid on a tick the canonical order is not, a pre-green tick of a
 * practice or qualifying session included, and both leave the grid on the
 * green tick. The lineup is the narrower of the two in one place:
 * `SessionState.Invalid` counts as pre-green there, where falling back to the
 * grid for a state iRacing has not reported yet is harmless, and does not
 * here, where it would be a claim about a phase nobody knows. The position is
 * withheld from the green tick itself (201.18 s), though the rows stay intact
 * for another 2.7 s: the phase decides, not a guess at when the unwind begins.
 *
 * The anchor is read rather than passed because a caller choosing the offset
 * is how the off-by-one gets written — at a phase boundary, in a harness, in a
 * test. A second resolver for the formation and a mode parameter were both
 * rejected for it: the pace car's slot is on the same tick as the rows, so the
 * reader cannot disagree with the data it counts. Reading also keeps the
 * shapes nobody has captured from being guessed at. A rolling start whose
 * pace car DID take line 0 row 0, alone in that slot, has the caution's shape
 * and is read as one — unmeasured, so that is consistency rather than a
 * verified answer — and any shape that fits neither frame withholds.
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
 *
 * **On the grid the walk keeps that filter and the count drops it.** A row
 * holder that is not in the world means two different things. Under a caution
 * it is the one-tick ghost above, a car that has LEFT. In a formation it is a
 * car that has not ARRIVED and keeps its slot until it does: the 2026-09-17
 * capture's own player held line 0 row 5 with a `NotInWorld` surface for
 * 5.67 s (107.38 → 113.05 s), and `race-order.ts` keeps such a car on its
 * qualifying slot — the order the grid frame claims to equal. Skipping it
 * would move every car behind it up a place, and behind an absent pole the
 * outside front car would read first and be told it is on pole. So on the
 * grid every car that holds a row is counted, in the world or not. You still
 * form up behind who is physically there, so the car to follow is found the
 * same way in both frames.
 */
import type { CautionLine } from "@iracedeck/event-bus";
import { carInWorld, getCarNumberFromSessionInfo, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";

import { isQualifyingGridPhase } from "../race-order.js";
import { resolveSessionType } from "../session-type.js";
import { resolvePaceCarIdx } from "./pace-laps.js";

/**
 * Which frame of reference a tick's pace rows are numbered in — where the
 * queue starts. `pace-car`: the pace car holds line 0 row 0 and line 1's rows
 * sit one behind line 0's (a caution). `grid`: a race before its green, with
 * the pace car holding no row and the pole alone at line 0 row 0 (a
 * rolling-start formation, issue #1167). Read from the tick by {@link resolvePaceLineup},
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
   * caution, and in a formation your place among the cars that hold a row —
   * the qualifying slot whenever every car on the grid holds one, which is
   * every formation measured. `null` when the rows carry no absolute
   * position: the tick matches neither frame, your own slot has none in the
   * frame it does match (the pace car's, or a line no capture has shown), or
   * the grid is too thin to say whether it is in one column or two.
   */
  lineupPosition: number | null;
  /**
   * The frame of reference `lineupPosition` was counted in (issue #1167), and
   * `null` whenever that position is withheld — the two are null together. So
   * it is not "the shape this tick has": a tick behind the pace car still
   * reads `null` here for a player whose own slot has no position, and for
   * one whose every answer is withheld.
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
 * puts one car on line 1 and therefore reads single file here. Behind the
 * pace car the leader's position is still right (line 0 row 1 → 1), and P2's
 * is withheld rather than wrong — `null` is the documented "cannot read",
 * never a guess. Since the stray-player rule ({@link isOffTheField}) P2's
 * follow answer is withheld too: with one car on line 1 and two on line 0 —
 * the pace car and the leader — P2 IS the shape of a stray reading, and the
 * data cannot tell the two apart.
 *
 * On the grid the pace car holds no row, so the same two cars are one to a
 * line and neither is the stray. There the bar's cost is paid by the count
 * instead ({@link resolveLineupPosition}): a single-file reading with a car
 * on another line gives no position, so the outside car is withheld rather
 * than counted first on a line of its own, and only the pole keeps its number.
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
 * nothing marks the player's as the stray one. Behind the pace car that is a
 * pace car alone on line 0 and a lone driver on line 1, who still reads as
 * before — following the pace car, with no position, since single file his
 * row 0 is the pace car's own. On the grid it is a two-car field, one to a
 * line: this rule passes both, and the count withholds the position of the
 * one that is not the pole ({@link resolveLineupPosition}).
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
 *
 * Line 0 row 0 must have exactly one holder in either frame — the pace car
 * behind it, the pole on the grid — or the slot the frame hangs on says two
 * things at once.
 */
function resolveAnchor(
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  lines: unknown[],
  rows: unknown[],
  paceCarIdx: number | null,
): PaceLineupAnchor | null {
  // Both frames are judged against the pace car's slot, so a session that
  // does not say which car that is has neither.
  if (paceCarIdx === null) return null;

  const paceRow = rows[paceCarIdx];
  const paceCarAtHead = lines[paceCarIdx] === 0 && paceRow === 0;

  if (!paceCarAtHead) {
    // The phase, not only the shape: the post-green unwind has the formation's
    // shape exactly, with the grid's third car at line 0 row 0 (module
    // comment). Asked through the predicate the canonical order serves the
    // qualifying grid on, with the session type read the way the translator
    // reads it, so the lineup is never a grid where that order is not.
    if (!isQualifyingGridPhase(telemetry, resolveSessionType(sessionInfo, telemetry) === "Race")) return null;

    // ...and a KNOWN phase. `Invalid` is pre-green to that predicate, a
    // harmless fallback for the order and a claim about nothing here.
    if (telemetry.SessionState === SessionState.Invalid) return null;

    if (typeof paceRow !== "number" || paceRow >= 0) return null;
  }

  // The racing cars at line 0 row 0: none behind the pace car, exactly one on
  // the grid. Past the returns above, so on a racing tick this loop never runs.
  let atHead = 0;

  for (let carIdx = 0; carIdx < rows.length; carIdx++) {
    if (carIdx !== paceCarIdx && lines[carIdx] === 0 && rows[carIdx] === 0) atHead++;
  }

  if (paceCarAtHead) return atHead === 0 ? "pace-car" : null;

  return atHead === 1 ? "grid" : null;
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
  // whose holder is there, not the row directly below — a car that has left
  // the world keeps its row for a tick, and one that has not reached the grid
  // yet holds its row until it does (module comment). In both frames: you form
  // up behind who is physically there. The player's own slot is skipped by the
  // strict `<`.
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
  const anchor = resolveAnchor(telemetry, sessionInfo, lines, rows, paceCarIdx);
  const lineupPosition = resolveLineupPosition(lines, rows, paceCarIdx, anchor, myLine, myRow, doubleFile, inWorld);

  return {
    followCarIdx,
    followCarNumber: resolveFollowCarNumber(sessionInfo, followCarIdx),
    line: resolveLine(myLine, doubleFile, isOval),
    isLeader: lineupPosition === 1,
    followsPaceCar,
    doubleFile,
    lineupPosition,
    // The frame the position was counted in, so nothing when none was.
    anchor: lineupPosition === null ? null : anchor,
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
 * from the row, so two lanes of uneven length still yield 1..N.
 *
 * The frames differ in three things, each argued in the module comment:
 * whether line 1's rows are shifted by one; WHO is counted — behind the pace
 * car only cars in the world, since a row holder that is not is the ghost of
 * a car that left, and on the grid every row holder, since there it is a car
 * that has not arrived and keeps its slot; and what a single-file reading
 * does with a car on another line — behind the pace car it is ignored as a
 * stray, and on the grid, where the pace car is not on line 0 to mark one, it
 * means the field is too thin to say one column from two and no position is
 * given.
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

  const onGrid = anchor === "grid";

  // The pole. The grid frame holds only with exactly one car at line 0 row 0,
  // and every row holder is counted on the grid, so nothing sorts ahead of
  // that slot whether the field reads as one column or two.
  if (onGrid && myLine === 0 && myRow === 0) return 1;

  const myKey = doubleFile ? combinedOrderKey(myLine, myRow, anchor) : myRow;

  // A line the capture has never shown: not a position.
  if (myKey === null) return null;

  // Key 0 past this point is not a position. Behind the pace car, line 0 row 0
  // is the pace car's own slot — the anchor, so only the pace car holds it —
  // and single file that slot is row 0 itself, on whichever line the player
  // is. On the grid the pole has answered above, and the only other car that
  // can read key 0 sits at row 0 of a line of its own beside it, which the
  // count below refuses in any case.
  if (myKey === 0) return null;

  // Counted rather than read off the row, single file as well as double.
  // Behind the pace car a car that has left the world keeps its row for a
  // tick, and counting who is actually there is what keeps it from inflating
  // the position by one on that tick; on the grid a car not in the world has
  // not arrived yet and keeps its slot, so it is counted (module comment).
  // Single file the count of cars ahead is the caution's `row` when every row
  // is held, which is every measured tick, and the formation's `row + 1`: the
  // pace car is skipped below, so behind it the leader at row 1 has nobody
  // ahead, and on the grid the pole at row 0 has nobody ahead.
  let ahead = 0;

  for (let carIdx = 0; carIdx < rows.length; carIdx++) {
    if (carIdx === paceCarIdx) continue;

    if (!onGrid && !inWorld(carIdx)) continue;

    const line = lines[carIdx];
    const row = rows[carIdx];

    // `isLinedUp` narrows the line; it checked the row is a number too.
    if (!isLinedUp(line, row)) continue;

    if (!doubleFile) {
      if (line !== myLine) {
        // A car on another line of a field that reads single file. Behind the
        // pace car it is the stray the population bar is there to ignore. On
        // the grid it is as likely the other half of a front row — two cars,
        // one to a line — and counting along the player's own line would put
        // both of them first: no position.
        if (onGrid) return null;

        continue;
      }

      if ((row as number) < myRow) ahead++;

      continue;
    }

    const key = combinedOrderKey(line, row as number, anchor);

    if (key !== null && key < myKey) ahead++;
  }

  return ahead + 1;
}
