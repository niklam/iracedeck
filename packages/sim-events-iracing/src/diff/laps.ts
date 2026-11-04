/**
 * Lap completion diff (issues #555, #1582).
 *
 * Emits `lap.completed` once per start/finish crossing, in one of two shapes
 * (the catalog's `LapCompletedData` union). A lap iRacing counted carries its
 * time (`lapTime`), and is triggered by `LapLastLapTime` changing — that's
 * the field that holds the just-completed lap time and is the ground-truth
 * signal for "a lap was completed". Using `LapCompleted` (the counter) as
 * the trigger instead is unreliable because iRacing increments the counter a
 * tick or two BEFORE refreshing `LapLastLapTime`, leading to a stale-time
 * emission. A lap iRacing refused (issue #1582) carries `lapIsValid: false`
 * and no `lapTime`: iRacing writes `-1` to `LapLastLapTime` for it, 0.4 to
 * 0.9 s after the counter moves in the 2026-11-02 captures, and leaves its
 * best where it was. The `-1` is iRacing's mapping and stays here: the
 * payload omits the time rather than carry it.
 *
 * Carries the rich payload defined on the bus so future lap-related
 * callouts (delta-to-PB, consistency, pace, remaining-time) can subscribe
 * without further bus changes.
 *
 * Detection:
 *   - First tick → seed baselines (counter, last-emitted-time,
 *     last-best-time) and bail. Without seeding, connecting mid-session
 *     would emit a bogus completion for the lap-time field's pre-existing
 *     value — a `-1` included.
 *   - The crossing: the tick `LapCompleted` moves, recorded in the
 *     `lapCrossing` slice with its time (`now`) and the `LapLastLapTime` that
 *     tick read.
 *   - Counted: `LapLastLapTime > 0` AND `!== lastEmittedLapTime`, for a
 *     counter other than the one last emitted for.
 *   - Refused: a crossing to a count of at least 1, other than the one last
 *     emitted for, then `LapLastLapTime === -1`: at once when it changed to
 *     `-1` after the crossing, or {@link LAP_TIME_REFRESH_ALLOWANCE_MS} after
 *     the crossing when it already read `-1` there (the lap before was
 *     refused too, and a counted lap shows the old `-1` until its own time
 *     lands).
 *   - Either then waits for the standings (`LAP_RESULTS_SYNC_MAX_WAIT_MS`),
 *     emits one event and advances the baselines.
 *   - At most one `lap.completed` per counter value: a time that lands for a
 *     counter already emitted — a late time after a refused emit — is
 *     dropped with a debug line and taken as the stale value.
 *
 * `isBest` is iRacing's own best (issue #1582): on the emit tick its best
 * has moved to this lap — `LapBestLap` is the lap just completed and
 * `LapBestLapTime` is positive. Nothing waits for it: on every crossing of
 * the captures that set a best, the best moved on the same tick as the lap
 * time. `isFirstValid` is `isBest` with no best before it. Both flags can be
 * true on the first best; the scenario's intro selector resolves the
 * precedence. A lap iRacing times but does not take as a best — the race
 * start lap — is neither.
 *
 * Sentinel suppression:
 *   - `LapCompleted < 0` (pace/warmup laps): bail without touching state
 *     so any spurious time write during the pace doesn't surface.
 *   - `LapLastLapTime === 0`: not a completion — wait. A `0` never means
 *     refused: the green and pit-exit crossings (`LapCompleted` 0) read it.
 *   - `LapLastLapTime === lastEmittedLapTime`: same as the last lap we
 *     announced — either a stale read (iRacing hasn't refreshed for the
 *     new lap yet) or, theoretically, two identical lap times back-to-back.
 *     Wait for the field to change. The theoretical-identical-time edge
 *     case would stall the diff but is so improbable for real driving
 *     that the simplicity is worth it.
 *   - A reset to the pits takes the car out of the world for a tick or more
 *     (`PlayerTrackSurface` `NotInWorld`), `LapCompleted` reading 0 meanwhile,
 *     and puts the count back. Those ticks are no crossing and no lap: the
 *     crossing record and the emit skip them, so a lap still waiting for its
 *     standings is reported as its own count once the car is back, never as
 *     `lap: 0`.
 *
 * Snapshot:
 *   - `bestLapTime` / `previousBestLapTime`: iRacing's best after this lap
 *     (`LapBestLapTime`, when positive), and the baseline this diff keeps of
 *     it from the emit before. The baseline follows iRacing's value after
 *     every emit, never a comparison of our own.
 *   - `lapsRemaining` / `timeRemaining`: `SessionLapsRemainEx` /
 *     `SessionTimeRemain` read through `resolveLapsRemaining` /
 *     `resolveTimeRemainingS` (#1220). Each is omitted when its resolver
 *     returns null: the field is missing, reads the unlimited sentinel of the
 *     side the session does not have (32767 laps, 604800 s), or is negative
 *     or non-finite. A `0` is kept.
 *   - `sessionType`: resolved by the orchestrator (translator.ts) since it
 *     reads session info; the diff just consumes the classified value.
 *   - `isOutLap` / `isInLap` (#1163): the pit laps, latched per lap on the
 *     counter by the rule `pit-lap.ts` shares with the fuel tracker, and
 *     taken on the tick the counter moves so the emission's wait cannot
 *     leak the next lap's pit entry into them.
 *   - `isClassFastestLapOfRace` (#1571): answered by the judge the
 *     orchestrator hands in ({@link FastestLapJudge}), once per emitted lap
 *     that is a new best; this module never reads the record.
 */
