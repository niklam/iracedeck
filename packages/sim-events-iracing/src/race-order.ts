/**
 * Source selection for the CANONICAL race order (issue #974).
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
 * from session YAML — and decides when it applies. It composes the two
 * primitives rather than computing anything itself, so there is still exactly
 * one lap-progress ranking and one grid parser in the project.
 *
 * **Why not rank by lap distance pre-green.** A parade lap is double-file, so
 * within every row the outside car sits marginally further round the lap.
 * Ordering the formation by `CarIdxLapDistPct` swaps every single grid pair —
 * measured on a real capture, all ten rows of a 20-car field. The grid order
 * has to come from `QualifyResultsInfo`, never from telemetry geometry.
 */
import { calculateGridPositions, extractQualifyResults, isPreGreen, type TelemetryData } from "@iracedeck/iracing-sdk";

import { calculateFrozenRacePositions } from "./diff/race-finish.js";
import type { TranslatorState } from "./state.js";

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
 * At the green the order rolls to live lap progress. Every car listed on the
 * grid keeps its slot even when it is not in the world yet (a driver still in
 * the garage starts from their qualifying position all the same); consumers
 * that need presence — the camera walks — filter it themselves via `carInWorld`.
 * Class position is derived from this order by `classPositionFromOrder` exactly
 * as it is during the race, so the grid's own `ClassPosition` field is never
 * read and class can't be sourced independently.
 */
export function calculateCanonicalRacePositions(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  isRaceSession: boolean,
): number[] {
  if (isRaceSession && isPreGreen(telemetry)) {
    const results = extractQualifyResults(sessionInfo);
    const gridOrder = results ? calculateGridPositions(results) : null;

    if (gridOrder) return gridOrder;
  }

  return calculateFrozenRacePositions(state, telemetry);
}
