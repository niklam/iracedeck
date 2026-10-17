/**
 * Replay Control dial — Car (#801): iRacing's Next Car / Previous Car binding,
 * one tap per rotate event, whatever its `ticks`. A rotation mode of the dial
 * surface (`replay-control-dial-mode.ts`). Design:
 * `docs/superpowers/specs/2026-10-12-issue-801-replay-control-dial-stepping.md`
 * ("Car").
 *
 * - **One tap per event**, not per detent: a keyboard tap holds the key for
 *   about 100 ms and a continued spin arrives as further events. The keys are
 *   the ones Camera Controls' Track Order dial and the keypad's car modes tap
 *   (`CAR_CYCLE_BINDING_KEYS`, V / Shift+V by default, SimHub roles included).
 * - **A walk is cancelled first, and nothing else**: a camera switch in the
 *   middle of a Jump to Fastest Lap or Jump to Race Start walk would point
 *   its searches at another car. A record jump's run, a marker jump's or the
 *   paced search's is left standing.
 * - **A turn during a position jump waits for it**: a jump swallows the tap
 *   (9 of 9, #1430's captures), a search does not. The wait is the gate's for
 *   jumps only, with no claim, so it takes no cursor and cancels nothing: the
 *   jump lands, its playback step runs, and the tap follows. A jump that
 *   starts meanwhile is waited for too.
 * - **One tap waits for the whole plugin.** A further turn meanwhile, on this
 *   dial or another, replaces it with its own direction, so however many
 *   events arrive during a jump the camera moves by one car. It waits for as
 *   long as the jump takes; it is dropped only at the ceiling #1276 puts on
 *   any jump's wait, when the dial that turned it has left the screen, or when
 *   the replay has been left.
 *
 * It sends no replay command, so it passes no origin token and draws nothing
 * of #1437's.
 */
import { getCarNumberFromSessionInfo } from "@iracedeck/iracing-sdk";

import { CAR_CYCLE_BINDING_KEY_LIST, CAR_CYCLE_BINDING_KEYS } from "../../shared/car-cycle-bindings.js";
import type { ReplayDialMode, ReplayDialStepIo } from "./replay-control-dial-mode.js";
import { NO_CAR_IDX } from "./replay-record-step.js";
import { formatSpeedDisplay } from "./replay-speed-format.js";

/** The name a Car turn cancels a walk under. */
const CURSOR_OWNER = "dial-car";

type CarDirection = keyof typeof CAR_CYCLE_BINDING_KEYS;

/** The one tap waiting behind a jump, for the whole plugin: the newest turn's direction and the dial that turned it. */
let waiting: { direction: CarDirection; io: ReplayDialStepIo } | null = null;

/** The wait that tap sits behind, or null when none waits. */
let waiter: Promise<void> | null = null;

/** Which wait {@link waiter} is, so a wait that ended clears only itself. */
let waitGeneration = 0;

/** What a direction is called in the log. */
function describe(direction: CarDirection): string {
  return direction === "next" ? "next car" : "previous car";
}

/** Taps the binding for `direction`, a walk cancelled first. */
async function tap(io: ReplayDialStepIo, direction: CarDirection): Promise<void> {
  const key = CAR_CYCLE_BINDING_KEYS[direction];

  io.cancelCameraWalks(CURSOR_OWNER);

  const sent = await io.tapBinding(key);

  io.logger.info(`Dial car: ${describe(direction)}`);
  io.logger.debug(`Dial car: tapped ${key}, result: ${sent}`);
}