import type { CountedLapCompleted, LapCompletedCommon, LapCompletedData, SimEventName } from "@iracedeck/event-bus";
import {
  Flags,
  hasFlag,
  resolveLapsRemaining,
  resolveTimeRemainingS,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";

import { createLapCrossingState, type TranslatorState } from "../state.js";
import { closePitLap, observePitLap, openPitLap } from "./pit-lap.js";
import type { EmitFn } from "./types.js";

/**
 * Whether the lap `lap.completed` is about to report set a new fastest lap
 * of the race in the player's class (issue #1571). The translator builds it
 * per tick over `diff/fastest-lap.ts` and hands it to {@link diffLaps}, which
 * calls it once for each emitted lap that is a new best (`isBest`, iRacing's
 * own verdict, issue #1582) and never otherwise, and sets
 * `isClassFastestLapOfRace: true` exactly when it answers `true`. Every
 * fastest lap of the race is a personal best, so whether iRacing counted the
 * lap is decided here, in one place. This module never imports the
 * fastest-lap module and never touches the record: the judge is the whole
 * seam.
 */
export type FastestLapJudge = (lap: number, lapTime: number) => boolean;

/**
 * Result of the translator's `classifyLapSessionType` (a stricter reading of
 * `classifySession`, `session-type.ts`) mapped onto the subset of values the
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

/**
 * How long (ms) after the player's crossing `LapLastLapTime` is allowed to
 * refresh for it (issues #1571, #1582). {@link diffLaps} bounds one wait
 * with it: a crossing whose tick already read `-1` (the lap before was
 * refused) is refused once the field still reads `-1` this long after the
 * crossing, since a counted lap shows the old `-1` until its own time lands.
 * A crossing that reads `0` or a stale positive time is not bounded: it
 * emits nothing until the field changes. The fastest-lap hold
 * (`diff/fastest-lap.ts`) adds it to the standings wait. 2 s: twice the
 * longest refresh in the 2026-11-02 captures (1.00 s, the race's lap 1), and
 * the budget `diff/replay-laps.ts` gives the same refresh for a remote car
 * (`REPLAY_LAP_TIME_WAIT_TICKS`, 120 ticks at 60 Hz).
 */
export const LAP_TIME_REFRESH_ALLOWANCE_MS = 2000;

/** The value iRacing writes to `LapLastLapTime` for a lap it did not count (issue #1582). */
const REFUSED_LAP_TIME = -1;

/** The events {@link diffLaps} emits (issue #1499): its emitter's type, and its row in `TICK_ORDER`. */
export const LAPS_EVENTS = [
  "lap.completed",
  "position.changed",
  "race.finished",
] as const satisfies readonly SimEventName[];

export function diffLaps(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionType: LapSessionType | undefined,
  isMultiClass: boolean | null,
  playerResults: PlayerResultsForLap | null,
  now: number,
  emit: EmitFn<(typeof LAPS_EVENTS)[number]>,
  judgeFastestLap: FastestLapJudge,
  logger: ILogger = silentLogger,
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
    // Position-change cadence + race-end latch (issue #569). New session ⇒
    // re-arm both: a position-change baseline carried in from practice would
    // skew the race-status every-3 cadence on the first race lap; a stale
    // `raceFinishedFired` from the prior race would swallow the new race's
    // emission entirely.
    state.lastPositionChangeLap = -1;
    state.raceFinishedFired = false;
    state.raceFinish = null;
    Object.assign(state.lapCrossing, createLapCrossingState());
    state.lapLatchLap = null;
    state.lapCautionSeen = false;
    state.lapCompletedWasCaution = false;
    state.lapCompletedPit = { isOutLap: false, isInLap: false };
  }

  state.lastLapSessionNum = sessionNum;

  // Per-lap caution latch (issue #1127, second review R16): was a full-course
  // caution out on ANY tick of the lap? Read off the translator's own phase,
  // which is what the whole caution family reads, never off the raw bits.
  // Latched BEFORE the counter is compared, so the crossing tick's own state
  // still counts toward the lap it completes (the `fuel-laps.ts` ordering);
  // when the counter moves, the accumulated value becomes the completed lap's
  // and a fresh latch starts for the lap now in progress. Runs on every tick
  // — the seed and the sentinel returns below included — because the lap in
  // progress does not stop while this diff waits for standings to sync.
  if (state.cautionPhase !== "none") state.lapCautionSeen = true;

  // Per-lap pit latch (issue #1163), the same shape on the same counter: the
  // shared rule of `pit-lap.ts`, observed on every tick BEFORE the counter is
  // compared so the crossing tick's own `OnPitRoad` still counts toward the
  // lap it completes (a crossing on pit road ends an in lap), and opened for
  // the lap now in progress with that same reading (it opens an out lap). The
  // first tick opens rather than observes: nothing is known of the lap a
  // connect lands in before this reading.
  const onPitRoad = telemetry.OnPitRoad === true;

  if (state.lapLatchLap !== null) observePitLap(state.lapPitLatch, onPitRoad);

  if (lapCompleted !== state.lapLatchLap) {
    const opened = state.lapLatchLap !== null;
    state.lapCompletedWasCaution = opened && state.lapCautionSeen;
    state.lapCompletedPit = opened ? closePitLap(state.lapPitLatch) : { isOutLap: false, isInLap: false };
    state.lapCautionSeen = false;
    openPitLap(state.lapPitLatch, onPitRoad);
    state.lapLatchLap = lapCompleted;
  }

  // Crossing record (issues #1278, #1582), taken on the tick the counter
  // moves — every tick, the seed and the waits below included — because the
  // emit that reads it can land seconds later. Three facts of the crossing:
  //
  //   - Was the checkered already flying when the player crossed the line?
  //     By the emit the leader may have taken the flag behind a lapped
  //     player. "Already flying" means on the previous tick too: a flag that
  //     rises on the crossing tick itself predates nothing the player did
  //     (the #771 rule; the leader's own case comes from the flag diff's
  //     winner grace, `flagCheckeredTakenLap`).
  //   - When it happened (`now`), which bounds the wait for a time after a
  //     refused lap (`LAP_TIME_REFRESH_ALLOWANCE_MS`).
  //   - What `LapLastLapTime` read on that tick, against which a `-1` is told
  //     apart as this lap's (a change after the crossing) or the lap before's.
  //
  // The seed records no crossing — a plugin started mid-lap has not seen one
  // — only the reading it starts from.
  //
  // A reset to the pits (issue #1582, second read): while the car is out of
  // the world `LapCompleted` reads 0, which is neither a crossing nor the lap
  // it would report. Skipping those ticks here keeps a counted lap that is
  // still waiting for its standings from being emitted as `lap: 0` (and so
  // not as the best it was) on the reset tick. The seed still runs on one.
  if (state.lapCompletedInitialized && telemetry.PlayerTrackSurface === TrkLoc.NotInWorld) return;

  const checkeredUp = hasFlag(telemetry.SessionFlags ?? 0, Flags.Checkered);
  const crossing = state.lapCrossing;

  if (!state.lapCompletedInitialized || lapCompleted !== crossing.lap) {
    crossing.underCheckered = state.lapCompletedInitialized && checkeredUp && crossing.prevCheckered;
    crossing.lap = lapCompleted;
    crossing.since = now;
    crossing.lapTimeAtCrossing = lapLastLapTime;
  }

  crossing.prevCheckered = checkeredUp;

  // First-tick seed. Captures the current `LapLastLapTime` so a mid-session
  // connect doesn't immediately re-emit whatever lap iRacing already has on
  // file — only future changes count. Captures the current best so an
  // existing PB is treated as "previous", not as a fresh first-valid lap.
  // Also runs immediately after a session-change reset above, so the new
  // session seeds from its own clean state. A `-1` seeds as `0`: the crossing
  // record above, not this baseline, is what tells a refused lap's `-1`
  // apart, so a seed on one emits nothing and the next lap is judged on its
  // own crossing.
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

  // What this tick says of the lap the counter names, if anything:
  //
  //   - counted: a positive time other than the last one emitted. Not yet
  //     while the field reads `0` (the sentinel before any lap, and what the
  //     green and pit-exit crossings at `LapCompleted` 0 read) or the time
  //     last emitted — either iRacing hasn't refreshed the field for the new
  //     lap yet (the common case — refresh lags `LapCompleted++` by a tick or
  //     two), or the driver clocked two byte-identical laps back-to-back.
  //     The identical-time edge case is so improbable in real driving that
  //     the simplicity is worth it.
  //   - refused (issue #1582): `-1` for a crossing to a count of at least 1,
  //     at once when the field changed to it after the crossing, or once it
  //     has read it since the crossing for `LAP_TIME_REFRESH_ALLOWANCE_MS`
  //     (the lap before was refused, and this one may yet get a time).
  //
  // Both need a counter other than the one last emitted for: one
  // `lap.completed` per counter value. A reset to the pits puts the same
  // count back, so it is no crossing.
  const newCount = lapCompleted !== state.lastLapCompletedCounter;
  const hasNewTime = lapLastLapTime > 0 && lapLastLapTime !== state.lastEmittedLapTime;
  const isCounted = newCount && hasNewTime;
  const isRefused =
    newCount &&
    lapCompleted >= 1 &&
    lapLastLapTime === REFUSED_LAP_TIME &&
    (crossing.lapTimeAtCrossing !== REFUSED_LAP_TIME || now - crossing.since >= LAP_TIME_REFRESH_ALLOWANCE_MS);

  if (!isCounted && !isRefused) {
    // A time for the count already emitted — a late time after a refused
    // emit: dropped, and taken as the stale value the next crossing reads.
    if (hasNewTime) {
      logger.debug(`Lap time dropped: lap=${lapCompleted} already emitted or seeded, time=${lapLastLapTime}`);
      state.lastEmittedLapTime = lapLastLapTime;
    }

    state.lapResultsPendingSince = 0;

    return;
  }

  // A lap to report. Before emitting, wait for `ResultsPositions`
  // to catch up to the lap counter (issue #566). The standings table updates
  // a tick or two after `LapCompleted` increments; emitting before it has
  // caught up would carry a stale (or zero) position from the leaderboard,
  // and `PlayerCarPosition` telemetry has the same lag in qualifying — there
  // is no faster authoritative source. So we defer the entire `lap.completed`
  // event (lap-time or refusal included) until standings are coherent, capped by
  // `LAP_RESULTS_SYNC_MAX_WAIT_MS` so a stuck / missing `ResultsPositions`
  // can't permanently swallow a lap.
  //
  // `lapResultsPendingSince` is set on the first tick of the wait and
  // cleared on emit (or on session change / the not-yet return above).
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

  // iRacing's own best (issue #1582): this lap is a best exactly when its
  // best has moved to it on this tick — `LapBestLap` names the lap that set
  // it, and moves on the same tick as the lap time on every crossing of the
  // captures that set one. A refused lap is never one. The baseline is
  // iRacing's best before this lap, as the emit before left it.
  const lapBestLap = typeof telemetry.LapBestLap === "number" ? telemetry.LapBestLap : -1;
  const previousBest = state.lastLapBestLapTime > 0 ? state.lastLapBestLapTime : 0;
  const isBest = isCounted && lapBestLap === lapCompleted && lapBestLapTime > 0;
  const isFirstValid = isBest && previousBest <= 0;

  const data: LapCompletedCommon = { lap: lapCompleted };

  if (lapBestLapTime > 0) data.bestLapTime = lapBestLapTime;

  if (previousBest > 0) data.previousBestLapTime = previousBest;

  if (sessionType) data.sessionType = sessionType;

  // Through the session-limit resolvers (#1220): iRacing reports the side a
  // session does not have with a sentinel (32767 laps, 604800 s), and the
  // catalog promises each field only when that side limits the session.
  const lapsRemaining = resolveLapsRemaining(telemetry);

  if (lapsRemaining !== null) data.lapsRemaining = lapsRemaining;

  const timeRemaining = resolveTimeRemainingS(telemetry);

  if (timeRemaining !== null) data.timeRemaining = timeRemaining;

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

  // Position-change detection (issue #569). Driven by the EFFECTIVE position
  // — class in multi-class series, overall otherwise — to match the rest of
  // the system's effective-position contract (`selectEffectivePosition` in
  // the position-change / race-status / race-end scenarios). In multi-class,
  // a class-only gain/loss is what the driver actually races for: it must
  // reset the cadence and emit `position.changed`; an overall-only churn
  // (e.g. another class shuffles around you with your class position
  // unchanged) is noise and shouldn't. The `position.changed` payload still
  // carries both raw fields so future consumers can pick what they need.
  // Emit only when a real prior baseline existed (skips the driver's first
  // valid lap of the session — the change scenario has no "previous" to
  // compare against and the issue's payload requires `previousPosition`).
  const effectivePositionForEmit = isMultiClass === true ? classPositionForEmit : positionForEmit;
  const effectivePreviousPosition = isMultiClass === true ? state.lastLapClassPosition : state.lastLapPosition;
  const positionChanged =
    effectivePositionForEmit > 0 &&
    effectivePreviousPosition > 0 &&
    effectivePositionForEmit !== effectivePreviousPosition;

  if (positionChanged) {
    state.lastPositionChangeLap = lapCompleted;

    const changeData: {
      lap: number;
      position: number;
      previousPosition: number;
      classPosition?: number;
      previousClassPosition?: number;
      isMultiClass?: boolean;
    } = {
      lap: lapCompleted,
      position: positionForEmit,
      previousPosition: state.lastLapPosition,
    };

    if (classPositionForEmit > 0) changeData.classPosition = classPositionForEmit;

    if (state.lastLapClassPosition > 0) changeData.previousClassPosition = state.lastLapClassPosition;

    if (isMultiClass !== null) changeData.isMultiClass = isMultiClass;

    emit({ event: "position.changed", data: changeData });
  } else if (state.lastPositionChangeLap < 0 && effectivePositionForEmit > 0) {
    // First lap.completed where we know our (effective) position — anchor
    // the every-3-laps cadence to this lap so a driver who holds position
    // from race start still hears status updates. Without this anchor,
    // `lapsSincePositionChange` would stay omitted until a real change
    // happened, and a P5-from-start-to-finish driver would never get any
    // race-status callout.
    state.lastPositionChangeLap = lapCompleted;
  }

  if (state.lastPositionChangeLap >= 0) {
    data.lapsSincePositionChange = lapCompleted - state.lastPositionChangeLap;
  }

  // A caution was out at some point during this lap (issue #1127, R16) — the
  // lap that ENDS a caution completes after the green, and the callouts
  // silenced under caution need to know it was a caution lap all the same.
  // Omitted rather than `false`, like every other optional flag here, so an
  // older consumer reading the payload sees exactly what it always did.
  if (state.lapCompletedWasCaution) data.wasCaution = true;

  // The pit laps (issue #1163): the facts latched for this lap on the tick the
  // counter moved, by the rule the fuel tracker shares. Omitted rather than
  // `false`, like the flags above.
  if (state.lapCompletedPit.isOutLap) data.isOutLap = true;

  if (state.lapCompletedPit.isInLap) data.isInLap = true;

  // The two shapes (issue #1582). A counted lap carries its time and the
  // best flags. A refused one carries `lapIsValid: false` and no time:
  // iRacing's `-1` is its mapping, never a payload value.
  //
  // The fastest lap of the race (issue #1571): judged on a counted lap's own
  // lap and time, through the judge the translator built over the record
  // this module never reads, and asked only of a lap iRacing took as a new
  // best — every fastest lap of the race is one, so whether the lap counted
  // is decided here and nowhere else. Called at most once per emitted lap:
  // the judge leaves a claim the translator publishes as `fastestLap.set`
  // later this tick, and the pairing rule on the catalog holds only while
  // this field and that claim are one decision.
  let payload: LapCompletedData;

  if (isCounted) {
    const counted: CountedLapCompleted = { ...data, lapTime: lapLastLapTime, isBest, isFirstValid };

    if (isBest && judgeFastestLap(lapCompleted, lapLastLapTime)) counted.isClassFastestLapOfRace = true;

    payload = counted;
  } else {
    payload = { ...data, isBest: false, isFirstValid: false, lapIsValid: false };
  }

  // Race-end detection (issue #569). Once per race session: fires on the
  // `lap.completed` of the lap the player finished — the crossing they made
  // under the checkered flag. Decided from the crossing record above, never
  // from the bit at this (possibly seconds later) emit tick: until #1278 a
  // lapped player crossing just ahead of the leader was declared finished a
  // lap early whenever the leader took the flag inside the standings wait.
  // The flag diff's record covers the winner grace, where the bit lands just
  // after the leader's crossing. The latch only flips when we successfully
  // emit (position field is populated) — without a position the race-end
  // callout can't speak, so a suppressed emit leaves the latch open for the
  // next lap.completed retry, which a crossing still under the flag
  // satisfies. The finish itself is recorded whether or not a position was
  // read (issue #1278), because a cool-down lap usually ends in the pits and
  // never brings that retry.
  const tookCheckered =
    sessionType === "race" &&
    ((crossing.lap === lapCompleted && crossing.underCheckered) || state.flagCheckeredTakenLap === lapCompleted);

  if (tookCheckered && state.raceFinish === null) {
    state.raceFinish = { sessionNum, lap: lapCompleted };
  }

  if (!state.raceFinishedFired && tookCheckered && positionForEmit > 0) {
    state.raceFinishedFired = true;

    const finishedData: { position: number; classPosition?: number; isMultiClass?: boolean } = {
      position: positionForEmit,
    };

    if (classPositionForEmit > 0) finishedData.classPosition = classPositionForEmit;

    if (isMultiClass !== null) finishedData.isMultiClass = isMultiClass;

    emit({ event: "race.finished", data: finishedData });
  }

  emit({ event: "lap.completed", data: payload });

  // The baselines follow iRacing: the count just reported, iRacing's best as
  // it now stands, and the field's value (`-1` after a refused lap).
  state.lastLapCompletedCounter = lapCompleted;
  state.lastLapBestLapTime = lapBestLapTime > 0 ? lapBestLapTime : 0;
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
