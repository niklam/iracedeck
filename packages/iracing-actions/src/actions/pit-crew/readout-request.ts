import { celsiusToFahrenheit, fuelToDisplayUnits } from "@iracedeck/deck-core";
import type { TelemetryReadoutKind, TelemetryReadoutRequest } from "@iracedeck/event-bus";
import { DisplayUnits, type TelemetryData } from "@iracedeck/iracing-sdk";
import type { FuelStats } from "@iracedeck/sim-events-iracing";

/**
 * The readouts a Telemetry Readout key can ask for (issue #466), in the order
 * the Property Inspector lists them.
 */
export const READOUT_KINDS = ["fuel-last-lap", "fuel-average", "track-temp", "air-temp"] as const;

// Compile-time: READOUT_KINDS covers the catalog's kinds exactly.
type Listed = (typeof READOUT_KINDS)[number];
const _allKinds: [Exclude<TelemetryReadoutKind, Listed> | Exclude<Listed, TelemetryReadoutKind>] extends [never]
  ? true
  : never = true;
void _allKinds;

/** The telemetry fields a readout reads. */
export type ReadoutTelemetry = Pick<TelemetryData, "DisplayUnits" | "TrackTempCrew" | "AirTemp">;

/**
 * Build the `telemetryReadout.requested` payload for one key press (issue
 * #466), or `null` when there is nothing true to say (a temperature the sim
 * does not report). The value is converted into the driver's display unit
 * here, at press time, and never re-read.
 *
 * `DisplayUnits` unset counts as metric — the translator's convention. It is
 * normalized before `fuelToDisplayUnits`, which on its own reads `undefined`
 * as imperial.
 */
export function buildTelemetryReadout(
  kind: TelemetryReadoutKind,
  fuelLapWindow: number,
  telemetry: ReadoutTelemetry,
  getStats: (windowLaps: number) => FuelStats,
): TelemetryReadoutRequest | null {
  const metric = telemetry.DisplayUnits !== DisplayUnits.English;

  switch (kind) {
    case "fuel-last-lap":
    case "fuel-average": {
      const stats = getStats(fuelLapWindow);
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
