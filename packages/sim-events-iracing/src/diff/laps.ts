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

/**
 * Player standings snapshot pulled from
 * `SessionInfo.Sessions[current].ResultsPositions[player]` (issue #566).
 * Resolved by the translator; the diff treats it as the authoritative source
 * for position fields on the `lap.completed` payload.
 *
 * `classPosition` is the **raw 0-indexed value** from iRacing — the diff
 * converts to 1-indexed when populating the payload so consumers see the
 * same convention as `PlayerCarClassPosition` telemetry.
 */
export type PlayerResultsForLap = {
  lapsComplete: number;
  position: number;
  classPosition: number;
};

/**
 * Max time (ms) the diff waits for `ResultsPositions.LapsComplete` to catch
 * up to `telemetry.LapCompleted` after a lap-time refresh before falling
 * back to the live telemetry position (issue #566). iRacing's session info
 * (where `ResultsPositions` lives) refreshes on a slower cadence than the
 * per-tick telemetry — typically every 1–3 seconds, so a sub-second timeout
 * misses the refresh window. 3000 ms covers the usual session-info refresh
 * comfortably; if it still hasn't landed by then, the diff sources position
 * from `PlayerCarPosition` / `PlayerCarClassPosition` so the lap is never
 * silently emitted without standings data.
 */
export const LAP_RESULTS_SYNC_MAX_WAIT_MS = 3000;

export function diffLaps(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionType: LapSessionType | undefined,
  isMultiClass: boolean | null,
  playerResults: PlayerResultsForLap | null,
  now: number,
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
  // SessionNum transition. Position baselines (issue #566) are wiped on the
  // same trigger so a P3 finish in practice doesn't ride into the qualifying
  // session as the "previous" position for the first lap there. The pending
  // sync timer also resets so a stale pending-emit from the old session
  // doesn't immediately fire in the new one.
  if (sessionNum !== null && state.lastLapSessionNum !== null && sessionNum !== state.lastLapSessionNum) {
    state.lapCompletedInitialized = false;
    state.lastLapCompletedCounter = -1;
    state.lastLapBestLapTime = 0;
    state.lastEmittedLapTime = 0;
    state.lastLapPosition = 0;
    state.lastLapClassPosition = 0;
    state.lapResultsPendingSince = 0;
  }

  state.lastLapSessionNum = sessionNum;

  // First-tick seed. Captures the current `LapLastLapTime` so a mid-session
  // connect doesn't immediately re-emit whatever lap iRacing already has on
  // file — only future changes count. Captures the current best so an
  // existing PB is treated as "previous", not as a fresh first-valid lap.
  // Also runs immediately after a session-change reset above, so the new
  // session seeds from its own clean state.
  //
  // Position baselines (issue #566) intentionally stay at 0 ("no baseline
  // yet") on first-tick seeding so the driver's first valid lap of the
  // session triggers the "no previous position" branch in the position-change
  // scenario — same shape as how `lastLapBestLapTime` stays 0 to drive
  // `isFirstValid: true`. Mid-session reconnects also seed to 0; the user
  // gets a fresh position fix on their next lap completion regardless of
  // what position they were in when they reconnected.
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
    state.lapResultsPendingSince = 0;

    return;
  }

  // Lap-time refresh detected. Before emitting, wait for `ResultsPositions`
  // to catch up to the lap counter (issue #566). The standings table updates
  // a tick or two after `LapCompleted` increments; emitting before it has
  // caught up would carry a stale (or zero) position from the leaderboard,
  // and `PlayerCarPosition` telemetry has the same lag in qualifying — there
  // is no faster authoritative source. So we defer the entire `lap.completed`
  // event (lap-time included) until standings are coherent, capped by
  // `LAP_RESULTS_SYNC_MAX_WAIT_MS` so a stuck / missing `ResultsPositions`
  // can't permanently swallow a lap.
  //
  // `lapResultsPendingSince` is set on the first tick of the wait and
  // cleared on emit (or on session change / time-refresh re-entry above).
  // Each subsequent tick re-evaluates `playerResults.lapsComplete` against
  // `lapCompleted` and either fires (synced) or returns (still waiting).
  const resultsSynced = playerResults !== null && playerResults.lapsComplete >= lapCompleted;

  if (!resultsSynced) {
    if (state.lapResultsPendingSince === 0) {
      state.lapResultsPendingSince = now;

      return;
    }

    if (now - state.lapResultsPendingSince < LAP_RESULTS_SYNC_MAX_WAIT_MS) {
      return;
    }

    // Timeout exceeded — emit without position fields. Lap-time-best still
    // fires; position-change `where:` will reject the missing position and
    // stay silent for this lap.
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
    position?: number;
    previousPosition?: number;
    classPosition?: number;
    previousClassPosition?: number;
    isMultiClass?: boolean;
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

  // Position fields (issue #566). Primary source is `ResultsPositions` — the
  // authoritative leaderboard — when it has caught up to the lap counter.
  // Fallback when standings haven't synced within the timeout: read the
  // live `PlayerCarPosition` / `PlayerCarClassPosition` telemetry. iRacing
  // session info refreshes on a slower cadence than telemetry (every 1–3 s);
  // the timeout sometimes wins the race. Telemetry is one tick behind the
  // standings on PB laps (qualifying recomputes order before the field
  // settles), but accurate on every other lap — far better than silently
  // omitting position. The class-position from `ResultsPositions` is
  // 0-indexed; convert to 1-indexed (`+ 1`) to match the
  // `PlayerCarClassPosition` telemetry convention so downstream consumers
  // don't need to know the source.
  //
  // `previousPosition` / `previousClassPosition` come from baselines we
  // captured at the previous emission, regardless of how this emission's
  // position was resolved — `0` baseline = first-valid-lap, field omitted.
  let positionForEmit = 0;
  let classPositionForEmit = 0;

  if (resultsSynced && playerResults && playerResults.position > 0) {
    positionForEmit = playerResults.position;

    if (playerResults.classPosition >= 0) classPositionForEmit = playerResults.classPosition + 1;
  } else {
    const telPos =
      typeof telemetry.PlayerCarPosition === "number" && telemetry.PlayerCarPosition > 0
        ? telemetry.PlayerCarPosition
        : 0;
    const telClass =
      typeof telemetry.PlayerCarClassPosition === "number" && telemetry.PlayerCarClassPosition > 0
        ? telemetry.PlayerCarClassPosition
        : 0;
    positionForEmit = telPos;
    classPositionForEmit = telClass;
  }

  if (positionForEmit > 0) data.position = positionForEmit;

  if (state.lastLapPosition > 0) data.previousPosition = state.lastLapPosition;

  if (classPositionForEmit > 0) data.classPosition = classPositionForEmit;

  if (state.lastLapClassPosition > 0) data.previousClassPosition = state.lastLapClassPosition;

  if (isMultiClass !== null) data.isMultiClass = isMultiClass;

  emit({ event: "lap.completed", data });

  state.lastLapCompletedCounter = lapCompleted;
  state.lastLapBestLapTime = newBest > 0 ? newBest : previousBest;
  state.lastEmittedLapTime = lapLastLapTime;

  // Only advance the position baselines when we have a real reading. With
  // the telemetry fallback this should almost always succeed; the rare zero
  // case (e.g. session info AND telemetry both stale before any standings
  // are computed) carries the baseline over so the next lap doesn't read a
  // "P3 → ? → P3" gap as two changes.
  if (positionForEmit > 0) state.lastLapPosition = positionForEmit;

  if (classPositionForEmit > 0) state.lastLapClassPosition = classPositionForEmit;

  state.lapResultsPendingSince = 0;
}
