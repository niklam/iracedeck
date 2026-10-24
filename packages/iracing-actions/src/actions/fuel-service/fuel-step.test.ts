import type { SessionInfo, TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { FuelPipeline } from "./fuel-pipeline.js";
import {
  FUEL_STEP_MAX_EXTRA_LTR,
  FUEL_STEP_WATCH_MS,
  type FuelStepDirection,
  FuelStepper,
  type FuelStepResult,
  readPlayerCarPath,
  readStepPitSvFuel,
} from "./fuel-step.js";

const { mockPitFuel, mockPitClearFuel } = vi.hoisted(() => ({
  mockPitFuel: vi.fn((_liters: number) => true),
  mockPitClearFuel: vi.fn(() => true),
}));

vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: () => ({ pit: { fuel: mockPitFuel, clearFuel: mockPitClearFuel } }),
}));

/** One US gallon in liters — the MX-5's fuel step. */
const GALLON = 3.78541;
/** iRacing's lag between a pit command and the telemetry reflecting it (one 60 Hz tick). */
const TICK_MS = 16;

const MX5 = "mx5 mx52016";
const PORSCHE = "porsche992cup";

/**
 * A fake car in the sim. `pit.fuel(n)` truncates n to whole liters (the native
 * broadcast is an integer), ignores 0 ("keep existing"), rounds it to the car's
 * fuel grid, caps it at the tank, and shows the result in `PitSvFuel` one tick
 * later — the behaviour the issue's logs show.
 */
class FakeCar {
  pitSvFuel: number | undefined;
  carPath: string;
  capacityLtr = Number.POSITIVE_INFINITY;
  /** True while the car is not in a pit-service state: nothing is banked. */
  ignoring = false;

  constructor(
    private readonly grid: (wholeLiters: number) => number,
    startLtr: number | undefined,
    carPath: string,
  ) {
    this.pitSvFuel = startLtr;
    this.carPath = carPath;
  }

  receive(liters: number): void {
    const whole = Math.trunc(liters);

    if (whole <= 0 || this.ignoring) return;

    const banked = Math.min(this.grid(whole), this.capacityLtr);
    setTimeout(() => {
      this.pitSvFuel = banked;
    }, TICK_MS);
  }

  telemetry(): TelemetryData | null {
    return { PitSvFuel: this.pitSvFuel } as unknown as TelemetryData;
  }

  sessionInfo(): SessionInfo | null {
    return {
      DriverInfo: {
        DriverCarIdx: 3,
        Drivers: [
          { CarIdx: 1, CarPath: "other" },
          { CarIdx: 3, CarPath: this.carPath },
        ],
      },
    } as unknown as SessionInfo;
  }
}

/** The MX-5 banks whole US gallons. */
const gallonGrid = (liters: number) => Math.round(liters / GALLON) * GALLON;
/** The Porsche banks whole liters. */
const literGrid = (liters: number) => liters;

describe("fuel-step helpers", () => {
  it("readStepPitSvFuel reads a finite PitSvFuel and nothing else", () => {
    expect(readStepPitSvFuel({ PitSvFuel: 12.5 } as unknown as TelemetryData)).toBe(12.5);
    expect(readStepPitSvFuel({ PitSvFuel: Number.NaN } as unknown as TelemetryData)).toBeUndefined();
    expect(readStepPitSvFuel({} as TelemetryData)).toBeUndefined();
    expect(readStepPitSvFuel(null)).toBeUndefined();
  });

  it("readPlayerCarPath finds the player's own car by DriverCarIdx", () => {
    const info = {
      DriverInfo: {
        DriverCarIdx: 2,
        Drivers: [
          { CarIdx: 0, CarPath: "safety pcsedan" },
          { CarIdx: 2, CarPath: MX5 },
        ],
      },
    } as unknown as SessionInfo;

    expect(readPlayerCarPath(info)).toBe(MX5);
  });

  it("readPlayerCarPath is null when session info does not name the car", () => {
    expect(readPlayerCarPath(null)).toBeNull();
    expect(readPlayerCarPath({ DriverInfo: { DriverCarIdx: 2 } } as unknown as SessionInfo)).toBeNull();
    expect(
      readPlayerCarPath({
        DriverInfo: { DriverCarIdx: 2, Drivers: [{ CarIdx: 2, CarPath: "" }] },
      } as unknown as SessionInfo),
    ).toBeNull();
  });
});

