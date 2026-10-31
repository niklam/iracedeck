import {
  type OvertakeGate,
  type PitCrewDeps,
  type RaceFinishedSnapshot,
  resolveGapCooldownMs,
  resolveStillThereIntervalMs,
  SPOTTER_STILL_THERE_SECONDS_KEY,
  type SpotterTrackDirection,
} from "@iracedeck/audio-scenarios/pit-crew";
import {
  evaluateSetupWarning,
  getGlobalSettings,
  isCalloutEnabled,
  resolveActiveDriverName,
} from "@iracedeck/settings";
import { TrackDirection } from "@iracedeck/sim-events-iracing";

import type { RaceEngineerCaches } from "./caches.js";
import type { RaceEngineerWiringDeps } from "./wire-race-engineer.js";

/**
 * The sim's track direction as the catalog's own union (#1378). The catalog
 * declares `"neutral" | "left" | "right"` structurally and never names the
 * translator's enum; this is the one place the two meet, exhaustive over the
 * enum so a new member fails `pnpm typecheck` here.
 */
const SPOTTER_TRACK_DIRECTION: Readonly<Record<TrackDirection, SpotterTrackDirection>> = {
  [TrackDirection.Neutral]: "neutral",
  [TrackDirection.Left]: "left",
  [TrackDirection.Right]: "right",
};

/**
 * Every `registerPitCrew` dependency (#1349).
 *
 * The callout opt-ins are one live-reading lookup, `isCalloutEnabled` from
 * @iracedeck/settings (#1350): each family in `registerPitCrew` resolves its own callout
 * id to a settings key through `@iracedeck/callout-settings`. The gate runs at
 * event-arrival time inside the scenario engine, before fire/expand, so a
 * mid-session toggle takes effect on the next event without re-registering
 * scenarios and without cutting a callout already playing. Per-key rationale
 * lives on `PitCrewDeps` in @iracedeck/audio-scenarios.
 *
 * Takes no `overrides`: `wireRaceEngineer` applies them over what this
 * returns, so accepting them here would let a caller pass ones that do nothing.
 */
