/**
 * The replay jump sequence and what the replay does after it (#1276).
 *
 * A jump to an absolute frame — Replay Control's Jump to Fastest Lap, Replay
 * Markers' Previous / Next Marker — ends the way the **Replay jump playback**
 * global setting says: at the speed the replay had before the press
 * (`remember`), playing at 1x (`play`) or paused (`stopped`). Both actions run
 * the one sequence here, so they remember the same thing and wait the same way:
 *
 * 1. **Capture** the speed at the press, before any command goes out
 *    ({@link beginReplayJump}).
 * 2. **Pause** a replay that is moving — one whose captured speed is not
 *    zero, or that does not read paused — and wait for the pause to show: a
 *    moving cursor runs past the target before the landing can be read.
 * 3. **Seek**, and
 * 4. **wait** until `ReplayFrameNum` reads the frame sent. iRacing covers a
 *    long jump in steps, and any replay command arriving meanwhile cuts it
 *    short (#1275), so nothing follows the seek until it lands. The wait
 *    gives up on a cursor that has stopped moving, not on one that is slow.
 * 5. **The caller's own step**, if any — Jump to Fastest Lap's camera switch.
 * 6. **Apply the setting**: one `setPlaySpeed`, and only when the speed wanted
 *    differs from the one the landing reads ({@link applyReplayJumpPlayback}).
 *    A paused `remember` press therefore sends the seek and nothing else.
 *
 * The sequence holds the replay cursor (`replay-cursor.ts`) throughout: a
 * replay command from any other key cancels it, and it then sends nothing
 * more. When a step fails or times out it also sends nothing more, which
 * leaves the replay paused where it stopped whatever the setting says —
 * playing from a spot the driver did not ask for is worse than stopping there.
 *
 * **What "the speed before the press" is when jumps overlap.** A jump pauses
 * the replay, so a second jump pressed before the first has finished — a fast
 * turn of the Replay Markers dial, a marker key during a fastest-lap walk —
 * would read "paused" and remember that. So the speed is one value the jumps
 * share (the cursor module's pending jump speed): a jump that takes the cursor
 * from another jump inherits the speed that one captured, and a jump pressed
 * just after another applied its speed reads that speed until telemetry shows
 * it. Any other replay command clears the value: a speed the driver sets
 * during a jump is theirs, and is not merged back.
 *
 * No logger here: the outcome says what happened, and the caller logs it.
 */
import { parseReplayJumpPlayback, type ReplayJumpPlayback } from "@iracedeck/app-constants";
import { ReplayPosMode, replaySpeedFromTelemetry, type TelemetryData } from "@iracedeck/iracing-sdk";
import { getGlobalSettings } from "@iracedeck/settings";

import {
  claimReplayCursor,
  clearReplayJumpSpeed,
  pendingReplayJumpSpeed,
  recordReplayJumpSpeed,
  type ReplayCursorClaim,
  type ReplayJumpSpeed,
} from "./replay-cursor.js";
import { isPaused, seekReplayFrame, waitForReplay } from "./replay-seek.js";
import { readReplayJumpTimeoutMs, REPLAY_JUMP_MAX_WAIT_MS, REPLAY_JUMP_POLL_MS } from "./replay-timing.js";

/** A replay speed in the units `setPlaySpeed` takes: in slow motion `speed` is the divisor (5 = 1/5x). 0 is paused. */
export interface ReplaySpeed {
  readonly speed: number;
  readonly slowMotion: boolean;
}

const PAUSED: ReplaySpeed = { speed: 0, slowMotion: false };
const NORMAL_SPEED: ReplaySpeed = { speed: 1, slowMotion: false };

/**
 * @internal Exported for testing
 *
 * How long (ms) the speed a jump applied stands in for telemetry that does not
 * show it yet. The sim reports a new speed within a few ticks; the hold only
 * has to outlast that, and is kept this short because for its length a speed
 * changed outside the plugin (iRacing's own replay bar) reads as "not shown
 * yet" too.
 */
export const JUMP_SPEED_HOLD_MS = 200;

