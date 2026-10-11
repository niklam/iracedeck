/**
 * Tire wear of a pit stop (issue #1108).
 *
 * Emits `tireWear.reported` once per stop the driver drove into, right behind
 * the exit `pitService.readbackRequested` of the same tick. A stored report
 * shares that exit fire's lifecycle: it is dropped exactly where
 * `diffPitReadback` cancels the fire, and otherwise follows it however often
 * the fire is re-armed.
 *
 * What the sim gives us (measured, `local/telemetry-watch-20260919-193233-855.jsonl`,
 * cut into `__fixtures__/tire-wear-stops-20260919.json`): the twelve
 * `<corner>wear<L|M|R>` readings refresh exactly once per stop, on the tick the
 * car arrives in its box, and then hold through service, departure and the
 * whole next stint — on track they never change. After a tire change they
 * still show the set that came OFF, so reading them as the car leaves the box
 * gives the summary of the stint just driven.
 *
 * The pipeline, one step per tick, all keyed off the per-tick `pending` queue
 * (this module runs right after `diffPitReadback`, so `diffPitLane`'s edges and
 * the readback's exit request of the same tick are already in it):
 *
 *   1. `pitLane.approaching` — drops a report still waiting, because this is
 *      the one event on which `diffPitReadback` cancels its exit fire; a report
 *      with no fire left to follow must not ride out on a later drive-through.
 *      `pitLane.entered` does NOT drop one: a re-entry that skips the approach
 *      zone (an `OnPitRoad` flicker at the pit-exit blend line) leaves the
 *      readback's exit fire armed, and it re-arms on the next on→off edge and
 *      plays.
 *   2. `pitStall.departed` — reads the report, only for a drive-in visit.
 *   3. `pitService.readbackRequested { reason: "exit" }` — publishes it.
 *
 * Whether a stall visit is a drive-in is the shared stall-visit rule's answer
 * (`diff/stall-visit.ts`, hoisted out of this module by #254): a garage start
 * ("Drive") and a tow into the stall both reach the box from a not-on-track /
 * not-in-world state, so neither is a stop and neither reports (maintainer
 * ruling on #1108).
 */
import type { TireCorner, TireCornerWear, TireWearReport, TireZone } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { StallVisit } from "./stall-visit.js";
import { readTireZoneValues, TIRE_CORNERS, zonesFromCarSides } from "./tire-zones.js";
import type { EmitFn, PendingEvent } from "./types.js";

/** In the tie-break order of the contract: inside, middle, outside. */
const ZONES: readonly TireZone[] = ["inside", "middle", "outside"];

/**
 * Build the report from the twelve tread readings, or `null` when there is
 * nothing trustworthy to report: any reading missing or non-finite, or all
 * twelve zero (a car with no wear model).
 *
 * The zones are named from the car's centreline (`zonesFromCarSides`): on the
 * left-side tires the sim's L is the outside shoulder and R the inside; on the
 * right-side tires it is the other way round. The capture confirms it — both
 * fronts wear lowest on the inside, the negative-camber signature.
 *
 * @internal Exported for testing.
 */
export function buildTireWearReport(telemetry: TelemetryData): TireWearReport | null {
  const readings = readTireZoneValues(telemetry, "wear");

  if (readings === null) return null;

  const corners = {} as Record<TireCorner, TireCornerWear>;
  let heaviest: { corner: TireCorner; zone: TireZone } | null = null;
  let heaviestTread = Infinity;

  TIRE_CORNERS.forEach((source, i) => {
    const left = readings[i * 3]! * 100;
    const middle = readings[i * 3 + 1]! * 100;
    const right = readings[i * 3 + 2]! * 100;
    const byZone = zonesFromCarSides(source.side, left, middle, right);

    // Strictly lower only, so a tie keeps the zone earlier in ZONES.
    let zone: TireZone = ZONES[0];

    for (const candidate of ZONES) {
      if (byZone[candidate] < byZone[zone]) zone = candidate;
    }

    corners[source.corner] = { ...byZone, tread: byZone[zone], zone };

    // Strictly lower only, so a tie keeps the corner earlier in TIRE_CORNERS.
    if (byZone[zone] < heaviestTread) {
      heaviestTread = byZone[zone];
      heaviest = { corner: source.corner, zone };
    }
  });

  // Unreachable with four finite corners; keeps the type honest.
  if (heaviest === null) return null;

  return { corners, heaviest };
}

function has(pending: ReadonlyArray<PendingEvent>, event: PendingEvent["event"]): boolean {
  return pending.some((p) => p.event === event);
}

/**
 * `stallVisit` is the tick's answer from `updateStallVisit`, which the caller
 * resolves once per tick and hands to every consumer. It is required so this
 * diff can never advance the latch a second time on a tick — see
 * `updateStallVisit`.
 */
export function diffTireWear(
  state: TranslatorState,
  telemetry: TelemetryData,
  emit: EmitFn,
  pending: ReadonlyArray<PendingEvent>,
  stallVisit: StallVisit,
): void {
  // A saved replay scrubbed through a pit stop never reaches this diff: it
  // reads `IsReplayPlaying === false` while `SimMode === "replay"`, which the
  // translator's guard has held back since #1324 (it used to be a gate here),
  // and the replay-entry wipe drops a stored report with the rest of the state.

  // 1. The readback cancels its exit fire on a fresh approach, and the report
  //    goes with it — one lifecycle, so the report can neither outlive the fire
  //    it waits for nor be lost while that fire still plays. Entering pit road
  //    cancels nothing in `diffPitReadback`, so it leaves a stored report alone.
  if (has(pending, "pitLane.approaching")) {
    state.tireWearReport = null;
  }

  // 2. Leaving the box: the readings are the ones taken on arrival, and the
  //    visit is a stop only if the car drove into it.
  if (stallVisit.departed) {
    state.tireWearReport = stallVisit.driveIn ? buildTireWearReport(telemetry) : null;
  }

  // 3. Behind the exit readback, from the same tick — never ahead of it.
  const exitReadback = pending.some((p) => p.event === "pitService.readbackRequested" && p.data.reason === "exit");

  if (exitReadback && state.tireWearReport !== null) {
    emit({ event: "tireWear.reported", data: state.tireWearReport });
    state.tireWearReport = null;
  }
}
