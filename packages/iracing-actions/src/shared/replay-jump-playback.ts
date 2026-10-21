/**
 * The replay jump sequence and what the replay does after it (#1276).
 *
 * A jump to an absolute frame — Replay Control's Jump to Fastest Lap and Jump
 * to Race Start, Replay Markers' Previous / Next Marker — ends the way the
 * **Replay jump playback** global setting says: at the speed the replay had
 * before the press (`remember`), playing at 1x (`play`) or paused (`stopped`).
 * Both actions run the one sequence here, so they remember the same thing and
 * wait the same way:
 *
 * 1. **Capture** the speed at the press, before any command goes out
 *    ({@link beginReplayJump}), and record the frame the jump is going to as
 *    the replay's pending target (`replay-position-state.ts`, #1430): a move
 *    made before the seek goes out steps on from there.
 * 2. **Pause** a replay that is moving — one whose captured speed is not
 *    zero, or that does not read paused — and wait for the pause to show: a
 *    moving cursor runs past the target before the landing can be read. A
 *    jump that took over from one still under way skips this when that jump
 *    has paused the replay: a pause sent into its seek would end the seek
 *    where it stands, and one sent in its pause window is a second pause.
 * 3. **Seek**, and
 * 4. **wait** until the target reads back — the replay command gate's one
 *    judgement of "landed" (`replay-command-gate.ts`), so a speed held behind
 *    the jump and the jump's own playback step meet the same landing. iRacing
 *    covers a long jump in steps, and any replay command arriving meanwhile
 *    cuts it short (#1275), so nothing follows the seek until it lands. The
 *    wait gives up on a cursor that has stopped short, not on one that is
 *    slow: its clock runs only while iRacing shows no seek under way.
 * 5. **The caller's own step**, if any — Jump to Fastest Lap's camera switch.
 * 6. **Apply the setting**: one speed command, and only when the speed wanted
 *    differs from the one the landing reads ({@link applyReplayJumpPlayback}).
 *    A paused `remember` press therefore sends the seek and nothing else.
 *
 * Every command goes out through the replay command gate, as the claim
 * holder's own. The sequence holds the replay cursor (`replay-cursor.ts`)
 * throughout: a replay command from any other key cancels it, and it then
 * sends nothing more — except that a press taking the cursor while the
 * sequence is still in its pause leaves the gate owing the seek, which it sends
 * once the pause shows (the gate's header). When a step fails or times out the
 * sequence also sends nothing more, which leaves the replay paused where it
 * stopped whatever the setting says — playing from a spot the driver did not
 * ask for is worse than stopping there.
 *
 * **What "the speed before the press" is when jumps overlap.** A jump pauses
 * the replay, so a second jump pressed before the first has finished — a fast
 * turn of the Replay Markers dial, a marker key during a fastest-lap walk —
 * would read "paused" and remember that. So the speed is one value the jumps
 * share (the cursor module's pending jump speed): a jump that takes the cursor
 * from another jump inherits the speed that one captured, and a jump pressed
 * just after another applied its speed reads that speed until telemetry shows
 * it. A speed waiting in the gate's slot is the newest word and is captured
 * instead, and a search on its way is taken at the speed the replay had when
 * it went out: a search clears slow motion, so a reading taken meanwhile says
 * full speed. Any other replay command clears the value.
 *
 * No logger here: the outcome says what happened, and the caller logs it.
 */
import { replaySpeedFromTelemetry, type TelemetryData } from "@iracedeck/iracing-sdk";
import {
  clearReplayJumpSpeed,
  isPaused,
  isSameSpeed,
  isSeeking,
  PAUSED,
  pendingReplayJumpSpeed,
  readReplayJumpPlayback,
  readReplayJumpTimeoutMs,
  recordReplayJumpSpeed,
  REPLAY_JUMP_MAX_WAIT_MS,
  REPLAY_JUMP_POLL_MS,
  type ReplayCursorClaim,
  type ReplayJumpSpeed,
  type ReplaySpeed,
  resolveReplayJumpSpeed,
  waitForReplay,
} from "@iracedeck/replay-engine";

