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
 *   events arrive during a jump the camera moves by one car. A camera key's
 *   press replaces it too, and is replaced by it. It waits for as
 *   long as the jump takes; it is dropped only at the ceiling #1276 puts on
 *   any jump's wait, when the dial that turned it has left the screen, or when
 *   the replay has been left.
 * - **The dial's Jump to My Car gesture is the same kind of switch**
 *   ({@link jumpToMyCarFromDial}): it cancels only the two walks, waits behind
 *   a position jump as the one waiting switch, and replaces a waiting tap or
 *   is replaced by a later turn.
 *
 * The waiting is the engine's one camera-switch waiter since #1467
 * (`@iracedeck/replay-engine`'s `camera-switch-waiter.ts`), which every camera
 * switch of the key and the dial goes through; this mode hands it the tap or
 * the switch, the dial's own jump reads, and the dial's on-screen check.
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
 * shows alone (`replay-car-arrays.ts`, the rule the lap on screen's fallback
 * reads too). The neighbours are a preview: iRacing's binding picks the car,
 * and the pace car is a stop of its own (#1277). They are drawn in the dash
 * box's neighbours slot, dimmed beside the number, behind on the left and
 * ahead on the right. There is no caption, and its line is kept, so the
 * number has the size and place the other stepping modes' value has. The box
 * label is `TRK ORD`: `TRACK ORDER` ran into the side marks on the Stream
 * Dock knob (`labelClearsSideMarks`); the Mode option keeps the full name.
 */
import {
  carInWorld,
  findNearestCarOnTrack,
  getCarNumberFromSessionInfo,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import { NO_CAR_IDX, requestCameraSwitch } from "@iracedeck/replay-engine";

import { CAR_CYCLE_BINDING_KEY_LIST, CAR_CYCLE_BINDING_KEYS } from "../../shared/car-cycle-bindings.js";
import type { DialNeighbours } from "../../shared/dial-box.js";
import { carArraysTrusted } from "./replay-car-arrays.js";
import type { ReplayDialMode, ReplayDialStepIo } from "./replay-control-dial-mode.js";

/**
 * Each session info's car numbers by carIdx, built once per session-info
 * object: the SDK parses a new one on every update, and a view runs every
 * tick, asking for every in-world car's number to find the neighbours.
 */
const carNumbersBySessionInfo = new WeakMap<object, ReadonlyMap<number, string>>();

/** The display number of every car in the session info's driver list, by carIdx; the SDK's lookup, once per car. */
function buildCarNumbers(sessionInfo: object): ReadonlyMap<number, string> {
  const drivers = (sessionInfo as { DriverInfo?: { Drivers?: unknown } }).DriverInfo?.Drivers;
  const numbers = new Map<number, string>();

  if (!Array.isArray(drivers)) return numbers;

  for (const driver of drivers) {
    const carIdx = (driver as { CarIdx?: unknown } | null)?.CarIdx;

    if (typeof carIdx !== "number" || numbers.has(carIdx)) continue;

    const number = getCarNumberFromSessionInfo(sessionInfo, carIdx);

    if (number !== null) numbers.set(carIdx, number);
  }

  return numbers;
}

/** The display number of the car at `carIdx` (`getCarNumberFromSessionInfo`), from the map built for this session info. */
function carNumberOf(sessionInfo: unknown, carIdx: number): string | null {
  if (typeof sessionInfo !== "object" || sessionInfo === null) return null;

  let numbers = carNumbersBySessionInfo.get(sessionInfo);

  if (numbers === undefined) {
    numbers = buildCarNumbers(sessionInfo);
    carNumbersBySessionInfo.set(sessionInfo, numbers);
  }

  return numbers.get(carIdx) ?? null;
}

/** The name a Track Order turn cancels a walk under. */
const CURSOR_OWNER = "dial-track-order";

/** The name the dial's Jump to My Car gesture cancels a walk under. */
const MY_CAR_OWNER = "dial-jump-to-my-car";

type CarDirection = keyof typeof CAR_CYCLE_BINDING_KEYS;

/**
 * A camera switch of the dial's: a Track Order turn's tap to the next or the
 * previous car, or the Jump to My Car gesture's switch to the player's car
 * (#801). Both are camera changes a jump swallows, so they share the one
 * switch that waits behind a jump.
 */
type CameraSwitch = { readonly kind: "car"; readonly direction: CarDirection } | { readonly kind: "my-car" };

/** What a switch is called in the log. */
function describe(change: CameraSwitch): string {
  if (change.kind === "my-car") return "my car";

  return change.direction === "next" ? "next car" : "previous car";
}

/** The name a switch cancels a walk under. */
function ownerOf(change: CameraSwitch): string {
  return change.kind === "my-car" ? MY_CAR_OWNER : CURSOR_OWNER;
}

/** Makes the switch: the car binding's tap, or the switch to the player's car. The waiter has cancelled a walk first. */
async function send(io: ReplayDialStepIo, change: CameraSwitch): Promise<void> {
  if (change.kind === "my-car") {
    io.jumpToMyCar();

    return;
  }

  const key = CAR_CYCLE_BINDING_KEYS[change.direction];
  const sent = await io.tapBinding(key);

  io.logger.info(`Dial track order: ${describe(change)}`);
  io.logger.debug(`Dial track order: tapped ${key}, result: ${sent}`);
}

/**
 * Asks the engine's one camera-switch waiter (`requestCameraSwitch`, #1467)
 * for a switch: made at once on a quiet replay, or behind a position jump
 * under way as the one switch that waits for the whole plugin, key and dial
 * alike. The dial's own jump reads and the check that it is still on screen
 * go with it. Resolves when the switch has gone out or been dropped.
 */
function requestDialCameraSwitch(io: ReplayDialStepIo, change: CameraSwitch, asked: string): Promise<void> {
  return requestCameraSwitch(() => send(io, change), {
    by: ownerOf(change),
    label: "Dial track order",
    name: describe(change),
    asked,
    stillValid: () => io.isStillOnScreen(),
    jumps: { isUnderWay: () => io.isJumpUnderWay(), waitToSettle: () => io.waitForJumpsToSettle() },
    logger: io.logger,
  });
}

/**
 * The dial's Jump to My Car gesture (#801): the camera to the player's car,
 * as a Track Order turn moves it. Only a Jump to Fastest Lap or Jump to Race
 * Start walk is cancelled, never a record jump's run, a marker jump's or the
 * paced search's, and during a position jump the switch waits for it to land
 * — the same one waiting switch a Track Order turn and the camera keys use,
 * so whichever was asked for last goes out. Resolves when the switch has gone
 * out or been dropped.
 */
export function jumpToMyCarFromDial(io: ReplayDialStepIo): Promise<void> {
  return requestDialCameraSwitch(io, { kind: "my-car" }, "Jump to My Car");
}

/** The Track Order mode. Clockwise is iRacing's Next Car, the car ahead on track; counter-clockwise Previous Car. */
export const trackOrderMode: ReplayDialMode<ReplayDialStepIo> = {
  label: "TRK ORD",
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

    return requestDialCameraSwitch(io, { kind: "car", direction }, `ticks=${ticks}`);
  },

  view(_dial, io) {
    const position = io.position();
    const telemetry = io.telemetry();
    const carIdx = telemetry?.CamCarIdx;
    const sessionInfo = io.sessionInfo();
    const number =
      typeof carIdx === "number" && carIdx >= 0 && carIdx !== NO_CAR_IDX ? carNumberOf(sessionInfo, carIdx) : null;

    // A tick read mid-seek is not the replay's: the value is null, and the box
    // keeps the car and the neighbours it showed. While a jump is under way
    // the arrays are not the replay's either, so the number shows alone.
    const neighbours =
      position !== null && number !== null && !position.seeking && carArraysTrusted(io, telemetry)
        ? neighbourNumbers(telemetry, carIdx as number, sessionInfo)
        : null;

    return {
      value: position === null ? null : number === null ? "" : `#${number}`,
      caption: "",
      reserveCaption: true,
      neighbours,
      sides: { left: true, right: true },
      bindingMissing: io.isBindingMissing(CAR_CYCLE_BINDING_KEY_LIST),
    };
  },
};

/**
 * @internal Exported for testing
 *
 * The cars immediately ahead of and behind `carIdx` on track: the SDK's
 * `findNearestCarOnTrack` each way, by `CarIdxLapDistPct` round the lap, over
 * the cars in the world (`carInWorld`) that `isCandidate` accepts. A car at
 * the same lap distance is no neighbour either way (a gap of 0, the SDK's
 * rule), and a tie goes to the lower index. Null either way when there is no
 * other such car (with one, it is both), or the camera car is not in the
 * world: off it, the SDK would fall back to the car nearest the line.
 */
export function trackOrderNeighbours(
  telemetry: TelemetryData | null,
  carIdx: number,
  isCandidate: (idx: number) => boolean = () => true,
): { ahead: number | null; behind: number | null } {
  if (!Array.isArray(telemetry?.CarIdxLapDistPct) || !carInWorld(telemetry)(carIdx)) {
    return { ahead: null, behind: null };
  }

  const options = { skipIdx: (idx: number) => !isCandidate(idx) };

  return {
    ahead: findNearestCarOnTrack(telemetry, carIdx, "ahead", options),
    behind: findNearestCarOnTrack(telemetry, carIdx, "behind", options),
  };
}

/**
 * @internal Exported for testing
 *
 * The numbers that flank the car in the box: the car behind on the left and
 * the car ahead on the right. Only cars with a number in the session info
 * count. Null when there is no other such car on track.
 */
export function neighbourNumbers(
  telemetry: TelemetryData | null,
  carIdx: number,
  sessionInfo: unknown,
): DialNeighbours | null {
  const numberOf = (idx: number): string | null => carNumberOf(sessionInfo, idx);
  const { ahead, behind } = trackOrderNeighbours(telemetry, carIdx, (idx) => numberOf(idx) !== null);

  if (ahead === null || behind === null) return null;

  return { left: `#${numberOf(behind)}`, right: `#${numberOf(ahead)}` };
}
