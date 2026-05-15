/**
 * Lap completion diff (issue #555).
 *
 * Emits `lap.completed { lap, lapTime, isBest, isFirstValid, ... }` once per
 * timed lap, triggered by `LapLastLapTime` changing — that's the field that
 * holds the just-completed lap time and is the ground-truth signal for "a
 * lap was completed". Using `LapCompleted` (the counter) as the trigger
 * instead is unreliable because iRacing increments the counter a tick or
 * two BEFORE refreshing `LapLastLapTime`, leading to a stale-time emission
 * that mis-classifies improved laps as not best (same lap-time as the prior
 * lap → isBest false). Driving off the time-change signal collapses the
 * two-step "wait for the field to settle" into one atomic test.
 *
 * Carries the rich payload defined on the bus so future lap-related
 * callouts (delta-to-PB, consistency, pace, remaining-time) can subscribe
 * without further bus changes.
 *
 * Detection:
 *   - First tick → seed baselines (counter, last-emitted-time,
 *     last-best-time) and bail. Without seeding, connecting mid-session
 *     would emit a bogus completion for the lap-time field's pre-existing
 *     value.
 *   - Subsequent tick → if `LapLastLapTime > 0` AND `!== lastEmittedLapTime`,
 *     emit one event with the captured data and advance the baselines.
 *
 * `isBest` is true when the just-completed `LapLastLapTime` is strictly
 * faster than the prior best baseline (or there was no prior best —
 * driver's first valid lap of the session). `isFirstValid` is true when
 * the prior `LapBestLapTime` baseline was zero. Both flags can be true
 * simultaneously on the first valid lap; the scenario's intro selector
 * resolves the precedence.
 *
 * Sentinel suppression:
 *   - `LapCompleted < 0` (pace/warmup laps): bail without touching state
 *     so any spurious time write during the pace doesn't surface.
 *   - `LapLastLapTime <= 0`: not a completion — wait.
 *   - `LapLastLapTime === lastEmittedLapTime`: same as the last lap we
 *     announced — either a stale read (iRacing hasn't refreshed for the
 *     new lap yet) or, theoretically, two identical lap times back-to-back.
 *     Wait for the field to change. The theoretical-identical-time edge
 *     case would stall the diff but is so improbable for real driving
 *     that the simplicity is worth it.
 *
 * Snapshot:
 *   - `bestLapTime` / `previousBestLapTime`: derived from `lapLastLapTime`
 *     vs the frozen baseline rather than iRacing's `LapBestLapTime` field,
 *     which can lag the lap-time refresh. Internally consistent regardless
 *     of update ordering.
 *   - `lapsRemaining` / `timeRemaining`: pass-through from session telemetry.
 *     Both omitted when the underlying field is missing.
 *   - `sessionType`: resolved by the orchestrator (translator.ts) since it
 *     reads session info; the diff just consumes the classified value.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/**
 * Result of `classifySessionType` mapped onto the subset of values the
 * bus payload exposes. Practice / qualifying / race covers the announceable
 * cases; anything else (test, replay, "Warmup" between sessions, …) reaches
 * here as `undefined` and is omitted from the payload.
 */
export type LapSessionType = "practice" | "qualifying" | "race";

