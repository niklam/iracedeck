/**
 * The one camera-switch policy (#1467, Decision 3 of
 * `docs/superpowers/specs/2026-10-20-issue-1467-replay-engine-package.md`;
 * #1428 / #1435, `docs/superpowers/specs/2026-10-24-issue-1428-camera-keys-during-replay-jump.md`):
 * every camera switch an action's key or dial makes goes through
 * {@link requestCameraSwitch}: Replay Control's (the dial's Track Order turn
 * and Jump to My Car gesture; the keys' Jump to My Car, Next / Prev Car and
 * Next / Prev Car Number), Camera Controls' keypad and dial, and Race Admin's
 * Car Selector focus press. Camera Controls' Set Camera State, flags on the
 * camera rather than a target, is sent at once and never comes here. Moved
 * from the dial's Track Order mode (#801), where it began.
 *
 * - **A walk is interrupted first, and nothing else** (#1428 / #1435): a
 *   camera switch in the middle of a Jump to Fastest Lap or Jump to Race
 *   Start walk would point its searches at another car, so the switch
 *   interrupts it (`interruptLapWalks`). The walk keeps its claim, stops its
 *   search and puts the replay back — frame, speed, and its own camera move
 *   undone — and the switch goes out after that. Only the search is
 *   interruptible: a walk that has its answer is jumping to the lap, which
 *   the switch waits for like any jump. A record jump's run, a marker jump's
 *   or the paced search's is left standing. The walks are interrupted at the
 *   request, since a walk would keep moving the replay meanwhile, and again
 *   when the switch goes out; a walk the second interrupt catches is waited
 *   for in turn. A switch that changes only the camera's angle, not its car,
 *   passes `interruptsWalks: false` and leaves a walk alone.
 * - **A lap press drops a switch still waiting from before it** (#1428 /
 *   #1435): Jump to Fastest Lap or Jump to Race Start is the newer press, so
 *   the older switch never goes out at the walk's first quiet moment to
 *   interrupt it, and the wait it sat behind ends with it. A camera switch
 *   asked for after the press interrupts its walk as above, and waits on its
 *   own.
 * - **A switch during a position jump waits for it**: a jump swallows a
 *   camera change (9 of 9, #1430's captures), a search does not. The wait is
 *   the gate's for jumps only, with no claim, so it takes no cursor and
 *   cancels nothing: the jump lands, its playback step runs, and the switch
 *   follows. A jump that starts meanwhile is waited for too. Two holds count
 *   as under way beside the jump reads, whatever reads a caller injects: a
 *   lap press winding down (interrupted, or past its search; its last replay
 *   command and its own camera step still to come), and a jump sequence with a frame
 *   from its press until its `end()` (`isReplayJumpSequenceOpen`), so the
 *   switch follows the jump's own camera switch after its landing rather
 *   than racing it. A paced search's run opens no frame and holds nothing.
 *   Every hold is a read of state the plugin keeps, never a timer.
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

import { now, pollUntil } from "./engine-clock.js";
import { isLapPressWindingDown, onLapPressStarted } from "./lap-press.js";
import { interruptLapWalks } from "./lap-walk-owners.js";
import {
  isReplayJumpSequenceOpen,
  readReplayPosition,
  type ReplaySettledOutcome,
  waitForReplaySettled,
} from "./replay-command-gate.js";
import { engineLogger, engineReads } from "./replay-engine-env.js";
import { onReplayLeft } from "./replay-left.js";
import { isSeeking } from "./replay-seek.js";
import { REPLAY_JUMP_MAX_WAIT_MS, STABILIZATION_POLL_INTERVAL_MS } from "./replay-timing.js";

/** How a switch learns of a position jump under way, and waits for the jumps to settle. */
export interface CameraSwitchJumps {
  /** Whether a position jump is under way: a pending target standing, or a seek showing. A search is not one. */
  isUnderWay(): boolean;
  /**
   * Waits until no jump has been under way, with no claim: takes no cursor
   * and sends nothing. `timeoutMs` is what is left of the switch's ceiling;
   * an injected wait may keep its own bound instead.
   */
  waitToSettle(timeoutMs?: number): Promise<ReplaySettledOutcome>;
}

