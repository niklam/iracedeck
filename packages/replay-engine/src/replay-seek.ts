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
 * The search never shows as a moving frame. Measured on 2026-10-12 on a paused
 * replay: a short jump, or one backwards, into a quiet replay lands within an
 * update or two. A long jump forwards, and any jump sent less than about half
 * a second after another, reads as if the replay had been left for the car —
 * `IsReplayPlaying` false, `ReplayFrameNum` a flat 0, `SessionNum` -1 — from
 * about 20 ms after the send until the cursor lands, and the first sample that
 * shows the frame sent is back in the replay. That took half a second for
 * 60,000 frames on a fast machine and grows with the distance. An absolute
 * jump sent meanwhile retargets the search. Any other replay command ends it
 * where it stands, as the play command above did: a frame step, a search, a
 * relative jump, and a pause too, even on a replay that is already paused.
 * So a wait is told what a seek still under way looks like
 * ({@link ReplayWaitOptions.seeking}), and a landing can be required to come
 * from a replay ({@link ReplaySeekOptions.requireReplay}).
 *
 * The caller holds the replay cursor ({@link ReplayCursorClaim}) for the whole
 * wait: a replay command from any other key cancels the claim, and the wait
 * then reports `cancelled` at its next poll instead of running to its timeout.
 */
import { pollUntil } from "./engine-clock.js";
import type { ReplayCursorClaim } from "./replay-cursor.js";

/** The telemetry fields the waits read. */
export interface ReplaySeekSample {
  IsOnTrack?: unknown;
  IsReplayPlaying?: unknown;
  ReplayFrameNum?: unknown;
  ReplayPlaySpeed?: unknown;
  SessionNum?: unknown;
}

export type ReplayWaitOutcome<T extends ReplaySeekSample> =
  { kind: "reached"; telemetry: T } | { kind: "timeout"; telemetry: T | null } | { kind: "cancelled"; by: string };

/** A seek's outcome: a wait's, or `refused` when the jump command itself was not sent. */
export type ReplaySeekOutcome<T extends ReplaySeekSample> = ReplayWaitOutcome<T> | { kind: "refused" };

export interface ReplayWaitOptions<T extends ReplaySeekSample> {
  /** The cursor claim the caller holds for the duration. */
  claim: ReplayCursorClaim;
  /** Reads the latest telemetry. */
  readTelemetry: () => T | null;
  /** How long to wait before giving up — with `seeking`, how long once no seek shows. */
  timeoutMs: number;
  /** How often to read the telemetry while waiting. */
  pollMs: number;
  /**
   * What a seek still under way reads ({@link isSeeking}). When given, the
   * timeout does not run while a read shows it, so a wait gives up on a
   * replay that has stopped short rather than on one that is slow: iRacing
   * covers a jump across hours of recording a few thousand frames per update,
   * and that takes longer than any fixed wait worth having.
   */
  seeking?: (sample: T | null) => boolean;
  /** The longest the wait runs, however long `seeking` keeps it going. */
  maxWaitMs?: number;
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
  /**
   * Take a landing only from a sample that is in a replay. Outside one
   * `ReplayFrameNum` reads a constant 0, and iRacing reports the same while
   * a seek is under way, so without this a jump to frame 0 reads as landed
   * before it has. Default `false`.
   */
  requireReplay?: boolean;
}

/** Whether a sample shows the cursor on `frame` — and, with `requireSession`, out of the `SessionNum = -1` transient. */
export function isLandedOn<T extends ReplaySeekSample>(
  sample: T | null,
  frame: number,
  requireSession = true,
): sample is T {
  if (sample == null || sample.ReplayFrameNum !== frame) return false;

  return !requireSession || (typeof sample.SessionNum === "number" && sample.SessionNum >= 0);
}

/**
 * Whether a sample shows a seek still under way: no replay on screen, and
 * nobody driving. iRacing reports a seek like a replay that has been left, so
 * the raw sample cannot tell the two apart; a driver on track is the one case
 * it can, and a wait that is told this must be bounded by `maxWaitMs` for the
 * rest — a replay left for the garage reads the same until then.
 */
