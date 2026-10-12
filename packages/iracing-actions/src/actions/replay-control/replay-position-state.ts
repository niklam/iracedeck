/**
 * Replay Control dial — where the replay stands, or is headed (#1317). Design:
 * `docs/superpowers/specs/2026-10-04-issue-1316-replay-control-dial.md`.
 *
 * A dial that moves the replay by frames has to know which frame it moves
 * from, and telemetry cannot always say. Measured against a paused replay on
 * 2026-10-12 (one machine; the times are that machine's, the rules are what
 * the code rests on):
 *
 * - A frame step moves one frame, and iRacing applies one per sim update:
 *   steps sent closer together than that are dropped.
 * - A position jump sent into a quiet replay lands within an update or two. One
 *   sent soon after another is acted on only some 400 ms after the earlier one
 *   landed, and until it lands telemetry reads as if the replay had been left:
 *   `IsReplayPlaying` false, `ReplayFrameNum` 0. A jump that arrives meanwhile
 *   replaces it, and the replay lands on the newest target — a fast turn that
 *   keeps retargeting lands on whichever target was newest every 400 ms or so,
 *   and exactly on the last one. The one limit seen: of two jumps inside one
 *   sim update (8 ms apart, faster than either deck host delivers turns) the
 *   earlier one was applied. That landing never reads back, so it is handled
 *   like any other that ends off its target.
 * - A frame step sent while such a jump is under way does not step: it ends
 *   the jump with the replay thousands of frames away. A jump relative to the
 *   current frame sent meanwhile is resolved from the start of the recording.
 *
 * So a move is measured from the **pending landing** while one stands — the
 * frame the last step or jump was sent to, the one `shared/replay-cursor.ts`
 * keeps for Replay Markers too, cleared by any other replay command — and from
 * telemetry only when the reading is the replay's. A landing stands until its
 * exact frame reads back from a replay. Nothing here waits a measured time: a
 * slower machine makes the landing stand longer, and the one clock,
 * {@link REPLAY_LANDING_GIVE_UP_MS}, only gives up on a landing that never
 * reads back.
 *
 * While a landing stands, the next move has to be an absolute jump from it,
 * never a step ({@link ReplayPosition.seeking}). That is also what puts a bad
 * landing right: a jump that ended somewhere else never reads back, so the
 * next turn is sent to where the last one was headed.
 *
 * Time is passed in, never read here. In memory only, and one value for every
 * dial: iRacing has one replay position.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";

import {
  clearReplayLanding,
  currentReplayCursorOwner,
  pendingReplayLanding,
  recordReplayLanding,
} from "../../shared/replay-cursor.js";

/**
 * @internal Exported for testing
 *
 * How long (ms) a landing may go without reading back before it is given up.
 * It stands in for "iRacing will never report this frame": a target it could
 * not reach, a jump something outside the plugin replaced, a replay that was
 * left. The longest landing measured took about half a second, so this is
 * several times that; a slower machine that needs longer only loses the
 * landing early, after which a turn is measured from telemetry when the
 * reading is the replay's and skipped when it is not. Nothing is sent when it
 * lapses. A landing is never given up while a claim on the replay cursor
 * stands: that is a jump still running under its own, longer bound (a marker
 * jump waiting for its landing), and its landing is its owner's to end.
 */
export const REPLAY_LANDING_GIVE_UP_MS = 3_000;

/** iRacing's replay frame rate. */
const FRAMES_PER_SECOND = 60;

/** How many targets of one run of moves are remembered for telling a stop on the way from a bad landing. */
const MAX_TARGETS_REMEMBERED = 512;

/** Where the replay stands or is headed. */
export interface ReplayPosition {
  /** The frame to measure the next move from: the pending landing while one stands, else the frame on screen. */
  readonly frame: number;
  /**
   * `ReplaySessionTime` (seconds) at {@link frame}: read with it, or, for a
   * pending landing, worked out from the last reading at 60 frames a second.
   * Undefined when no reading carried a time.
   */
  readonly time: number | undefined;
  /** The last frame of the recording, from the last reading; undefined when telemetry did not say. */
  readonly endFrame: number | undefined;
  /**
   * A landing stands: something was sent that has not read back. The next
   * move must be an absolute jump from {@link frame}; a frame step would end
   * the jump under way somewhere else.
   */
  readonly seeking: boolean;
}

/** What a reading that is the replay's says about the position. */
interface Standing {
  readonly frame: number;
  readonly time: number | undefined;
  readonly endFrame: number | undefined;
}

/** The moves sent since the replay last stood where telemetry said, for the bad-landing report. */
interface Run {
  /** The frame on screen when the first move of the run went out, or the last one seen before it; null when no reading ever said. */
  readonly origin: number | null;
  /** Every frame a move of the run was sent to. A fast turn lands on some of them on the way. */
  readonly targets: Set<number>;
  /** The newest landing recorded, to tell this module's landing from another surface's. */
  latest: { readonly frame: number; readonly sentAt: number };
  /** The frame a bad landing was last reported at, so it is logged once. */
  reportedAt: number | null;
}

