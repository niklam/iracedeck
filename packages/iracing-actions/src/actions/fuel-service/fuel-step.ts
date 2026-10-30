/**
 * Fuel Service — the fuel step check (issue #1314).
 *
 * iRacing banks a requested fuel amount on a car-specific grid: the MX-5 banks
 * whole US gallons (3.785 L), the Porsche 911 GT3 whole liters, and nothing in
 * session info or telemetry says which. A request smaller than half the car's
 * step rounds straight back to where it was, so an Add / Reduce press would do
 * nothing. Rather than a per-car table, every stepping press is checked:
 *
 * - after a send, `PitSvFuel` is watched for up to {@link FUEL_STEP_WATCH_MS};
 *   once it moves in the press's direction the press is done;
 * - when it does not move, the next whole liter further in the same direction
 *   is sent and watched again, up to {@link FUEL_STEP_MAX_EXTRA_LTR} past the
 *   press's own request, after which the check stops and logs at info (tank
 *   full, request at zero, or the car is not in a pit-service state);
 * - the smallest move that is known to land is remembered per car (the
 *   player's `CarPath`) and direction for the plugin's lifetime, and a later
 *   press whose own move is smaller is bumped up to it, so it lands on its
 *   first send — while a press larger than the car's step goes out unchanged
 *   (see {@link FuelStepper} for how the memory is kept);
 * - a press arriving while a check runs is queued one deep, the newest
 *   replacing an older queued one, and runs from the new baseline once the
 *   running check ends — a held key on a gallon car steps one gallon per check
 *   instead of restarting a check that never finishes;
 * - any other command sent through the {@link FuelPipeline} (a Clear Fuel or
 *   Set Fuel Amount press, a dial gesture, the fill-to monitor's clear) cancels
 *   the running check and the queued press, so a later escalation cannot undo it.
 *
 * A step completes by one of two rules, chosen by the request's form
 * ({@link FuelStepRequest}):
 *
 * - **the move rule** (Add / Reduce Fuel, the dial's Add Amount): done once
 *   `PitSvFuel` moves in the press's direction;
 * - **the floor rule** (the dial's Target Amount, #1483): the request is a
 *   floor, the least the stop must add, and the step is done once `PitSvFuel`
 *   is at or above it. Fill To rounds its add up so a stop never finishes
 *   under target, and a car whose step is coarser than a liter would otherwise
 *   round that add back down to the grid point below. The stepper picks the
 *   first request itself from the car's learned step, and escalates a whole
 *   liter at a time while the bank stays short, bounded as above.
 *
 * The car's fuel step itself (one grid point: 3.785 L on the MX-5, 1 L on the
 * Porsche) is learned per `CarPath` from steps that landed exactly one grid
 * point away, and is what the floor rule's first request and the dial's
 * fill-to monitor use (see {@link FuelStepper}).
 *
 * One instance per FuelService action, shared by the keypad's Add / Reduce Fuel
 * and the dial's Add Amount and Target Amount sends: all drive the same single
 * pit request. Specs: `docs/superpowers/specs/2026-10-18-issue-1314-fuel-step-per-car.md`,
 * `docs/superpowers/specs/2026-10-25-issue-1483-fill-to-fuel-step.md`.
 */
