/**
 * Jump to Fastest Lap (#607, #1203, #1275, #1276; out of `ReplayControl` in
 * #1467): one press, from the guards to the record jump or the walk. The key
 * hands it its origin token and its target setting and reports an `ignored`
 * result to the replay busy indicator, which the engine cannot reach.
 *
 * Jump to Fastest Lap is a lookup first and a walk second (issue #1203,
 * docs/superpowers/specs/2026-09-24-issue-1203-fastest-lap-from-session-record.md):
 * a lap start the per-session replay record holds is one waited jump to
 * `LAP_START_APPROACH_FRAMES` before it with the camera switched onto the car
 * once the cursor has landed; a lap it does not hold is walked to
 * (`lap-walk.ts`). Either way the press ends as the **Replay jump playback**
 * setting says (#1276).
 */
import { getCarNumberRawFromSessionInfo, type TelemetryData } from "@iracedeck/iracing-sdk";
import {
  getReplaySessionStore,
  isReplaySessionStoreInitialized,
  type LapStartLookup,
  type LapStartQuery,
} from "@iracedeck/replay-store";

import {
  activeLapPressOrigin,
  FASTEST_LAP_LOG_LABEL,
  FASTEST_LAP_RECORD_JUMP_OWNER,
  FastestLapPressCancelled,
  holdLapPressSlot,
  isLapPressInFlight,
  type LapPressIdentity,
  lapPressLogger,
  readSessionInfo,
  replayOnScreen,
  reportReplayJumpSpeed,
  runJumpToFrame,
  waitToSwitchCamera,
} from "./lap-press.js";
import { FASTEST_LAP_WALK_OWNER } from "./lap-walk-owners.js";
import {
  FASTEST_TIME_TOLERANCE_MS,
  type FastestLapRecordIdentity,
  LAP_START_APPROACH_FRAMES,
  runFastestLapWalk,
} from "./lap-walk.js";
import { engineEnv, engineReads } from "./replay-engine-env.js";
import { applyReplayJumpPlayback, noteReplayJumpLanded } from "./replay-jump-playback.js";
import { formatSpeedDisplay } from "./replay-speed-format.js";

/**
 * What a press came to, at the moment it returns: `started` when a record
 * jump or a walk is under way (fire-and-forget), `ignored` when a Jump to
 * Fastest Lap or Jump to Race Start press was still in flight — the one result
 * the key reports to the replay busy indicator — and `refused` when a guard
 * stopped it before any command, with why.
 */
export type LapPressResult =
  { readonly kind: "started" } | { readonly kind: "ignored" } | { readonly kind: "refused"; readonly reason: string };

/** A record lookup's outcome, widened with the case where no store was initialized (tests, a plugin without one). */
export type RecordedLapStartLookup = LapStartLookup | { hit: false; reason: "no store" };

/** The `ResultsPositions` entry for a car in a session, matched by `SessionNum` field, not array index. */
export function findResultsPosition(
  sessionInfo: unknown,
  sessionNum: number,
  carIdx: number,
): Record<string, unknown> | undefined {
  const sessionInfoRoot = (sessionInfo as Record<string, unknown> | undefined)?.SessionInfo as
    Record<string, unknown> | undefined;
  const sessions = sessionInfoRoot?.Sessions as Array<Record<string, unknown>> | undefined;
  const session = sessions?.find((s) => (s?.SessionNum as number | undefined) === sessionNum);
  const positions = session?.ResultsPositions as Array<Record<string, unknown>> | undefined;

  return positions?.find((p) => (p?.CarIdx as number | undefined) === carIdx);
}

/** `WeekendInfo.SubSessionID` as a finite number, else undefined (nothing loaded yet). */
export function readSubSessionId(sessionInfo: unknown): number | undefined {
  const weekend = (sessionInfo as Record<string, unknown> | undefined)?.WeekendInfo as
    Record<string, unknown> | undefined;
  const raw = weekend?.SubSessionID;
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;

  return Number.isFinite(value) ? value : undefined;
}

/** `DriverInfo.Drivers[].UserID` for a car, else 0 — stored for a person reading the file, never matched on. */
export function readUserId(sessionInfo: unknown, carIdx: number): number {
  const driverInfo = (sessionInfo as Record<string, unknown> | undefined)?.DriverInfo as
    Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers as Array<Record<string, unknown>> | undefined;
  const userId = drivers?.find((d) => (d?.CarIdx as number | undefined) === carIdx)?.UserID;

  return typeof userId === "number" && Number.isFinite(userId) ? userId : 0;
}