/** The replay commands a jump sends; `getCommands().replay` is one. */
export interface ReplayJumpCommands {
  setPlaySpeed(speed: number, slowMotion?: boolean): boolean;
  setPlayPosition(mode: ReplayPosMode, frameNumber: number): boolean;
}

/** One jump under way: the cursor claim it holds and the speed it will restore under `remember`. */
export interface ReplayJump {
  /** The replay-cursor claim, held until {@link ReplayJump.end}. */
  readonly claim: ReplayCursorClaim;
  /** The speed the replay had before the press — or, when this jump took over from another, the speed that one captured. */
  readonly captured: ReplaySpeed;
  /** Hand the cursor back. Call it once, in a `finally`, however the jump ended. */
  end(): void;
}

/** What a jump left behind once the setting was applied. */
export interface ReplayJumpApplied {
  /** The speed the replay is at now. */
  readonly speed: ReplaySpeed;
  /** `sent`: a speed command went out. `none`: the replay already read the speed wanted. `failed`: the command was refused, and the replay is still at the speed it landed with. */
  readonly command: "sent" | "none" | "failed";
}

/** Why a jump stopped short. Each leaves the replay where it was at that point, with nothing more sent. */
export type ReplayJumpStopReason =
  /** The pause command was refused; the seek was not sent. */
  | "pause-failed"
  /** The replay never read paused; the seek was not sent. */
  | "pause-timeout"
  /** The seek command was refused. */
  | "seek-failed"
  /** `ReplayFrameNum` stopped moving without reading the frame sent. */
  | "seek-timeout"
  /** The caller's own step after the landing returned false. */
  | "after-landing-failed";

export type ReplayJumpOutcome =
  | ({ kind: "landed" } & ReplayJumpApplied)
  | { kind: "cancelled"; by: string }
  | { kind: "stopped"; reason: ReplayJumpStopReason; telemetry: TelemetryData | null };

export interface ReplayJumpOptions {
  /** The absolute frame to land on. */
  frame: number;
  /** `getCommands().replay`. */
  replay: ReplayJumpCommands;
  /** Reads the latest telemetry. */
  readTelemetry: () => TelemetryData | null;
  /** How long to wait for the pause, and for a landing the cursor is no longer moving towards. Default {@link readReplayJumpTimeoutMs}. */
  timeoutMs?: number;
  /** How often to read the telemetry while waiting. Default {@link REPLAY_JUMP_POLL_MS}. */
  pollMs?: number;
  /** Runs right after the sequence's own pause was sent — Replay Control mirrors it into its speed cache. */
  onPaused?: () => void;
  /**
   * The caller's own step, run once the cursor has landed and before the
   * setting is applied — a camera switch, which is also a command that would
   * cut the seek short if sent earlier. Returning false stops the sequence
   * with the replay paused on the frame.
   */
  afterLanding?: (landing: TelemetryData) => boolean;
}

/** The live **Replay jump playback** setting; anything unreadable is `remember`. */
export function readReplayJumpPlayback(): ReplayJumpPlayback {
  return parseReplayJumpPlayback((getGlobalSettings() as Record<string, unknown>).replayJumpPlayback);
}

/** The speed one telemetry tick shows, or null when it carries none. */
function readSpeed(telemetry: TelemetryData | null): ReplaySpeed | null {
  const current = telemetry ? replaySpeedFromTelemetry(telemetry) : null;

  if (current === null) return null;

  return current.speed === 0 ? PAUSED : current;
}

/** Two speeds are the same when the numbers match; the slow-motion flag means nothing on a paused replay. */
function isSameSpeed(a: ReplaySpeed, b: ReplaySpeed): boolean {
  return a.speed === b.speed && (a.speed === 0 || a.slowMotion === b.slowMotion);
}

/**
 * @internal Exported for testing
 *
 * The speed the replay had before a press at `nowMs`: the pending jump speed
 * while it stands — a jump still under way, or one that applied its speed less
 * than {@link JUMP_SPEED_HOLD_MS} ago and telemetry does not show it yet —
 * else what telemetry reads. An unreadable speed is taken as paused: restoring
 * nothing is the safe side of a guess.
 */
