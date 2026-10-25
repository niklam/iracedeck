/**
 * Replay Control dial — Car # and Position (#1448): Camera Controls' two
 * camera-car modes besides Track Order, drawn in #801's Track Order box. Two
 * rotation modes of the dial surface (`replay-control-dial-mode.ts`), stored
 * `car-number` and `race-position` as in Camera Controls. Design:
 * `docs/superpowers/specs/2026-10-18-issue-1448-replay-dial-camera-car-modes.md`.
 *
 * - **The same targets as Camera Controls'**, shared rather than copied: Car #
 *   walks every car the session has had by car number (`computeCarNumberTarget`
 *   over `getAllCarNumbers(sessionInfo, true, true)`, no pace car, #1281), and
 *   Position walks the race order (`computeRacePositionTarget` over the
 *   canonical live order, the official `CarIdxPosition` as the fallback,
 *   `resolveRaceOrder`, `.claude/rules/race-positions.md`), a car with no
 *   position re-entering at the end. Either way the switch is
 *   `camera.switchNum` to a car NUMBER, never `switchPos`.
 * - **Clockwise lowers the number**, as on Camera Controls' dial (#884, #973):
 *   `#94 → #77`, `P4 → P3`, so a clockwise detent is the walk's `previous`.
 *   There is no `reverseRotation` here.
 * - **One switch per event**, whatever its `ticks`, through the engine's one
 *   camera-switch waiter (`requestCameraSwitch`), as a Track Order turn goes:
 *   it interrupts a lap walk searching on the camera's car (the walk puts the
 *   replay back first, #1428 / #1435) and nothing else, goes out at once on a
 *   quiet replay or behind a search, and waits behind a position jump as the
 *   one switch waiting for the whole plugin, the newest request replacing it.
 *   The target is worked out when the switch goes out, from the camera car
 *   then, so a switch that waited behind a jump steps from the car the jump
 *   left on camera.
 * - **Position trusts the per-car arrays only where they are the replay's own**
 *   (#801's rule, `replay-car-arrays.ts`): in a saved replay, and at the live
 *   edge of an in-session replay. Scrubbed back in an in-session replay the
 *   race order is the live field's, so the box shows `P--` with no
 *   neighbours and a turn sends nothing (the maintainer's decision 3,
 *   2026-10-18); the check is made at the turn and again when the switch goes
 *   out, since a jump the switch waited for may land where the arrays are not
 *   the replay's. Car # needs no trust rule: the car list is the session's.
 *
 * Neither sends a replay command, so neither passes an origin token nor draws
 * anything of #1437's.
 *
 * **The box** is Track Order's: the value in the stepping modes' place (no
 * caption needed, its line kept), the cars one detent either way dimmed
 * beside it, counter-clockwise on the left and clockwise on the right — so the
 * lower number on the right. Car #'s value is the camera car's number (`#12`)
 * with both side marks lit; Position's is the camera car's position (`P4`)
 * with its number as the caption (`#12`) and a side mark lit where a turn that
 * way has a car to go to. The labels are `CAR #` and `POS`: `POSITION` leaves
 * less room than `INCIDENT` beside the side marks on the Stream Dock knob
 * (`labelClearsSideMarks`, 9.8 px against 10.2), so the spec's fallback
 * applies; the Mode options keep the full names.
 */
import { getAllCarNumbers, type TelemetryData } from "@iracedeck/iracing-sdk";
import { requestCameraSwitch } from "@iracedeck/replay-engine";

import { type CarCycleDirection, computeCarNumberTarget } from "../../shared/car-cycling.js";
import type { DialNeighbours } from "../../shared/dial-box.js";
import {
  carNumberRawAtPosition,
  computeRacePositionTarget,
  resolveRaceOrder,
} from "../../shared/race-position-cycling.js";
import { carArraysTrusted } from "./replay-car-arrays.js";
import { cameraCarIdx, carNumberOf } from "./replay-car-numbers.js";
import type { ReplayDialMode, ReplayDialModeView, ReplayDialStepIo } from "./replay-control-dial-mode.js";

/** What Position shows where the race order cannot be trusted, or the camera car has no position. */
const NO_POSITION = "P--";