/** A car's raw number for the camera, from the session info the SDK holds now; null when it has none. */
export function carNumberRawByIdx(carIdx: number): number | null {
  return getCarNumberRawFromSessionInfo(readSessionInfo(), carIdx);
}

/**
 * @internal Exported for testing
 *
 * Resolves a car's fastest lap number for the **current replay session**,
 * preferring `SessionInfo.Sessions[].ResultsPositions[].FastestLap` over
 * live telemetry. `ResultsPositions` is the authoritative post-session
 * record iRacing populates as soon as a replay is loaded — `CarIdxBestLapNum`
 * only fills in for laps the replay cursor has actually visited, which is
 * empty on a freshly-loaded replay.
 *
 * Session matching is by `SessionNum` field equality (not by array index),
 * because the array order is not contractually tied to the session number.
 *
 * Returns `null` when neither source yields a positive lap number.
 */
export function findFastestLapForCar(
  sessionInfo: unknown,
  telemetry: TelemetryData | null,
  carIdx: number,
): number | null {
  const sessionNum = telemetry?.SessionNum as number | undefined;

  if (typeof sessionNum === "number") {
    const fastestLap = findResultsPosition(sessionInfo, sessionNum, carIdx)?.FastestLap as number | undefined;

    if (typeof fastestLap === "number" && fastestLap > 0) {
      return fastestLap;
    }
  }

  // Fallback for live sessions where ResultsPositions hasn't been written yet
  // (race in progress, practice without finalised positions, etc.).
  const bestLapNums = telemetry?.CarIdxBestLapNum as number[] | undefined;
  const telemetryLap = bestLapNums?.[carIdx];

  if (typeof telemetryLap === "number" && telemetryLap > 0) {
    return telemetryLap;
  }

  return null;
}

/**
 * @internal Exported for testing.
 *
 * Resolves the carIdx whose fastest lap we should jump to. For
 * `always-my-car` the lookup is the driver's own car (the same path
 * `jump-to-my-car` uses). For `viewed-car` it's whichever car the replay
 * camera is currently framing (`telemetry.CamCarIdx`). Returns `-1` when
 * the resolution fails — caller is responsible for the warn.
 */
export function resolveFastestLapCarIdx(
  target: "viewed-car" | "always-my-car",
  telemetry: TelemetryData | null,
): number {
  if (target === "always-my-car") {
    const sessionInfo = readSessionInfo();
    const driverInfo = (sessionInfo as Record<string, unknown>)?.DriverInfo as Record<string, unknown> | undefined;

    return (driverInfo?.DriverCarIdx as number) ?? -1;
  }

  return (telemetry?.CamCarIdx as number) ?? -1;
}

/**
 * The recorded start frame of a car's lap, from the per-session replay
 * record. Degrades to a miss when no store was initialized (tests, a plugin
 * without one), so the press still walks.
 */
export function lookupRecordedLapStart(query: LapStartQuery & { subSessionId?: number }): RecordedLapStartLookup {
  if (!isReplaySessionStoreInitialized()) return { hit: false, reason: "no store" };

  return getReplaySessionStore().laps.findLapStart(query);
}

/**
 * The record can check the lap-number convention the lookup relies on: when
 * `ResultsPositions[].FastestTime` is present and differs from the matched
 * entry's `timeMs` by more than a tick, log it. The jump still happens.
 */
function logFastestTimeDisagreement(
  sessionInfo: unknown,
  sessionNum: number,
  carIdx: number,
  lap: number,
  timeMs: number | null,
): void {
  if (timeMs === null) return;

  const fastestTime = findResultsPosition(sessionInfo, sessionNum, carIdx)?.FastestTime;

  if (typeof fastestTime !== "number" || !(fastestTime > 0)) return;

  const diffMs = Math.abs(fastestTime * 1000 - timeMs);

  if (diffMs > FASTEST_TIME_TOLERANCE_MS) {
    lapPressLogger().debug(
      `Jump to fastest lap: FastestTime disagreement — ResultsPositions says ${fastestTime.toFixed(3)} s for carIdx ${carIdx}, the record's lap ${lap} took ${timeMs} ms (diff ${diffMs.toFixed(1)} ms); jumping anyway`,
    );
  }
}

