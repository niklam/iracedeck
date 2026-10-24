/**
 * Jump to Race Start (#1354; out of `ReplayControl` in #1467): one press,
 * from the guards to the record jump or the search. The key and the dial hand
 * it their origin token and report an `ignored` result to the replay busy
 * indicator, which the engine cannot reach.
 *
 * Jump to Race Start (issue #1354,
 * docs/superpowers/specs/2026-10-05-issue-1354-replay-jump-to-green-flag.md)
 * is a lookup first, like Jump to Fastest Lap. The race start is recorded
 * live in the replay record's `greens` section (the translator's
 * `replay.greenFlag`), so a press is one waited jump to five seconds before
 * it, with no camera switch: the green belongs to the whole field. With no
 * recorded green the pole car's lap 1 stands in for it, from the lap record
 * when it holds that lap, else from the lap walk run for lap 1
 * (`lap-walk.ts`). The press shares Jump to Fastest Lap's in-flight slot
 * (`lap-press.ts`) and ends as the Replay jump playback setting says. It
 * claims the cursor under RACE_START_JUMP_OWNER for its single waited jump,
 * and under RACE_START_WALK_OWNER while it searches.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import {
  getReplaySessionStore,
  type GreenLookup,
  type GreenQuery,
  isReplaySessionStoreInitialized,
} from "@iracedeck/replay-store";

import {
  carNumberRawByIdx,
  type LapPressResult,
  lookupRecordedLapStart,
  readSubSessionId,
  readUserId,
} from "./fastest-lap-press.js";
import {
  acceptsGreenFallbackLanding,
  greenApproachFrame,
  type GreenFlagTarget,
  resolveGreenFallbackCar,
  resolveGreenFlagTarget,
  resolvePoleCarIdx,
} from "./green-flag-target.js";
import {
  activeLapPressOrigin,
  FastestLapPressCancelled,
  holdLapPressSlot,
  inReplayNow,
  isLapPressInFlight,
  type LapPressIdentity,
  lapPressLogger,
  RACE_START_JUMP_OWNER,
  RACE_START_LOG_LABEL,
  readSessionInfo,
  runJumpToFrame,
  waitToSwitchCamera,
} from "./lap-press.js";
import { RACE_START_WALK_OWNER } from "./lap-walk-owners.js";
import { type FastestLapRecordIdentity, runFastestLapWalk } from "./lap-walk.js";
import { engineEnv, engineReads } from "./replay-engine-env.js";
import { formatSpeedDisplay } from "./replay-speed-format.js";

/** A green lookup's outcome, widened with the case where no store was initialized (tests, a plugin without one). */
type RecordedGreenLookup = GreenLookup | { hit: false; reason: "no store" };

/**
 * Whether a press has a race to aim at: the race session the cursor is in,
 * else the last race session of the replay (`resolveGreenFlagTarget`). What
 * the dial's hold preview of the gesture shows.
 */
export function canJumpToRaceStart(): boolean {
  return resolveGreenFlagTarget(readSessionInfo(), engineReads().readTelemetry()) !== null;
}

/**
 * The recorded race start of a session, from the per-session replay record
 * (#1354). Degrades to a miss when no store was initialized (tests, a plugin
 * without one), so the press still falls back.
 */
function lookupRecordedGreen(query: GreenQuery & { subSessionId?: number }): RecordedGreenLookup {
  if (!isReplaySessionStoreInitialized()) return { hit: false, reason: "no store" };

  return getReplaySessionStore().greens.findGreen(query);
}

/**
 * One Jump to Race Start press (#1354): a lookup first, like Jump to Fastest
 * Lap. The target is the race session the cursor is in, else the last race
 * session of the replay (`resolveGreenFlagTarget`). Its recorded start is
 * one waited jump to five seconds before the green, with no camera switch;
 * with no record, the pole car's lap 1 stands in ({@link jumpToGreenFromPoleCar}).
 *
 * The guards are Jump to Fastest Lap's, in its order, and each ignores the
 * press before any command is sent: no race session in the replay (the one
 * case the key greys for), the `SessionNum = -1` transient after a seek, a
 * press of either jump still in flight, and no replay on screen — the
 * debounced state, not the raw flag, which reads false for ~300 ms after
 * every seek (#1324). A press still in flight makes it `ignored`, the one
 * result the key reports to the replay busy indicator; the others, and the
 * fallback finding no car to take lap 1 from, are `refused`. Otherwise the
 * jump or the search runs fire-and-forget and the press returns `started`.
 */