export function diffLaps(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionType: LapSessionType | undefined,
  emit: EmitFn,
): void {
  const lapCompleted = typeof telemetry.LapCompleted === "number" ? telemetry.LapCompleted : -1;
  const lapLastLapTime = typeof telemetry.LapLastLapTime === "number" ? telemetry.LapLastLapTime : 0;
  const lapBestLapTime = typeof telemetry.LapBestLapTime === "number" ? telemetry.LapBestLapTime : 0;
  const sessionNum = typeof telemetry.SessionNum === "number" ? telemetry.SessionNum : null;

  // Session change → wipe the lap-completed tracking so the new session
  // re-seeds from scratch. Without this, a fast practice PB would carry into
  // qualifying and the first qualifying lap (typically slower than the
  // practice ultra-lap) would be classified `isBest: false` instead of
  // `isFirstValid: true` — the engineer would stay silent on the first
  // qualifying lap. Same applies to qualifying → race and any other
  // SessionNum transition.
  if (sessionNum !== null && state.lastLapSessionNum !== null && sessionNum !== state.lastLapSessionNum) {
    state.lapCompletedInitialized = false;
    state.lastLapCompletedCounter = -1;
    state.lastLapBestLapTime = 0;
    state.lastEmittedLapTime = 0;
  }

  state.lastLapSessionNum = sessionNum;

  // First-tick seed. Captures the current `LapLastLapTime` so a mid-session
  // connect doesn't immediately re-emit whatever lap iRacing already has on
  // file — only future changes count. Captures the current best so an
  // existing PB is treated as "previous", not as a fresh first-valid lap.
  // Also runs immediately after a session-change reset above, so the new
  // session seeds from its own clean state.
  if (!state.lapCompletedInitialized) {
    state.lapCompletedInitialized = true;
    state.lastLapCompletedCounter = lapCompleted;
    state.lastLapBestLapTime = lapBestLapTime > 0 ? lapBestLapTime : 0;
    state.lastEmittedLapTime = lapLastLapTime > 0 ? lapLastLapTime : 0;

    return;
  }

  // Pace / warmup laps (LapCompleted < 0) — bail without touching state.
  // iRacing shouldn't write a real lap time during pace, but if it does we
  // don't want to surface it. Counter baseline carries the pace value
  // forward; once iRacing transitions into the racing state and a real lap
  // completes, the time-change signal triggers a clean emission.
  if (lapCompleted < 0) {
    state.lastLapCompletedCounter = lapCompleted;

    return;
  }

  // Wait until iRacing publishes a new lap time. Two flavors of "not yet":
  //
  //   1. `LapLastLapTime <= 0` — the sentinel iRacing uses before any lap
  //      has been completed. Pre-first-lap or post-session-reset state.
  //   2. `LapLastLapTime === lastEmittedLapTime` — same time as the last
  //      lap we emitted. Either iRacing hasn't refreshed the field for the
  //      new lap yet (the common case — refresh lags `LapCompleted++` by
  //      a tick or two), or the driver clocked two byte-identical laps
  //      back-to-back. Wait for the field to change. The identical-time
  //      edge case is so improbable in real driving that the simplicity
  //      is worth it; swap for a "wait at most N ticks" timeout if it
  //      ever becomes a real concern.
  if (lapLastLapTime <= 0 || lapLastLapTime === state.lastEmittedLapTime) {
    return;
  }

  // Real lap completion. Use `lapLastLapTime` (the time of the lap just
  // finished — known at this tick) as the authoritative signal for "did we
  // improve?", rather than `lapBestLapTime` which iRacing may not have
  // updated to reflect the new lap yet. Comparing against the frozen
  // baseline gives the correct answer regardless of whether the sim has
  // committed the best-lap update on this tick or a later one.
  const previousBest = state.lastLapBestLapTime > 0 ? state.lastLapBestLapTime : 0;
  const isFirstValid = previousBest <= 0;
  const isBest = previousBest <= 0 || lapLastLapTime < previousBest;
  // Resolve the announced "current best" so the payload is internally
  // consistent: if this lap was the new best, that's the lap-time we just
  // measured; otherwise the prior best still stands. Avoids surfacing a
  // stale `lapBestLapTime` reading on the rare tick where iRacing's update
  // ordering hasn't settled.
  const newBest = isBest ? lapLastLapTime : previousBest;

  const data: {
    lap: number;
    lapTime: number;
    isBest: boolean;
    isFirstValid: boolean;
    bestLapTime?: number;
    previousBestLapTime?: number;
    lapsRemaining?: number;
    timeRemaining?: number;
    sessionType?: LapSessionType;
  } = {
    lap: lapCompleted,
    lapTime: lapLastLapTime,
    isBest,
    isFirstValid,
  };

  if (newBest > 0) data.bestLapTime = newBest;

  if (previousBest > 0) data.previousBestLapTime = previousBest;

  if (sessionType) data.sessionType = sessionType;

  const lapsRemaining = typeof telemetry.SessionLapsRemainEx === "number" ? telemetry.SessionLapsRemainEx : undefined;

  if (lapsRemaining !== undefined && lapsRemaining >= 0) data.lapsRemaining = lapsRemaining;

  const timeRemaining = typeof telemetry.SessionTimeRemain === "number" ? telemetry.SessionTimeRemain : undefined;

  if (timeRemaining !== undefined && timeRemaining >= 0) data.timeRemaining = timeRemaining;

  emit({ event: "lap.completed", data });

  state.lastLapCompletedCounter = lapCompleted;
  state.lastLapBestLapTime = newBest > 0 ? newBest : previousBest;
  state.lastEmittedLapTime = lapLastLapTime;
}
