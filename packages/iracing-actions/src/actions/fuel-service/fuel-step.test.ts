import type { SessionInfo, TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { FuelPipeline } from "./fuel-pipeline.js";
import {
  floorFirstRequestLtr,
  FUEL_STEP_MAX_EXTRA_LTR,
  FUEL_STEP_WATCH_MS,
  type FuelStepDirection,
  FuelStepper,
  type FuelStepResult,
  readPitSvFuel,
  readPlayerCarPath,
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
  /** How long after a command `PitSvFuel` shows it. */
  lagMs = TICK_MS;

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
    }, this.lagMs);
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
  it("readPitSvFuel reads a finite PitSvFuel and nothing else", () => {
    expect(readPitSvFuel({ PitSvFuel: 12.5 } as unknown as TelemetryData)).toBe(12.5);
    expect(readPitSvFuel({ PitSvFuel: Number.NaN } as unknown as TelemetryData)).toBeUndefined();
    expect(readPitSvFuel({} as TelemetryData)).toBeUndefined();
    expect(readPitSvFuel(null)).toBeUndefined();
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

  it("floorFirstRequestLtr rounds a floor up to a whole liter while the step is unknown (#1483)", () => {
    expect(floorFirstRequestLtr(5, undefined)).toBe(5);
    expect(floorFirstRequestLtr(46.08, undefined)).toBe(47);
    // Float noise does not cost a whole liter.
    expect(floorFirstRequestLtr(5.000000001, undefined)).toBe(5);
    // Never pit.fuel(0), which means "keep the existing amount".
    expect(floorFirstRequestLtr(0.004, undefined)).toBe(1);
  });

  it("floorFirstRequestLtr picks the liter that banks the smallest grid point at or above the floor (#1483)", () => {
    // 5 L on gallons: 2 gal (7.57 L) is the smallest grid point at or above it; 8 rounds to it.
    expect(floorFirstRequestLtr(5, GALLON)).toBe(8);
    // Exactly 2 gal (a gallon target's whole-unit add) stays 2 gal, not 3.
    expect(floorFirstRequestLtr(2 * GALLON, GALLON)).toBe(8);
    // One grid point: round(3.785) = 4, which banks 1 gal.
    expect(floorFirstRequestLtr(3.5, GALLON)).toBe(4);
    // A whole-liter car: the floor rounded up.
    expect(floorFirstRequestLtr(46.08, 1)).toBe(47);
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
      // A car whose first sends always land learns nothing.
      expect(stepper.minimumMoveFor(PORSCHE, "add")).toBe(0);
      expect(stepper.minimumMoveFor(PORSCHE, "reduce")).toBe(0);
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

    it("remembers the minimum move per car and direction, so the next small press lands on its first send", async () => {
      const first = press("add", 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(first).resolves.toMatchObject({ extraLtr: 2 });
      // 14 - 11.36: the distance from the baseline that landed.
      expect(stepper.minimumMoveFor(MX5, "add")).toBeCloseTo(14 - 3 * GALLON, 5);
      // Learned for adding only.
      expect(stepper.minimumMoveFor(MX5, "reduce")).toBe(0);
      mockPitFuel.mockClear();

      // From 4 gal (15.14 L): round(16.14) = 16 moves 0.86 L; 2 more whole liters
      // reach the 2.64 L minimum, so 18 goes out → 5 gal at once.
      const second = press("add", 1);
      await vi.advanceTimersByTimeAsync(TICK_MS + 4);

      await expect(second).resolves.toMatchObject({ outcome: "landed", extraLtr: 2, sentLtr: 18 });
      expect(sent()).toEqual([18]);
      expect(car.pitSvFuel).toBeCloseTo(5 * GALLON, 5);

      // The reduce direction learns its own minimum the first time…
      mockPitFuel.mockClear();
      const reduce = press("reduce", 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(reduce).resolves.toMatchObject({ outcome: "landed" });
      expect(sent()).toEqual([18, 17]);
      expect(stepper.minimumMoveFor(MX5, "reduce")).toBeCloseTo(5 * GALLON - 17, 5);

      // …and uses it from then on.
      mockPitFuel.mockClear();
      const reduceAgain = press("reduce", 1);
      await vi.advanceTimersByTimeAsync(TICK_MS + 4);
      await expect(reduceAgain).resolves.toMatchObject({ outcome: "landed", extraLtr: 1 });
      expect(sent()).toEqual([13]);
      expect(car.pitSvFuel).toBeCloseTo(3 * GALLON, 5);
    });

    it("sends a press larger than the step as its own request after a small press taught the minimum", async () => {
      // A 1 L press teaches the 2.64 L minimum (12, 13, 14 from 3 gal)…
      const small = press("add", 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(small).resolves.toMatchObject({ outcome: "landed", sentLtr: 14 });

      // …back to 3 gal…
      const back = press("reduce", 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(back).resolves.toMatchObject({ outcome: "landed" });
      expect(car.pitSvFuel).toBeCloseTo(3 * GALLON, 5);
      mockPitFuel.mockClear();

      // …and a 5 L Add moves 4.64 L on its own, past the minimum: plain
      // round(11.36 + 5) = 16, which banks 4 gal — not 18, which would bank 5.
      const large = press("add", 5);
      await vi.advanceTimersByTimeAsync(TICK_MS + 4);

      await expect(large).resolves.toMatchObject({ outcome: "landed", extraLtr: 0, sentLtr: 16 });
      expect(sent()).toEqual([16]);
      expect(car.pitSvFuel).toBeCloseTo(4 * GALLON, 5);
      // Landing on its first send with a larger move does not raise the minimum.
      expect(stepper.minimumMoveFor(MX5, "add")).toBeCloseTo(14 - 3 * GALLON, 5);
    });

    it("keeps the minimum when a bumped press lands on its first send", async () => {
      // 12, 13, 14 from 3 gal: the minimum is 2.64 L.
      const first = press("add", 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await first;

      // From 4 gal the bumped 18 (2.86 L) lands at once; the minimum stays.
      const second = press("add", 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(second).resolves.toMatchObject({ outcome: "landed", sentLtr: 18 });
      expect(stepper.minimumMoveFor(MX5, "add")).toBeCloseTo(14 - 3 * GALLON, 5);
    });

    it("does not learn from a send that iRacing shows only after the watch expired", async () => {
      useCar(new FakeCar(literGrid, 10, PORSCHE));
      car.lagMs = FUEL_STEP_WATCH_MS + 50;

      // 11 shows at 350 ms, after the check escalated to 12 at 300 ms: the step
      // "lands" on 11, which is the late send, not evidence about the grid.
      const late = press("add", 1);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(late).resolves.toMatchObject({ outcome: "landed", sentLtr: 12, endLtr: 11 });
      expect(stepper.minimumMoveFor(PORSCHE, "add")).toBe(0);

      // The late 12 has shown by now; the next 1 L press sends baseline + 1, unbumped.
      car.lagMs = TICK_MS;
      mockPitFuel.mockClear();
      const next = press("add", 1);
      await vi.advanceTimersByTimeAsync(100);

      await expect(next).resolves.toMatchObject({ outcome: "landed", baselineLtr: 12, sentLtr: 13, extraLtr: 0 });
      expect(sent()).toEqual([13]);
    });

    it("keys the minimum move by car: another car starts without one", async () => {
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
      expect(stepper.minimumMoveFor(MX5, "add")).toBeCloseTo(14 - 3 * GALLON, 5);
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
      expect(stepper.minimumMoveFor(MX5, "add")).toBe(0);
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
    it("clears fueling when a reduce lands at zero, ending it as emptied", async () => {
      useCar(new FakeCar(gallonGrid, GALLON, MX5));
      const onEnd = vi.fn((_result: FuelStepResult) => undefined);

      // 1 gal (3.79 L) - 1 → 3, 2 bank 1 gal again; 1 lands on 0 gal.
      const toZero = press("reduce", 1, onEnd);

      // Not yet: the clear follows the landing, not the send.
      await vi.advanceTimersByTimeAsync(2 * FUEL_STEP_WATCH_MS + 1);
      expect(mockPitClearFuel).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(toZero).resolves.toMatchObject({ outcome: "emptied", sentLtr: 1, endLtr: 0 });
      expect(sent()).toEqual([3, 2, 1]);
      expect(mockPitClearFuel).toHaveBeenCalledOnce();
      expect(mockPitClearFuel.mock.invocationCallOrder[0]).toBeGreaterThan(mockPitFuel.mock.invocationCallOrder[2]!);
      // The clear is the step's own command: it ended the step, it did not cancel it.
      expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ outcome: "emptied" }));
      expect(stepper.busy).toBe(false);
    });

    it("an add from zero lands normally: only a reduce at zero empties", async () => {
      useCar(new FakeCar(literGrid, 0, PORSCHE));

      const add = press("add", 1);
      await vi.advanceTimersByTimeAsync(100);

      await expect(add).resolves.toMatchObject({ outcome: "landed", sentLtr: 1 });
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("empties the request through the no-fuel path instead of sending pit.fuel(0)", async () => {
      useCar(new FakeCar(gallonGrid, 0, MX5));

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
      // From 4 gal, bumped to the learned minimum move: 16 + 2 = 18 → 5 gal.
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
      // 11.36 L goes out as whole liters.
      expect(sent()).toEqual([11]);
    });

    it("rounds a fractional request before sending, measuring and learning from it", async () => {
      useCar(new FakeCar(literGrid, 10, PORSCHE));

      // A dial detent of 0.5 L from 10 L: 10.5 goes out as 11 and lands at once.
      const detent = stepper.sendFuelStep(() => ({ direction: "add", firstLtr: 10.5 }));
      await vi.advanceTimersByTimeAsync(100);

      await expect(detent).resolves.toMatchObject({ outcome: "landed", firstLtr: 11, sentLtr: 11, extraLtr: 0 });
      expect(stepper.minimumMoveFor(PORSCHE, "add")).toBe(0);

      // So a 1 L press afterwards is not inflated: from 11 it sends 12.
      const key = press("add", 1);
      await vi.advanceTimersByTimeAsync(100);
      await expect(key).resolves.toMatchObject({ outcome: "landed", sentLtr: 12 });
      expect(sent()).toEqual([11, 12]);
    });

    it("sends nothing when the resolver asks for nothing", async () => {
      const result = stepper.sendFuelStep(() => null);

      await expect(result).resolves.toMatchObject({ outcome: "skipped" });
      expect(mockPitFuel).not.toHaveBeenCalled();
    });
  });

  describe("the floor rule (#1483)", () => {
    /** A Target Amount send: bank at least `floorLtr`. */
    function floor(floorLtr: number, onEnd?: (result: FuelStepResult) => void) {
      return stepper.sendFuelStep(() => ({ floorLtr }), onEnd);
    }

    /** Every value `PitSvFuel` shows while the timers run, so a test can say what was never banked. */
    function recordBanks(): number[] {
      const banks: number[] = [];
      const receive = car.receive.bind(car);
      vi.spyOn(car, "receive").mockImplementation((liters: number) => {
        receive(liters);
        // The fake banks one tick later; record what it will show.
        setTimeout(() => banks.push(car.pitSvFuel ?? Number.NaN), car.lagMs);
      });

      return banks;
    }

    /** Teaches the MX-5's gallon step: from 1 gal, floor 5 sends 5 (banks 1 gal again), then 6 (2 gal). */
    async function learnGallonStep(): Promise<void> {
      useCar(new FakeCar(gallonGrid, GALLON, MX5));
      const teach = floor(5);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(teach).resolves.toMatchObject({ outcome: "landed", sentLtr: 6 });
      expect(stepper.fuelStepFor(MX5)).toBeCloseTo(GALLON, 5);
      mockPitFuel.mockClear();
    }

    it("a 5 L floor on a gallon car banks 2 gal, never stopping at 1 gal", async () => {
      useCar(new FakeCar(gallonGrid, 0, MX5));
      const banks = recordBanks();

      // 5 banks the nearest gallon, 1 gal (3.79 L) — below the floor, so 6 goes
      // out and banks 2 gal (7.57 L). Today's Fill To would have stopped at 1 gal.
      const result = floor(5);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toMatchObject({ outcome: "landed", floorLtr: 5, firstLtr: 5, sentLtr: 6 });
      expect(sent()).toEqual([5, 6]);
      expect(car.pitSvFuel).toBeCloseTo(2 * GALLON, 5);
      expect(car.pitSvFuel).toBeGreaterThanOrEqual(5);
      // The 1 gal was only the probe on the way up, not where the step ended.
      expect(banks.map((bank) => Number(bank.toFixed(2)))).toEqual([3.79, 7.57]);
    });

    it("learns the step from a one-step landing, and the next floor send lands on its first read", async () => {
      await learnGallonStep();

      // From 2 gal, a 9 L floor needs 3 gal (11.36 L): round(11.36) = 11 lands at once.
      const next = floor(9);
      await vi.advanceTimersByTimeAsync(TICK_MS + 4);

      await expect(next).resolves.toMatchObject({ outcome: "landed", firstLtr: 11, sentLtr: 11, extraLtr: 0 });
      expect(sent()).toEqual([11]);
      expect(car.pitSvFuel).toBeCloseTo(3 * GALLON, 5);
    });

    it("on a whole-liter car sends the floor rounded up once and never steps", async () => {
      useCar(new FakeCar(literGrid, 10, PORSCHE));

      const result = floor(15.3);
      await vi.advanceTimersByTimeAsync(TICK_MS + 4);

      await expect(result).resolves.toMatchObject({ outcome: "landed", sentLtr: 16, extraLtr: 0, endLtr: 16 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent()).toEqual([16]);
    });

    it("learns a whole-liter car's 1 L step from a one-liter landing, never from a large first fill", async () => {
      useCar(new FakeCar(literGrid, 0, PORSCHE));

      // 0 → 46 L lands on its first send but spans 46 grid points: not the step.
      const fill = floor(46);
      await vi.advanceTimersByTimeAsync(100);
      await expect(fill).resolves.toMatchObject({ outcome: "landed", endLtr: 46 });
      expect(stepper.fuelStepFor(PORSCHE)).toBeUndefined();

      // A liter of burn later the floor is 47: a 1 L move, one whole-liter step.
      const burn = floor(47);
      await vi.advanceTimersByTimeAsync(100);
      await expect(burn).resolves.toMatchObject({ outcome: "landed", endLtr: 47 });
      expect(stepper.fuelStepFor(PORSCHE)).toBe(1);
    });

    it("with the step known, a floor more than a step below the bank lands on the grid point just above it", async () => {
      await learnGallonStep();
      // Back up to 3 gal (11.36 L).
      const up = floor(10);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(up).resolves.toMatchObject({ outcome: "landed" });
      expect(car.pitSvFuel).toBeCloseTo(3 * GALLON, 5);
      mockPitFuel.mockClear();

      // The target lowered: a 3.5 L floor needs 1 gal. 4 goes out; PitSvFuel
      // still reads 11.36 for a tick (at or above the floor, but the baseline),
      // then 3.79 shows and the step ends there.
      const down = floor(3.5);
      await vi.advanceTimersByTimeAsync(TICK_MS + 4);

      await expect(down).resolves.toMatchObject({ outcome: "landed", sentLtr: 4, extraLtr: 0 });
      expect(sent()).toEqual([4]);
      expect(car.pitSvFuel).toBeCloseTo(GALLON, 5);
    });

    it("ends a floor the baseline already covers only when the watch expires", async () => {
      await learnGallonStep();

      // From 2 gal (7.57 L) a 7 L floor needs 2 gal again: 8 goes out and banks
      // what is already there. The step cannot tell "covered" from "not shown
      // yet" until the watch ends.
      const covered = floor(7);
      await vi.advanceTimersByTimeAsync(FUEL_STEP_WATCH_MS - 20);
      expect(stepper.busy).toBe(true);

      await vi.advanceTimersByTimeAsync(40);

      await expect(covered).resolves.toMatchObject({ outcome: "landed", sentLtr: 8, extraLtr: 0 });
      expect(sent()).toEqual([8]);
      expect(car.pitSvFuel).toBeCloseTo(2 * GALLON, 5);
    });

    it("ends unmoved, logging at info, when the bank cannot reach the floor within the bound", async () => {
      useCar(new FakeCar(gallonGrid, 3 * GALLON, MX5));
      car.capacityLtr = 3 * GALLON;

      const result = floor(14);
      await vi.advanceTimersByTimeAsync(20 * FUEL_STEP_WATCH_MS);

      await expect(result).resolves.toMatchObject({
        outcome: "unmoved",
        extraLtr: FUEL_STEP_MAX_EXTRA_LTR,
        sentLtr: 22,
      });
      expect(sent()).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22]);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("did not reach the target"));
      expect(stepper.busy).toBe(false);
    });

    it("never reads or writes the minimum move", async () => {
      useCar(new FakeCar(gallonGrid, GALLON, MX5));

      // An escalated floor landing (5, 6) teaches no minimum move…
      const first = floor(5);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(first).resolves.toMatchObject({ outcome: "landed", extraLtr: 1 });
      expect(stepper.minimumMoveFor(MX5, "add")).toBe(0);
      expect(stepper.minimumMoveFor(MX5, "reduce")).toBe(0);

      // …a key press teaches one (from 2 gal: 9 rounds back, 10 lands on 3 gal)…
      const key = press("add", 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(key).resolves.toMatchObject({ outcome: "landed", sentLtr: 10 });
      const minimum = stepper.minimumMoveFor(MX5, "add");
      expect(minimum).toBeCloseTo(10 - 2 * GALLON, 5);
      mockPitFuel.mockClear();

      // …and a floor send is not bumped by it, nor changes it: 12 L from 3 gal
      // needs 4 gal, and goes out as round(15.14) = 15, not 15 + a bump.
      const second = floor(12);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(second).resolves.toMatchObject({ outcome: "landed", sentLtr: 15, extraLtr: 0 });
      expect(sent()).toEqual([15]);
      expect(stepper.minimumMoveFor(MX5, "add")).toBe(minimum);
    });

    it("a key press's escalated landing teaches the step too", async () => {
      // 12 and 13 round back to 3 gal; 14 lands one grid point up, on 4 gal.
      const key = press("add", 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(key).resolves.toMatchObject({ outcome: "landed", sentLtr: 14 });

      expect(stepper.fuelStepFor(MX5)).toBeCloseTo(GALLON, 5);
    });

    it("does not learn a step from a send that shows only after the watch expired", async () => {
      useCar(new FakeCar(literGrid, 0, PORSCHE));
      car.lagMs = FUEL_STEP_WATCH_MS + 50;

      // 46 shows at 350 ms, after the check escalated to 47: the step ends on the
      // late 46, which is 46 L from the baseline, not one grid point.
      const late = floor(46);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(late).resolves.toMatchObject({ outcome: "landed", sentLtr: 47, endLtr: 46 });
      expect(stepper.fuelStepFor(PORSCHE)).toBeUndefined();
    });

    it("keeps the smallest step seen per car", async () => {
      await learnGallonStep();
      useCar(new FakeCar(literGrid, 10, PORSCHE));

      const liter = floor(11);
      await vi.advanceTimersByTimeAsync(100);
      await expect(liter).resolves.toMatchObject({ outcome: "landed" });

      expect(stepper.fuelStepFor(PORSCHE)).toBe(1);
      expect(stepper.fuelStepFor(MX5)).toBeCloseTo(GALLON, 5);
    });

    it("learns nothing when session info does not name the car", async () => {
      useCar(new FakeCar(gallonGrid, GALLON, MX5));
      vi.spyOn(car, "sessionInfo").mockReturnValue(null);

      const result = floor(5);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toMatchObject({ outcome: "landed", sentLtr: 6 });
      expect(stepper.fuelStepFor(MX5)).toBeUndefined();
    });

    it("sends once without a check when PitSvFuel is unreadable", async () => {
      useCar(new FakeCar(gallonGrid, undefined, MX5));

      const result = floor(5);

      await expect(result).resolves.toMatchObject({ outcome: "unchecked", floorLtr: 5, sentLtr: 5 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent()).toEqual([5]);
    });

    it("sends nothing for a floor at or below zero", async () => {
      const result = floor(0);

      await expect(result).resolves.toMatchObject({ outcome: "skipped" });
      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("is cancelled by another fuel command like any step", async () => {
      useCar(new FakeCar(gallonGrid, 0, MX5));

      const running = floor(5);
      await vi.advanceTimersByTimeAsync(50);
      pipeline.forceClearFuel();

      await expect(running).resolves.toMatchObject({ outcome: "cancelled", sentLtr: 5 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent()).toEqual([5]);
    });
  });
});