/** Waits for the jump under way, then taps whatever turn is waiting by then — or drops it. */
async function tapWhenJumpsSettle(io: ReplayDialStepIo, generation: number): Promise<void> {
  let outcome: Awaited<ReturnType<ReplayDialStepIo["waitForJumpsToSettle"]>>;

  try {
    outcome = await io.waitForJumpsToSettle();
  } catch (error) {
    // A wait that failed taps nothing, and leaves no turn waiting that holds a
    // dial's io: the next turn is a turn of its own.
    if (waitGeneration === generation) waiting = null;

    io.logger.warn(
      `Dial car: tap dropped, the wait for the jump under way failed: ${error instanceof Error ? error.message : String(error)}`,
    );

    return;
  } finally {
    // The wait is over: a turn from here on is a turn of its own, never one
    // folded into a tap that is already going out.
    if (waitGeneration === generation) waiter = null;
  }

  if (waitGeneration !== generation) return;

  const turn = waiting;

  waiting = null;

  if (turn === null) return;

  if (outcome !== "settled") {
    turn.io.logger.debug(`Dial car: tap dropped, the jump under way did not land within the longest a jump waits`);

    return;
  }

  if (!turn.io.isStillOnScreen()) {
    turn.io.logger.debug("Dial car: tap dropped, the dial left the screen or the replay was left while it waited");

    return;
  }

  await tap(turn.io, turn.direction);
}

/**
 * @internal Exported for testing
 *
 * Forgets the tap waiting behind a jump. The wait itself runs on and taps
 * nothing.
 */
export function _resetCarTap(): void {
  waiting = null;
  waiter = null;
  waitGeneration++;
}

/**
 * @internal Exported for testing
 *
 * Whether a tap is waiting behind a jump.
 */
export function _isCarTapWaiting(): boolean {
  return waiting !== null;
}

/** The Car mode. Clockwise is iRacing's Next Car, the car ahead on track; counter-clockwise Previous Car. */
export const carMode: ReplayDialMode<ReplayDialStepIo> = {
  label: "CAR",
  rotateDescription: "Next / previous car",

  rotate(ticks, _dial, io) {
    const direction: CarDirection = ticks > 0 ? "next" : "previous";
    const key = CAR_CYCLE_BINDING_KEYS[direction];

    // `tapBinding` resolves with nothing to say for an unset binding, so check first.
    if (io.isBindingMissing(key)) {
      io.logger.warn("Dial car: binding not configured, nothing sent");
      io.logger.debug(`Dial car: direction=${direction}, binding=${key}`);

      return;
    }

    // Stop a walk now, not when the tap goes out: it would keep moving the replay meanwhile.
    io.cancelCameraWalks(CURSOR_OWNER);

    if (waiter !== null) {
      const replaced = waiting?.direction;

      waiting = { direction, io };
      io.logger.debug(
        `Dial car: ticks=${ticks}; the tap waiting for a jump now goes to the ${describe(direction)}` +
          (replaced === undefined ? "" : ` (was ${describe(replaced)})`),
      );

      return waiter;
    }

    if (!io.isJumpUnderWay()) return tap(io, direction);

    waiting = { direction, io };
    io.logger.debug(`Dial car: ticks=${ticks}; a jump is under way, the ${describe(direction)} tap waits for it`);

    const generation = ++waitGeneration;
    const run = tapWhenJumpsSettle(io, generation);

    // Set after the call: a wait that ended at once (one that threw before its
    // first await) has already cleared nothing of its own, so the run clears
    // it when it settles, either way.
    waiter = run;

    const clear = (): void => {
      if (waitGeneration === generation && waiter === run) waiter = null;
    };

    run.then(clear, clear);

    return run;
  },

  view(_dial, io) {
    const live = io.liveSpeed();
    const carIdx = io.telemetry()?.CamCarIdx;
    const number =
      typeof carIdx === "number" && carIdx >= 0 && carIdx !== NO_CAR_IDX
        ? getCarNumberFromSessionInfo(io.sessionInfo(), carIdx)
        : null;

    return {
      // A tick read mid-seek is not the replay's: the box keeps the car it showed.
      value: io.position() === null ? null : number === null ? "" : `#${number}`,
      caption: formatSpeedDisplay(live.speed, live.slowMotion),
      sides: { left: true, right: true },
      bindingMissing: io.isBindingMissing(CAR_CYCLE_BINDING_KEY_LIST),
    };
  },
};
