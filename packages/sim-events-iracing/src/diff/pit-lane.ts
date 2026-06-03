/**
 * Pit lane transitions.
 *
 * Emits:
 *   - pitLane.approaching — pit-entry signal, track-type aware:
 *       • Non-dirt-oval (road course / unknown / future types): car enters the
 *         approach zone *not* from pit road. Once fired, suppressed until the
 *         car is fully back on track.
 *       • Dirt oval: iRacing tows the car straight to the pit stall, bypassing
 *         the approach zone, so instead fire on the `OnPitRoad` false→true
 *         drive-in edge — but only when the car drove in rather than teleported
 *         straight into the box (teleport-to-stall stays silent).
 *   - pitLane.entered / exited — onPitRoad off→on / on→off transitions.
 *   - pitStall.entered / departed — inPitStall off→on / on→off transitions.
 *     Departed only fires while still on pit road (distinguishes from teleport out).
 */
import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import { TrackType } from "../track-type.js";
import type { EmitFn } from "./types.js";

export function diffPitLane(
  state: TranslatorState,
  telemetry: TelemetryData,
  trackType: TrackType,
  emit: EmitFn,
): void {
  const onPitRoad = telemetry.OnPitRoad ?? false;
  const inPitStall = telemetry.PlayerCarInPitStall ?? false;
  const trackSurface = telemetry.PlayerTrackSurface ?? TrkLoc.NotInWorld;
  const isApproaching = trackSurface === TrkLoc.AproachingPits && !onPitRoad;

  // First tick — seed from the current snapshot and bail. A translator that
  // boots while the car is already on pit road, in the stall, or in the
  // approach zone would otherwise synthesize `pitLane.entered`,
  // `pitStall.entered`, and `pitLane.approaching` on the first tick even
  // though no transition happened. Seeding `approachExitingSuppressed`
  // while already on pit road / approach is how the existing exit-zone
  // logic would have landed after observing the entry transition.
  if (!state.pitLaneInitialized) {
    state.pitLaneInitialized = true;
    state.lastOnPitRoad = onPitRoad;
    state.lastInPitStall = inPitStall;
    state.approachAlertFired = isApproaching;
    state.approachExitingSuppressed = onPitRoad || isApproaching;

    return;
  }

  // The OnPitRoad false→true edge: the same drive-in transition powers both
  // `pitLane.entered` and (on dirt ovals) the `pitLane.approaching` pit-entry signal.
  const enteredPitRoad = !state.lastOnPitRoad && onPitRoad;

  // ── Pit road on/off transitions ────────────────────────────────────────
  if (enteredPitRoad) {
    emit({ event: "pitLane.entered", data: {} });
  } else if (state.lastOnPitRoad && !onPitRoad) {
    emit({ event: "pitLane.exited", data: {} });
    // Flag the now-current lap as "from pits" so the qualifying
    // lap-invalidation snapshot (issue #567) suppresses the callout there.
    // Cleared by `diffLifecycle` at the next `lap.started` (S/F crossing).
    state.lapStartedFromPits = true;
  }

  // ── Pit stall on/off transitions ───────────────────────────────────────
  if (!state.lastInPitStall && inPitStall) {
    emit({ event: "pitStall.entered", data: {} });
  } else if (state.lastInPitStall && !inPitStall && onPitRoad) {
    // Departed only when still on pit road (ignore stall exit from teleport/reset)
    emit({ event: "pitStall.departed", data: {} });
  }

  // ── Approach zone (with exit suppression) ──────────────────────────────
  const isOnTrack = trackSurface === TrkLoc.OnTrack;
  const isExitingPits = state.lastOnPitRoad || state.approachExitingSuppressed;

  if (isApproaching && isExitingPits) {
    // Car is in the approach zone but coming FROM pit road — stay suppressed.
    state.approachExitingSuppressed = true;
  } else if (!isApproaching && !onPitRoad) {
    // Left approach zone cleanly — clear suppression.
    state.approachExitingSuppressed = false;
  }

  if (trackType === TrackType.DirtOval) {
    // Dirt oval: the approach zone is bypassed by iRacing's tow-to-stall, so
    // fire on the OnPitRoad drive-in edge instead. Suppress the teleport/tow
    // case — a car materialized directly in the box reports `PlayerCarInPitStall`
    // true and/or `PlayerTrackSurface` jumping straight to `InPitStall`, and has
    // nothing to "approach". The exit edge (OnPitRoad on→off) never fires here.
    if (enteredPitRoad && !inPitStall && trackSurface !== TrkLoc.InPitStall) {
      emit({ event: "pitLane.approaching", data: {} });
    }
  } else if (isApproaching && !state.approachAlertFired && !isExitingPits) {
    state.approachAlertFired = true;
    emit({ event: "pitLane.approaching", data: {} });
  } else if (isOnTrack && state.approachAlertFired) {
    // Rearm only when the car is fully back on track.
    state.approachAlertFired = false;
  }

  state.lastOnPitRoad = onPitRoad;
  state.lastInPitStall = inPitStall;
}
