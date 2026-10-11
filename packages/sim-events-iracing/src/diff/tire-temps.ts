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
 * the world carries whatever iRacing gave it (~50 °C, or near ambient). Three
 * rules decide it, and `diffTireTemps` is the one place they live:
 *
 *   1. **A stop the car drove into**, by the shared stall-visit rule
 *      (`diff/stall-visit.ts`), with a run on the circuit behind it: on every
 *      tick from `pitStall.entered` to `pitStall.departed` the reading is
 *      replaced by the current values, so the key updates while the driver
 *      sits in the box, and it freezes as the car leaves. Reading on every
 *      tick of the visit rather than at one edge makes the arrival-time
 *      refresh safe whatever its exact tick is. A second entry into the box
 *      before the car has been back on the circuit — pulling out and backing
 *      in again — is not followed: the stall-visit rule still calls it a
 *      drive-in, but what the sim refreshes there is whatever the stop fitted.
 *   2. **A tow or reset into the box** (maintainer ruling, 2026-10-10): the car
 *      stands in its stall without having driven in, and the values are no
 *      longer the ones it carried on the circuit.
 *   3. **Leaving the car after a run** (same ruling): the driver is out of the
 *      car, and the values are no longer the ones it carried on the circuit.
 *
 * All three need a run on the circuit since the last reading
 * (`state.tireTempsRun`): driving on the circuit starts one, and taking a
 * reading or leaving the car ends it. Rules 2 and 3 also need proof that the
 * sim refreshed the values, which is a change from `state.tireTempsOnCircuit`,
 * the values as last seen while the car was driving there. That is what keeps
 * a garage "Drive" placement from ever being a reading: the driver left the
 * car in between, whatever set the garage fitted.
 *
 * Rule 3's tick is a replay-mode tick, which never reaches the diffs behind
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
import { isDrivingOnCircuit, type StallVisit } from "./stall-visit.js";
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
 * driving on the circuit. Without a run since the last reading there is
 * nothing to compare against and nothing is taken; a tick whose values cannot
 * be trusted is skipped and leaves the comparison standing.
 */
function takeRefreshedReading(state: TranslatorState, telemetry: TelemetryData): void {
  const held = state.tireTempsOnCircuit;

  if (state.tireTempsRun !== "driven" || held === null || tireZoneValuesAre(telemetry, "tempC", held)) return;

  const values = readTireZoneValues(telemetry, "tempC");

  if (values === null) return;

  state.lastStopTireTemps = toReading(values);
  endRun(state);
}

function endRun(state: TranslatorState): void {
  state.tireTempsRun = "none";
  state.tireTempsOnCircuit = null;
}

/**
 * The driver has left the car (rule 3): take the reading if the sim refreshed
 * the values as the run ended, and end the run either way — nothing the sim
 * holds from here on is compared against the circuit again.
 *
 * The translator calls this ahead of its replay guard, on the tick the guard
 * starts holding (the garage is replay-mode ticks) and never in a saved replay;
 * `diffTireTemps` calls it for an out-of-car tick that does reach it.
 */
export function readTireTempsLeavingCar(state: TranslatorState, telemetry: TelemetryData): void {
  takeRefreshedReading(state, telemetry);
  endRun(state);
}

export function diffTireTemps(state: TranslatorState, telemetry: TelemetryData, stallVisit: StallVisit): void {
  // 1. A stop the car drove into: follow the values through the whole visit,
  //    when it ends a run. The run is spent as the visit starts, so a second
  //    entry before the car is back on the circuit is not followed.
  if (stallVisit.driveIn) {
    if (state.tireTempsRun === "driven") {
      state.tireTempsRun = "in-stop";
      state.tireTempsOnCircuit = null;
    }

    if (state.tireTempsRun === "in-stop") {
      const reading = buildLastStopTireTemps(telemetry);

      // Unavailable is not a reading: a tick the values cannot be trusted on
      // neither becomes the reading nor erases the previous stop's.
      if (reading !== null) state.lastStopTireTemps = reading;

      if (stallVisit.departed) endRun(state);
    }

    return;
  }

  // A visit that ended with no departure edge is over all the same.
  if (state.tireTempsRun === "in-stop") endRun(state);

  // 3. Out of the car on a tick the replay guard let through.
  if (!(telemetry.IsOnTrack ?? false)) {
    readTireTempsLeavingCar(state, telemetry);

    return;
  }

  // On the circuit the sim holds the values still, so the latest tick is what
  // a refresh will be measured against — and through a stint it is the same
  // twelve values on every tick, re-read only when one of them moved.
  if (isDrivingOnCircuit(telemetry)) {
    const held = state.tireTempsOnCircuit;

    state.tireTempsRun = "driven";

    if (held === null || !tireZoneValuesAre(telemetry, "tempC", held)) {
      state.tireTempsOnCircuit = readTireZoneValues(telemetry, "tempC");
    }

    return;
  }

  // 2. Standing in the box without having driven in: a tow or a reset. The
  //    out-of-world ticks before it match no branch above, so the values held
  //    on the circuit are still there to compare against.
  if (telemetry.PlayerCarInPitStall ?? false) takeRefreshedReading(state, telemetry);
}