describe("FuelStepper", () => {
  let car: FakeCar;
  let logger: ILogger & { info: Mock<(message: string) => void>; debug: Mock<(message: string) => void> };
  let pipeline: FuelPipeline;
  let stepper: FuelStepper;

  function useCar(next: FakeCar): void {
    car = next;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    useCar(new FakeCar(gallonGrid, 3 * GALLON, MX5));
    mockPitFuel.mockImplementation((liters: number) => {
      car.receive(liters);

      return true;
    });
    logger = { ...silentLogger, info: vi.fn<(message: string) => void>(), debug: vi.fn<(message: string) => void>() };
    pipeline = new FuelPipeline(logger);
    stepper = new FuelStepper(
      { logger, getTelemetry: () => car.telemetry(), getSessionInfo: () => car.sessionInfo() },
      pipeline,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** An Add / Reduce key press of `amountLtr`, as the keypad sends it. */
  function press(direction: FuelStepDirection, amountLtr: number, onEnd?: (result: FuelStepResult) => void) {
    return stepper.sendFuelStep(
      (baselineLtr) => ({
        direction,
        firstLtr: Math.round(direction === "add" ? baselineLtr + amountLtr : baselineLtr - amountLtr),
      }),
      onEnd,
    );
  }

  const sent = () => mockPitFuel.mock.calls.map(([liters]) => liters);

  describe("a car that banks whole liters (Porsche-like)", () => {
    beforeEach(() => {
      useCar(new FakeCar(literGrid, 5, PORSCHE));
    });

    it("stops at once when the first request lands", async () => {
      const result = press("add", 1);

      await vi.advanceTimersByTimeAsync(TICK_MS + 4);

      await expect(result).resolves.toMatchObject({ outcome: "landed", extraLtr: 0, sentLtr: 6, endLtr: 6 });
      expect(sent()).toEqual([6]);
      expect(stepper.busy).toBe(false);

      // Nothing more is ever sent for that press.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent()).toEqual([6]);
    });

    it("moves 1 L per press both ways", async () => {
      const add = press("add", 1);
      await vi.advanceTimersByTimeAsync(100);
      await expect(add).resolves.toMatchObject({ outcome: "landed" });

      const reduce = press("reduce", 1);
      await vi.advanceTimersByTimeAsync(100);
      await expect(reduce).resolves.toMatchObject({ outcome: "landed" });

      expect(sent()).toEqual([6, 5]);
      expect(car.pitSvFuel).toBe(5);
      expect(stepper.headStartFor(PORSCHE, "add")).toBe(0);
      expect(stepper.headStartFor(PORSCHE, "reduce")).toBe(0);
    });
  });

  describe("a car that banks whole gallons (MX-5)", () => {
    it("a 1 L Reduce moves exactly one gallon, sending the extra liter the issue's log predicts", async () => {
      // 11.36 L (3 gal) - 1 → pit.fuel(10) rounds back to 3 gal; 9 lands on 2 gal.
      const result = press("reduce", 1);

      await vi.advanceTimersByTimeAsync(FUEL_STEP_WATCH_MS - 1);
      expect(sent()).toEqual([10]);

      await vi.advanceTimersByTimeAsync(100);

      await expect(result).resolves.toMatchObject({ outcome: "landed", extraLtr: 1, sentLtr: 9 });
      expect(sent()).toEqual([10, 9]);
      expect(car.pitSvFuel).toBeCloseTo(2 * GALLON, 5);
    });

    it("a 1 L Add moves exactly one gallon, sending the two extra liters it needs", async () => {
      // 11.36 L + 1 → 12 and 13 round back to 3 gal; 14 lands on 4 gal.
      const result = press("add", 1);

      await vi.advanceTimersByTimeAsync(2 * FUEL_STEP_WATCH_MS + 100);

      await expect(result).resolves.toMatchObject({ outcome: "landed", extraLtr: 2, sentLtr: 14 });
      expect(sent()).toEqual([12, 13, 14]);
      expect(car.pitSvFuel).toBeCloseTo(4 * GALLON, 5);
    });

    it("remembers the head start per car and direction, so the next press lands on its first send", async () => {
      const first = press("add", 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(first).resolves.toMatchObject({ extraLtr: 2 });
      expect(stepper.headStartFor(MX5, "add")).toBe(2);
      // Learned for adding only.
      expect(stepper.headStartFor(MX5, "reduce")).toBe(0);
      mockPitFuel.mockClear();

      // From 4 gal (15.14 L): round(16.14) = 16, +2 head start = 18 → 5 gal at once.
      const second = press("add", 1);
      await vi.advanceTimersByTimeAsync(TICK_MS + 4);

      await expect(second).resolves.toMatchObject({ outcome: "landed", extraLtr: 2, sentLtr: 18 });
      expect(sent()).toEqual([18]);
      expect(car.pitSvFuel).toBeCloseTo(5 * GALLON, 5);

      // The reduce direction learns its own head start the first time…
      mockPitFuel.mockClear();
      const reduce = press("reduce", 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(reduce).resolves.toMatchObject({ outcome: "landed" });
      expect(sent()).toEqual([18, 17]);
      expect(stepper.headStartFor(MX5, "reduce")).toBe(1);

      // …and uses it from then on.
      mockPitFuel.mockClear();
      const reduceAgain = press("reduce", 1);
      await vi.advanceTimersByTimeAsync(TICK_MS + 4);
      await expect(reduceAgain).resolves.toMatchObject({ outcome: "landed", extraLtr: 1 });
      expect(sent()).toEqual([13]);
      expect(car.pitSvFuel).toBeCloseTo(3 * GALLON, 5);
    });

    it("keys the head start by car: another car starts without one", async () => {
      const mx5 = press("add", 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(mx5).resolves.toMatchObject({ extraLtr: 2 });

      useCar(new FakeCar(literGrid, 5, PORSCHE));
      mockPitFuel.mockClear();

      const porsche = press("add", 1);
      await vi.advanceTimersByTimeAsync(100);

      await expect(porsche).resolves.toMatchObject({ outcome: "landed", extraLtr: 0 });
      expect(sent()).toEqual([6]);
      // The MX-5's memory survives the car change.
      expect(stepper.headStartFor(MX5, "add")).toBe(2);
    });

    it("remembers nothing when session info does not name the car", async () => {
      vi.spyOn(car, "sessionInfo").mockReturnValue(null);

      const first = press("add", 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(first).resolves.toMatchObject({ extraLtr: 2 });
      mockPitFuel.mockClear();

      const second = press("add", 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(second).resolves.toMatchObject({ extraLtr: 2 });
      // Started from the press's own request again: 16, 17, 18.
      expect(sent()).toEqual([16, 17, 18]);
    });
  });

  describe("the 8 L bound", () => {
    it("stops 8 L past the first request when the tank is full, and logs at info", async () => {
      car.capacityLtr = 3 * GALLON;

      const result = press("add", 1);
      await vi.advanceTimersByTimeAsync(20 * FUEL_STEP_WATCH_MS);

      await expect(result).resolves.toMatchObject({
        outcome: "unmoved",
        extraLtr: FUEL_STEP_MAX_EXTRA_LTR,
        sentLtr: 20,
      });
      expect(sent()).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20]);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("did not move"));
      expect(stepper.headStartFor(MX5, "add")).toBe(0);
      expect(stepper.busy).toBe(false);
    });

    it("stops the same way when the car is not in a pit-service state", async () => {
      car.ignoring = true;

      const result = press("reduce", 1);
      await vi.advanceTimersByTimeAsync(20 * FUEL_STEP_WATCH_MS);

      await expect(result).resolves.toMatchObject({ outcome: "unmoved" });
      // 10, 9, 8 … 2: eight liters past 10, all still above zero.
      expect(sent()).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2]);
      expect(logger.info).toHaveBeenCalledTimes(1);
    });
  });

  describe("reaching zero", () => {
    it("empties the request through the no-fuel path instead of sending pit.fuel(0)", async () => {
      useCar(new FakeCar(gallonGrid, GALLON, MX5));

      // 1 gal (3.79 L) - 1 → 3, 2 bank 1 gal again; 1 lands on 0 gal.
      const toZero = press("reduce", 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(toZero).resolves.toMatchObject({ outcome: "landed", sentLtr: 1 });
      mockPitFuel.mockClear();

      // At 0: round(0 - 1) = -1 is at or below zero → 1 L then clear, and the step ends.
      const empty = press("reduce", 1);

      await expect(empty).resolves.toMatchObject({ outcome: "emptied" });
      expect(sent()).toEqual([1]);
      expect(mockPitClearFuel).toHaveBeenCalledOnce();
      expect(mockPitFuel).not.toHaveBeenCalledWith(0);
      expect(stepper.busy).toBe(false);
    });

    it("ends an escalating reduce at the no-fuel path once its request would reach zero", async () => {
      useCar(new FakeCar(gallonGrid, GALLON, MX5));
      car.ignoring = true;

      const result = press("reduce", 1);
      await vi.advanceTimersByTimeAsync(10 * FUEL_STEP_WATCH_MS);

      await expect(result).resolves.toMatchObject({ outcome: "emptied" });
      // 3, 2, 1, then 0 would mean "keep existing": no-fuel sends 1 L and clears.
      expect(sent()).toEqual([3, 2, 1, 1]);
      expect(mockPitClearFuel).toHaveBeenCalledOnce();
    });
  });

  describe("the one-deep queue", () => {
    it("holds a press that arrives during a check and runs it from the new baseline", async () => {
      const first = press("add", 1);
      await vi.advanceTimersByTimeAsync(50);
      const second = press("add", 1);

      // Held, not sent: the running check is still stepping.
      expect(sent()).toEqual([12]);

      await vi.advanceTimersByTimeAsync(2_000);

      await expect(first).resolves.toMatchObject({ outcome: "landed", sentLtr: 14 });
      // From 4 gal with the learned head start: 16 + 2 = 18 → 5 gal.
      await expect(second).resolves.toMatchObject({ outcome: "landed", baselineLtr: 4 * GALLON, sentLtr: 18 });
      expect(sent()).toEqual([12, 13, 14, 18]);
      expect(car.pitSvFuel).toBeCloseTo(5 * GALLON, 5);
    });

    it("lets the newest queued press win", async () => {
      const first = press("add", 1);
      await vi.advanceTimersByTimeAsync(50);
      const older = press("add", 1);
      const newer = press("reduce", 1);

      await expect(older).resolves.toEqual({ outcome: "superseded", extraLtr: 0 });

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(first).resolves.toMatchObject({ outcome: "landed" });
      await expect(newer).resolves.toMatchObject({ outcome: "landed", baselineLtr: 4 * GALLON });
      // The add ran (12, 13, 14), the superseded add never did, and the reduce ran
      // from 4 gal: round(15.14 - 1) = 14 banks 4 gal again, 13 lands on 3 gal.
      expect(sent()).toEqual([12, 13, 14, 14, 13]);
      expect(car.pitSvFuel).toBeCloseTo(3 * GALLON, 5);
    });

    it("runs the end handler once, after the check and before the queued press, without cancelling it", async () => {
      // The keypad's preserve-off clear is sent from the end handler.
      const onEnd = vi.fn((_result: FuelStepResult) => {
        pipeline.clearFuel();
      });
      const first = press("add", 1, onEnd);
      await vi.advanceTimersByTimeAsync(50);
      const second = press("add", 1);

      await vi.advanceTimersByTimeAsync(2_000);
      await first;
      await expect(second).resolves.toMatchObject({ outcome: "landed" });

      expect(onEnd).toHaveBeenCalledOnce();
      expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ outcome: "landed", sentLtr: 14 }));
      expect(mockPitClearFuel).toHaveBeenCalledOnce();

      const fuelOrder = mockPitFuel.mock.invocationCallOrder;
      const clearOrder = mockPitClearFuel.mock.invocationCallOrder[0]!;

      // 12, 13, 14 before the clear; the queued press's 18 after it.
      expect(fuelOrder.slice(0, 3).every((order) => order < clearOrder)).toBe(true);
      expect(fuelOrder[3]).toBeGreaterThan(clearOrder);
    });
  });

  describe("another fuel command", () => {
    it("cancels the running check and the queued press", async () => {
      const running = press("add", 1);
      await vi.advanceTimersByTimeAsync(50);
      const queued = press("add", 1);

      // A Clear Fuel press, say.
      pipeline.forceClearFuel();

      await expect(running).resolves.toMatchObject({ outcome: "cancelled", sentLtr: 12 });
      await expect(queued).resolves.toEqual({ outcome: "cancelled", extraLtr: 0 });
      expect(stepper.busy).toBe(false);

      // No escalation undoes the clear afterwards.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent()).toEqual([12]);
    });

    it("leaves an idle stepper alone", () => {
      pipeline.fuel(30);

      expect(stepper.busy).toBe(false);
      expect(sent()).toEqual([30]);
    });
  });

  describe("requests that are not checked", () => {
    it("sends once without a check when PitSvFuel is unreadable", async () => {
      useCar(new FakeCar(gallonGrid, undefined, MX5));

      const result = press("add", 5);

      await expect(result).resolves.toMatchObject({ outcome: "unchecked", sentLtr: 5 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent()).toEqual([5]);
    });

    it("sends once without a check when the request has no direction", async () => {
      const result = stepper.sendFuelStep((baselineLtr) => ({ direction: null, firstLtr: baselineLtr }));

      await expect(result).resolves.toMatchObject({ outcome: "unchecked" });
      expect(sent()).toEqual([3 * GALLON]);
    });

    it("sends nothing when the resolver asks for nothing", async () => {
      const result = stepper.sendFuelStep(() => null);

      await expect(result).resolves.toMatchObject({ outcome: "skipped" });
      expect(mockPitFuel).not.toHaveBeenCalled();
    });
  });
});