export function pressJumpToRaceStart(request: { readonly origin: string }): LapPressResult {
  const { origin } = request;
  const logger = lapPressLogger();
  const telemetry = engineReads().readTelemetry();
  const sessionInfo = readSessionInfo();
  const target = resolveGreenFlagTarget(sessionInfo, telemetry);

  if (target === null) {
    logger.info("Jump to race start: no race session in this replay; press ignored");

    return { kind: "refused", reason: "no race session" };
  }

  const cursorSessionNum = telemetry?.SessionNum;

  if (typeof cursorSessionNum !== "number" || cursorSessionNum < 0) {
    logger.info("Jump to race start: replay session not settled yet; press ignored");
    logger.debug(`SessionNum=${String(cursorSessionNum)}`);

    return { kind: "refused", reason: "replay session not settled" };
  }

  if (isLapPressInFlight()) {
    logger.info("Jump to race start: previous jump still in flight; press ignored");
    logger.debug(`In-flight context: ${activeLapPressOrigin()}, ignored press context: ${origin}`);

    return { kind: "ignored" };
  }

  if (!inReplayNow()) {
    logger.info("Jump to race start: replay not open; iRacing ignores replay commands from the car");

    return { kind: "refused", reason: "replay not open" };
  }

  const subSessionId = readSubSessionId(sessionInfo);

  logger.info("Jump to race start executed");
  logger.debug(
    `Target session: ${target.sessionNum}/${target.sessionUniqueId ?? "n/a"} (${target.from}), cursor session: ${cursorSessionNum}, subSession: ${subSessionId ?? "n/a"}`,
  );

  const lookup = lookupRecordedGreen({
    subSessionId,
    sessionNum: target.sessionNum,
    sessionUniqueId: target.sessionUniqueId,
    kind: "start",
  });

  if (lookup.hit) {
    logger.info(`Jump to race start: record HIT (matchedBy ${lookup.matchedBy})`);
    logger.debug(`Green of session ${target.sessionNum}/${lookup.sessionUniqueId} at frame ${lookup.frame}`);

    // Fire-and-forget: the jump waits for the cursor to land before it sends
    // anything else (#1275), and the press handler returns immediately.
    void jumpToGreenApproach(origin, { frame: lookup.frame, what: "green recorded" });

    return { kind: "started" };
  }

  logger.info(`Jump to race start: record MISS (${lookup.reason}); falling back to lap 1 of the pole car`);

  return jumpToGreenFromPoleCar(origin, target, { telemetry, sessionInfo, subSessionId });
}

/**
 * The single waited jump of a Jump to Race Start press: through the shared
 * sequence to the run-up before `anchor.frame` — the recorded green, or the
 * recorded start of the pole car's lap 1 — and then whatever the **Replay
 * jump playback** setting says. No camera switch. A jump that stops short
 * leaves the replay paused where it stopped (`runJumpToFrame` logs it).
 */
async function jumpToGreenApproach(origin: string, anchor: { frame: number; what: string }): Promise<void> {
  const press: LapPressIdentity = { owner: RACE_START_JUMP_OWNER, noun: "jump", label: RACE_START_LOG_LABEL };

  const approachFrame = greenApproachFrame(anchor.frame);

  await holdLapPressSlot(
    origin,
    press,
    async (jump) => {
      const outcome = await runJumpToFrame(jump, { frame: approachFrame, label: RACE_START_LOG_LABEL });

      if (outcome.kind === "cancelled") throw new FastestLapPressCancelled(outcome.by, "jump");

      if (outcome.kind === "landed") {
        lapPressLogger().debug(
          `Jump to race start: ${anchor.what} at frame ${anchor.frame}; landed on ${approachFrame}; replay left at ${formatSpeedDisplay(outcome.speed.speed, outcome.speed.slowMotion)} (speed command ${outcome.command})`,
        );
      }
    },
    { frame: approachFrame },
  );
}

/**
 * The fallback of a Jump to Race Start press with no recorded green: the
 * pole car's lap 1, which starts a second or two after the green at most
 * (`resolveGreenFallbackCar`: with no qualifying grid, or a pole sitter who
 * did not take part in the target session, the car the camera is on).
 * From the lap record when it holds that lap — one waited jump and no camera
 * switch, which is what every replay recorded before the green record
 * existed gets — else from a search of the replay ({@link searchGreenFromPoleCar}).
 * With no car to take lap 1 from, or no number for it, the press is refused.
 */
