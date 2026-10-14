/**
 * Where the replay stands, or is headed: the one pending target (#1317, moved
 * here for #1430). Design: `docs/superpowers/specs/2026-10-04-issue-1316-replay-control-dial.md`
 * and `docs/superpowers/specs/2026-10-12-issue-1430-replay-command-gate.md`.
 *
 * A surface that moves the replay by frames has to know which frame it moves
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
 * - Any other replay command sent while such a jump is under way ends the
 *   jump where it stands, thousands of frames from its target: a frame step
 *   (which does not step), a search, a speed that sets the replay playing,
 *   and a pause alike. Only another position jump is safe, because it
 *   replaces the target; a pause followed at once by a jump lands on the
 *   jump. A jump relative to the current frame sent meanwhile is resolved
 *   from the start of the recording.
 * - A jump's time grows with its length: 165, 400, 896 and 1495 ms for
 *   30000, 60000, 120000 and 195000 frames, about 2048 frames a sim update
 *   (measured 2026-10-13). A six-hour recording is 1296000 frames, about
 *   10.5 s end to end at that rate.
 *
 * So a move is measured from the **pending target** while one stands — the
 * frame the last step or jump of ANY surface was sent to — and from telemetry
 * only when the reading is the replay's. A target stands until its frame reads
 * back from a replay in a way that can only mean the move is done (see
 * {@link settleReplayTarget}). Nothing here waits a measured time: a slower
 * machine makes the target stand longer, and the one clock only gives up on a
 * target that never reads back. That clock is the jump's own wait: the larger
 * of {@link REPLAY_TARGET_GIVE_UP_MS} and twice the jump's length at iRacing's
 * search rate ({@link replayTargetGiveUpMs}), and it does not run while the
 * replay jump that recorded the target still holds the replay cursor, whose
 * own wait bounds it.
 *
 * While a target stands, the next move has to be an absolute jump from it,
 * never a step ({@link ReplayPosition.seeking}). That is also what puts a bad
 * landing right: a jump that ended somewhere else never reads back, so the
 * next turn is sent to where the last one was headed.
 *
 * One record for every sender since #1430: the dial's frame moves, the jump
 * sequence's seeks (Replay Markers and Jump to Fastest Lap) and the keys'
 * frame steps all record here, and only the replay command gate
 * (`replay-command-gate.ts`) writes it. A cursor take does not clear it: the
 * replay is still headed there whoever holds the cursor.
 *
 * Time is passed in, never read here. In memory only, and one value for the
 * whole plugin: iRacing has one replay position.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";

import { replaySeekWaitMs } from "./replay-seek.js";

/**
 * @internal Exported for testing
 *
 * The shortest a target may go without reading back before it is given up.
 * It stands in for "iRacing will never report this frame": a target it could
 * not reach, a jump something outside the plugin replaced, a replay that was
 * left. The longest short landing measured took about half a second, so this
 * is several times that; a long jump gets twice its own length at iRacing's
 * search rate instead ({@link replayTargetGiveUpMs}). Nothing is sent when it
 * lapses.
 */
export const REPLAY_TARGET_GIVE_UP_MS = 3_000;

/** iRacing's replay frame rate. */
const FRAMES_PER_SECOND = 60;

/** How many targets of one run of moves are remembered for telling a stop on the way from a bad landing. */
const MAX_TARGETS_REMEMBERED = 512;

/**
 * How long (ms) a target of a jump of `distanceFrames` may go without reading
 * back: the jump's own wait, the larger of {@link REPLAY_TARGET_GIVE_UP_MS} and
 * twice the time iRacing needs at its search rate. About 21 s for a jump
 * across a six-hour recording.
 */
export function replayTargetGiveUpMs(distanceFrames: number): number {
  return replaySeekWaitMs(distanceFrames, REPLAY_TARGET_GIVE_UP_MS);
}

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

