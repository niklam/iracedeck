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
 *   Set Fuel Amount press, a dial gesture, the fill-to monitor) cancels the
 *   running check and the queued press, so a later escalation cannot undo it.
 *
 * One instance per FuelService action, shared by the keypad's Add / Reduce Fuel
 * and the dial's Add Amount rotation: both drive the same single pit request.
 * Spec: `docs/superpowers/specs/2026-10-18-issue-1314-fuel-step-per-car.md`.
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

/** Which way a press moves the pit fuel request. */
export type FuelStepDirection = "add" | "reduce";

/**
 * What a press asks for, resolved from the `PitSvFuel` baseline when its check
 * STARTS — a queued press must run from the baseline the previous check left.
 */
export interface FuelStepRequest {
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
 * How a step ended.
 *
 * - `landed` — `PitSvFuel` moved in the press's direction.
 * - `unmoved` — nothing moved up to {@link FUEL_STEP_MAX_EXTRA_LTR} past the request.
 * - `emptied` — the request reached zero, so the request was emptied instead (see {@link FuelStepper}).
 * - `unchecked` — sent once without a check (`direction: null`, or `PitSvFuel` unreadable).
 * - `skipped` — the resolver asked for nothing.
 * - `superseded` — a newer press replaced this one in the queue before it ran.
 * - `cancelled` — another fuel command took over the request.
 */
export type FuelStepOutcome = "landed" | "unmoved" | "emptied" | "unchecked" | "skipped" | "superseded" | "cancelled";

export interface FuelStepResult {
  outcome: FuelStepOutcome;
  /** `PitSvFuel` when the step started (liters); undefined when it never started. */
  baselineLtr?: number;
  /** The press's own request; undefined when the step never resolved one. */
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
  baselineLtr: number;
  firstLtr: number;
  /** The minimum-move memory key (`<CarPath>|<direction>`), or null when the car is unknown. */
  memoryKey: string | null;
  /** Whole liters the first send was bumped by to reach the learned minimum move. */
  bumpLtr: number;
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
 * @internal Exported for testing
 *
 * The player's car path (`DriverInfo.Drivers[DriverCarIdx].CarPath`, e.g.
 * `"mx5 mx52016"`), the key the minimum moves are remembered under. Null when
 * session info does not name it.
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
 *   under one step, so a bumped press never skips a step. A one-off error (a
 *   telemetry tick later than the watch) can add at most the one liter of
 *   that escalation, and the 8 L bound caps it absolutely.
 * - A press that never moved (`unmoved`), was emptied, or was not checked
 *   teaches nothing.
 */
export class FuelStepper {
  /** The smallest move (liters from the baseline) known to land, by `<CarPath>|<direction>`. */
  private readonly minimumMoves = new Map<string, number>();
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
      baselineLtr,
      firstLtr,
      memoryKey,
      bumpLtr,
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

  /** Sends the run's current request (its own request plus `extraLtr`) and starts watching it. */
  private send(run: RunningStep): void {
    const liters = run.direction === "add" ? run.firstLtr + run.extraLtr : run.firstLtr - run.extraLtr;
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

  /** Reads `PitSvFuel` back: done when it moved, otherwise watch on, step further or give up. */
  private check(run: RunningStep): void {
    run.timer = null;

    if (this.running !== run) return;

    const nowLtr = readPitSvFuel(this.host.getTelemetry());

    if (nowLtr !== undefined && this.moved(run, nowLtr)) {
      this.learn(run);

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
          `Fuel request did not move ${FUEL_STEP_MAX_EXTRA_LTR} L past the request — tank full, request at zero, or not in a pit-service state`,
        );
        this.end(run, "unmoved", nowLtr, true);

        return;
      }

      run.extraLtr += 1;
      this.host.logger.debug(`Fuel step: request unchanged, stepping ${run.extraLtr} L past it`);
      this.send(run);

      return;
    }

    run.timer = setTimeout(() => {
      run.watchedMs += FUEL_STEP_POLL_MS;
      this.check(run);
    }, FUEL_STEP_POLL_MS);
  }

  /** Updates the learned minimum move from a press that landed (see the class comment). */
  private learn(run: RunningStep): void {
    if (run.memoryKey === null) return;

    const moveLtr = Math.abs(run.sentLtr - run.baselineLtr);
    const escalated = run.extraLtr > run.bumpLtr;
    const known = this.minimumMoves.get(run.memoryKey);

    if (escalated) {
      this.minimumMoves.set(run.memoryKey, moveLtr);
    } else if (known !== undefined && moveLtr < known) {
      this.minimumMoves.set(run.memoryKey, moveLtr);
    }
  }

  private moved(run: RunningStep, nowLtr: number): boolean {
    return run.direction === "add"
      ? nowLtr > run.baselineLtr + MOVE_EPSILON_LTR
      : nowLtr < run.baselineLtr - MOVE_EPSILON_LTR;
  }

  /** Ends the running check, then starts the queued press when `startNext`. */
  private end(run: RunningStep, outcome: FuelStepOutcome, endLtr: number | undefined, startNext: boolean): void {
    if (run.timer !== null) clearTimeout(run.timer);

    run.timer = null;
    this.running = null;
    this.finishStarted(
      run,
      {
        outcome,
        baselineLtr: run.baselineLtr,
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