/**
 * One Jump to Fastest Lap press: the whole of what Replay Control's key did
 * on its press. The guards run first, in this order, each before any command
 * is sent: no target car (`refused`), the `SessionNum = -1` transient after a
 * seek (`refused`), no fastest lap iRacing names (`refused`), no car number
 * for the camera (`refused`), a Jump to Fastest Lap or Jump to Race Start
 * press still in flight (`ignored`), and no replay on screen (`refused`).
 * Then the record first, else the walk; either runs fire-and-forget and the
 * press returns `started` at once.
 */
export function pressJumpToFastestLap(request: {
  readonly origin: string;
  readonly target: "viewed-car" | "always-my-car";
}): LapPressResult {
  const { origin, target } = request;
  const logger = lapPressLogger();
  const telemetry = engineReads().readTelemetry();
  const sessionInfo = readSessionInfo();
  const targetCarIdx = resolveFastestLapCarIdx(target, telemetry);

  // CarIdx 255 is iRacing's "no driver" placeholder — appears when the
  // camera is mid-transition or focused on the pace car. The downstream
  // `findFastestLapForCar` would just return null and we'd log
  // "no best lap" anyway, but a direct guard is clearer and avoids
  // burning a SessionInfo/telemetry read.
  if (targetCarIdx < 0 || targetCarIdx === 255) {
    logger.warn("No target car available for jump to fastest lap");
    logger.debug(`Target setting: ${target}, carIdx: ${targetCarIdx}`);

    return { kind: "refused", reason: "no target car" };
  }

  // iRacing publishes SessionNum -1 for ~500 ms after the cursor lands
  // (see STABILIZATION_TIMEOUT_MULTIPLIER). A press in that window would
  // find a lap through the CarIdxBestLapNum fallback and walk toward session -1, which no session map
  // holds: the walk would pause the replay, move the cursor to the start
  // of the recording, and abort. Refuse it before any command is sent.
  const targetSessionNum = telemetry?.SessionNum;

  if (typeof targetSessionNum !== "number" || targetSessionNum < 0) {
    logger.info("Jump to fastest lap: replay session not settled yet; press ignored");
    logger.debug(`SessionNum=${String(targetSessionNum)}`);

    return { kind: "refused", reason: "replay session not settled" };
  }

  const targetLap = findFastestLapForCar(sessionInfo, telemetry, targetCarIdx);

  // iRacing's own data (ResultsPositions, then CarIdxBestLapNum) names no
  // lap — a car with no timed lap yet, or none at all, like one that
  // finished with FastestLap -1. The session record is never consulted.
  if (targetLap === null) {
    logger.info("Jump to fastest lap: iRacing reports no fastest lap for the target car");
    logger.debug(`Target carIdx: ${targetCarIdx}`);

    return { kind: "refused", reason: "no fastest lap" };
  }

  const carNum = carNumberRawByIdx(targetCarIdx);

  if (carNum === null) {
    logger.warn("Could not find car number for jump-to-fastest-lap target");

    return { kind: "refused", reason: "no car number" };
  }

  // A press while a walk or a record jump stands is ignored BEFORE any
  // command goes out: a camera switch from a key with another target
  // would re-frame the car iRacing's camera-relative lap-search is
  // walking (#1203), and any command cuts a record jump's seek short
  // (#1275).
  if (isLapPressInFlight()) {
    logger.info("Jump to fastest lap: previous press still in flight; press ignored");
    logger.debug(`In-flight walk context: ${activeLapPressOrigin()}, ignored press context: ${origin}`);

    return { kind: "ignored" };
  }

  // iRacing honours camera and replay commands only out of the car
  // (irsdk_defines.h: "camera and replay commands only work when you
  // are out of your car"): a jump or a walk from the car would be sent,
  // ignored, and logged as done — and a walk would cache a session map
  // describing the live view. The debounced state, not the raw flag,
  // which reads false for ~300 ms after every seek (#1324).
  if (!replayOnScreen()) {
    logger.info("Jump to fastest lap: replay not open; iRacing ignores replay commands from the car");

    return { kind: "refused", reason: "replay not open" };
  }

  // Resolve the session at dispatch time so the lookup and the walk
  // both address the session the cursor is in (practice + qualifying
  // + race). `findFastestLapForCar` already used the same `SessionNum`
  // to look the lap number up; the `SessionUniqueID` pair tells two
  // instances of one `SessionNum` apart (a restart within a sim run).
  const sessionUniqueId = typeof telemetry?.SessionUniqueID === "number" ? telemetry.SessionUniqueID : null;
  const subSessionId = readSubSessionId(sessionInfo);

  logger.info("Jump to fastest lap executed");
  logger.debug(
    `Target carIdx: ${targetCarIdx}, carNum: ${carNum}, fastest lap: ${targetLap}, session: ${targetSessionNum}/${sessionUniqueId ?? "n/a"}, subSession: ${subSessionId ?? "n/a"}`,
  );

  // The record first (#1203): the lap start the plugin saw live, or a
  // frame an earlier walk landed on.
  const lookup = lookupRecordedLapStart({
    subSessionId,
    sessionNum: targetSessionNum,
    sessionUniqueId,
    carIdx: targetCarIdx,
    carNumberRaw: carNum,
    lap: targetLap,
  });

  if (lookup.hit) {
    logger.info(`Jump to fastest lap: record HIT (matchedBy ${lookup.matchedBy})`);
    logFastestTimeDisagreement(sessionInfo, targetSessionNum, targetCarIdx, targetLap, lookup.timeMs);

    // Fire-and-forget like the walk: the jump waits for the cursor to
    // land before it sends anything else (#1275), and the press handler
    // returns immediately.
    void jumpToRecordedLapStart(origin, {
      carIdx: targetCarIdx,
      carNum,
      lap: targetLap,
      frame: lookup.frame,
      timeMs: lookup.timeMs,
    });

    return { kind: "started" };
  }

  logger.info(`Jump to fastest lap: record MISS (${lookup.reason}); walking`);

  // The walk (issue #607, repaired in #1203). Fire-and-forget — the
  // press handler returns immediately; the walk writes what it found
  // into the record and leaves the replay as the Replay jump playback
  // setting says (#1276). It first switches the replay camera onto the
  // target car, since iRacing's lap-search is camera-focus-relative,
  // and only once no jump is under way: iRacing drops a camera change
  // sent during a seek (#1430). A record hit switches only after its
  // jump has landed, because any command sent during the seek can cut
  // it short (#1275).
  void walkToFastestLap(
    origin,
    targetCarIdx,
    targetLap,
    targetSessionNum,
    { carNumberRaw: carNum, userId: readUserId(sessionInfo, targetCarIdx), subSessionId },
    typeof telemetry?.CamCarIdx === "number" ? telemetry.CamCarIdx : targetCarIdx,
    carNum,
  );

  return { kind: "started" };
}