export function captureReplaySpeed(
  pending: ReplayJumpSpeed | null,
  telemetry: TelemetryData | null,
  nowMs: number,
): ReplaySpeed {
  const live = readSpeed(telemetry);

  if (pending !== null) {
    const stands =
      pending.appliedAt === null ||
      (nowMs - pending.appliedAt < JUMP_SPEED_HOLD_MS && (live === null || !isSameSpeed(live, pending)));

    if (stands) return pending.speed === 0 ? PAUSED : { speed: pending.speed, slowMotion: pending.slowMotion };
  }

  return live ?? PAUSED;
}

/**
 * @internal Exported for testing
 *
 * The speed a jump should leave the replay at.
 */
export function resolveReplayJumpSpeed(mode: ReplayJumpPlayback, captured: ReplaySpeed): ReplaySpeed {
  switch (mode) {
    case "play":
      return NORMAL_SPEED;
    case "stopped":
      return PAUSED;
    case "remember":
      return captured;
  }
}

/**
 * Start a jump: capture the speed to restore and claim the replay cursor in
 * `owner`'s name, cancelling whatever held it. Call it at the press, before
 * any command is sent, with the telemetry of that moment. `onCancelled` runs
 * synchronously, once, when another replay command takes the cursor.
 */
export function beginReplayJump(
  owner: string,
  telemetry: TelemetryData | null,
  onCancelled?: (by: string) => void,
  nowMs: number = Date.now(),
): ReplayJump {
  // Read before the claim: claiming clears the pending speed with the cursor.
  const captured = captureReplaySpeed(pendingReplayJumpSpeed(), telemetry, nowMs);
  const claim = claimReplayCursor(owner, onCancelled);
  const pending: ReplayJumpSpeed = { ...captured, appliedAt: null };

  recordReplayJumpSpeed(pending);

  return {
    claim,
    captured,
    end(): void {
      claim.release();

      // A jump that ended without applying a speed restores nothing, so what
      // it captured must not outlive it. Only its own record: a later jump's,
      // or the speed this one applied, stands.
      if (pendingReplayJumpSpeed() === pending) clearReplayJumpSpeed();
    },
  };
}

/**
 * Step 6: leave the replay at the speed the setting asks for. Sends one
 * `setPlaySpeed`, and only when that speed differs from the one `landed`
 * reads. Returns null, having sent nothing, when the jump was cancelled.
 * `landed` is the sample the cursor landed on; the walk passes its last one.
 */
export function applyReplayJumpPlayback(
  jump: ReplayJump,
  replay: Pick<ReplayJumpCommands, "setPlaySpeed">,
  landed: TelemetryData | null,
  nowMs: number = Date.now(),
): ReplayJumpApplied | null {
  if (jump.claim.cancelledBy !== null) return null;

  const wanted = resolveReplayJumpSpeed(readReplayJumpPlayback(), jump.captured);
  const current = readSpeed(landed);
  let applied: ReplayJumpApplied;

  if (current !== null && isSameSpeed(current, wanted)) {
    applied = { speed: wanted, command: "none" };
  } else if (replay.setPlaySpeed(wanted.speed, wanted.slowMotion)) {
    applied = { speed: wanted, command: "sent" };
  } else {
    applied = { speed: current ?? PAUSED, command: "failed" };
  }

  // The next jump reads this until telemetry catches up with it.
  recordReplayJumpSpeed({ ...applied.speed, appliedAt: nowMs });

  return applied;
}

/**
 * Steps 2 to 6 for a jump {@link beginReplayJump} started: pause if moving,
 * seek to `frame`, wait for the landing, run the caller's step and apply the
 * setting. Never throws for a cancellation or a timeout — the outcome says
 * which — and never calls `jump.end()`: the caller does, in its `finally`.
 */