import type { SessionInfo, TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";

import type { FuelPipeline } from "./fuel-pipeline.js";

/**
 * @internal Exported for testing
 *
 * How long one send is watched for `PitSvFuel` to move. Telemetry runs at 60 Hz
 * and iRacing reflects a pit command within a tick or two, so this is generous.
 */
export const FUEL_STEP_WATCH_MS = 300;

/**
 * @internal Exported for testing
 *
 * How often `PitSvFuel` is re-read while a send is watched (about one tick).
 */
export const FUEL_STEP_POLL_MS = 20;

/**
 * @internal Exported for testing
 *
 * How far past the press's own request the check steps before it gives up: a
 * little over two gallons, room for a coarser step than the MX-5's.
 */
export const FUEL_STEP_MAX_EXTRA_LTR = 8;

/** A `PitSvFuel` change smaller than this is float noise, not a move. */
const MOVE_EPSILON_LTR = 0.01;

/**
 * An escalated landing this close to the PREVIOUS send is that send showing up
 * late, not the escalated one landing (see the class comment).
 */
const LATE_REFLECTION_LTR = 0.5;

/**
 * The smallest move learned as a car's fuel step: a whole-liter car's step is
 * 1 L, so anything clearly below it is float noise or a capped bank, not a step.
 */
const FUEL_STEP_MIN_LTR = 0.9;

/**
 * A step that landed on its FIRST send is learned as one grid point only when
 * it moved less than this: a whole-liter request cannot resolve a finer grid,
 * so a move under 1.5 L is one whole-liter step, while a larger first-send move
 * may span several grid points (a first Fill To send from 0 to 46 L on a
 * whole-liter car is 46 steps, not one). See the class comment.
 */
const ONE_STEP_FIRST_SEND_MAX_LTR = 1.5;

/** Which way a press moves the pit fuel request. */
export type FuelStepDirection = "add" | "reduce";

/**
 * A move request (the move rule): the request should move away from the
 * baseline in `direction`.
 */
export interface FuelStepMoveRequest {
  /**
   * Which way the request should move, or `null` to send `firstLtr` once with no
   * check (the dial's request already equals the banked amount, but a rotation
   * still arms fueling).
   */
  direction: FuelStepDirection | null;
  /**
   * The press's own request in liters, before any bump to the learned minimum
   * move or escalation. The stepper rounds it to whole liters itself (see
   * {@link FuelStepper}), so a caller may hand over a fractional value.
   */
  firstLtr: number;
}

/**
 * A floor request (the floor rule, #1483): the stop must add at least
 * `floorLtr` liters. The stepper picks the first whole-liter request itself,
 * from the car's learned fuel step, and escalates while the bank stays below
 * the floor. A floor at or below zero asks for nothing (`skipped`).
 */
export interface FuelStepFloorRequest {
  floorLtr: number;
}

/**
 * What a press asks for, resolved from the `PitSvFuel` baseline when its check
 * STARTS — a queued press must run from the baseline the previous check left.
 */
export type FuelStepRequest = FuelStepMoveRequest | FuelStepFloorRequest;

/**
 * How a step ended.
 *
 * - `landed` — the move rule: `PitSvFuel` moved in the press's direction. The
 *   floor rule: `PitSvFuel` is at or above the floor — at once when it differs
 *   from the baseline, or, when it still equals a baseline already at or above
 *   the floor, once the watch has expired (the send may not have shown yet).
 * - `unmoved` — the move rule: nothing moved up to {@link FUEL_STEP_MAX_EXTRA_LTR}
 *   past the request. The floor rule: the bank stayed below the floor that far.
 * - `emptied` — the request reached zero, so the request was emptied instead (see {@link FuelStepper}).
 * - `unchecked` — sent once without a check (`direction: null`, or `PitSvFuel` unreadable).
 * - `skipped` — the resolver asked for nothing (or a floor at or below zero).
 * - `superseded` — a newer press replaced this one in the queue before it ran.
 * - `cancelled` — another fuel command took over the request.
 */
export type FuelStepOutcome = "landed" | "unmoved" | "emptied" | "unchecked" | "skipped" | "superseded" | "cancelled";

export interface FuelStepResult {
  outcome: FuelStepOutcome;
  /** `PitSvFuel` when the step started (liters); undefined when it never started. */
  baselineLtr?: number;
  /** The floor of a floor request (liters); undefined for a move request or a step that never resolved. */
  floorLtr?: number;
  /**
   * The press's own request (for a floor request, the first request the stepper
   * chose); undefined when the step never resolved one.
   */
  firstLtr?: number;
  /** The last request actually sent (liters); undefined when nothing was sent. */
  sentLtr?: number;
  /** Whole liters sent beyond the press's own request (the bump to the learned minimum move included). */
  extraLtr: number;
  /** `PitSvFuel` when the step ended; undefined when unreadable or the step never started. */
  endLtr?: number;
}

/** Resolves a press against the baseline its check starts from; `null` sends nothing. */
export type FuelStepResolver = (baselineLtr: number) => FuelStepRequest | null;

/**
 * Called once when a step ends, BEFORE a queued press starts. Commands it sends
 * (the keypad's preserve-off clear) belong to the step and cancel nothing.
 */
export type FuelStepEndHandler = (result: FuelStepResult) => void;

/** What the stepper reads from the owning action. */
export interface FuelStepHost {
  readonly logger: ILogger;
  getTelemetry(): TelemetryData | null;
  getSessionInfo(): SessionInfo | null;
}

/** A press waiting in the queue, or the one whose check is running. */
interface PendingStep {
  resolve: FuelStepResolver;
  onEnd?: FuelStepEndHandler;
  done: (result: FuelStepResult) => void;
}

/** The running check. */
interface RunningStep extends PendingStep {
  direction: FuelStepDirection;
  /** The floor of a floor request (the floor rule), or null for the move rule. */
  floorLtr: number | null;
  baselineLtr: number;
  firstLtr: number;
  /** The player's car, the key the learned fuel step is kept under; null when unknown. */
  carPath: string | null;
  /**
   * The minimum-move memory key (`<CarPath>|<direction>`), or null when the car
   * is unknown or the step follows the floor rule (which never uses it).
   */
  memoryKey: string | null;
  /** The last `PitSvFuel` read while watching (the baseline until a read). */
  lastReadingLtr: number;
  /** {@link lastReadingLtr} when the current send went out: what the previous send left banked. */
  readingBeforeSendLtr: number;
  /**
   * The distinct readings other than {@link readingBeforeSendLtr} seen while
   * watching the current send. More than the landing itself means an earlier
   * send showed late (see `learnStep`).
   */
  readingsSinceSendLtr: number[];
  /** Whole liters the first send was bumped by to reach the learned minimum move. */
  bumpLtr: number;
  /** The send before the current one, or null while only one has gone out. */
  previousSentLtr: number | null;
  /** How many sends this step has made. */
  sends: number;
  extraLtr: number;
  sentLtr: number;
  /** Milliseconds the current send has been watched. */
  watchedMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Reads `PitSvFuel` (the requested pit fuel add, liters) from telemetry, or
 * undefined when unavailable. The one reader both Fuel Service surfaces use:
 * it lives here, the leaf of the fuel modules, so the dial surface can import
 * it without a cycle.
 */
export function readPitSvFuel(telemetry: TelemetryData | null): number | undefined {
  const value = telemetry?.PitSvFuel;

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The player's car path (`DriverInfo.Drivers[DriverCarIdx].CarPath`, e.g.
 * `"mx5 mx52016"`), the key the minimum moves and the fuel step are remembered
 * under — also read by the dial's fill-to monitor to look up the learned step
 * (#1483). Null when session info does not name it.
 */
export function readPlayerCarPath(sessionInfo: SessionInfo | null): string | null {
  const driverInfo = (sessionInfo as Record<string, unknown> | null)?.DriverInfo as Record<string, unknown> | undefined;
  const carIdx = driverInfo?.DriverCarIdx;
  const drivers = driverInfo?.Drivers;

  if (typeof carIdx !== "number" || !Array.isArray(drivers)) return null;

  const player = drivers.find(
    (driver): driver is Record<string, unknown> =>
      typeof driver === "object" && driver !== null && (driver as Record<string, unknown>).CarIdx === carIdx,
  );
  const carPath = player?.CarPath;

  return typeof carPath === "string" && carPath.length > 0 ? carPath : null;
}

/**
 * @internal Exported for testing
 *
 * The floor rule's first whole-liter request for a floor (#1483). With the
 * car's fuel step known it is the whole liter nearest the smallest grid point
 * at or above the floor — iRacing rounds a request to the nearest grid point,
 * so that liter banks that point — and never less than the floor rounded up.
 * With the step unknown it is the floor rounded up, which on a whole-liter car
 * already banks the floor. The epsilon keeps float noise (5.0000000001) from
 * costing a whole liter or a whole grid point.
 */
export function floorFirstRequestLtr(floorLtr: number, stepLtr: number | undefined): number {
  const atLeastLtr = Math.max(1, Math.ceil(floorLtr - MOVE_EPSILON_LTR));

  if (stepLtr === undefined || !(stepLtr > 0)) return atLeastLtr;

  const gridPoints = Math.ceil((floorLtr - MOVE_EPSILON_LTR) / stepLtr);

  return Math.max(atLeastLtr, Math.round(gridPoints * stepLtr));
}

/**
 * The fuel step check: sends a stepping press through the {@link FuelPipeline},
 * reads `PitSvFuel` back, and steps further until the request moves. See the
 * module comment for the rules.
 *
 * **Every request is a whole number of liters.** The broadcast carries an
 * integer and the native layer truncates whatever it is given, so the stepper
 * rounds the press's own request (`Math.round`) before anything else, and
 * every send, `sentLtr` and the learned move are that integer plus whole
 * liters. Measuring a fractional request the sim never saw would read a
 * truncation as "did not land" and learn a move the car does not need: a
 * 0.5 L dial detent from 10 L once went out as 10.5 (banked 10), escalated
 * to 11.5 (banked 11) and taught a 1.5 L minimum, so a later 1 L key press
 * added 2 L.
 *
 * **A request at or below zero is never sent as `pit.fuel`.** `pit.fuel(0)` means
 * "keep the existing amount", so a request that would reach zero (a reduce
 * press, or a reduce escalation stepping past the last whole step) goes through
 * {@link FuelPipeline.sendNoFuel} instead (1 L then clear) and the step ends
 * there as `emptied`. A reduce that LANDS at zero (a gallon car banks
 * `pit.fuel(1)` as 0 gal) is followed by the clear and ends `emptied` too, so
 * every car leaves the same state: zero is the floor, there is nothing further to step to,
 * and the clear leaves fueling off — the state the keypad's reduce-to-zero
 * has always left.
 *
 * **The learned minimum move.** What a car needs is a distance from the
 * baseline, not an amount of extra liters: on the MX-5 a request lands once it
 * is past half a gallon from where the request stands, whatever the key's
 * amount. So the memory is the move `|sent − baseline|`, and a press's first
 * request moves by `max(its own move, the minimum)` — its own request plus
 * the whole liters that reach the minimum. A 1 L press on the MX-5 goes out
 * as about 3 L; a 5 L press goes out as plain `round(baseline ± 5)`. The check
 * still escalates whenever a send does not land.
 *
 * How the minimum is kept, so it cannot ratchet upward:
 *
 * - It is SET (replaced, never maxed) only by a press that landed after
 *   escalating. That is the one tight evidence there is: the same press's
 *   send one liter shorter, from the same baseline, did not land, so the
 *   landing move is what this car needed from that point on its grid.
 * - A press that lands on its first send only shows that its move suffices,
 *   and lowers the minimum when that move is smaller. With the bump, a first
 *   send moves at least the minimum (to within the float epsilon), so this
 *   rarely changes anything: nothing probes below the minimum. That is
 *   accepted because the minimum is bounded, as below.
 * - It therefore only grows when a bumped send genuinely failed, and settles
 *   at the largest move any baseline on the car's grid needs — about half a
 *   step plus one liter of whole-liter rounding (≈ 2.9 L on the MX-5), well
 *   under one step, so a bumped press never skips a step.
 * - A late reflection teaches nothing. If iRacing shows a send later than the
 *   watch, the check escalates and then "lands" on the EARLIER send's effect;
 *   learning that escalated move would be permanent, since a bumped first send
 *   always moves at least the minimum and nothing would ever lower it again
 *   (every later 1 L press on a liter car would add 2 L until a restart). So
 *   an escalated landing whose `PitSvFuel` sits within
 *   {@link LATE_REFLECTION_LTR} of the previous send — the one declared
 *   unmoved — is not learned from. It cannot misfire on a real grid: a send
 *   that rounded back sits within half a step of the baseline, and a true
 *   landing is a full step from the baseline, so on any grid whose step is
 *   larger than 1 L the landing is at least half a step from that send.
 * - A press that never moved (`unmoved`), was emptied, or was not checked
 *   teaches nothing.
 *
 * **The floor rule (#1483).** A floor request is done once `PitSvFuel` is at or
 * above the floor. A reading at the floor that differs from the baseline ends
 * the step at once; one that still EQUALS the baseline ends it only when the
 * watch expires, because the send may not show yet — lowering a target from
 * 11.35 L to a 3.5 L floor sends 4, and `PitSvFuel` reads 11.35 for a tick
 * before 3.785 shows. A reading below the floor is never done: at the watch's
 * end the next whole liter up is sent, bounded by {@link FUEL_STEP_MAX_EXTRA_LTR}
 * like the move rule, ending `unmoved`. The first request is
 * {@link floorFirstRequestLtr}: with the car's step known it already banks the
 * smallest grid point at or above the floor, so the check confirms on its first
 * read. A floor step is never bumped to the learned minimum move, and never
 * reads or writes it: that memory is a distance from the baseline, which the
 * floor rule does not measure.
 *
 * **The learned fuel step.** One grid point of the car, kept per `CarPath` for
 * the plugin's lifetime as the SMALLEST evidence seen ({@link fuelStepFor}).
 * Only a step that landed, of either rule and direction, is evidence, and only
 * where the move is known to span exactly one grid point:
 *
 * - an escalated landing: the request one liter short banked the previous
 *   reading, and iRacing rounds to the nearest grid point, so two requests a
 *   liter apart bank the same or ADJACENT grid points — the landing minus the
 *   reading the previous send left is one step. A send that shows only after
 *   its watch makes that reading stale, so such a landing is excluded — by the
 *   minimum move's guard, by an intermediate reading, or by readings that are
 *   inconsistent with a grid of the claimed step (`adjacentLanding`);
 * - a first-send landing that moved less than {@link ONE_STEP_FIRST_SEND_MAX_LTR}:
 *   a whole-liter car's 1 L step. A larger first-send move is not evidence: it
 *   may span several grid points, and a multiple learned as the step would make
 *   every later floor request overshoot by it.
 *
 * Moves under {@link FUEL_STEP_MIN_LTR} teach nothing. A capped bank (a tank
 * whose capacity is not a grid point) can still teach a step that is too small;
 * that only costs extra escalations, since every floor step is checked.
 */
export class FuelStepper {
  /** The smallest move (liters from the baseline) known to land, by `<CarPath>|<direction>`. */
  private readonly minimumMoves = new Map<string, number>();
  /** The car's learned fuel step (liters, one grid point), by `CarPath` (#1483). */
  private readonly fuelSteps = new Map<string, number>();
  private running: RunningStep | null = null;
  private queued: PendingStep | null = null;
  /** True while the stepper itself sends, so its own commands cancel nothing. */
  private ownCommand = false;

  constructor(
    private readonly host: FuelStepHost,
    private readonly pipeline: FuelPipeline,
  ) {
    this.pipeline.setCommandListener(() => {
      if (!this.ownCommand) this.cancel();
    });
  }

  /** Whether a check is running (a press now would be queued). */
  get busy(): boolean {
    return this.running !== null;
  }

  /**
   * @internal Exported for testing
   *
   * The learned minimum move (liters) for a car and direction (0 when none).
   */
  minimumMoveFor(carPath: string, direction: FuelStepDirection): number {
    return this.minimumMoves.get(`${carPath}|${direction}`) ?? 0;
  }

  /**
   * The car's learned fuel step (liters, one grid point), or undefined while
   * none is known (#1483). The floor rule's first request uses it, and so does
   * the dial's fill-to monitor, to tell a bank a whole step above the need.
   */
  fuelStepFor(carPath: string): number | undefined {
    return this.fuelSteps.get(carPath);
  }

  /**
   * Sends one stepping press. The first command goes out synchronously when no
   * check is running; otherwise the press waits in the one-deep queue. The
   * promise resolves when the press's step ends, however it ends.
   */
  sendFuelStep(resolve: FuelStepResolver, onEnd?: FuelStepEndHandler): Promise<FuelStepResult> {
    return new Promise((done) => {
      const step: PendingStep = { resolve, onEnd, done };

      if (this.running) {
        const replaced = this.queued;
        this.queued = step;

        if (replaced) {
          this.host.logger.debug("Fuel step: a newer press replaced the queued one");
          this.finishPending(replaced, "superseded");
        } else {
          this.host.logger.debug("Fuel step: press queued behind the running check");
        }

        return;
      }

      this.start(step);
    });
  }

  /**
   * Ends the running check and drops the queued press: another fuel command now
   * owns the request. Called through the pipeline's command listener.
   */
  cancel(): void {
    const queued = this.queued;
    const running = this.running;
    this.queued = null;

    if (queued) this.finishPending(queued, "cancelled");

    if (running) {
      this.host.logger.debug("Fuel step: cancelled by another fuel command");
      this.end(running, "cancelled", readPitSvFuel(this.host.getTelemetry()), false);
    }
  }

  private start(step: PendingStep): void {
    const baselineLtr = readPitSvFuel(this.host.getTelemetry());
    const request = step.resolve(baselineLtr ?? 0);

    if (!request) {
      this.finishStarted(step, { outcome: "skipped", baselineLtr, extraLtr: 0, endLtr: baselineLtr });

      return;
    }

    if ("floorLtr" in request) {
      this.startFloor(step, request.floorLtr, baselineLtr);

      return;
    }

    const { direction } = request;
    const firstLtr = Math.round(request.firstLtr);

    // No direction to check, or no baseline to check against: send once, as
    // before #1314. An empty request still goes through the empty path.
    if (direction === null || baselineLtr === undefined) {
      if (firstLtr <= 0) {
        this.own(() => this.pipeline.sendNoFuel());
        this.finishStarted(step, { outcome: "emptied", baselineLtr, firstLtr, sentLtr: firstLtr, extraLtr: 0 });

        return;
      }

      this.own(() => this.pipeline.fuel(firstLtr));
      this.finishStarted(step, {
        outcome: "unchecked",
        baselineLtr,
        firstLtr,
        sentLtr: firstLtr,
        extraLtr: 0,
        endLtr: baselineLtr,
      });

      return;
    }

    const carPath = readPlayerCarPath(this.host.getSessionInfo());
    const memoryKey = carPath === null ? null : `${carPath}|${direction}`;
    const minimumMoveLtr = memoryKey === null ? 0 : (this.minimumMoves.get(memoryKey) ?? 0);
    const ownMoveLtr = Math.abs(firstLtr - baselineLtr);
    // The whole liters that bring the press's own move up to the learned
    // minimum; 0 for a press that already moves far enough. The epsilon keeps
    // float noise (3.0000000001) from costing a whole extra liter.
    const bumpLtr = Math.max(0, Math.ceil(minimumMoveLtr - ownMoveLtr - MOVE_EPSILON_LTR));
    const run: RunningStep = {
      ...step,
      direction,
      floorLtr: null,
      baselineLtr,
      firstLtr,
      carPath,
      memoryKey,
      lastReadingLtr: baselineLtr,
      readingBeforeSendLtr: baselineLtr,
      readingsSinceSendLtr: [],
      bumpLtr,
      previousSentLtr: null,
      sends: 0,
      extraLtr: bumpLtr,
      sentLtr: firstLtr,
      watchedMs: 0,
      timer: null,
    };

    this.running = run;

    if (bumpLtr > 0) {
      this.host.logger.debug(
        `Fuel step: starting ${bumpLtr} L past the request to move ${minimumMoveLtr.toFixed(2)}L (learned for ${carPath})`,
      );
    }

    this.send(run);
  }

  /**
   * Starts a floor request (the floor rule, #1483): the first request comes from
   * the car's learned step ({@link floorFirstRequestLtr}), never from the
   * minimum-move memory. An unreadable baseline sends it once, unchecked, as
   * the move rule does.
   */
  private startFloor(step: PendingStep, floorLtr: number, baselineLtr: number | undefined): void {
    if (!(floorLtr > MOVE_EPSILON_LTR)) {
      this.finishStarted(step, { outcome: "skipped", baselineLtr, floorLtr, extraLtr: 0, endLtr: baselineLtr });

      return;
    }

    const carPath = readPlayerCarPath(this.host.getSessionInfo());
    const stepLtr = carPath === null ? undefined : this.fuelSteps.get(carPath);
    const firstLtr = floorFirstRequestLtr(floorLtr, stepLtr);

    if (baselineLtr === undefined) {
      this.own(() => this.pipeline.fuel(firstLtr));
      this.finishStarted(step, {
        outcome: "unchecked",
        baselineLtr,
        floorLtr,
        firstLtr,
        sentLtr: firstLtr,
        extraLtr: 0,
      });

      return;
    }

    const run: RunningStep = {
      ...step,
      direction: "add",
      floorLtr,
      baselineLtr,
      firstLtr,
      carPath,
      memoryKey: null,
      lastReadingLtr: baselineLtr,
      readingBeforeSendLtr: baselineLtr,
      readingsSinceSendLtr: [],
      bumpLtr: 0,
      previousSentLtr: null,
      sends: 0,
      extraLtr: 0,
      sentLtr: firstLtr,
      watchedMs: 0,
      timer: null,
    };

    this.running = run;
    this.host.logger.debug(
      `Fuel step: floor ${floorLtr.toFixed(2)}L from ${baselineLtr.toFixed(2)}L, first request ${firstLtr} L (step ${stepLtr === undefined ? "unknown" : `${stepLtr.toFixed(2)}L`})`,
    );
    this.send(run);
  }

  /** Sends the run's current request (its own request plus `extraLtr`) and starts watching it. */
  private send(run: RunningStep): void {
    const liters = run.direction === "add" ? run.firstLtr + run.extraLtr : run.firstLtr - run.extraLtr;
    run.previousSentLtr = run.sends > 0 ? run.sentLtr : null;
    run.readingBeforeSendLtr = run.lastReadingLtr;
    run.readingsSinceSendLtr = [];
    run.sends += 1;
    run.sentLtr = liters;

    if (liters <= 0) {
      this.own(() => this.pipeline.sendNoFuel());
      this.host.logger.debug(`Fuel step: request ${liters.toFixed(2)}L reached zero — emptied it instead`);
      this.end(run, "emptied", undefined, true);

      return;
    }

    this.own(() => this.pipeline.fuel(liters));
    run.watchedMs = 0;
    this.check(run);
  }

  /**
   * Reads `PitSvFuel` back: done when the run's rule is met (it moved, or it
   * reached the floor), otherwise watch on, step further or give up.
   */
  private check(run: RunningStep): void {
    run.timer = null;

    if (this.running !== run) return;

    const nowLtr = readPitSvFuel(this.host.getTelemetry());

    if (nowLtr !== undefined) this.observe(run, nowLtr);

    if (run.floorLtr !== null) {
      if (this.reachedFloor(run, run.floorLtr, nowLtr)) {
        if (run.extraLtr > 0) {
          this.host.logger.debug(
            `Fuel step: reached the ${run.floorLtr.toFixed(2)}L floor at ${nowLtr?.toFixed(2)}L, ${run.extraLtr} L past the request ${run.firstLtr} L`,
          );
        }

        this.end(run, "landed", nowLtr, true);

        return;
      }
    } else if (nowLtr !== undefined && this.moved(run, nowLtr)) {
      this.learn(run, nowLtr);

      if (run.extraLtr > 0) {
        this.host.logger.debug(
          `Fuel step: landed at ${nowLtr.toFixed(2)}L, ${run.extraLtr} L past the request ${run.firstLtr.toFixed(2)}L`,
        );
      }

      // A reduce that lands at zero (on the MX-5, `pit.fuel(1)` banks 0 gal) is
      // the empty request: clear the box too, as `sendNoFuel` does on a car
      // whose reduce reaches zero by request, so both leave fueling off.
      if (run.direction === "reduce" && nowLtr <= MOVE_EPSILON_LTR) {
        this.own(() => this.pipeline.clearFuel());
        this.host.logger.debug("Fuel step: reduce landed at zero — cleared fueling");
        this.end(run, "emptied", nowLtr, true);

        return;
      }

      this.end(run, "landed", nowLtr, true);

      return;
    }

    if (run.watchedMs >= FUEL_STEP_WATCH_MS) {
      if (run.extraLtr >= FUEL_STEP_MAX_EXTRA_LTR) {
        this.host.logger.info(
          run.floorLtr === null
            ? `Fuel request did not move ${FUEL_STEP_MAX_EXTRA_LTR} L past the request — tank full, request at zero, or not in a pit-service state`
            : `Fuel request did not reach the target ${FUEL_STEP_MAX_EXTRA_LTR} L past the request — tank full, or not in a pit-service state`,
        );
        this.end(run, "unmoved", nowLtr, true);

        return;
      }

      run.extraLtr += 1;
      this.host.logger.debug(
        run.floorLtr === null
          ? `Fuel step: request unchanged, stepping ${run.extraLtr} L past it`
          : `Fuel step: bank ${nowLtr?.toFixed(2) ?? "unreadable"} below the ${run.floorLtr.toFixed(2)}L floor, stepping ${run.extraLtr} L past the request`,
      );
      this.send(run);

      return;
    }

    run.timer = setTimeout(() => {
      run.watchedMs += FUEL_STEP_POLL_MS;
      this.check(run);
    }, FUEL_STEP_POLL_MS);
  }

  /** Updates the learned minimum move from a press that landed (see the class comment). */
  private learn(run: RunningStep, landedLtr: number): void {
    if (run.memoryKey === null) return;

    const moveLtr = Math.abs(run.sentLtr - run.baselineLtr);
    const escalated = run.extraLtr > run.bumpLtr;
    const known = this.minimumMoves.get(run.memoryKey);

    if (escalated && run.previousSentLtr !== null && Math.abs(landedLtr - run.previousSentLtr) <= LATE_REFLECTION_LTR) {
      this.host.logger.debug(
        `Fuel step: landed at ${landedLtr.toFixed(2)}L, the previous send ${run.previousSentLtr} L showing late — not learned`,
      );

      return;
    }

    if (escalated) {
      this.minimumMoves.set(run.memoryKey, moveLtr);
    } else if (known !== undefined && moveLtr < known) {
      this.minimumMoves.set(run.memoryKey, moveLtr);
    }
  }

  /** Records a reading taken while watching the current send. */
  private observe(run: RunningStep, nowLtr: number): void {
    run.lastReadingLtr = nowLtr;

    const isNew =
      Math.abs(nowLtr - run.readingBeforeSendLtr) > MOVE_EPSILON_LTR &&
      run.readingsSinceSendLtr.every((seen) => Math.abs(seen - nowLtr) > MOVE_EPSILON_LTR);

    if (isNew) run.readingsSinceSendLtr.push(nowLtr);
  }

  /**
   * Updates the car's learned fuel step from a step that landed (#1483), when
   * the landing is known to span exactly one grid point (see the class comment).
   */
  private learnStep(run: RunningStep, landedLtr: number): void {
    if (run.carPath === null) return;

    let evidenceLtr: number;

    if (run.sends > 1) {
      if (!this.adjacentLanding(run, landedLtr)) return;

      evidenceLtr = Math.abs(landedLtr - run.readingBeforeSendLtr);
    } else {
      evidenceLtr = Math.abs(landedLtr - run.baselineLtr);

      if (evidenceLtr >= ONE_STEP_FIRST_SEND_MAX_LTR) return;
    }

    if (evidenceLtr < FUEL_STEP_MIN_LTR) return;

    const known = this.fuelSteps.get(run.carPath);

    if (known === undefined || evidenceLtr < known) {
      this.fuelSteps.set(run.carPath, evidenceLtr);
      this.host.logger.debug(`Fuel step: learned a ${evidenceLtr.toFixed(2)}L fuel step for ${run.carPath}`);
    }
  }

  /**
   * Whether an escalated landing is the current send landing one grid point from
   * what the previous send left banked — the only escalated landing that is
   * step evidence. Three ways it is not, each a send showing after its watch:
   *
   * - the landing sits within {@link LATE_REFLECTION_LTR} of the previous
   *   request: that request showing late (the minimum move's guard);
   * - a reading other than the landing showed while the current send was
   *   watched: the previous send showing late, so the reading the current send
   *   started from was stale (MX-5 from 0 L, floor 5: 5 unshown at 300 ms, 6
   *   sent from a stale 0, then 3.79 and 7.57 show — 7.57 − 0 is two gallons);
   * - the same, with both showing between two polls so no intermediate reading
   *   is seen: then the readings are inconsistent with nearest rounding on a
   *   grid of the claimed step, since the previous request must sit within half
   *   a step of what it banked, and the current one within half a step of the
   *   landing. A two-step claim fails this on any grid coarser than 2 L.
   */
  private adjacentLanding(run: RunningStep, landedLtr: number): boolean {
    const previousLtr = run.previousSentLtr;

    if (previousLtr === null) return false;

    if (Math.abs(landedLtr - previousLtr) <= LATE_REFLECTION_LTR) return false;

    if (run.readingsSinceSendLtr.some((seen) => Math.abs(seen - landedLtr) > MOVE_EPSILON_LTR)) {
      this.host.logger.debug(`Fuel step: an earlier send showed late before ${landedLtr.toFixed(2)}L — not learned`);

      return false;
    }

    const halfStepLtr = Math.abs(landedLtr - run.readingBeforeSendLtr) / 2 + MOVE_EPSILON_LTR;

    return (
      Math.abs(previousLtr - run.readingBeforeSendLtr) <= halfStepLtr &&
      Math.abs(run.sentLtr - landedLtr) <= halfStepLtr
    );
  }

  private moved(run: RunningStep, nowLtr: number): boolean {
    return run.direction === "add"
      ? nowLtr > run.baselineLtr + MOVE_EPSILON_LTR
      : nowLtr < run.baselineLtr - MOVE_EPSILON_LTR;
  }

  /**
   * The floor rule's completion: a reading at or above the floor that differs
   * from the baseline is done at once; one that still equals the baseline is
   * done only once the watch has expired (the send may not show yet). Below the
   * floor, or unreadable, is never done.
   */
  private reachedFloor(run: RunningStep, floorLtr: number, nowLtr: number | undefined): boolean {
    if (nowLtr === undefined || nowLtr < floorLtr - MOVE_EPSILON_LTR) return false;

    return Math.abs(nowLtr - run.baselineLtr) > MOVE_EPSILON_LTR || run.watchedMs >= FUEL_STEP_WATCH_MS;
  }

  /** Ends the running check, then starts the queued press when `startNext`. */
  private end(run: RunningStep, outcome: FuelStepOutcome, endLtr: number | undefined, startNext: boolean): void {
    if (run.timer !== null) clearTimeout(run.timer);

    run.timer = null;
    this.running = null;

    if (outcome === "landed" && endLtr !== undefined) this.learnStep(run, endLtr);

    this.finishStarted(
      run,
      {
        outcome,
        baselineLtr: run.baselineLtr,
        ...(run.floorLtr === null ? {} : { floorLtr: run.floorLtr }),
        firstLtr: run.firstLtr,
        sentLtr: run.sentLtr,
        extraLtr: run.extraLtr,
        endLtr,
      },
      startNext,
    );
  }

  /** Reports a step that started (or resolved), then runs the queued press. */
  private finishStarted(step: PendingStep, result: FuelStepResult, startNext = true): void {
    this.own(() => step.onEnd?.(result));
    step.done(result);

    if (!startNext) return;

    const next = this.queued;

    if (next && !this.running) {
      this.queued = null;
      this.start(next);
    }
  }

  /** Reports a press that never started (superseded in the queue, or cancelled). */
  private finishPending(step: PendingStep, outcome: "superseded" | "cancelled"): void {
    this.own(() => step.onEnd?.({ outcome, extraLtr: 0 }));
    step.done({ outcome, extraLtr: 0 });
  }

  private own(send: () => void): void {
    const previous = this.ownCommand;
    this.ownCommand = true;

    try {
      send();
    } finally {
      this.ownCommand = previous;
    }
  }
}
