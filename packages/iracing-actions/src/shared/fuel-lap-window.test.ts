import { describe, expect, it, vi } from "vitest";

import { DEFAULT_FUEL_LAP_WINDOW, FuelLapWindow } from "./fuel-lap-window.js";

vi.mock("@iracedeck/sim-events-iracing", () => ({ FUEL_LAP_HISTORY_CAP: 20 }));

describe("FuelLapWindow (issues #465, #466)", () => {
  it("defaults to 5 laps when unset or blank", () => {
    expect(DEFAULT_FUEL_LAP_WINDOW).toBe(5);

    for (const raw of [undefined, null, ""]) expect(FuelLapWindow.parse(raw)).toBe(5);
  });

  it("parses the PI's string value", () => {
    expect(FuelLapWindow.parse("10")).toBe(10);
  });

  it("rounds and clamps into 1..FUEL_LAP_HISTORY_CAP instead of failing", () => {
    expect(FuelLapWindow.parse(0)).toBe(1);
    expect(FuelLapWindow.parse(-3)).toBe(1);
    expect(FuelLapWindow.parse(25)).toBe(20);
    expect(FuelLapWindow.parse(4.6)).toBe(5);
  });

  it("falls back to the default on garbage rather than failing the whole settings parse", () => {
    expect(FuelLapWindow.parse("abc")).toBe(5);
    expect(FuelLapWindow.safeParse({}).success).toBe(true);
  });
});
