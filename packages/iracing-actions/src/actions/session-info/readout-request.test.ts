import type { FuelStats } from "@iracedeck/sim-events-iracing";
import { describe, expect, it, vi } from "vitest";

import { buildTelemetryReadout, type ReadoutItem, readoutKindFor } from "./readout-request.js";

// Real conversions: only the two helpers this module uses, from deck-core's source.
vi.mock("@iracedeck/deck-core", async () => {
  const units = await vi.importActual<typeof import("../../../../deck-core/src/unit-conversion.js")>(
    "../../../../deck-core/src/unit-conversion.js",
  );

  return { celsiusToFahrenheit: units.celsiusToFahrenheit, fuelToDisplayUnits: units.fuelToDisplayUnits };
});

const METRIC = 1;
const ENGLISH = 0;

const LAST_LAP: ReadoutItem = { mode: "fuel", fuelSubMode: "lastLap", fuelLapWindow: 5 };
const AVERAGE: ReadoutItem = { mode: "fuel", fuelSubMode: "avgN", fuelLapWindow: 5 };
const TRACK_TEMP: ReadoutItem = { mode: "track-temp", fuelSubMode: "now", fuelLapWindow: 5 };
const AIR_TEMP: ReadoutItem = { mode: "air-temp", fuelSubMode: "now", fuelLapWindow: 5 };

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
    expect(readoutKindFor({ mode: "fuel", fuelSubMode: "now", fuelLapWindow: 5 })).toBeNull();
  });

  it("an item with no speech yet maps to nothing, whatever its fuel sub-mode", () => {
    expect(readoutKindFor({ mode: "incidents", fuelSubMode: "lastLap", fuelLapWindow: 5 })).toBeNull();
    expect(readoutKindFor({ mode: "laps-to-empty", fuelSubMode: "avgN", fuelLapWindow: 5 })).toBeNull();
    expect(readoutKindFor({ mode: "wind", fuelSubMode: "now", fuelLapWindow: 5 })).toBeNull();
  });
});

describe("buildTelemetryReadout — fuel (issue #466)", () => {
  it("last lap in liters on metric", () => {
    expect(buildTelemetryReadout(LAST_LAP, { DisplayUnits: METRIC }, stats({ lastLap: 2.44 }))).toEqual({
      kind: "fuel-last-lap",
      value: 2.44,
      unit: "liters",
      laps: null,
    });
  });

  it("last lap in US gallons on imperial", () => {
    const r = buildTelemetryReadout(LAST_LAP, { DisplayUnits: ENGLISH }, stats({ lastLap: 3.78541 }));

    expect(r?.unit).toBe("gallons");
    expect(r?.value).toBeCloseTo(1, 4);
  });

  it("an unset DisplayUnits counts as metric — never gallons in a liters tail", () => {
    expect(buildTelemetryReadout(LAST_LAP, {}, stats({ lastLap: 2.44 }))).toMatchObject({
      value: 2.44,
      unit: "liters",
    });
  });

  it("the average asks for the key's window and reports the laps actually averaged, not the window", () => {
    const getStats = stats({ avg: 2.51, samples: 3 });
    const r = buildTelemetryReadout({ ...AVERAGE, fuelLapWindow: 7 }, { DisplayUnits: METRIC }, getStats);

    expect(getStats).toHaveBeenCalledWith(7);
    expect(r).toEqual({ kind: "fuel-average", value: 2.51, unit: "liters", laps: 3 });
  });

  it("no valid lap yet: publishes the kind with a null value so the engineer can say so", () => {
    expect(buildTelemetryReadout(AVERAGE, { DisplayUnits: ENGLISH }, stats({}))).toEqual({
      kind: "fuel-average",
      value: null,
      unit: "gallons",
      laps: null,
    });
  });
});

describe("buildTelemetryReadout — temperatures (issue #466)", () => {
  it("track temperature from TrackTempCrew in Celsius on metric", () => {
    expect(buildTelemetryReadout(TRACK_TEMP, { DisplayUnits: METRIC, TrackTempCrew: 41.3 }, stats({}))).toEqual({
      kind: "track-temp",
      value: 41.3,
      unit: "celsius",
      laps: null,
    });
  });

  it("air temperature from AirTemp in Fahrenheit on imperial", () => {
    const r = buildTelemetryReadout(AIR_TEMP, { DisplayUnits: ENGLISH, AirTemp: 23 }, stats({}));

    expect(r?.unit).toBe("fahrenheit");
    expect(r?.value).toBeCloseTo(73.4, 10);
  });

  it("a missing temperature reading publishes nothing — never 'zero degrees'", () => {
    expect(buildTelemetryReadout(TRACK_TEMP, { DisplayUnits: METRIC }, stats({}))).toBeNull();
    expect(buildTelemetryReadout(AIR_TEMP, { DisplayUnits: METRIC, AirTemp: Number.NaN }, stats({}))).toBeNull();
  });

  it("never reads fuel history for a temperature", () => {
    const getStats = stats({});

    buildTelemetryReadout(AIR_TEMP, { AirTemp: 20 }, getStats);

    expect(getStats).not.toHaveBeenCalled();
  });
});

describe("buildTelemetryReadout — items with no speech (issue #466)", () => {
  it("builds nothing and reads nothing for Fuel → Now or a non-speaking item", () => {
    const getStats = stats({ lastLap: 2.4, avg: 2.5, samples: 5 });
    const telemetry = { DisplayUnits: METRIC, TrackTempCrew: 30, AirTemp: 20 };

    expect(buildTelemetryReadout({ ...LAST_LAP, fuelSubMode: "now" }, telemetry, getStats)).toBeNull();
    expect(buildTelemetryReadout({ ...LAST_LAP, mode: "incidents" }, telemetry, getStats)).toBeNull();
    expect(getStats).not.toHaveBeenCalled();
  });
});
