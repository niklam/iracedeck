/**
 * Replay Control dial — Track Order (#801): iRacing's Next Car / Previous Car
 * binding, one tap per rotate event, whatever its `ticks`. Camera Controls'
 * Track Order rotation, and named after it (stored `track-order`; it was Car
 * until the maintainer's second test round, when nothing had shipped under
 * that value). A rotation mode of the dial surface
 * (`replay-control-dial-mode.ts`). Design:
 * `docs/superpowers/specs/2026-10-12-issue-801-replay-control-dial-stepping.md`
 * ("Car", "The display").
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
 *
 * **The box** (the maintainer's second test round, 2026-10-18) shows the
 * viewed car's number, `#12`, and the numbers of the cars on track behind and
 * ahead of it, as Camera Controls' Car # mode flanks its car — only where the
 * per-car track positions are the replay's own: in a saved replay, and at the
 * live edge of an in-session replay. Scrubbed back in an in-session replay
 * those arrays read the live field (#1281's capture), so there the number
 * shows alone. The neighbours are a preview: iRacing's binding picks the car,
 * and the pace car is a stop of its own (#1277). The shared dash box has no
 * flank slots beside its value, so they are drawn as its caption, behind on
 * the left and ahead on the right; with none the caption is blank rather than
 * absent, so the number keeps the size and place the other modes' value has.
 */
import { getCarNumberFromSessionInfo, type TelemetryData } from "@iracedeck/iracing-sdk";

import { CAR_CYCLE_BINDING_KEY_LIST, CAR_CYCLE_BINDING_KEYS } from "../../shared/car-cycle-bindings.js";
import type { ReplayDialMode, ReplayDialStepIo } from "./replay-control-dial-mode.js";
import { BLANK_CAPTION } from "./replay-control-step-mode.js";
import { NO_CAR_IDX } from "./replay-record-step.js";

/**
 * How far from the end of the tape, in frames, an in-session replay's cursor
 * may sit and still read the live field as its own — 2 s. The same bound as
 * sim-events-iracing's `LIVE_EDGE_MAX_FRAMES` (`diff/replay-record-gate.ts`,
 * #1426), which its package does not export: measured at the edge,
 * `ReplayFrameNumEnd` reads 1, and the nearest scrubbed-back reading measured
 * is 1201.
 */
export const TRACK_ORDER_LIVE_EDGE_MAX_FRAMES = 120;

/** `CarIdxTrackSurface`'s `irsdk_NotInWorld`: a car not on track (in the garage, or not there at all). */
const NOT_IN_WORLD = -1;

/** The gap between the two neighbours in the caption: no-break spaces, which SVG does not collapse. */
const NEIGHBOUR_GAP = "\u00a0".repeat(10);

