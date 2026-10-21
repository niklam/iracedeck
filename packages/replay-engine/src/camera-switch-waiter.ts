/**
 * The one camera-switch policy (#1467, Decision 3 of
 * `docs/superpowers/specs/2026-10-20-issue-1467-replay-engine-package.md`):
 * every camera switch the Replay Control key or dial makes — the dial's Track
 * Order turn and Jump to My Car gesture, the keys' Jump to My Car, Next / Prev
 * Car and Next / Prev Car Number — goes through {@link requestCameraSwitch}.
 * Moved from the dial's Track Order mode (#801), where it began.
 *
 * - **A walk is cancelled first, and nothing else**: a camera switch in the
 *   middle of a Jump to Fastest Lap or Jump to Race Start walk would point
 *   its searches at another car (`cancelLapWalks`). A record jump's run, a
 *   marker jump's or the paced search's is left standing. The walks are
 *   cancelled at the request, since a walk would keep moving the replay
 *   meanwhile, and again when the switch goes out.
 * - **A switch during a position jump waits for it**: a jump swallows a
 *   camera change (9 of 9, #1430's captures), a search does not. The wait is
 *   the gate's for jumps only, with no claim, so it takes no cursor and
 *   cancels nothing: the jump lands, its playback step runs, and the switch
 *   follows. A jump that starts meanwhile is waited for too.
 * - **One switch waits for the whole plugin.** A further switch meanwhile,
 *   from any key or dial, replaces it, so however many presses and turns
 *   arrive during a jump the camera moves once. It waits for as long as the
 *   jump takes; it is dropped only at the ceiling #1276 puts on any jump's
 *   wait, when the wait fails, or when the switch is no longer valid (its key
 *   or dial left the screen, or the replay was left).
 *
 * Not a lane in the replay command gate: the gate's one newest-wins slot
 * holds a speed, search or pause, and the keypad's Next / Prev Car are
 * keystrokes, so `send` is the caller's. Camera sends stay outside the gate's
 * single-sender rule.
 */
import type { ILogger } from "@iracedeck/logger";

import { cancelLapWalks } from "./lap-walk-owners.js";
import { readReplayPosition, type ReplaySettledOutcome, waitForReplaySettled } from "./replay-command-gate.js";
import { engineLogger, engineReads } from "./replay-engine-env.js";
import { isSeeking } from "./replay-seek.js";
import { REPLAY_JUMP_MAX_WAIT_MS } from "./replay-timing.js";

/** How a switch learns of a position jump under way, and waits for the jumps to settle. */
export interface CameraSwitchJumps {
  /** Whether a position jump is under way: a pending target standing, or a seek showing. A search is not one. */
  isUnderWay(): boolean;
  /** Waits until no jump has been under way, with no claim: takes no cursor and sends nothing. */
  waitToSettle(): Promise<ReplaySettledOutcome>;
}

/** What a camera switch is, for the waiter. */
export interface CameraSwitchOptions {
  /** The name the lap walks are cancelled under. */
  readonly by: string;
  /** What opens the switch's log lines (`Dial track order`, `Replay control`). */
  readonly label: string;
  /** What the switch is called in the log (`next car`, `my car`). */
  readonly name: string;
  /** What asked for it, in the log (`ticks=1`, `Jump to My Car`). */
  readonly asked: string;
  /** Whether the switch may still go out once a wait ends: its key or dial on screen, with a replay to act on. */
  readonly stillValid: () => boolean;
  /** The jump reads; the gate's own ({@link isReplayJumpUnderWay}, {@link waitForReplayJumpsToLand}) by default. */
  readonly jumps?: CameraSwitchJumps;
  /** Where the switch's log lines go; the engine's `CameraSwitch` scope by default. */
  readonly logger?: ILogger;
}

/** One switch asked for: its send and what it is. */
interface CameraSwitchRequest {
  readonly send: () => unknown;
  readonly options: CameraSwitchOptions;
}

/** The one camera switch waiting behind a jump, for the whole plugin: the newest one asked for. */
let waiting: CameraSwitchRequest | null = null;

/** The wait that switch sits behind, or null when none waits. */
let waiter: Promise<void> | null = null;

/** Which wait {@link waiter} is, so a wait that ended clears only itself. */
let waitGeneration = 0;

/** The gate's jump reads: the default for a switch that injects none. */
const GATE_JUMPS: CameraSwitchJumps = {
  isUnderWay: () => isReplayJumpUnderWay(),
  waitToSettle: () => waitForReplayJumpsToLand(),
};

