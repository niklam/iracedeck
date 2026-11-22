/**
 * Source selection for the CANONICAL race order (issues #974, #1682).
 *
 * `.claude/rules/race-positions.md` names one race order for the whole project.
 * That order is normally the self-managed lap-progress ranking
 * (`calculateFrozenRacePositions`), but that ranking cannot exist before the
 * green flag: it scores cars as `CarIdxLapCompleted + CarIdxLapDistPct`, and
 * iRacing reports `CarIdxLapCompleted = -1` for every car until it crosses
 * start/finish (#307). iRacing's own `CarIdxPosition` counters are all-zero
 * through the same window, because it scores positions at the line too. So
 * before the green there was no order at all — every position display read
 * blank and the Camera Controls dial's Cycle by Race Position did nothing.
 *
 * This module adds the one source that DOES exist there — the qualifying grid
 * from session YAML — and decides when it applies. It composes the primitives
 * rather than computing anything itself, so there is still exactly one
 * ranking (`rankRaceScores`) and one grid parser in the project.
 *
 * **The third source: a replay frame's progress (issue #1682).** A replay
 * frame never reaches the live freeze, so ranked raw a car whose lap counter
 * and lap fraction disagree for a tick at the start/finish line ranks a lap
 * ahead or behind for that tick. The translator's replay step
 * (`diff/replay-progress.ts`) reads every car through the one line-progress
 * reading instead, and the translator hands those readings in as a value for
 * the very telemetry they were taken from; this module only chooses them.
 *
 * **Why not rank by lap distance pre-green.** A parade lap is double-file, so
 * within every row the outside car sits marginally further round the lap.
 * Ordering the formation by `CarIdxLapDistPct` swaps every single grid pair —
 * measured on a real capture, all ten rows of a 20-car field. The grid order
 * has to come from `QualifyResultsInfo`, never from telemetry geometry.
 */
import {
  calculateGridPositions,
  extractQualifyResults,
  isPreGreen,
  rankRaceScores,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";

import { calculateFrozenRacePositions } from "./diff/race-finish.js";
import type { TranslatorState } from "./state.js";

/**
 * Whether this tick is in the phase the qualifying grid is the order for: a
 * race session, before its green. The ONE statement of that phase —
 * {@link calculateCanonicalRacePositions} serves the grid on it, and the pace
 * lineup reader (`diff/pace-lineup.ts`, issue #1167) numbers a rolling-start
 * formation as a grid on it — so the canonical order and the lineup leave the
 * grid on the same tick, and can never disagree on a pre-green tick of a
 * practice or qualifying session. The two gates it folds together are
 * explained on {@link calculateCanonicalRacePositions}.
 */
export function isQualifyingGridPhase(telemetry: TelemetryData, isRaceSession: boolean): boolean {
  return isRaceSession && isPreGreen(telemetry);
}

/**
 * The canonical per-car race order for this tick: 1-based rank indexed by
 * `carIdx`, `0` for cars the order omits.
 *
 * The qualifying grid holds the order for the whole pre-green phase of a race —
 * grid, warmup and parade laps (`isPreGreen`, the same predicate that suppresses
 * position callouts there, #647). Two gates keep it to exactly that window:
 *
 * - **`isPreGreen`, not "the live order is empty".** By the end of a rolling
 *   parade lap the leaders have already crossed start/finish for the pace lap
 *   and DO carry a lap-progress score (captured: two of 21 cars, ranked in the
 *   reverse of their grid slots). An emptiness test would hand over to a
 *   two-car order mid-formation and blank the other nineteen; the phase gate
 *   holds the full grid until the green.
 * - **Race sessions only.** `SessionState` sits at `Racing` for the whole of a
 *   practice or qualifying session, so the pre-green states appear there only
 *   on transient session-boundary ticks — where `QualifyResultsInfo` holds the
 *   PREVIOUS session's grid, or a qualifying order that is still being set.
 *
 * Past the grid, a replay frame the translator's replay step read
 * (`replayProgress`, its readings for exactly this telemetry, issue #1682) is
 * ranked by those readings through `rankRaceScores`: each car's lap progress,
 * corrected for the one tick its counter and fraction disagree at the line.
 * Any other tick — every live tick, and a replay tick the step did not
 * complete — gets `null` and the lap-progress order with its tow/finish
 * freeze (`calculateFrozenRacePositions`), which on a replay frame has no
 * anchors and ranks raw.
 *
 * At the green the order rolls to live lap progress. Every car listed on the
 * grid keeps its slot even when it is not in the world yet (a driver still in
 * the garage starts from their qualifying position all the same); a consumer
 * that needs presence filters it itself via `carInWorld`. The race-position
 * camera walk deliberately does not: it walks every ranked car (#1281).
 * Class position is derived from this order by `classPositionFromOrder` exactly
 * as it is during the race, so the grid's own `ClassPosition` field is never
 * read and class can't be sourced independently.
 */
export function calculateCanonicalRacePositions(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  isRaceSession: boolean,
  /**
   * The replay step's per-car progress for THIS telemetry (`null` = none: a
   * live tick, or a replay tick the step did not complete). The caller pairs
   * it with its telemetry; this function trusts the pairing.
   */
  replayProgress: readonly (number | null)[] | null = null,
): number[] {
  if (isQualifyingGridPhase(telemetry, isRaceSession)) {
    const results = extractQualifyResults(sessionInfo);
    const gridOrder = results ? calculateGridPositions(results) : null;

    if (gridOrder) return gridOrder;
  }

  if (replayProgress !== null) return rankRaceScores(replayProgress);

  return calculateFrozenRacePositions(state, telemetry);
}