export function isSeeking(sample: ReplaySeekSample | null): boolean {
  return sample?.IsReplayPlaying === false && sample.IsOnTrack !== true;
}

/** How many frames of a position jump iRacing searches in one sim update (`maxFramesToSearchPerUpdate`, default). */
const SEEK_FRAMES_PER_SIM_UPDATE = 2048;

/** One sim update, in milliseconds: the replay runs at 60 Hz. */
const SIM_UPDATE_MS = 1000 / 60;

/**
 * How long to wait for an absolute jump of `distanceFrames` to land: twice the
 * time iRacing needs at its search rate, and never less than `floorMs`.
 *
 * A jump's time grows with its length all the way. Measured on 2026-10-13 on a
 * paused replay, each twice within 5 ms: 30,000 frames 165 ms, 60,000 frames
 * 400 ms, 120,000 frames 896 ms, 195,000 frames 1495 ms — 8.1 ms per 1000
 * frames from 60,000 up, which is 2048 frames a sim update. A fixed wait
 * therefore gives up on a jump that is still on its way once the recording is
 * long enough: the 1.6 s the lap search used to allow is passed at about
 * 208,000 frames, under an hour of tape.
 */
export function replaySeekWaitMs(distanceFrames: number, floorMs: number): number {
  if (!Number.isFinite(distanceFrames) || distanceFrames <= 0) return floorMs;

  const searchMs = Math.ceil(distanceFrames / SEEK_FRAMES_PER_SIM_UPDATE) * SIM_UPDATE_MS;

  return Math.max(floorMs, Math.ceil(2 * searchMs));
}

/** Whether a sample shows the replay paused. */
export function isPaused(sample: ReplaySeekSample | null): boolean {
  return sample?.ReplayPlaySpeed === 0;
}

/**
 * Poll until `reached` holds, the claim is cancelled, or the timeout passes —
 * with `seeking`, until that long has passed with no seek showing. Sends
 * nothing.
 */
export async function waitForReplay<T extends ReplaySeekSample>(
  options: ReplayWaitOptions<T>,
  reached: (sample: T | null) => sample is T,
): Promise<ReplayWaitOutcome<T>> {
  const { claim, readTelemetry, timeoutMs, pollMs, seeking, maxWaitMs } = options;

  if (claim.cancelledBy !== null) return { kind: "cancelled", by: claim.cancelledBy };

  let last: T | null = null;

  // Sleeps first: the command the caller just sent cannot show yet.
  const waited = await pollUntil(
    (poll): ReplayWaitOutcome<T> | undefined => {
      if (claim.cancelledBy !== null) return { kind: "cancelled", by: claim.cancelledBy };

      last = readTelemetry();

      if (reached(last)) return { kind: "reached", telemetry: last };

      if (seeking?.(last)) poll.extend();

      return undefined;
    },
    { intervalMs: pollMs, timeoutMs, maxWaitMs, sleepFirst: true },
  );

  return waited.kind === "done" ? waited.value : { kind: "timeout", telemetry: last };
}

/**
 * Send an absolute jump and wait until the cursor reads the frame that was
 * sent. Sends nothing when the claim is already cancelled, and does not wait
 * for a jump the send refused: nothing is on its way.
 */
export async function seekReplayFrame<T extends ReplaySeekSample>(
  options: ReplaySeekOptions<T>,
): Promise<ReplaySeekOutcome<T>> {
  const { frame, claim, send, requireSession = true, requireReplay = false } = options;

  if (claim.cancelledBy !== null) return { kind: "cancelled", by: claim.cancelledBy };

  if (!send(frame)) return { kind: "refused" };

  return waitForReplay(
    options,
    (sample): sample is T =>
      isLandedOn(sample, frame, requireSession) && !(requireReplay && sample.IsReplayPlaying === false),
  );
}