let standing: Standing | null = null;
let run: Run | null = null;

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The position a reading carries, or null when the reading is not the
 * replay's: no telemetry, no frame, or `IsReplayPlaying` not true — what
 * iRacing reports from the car and for the whole of a jump under way, with a
 * frame of 0 that must never be measured from.
 */
function readStanding(telemetry: TelemetryData | null): Standing | null {
  if (telemetry === null || telemetry.IsReplayPlaying !== true) return null;

  const frame = finite(telemetry.ReplayFrameNum);

  if (frame === undefined) return null;

  // In a replay `ReplayFrameNumEnd` counts the frames left, not a position.
  const left = finite(telemetry.ReplayFrameNumEnd);

  return {
    frame,
    time: finite(telemetry.ReplaySessionTime),
    endFrame: left !== undefined && left >= 0 ? frame + left : undefined,
  };
}

/** The replay time at `frame`, worked out from the last reading. */
function timeAt(frame: number): number | undefined {
  if (standing === null || standing.time === undefined) return undefined;

  return standing.time + (frame - standing.frame) / FRAMES_PER_SECOND;
}

/**
 * Logs, once per frame it shows at, a replay that stands somewhere no move of
 * the run was sent to while a landing is still pending. A reading at the
 * run's origin is a move that has not started, and one at an earlier target
 * of the run is a fast turn's stop on the way; anything else is a jump or step
 * iRacing ended elsewhere.
 */
function reportBadLanding(landingFrame: number, reading: Standing, logger: ILogger): void {
  if (run === null || reading.frame === run.origin || run.targets.has(reading.frame)) return;

  if (run.reportedAt === reading.frame) return;

  run.reportedAt = reading.frame;
  logger.debug(
    `Replay stands off its target: sent to frame ${landingFrame}, reads ${reading.frame}; ` +
      "the next turn is measured from the target",
  );
}

/**
 * Where the replay stands or is headed, from one telemetry reading and the
 * clock; null when neither a pending landing nor the reading says. Settles the
 * landing as it reads: the exact frame reading back from a replay ends it, and
 * so does {@link REPLAY_LANDING_GIVE_UP_MS} passing without that.
 */
export function resolveReplayPosition(
  telemetry: TelemetryData | null,
  nowMs: number,
  logger: ILogger,
): ReplayPosition | null {
  const reading = readStanding(telemetry);

  if (reading !== null) standing = reading;

  const landing = pendingReplayLanding();

  // A landing this module did not record (a marker jump), or none: its run is over.
  if (
    run !== null &&
    (landing === null || landing.frame !== run.latest.frame || landing.sentAt !== run.latest.sentAt)
  ) {
    run = null;
  }

  if (landing !== null) {
    if (reading !== null && reading.frame === landing.frame) {
      clearReplayLanding();
      run = null;
    } else if (nowMs - landing.sentAt >= REPLAY_LANDING_GIVE_UP_MS && currentReplayCursorOwner() === null) {
      logger.debug(
        `Replay landing given up: frame ${landing.frame} did not read back within ${REPLAY_LANDING_GIVE_UP_MS} ms` +
          (reading === null ? "" : `; the replay reads ${reading.frame}`),
      );
      clearReplayLanding();
      run = null;
    } else {
      if (reading !== null) reportBadLanding(landing.frame, reading, logger);

      return { frame: landing.frame, time: timeAt(landing.frame), endFrame: standing?.endFrame, seeking: true };
    }
  }

  return reading === null ? null : { ...reading, seeking: false };
}

/**
 * Records the frame a step or a jump was just sent to as the pending landing.
 * Call it only when the command went out, after the cursor was taken for it
 * (the take clears the landing), and after {@link resolveReplayPosition} in
 * the same entry: a landing still standing there makes this move part of the
 * same run. `from` is the frame the reading showed, null when it was not the
 * replay's.
 */
export function recordReplayTarget(frame: number, from: number | null, nowMs: number): void {
  recordReplayLanding(frame, nowMs);

  if (run === null) {
    // Without a reading now, the last frame the replay was seen on: a move
    // that has not started still shows it.
    run = {
      origin: from ?? standing?.frame ?? null,
      targets: new Set(),
      latest: { frame, sentAt: nowMs },
      reportedAt: null,
    };
  } else {
    run.latest = { frame, sentAt: nowMs };
  }

  if (run.targets.size < MAX_TARGETS_REMEMBERED) run.targets.add(frame);
}

/** @internal Reset for tests. */
export function _resetReplayPositionState(): void {
  standing = null;
  run = null;
}