/** The name a Track Order turn cancels a walk under. */
const CURSOR_OWNER = "dial-track-order";

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

  io.logger.info(`Dial track order: ${describe(direction)}`);
  io.logger.debug(`Dial track order: tapped ${key}, result: ${sent}`);
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
      `Dial track order: tap dropped, the wait for the jump under way failed: ${error instanceof Error ? error.message : String(error)}`,
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
    turn.io.logger.debug(
      `Dial track order: tap dropped, the jump under way did not land within the longest a jump waits`,
    );

    return;
  }

  if (!turn.io.isStillOnScreen()) {
    turn.io.logger.debug(
      "Dial track order: tap dropped, the dial left the screen or the replay was left while it waited",
    );

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
export function _resetTrackOrderTap(): void {
  waiting = null;
  waiter = null;
  waitGeneration++;
}

/**
 * @internal Exported for testing
 *
 * Whether a tap is waiting behind a jump.
 */
export function _isTrackOrderTapWaiting(): boolean {
  return waiting !== null;
}

/** The Car mode. Clockwise is iRacing's Next Car, the car ahead on track; counter-clockwise Previous Car. */
export const trackOrderMode: ReplayDialMode<ReplayDialStepIo> = {
  label: "TRACK ORDER",
  rotateDescription: "Cycle Cars by Track Order",

  rotate(ticks, _dial, io) {
    const direction: CarDirection = ticks > 0 ? "next" : "previous";
    const key = CAR_CYCLE_BINDING_KEYS[direction];

    // `tapBinding` resolves with nothing to say for an unset binding, so check first.
    if (io.isBindingMissing(key)) {
      io.logger.warn("Dial track order: binding not configured, nothing sent");
      io.logger.debug(`Dial track order: direction=${direction}, binding=${key}`);

      return;
    }

    // Stop a walk now, not when the tap goes out: it would keep moving the replay meanwhile.
    io.cancelCameraWalks(CURSOR_OWNER);

    if (waiter !== null) {
      const replaced = waiting?.direction;

      waiting = { direction, io };
      io.logger.debug(
        `Dial track order: ticks=${ticks}; the tap waiting for a jump now goes to the ${describe(direction)}` +
          (replaced === undefined ? "" : ` (was ${describe(replaced)})`),
      );

      return waiter;
    }

    if (!io.isJumpUnderWay()) return tap(io, direction);

    waiting = { direction, io };
    io.logger.debug(
      `Dial track order: ticks=${ticks}; a jump is under way, the ${describe(direction)} tap waits for it`,
    );

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
    const position = io.position();
    const telemetry = io.telemetry();
    const carIdx = telemetry?.CamCarIdx;
    const sessionInfo = io.sessionInfo();
    const number =
      typeof carIdx === "number" && carIdx >= 0 && carIdx !== NO_CAR_IDX
        ? getCarNumberFromSessionInfo(sessionInfo, carIdx)
        : null;

    // A tick read mid-seek is not the replay's: the box keeps the car and the
    // neighbours it showed (null). While a jump is under way the arrays are
    // not the replay's either, so the number shows alone.
    let caption: string | null = null;

    if (position !== null) {
      const flanks =
        number !== null && !position.seeking && trackPositionsTrusted(io, telemetry)
          ? neighbourCaption(telemetry, carIdx as number, sessionInfo)
          : null;

      caption = flanks ?? BLANK_CAPTION;
    }

    return {
      value: position === null ? null : number === null ? "" : `#${number}`,
      caption,
      sides: { left: true, right: true },
      bindingMissing: io.isBindingMissing(CAR_CYCLE_BINDING_KEY_LIST),
    };
  },
};

/**
 * @internal Exported for testing
 *
 * Whether the per-car track positions are the replay's own: in a saved
 * replay always; in an in-session replay only at the live edge, the cursor
 * within {@link TRACK_ORDER_LIVE_EDGE_MAX_FRAMES} of the end of the tape
 * (`ReplayFrameNumEnd`). Scrubbed back further, they read the live field.
 */
export function trackPositionsTrusted(
  io: Pick<ReplayDialStepIo, "isSavedReplay">,
  telemetry: TelemetryData | null,
): boolean {
  if (io.isSavedReplay()) return true;

  const toEnd = telemetry?.ReplayFrameNumEnd;

  return typeof toEnd === "number" && toEnd >= 0 && toEnd <= TRACK_ORDER_LIVE_EDGE_MAX_FRAMES;
}

/**
 * @internal Exported for testing
 *
 * The cars immediately ahead of and behind `carIdx` on track, by
 * `CarIdxLapDistPct` round the lap (wrapping at the line): ahead is the
 * smallest distance forward to another car, behind the smallest distance
 * back. A car counts when `isCandidate` accepts it, it is in the world
 * (`CarIdxTrackSurface` set and not `NotInWorld`) and its lap distance is a
 * fraction of the lap; the camera car must be in the world too. Null either
 * way when there is no other car (with one, it is both), or the camera car is
 * not on track. A tie goes to the lower index.
 */
export function trackOrderNeighbours(
  carIdx: number,
  lapDistPct: readonly number[] | undefined,
  trackSurface: readonly number[] | undefined,
  isCandidate: (idx: number) => boolean = () => true,
): { ahead: number | null; behind: number | null } {
  const onTrack = (idx: number): boolean => {
    const pct = lapDistPct?.[idx];
    const surface = trackSurface?.[idx];

    return typeof pct === "number" && pct >= 0 && pct <= 1 && typeof surface === "number" && surface !== NOT_IN_WORLD;
  };

  if (!lapDistPct || !onTrack(carIdx)) return { ahead: null, behind: null };

  const own = lapDistPct[carIdx];
  let ahead: { idx: number; gap: number } | null = null;
  let behind: { idx: number; gap: number } | null = null;

  for (let idx = 0; idx < lapDistPct.length; idx++) {
    if (idx === carIdx || !onTrack(idx) || !isCandidate(idx)) continue;

    const forward = (((lapDistPct[idx] - own) % 1) + 1) % 1;
    const back = (((own - lapDistPct[idx]) % 1) + 1) % 1;

    if (ahead === null || forward < ahead.gap) ahead = { idx, gap: forward };

    if (behind === null || back < behind.gap) behind = { idx, gap: back };
  }

  return { ahead: ahead?.idx ?? null, behind: behind?.idx ?? null };
}

/**
 * @internal Exported for testing
 *
 * The caption that flanks the car: the number of the car behind on the left
 * and of the car ahead on the right, a gap apart. Only cars with a number in
 * the session info count. Null when there is no other such car on track.
 */
export function neighbourCaption(telemetry: TelemetryData | null, carIdx: number, sessionInfo: unknown): string | null {
  const numberOf = (idx: number): string | null => getCarNumberFromSessionInfo(sessionInfo, idx);
  const { ahead, behind } = trackOrderNeighbours(
    carIdx,
    telemetry?.CarIdxLapDistPct,
    telemetry?.CarIdxTrackSurface,
    (idx) => numberOf(idx) !== null,
  );

  if (ahead === null || behind === null) return null;

  return `#${numberOf(behind)}${NEIGHBOUR_GAP}#${numberOf(ahead)}`;
}
