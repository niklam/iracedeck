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
 * So a move is measured from the **pending target** while one stands — the
 * frame the dial's last step or jump was sent to — and from telemetry only
 * when the reading is the replay's. A target stands until its frame reads
 * back from a replay in a way that can only mean the move is done (see
 * {@link resolveReplayPosition}). Nothing here waits a measured time: a slower
 * machine makes the target stand longer, and the one clock,
 * {@link REPLAY_TARGET_GIVE_UP_MS}, only gives up on a target that never reads
 * back.
 *
 * While a target stands, the next move has to be an absolute jump from it,
 * never a step ({@link ReplayPosition.seeking}). That is also what puts a bad
 * landing right: a jump that ended somewhere else never reads back, so the
 * next turn is sent to where the last one was headed.
 *
 * The target is this module's own, not the replay cursor's pending landing
 * that Replay Markers keeps (`shared/replay-cursor.ts`): a marker surface ends
 * that landing by its own rule — the replay within a second of it — which a
 * frame move always is, so a visible marker key would end it one tick after
 * every send. The two meet only at the cursor: a replay command of any other
 * action takes the cursor and drops the target, since the replay is no longer
 * headed there, while the dial's own commands keep it
 * ({@link keepReplayTarget}).
 *
 * Time is passed in, never read here. In memory only, and one value for every
 * dial: iRacing has one replay position.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";

import { onReplayCursorTaken } from "../../shared/replay-cursor.js";

/**
 * @internal Exported for testing
 *
 * How long (ms) a target may go without reading back before it is given up.
 * It stands in for "iRacing will never report this frame": a target it could
 * not reach, a jump something outside the plugin replaced, a replay that was
 * left. The longest landing measured took about half a second, so this is
 * several times that; a slower machine that needs longer only loses the
 * target early, after which a turn is measured from telemetry when the
 * reading is the replay's and skipped when it is not. Nothing is sent when it
 * lapses.
 */
export const REPLAY_TARGET_GIVE_UP_MS = 3_000;

/** iRacing's replay frame rate. */
const FRAMES_PER_SECOND = 60;

/** How many targets of one run of moves are remembered for telling a stop on the way from a bad landing. */
const MAX_TARGETS_REMEMBERED = 512;

