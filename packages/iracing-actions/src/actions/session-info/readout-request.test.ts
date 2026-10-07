import type { FuelStats } from "@iracedeck/sim-events-iracing";
import { describe, expect, it, vi } from "vitest";

import { type ReadoutItem, readoutKindFor, resolveReadoutFigure } from "./readout-request.js";

// Real conversions: only the two helpers this module uses, from deck-iracing's
// source. A plain factory, because the real barrel's IRacingAction extends a
// deck-core class this suite does not load.
vi.mock("@iracedeck/deck-iracing", async () => {
  const units = await vi.importActual<typeof import("../../../../deck-iracing/src/unit-conversion.js")>(
    "../../../../deck-iracing/src/unit-conversion.js",
  );

  return { celsiusToFahrenheit: units.celsiusToFahrenheit, fuelToDisplayUnits: units.fuelToDisplayUnits };
});

const METRIC = 1;
const ENGLISH = 0;

const LAST_LAP: ReadoutItem = { mode: "fuel", fuelSubMode: "lastLap" };
const AVERAGE: ReadoutItem = { mode: "fuel", fuelSubMode: "avgN" };
const TRACK_TEMP: ReadoutItem = { mode: "track-temp", fuelSubMode: "now" };
const AIR_TEMP: ReadoutItem = { mode: "air-temp", fuelSubMode: "now" };

function stats(partial: Partial<FuelStats>): (window: number) => FuelStats {
  return vi.fn(() => ({ lastLap: null, avg: null, avgLapTime: null, samples: 0, ...partial }));
}

describe("readoutKindFor (issue #466)", () => {
  it("maps each speaking Session Info item to its readout kind", () => {
    expect(readoutKindFor(LAST_LAP)).toBe("fuel-last-lap");
    expect(readoutKindFor(AVERAGE)).toBe("fuel-average");
    expect(readoutKindFor(TRACK_TEMP)).toBe("track-temp");
    expect(readoutKindFor(AIR_TEMP)).toBe("air-temp");
  });

  it("Fuel → Now does not speak yet", () => {
    expect(readoutKindFor({ mode: "fuel", fuelSubMode: "now" })).toBeNull();
  });

  it("an item with no speech yet maps to nothing, whatever its fuel sub-mode", () => {
    expect(readoutKindFor({ mode: "incidents", fuelSubMode: "lastLap" })).toBeNull();
    expect(readoutKindFor({ mode: "laps-to-empty", fuelSubMode: "avgN" })).toBeNull();
    expect(readoutKindFor({ mode: "wind", fuelSubMode: "now" })).toBeNull();
  });
});

describe("resolveReadoutFigure — fuel (issue #466)", () => {
  it("last lap in liters on metric", () => {
    expect(resolveReadoutFigure("fuel-last-lap", 5, { DisplayUnits: METRIC }, stats({ lastLap: 2.44 }))).toEqual({
      kind: "fuel-last-lap",
      value: 2.44,
      unit: "liters",
      laps: null,
    });
  });

  it("last lap in US gallons on imperial", () => {
    const r = resolveReadoutFigure("fuel-last-lap", 5, { DisplayUnits: ENGLISH }, stats({ lastLap: 3.78541 }));

    expect(r?.unit).toBe("gallons");
    expect(r?.value).toBeCloseTo(1, 4);
  });

  it("an unset DisplayUnits counts as metric — never gallons in a liters tail", () => {
    expect(resolveReadoutFigure("fuel-last-lap", 5, {}, stats({ lastLap: 2.44 }))).toMatchObject({
      value: 2.44,
      unit: "liters",
    });
  });

  it("the average asks for the key's window and reports the laps actually averaged, not the window", () => {
    const getStats = stats({ avg: 2.51, samples: 3 });
    const r = resolveReadoutFigure("fuel-average", 7, { DisplayUnits: METRIC }, getStats);

    expect(getStats).toHaveBeenCalledWith(7);
    expect(r).toEqual({ kind: "fuel-average", value: 2.51, unit: "liters", laps: 3 });
  });

  it("no valid lap yet: publishes the kind with a null value so the engineer can say so", () => {
    expect(resolveReadoutFigure("fuel-average", 5, { DisplayUnits: ENGLISH }, stats({}))).toEqual({
      kind: "fuel-average",
      value: null,
      unit: "gallons",
      laps: null,
    });
  });
});

describe("resolveReadoutFigure — temperatures (issue #466)", () => {
  it("track temperature from TrackTempCrew in Celsius on metric", () => {
    expect(resolveReadoutFigure("track-temp", 5, { DisplayUnits: METRIC, TrackTempCrew: 41.3 }, stats({}))).toEqual({
      kind: "track-temp",
      value: 41.3,
      unit: "celsius",
      laps: null,
    });
  });

  it("air temperature from AirTemp in Fahrenheit on imperial", () => {
    const r = resolveReadoutFigure("air-temp", 5, { DisplayUnits: ENGLISH, AirTemp: 23 }, stats({}));

    expect(r?.unit).toBe("fahrenheit");
    expect(r?.value).toBeCloseTo(73.4, 10);
  });

  it("a missing temperature reading publishes nothing — never 'zero degrees'", () => {
    expect(resolveReadoutFigure("track-temp", 5, { DisplayUnits: METRIC }, stats({}))).toBeNull();
    expect(resolveReadoutFigure("air-temp", 5, { DisplayUnits: METRIC, AirTemp: Number.NaN }, stats({}))).toBeNull();
  });

  it("never reads fuel history for a temperature", () => {
    const getStats = stats({});

    resolveReadoutFigure("air-temp", 5, { AirTemp: 20 }, getStats);

    expect(getStats).not.toHaveBeenCalled();
  });
});
