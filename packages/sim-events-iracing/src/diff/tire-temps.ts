/**
 * Tire temperatures of the last pit stop (issue #254).
 *
 * Keeps `state.lastStopTireTemps`, the reading `getLastStopTireTemps()`
 * serves. Tracker-only: it emits no event — a key polls the accessor on its
 * render pass, the way it polls the fuel stats.
 *
 * What the sim gives us (maintainer ruling, 2026-10-05, the model #1108
 * measured for wear): the twelve `<corner>tempC<L|M|R>` carcass temperatures
 * refresh only while the car is in its pit stall and hold unchanged through
 * the whole next stint — they are not live. After a tire change they still
 * describe the set that came OFF, so the reading is a summary of the stint
 * just driven.
 *
 * Nothing in the values says whether they are a stop reading: a car placed in
 * the world carries whatever iRacing gave it (~40 °C, or near ambient). So the
 * reading is taken only during a stall visit the car DROVE INTO, by the shared
 * stall-visit rule (`diff/stall-visit.ts`): on every tick from
 * `pitStall.entered` to `pitStall.departed` it is replaced by the current
 * values, so the key updates while the driver sits in the box, and it freezes
 * as the car leaves. Reading on every tick of the visit rather than at one
 * edge makes the arrival-time refresh — which the wear capture timed ~0.2 s
 * BEFORE `PlayerCarInPitStall` — safe whatever its exact tick is. A garage
 * "Drive" placement, a tow and a reset leave the previous reading in place.
 *
 * The reading's lifetime is the translator's, not this module's: it outlives
 * a replay visit and a session change, and a disconnect and a saved replay
 * clear it (`translator.ts`).
 */
import type { TireCorner } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import type { LastStopTireTemps, TireCornerTemps, TranslatorState } from "../state.js";
import type { StallVisit } from "./stall-visit.js";
import { type TireSide, zonesFromCarSides } from "./tire-zones.js";

type TempField = keyof TelemetryData & `${"LF" | "RF" | "LR" | "RR"}tempC${"L" | "M" | "R"}`;

type CornerSource = {
  corner: TireCorner;
  /** iRacing's L / M / R are the car's left / middle / right. */
  left: TempField;
  middle: TempField;
  right: TempField;
  side: TireSide;
};

const CORNERS: readonly CornerSource[] = [
  { corner: "lf", left: "LFtempCL", middle: "LFtempCM", right: "LFtempCR", side: "left" },
  { corner: "rf", left: "RFtempCL", middle: "RFtempCM", right: "RFtempCR", side: "right" },
  { corner: "lr", left: "LRtempCL", middle: "LRtempCM", right: "LRtempCR", side: "left" },
  { corner: "rr", left: "RRtempCL", middle: "RRtempCM", right: "RRtempCR", side: "right" },
];

/**
 * Build the reading from the twelve carcass temperatures (°C, unrounded), or
 * `null` when there is nothing trustworthy to read: any value missing or
 * non-finite, or all twelve zero (a car with no temperature model) — the rule
 * `buildTireWearReport` applies to wear.
 *
 * The zones are named from the car's centreline by the tire wear report's own
 * mapping (`zonesFromCarSides`), so wear and temperature of one zone line up.
 *
 * @internal Exported for testing.
 */
export function buildLastStopTireTemps(telemetry: TelemetryData): LastStopTireTemps | null {
  const readings: number[] = [];

  for (const source of CORNERS) {
    for (const field of [source.left, source.middle, source.right]) {
      const value = telemetry[field];

      if (typeof value !== "number" || !Number.isFinite(value)) return null;

      readings.push(value);
    }
  }

  if (readings.every((value) => value === 0)) return null;

  const corners = {} as Record<TireCorner, TireCornerTemps>;

  for (const source of CORNERS) {
    corners[source.corner] = zonesFromCarSides(
      source.side,
      telemetry[source.left] as number,
      telemetry[source.middle] as number,
      telemetry[source.right] as number,
    );
  }

  return { corners };
}

/**
 * Whether this tick's twelve values are a stop reading — the ONE place that
 * decides it. Today that is a tick of a stall visit the car drove into, and
 * nothing else: not a garage "Drive" placement, not a tow, not a reset.
 *
 * Two cases are still with the maintainer (the #254 spec's open questions) and
 * would each be a branch here: whether a refresh on escaping to the garage
 * after a run counts as a reading, and whether a tow does.
 */
function isStopReadingTick(stallVisit: StallVisit): boolean {
  return stallVisit.driveIn;
}

export function diffTireTemps(state: TranslatorState, telemetry: TelemetryData, stallVisit: StallVisit): void {
  if (!isStopReadingTick(stallVisit)) return;

  const reading = buildLastStopTireTemps(telemetry);

  // Unavailable is not a reading: a tick the values cannot be trusted on
  // neither becomes the reading nor erases the previous stop's.
  if (reading !== null) state.lastStopTireTemps = reading;
}