/** Where the replay stands or is headed. */
export interface ReplayPosition {
  /** The frame to measure the next move from: the pending target while one stands, else the frame on screen. */
  readonly frame: number;
  /**
   * `ReplaySessionTime` (seconds) at {@link frame}: read with it, or, for a
   * pending target, worked out at 60 frames a second from the reading the run
   * of moves started from. Undefined when no reading carried a time.
   */
  readonly time: number | undefined;
  /** The last frame of the recording, by the same reading; undefined when telemetry did not say. */
  readonly endFrame: number | undefined;
  /**
   * A target stands: something was sent that has not read back. The next
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

/** The frame the last step or jump was sent to. */
interface PendingTarget {
  readonly frame: number;
  /** The send's timestamp (ms). */
  readonly sentAt: number;
  /** The last replay reading known when the run of moves began: what the target's time and the recording's end are worked out from. */
  readonly anchor: Standing | null;
  /**
   * Whether this frame reading back from a replay means the move is done.
   * Not while the replay may still show it for another reason: it is the
   * frame the run started on or an earlier target of the run, where a move
   * not yet acted on, or a fast turn's stop on the way, shows the same frame.
   * A reading that is not the replay's since the send settles it: iRacing
   * shows one for the whole of a jump under way, and lands on the newest
   * target after it.
   */
  conclusive: boolean;
}

/** The moves sent since the replay last stood where telemetry said. */
interface Run {
  /** The frame on screen when the first move of the run went out; null when the reading was not the replay's. */
  readonly origin: number | null;
  /** Every frame a move of the run was sent to. A fast turn lands on some of them on the way. */
  readonly targets: Set<number>;
  /** The frame a bad landing was last reported at, so it is logged once. */
  reportedAt: number | null;
}

let pending: PendingTarget | null = null;
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

/** The replay time at `frame`, worked out from `anchor`. */
function timeAt(frame: number, anchor: Standing | null): number | undefined {
  if (anchor === null || anchor.time === undefined) return undefined;

  return anchor.time + (frame - anchor.frame) / FRAMES_PER_SECOND;
}

/**
 * Logs, once per frame it shows at, a replay that stands somewhere no move of
 * the run was sent to while a target is still pending. A reading at the run's
 * origin is a move that has not started, and one at an earlier target of the
 * run is a fast turn's stop on the way; anything else is a jump or step
 * iRacing ended elsewhere.
 */
function reportBadLanding(target: number, reading: Standing, logger: ILogger): void {
  if (run === null || reading.frame === run.origin || run.targets.has(reading.frame)) return;

  if (run.reportedAt === reading.frame) return;

  run.reportedAt = reading.frame;
  logger.debug(
    `Replay stands off its target: sent to frame ${target}, reads ${reading.frame}; ` +
      "the next turn is measured from the target",
  );
}

function clear(): void {
  pending = null;
  run = null;
}

/**
 * Where the replay stands or is headed, from one telemetry reading and the
 * clock; null when neither a pending target nor the reading says. Settles the
 * target as it reads. The target's frame reading back from a replay ends it
 * when that can only mean the move is done: the frame is one the replay could
 * not have been showing anyway, or a reading that was not the replay's has
 * been seen since the send. {@link REPLAY_TARGET_GIVE_UP_MS} passing without
 * that ends it too, and the position is then the reading's or unknown.
 */
export function resolveReplayPosition(
  telemetry: TelemetryData | null,
  nowMs: number,
  logger: ILogger,
): ReplayPosition | null {
  const reading = readStanding(telemetry);

  if (pending !== null) {
    // The whole of a jump under way reads as not the replay's.
    if (reading === null) pending.conclusive = true;

    if (reading !== null && reading.frame === pending.frame && pending.conclusive) {
      clear();
    } else if (nowMs - pending.sentAt >= REPLAY_TARGET_GIVE_UP_MS) {
      logger.debug(
        `Replay target given up: frame ${pending.frame} did not read back within ${REPLAY_TARGET_GIVE_UP_MS} ms` +
          (reading === null ? "" : `; the replay reads ${reading.frame}`),
      );
      clear();
    } else {
      if (reading !== null && reading.frame !== pending.frame) reportBadLanding(pending.frame, reading, logger);

      return {
        frame: pending.frame,
        time: timeAt(pending.frame, pending.anchor),
        endFrame: pending.anchor?.endFrame,
        seeking: true,
      };
    }
  }

  return reading === null ? null : { ...reading, seeking: false };
}

/**
 * Records the frame a step or a jump was just sent to as the pending target.
 * Call it only when the command went out. `telemetry` is the reading the move
 * was decided on, which says what the replay was showing when it was sent. A
 * target still standing makes this move part of the same run.
 */
export function recordReplayTarget(frame: number, telemetry: TelemetryData | null, nowMs: number): void {
  const shown = readStanding(telemetry);

  run ??= { origin: shown?.frame ?? null, targets: new Set(), reportedAt: null };

  // Fresh: a frame the replay cannot be showing unless this move has landed.
  const fresh = frame !== run.origin && frame !== shown?.frame && !run.targets.has(frame);

  if (run.targets.size < MAX_TARGETS_REMEMBERED) run.targets.add(frame);

  pending = { frame, sentAt: nowMs, anchor: pending?.anchor ?? shown, conclusive: fresh };
}

/**
 * Drops the pending target: something else just took the replay cursor to
 * send a command of its own, so the replay is no longer headed there and the
 * position is telemetry's again. Runs on every cursor take (registered
 * below); a dial's own take goes through {@link keepReplayTarget}.
 */
export function clearReplayTarget(): void {
  clear();
}

/**
 * Runs `take` — a dial taking the replay cursor for its own command — and
 * puts back the target that stood before it. A dial's own command does not
 * end the move the dial has under way: a speed or a pause sent during a jump
 * leaves the jump's fate open, and a target that still stands is what keeps
 * the next turn from stepping into it. A move the dial sends next replaces it
 * through {@link recordReplayTarget}.
 */
export function keepReplayTarget<T>(take: () => T): T {
  const held = pending;
  const heldRun = run;

  try {
    return take();
  } finally {
    pending = held;
    run = heldRun;
  }
}

// Every replay command of every action takes the cursor before it sends.
onReplayCursorTaken(clearReplayTarget);

/** @internal Reset for tests. */
export function _resetReplayPositionState(): void {
  clear();
}