/** What a camera switch is, for the waiter. */
export interface CameraSwitchOptions {
  /** The name the lap walks are interrupted under. */
  readonly by: string;
  /**
   * Whether the switch changes the camera's car, and so interrupts a lap walk
   * (#1428 / #1435): true by default. A switch of the camera's angle only
   * (another camera group or sub-camera on the same car) passes false, since
   * a walk follows the car and not the angle.
   */
  readonly interruptsWalks?: boolean;
  /** What opens the switch's log lines (`Dial track order`, `Replay control`). */
  readonly label: string;
  /** What the switch is called in the log (`next car`, `my car`). */
  readonly name: string;
  /** What asked for it, in the log (`ticks=1`, `Jump to My Car`). */
  readonly asked: string;
  /** What asked for it, as the drop line names it when it is no longer valid (`the dial`, `the key`). */
  readonly surface: string;
  /** Whether the switch may still go out once a wait ends: its key or dial on screen, with a replay to act on. */
  readonly stillValid: () => boolean;
  /**
   * The jump reads; the gate's own ({@link isReplayJumpUnderWay}, {@link waitForReplayJumpsToLand}) by default.
   * The plugin's holds ({@link isHeldByPlugin}) are added to whichever reads are used.
   */
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
  waitToSettle: (timeoutMs) => waitForReplayJumpsToLand(timeoutMs),
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
 * claim and bounded by the longest any jump waits (`REPLAY_JUMP_MAX_WAIT_MS`),
 * or by what is left of it: a jump that starts meanwhile is waited for too.
 * Takes no cursor and sends nothing.
 */
function waitForReplayJumpsToLand(timeoutMs: number = REPLAY_JUMP_MAX_WAIT_MS): Promise<ReplaySettledOutcome> {
  return waitForReplaySettled({ jumpsOnly: true, reads: 3, timeoutMs });
}

/**
 * What the plugin holds a camera switch for beside the jump reads (#1428 /
 * #1435): a lap press winding down — a walk a camera switch interrupted,
 * putting the replay back and undoing its own camera move, or one past its
 * search, jumping to the lap or putting back a search that came to nothing,
 * its own camera step still to run — and a jump sequence with a
 * frame that has not ended — between its landing and its `end()` it runs its
 * own camera switch and its playback step. Both are reads of what the plugin
 * keeps, not of a timer.
 */
function isHeldByPlugin(): boolean {
  return isLapPressWindingDown() || isReplayJumpSequenceOpen();
}

function jumpsOf(options: CameraSwitchOptions): CameraSwitchJumps {
  return options.jumps ?? GATE_JUMPS;
}

/**
 * Whether the replay has been left and not come back since: the engine's own
 * departure event (`onReplayLeft`), which is held through the plugin's seeks.
 * Not the debounced replay state alone, which reads false a second into a
 * long seek in an in-session replay — exactly when a switch must wait.
 */
let replayDeparted = false;

onReplayLeft(() => {
  replayDeparted = true;
});

/** Whether the replay has been left, on a fresh reading: back in a replay, the departure no longer stands. */
function hasLeftReplay(): boolean {
  if (engineReads().inReplay()) replayDeparted = false;

  return replayDeparted;
}

/**
 * Whether anything a switch waits for is under way: a jump, or one of the
 * plugin's holds. Not once the replay has been left: live, no seek can
 * swallow the switch, and a jump or walk left standing by the departure (its
 * target not yet given up, its landing wait not yet run out) must not park a
 * live Camera Controls or Race Admin press behind it, to be dropped because
 * the replay was left.
 */
function isUnderWay(options: CameraSwitchOptions): boolean {
  return !hasLeftReplay() && (jumpsOf(options).isUnderWay() || isHeldByPlugin());
}

/**
 * Waits until nothing a switch waits for is under way: the plugin's holds
 * end, then the jumps settle, and again while a hold has begun meanwhile.
 * Bounded overall by `REPLAY_JUMP_MAX_WAIT_MS` from the start, which only
 * gives up: every end is a read.
 */
async function waitUntilQuiet(jumps: CameraSwitchJumps): Promise<ReplaySettledOutcome> {
  const deadline = now() + REPLAY_JUMP_MAX_WAIT_MS;
  const left = (): number => Math.max(0, deadline - now());

  for (;;) {
    if (isHeldByPlugin()) {
      const released = await pollUntil(() => (isHeldByPlugin() ? undefined : true), {
        intervalMs: STABILIZATION_POLL_INTERVAL_MS,
        timeoutMs: left(),
      });

      if (released.kind === "timed-out") return "gave-up";
    }

    const outcome = await jumps.waitToSettle(left());

    if (outcome !== "settled" || !isHeldByPlugin()) return outcome;

    if (left() === 0) return "gave-up";
  }
}

function loggerOf(options: CameraSwitchOptions): ILogger {
  return options.logger ?? engineLogger("CameraSwitch");
}

/** Interrupts a lap walk for a switch that changes the camera's car. The walk's owner, or null when none was. */
function interruptWalks(options: CameraSwitchOptions): string | null {
  if (options.interruptsWalks === false) return null;

  const owner = interruptLapWalks(options.by);

  if (owner !== null) {
    loggerOf(options).debug(`${options.label}: ${options.asked}; the ${owner} is interrupted and puts the replay back`);
  }

  return owner;
}

/**
 * Makes the switch, a walk interrupted first. A walk that interrupt catches
 * (one pressed while the switch waited) is waited for in turn: the switch
 * is asked for again, behind the walk putting the replay back. A send that
 * fails is logged here and never rejects: a parked switch goes out through
 * the wait every caller of that wait shares, so its failure is no one
 * caller's to handle.
 */
async function send(request: CameraSwitchRequest): Promise<void> {
  const { options } = request;

  if (interruptWalks(options) !== null) return requestCameraSwitch(request.send, options);

  try {
    await request.send();
  } catch (error) {
    loggerOf(options).warn(
      `${options.label}: the ${options.name} switch failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Waits for the jump under way, then makes whatever switch is waiting by then — or drops it. */
async function switchWhenJumpsSettle(starter: CameraSwitchOptions, generation: number): Promise<void> {
  let outcome: ReplaySettledOutcome;

  try {
    outcome = await waitUntilQuiet(jumpsOf(starter));
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
      `${options.label}: tap dropped (${options.name}), ${options.surface} left the screen or the replay was left while it waited`,
    );

    return;
  }

  await send(turn);
}

/**
 * Asks for a camera switch: made at once on a quiet replay, or behind a
 * position jump under way as the one switch that waits for the whole plugin,
 * replacing any switch already waiting. A lap walk is interrupted at once,
 * not when the switch goes out: it would keep moving the replay meanwhile,
 * and the switch then waits for it to put the replay back. Resolves when the
 * switch has gone out, failed (logged) or been dropped; never rejects for a
 * failed send.
 */
export function requestCameraSwitch(sendSwitch: () => unknown, options: CameraSwitchOptions): Promise<void> {
  const request: CameraSwitchRequest = { send: sendSwitch, options };

  interruptWalks(options);

  if (waiter !== null) {
    const replaced = waiting?.options.name;

    waiting = request;
    loggerOf(options).debug(
      `${options.label}: ${options.asked}; the switch waiting for a jump now goes to the ${options.name}` +
        (replaced === undefined ? "" : ` (was ${replaced})`),
    );

    return waiter;
  }

  if (!isUnderWay(options)) return send(request);

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

/**
 * A lap press drops the switch still waiting from before it (#1428 / #1435):
 * the press is the newer one, and the older switch would otherwise go out at
 * its walk's first quiet moment and interrupt it. The wait it sat behind ends
 * with it, as {@link _resetCameraSwitchWaiter} ends one: its run goes on to
 * its end and sends nothing, and a switch asked for after the press is one of
 * its own — its own ceiling from its own request, and its own jump reads —
 * never folded into the older wait.
 */
onLapPressStarted((label) => {
  const dropped = waiting;

  waiting = null;

  if (waiter !== null) {
    waiter = null;
    waitGeneration++;
  }

  if (dropped === null) return;

  const { options } = dropped;

  loggerOf(options).debug(`${options.label}: tap dropped (${options.name}), a ${label} press came after it`);
});

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
  replayDeparted = false;
}