/**
 * Whether a position jump is under way, on a fresh reading: a target
 * standing (settled against this reading first), or a seek showing in a
 * replay. A search is not one.
 */
function isReplayJumpUnderWay(): boolean {
  const telemetry = engineReads().readTelemetry();

  return readReplayPosition(telemetry)?.seeking === true || (engineReads().inReplay() && isSeeking(telemetry));
}

/**
 * Waits until no jump has been under way on three reads 50 ms apart, with no
 * claim and bounded by the longest any jump waits (`REPLAY_JUMP_MAX_WAIT_MS`):
 * a jump that starts meanwhile is waited for too. Takes no cursor and sends
 * nothing.
 */
function waitForReplayJumpsToLand(): Promise<ReplaySettledOutcome> {
  return waitForReplaySettled({ jumpsOnly: true, reads: 3, timeoutMs: REPLAY_JUMP_MAX_WAIT_MS });
}

function loggerOf(options: CameraSwitchOptions): ILogger {
  return options.logger ?? engineLogger("CameraSwitch");
}

/** Makes the switch, a walk cancelled first. */
async function send(request: CameraSwitchRequest): Promise<void> {
  cancelLapWalks(request.options.by);
  await request.send();
}

/** Waits for the jump under way, then makes whatever switch is waiting by then — or drops it. */
async function switchWhenJumpsSettle(starter: CameraSwitchOptions, generation: number): Promise<void> {
  let outcome: ReplaySettledOutcome;

  try {
    outcome = await (starter.jumps ?? GATE_JUMPS).waitToSettle();
  } catch (error) {
    // A wait that failed sends nothing, and leaves no switch waiting: the
    // next one asked for is one of its own.
    if (waitGeneration === generation) waiting = null;

    loggerOf(starter).warn(
      `${starter.label}: tap dropped, the wait for the jump under way failed: ${error instanceof Error ? error.message : String(error)}`,
    );

    return;
  } finally {
    // The wait is over: a switch asked for from here on is one of its own,
    // never one folded into a switch that is already going out.
    if (waitGeneration === generation) waiter = null;
  }

  if (waitGeneration !== generation) return;

  const turn = waiting;

  waiting = null;

  if (turn === null) return;

  const { options } = turn;

  if (outcome !== "settled") {
    loggerOf(options).debug(
      `${options.label}: tap dropped (${options.name}), the jump under way did not land within the longest a jump waits`,
    );

    return;
  }

  if (!options.stillValid()) {
    loggerOf(options).debug(
      `${options.label}: tap dropped (${options.name}), the dial left the screen or the replay was left while it waited`,
    );

    return;
  }

  await send(turn);
}

/**
 * Asks for a camera switch: made at once on a quiet replay, or behind a
 * position jump under way as the one switch that waits for the whole plugin,
 * replacing any switch already waiting. The lap walks are cancelled at once,
 * not when the switch goes out: one would keep moving the replay meanwhile.
 * Resolves when the switch has gone out or been dropped.
 */
export function requestCameraSwitch(sendSwitch: () => unknown, options: CameraSwitchOptions): Promise<void> {
  const request: CameraSwitchRequest = { send: sendSwitch, options };

  cancelLapWalks(options.by);

  if (waiter !== null) {
    const replaced = waiting?.options.name;

    waiting = request;
    loggerOf(options).debug(
      `${options.label}: ${options.asked}; the switch waiting for a jump now goes to the ${options.name}` +
        (replaced === undefined ? "" : ` (was ${replaced})`),
    );

    return waiter;
  }

  if (!(options.jumps ?? GATE_JUMPS).isUnderWay()) return send(request);

  waiting = request;
  loggerOf(options).debug(
    `${options.label}: ${options.asked}; a jump is under way, the ${options.name} switch waits for it`,
  );

  const generation = ++waitGeneration;
  const run = switchWhenJumpsSettle(options, generation);

  // Set after the call: a wait that ended at once (one that threw before its
  // first await) has already cleared nothing of its own, so the run clears
  // it when it settles, either way.
  waiter = run;

  const clear = (): void => {
    if (waitGeneration === generation && waiter === run) waiter = null;
  };

  run.then(clear, clear);

  return run;
}

/** Whether a camera switch is waiting behind a jump. */
export function isCameraSwitchWaiting(): boolean {
  return waiting !== null;
}

/**
 * @internal For tests: forgets the switch waiting behind a jump. The wait
 * itself runs on and sends nothing.
 */
export function _resetCameraSwitchWaiter(): void {
  waiting = null;
  waiter = null;
  waitGeneration++;
}