/**
 * @internal Exported for testing.
 *
 * Drives the replay cursor to the start of the fastest lap for a specific
 * car when the record has no frame for it (issue #607, repaired in #1203).
 * Phases:
 *
 *   1. **Session map.** On the first walk per replay (`SubSessionID` plus
 *      the `SessionUniqueID`s seen), build a map of session-instance bounds
 *      by `goToStart` + `nextSession` × N, one entry per
 *      `(SessionNum, SessionUniqueID)`; the last entry's end is open and
 *      every walk reads it live as `ReplayFrameNum + ReplayFrameNumEnd`, so
 *      the walk never leaves the replay (no `goToEnd`) and a live session
 *      that grew since the build is bisected to its current edge. A Next
 *      Session search covers its session at the rate of a position jump
 *      and shows nothing on a paused replay until it lands, so it is waited
 *      for as long as a search to the end of the recording would take, and
 *      from the last session a real event lists none is sent (#1354). A
 *      bisection probe that reads another session than its bounds promise
 *      drops the map.
 *   2. **Bisect within the target session instance.** Look up the entry
 *      whose pair matches the target and bisect with
 *      `setPlayPosition(Begin, mid)` until the car is within
 *      `CLOSE_ENOUGH_LAPS` of the lap before the target. Only a probe
 *      that shows the car moves a bound; one that finds it out of the world
 *      is no information, and another frame of the open interval is probed
 *      instead, up to `MAX_ABSENT_PROBES` of them (#1354).
 *   3. **Lap-step refinement.** `nextLap` / `prevLap` until
 *      `CarIdxLap[carIdx]` is the lap before the target, a distance nudge
 *      to that lap's end, and a `FASTEST_LAP_FINAL_BACKSTEP_TICKS`
 *      back-step, so the car is visibly approaching the line.
 *   4. **Record what was verified.** The landed frame goes into the record
 *      as the car's start of `targetLap` ONLY when the walk converged: the
 *      sample before the back-step showed the car on `targetLap − 1` at
 *      `dist ≥` `FASTEST_LAP_DIST_THRESHOLD` in the target session
 *      instance, and the sample at the back-stepped frame agreed on lap and
 *      session. Anything less — lap steps exhausted, a nudge that did not
 *      move, a landing in another lap or session — stays where it got to,
 *      warns `walk did not converge`, and records nothing: a later press
 *      would trust that frame forever.
 *   5. **Leave the replay as the Replay jump playback setting says**
 *      (#1276), converged or not: at the speed it had at the press, at 1×,
 *      or paused (`applyReplayJumpPlayback`, recorded by the gate in the
 *      engine's speed state like the opening `pause()`). The speed to
 *      restore is captured before that pause, when the press takes the
 *      cursor. This step belongs to the press, not to the walk:
 *      `runFastestLapWalk` only lands.
 *
 * An absolute jump settles when `ReplayFrameNum` reads the sent frame; a
 * search when the frame has moved from its pre-command value and, once the
 * configured `fastestLapSearchDelayMs` has elapsed, held across two reads
 * `STABILIZATION_POLL_INTERVAL_MS` apart. A search whose frame never
 * held is "unsettled" and aborts (the build caches nothing); one whose frame
 * never left its pre-command value is "unmoved" — how the sim says
 * `nextSession` in the last session. The walk holds the shared replay-cursor
 * claim; any replay command from any action cancels it, and it sends
 * nothing more. It refuses to start while no replay is on screen (the
 * controller's debounced replay state, #1324), because iRacing ignores
 * replay commands from the car. A walk that gives up puts the replay back
 * on the frame and at the speed the press found it (#1354), and the camera
 * back on `viewedCarIdx`, the car that was on screen at the press, when the
 * press had moved it. Only when the sim does not honour the way back does
 * the replay stay paused where the walk stopped, with the speed state saying
 * so, so the Play key plays.
 *
 * `cameraCarNum` is the car number a press switches the camera onto before
 * the walk, since iRacing's lap search follows the camera; null leaves the
 * camera alone. That switch, and the one back after a walk that gave up, is
 * sent only once no jump is under way (#1430): iRacing drops a camera change
 * that arrives during a seek, and a walk that then searched on the car on
 * screen would not converge.
 *
 * Resolves `ignored` when a press already held the slot (logged, and nothing
 * sent; the caller reports it to the busy indicator), else `ran` once the
 * press has ended.
 */