export function buildPitCrewDeps(
  deps: Omit<RaceEngineerWiringDeps, "overrides">,
  caches: RaceEngineerCaches,
): Required<PitCrewDeps> {
  const { logger, sim, voice } = deps;

  // Compose the overtake gate from live telemetry + the tracked incident time.
  // Returns null when telemetry is unavailable (the scenario suppresses).
  const getOvertakeGate = (): OvertakeGate | null => {
    const gate = sim.getOvertakeTelemetryGate();

    if (!gate) return null;

    const at = caches.lastIncidentAt();

    return { ...gate, msSinceIncident: at === null ? null : Date.now() - at };
  };

  // Live speak-time position resolver shared by the opponent-pit (#622) and
  // opponent-flag (#936) callout families — one definition so the projection/
  // fallback logic can never drift between the two: the car's canonical
  // position at speak time, read in the projection the event was classified
  // in (the pending stash's isMultiClass, so a transient session-info dropout
  // can't flip a multi-class read to overall space). A null return falls back
  // to the emit-time payload position.
  const resolvePendingCarLivePosition = (pending: {
    carIdx: number;
    position: number;
    isMultiClass: boolean;
  }): number | null => {
    const live = sim.getLiveCarPosition(pending.carIdx);

    if (!live) return null;

    const n = pending.isMultiClass ? live.classPosition : live.position;

    return n > 0 ? n : null;
  };

  return {
    isCalloutEnabled,
    // The full-course caution sequence (issue #1127): the lineup the `caution.*`
    // vocabulary reads at speak time, and the translator's own caution
    // phase — the boolean for the lap-time, position-change, race-status and
    // two gap-callout silencings, the phase itself for the caution family,
    // which gates on WHICH stage the caution is in (the two pace-car callouts
    // because `paceCar.deployed` / `paceCar.off` also fire at a rolling start),
    // and the episode that scopes the lineup change's memory of the car last
    // named to one caution (issue #1286).
    getPaceLineup: () => sim.getPaceLineup(),
    getUnderFullCourseCaution: () => sim.isUnderFullCourseCaution(),
    getCautionPhase: () => sim.getCautionPhase(),
    getCautionEpisode: () => sim.getCautionEpisode(),
    // The rolling-start formation (issue #1167): its identity while one runs,
    // `null` otherwise. The three formation callouts gate on it not being
    // `null`, and the lineup change scopes its memory of the car last named to
    // its id, as the caution's does to the episode.
    getRollingStartFormation: () => sim.getRollingStartFormation(),
    // The caution catch-up (issue #1168): whether a call to close up is
    // warranted right now, read live. Both catch-up callouts ask it at speak
    // time, so one queued behind another line is refused once the driver has
    // closed up; `null` while the player holds no pace row.
    getCautionGap: () => sim.getCautionGap(),
    logger: logger.createScope("PitCrewScenarios"),
    getPitActionsAllowed: () => sim.isPitActionsAllowed(),
    getReadbackSnapshot: () => sim.getReadbackSnapshot(),
    getSessionStartSnapshot: () => {
      const conditions = sim.getSessionStartConditions();

      if (!conditions) return null;

      const driverName = resolveActiveDriverName(voice.driverNames, "driver");

      // A voice with no name clips still briefs: the greeting is optional, the
      // rest of the brief is not about the name (#1284).
      return { ...conditions, driverName: driverName ?? "driver" };
    },
    getLapCompletedSnapshot: () => caches.lapCompleted(),
    getQualifyingInvalidationSnapshot: () => sim.getQualifyingInvalidationSnapshot(),
    getRaceFinishedFired: () => sim.isRaceFinished(),
    getRaceFinishedSnapshot: (): RaceFinishedSnapshot | null => {
      const finished = caches.raceFinished();

      if (!finished) return null;

      const driverName = resolveActiveDriverName(voice.driverNames, "driver");

      return driverName ? { ...finished, driverName } : null;
    },
    getRaceStartSnapshot: () => {
      const conditions = sim.getRaceStartConditions();

      if (!conditions) return null;

      const driverName = resolveActiveDriverName(voice.driverNames, "driver");

      // A voice with no name clips still briefs: the greeting is optional, the
      // rest of the brief is not about the name (#1284).
      return { ...conditions, driverName: driverName ?? "driver" };
    },
    getOvertakeDriverName: () => resolveActiveDriverName(voice.driverNames, "driver"),
    getLivePosition: () => sim.getLivePosition(),
    getOvertakeGate: getOvertakeGate,
    getSetupWarningMismatch: (kind) => evaluateSetupWarning(kind, getGlobalSettings(), sim.getDriverSetupName()),
    getSpotterTrackDirection: () => SPOTTER_TRACK_DIRECTION[sim.getTrackDirection()],
    getSpotterStillThereIntervalMs: () =>
      resolveStillThereIntervalMs((getGlobalSettings() as Record<string, unknown>)[SPOTTER_STILL_THERE_SECONDS_KEY]),
    getSpotterNearestCarGapMeters: () => sim.getNearestCarGapMeters(),
    getCornerNameSnapshot: () => caches.cornerName(),
    getOpponentPitLivePosition: resolvePendingCarLivePosition,
    getGapCooldownMs: () =>
      resolveGapCooldownMs((getGlobalSettings() as Record<string, unknown>).gapCalloutCooldownSeconds),
    getLiveGaps: () => sim.getLiveGaps(),
    getOpponentFlagLivePosition: resolvePendingCarLivePosition,
    getRaceEngineerMasterEnabled: () =>
      (getGlobalSettings() as Record<string, unknown>).pitCrewRaceEngineerEnabled === true,
    getRadarMasterEnabled: () => (getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled === true,
    // The four reads the catalog used to take from the translator module
    // (#1378): raw telemetry, the session type name, the standing-start grid
    // and the debounced repair need, each passed through so the catalog reads
    // the sim only through its deps and the wiring reads it only through
    // `SimRuntime`.
    getLatestTelemetry: () => sim.getLatestTelemetry(),
    getSessionType: () => sim.getSessionType(),
    getStandingStart: () => sim.isStandingStart(),
    getDamageRepairNeeded: () => sim.isDamageRepairNeeded(),
  };
}