import {
  claimReplayCursorForJump,
  closeReplayJump,
  isReplayPausedForJump,
  openReplayJump,
  recordReplayJumpTarget,
  type ReplayJumpGateHandle,
  replayJumpLanding,
  type ReplayJumpResult,
  replaySearchSpeedAtSend,
  sendOwnedReplayCommand,
  sendReplayJumpSeek,
  takeWaitingReplaySpeed,
} from "./replay-command-gate.js";

export { readReplayJumpPlayback, type ReplaySpeed, resolveReplayJumpSpeed } from "@iracedeck/replay-engine";
export type { ReplayJumpResult } from "./replay-command-gate.js";

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

/** One jump under way: the cursor claim it holds and the speed it will restore under `remember`. */
export interface ReplayJump {
  /** The replay-cursor claim, held until {@link ReplayJump.end}. */
  readonly claim: ReplayCursorClaim;
  /** The speed the replay had before the press — or, when this jump took over from another, the speed that one captured. */
  readonly captured: ReplaySpeed;
  /** Whether this jump started while another jump was under way, which has paused the replay or sent the pause. */
  readonly tookOver: boolean;
  /** The jump's handle with the replay command gate. */
  readonly gate: ReplayJumpGateHandle;
  /**
   * Hand the cursor back. Call it once, in a `finally`, however the jump
   * ended; `result` says how, for the gate's state seam, and defaults to what
   * {@link runReplayJump} saw — or, for a walk, {@link noteReplayJumpLanded} —
   * noted, and else to cancelled or gave-up.
   */
  end(result?: ReplayJumpResult): void;
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
  /** The replay stopped short of the frame sent, or was still seeking at the longest a jump waits. */
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
  /** Reads the latest telemetry. */
  readTelemetry: () => TelemetryData | null;
  /** How long to wait for the pause, and for a landing iRacing is no longer seeking towards. Default {@link readReplayJumpTimeoutMs}. */
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

/** What {@link beginReplayJump} is told about the jump besides its owner. */
export interface ReplayJumpBeginOptions {
  /** The origin token of the press (the gate's state seam): a key's context id, a dial's own. */
  readonly origin?: string;
  /**
   * The frame the jump is going to, when it is known at the press: recorded
   * as the replay's pending target before the pause. A walk, whose frame is
   * found as it goes, records its last jump's when {@link runReplayJump} runs.
   */
  readonly frame?: number;
  /**
   * Whether the jump sends a position jump (default true): it then forgets a
   * search on its way, since its seek puts the replay right. #801's search
   * runner sends none and waits for the search instead.
   */
  readonly sendsPositionJump?: boolean;
  /**
   * The caller's step after the landing, for the gate to run on the
   * read-back when a press took the cursor from the jump: a camera switch
   * belongs to where the jump was going. Its result is not looked at there.
   */
  readonly afterLanding?: (landing: TelemetryData) => boolean;
}

/** The speed one telemetry tick shows, or null when it carries none. */
function readSpeed(telemetry: TelemetryData | null): ReplaySpeed | null {
  const current = telemetry ? replaySpeedFromTelemetry(telemetry) : null;

  if (current === null) return null;

  return current.speed === 0 ? PAUSED : current;
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
 * Start a jump: capture the speed to restore and claim the replay cursor in
 * `owner`'s name, cancelling whatever held it. Call it at the press, before
 * any command is sent, with the telemetry of that moment. `onCancelled` runs
 * synchronously, once, when another replay command takes the cursor.
 *
 * The speed captured is, in order: a speed waiting in the gate's slot (the
 * driver's newest word, which the jump takes instead of sending it), the
 * pending speed of a jump still under way (one nobody has applied yet: that
 * jump paused the replay, so a search it sent went out paused — #801's dial
 * search runner, the fastest-lap walk), the speed the replay had when a
 * search still on its way went out, and else {@link captureReplaySpeed}. A
 * key's search takes the cursor, which clears the pending jump speed, so a
 * jump behind one reads the search's speed. Each is read before the claim:
 * claiming clears the pending jump speed with the cursor.
 */
export function beginReplayJump(
  owner: string,
  telemetry: TelemetryData | null,
  onCancelled?: (by: string) => void,
  nowMs: number = Date.now(),
  options: ReplayJumpBeginOptions = {},
): ReplayJump {
  const standing = pendingReplayJumpSpeed();
  const captured =
    takeWaitingReplaySpeed() ??
    (standing !== null && standing.appliedAt === null ? captureReplaySpeed(standing, telemetry, nowMs) : null) ??
    replaySearchSpeedAtSend() ??
    captureReplaySpeed(standing, telemetry, nowMs);
  // A pending speed nobody has applied yet belongs to a jump still under way.
  const tookOver = standing !== null && standing.appliedAt === null;
  const claim = claimReplayCursorForJump(owner, onCancelled, options.origin);
  const pending: ReplayJumpSpeed = { ...captured, appliedAt: null };
  const afterLanding = options.afterLanding;

  recordReplayJumpSpeed(pending);

  const gate = openReplayJump(claim, {
    frame: options.frame,
    origin: options.origin,
    telemetry,
    sendsPositionJump: options.sendsPositionJump ?? true,
    afterLanding: afterLanding === undefined ? undefined : (landing) => void afterLanding(landing),
  });
  let ended = false;

  const jump: ReplayJump & { seen: ReplayJumpResult | null } = {
    claim,
    captured,
    tookOver,
    gate,
    seen: null,
    end(result?: ReplayJumpResult): void {
      if (ended) return;

      ended = true;
      closeReplayJump(gate, result ?? jump.seen ?? (claim.cancelledBy !== null ? "cancelled" : "gave-up"));
      claim.release();

      // A jump that ended without applying a speed restores nothing, so what
      // it captured must not outlive it. Only its own record: a later jump's,
      // or the speed this one applied, stands.
      if (pendingReplayJumpSpeed() === pending) clearReplayJumpSpeed();
    },
  };

  return jump;
}

/** Notes how {@link runReplayJump} saw the jump end, for its `end()`. */
function noteSeen(jump: ReplayJump, outcome: ReplayJumpOutcome): ReplayJumpOutcome {
  setSeen(jump, outcome.kind === "landed" ? "landed" : outcome.kind === "cancelled" ? "cancelled" : "gave-up");

  return outcome;
}

/**
 * Notes that a jump which never went through {@link runReplayJump} landed:
 * a walk, once its last landing has had the setting applied. Without it the
 * jump's `end()` reports it gave up.
 */
export function noteReplayJumpLanded(jump: ReplayJump): void {
  setSeen(jump, "landed");
}

function setSeen(jump: ReplayJump, seen: ReplayJumpResult): void {
  (jump as { seen?: ReplayJumpResult | null }).seen = seen;
}

/**
 * Step 6: leave the replay at the speed the setting asks for. Sends one speed
 * command through the gate, and only when that speed differs from the one
 * `landed` reads. Returns null, having sent nothing, when the jump was
 * cancelled. `landed` is the sample the cursor landed on; the walk passes its
 * last one.
 */
export function applyReplayJumpPlayback(
  jump: ReplayJump,
  landed: TelemetryData | null,
  nowMs: number = Date.now(),
): ReplayJumpApplied | null {
  if (jump.claim.cancelledBy !== null) return null;

  const wanted = resolveReplayJumpSpeed(readReplayJumpPlayback(), jump.captured);
  const current = readSpeed(landed);
  let applied: ReplayJumpApplied;

  if (current !== null && isSameSpeed(current, wanted)) {
    applied = { speed: wanted, command: "none" };
  } else {
    const sent = sendOwnedReplayCommand(jump.claim, {
      kind: "speed",
      speed: wanted.speed,
      slowMotion: wanted.slowMotion,
    });

    if (sent === "cancelled") return null;

    applied = sent === "sent" ? { speed: wanted, command: "sent" } : { speed: current ?? PAUSED, command: "failed" };
  }

  // The next jump reads this until telemetry catches up with it.
  recordReplayJumpSpeed({ ...applied.speed, appliedAt: nowMs });

  return applied;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Steps 2 to 6 for a jump {@link beginReplayJump} started: pause if moving,
 * seek to `frame`, wait for the landing, run the caller's step and apply the
 * setting. Never throws for a cancellation or a timeout — the outcome says
 * which — and never calls `jump.end()`: the caller does, in its `finally`.
 */
export async function runReplayJump(jump: ReplayJump, options: ReplayJumpOptions): Promise<ReplayJumpOutcome> {
  return noteSeen(jump, await runSequence(jump, options));
}

async function runSequence(jump: ReplayJump, options: ReplayJumpOptions): Promise<ReplayJumpOutcome> {
  const { frame, readTelemetry, onPaused, afterLanding } = options;
  const { claim, gate } = jump;
  const timeoutMs = options.timeoutMs ?? readReplayJumpTimeoutMs();
  const pollMs = options.pollMs ?? REPLAY_JUMP_POLL_MS;

  if (claim.cancelledBy !== null) return { kind: "cancelled", by: claim.cancelledBy };

  const atPress = readTelemetry();

  // A walk's last jump, whose frame was not known at the press: recorded now, before its pause.
  if (gate.target?.frame !== frame) recordReplayJumpTarget(gate, frame, atPress);

  // The captured speed as well as the reading: right after another jump
  // applied a speed, telemetry still reads paused while the replay is already
  // starting to move, and a seek sent into that would be run past. An unknown
  // speed counts as moving too: a pause sent to a quiet paused replay costs
  // nothing. Not so when another jump under way has paused the replay: a pause
  // sent into its seek ends it where it stands.
  const moving = !isPaused(atPress) || jump.captured.speed !== 0;

  if (moving && !isReplayPausedForJump(claim, atPress)) {
    const pause = sendOwnedReplayCommand(claim, { kind: "pause", send: (replay) => replay.setPlaySpeed(0) });

    if (pause === "cancelled") return { kind: "cancelled", by: claim.cancelledBy ?? "unknown" };

    if (pause === "refused") return { kind: "stopped", reason: "pause-failed", telemetry: null };

    if (pause === "sent") {
      onPaused?.();

      const pausing = await waitForReplay(
        { claim, readTelemetry, timeoutMs, pollMs },
        (sample): sample is TelemetryData => isPaused(sample),
      );

      if (pausing.kind === "cancelled") return pausing;

      if (pausing.kind === "timeout") return { kind: "stopped", reason: "pause-timeout", telemetry: pausing.telemetry };
    }
  }

  const seek = sendReplayJumpSeek(gate);

  if (seek === "cancelled" || seek === "replaced") {
    return { kind: "cancelled", by: claim.cancelledBy ?? "another jump" };
  }

  if (seek === "refused") return { kind: "stopped", reason: "seek-failed", telemetry: null };

  // The landing is the gate's read-back of the target. The wait goes on for as
  // long as iRacing shows the seek, and gives up one timeout after it no
  // longer does without the frame having read back.
  const startedAt = Date.now();
  const latest = startedAt + REPLAY_JUMP_MAX_WAIT_MS;
  let deadline = startedAt + timeoutMs;
  let last: TelemetryData | null = null;
  let landing: TelemetryData | null = null;

  while (landing === null) {
    if (Date.now() >= Math.min(deadline, latest)) {
      return { kind: "stopped", reason: "seek-timeout", telemetry: last };
    }

    await sleep(pollMs);

    if (claim.cancelledBy !== null) return { kind: "cancelled", by: claim.cancelledBy };

    last = readTelemetry();

    const state = replayJumpLanding(gate, last);

    if (state.status === "read-back") {
      landing = state.landing ?? last;
    } else if (state.status !== "pending") {
      return { kind: "stopped", reason: "seek-timeout", telemetry: last };
    } else if (isSeeking(last)) {
      deadline = Date.now() + timeoutMs;
    }
  }

  if (afterLanding !== undefined && !afterLanding(landing)) {
    return { kind: "stopped", reason: "after-landing-failed", telemetry: landing };
  }

  const applied = applyReplayJumpPlayback(jump, landing);

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
  "seek-timeout": "jump did not land; nothing more sent",
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