export async function walkToFastestLap(
  origin: string,
  carIdx: number,
  targetLap: number,
  targetSessionNum: number,
  identity: FastestLapRecordIdentity,
  viewedCarIdx: number = carIdx,
  cameraCarNum: number | null = null,
): Promise<"ignored" | "ran"> {
  const logger = lapPressLogger();

  if (isLapPressInFlight()) {
    logger.info("Jump to fastest lap: walk already in flight; press ignored");
    logger.debug(`In-flight walk context: ${activeLapPressOrigin()}, ignored press context: ${origin}`);

    return "ignored";
  }

  const press: LapPressIdentity = { owner: FASTEST_LAP_WALK_OWNER, noun: "walk", label: FASTEST_LAP_LOG_LABEL };

  await holdLapPressSlot(origin, press, async (jump) => {
    // The camera onto the target car before the walk: iRacing's lap search
    // is camera-focus-relative, so the walk must start on the right driver.
    // For viewed-car this is usually a no-op (the camera is already there);
    // for always-my-car it actively re-frames.
    if (cameraCarNum !== null) {
      await waitToSwitchCamera(jump.claim, FASTEST_LAP_LOG_LABEL);

      if (!engineEnv().camera().switchNum(cameraCarNum, 0, 0)) {
        // If the SDK refused, abort rather than walk the wrong driver.
        logger.warn("Jump to fastest lap: camera switch failed, aborting");
        logger.debug(`Failed switchNum: carNum=${cameraCarNum}, carIdx=${carIdx}`);

        return;
      }
    }

    const landing = await runFastestLapWalk(jump, {
      carIdx,
      lap: targetLap,
      sessionNum: targetSessionNum,
      instance: "cursor",
      identity,
      label: FASTEST_LAP_LOG_LABEL,
    });

    // A walk that gave up has put the replay back where the press found it,
    // whatever the setting says: nothing was jumped to. The camera the press
    // moved onto the target car goes back too, once no seek is in flight.
    if (landing === null) {
      const viewedCarNum =
        viewedCarIdx !== carIdx && viewedCarIdx >= 0 && viewedCarIdx !== 255 ? carNumberRawByIdx(viewedCarIdx) : null;

      if (viewedCarNum === null) return;

      await waitToSwitchCamera(jump.claim, FASTEST_LAP_LOG_LABEL);

      if (!engineEnv().camera().switchNum(viewedCarNum, 0, 0)) {
        logger.warn("Jump to fastest lap: could not switch the camera back; it is left on the target car");
        logger.debug(`Failed switchNum: carNum=${viewedCarNum}, carIdx=${viewedCarIdx}`);
      }

      return;
    }

    const applied = applyReplayJumpPlayback(jump, landing.telemetry);

    if (applied === null) throw new FastestLapPressCancelled(jump.claim.cancelledBy ?? "unknown");

    // The walk never ran through `runReplayJump`: say it landed, or `end()` reports it gave up.
    noteReplayJumpLanded(jump);
    reportReplayJumpSpeed(FASTEST_LAP_LOG_LABEL, applied);
    logger.debug(
      `Jump to fastest lap: walk ${landing.converged ? "converged" : "did not converge"} on frame ${landing.landedFrame}; replay left at ${formatSpeedDisplay(applied.speed.speed, applied.speed.slowMotion)} (speed command ${applied.command})`,
    );
  });

  return "ran";
}

