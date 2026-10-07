import { celsiusToFahrenheit, fuelToDisplayUnits } from "@iracedeck/deck-iracing";
import type { TelemetryReadoutKind, TelemetryReadoutRequest } from "@iracedeck/event-bus";
import { DisplayUnits, type TelemetryData } from "@iracedeck/iracing-sdk";
import type { FuelStats } from "@iracedeck/sim-events-iracing";

import type { SessionInfoSettings } from "./session-info-settings.js";

/** The Session Info settings that name an item's readout: the item and its fuel sub-mode. */
export type ReadoutItem = Pick<SessionInfoSettings, "mode" | "fuelSubMode">;

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
 * The figure a speaking Session Info item shows on its key AND speaks on a
 * press (issue #466). One source for both surfaces, so the key and the voice
 * read the same field with the same missing-reading rule and the same unit
 * conversion; only the precision is each surface's own (the key rounds for
 * its face, the audio layer for speech). The result is the
 * `telemetryReadout.requested` payload, converted into the driver's display
 * unit at read time.
 *
 * A fuel item with no valid lap yet has a `null` value: the key shows `--`
 * and the engineer says there is no reading. A temperature the sim does not
 * report is `null` outright: the key shows `--` and nothing is published,
 * never "zero degrees".
 *
 * `DisplayUnits` unset counts as metric — the translator's convention. It is
 * normalized before `fuelToDisplayUnits`, which on its own reads `undefined`
 * as imperial.
 */
export function resolveReadoutFigure(
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
      return temperatureFigure(kind, telemetry.TrackTempCrew, metric);
    case "air-temp":
      return temperatureFigure(kind, telemetry.AirTemp, metric);
  }
}

function temperatureFigure(
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