function jumpToGreenFromPoleCar(
  origin: string,
  target: GreenFlagTarget,
  press: { telemetry: TelemetryData | null; sessionInfo: unknown; subSessionId: number | undefined },
): LapPressResult {
  const logger = lapPressLogger();
  const { telemetry, sessionInfo, subSessionId } = press;
  const viewedCarIdx = typeof telemetry?.CamCarIdx === "number" ? telemetry.CamCarIdx : -1;
  const car = resolveGreenFallbackCar(sessionInfo, target.sessionNum, viewedCarIdx);

  if (car === null) {
    logger.warn("Jump to race start: no pole car and no viewed car to take lap 1 from; press ignored");
    logger.debug(`Pole carIdx: ${resolvePoleCarIdx(sessionInfo) ?? "n/a"}, CamCarIdx: ${viewedCarIdx}`);

    return { kind: "refused", reason: "no car for lap 1" };
  }

  const { carIdx } = car;

  const carNum = carNumberRawByIdx(carIdx);

  if (carNum === null) {
    logger.warn("Jump to race start: could not find the car number of the car to take lap 1 from; press ignored");
    logger.debug(`carIdx: ${carIdx}`);

    return { kind: "refused", reason: "no car number" };
  }

  logger.debug(
    `Jump to race start: lap 1 of carIdx ${carIdx}, carNum ${carNum} (${car.from === "pole" ? "pole" : "the viewed car; no pole car in the target session"})`,
  );

  const lookup = lookupRecordedLapStart({
    subSessionId,
    sessionNum: target.sessionNum,
    sessionUniqueId: target.sessionUniqueId,
    carIdx,
    carNumberRaw: carNum,
    lap: 1,
  });

  if (lookup.hit) {
    logger.info(`Jump to race start: lap record HIT (matchedBy ${lookup.matchedBy})`);
    void jumpToGreenApproach(origin, { frame: lookup.frame, what: `lap 1 of carIdx ${carIdx} starts` });

    return { kind: "started" };
  }

  logger.info(`Jump to race start: lap record MISS (${lookup.reason}); searching the replay`);
  void searchGreenFromPoleCar(origin, target, {
    carIdx,
    carNum,
    viewedCarIdx,
    identity: { carNumberRaw: carNum, userId: readUserId(sessionInfo, carIdx), subSessionId },
  });

  return { kind: "started" };
}

/**
 * The last resort of a Jump to Race Start press: search the replay for the
 * start of the pole car's lap 1 with the walk Jump to Fastest Lap uses, then
 * one waited jump back by the rest of the run-up.
 *
 * iRacing's lap search follows the camera, so the camera goes onto the pole
 * car for the search and back onto the car that was on screen at the press
 * once the cursor has landed — the green belongs to the whole field, and the
 * user had chosen what to watch. It goes back too when the search gives up,
 * when a camera key interrupts it (#1428 / #1435: the replay is put back and
 * the key's own switch follows) or when the last jump stops short, but not
 * when another replay command cancelled the press: that command's own effect
 * stands.
 *
 * A search that could not verify its landing still anchors the jump when
 * the landing is near the end of the lap before lap 1
 * (`acceptsGreenFallbackLanding`): the anchor of a five-second run-up need
 * not be the exact frame the lap record demands, and iRacing's Next Lap can
 * land a few frames short of what the walk verifies (#1432). Anything
 * further off is a search that came to nothing, and like one that gave up
 * on the way it ends with the replay back on the frame and at the speed the
 * press found it: the press leaves no trace but its log lines.
 */