/**
 * @internal Exported for testing.
 *
 * Jump to a lap start the record holds (#1203): the shared sequence to one
 * second before the line, with the camera switched onto the car once the
 * cursor has landed — sent any earlier it would cut the seek short (#1275).
 * The replay then does what the **Replay jump playback** setting says
 * (#1276). On any failure nothing more is sent, leaving the replay paused
 * where it stopped rather than playing from a spot nobody asked for.
 */
export async function jumpToRecordedLapStart(
  origin: string,
  target: {
    carIdx: number;
    carNum: number;
    lap: number;
    frame: number;
    timeMs: number | null;
  },
): Promise<void> {
  const logger = lapPressLogger();
  const press: LapPressIdentity = {
    owner: FASTEST_LAP_RECORD_JUMP_OWNER,
    noun: "jump",
    label: FASTEST_LAP_LOG_LABEL,
  };

  const approachFrame = Math.max(0, target.frame - LAP_START_APPROACH_FRAMES);
  // The camera onto the car once the cursor has landed. It belongs to where
  // the jump is going, so when a key takes the cursor mid-jump the gate
  // still runs it on the read-back (#1430); a car key's cancel does not.
  const afterLanding = (): boolean => {
    if (engineEnv().camera().switchNum(target.carNum, 0, 0)) return true;

    logger.warn("Jump to fastest lap: camera switch failed; replay left at the lap start");
    logger.debug(`Failed switchNum: carNum=${target.carNum}, carIdx=${target.carIdx}`);

    return false;
  };

  await holdLapPressSlot(
    origin,
    press,
    async (jump) => {
      const outcome = await runJumpToFrame(jump, {
        frame: approachFrame,
        label: FASTEST_LAP_LOG_LABEL,
        afterLanding,
      });

      if (outcome.kind === "cancelled") throw new FastestLapPressCancelled(outcome.by, "jump");

      if (outcome.kind === "landed") {
        logger.debug(
          `Lap ${target.lap} of carIdx ${target.carIdx} starts at frame ${target.frame} (time ${target.timeMs ?? "untimed"} ms); landed on ${approachFrame}; replay left at ${formatSpeedDisplay(outcome.speed.speed, outcome.speed.slowMotion)} (speed command ${outcome.command})`,
        );
      }
    },
    { frame: approachFrame, afterLanding },
  );
}
