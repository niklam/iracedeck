import { celsiusToFahrenheit, fuelToDisplayUnits } from "@iracedeck/deck-core";
import type { TelemetryReadoutKind, TelemetryReadoutRequest } from "@iracedeck/event-bus";
import { DisplayUnits, type TelemetryData } from "@iracedeck/iracing-sdk";
import type { FuelStats } from "@iracedeck/sim-events-iracing";

import type { SessionInfoSettings } from "./session-info.js";

/** The Session Info settings a readout reads: the item the key shows, and its fuel window. */
export type ReadoutItem = Pick<SessionInfoSettings, "mode" | "fuelSubMode" | "fuelLapWindow">;

/**
 * The readout a Session Info item speaks on a press (issue #466), or `null`
 * for an item with no speech yet — Fuel → Now among them. The return type is
 * left to inference on purpose: the check below reads it.
 */
export function readoutKindFor(item: ReadoutItem) {
  switch (item.mode) {
    case "fuel":
      if (item.fuelSubMode === "lastLap") return "fuel-last-lap";

      if (item.fuelSubMode === "avgN") return "fuel-average";

      return null;
    case "track-temp":
      return "track-temp";
    case "air-temp":
      return "air-temp";
    default:
      return null;
  }
}

// Compile-time: the items speak exactly the catalog's kinds — none left without
// an item, and no kind the catalog does not define.
type Spoken = NonNullable<ReturnType<typeof readoutKindFor>>;
const _allKinds: [Exclude<TelemetryReadoutKind, Spoken> | Exclude<Spoken, TelemetryReadoutKind>] extends [never]
  ? true
  : never = true;
void _allKinds;

/** The telemetry fields a readout reads. */
export type ReadoutTelemetry = Pick<TelemetryData, "DisplayUnits" | "TrackTempCrew" | "AirTemp">;

/**
 * Build the `telemetryReadout.requested` payload for one Session Info key
 * press (issue #466), or `null` when there is nothing to say: an item with no
 * speech yet, or a temperature the sim does not report. The value is converted
 * into the driver's display unit here, at press time, and never re-read.
 *
 * `DisplayUnits` unset counts as metric — the translator's convention. It is
 * normalized before `fuelToDisplayUnits`, which on its own reads `undefined`
 * as imperial.
 */
export function buildTelemetryReadout(
  item: ReadoutItem,
  telemetry: ReadoutTelemetry,
  getStats: (windowLaps: number) => FuelStats,
): TelemetryReadoutRequest | null {
  const kind = readoutKindFor(item);

  if (kind === null) return null;

  const metric = telemetry.DisplayUnits !== DisplayUnits.English;

  switch (kind) {
    case "fuel-last-lap":
    case "fuel-average": {
      const stats = getStats(item.fuelLapWindow);
      const liters = kind === "fuel-last-lap" ? stats.lastLap : stats.avg;
      const unit = metric ? "liters" : "gallons";

      if (liters === null) return { kind, value: null, unit, laps: null };

      return {
        kind,
        value: fuelToDisplayUnits(liters, metric ? DisplayUnits.Metric : DisplayUnits.English),
        unit,
        // The laps actually averaged — fewer than the window early in a stint.
        laps: kind === "fuel-average" ? stats.samples : null,
      };
    }
    case "track-temp":
      return temperatureReadout(kind, telemetry.TrackTempCrew, metric);
    case "air-temp":
      return temperatureReadout(kind, telemetry.AirTemp, metric);
  }
}

function temperatureReadout(
  kind: "track-temp" | "air-temp",
  celsius: number | undefined,
  metric: boolean,
): TelemetryReadoutRequest | null {
  if (typeof celsius !== "number" || !Number.isFinite(celsius)) return null;

  return {
    kind,
    value: metric ? celsius : celsiusToFahrenheit(celsius),
    unit: metric ? "celsius" : "fahrenheit",
    laps: null,
  };
}
