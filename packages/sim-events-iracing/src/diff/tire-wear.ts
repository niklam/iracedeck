/**
 * Tire wear of a pit stop (issue #1108).
 *
 * Emits `tireWear.reported` once per stop the driver drove into, right behind
 * the exit `pitService.readbackRequested` of the same tick.
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
 *   1. `tireWearDroveOnCircuit` — set on a tick the car is driving on the
 *      circuit, cleared when the driver is out of the car or the car is out of
 *      the world, untouched on pit road so it survives the drive down the lane.
 *   2. `pitLane.entered` — drops a report still waiting from an earlier visit
 *      (its exit fire was cancelled by this re-entry, so it must not ride out
 *      on a later drive-through), and clears the flag when the car arrived on
 *      pit road already in its box: a tow or a teleport, never a drive-in.
 *   3. `pitStall.entered` — latches whether this stall visit is a drive-in.
 *   4. `pitStall.departed` — reads the report, only for a drive-in visit.
 *   5. `pitService.readbackRequested { reason: "exit" }` — publishes it.
 *
 * A garage start ("Drive") and a tow into the stall both reach the box from a
 * not-on-track / not-in-world state, so neither is a stop and neither reports
 * (maintainer ruling on #1108).
 */
import type { TireCorner, TireCornerWear, TireWearReport, TireZone } from "@iracedeck/event-bus";
import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn, PendingEvent } from "./types.js";

type WearField = keyof TelemetryData & `${"LF" | "RF" | "LR" | "RR"}wear${"L" | "M" | "R"}`;

type CornerSource = {
  corner: TireCorner;
  /** iRacing's L / M / R are the car's left / middle / right. */
  left: WearField;
  middle: WearField;
  right: WearField;
  /** Which side of the car the tire sits on — decides which shoulder is the inside. */
  side: "left" | "right";
};

/** In the tie-break order of the contract: lf, rf, lr, rr. */
const CORNERS: readonly CornerSource[] = [
  { corner: "lf", left: "LFwearL", middle: "LFwearM", right: "LFwearR", side: "left" },
  { corner: "rf", left: "RFwearL", middle: "RFwearM", right: "RFwearR", side: "right" },
  { corner: "lr", left: "LRwearL", middle: "LRwearM", right: "LRwearR", side: "left" },
  { corner: "rr", left: "RRwearL", middle: "RRwearM", right: "RRwearR", side: "right" },
];

/** In the tie-break order of the contract: inside, middle, outside. */
const ZONES: readonly TireZone[] = ["inside", "middle", "outside"];

/**
 * Build the report from the twelve tread readings, or `null` when there is
 * nothing trustworthy to report: any reading missing or non-finite, or all
 * twelve zero (a car with no wear model).
 *
 * The zones are named from the car's centreline: on the left-side tires the
 * sim's L is the outside shoulder and R the inside; on the right-side tires it
 * is the other way round. The capture confirms it — both fronts wear lowest on
 * the inside, the negative-camber signature.
 *
 * @internal Exported for testing.
 */
export function buildTireWearReport(telemetry: TelemetryData): TireWearReport | null {
  const readings: number[] = [];

  for (const source of CORNERS) {
    for (const field of [source.left, source.middle, source.right]) {
      const value = telemetry[field];

      if (typeof value !== "number" || !Number.isFinite(value)) return null;

      readings.push(value);
    }
  }

  if (readings.every((value) => value === 0)) return null;

  const corners = {} as Record<TireCorner, TireCornerWear>;
  let heaviest: { corner: TireCorner; zone: TireZone } | null = null;
  let heaviestTread = Infinity;

  for (const source of CORNERS) {
    const left = (telemetry[source.left] as number) * 100;
    const middle = (telemetry[source.middle] as number) * 100;
    const right = (telemetry[source.right] as number) * 100;
    const byZone: Record<TireZone, number> =
      source.side === "left" ? { inside: right, middle, outside: left } : { inside: left, middle, outside: right };

    // Strictly lower only, so a tie keeps the zone earlier in ZONES.
    let zone: TireZone = ZONES[0];

    for (const candidate of ZONES) {
      if (byZone[candidate] < byZone[zone]) zone = candidate;
    }

    corners[source.corner] = { ...byZone, tread: byZone[zone], zone };

    // Strictly lower only, so a tie keeps the corner earlier in CORNERS.
    if (byZone[zone] < heaviestTread) {
      heaviestTread = byZone[zone];
      heaviest = { corner: source.corner, zone };
    }
  }

  // Unreachable with four finite corners; keeps the type honest.
  if (heaviest === null) return null;

  return { corners, heaviest };
}

function has(pending: ReadonlyArray<PendingEvent>, event: PendingEvent["event"]): boolean {
  return pending.some((p) => p.event === event);
}

export function diffTireWear(
  state: TranslatorState,
  telemetry: TelemetryData,
  emit: EmitFn,
  pending: ReadonlyArray<PendingEvent>,
  replayOnlySession: boolean,
): void {
  // A saved replay scrubbed through a pit stop can read `IsReplayPlaying ===
  // false` while `SimMode === "replay"` (the diffPitsOpen / diffPitSpeeding
  // precedent) — nobody drove that stop, so nothing is read or kept.
  if (replayOnlySession) {
    state.tireWearDroveOnCircuit = false;
    state.tireWearStallDriveIn = false;
    state.tireWearReport = null;

    return;
  }

  const isOnTrack = telemetry.IsOnTrack ?? false;
  const onPitRoad = telemetry.OnPitRoad ?? false;
  const inPitStall = telemetry.PlayerCarInPitStall ?? false;
  const surface = telemetry.PlayerTrackSurface ?? TrkLoc.NotInWorld;

  // 1. Where the car came from. Pit-road ticks match neither branch, so the
  //    flag rides unchanged from the circuit to the box.
  if (!isOnTrack || surface === TrkLoc.NotInWorld) {
    state.tireWearDroveOnCircuit = false;
  } else if (!onPitRoad && !inPitStall) {
    state.tireWearDroveOnCircuit = true;
  }

  // 2. A new pit-road visit. A report still stored belongs to the previous
  //    visit, whose exit fire this re-entry cancelled. A car that arrives on pit
  //    road already in its box was put there (tow, reset, garage) — the same
  //    signature `diffPitLane`'s dirt-oval guard uses — so it did not drive in,
  //    even if the tick before it read "on the circuit".
  if (has(pending, "pitLane.entered")) {
    state.tireWearReport = null;
    state.tireWearStallDriveIn = false;

    if (inPitStall || surface === TrkLoc.InPitStall) state.tireWearDroveOnCircuit = false;
  }

  // 3. This stall visit is a stop only if the car drove into it.
  if (has(pending, "pitStall.entered")) {
    state.tireWearStallDriveIn = state.tireWearDroveOnCircuit;
  }

  // 4. Leaving the box: the readings are the ones taken on arrival.
  if (has(pending, "pitStall.departed")) {
    state.tireWearReport = state.tireWearStallDriveIn ? buildTireWearReport(telemetry) : null;
    state.tireWearStallDriveIn = false;
  }

  // 5. Behind the exit readback, from the same tick — never ahead of it.
  const exitReadback = pending.some((p) => p.event === "pitService.readbackRequested" && p.data.reason === "exit");

  if (exitReadback && state.tireWearReport !== null) {
    emit({ event: "tireWear.reported", data: state.tireWearReport });
    state.tireWearReport = null;
  }
}