/**
 * @internal Exported for testing
 *
 * The walk's direction for a turn: clockwise (`ticks > 0`) is `previous`, the
 * lower number on the box (#884, #973), as on Camera Controls' dial.
 */
export function carStepDirection(ticks: number): CarCycleDirection {
  return ticks > 0 ? "previous" : "next";
}

/** The box's neighbours from the walk's two targets: counter-clockwise (`next`) left, clockwise (`previous`) right. */
function sidesOf<T>(next: T, previous: T): { left: T; right: T } {
  return { left: next, right: previous };
}

/** What a mode tells the waiter about one of its switches. */
interface CarStep {
  /** The name it interrupts a walk under. */
  readonly by: string;
  /** The log prefix. */
  readonly label: string;
  /** The switch, in the log. */
  readonly name: string;
  /** The turn that asked, in the log. */
  readonly asked: string;
}

/**
 * Asks the engine's one camera-switch waiter for the switch `send` makes, as
 * a Track Order turn does: the dial's own jump reads and its on-screen check
 * go with it. Resolves when the switch has gone out or been dropped.
 */
function requestCarStep(io: ReplayDialStepIo, step: CarStep, send: () => void): Promise<void> {
  return requestCameraSwitch(send, {
    by: step.by,
    label: step.label,
    name: step.name,
    asked: step.asked,
    surface: "the dial",
    stillValid: () => io.isStillOnScreen(),
    jumps: { isUnderWay: () => io.isJumpUnderWay(), waitToSettle: () => io.waitForJumpsToSettle() },
    logger: io.logger,
  });
}

/** The switch to `carNumberRaw`, logged under `label`. */
function switchTo(io: ReplayDialStepIo, label: string, name: string, carNumberRaw: number): void {
  const sent = io.switchToCarNumber(carNumberRaw);

  io.logger.info(`${label}: ${name}`);
  io.logger.debug(`${label}: switchNum ${carNumberRaw}, result: ${sent}`);
}

/** The Car # log prefix and walk owner. */
const CAR_NUMBER_LABEL = "Dial car number";
const CAR_NUMBER_OWNER = "dial-car-number";

/** The Position log prefix and walk owner. */
const POSITION_LABEL = "Dial position";
const POSITION_OWNER = "dial-race-position";

/** Car # (`car-number`): the camera to the next or previous car by number. */
export const carNumberMode: ReplayDialMode<ReplayDialStepIo> = {
  label: "CAR #",
  rotateDescription: "Cycle Cars by Number",

  rotate(ticks, _dial, io) {
    const direction = carStepDirection(ticks);
    const name = `${direction} car by number`;

    return requestCarStep(io, { by: CAR_NUMBER_OWNER, label: CAR_NUMBER_LABEL, name, asked: `ticks=${ticks}` }, () => {
      // From the camera car when the switch goes out, not at the turn.
      const camCarIdx = cameraCarIdx(io.telemetry());
      const target = computeCarNumberTarget(camCarIdx, getAllCarNumbers(io.sessionInfo(), true, true), direction);

      if (target === null) {
        io.logger.debug(`${CAR_NUMBER_LABEL}: no other car to switch to, nothing sent (camera car ${camCarIdx})`);

        return;
      }

      switchTo(io, CAR_NUMBER_LABEL, name, target.carNumberRaw);
    });
  },

  view(_dial, io) {
    const position = io.position();
    const telemetry = io.telemetry();
    const camCarIdx = cameraCarIdx(telemetry);
    const sessionInfo = io.sessionInfo();
    const number = camCarIdx === undefined ? null : carNumberOf(sessionInfo, camCarIdx);

    return {
      // A tick read mid-seek is not the replay's: the box keeps what it showed.
      value: position === null ? null : number === null ? "" : `#${number}`,
      caption: "",
      reserveCaption: true,
      neighbours: position === null ? null : carNumberNeighbours(camCarIdx, sessionInfo),
      sides: { left: true, right: true },
    };
  },
};

/**
 * @internal Exported for testing
 *
 * The car numbers one detent either way of the camera car, as the walk lands
 * on them: the higher number on the left (counter-clockwise), the lower on the
 * right (clockwise). Null with no other car to go to.
 */
