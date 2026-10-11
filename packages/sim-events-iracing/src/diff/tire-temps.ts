/**
 * Tire temperatures of the last pit stop (issue #254).
 *
 * Keeps `state.lastStopTireTemps`, the reading `getLastStopTireTemps()`
 * serves. Tracker-only: it emits no event — a key polls the accessor on its
 * render pass, the way it polls the fuel stats.
 *
 * What the sim gives us (maintainer ruling, 2026-10-05, the model #1108
 * measured for wear, and the two 2026-10-11 captures cut into
 * `__fixtures__/tire-temps-stops-20261011.json` and
 * `__fixtures__/tire-temps-tow-20261011.json`): the twelve
 * `<corner>tempC<L|M|R>` carcass temperatures are not live. iRacing refreshes
 * them at three moments and holds them unchanged in between, through the whole
 * next stint:
 *
 *   - as the car arrives in its pit stall for a stop — a few ticks BEFORE
 *     `PlayerCarInPitStall` (0.05 s to 0.4 s in the captures);
 *   - on the tick a tow or reset takes the car out of the world, one tick
 *     before it reads as standing in its box — where a timed tow then keeps it,
 *     the driver in the car, until `PlayerCarTowTime` has run out;
 *   - on the tick the driver leaves the car for the garage.
 *
 * Each time they describe the set that was on the car as it came in: after a
 * tire change, and after a reset that fits a fresh set, the set that came OFF.
 * So a reading is a summary of the run just driven.
 *
 * Nothing in the values says whether they are such a reading: a car placed in
 * the world carries whatever iRacing gave it (~50 °C, or near ambient). What
 * does say it is a CHANGE. On the circuit the sim holds the values still, so
 * `state.tireTempsOnCircuit` keeps them as last seen there, and the reading is
 * taken on the first tick that finds them different while the car is where a
 * run ends:
 *
 *   - **standing in its box** — a pit stop the driver drove into, or a tow or
 *     reset that put the car there (maintainer ruling, 2026-10-10). The two
 *     need no telling apart: either way the car has come in from the circuit
 *     and the sim has refreshed the values.
 *   - **out of the car** (same ruling) — the return to the garage.
 *
 * Taking the reading ends the run, and so does leaving the car: the held
 * values are dropped, and nothing is compared again until the car has been
 * back on the circuit. So every reading needs a run behind it and proof of a
 * refresh, which is what keeps these from ever being one:
 *
 *   - a garage "Drive" placement, whatever set the garage fitted — the driver
 *     left the car in between;
 *   - pulling out of the box and backing in again, or a reset pressed while
 *     standing in it, after a tire change — the stop already was the reading;
 *   - a car that clips its box without the sim refreshing anything — the
 *     values are still the ones it carried on the circuit, and the run goes on.
 *
 * The reading is one tick's values and does not follow the box afterwards: in
 * every captured stop the refresh came before `PlayerCarInPitStall` and the
 * values then held still through service. A refresh that lands later is taken
 * on the tick it lands.
 *
 * Leaving the car is a replay-mode tick, which never reaches the diffs behind
 * the translator's replay guard, so the translator calls
 * `readTireTempsLeavingCar` ahead of the guard on its entry tick.
 *
 * The reading's lifetime is the translator's, not this module's: it outlives
 * a replay visit and a session change, and a disconnect and a saved replay
 * clear it (`translator.ts`).
 */
import type { TireCorner } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import type { LastStopTireTemps, TireCornerTemps, TranslatorState } from "../state.js";
import { isDrivingOnCircuit } from "./stall-visit.js";
import { readTireZoneValues, TIRE_CORNERS, tireZoneValuesAre, zonesFromCarSides } from "./tire-zones.js";

/**
 * The reading from the twelve carcass temperatures (°C, unrounded) as
 * `readTireZoneValues` returns them. The zones are named from the car's
 * centreline by the tire wear report's own mapping (`zonesFromCarSides`), so
 * wear and temperature of one zone line up.
 */
function toReading(values: readonly number[]): LastStopTireTemps {
  const corners = {} as Record<TireCorner, TireCornerTemps>;

  TIRE_CORNERS.forEach((source, i) => {
    corners[source.corner] = zonesFromCarSides(source.side, values[i * 3]!, values[i * 3 + 1]!, values[i * 3 + 2]!);
  });

  return { corners };
}

/**
 * Build the reading from the twelve carcass temperatures, or `null` when
 * there is nothing trustworthy to read: any value missing or non-finite, or
 * all twelve zero (a car with no temperature model) — the rule the tire wear
 * report applies to wear (`readTireZoneValues`).
 *
 * @internal Exported for testing.
 */
export function buildLastStopTireTemps(telemetry: TelemetryData): LastStopTireTemps | null {
  const values = readTireZoneValues(telemetry, "tempC");

  return values === null ? null : toReading(values);
}

/**
 * Take the reading if the sim has refreshed the values since the car was last
 * driving on the circuit, and end the run with it. Without a run there is
 * nothing to compare against and nothing is taken; a tick whose values cannot
 * be trusted is skipped and leaves the comparison standing.
 */
function takeRefreshedReading(state: TranslatorState, telemetry: TelemetryData): void {
  const held = state.tireTempsOnCircuit;

  if (held === null || tireZoneValuesAre(telemetry, "tempC", held)) return;

  const values = readTireZoneValues(telemetry, "tempC");

  if (values === null) return;

  state.lastStopTireTemps = toReading(values);
  state.tireTempsOnCircuit = null;
}

/**
 * The driver has left the car: take the reading if the sim refreshed the
 * values as the run ended, and end the run either way — nothing the sim holds
 * from here on is compared against the circuit again.
 *
 * The translator calls this ahead of its replay guard, on the tick the guard
 * starts holding (the garage is replay-mode ticks) and never in a saved replay;
 * `diffTireTemps` calls it for an out-of-car tick that does reach it.
 */
export function readTireTempsLeavingCar(state: TranslatorState, telemetry: TelemetryData): void {
  takeRefreshedReading(state, telemetry);
  state.tireTempsOnCircuit = null;
}

export function diffTireTemps(state: TranslatorState, telemetry: TelemetryData): void {
  // Out of the car on a tick the replay guard let through.
  if (!(telemetry.IsOnTrack ?? false)) {
    readTireTempsLeavingCar(state, telemetry);

    return;
  }

  // On the circuit the sim holds the values still, so the latest tick is what
  // a refresh will be measured against — and through a stint it is the same
  // twelve values on every tick, re-read only when one of them moved.
  if (isDrivingOnCircuit(telemetry)) {
    const held = state.tireTempsOnCircuit;

    if (held === null || !tireZoneValuesAre(telemetry, "tempC", held)) {
      state.tireTempsOnCircuit = readTireZoneValues(telemetry, "tempC");
    }

    return;
  }

  // Standing in the box: a stop, a tow or a reset. Pit road and the
  // out-of-world ticks of a tow match no branch, so the values held on the
  // circuit ride through them untouched.
  if (telemetry.PlayerCarInPitStall ?? false) takeRefreshedReading(state, telemetry);
}
