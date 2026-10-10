/**
 * How the car reached its pit stall (issues #1108, #254).
 *
 * A car placed in its stall — a garage "Drive", a tow, a reset — enters and
 * leaves the box on the same stall edges as one that stopped there, so those
 * edges alone cannot tell a pit stop from a placement. This module tells them
 * apart by where the car came from: a stall visit is a **drive-in** only when
 * the car was last seen driving on the circuit and reached its box down pit
 * road. A garage start and a tow both reach the box from a not-on-track /
 * not-in-world state, so neither is a stop (maintainer ruling on #1108).
 *
 * The rule was `diffTireWear`'s own until #254, whose last-stop tire
 * temperatures need the same answer. It lives here, once, so the two families
 * cannot drift on what counts as a stop: `updateStallVisit` runs once per tick
 * and each consumer is handed the {@link StallVisit} it returns.
 *
 * One step per tick, keyed off the per-tick `pending` queue (so it runs after
 * `diffPitLane`, whose edges it reads):
 *
 *   1. `stallVisitDroveOnCircuit` — set on a tick the car is driving on the
 *      circuit, cleared when the driver is out of the car or the car is out of
 *      the world, untouched on pit road so it survives the drive down the lane.
 *   2. `pitLane.entered` — clears the flag when the car arrived on pit road
 *      already in its box: a tow or a teleport, never a drive-in.
 *   3. `pitStall.entered` — latches whether this stall visit is a drive-in.
 *   4. `pitStall.departed` — the visit's last tick; the latch is released
 *      behind the answer of that tick.
 */
import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { PendingEvent } from "./types.js";

/** What one tick's stall visit is — the answer `updateStallVisit` hands its consumers. */
export type StallVisit = {
  /**
   * The car is in a stall visit it drove into: true from the tick of
   * `pitStall.entered` through the tick of `pitStall.departed`, both included,
   * and on no other tick. False throughout a visit the car was placed into.
   */
  driveIn: boolean;
  /** The car left its box on this tick (`pitStall.departed`) — the last tick of the visit. */
  departed: boolean;
};

function has(pending: ReadonlyArray<PendingEvent>, event: PendingEvent["event"]): boolean {
  return pending.some((p) => p.event === event);
}

/**
 * Advance the stall-visit latch by one tick and answer what this tick's visit
 * is. Call it ONCE per tick: the departure tick releases the latch, so a second
 * call on that tick would answer "not a drive-in".
 */
export function updateStallVisit(
  state: TranslatorState,
  telemetry: TelemetryData,
  pending: ReadonlyArray<PendingEvent>,
): StallVisit {
  const isOnTrack = telemetry.IsOnTrack ?? false;
  const onPitRoad = telemetry.OnPitRoad ?? false;
  const inPitStall = telemetry.PlayerCarInPitStall ?? false;
  const surface = telemetry.PlayerTrackSurface ?? TrkLoc.NotInWorld;

  // 1. Where the car came from. Pit-road ticks match neither branch, so the
  //    flag rides unchanged from the circuit to the box.
  if (!isOnTrack || surface === TrkLoc.NotInWorld) {
    state.stallVisitDroveOnCircuit = false;
  } else if (!onPitRoad && !inPitStall) {
    state.stallVisitDroveOnCircuit = true;
  }

  // 2. How the car arrived on pit road. One that arrives already in its box was
  //    put there (tow, reset, garage) — the same signature `diffPitLane`'s
  //    dirt-oval guard uses — so it did not drive in, even if the tick before it
  //    read "on the circuit".
  if (has(pending, "pitLane.entered")) {
    state.stallVisitDriveIn = false;

    if (inPitStall || surface === TrkLoc.InPitStall) state.stallVisitDroveOnCircuit = false;
  }

  // 3. This stall visit is a stop only if the car drove into it.
  if (has(pending, "pitStall.entered")) {
    state.stallVisitDriveIn = state.stallVisitDroveOnCircuit;
  }

  // 4. Leaving the box ends the visit. The latch alone would outlive a visit
  //    that ends with no departure edge (`diffPitLane` emits none when the car
  //    leaves its box and pit road on one tick), so the answer also asks that
  //    the car is in the box now, or leaving it on this tick.
  const departed = has(pending, "pitStall.departed");
  const driveIn = state.stallVisitDriveIn && (inPitStall || departed);

  if (departed) state.stallVisitDriveIn = false;

  return { driveIn, departed };
}