export async function runReplayJump(jump: ReplayJump, options: ReplayJumpOptions): Promise<ReplayJumpOutcome> {
  const { frame, replay, readTelemetry, onPaused, afterLanding } = options;
  const { claim } = jump;
  const waitOptions = {
    claim,
    readTelemetry,
    timeoutMs: options.timeoutMs ?? readReplayJumpTimeoutMs(),
    pollMs: options.pollMs ?? REPLAY_JUMP_POLL_MS,
  };

  if (claim.cancelledBy !== null) return { kind: "cancelled", by: claim.cancelledBy };

  // The captured speed as well as the reading: right after another jump
  // applied a speed, telemetry still reads paused while the replay is already
  // starting to move, and a seek sent into that would be run past. An unknown
  // speed counts as moving too: a pause sent to a paused replay costs nothing.
  if (jump.captured.speed !== 0 || !isPaused(readTelemetry())) {
    if (!replay.setPlaySpeed(0)) return { kind: "stopped", reason: "pause-failed", telemetry: null };

    onPaused?.();

    const paused = await waitForReplay(waitOptions, (sample): sample is TelemetryData => isPaused(sample));

    if (paused.kind === "cancelled") return paused;

    if (paused.kind === "timeout") return { kind: "stopped", reason: "pause-timeout", telemetry: paused.telemetry };
  }

  // The landing sample is read for nothing but the frame and the speed, so
  // the `SessionNum = -1` transient after it need not be waited out. Only a
  // paused replay's frame counts as the seek still running: while the replay
  // plays — started from iRacing's own replay bar, or by a key pressed a tick
  // before this jump — every read shows a new frame, and that is playback.
  const landing = await seekReplayFrame({
    ...waitOptions,
    frame,
    send: (target) => replay.setPlayPosition(ReplayPosMode.Begin, target),
    requireSession: false,
    progress: (sample) => (isPaused(sample) ? sample?.ReplayFrameNum : null),
    maxWaitMs: REPLAY_JUMP_MAX_WAIT_MS,
  });

  if (landing.kind === "refused") return { kind: "stopped", reason: "seek-failed", telemetry: null };

  if (landing.kind === "cancelled") return landing;

  if (landing.kind === "timeout") return { kind: "stopped", reason: "seek-timeout", telemetry: landing.telemetry };

  if (afterLanding !== undefined && !afterLanding(landing.telemetry)) {
    return { kind: "stopped", reason: "after-landing-failed", telemetry: landing.telemetry };
  }

  const applied = applyReplayJumpPlayback(jump, replay, landing.telemetry);

  // Nothing is awaited between the landing and here, so a cancellation cannot
  // have arrived — unless the caller's own step took the cursor.
  if (applied === null) return { kind: "cancelled", by: claim.cancelledBy ?? "unknown" };

  return { kind: "landed", ...applied };
}

/** What went wrong, for each way a jump stops short. */
const STOPPED_SHORT: Record<ReplayJumpStopReason, string> = {
  "pause-failed": "pause failed; jump not sent",
  "pause-timeout": "replay did not pause; jump not sent",
  "seek-failed": "jump not sent",
  "seek-timeout": "jump did not land; replay left where the seek stopped",
  "after-landing-failed": "jump stopped after the landing; replay left paused there",
};

/** What a caller logs once a jump has ended. */
export interface ReplayJumpReport {
  /** What went wrong when the jump stopped short or its speed command was refused; null otherwise. */
  warn: string | null;
  /** The details, for the debug line. */
  detail: string;
}

/**
 * How a jump to `frame` ended, worded for the log, so every action that jumps
 * reports it the same way: a warning only when something went wrong, and
 * always the details — for a jump that stopped, the frame it was for and the
 * frame and speed telemetry last showed.
 */
export function describeReplayJump(outcome: ReplayJumpOutcome, frame: number): ReplayJumpReport {
  switch (outcome.kind) {
    case "landed":
      return {
        warn: outcome.command === "failed" ? "speed command failed; replay left as it landed" : null,
        detail: `landed on frame ${frame}; speed=${outcome.speed.speed} slowMotion=${outcome.speed.slowMotion} command=${outcome.command}`,
      };
    case "cancelled":
      return { warn: null, detail: `jump to frame ${frame} cancelled by ${outcome.by}` };
    case "stopped":
      return {
        warn: STOPPED_SHORT[outcome.reason],
        detail:
          `reason=${outcome.reason} target=${frame} lastFrame=${outcome.telemetry?.ReplayFrameNum ?? "n/a"} ` +
          `lastSpeed=${outcome.telemetry?.ReplayPlaySpeed ?? "n/a"}`,
      };
  }
}
