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
 * The landing also waits out the `SessionNum = -1` transient iRacing publishes
 * while the cursor lands (#607), so the sample it returns carries a session.
 *
 * The caller holds the replay cursor ({@link ReplayCursorClaim}) for the whole
 * wait: a replay command from any other key cancels the claim, and the seek
 * then reports `cancelled` at its next poll instead of waiting out the timeout.
 */
import type { ReplayCursorClaim } from "./replay-cursor.js";

/** The two telemetry fields a landing is judged by. */
export interface ReplaySeekSample {
  ReplayFrameNum?: unknown;
  SessionNum?: unknown;
}

export type ReplaySeekOutcome<T extends ReplaySeekSample> =
  { kind: "landed"; telemetry: T } | { kind: "timeout"; telemetry: T | null } | { kind: "cancelled"; by: string };

export interface ReplaySeekOptions<T extends ReplaySeekSample> {
  /** The absolute frame to land on. */
  frame: number;
  /** The cursor claim the caller holds for the duration. */
  claim: ReplayCursorClaim;
  /** Sends the jump — `setPlayPosition(ReplayPosMode.Begin, frame)`. */
  send: (frame: number) => boolean;
  /** Reads the latest telemetry. */
  readTelemetry: () => T | null;
  /** How long to wait for the landing before giving up. */
  timeoutMs: number;
  /** How often to read the telemetry while waiting. */
  pollMs: number;
  /** Injected for tests; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a sample shows the cursor on `frame`, out of the `SessionNum = -1` transient. */
export function isLandedOn(sample: ReplaySeekSample | null, frame: number): boolean {
  return (
    sample != null && sample.ReplayFrameNum === frame && typeof sample.SessionNum === "number" && sample.SessionNum >= 0
  );
}

/**
 * Send an absolute jump and wait until the cursor reads the frame that was
 * sent. Sends nothing when the claim is already cancelled.
 */
export async function seekReplayFrame<T extends ReplaySeekSample>(
  options: ReplaySeekOptions<T>,
): Promise<ReplaySeekOutcome<T>> {
  const { frame, claim, send, readTelemetry, timeoutMs, pollMs } = options;
  const sleep = options.sleep ?? defaultSleep;

  if (claim.cancelledBy !== null) return { kind: "cancelled", by: claim.cancelledBy };

  send(frame);

  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;

  while (Date.now() < deadline) {
    await sleep(pollMs);

    if (claim.cancelledBy !== null) return { kind: "cancelled", by: claim.cancelledBy };

    last = readTelemetry();

    if (isLandedOn(last, frame)) return { kind: "landed", telemetry: last as T };
  }

  return { kind: "timeout", telemetry: last };
}
