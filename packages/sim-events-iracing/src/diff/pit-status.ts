/**
 * Pit-service status transitions (issue #479).
 *
 * Emits `pitService.statusChanged { from, to }` whenever
 * `PlayerCarPitSvStatus` changes — covering "in progress" / "complete" /
 * the four positioning errors / "can't fix that". Closing transitions
 * (`* → None`) are silently absorbed: the engineer doesn't announce the
 * idle state. The translator suppresses the emit but still advances the
 * baseline, so the next non-`None` transition re-fires correctly.
 *
 * Seeded silently only on first tick or while off-track. We deliberately
 * do NOT seed on `PlayerCarInPitStall: true` — every one of the eight
 * callouts (InProgress, Complete, the four positioning errors, BadAngle,
 * CantFixThat) only ever fires while parked in the stall. Live-captured
 * telemetry (`master/local/telemetry-snapshot-20260505-192236.json`)
 * shows `IsOnTrack: true, PlayerCarInPitStall: true,
 * PlayerCarPitSvStatus: 1` (InProgress) during an active stop — re-seeding
 * here would silence the entire feature.
 *
 * Compare with `diffToggles`, which DOES re-seed in-stall: the toggle
 * bits flip as the crew completes each fuel/tire task — those are
 * servicing artifacts, not user intent. `PlayerCarPitSvStatus` is
 * precisely the in-stall signal we want narrated.
 *
 * No debounce: positioning errors are stable while the car sits in the
 * wrong spot, and `InProgress`/`Complete` are clean discrete transitions.
 */
import { PitSvStatus, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

export function diffPitStatus(state: TranslatorState, telemetry: TelemetryData, emit: EmitFn): void {
  const status = telemetry.PlayerCarPitSvStatus ?? PitSvStatus.None;
  const isOnTrack = telemetry.IsOnTrack ?? false;

  if (!state.pitStatusInitialized || !isOnTrack) {
    state.pitStatusInitialized = true;
    state.lastPitSvStatus = status;

    return;
  }

  if (status === state.lastPitSvStatus) return;

  // Suppress the closing transition (any → None) — the silent idle state
  // shouldn't surface as a callout. Advance the baseline so the next
  // genuine transition fires correctly.
  if (status !== PitSvStatus.None) {
    emit({ event: "pitService.statusChanged", data: { from: state.lastPitSvStatus, to: status } });
  }

  state.lastPitSvStatus = status;
}
