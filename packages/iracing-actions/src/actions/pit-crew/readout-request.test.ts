import type { FuelStats } from "@iracedeck/sim-events-iracing";
import { describe, expect, it, vi } from "vitest";

import { buildTelemetryReadout, READOUT_KINDS } from "./readout-request.js";

// Real conversions: only the two helpers this module uses, from deck-core's source.
vi.mock("@iracedeck/deck-core", async () => {
  const units = await vi.importActual<typeof import("../../../../deck-core/src/unit-conversion.js")>(
    "../../../../deck-core/src/unit-conversion.js",
  );

  return { celsiusToFahrenheit: units.celsiusToFahrenheit, fuelToDisplayUnits: units.fuelToDisplayUnits };
});

const METRIC = 1;
const ENGLISH = 0;

function stats(partial: Partial<FuelStats>): (window: number) => FuelStats {
  return vi.fn(() => ({ lastLap: null, avg: null, avgLapTime: null, samples: 0, ...partial }));
}

describe("READOUT_KINDS", () => {
  it("lists the four kinds in PI order", () => {
    expect(READOUT_KINDS).toEqual(["fuel-last-lap", "fuel-average", "track-temp", "air-temp"]);
  });
});

describe("buildTelemetryReadout — fuel (issue #466)", () => {
  it("last lap in liters on metric", () => {
    expect(buildTelemetryReadout("fuel-last-lap", 5, { DisplayUnits: METRIC }, stats({ lastLap: 2.44 }))).toEqual({
      kind: "fuel-last-lap",
      value: 2.44,
      unit: "liters",
      laps: null,
    });
  });

  it("last lap in US gallons on imperial", () => {
    const r = buildTelemetryReadout("fuel-last-lap", 5, { DisplayUnits: ENGLISH }, stats({ lastLap: 3.78541 }));

    expect(r?.unit).toBe("gallons");
    expect(r?.value).toBeCloseTo(1, 4);
  });

  it("an unset DisplayUnits counts as metric — never gallons in a liters tail", () => {
    expect(buildTelemetryReadout("fuel-last-lap", 5, {}, stats({ lastLap: 2.44 }))).toMatchObject({
      value: 2.44,
      unit: "liters",
    });
  });

  it("the average asks for the key's window and reports the laps actually averaged, not the window", () => {
    const getStats = stats({ avg: 2.51, samples: 3 });
    const r = buildTelemetryReadout("fuel-average", 5, { DisplayUnits: METRIC }, getStats);

    expect(getStats).toHaveBeenCalledWith(5);
    expect(r).toEqual({ kind: "fuel-average", value: 2.51, unit: "liters", laps: 3 });
  });

  it("no valid lap yet: publishes the kind with a null value so the engineer can say so", () => {
    expect(buildTelemetryReadout("fuel-average", 5, { DisplayUnits: ENGLISH }, stats({}))).toEqual({
      kind: "fuel-average",
      value: null,
      unit: "gallons",
      laps: null,
    });
  });
});

describe("buildTelemetryReadout — temperatures (issue #466)", () => {
  it("track temperature from TrackTempCrew in Celsius on metric", () => {
    expect(buildTelemetryReadout("track-temp", 5, { DisplayUnits: METRIC, TrackTempCrew: 41.3 }, stats({}))).toEqual({
      kind: "track-temp",
      value: 41.3,
      unit: "celsius",
      laps: null,
    });
  });

  it("air temperature from AirTemp in Fahrenheit on imperial", () => {
    const r = buildTelemetryReadout("air-temp", 5, { DisplayUnits: ENGLISH, AirTemp: 23 }, stats({}));

    expect(r?.unit).toBe("fahrenheit");
    expect(r?.value).toBeCloseTo(73.4, 10);
  });

  it("a missing temperature reading publishes nothing — never 'zero degrees'", () => {
    expect(buildTelemetryReadout("track-temp", 5, { DisplayUnits: METRIC }, stats({}))).toBeNull();
    expect(buildTelemetryReadout("air-temp", 5, { DisplayUnits: METRIC, AirTemp: Number.NaN }, stats({}))).toBeNull();
  });

  it("never reads fuel history for a temperature", () => {
    const getStats = stats({});

    buildTelemetryReadout("air-temp", 5, { AirTemp: 20 }, getStats);

    expect(getStats).not.toHaveBeenCalled();
  });
});
