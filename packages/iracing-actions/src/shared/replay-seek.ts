/**
 * An absolute replay jump that waits for the cursor to land (#1275).
 *
 * iRacing does not move the cursor to a `ReplaySetPlayPosition` frame in one
 * step: it searches at most `maxFramesToSearchPerUpdate` frames per update
 * (2048 by default in `app.ini`), and a replay command that arrives while the
 * search is under way ends it wherever it has got to. Measured on 2026-09-28:
 * a play command sent 3 ms after the jump landed it only when the target lay
 * within about 2000 frames ahead, and otherwise left the cursor roughly 6000
 * frames further forward. So nothing may follow a jump until `ReplayFrameNum`
 * reads the frame that was sent.
 *
 * The caller holds the replay cursor ({@link ReplayCursorClaim}) for the whole
 * wait: a replay command from any other key cancels the claim, and the wait
 * then reports `cancelled` at its next poll instead of running to its timeout.
 */
import type { ReplayCursorClaim } from "./replay-cursor.js";

/** The telemetry fields the waits read. */
export interface ReplaySeekSample {
  ReplayFrameNum?: unknown;
  ReplayPlaySpeed?: unknown;
  SessionNum?: unknown;
}

export type ReplayWaitOutcome<T extends ReplaySeekSample> =
  { kind: "reached"; telemetry: T } | { kind: "timeout"; telemetry: T | null } | { kind: "cancelled"; by: string };

export interface ReplayWaitOptions<T extends ReplaySeekSample> {
  /** The cursor claim the caller holds for the duration. */
  claim: ReplayCursorClaim;
  /** Reads the latest telemetry. */
  readTelemetry: () => T | null;
  /** How long to wait before giving up. */
  timeoutMs: number;
  /** How often to read the telemetry while waiting. */
  pollMs: number;
}

export interface ReplaySeekOptions<T extends ReplaySeekSample> extends ReplayWaitOptions<T> {
  /** The absolute frame to land on. */
  frame: number;
  /** Sends the jump — `setPlayPosition(ReplayPosMode.Begin, frame)`. */
  send: (frame: number) => boolean;
  /**
   * Also wait out the `SessionNum = -1` transient iRacing publishes for about
   * half a second after the cursor lands (#607). A caller that reads per-car
   * arrays from the landing sample needs it (the walk); one that only plays
   * from the landing does not (the record jump). Default `true`.
   */
  requireSession?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a sample shows the cursor on `frame` — and, with `requireSession`, out of the `SessionNum = -1` transient. */
export function isLandedOn<T extends ReplaySeekSample>(
  sample: T | null,
  frame: number,
  requireSession = true,
): sample is T {
  if (sample == null || sample.ReplayFrameNum !== frame) return false;

  return !requireSession || (typeof sample.SessionNum === "number" && sample.SessionNum >= 0);
}

/** Whether a sample shows the replay paused. */
export function isPaused(sample: ReplaySeekSample | null): boolean {
  return sample?.ReplayPlaySpeed === 0;
}

/** Poll until `reached` holds, the claim is cancelled, or the timeout passes. Sends nothing. */
export async function waitForReplay<T extends ReplaySeekSample>(
  options: ReplayWaitOptions<T>,
  reached: (sample: T | null) => sample is T,
): Promise<ReplayWaitOutcome<T>> {
  const { claim, readTelemetry, timeoutMs, pollMs } = options;

  if (claim.cancelledBy !== null) return { kind: "cancelled", by: claim.cancelledBy };

  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;

  while (Date.now() < deadline) {
    await sleep(pollMs);

    if (claim.cancelledBy !== null) return { kind: "cancelled", by: claim.cancelledBy };

    last = readTelemetry();

    if (reached(last)) return { kind: "reached", telemetry: last };
  }

  return { kind: "timeout", telemetry: last };
}

/**
 * Send an absolute jump and wait until the cursor reads the frame that was
 * sent. Sends nothing when the claim is already cancelled.
 */
export async function seekReplayFrame<T extends ReplaySeekSample>(
  options: ReplaySeekOptions<T>,
): Promise<ReplayWaitOutcome<T>> {
  const { frame, claim, send, requireSession = true } = options;

  if (claim.cancelledBy !== null) return { kind: "cancelled", by: claim.cancelledBy };

  send(frame);

  return waitForReplay(options, (sample): sample is T => isLandedOn(sample, frame, requireSession));
}