export function carNumberNeighbours(camCarIdx: number | undefined, sessionInfo: unknown): DialNeighbours | null {
  const cars = getAllCarNumbers(sessionInfo, true, true);
  const next = computeCarNumberTarget(camCarIdx, cars, "next");
  const previous = computeCarNumberTarget(camCarIdx, cars, "previous");

  if (next === null || previous === null) return null;

  return sidesOf(`#${next.carNumber}`, `#${previous.carNumber}`);
}

/** The race order now: the canonical one, official `CarIdxPosition` as the fallback. */
function raceOrder(io: ReplayDialStepIo, telemetry: TelemetryData | null): number[] | null {
  return resolveRaceOrder(io.racePositions(), telemetry?.CarIdxPosition);
}

/** Position (`race-position`): the camera to the next or previous car in the race order. */
export const racePositionMode: ReplayDialMode<ReplayDialStepIo> = {
  label: "POS",
  rotateDescription: "Cycle Cars by Position",

  rotate(ticks, _dial, io) {
    const direction = carStepDirection(ticks);
    const name = `${direction} car by position`;
    const position = io.position();

    // Asked where nothing is under way, the reading says whether the order is
    // the replay's: where it is not, nothing is asked of the waiter, so no
    // walk is interrupted for a turn that would send nothing. Behind a jump
    // the send decides, once it has landed.
    if (position !== null && !position.seeking && !io.isJumpUnderWay() && !carArraysTrusted(io, io.telemetry())) {
      io.logger.debug(`${POSITION_LABEL}: the race order is not the replay's here, nothing sent (ticks=${ticks})`);

      return;
    }

    return requestCarStep(io, { by: POSITION_OWNER, label: POSITION_LABEL, name, asked: `ticks=${ticks}` }, () => {
      const telemetry = io.telemetry();

      if (!carArraysTrusted(io, telemetry)) {
        io.logger.debug(`${POSITION_LABEL}: the race order is not the replay's where the replay landed, nothing sent`);

        return;
      }

      // From the camera car when the switch goes out, not at the turn.
      const camCarIdx = cameraCarIdx(telemetry);
      const order = raceOrder(io, telemetry);
      const target = computeRacePositionTarget(camCarIdx, order, direction);
      const carNumberRaw =
        target === null || order === null
          ? null
          : carNumberRawAtPosition(order, io.sessionInfo(), target.targetPosition);

      if (target === null || carNumberRaw === null) {
        io.logger.debug(`${POSITION_LABEL}: no car to switch to, nothing sent (camera car ${camCarIdx})`);

        return;
      }

      switchTo(io, POSITION_LABEL, `${name}, P${target.targetPosition}`, carNumberRaw);
    });
  },

  view(_dial, io): ReplayDialModeView {
    const position = io.position();
    const telemetry = io.telemetry();

    // A tick read mid-seek, or a jump under way: the arrays are not the
    // replay's, and the box keeps the position, its car and its neighbours.
    if (position === null || position.seeking) {
      return { value: null, caption: null, reserveCaption: true, sides: { left: false, right: false } };
    }

    const camCarIdx = cameraCarIdx(telemetry);
    const number = camCarIdx === undefined ? null : carNumberOf(io.sessionInfo(), camCarIdx);
    const caption = number === null ? "" : `#${number}`;

    if (!carArraysTrusted(io, telemetry)) {
      return {
        value: NO_POSITION,
        caption,
        reserveCaption: true,
        neighbours: null,
        sides: { left: false, right: false },
      };
    }

    const order = raceOrder(io, telemetry);
    const next = computeRacePositionTarget(camCarIdx, order, "next");
    const previous = computeRacePositionTarget(camCarIdx, order, "previous");
    const current = next?.currentPosition ?? previous?.currentPosition ?? null;
    const sides = sidesOf(next !== null, previous !== null);

    return {
      value: current === null ? NO_POSITION : `P${current}`,
      caption,
      reserveCaption: true,
      neighbours:
        next === null || previous === null ? null : sidesOf(`P${next.targetPosition}`, `P${previous.targetPosition}`),
      sides,
    };
  },
};