async function searchGreenFromPoleCar(
  origin: string,
  target: GreenFlagTarget,
  car: { carIdx: number; carNum: number; viewedCarIdx: number; identity: FastestLapRecordIdentity },
): Promise<void> {
  const logger = lapPressLogger();
  const press: LapPressIdentity = { owner: RACE_START_WALK_OWNER, noun: "walk", label: RACE_START_LOG_LABEL };

  await holdLapPressSlot(origin, press, async (jump) => {
    const camera = engineEnv().camera();
    const viewedCarNum = car.viewedCarIdx >= 0 && car.viewedCarIdx !== 255 ? carNumberRawByIdx(car.viewedCarIdx) : null;
    /** Whether the press moved the camera onto the pole car, and so owes the move back. */
    let borrowed = false;

    if (car.viewedCarIdx !== car.carIdx) {
      // Not into a jump still under way, which would swallow the switch and
      // leave the search following the car on screen (#1430).
      await waitToSwitchCamera(jump.claim, RACE_START_LOG_LABEL);

      // A camera key that interrupted the press meanwhile (#1428 / #1435)
      // wants another car: nothing is borrowed, and the walk stops at its
      // first checkpoint.
      if (jump.claim.interruptedBy === null) {
        if (!camera.switchNum(car.carNum, 0, 0)) {
          // If the SDK refused, abort rather than search for the wrong driver's lap.
          logger.warn("Jump to race start: camera switch failed, aborting");
          logger.debug(`Failed switchNum: carNum=${car.carNum}, carIdx=${car.carIdx}`);

          return;
        }

        borrowed = true;
      }
    }

    /** The camera back on the car on screen at the press. Sync, for the last jump's landing step. */
    const restoreCamera = (): void => {
      if (!borrowed) return;

      if (viewedCarNum === null) {
        logger.debug("Jump to race start: no car was on screen at the press; camera left on the pole car");

        return;
      }

      if (!camera.switchNum(viewedCarNum, 0, 0)) {
        logger.warn("Jump to race start: could not switch the camera back; it is left on the pole car");
        logger.debug(`Failed switchNum: carNum=${viewedCarNum}, carIdx=${car.viewedCarIdx}`);
      }
    };

    /**
     * The same, outside a landing step: once no jump is under way, since a
     * search that gave up may have left a seek in flight (#1430).
     */
    const restoreCameraWhenSettled = async (): Promise<void> => {
      if (!borrowed || viewedCarNum === null) {
        restoreCamera();

        return;
      }

      await waitToSwitchCamera(jump.claim, RACE_START_LOG_LABEL);
      restoreCamera();
    };

    const landing = await runFastestLapWalk(jump, {
      carIdx: car.carIdx,
      lap: 1,
      sessionNum: target.sessionNum,
      instance: target.from === "cursor" ? "cursor" : "latest",
      identity: car.identity,
      label: RACE_START_LOG_LABEL,
    });

    // The search gave up, logged why and put the replay back; or a camera key
    // interrupted it (#1428 / #1435), and the replay is put back the same
    // way before that key's own switch goes out.
    if (landing === null) {
      await restoreCameraWhenSettled();

      return;
    }

    if (!acceptsGreenFallbackLanding(landing)) {
      logger.warn("Jump to race start: the search did not reach the start of the pole car's lap 1");
      logger.debug(
        `Landed frame ${landing.landedFrame}, dist on the lap before lap 1: ${landing.priorLapDist ?? "n/a"}`,
      );
      // The camera only once the way back has landed: sent during the seek
      // it would cut it short (#1275), and iRacing would drop it (#1430).
      await landing.putBack();
      await restoreCameraWhenSettled();

      return;
    }

    const approachFrame = greenApproachFrame(landing.lapStartFrame);
    const outcome = await runJumpToFrame(jump, {
      frame: approachFrame,
      label: RACE_START_LOG_LABEL,
      // The camera goes back once the cursor has landed — sent any earlier it
      // would cut the seek short (#1275) — and never stops the jump: the
      // replay is where the press asked, whichever car is on screen.
      afterLanding: () => {
        restoreCamera();

        return true;
      },
    });

    if (outcome.kind === "cancelled") throw new FastestLapPressCancelled(outcome.by, "jump");

    // A jump that stopped short never reached `afterLanding`, and has sent
    // its last replay command: the camera goes back here, once its seek is
    // no longer under way.
    if (outcome.kind === "stopped") await restoreCameraWhenSettled();

    if (outcome.kind === "landed") {
      logger.debug(
        `Jump to race start: lap 1 of carIdx ${car.carIdx} starts at frame ${landing.lapStartFrame} (search ${landing.converged ? "converged" : "did not converge"}); landed on ${approachFrame}; replay left at ${formatSpeedDisplay(outcome.speed.speed, outcome.speed.slowMotion)} (speed command ${outcome.command})`,
      );
    }
  });
}