/** What a sender says about a target besides its frame. */
export interface ReplayTargetDetails {
  /**
   * Whether the seek has gone out. A replay jump records its target at the
   * press, before the pause it sends a moving replay, so a move made in that
   * window steps on from where the jump is going; such a target cannot read
   * back, and is not timed, until {@link markReplayTargetSent}. Default true.
   */
  readonly sent?: boolean;
  /**
   * While this returns true the target is not given up by its clock: the
   * replay jump that recorded it holds the cursor, and its own wait bounds it.
   */
  readonly heldBy?: () => boolean;
  /** The origin token of the press the target belongs to (the state seam, #1430). */
  readonly origin?: string;
}

/** The pending target, as the gate reads it. */
export interface ReplayTarget {
  readonly frame: number;
  /** When the seek went out (ms), or when it was recorded while {@link sent} is false. */
  readonly sentAt: number;
  /** Whether the seek has gone out. */
  readonly sent: boolean;
  /** How long it may go without reading back once sent and not held (ms). */
  readonly giveUpMs: number;
  /** The origin token of the press it belongs to; undefined for none. */
  readonly origin: string | undefined;
  /** Identity of the record: two targets to the same frame are told apart by it. */
  readonly id: number;
}

/** The frame the last step or jump was sent to. */
interface PendingTarget {
  readonly id: number;
  readonly frame: number;
  sentAt: number;
  sent: boolean;
  giveUpMs: number;
  readonly origin: string | undefined;
  readonly heldBy: (() => boolean) | undefined;
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
let nextId = 1;

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

function snapshot(target: PendingTarget): ReplayTarget {
  return {
    id: target.id,
    frame: target.frame,
    sentAt: target.sentAt,
    sent: target.sent,
    giveUpMs: target.giveUpMs,
    origin: target.origin,
  };
}

/** How a call to {@link settleReplayTarget} left the target. */
export type ReplayTargetSettlement =
  /** Nothing stood, or the target still stands. */
  | { readonly kind: "none" }
  /** The target's frame read back: the move is done. `telemetry` is the reading that ended it. */
  | { readonly kind: "read-back"; readonly target: ReplayTarget; readonly telemetry: TelemetryData }
  /** The target went too long without reading back. `reading` is the frame the replay shows, if the reading is the replay's. */
  | { readonly kind: "gave-up"; readonly target: ReplayTarget; readonly reading: number | null };

/**
 * Settles the pending target against one reading: its frame reading back from
 * a replay ends it when that can only mean the move is done — the frame is one
 * the replay could not have been showing anyway, or a reading that was not the
 * replay's has been seen since the send — and its own wait passing without
 * that ends it too, unless the replay jump that recorded it still holds the
 * cursor. A target whose seek has not gone out is left alone. Says which, so
 * the gate can act on it; logs a give-up and a bad landing at debug.
 */
export function settleReplayTarget(
  telemetry: TelemetryData | null,
  nowMs: number,
  logger: ILogger,
): ReplayTargetSettlement {
  if (pending === null || !pending.sent) return { kind: "none" };

  const reading = readStanding(telemetry);

  // The whole of a jump under way reads as not the replay's.
  if (reading === null) pending.conclusive = true;

  if (reading !== null && telemetry !== null && reading.frame === pending.frame && pending.conclusive) {
    const target = snapshot(pending);

    clear();

    return { kind: "read-back", target, telemetry };
  }

  if (nowMs - pending.sentAt >= pending.giveUpMs && pending.heldBy?.() !== true) {
    const target = snapshot(pending);

    logger.debug(
      `Replay target given up: frame ${target.frame} did not read back within ${target.giveUpMs} ms` +
        (reading === null ? "" : `; the replay reads ${reading.frame}`),
    );
    clear();

    return { kind: "gave-up", target, reading: reading?.frame ?? null };
  }

  if (reading !== null && reading.frame !== pending.frame) reportBadLanding(pending.frame, reading, logger);

  return { kind: "none" };
}

/**
 * Where the replay stands or is headed, from one telemetry reading and the
 * clock; null when neither a pending target nor the reading says. Settles the
 * target as it reads ({@link settleReplayTarget}), and the position is then
 * the reading's or unknown.
 */
export function resolveReplayPosition(
  telemetry: TelemetryData | null,
  nowMs: number,
  logger: ILogger,
): ReplayPosition | null {
  settleReplayTarget(telemetry, nowMs, logger);

  const headed = pendingReplayTargetPosition();

  if (headed !== null) return headed;

  const reading = readStanding(telemetry);

  return reading === null ? null : { ...reading, seeking: false };
}

/** The pending target, or null; read-only. Settle it first ({@link settleReplayTarget}) for a current answer. */
export function pendingReplayTarget(): ReplayTarget | null {
  return pending === null ? null : snapshot(pending);
}

/** The position a move is measured from while a target stands; null when none does. Settles nothing. */
export function pendingReplayTargetPosition(): ReplayPosition | null {
  if (pending === null) return null;

  return {
    frame: pending.frame,
    time: timeAt(pending.frame, pending.anchor),
    endFrame: pending.anchor?.endFrame,
    seeking: true,
  };
}

/**
 * Records the frame a step or a jump was just sent to as the pending target.
 * Call it only when the command went out — or, with `details.sent` false, at a
 * replay jump's press, before its seek ({@link markReplayTargetSent}).
 * `telemetry` is the reading the move was decided on, which says what the
 * replay was showing when it was sent. A target still standing makes this
 * move part of the same run.
 */
export function recordReplayTarget(
  frame: number,
  telemetry: TelemetryData | null,
  nowMs: number,
  details: ReplayTargetDetails = {},
): ReplayTarget {
  const shown = readStanding(telemetry);

  run ??= { origin: shown?.frame ?? null, targets: new Set(), reportedAt: null };

  // Fresh: a frame the replay cannot be showing unless this move has landed.
  const fresh = frame !== run.origin && frame !== shown?.frame && !run.targets.has(frame);

  if (run.targets.size < MAX_TARGETS_REMEMBERED) run.targets.add(frame);

  const anchor = pending?.anchor ?? shown;

  pending = {
    id: nextId++,
    frame,
    sentAt: nowMs,
    sent: details.sent ?? true,
    giveUpMs: replayTargetGiveUpMs(jumpDistance(frame, shown, pending, anchor)),
    origin: details.origin,
    heldBy: details.heldBy,
    anchor,
    conclusive: fresh,
  };

  return snapshot(pending);
}

/**
 * How far a jump to `frame` may have to go: from the frame on screen and from
 * the target it replaces, whichever is further. With neither known, the
 * recording's length: a wait too long only keeps a target that will not read
 * back a little longer, and one too short gives a target up with its seek
 * still running.
 */
function jumpDistance(
  frame: number,
  shown: Standing | null,
  previous: PendingTarget | null,
  anchor: Standing | null,
): number {
  const from = [shown?.frame, previous?.frame].filter((f): f is number => f !== undefined);

  if (from.length > 0) return Math.max(...from.map((f) => Math.abs(frame - f)));

  return anchor?.endFrame ?? 0;
}

/**
 * The seek of a target recorded at a replay jump's press has gone out: from
 * now it can read back and its clock runs. Whether its frame reading back is
 * conclusive is judged from this reading, not the press's: a replay
 * fast-forwarding while its pause took hold may have run across the frame,
 * and a frame it merely ran across is not a landing. A no-op unless `target`
 * is the record standing and its seek has not been marked yet.
 */
export function markReplayTargetSent(target: ReplayTarget, telemetry: TelemetryData | null, nowMs: number): void {
  if (pending === null || pending.sent || pending.id !== target.id) return;

  const shown = readStanding(telemetry);
  const distance = shown === null ? (pending.anchor?.endFrame ?? 0) : Math.abs(pending.frame - shown.frame);

  pending.sent = true;
  pending.sentAt = nowMs;
  pending.conclusive = pending.frame !== shown?.frame;
  pending.giveUpMs = replayTargetGiveUpMs(distance);
}

/** Drops the pending target: the replay is no longer headed there, and the position is telemetry's again. */
export function clearReplayTarget(): void {
  clear();
}

/** @internal Reset for tests. */
export function _resetReplayPositionState(): void {
  clear();
}
