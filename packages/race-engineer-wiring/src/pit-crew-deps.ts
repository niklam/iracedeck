import {
  AUTO_FUEL_CALLOUT_SETTING_KEYS,
  type AutoFuelCalloutId,
  CAUTION_CALLOUT_SETTING_KEYS,
  type CautionCalloutId,
  CORNER_NAME_CALLOUT_SETTING_KEYS,
  type CornerNameCalloutId,
  DAMAGE_CALLOUT_SETTING_KEYS,
  type DamageCalloutId,
  FLAG_CALLOUT_SETTING_KEYS,
  type FlagCalloutId,
  FUEL_CALLOUT_SETTING_KEYS,
  type FuelCalloutId,
  GAP_CALLOUT_SETTING_KEYS,
  type GapCalloutId,
  INCIDENT_CALLOUT_SETTING_KEYS,
  type IncidentCalloutId,
  LAP_TIME_CALLOUT_SETTING_KEYS,
  type LapTimeCalloutId,
  NO_LIMITER_CALLOUT_SETTING_KEYS,
  type NoLimiterCalloutId,
  OPPONENT_FLAG_CALLOUT_SETTING_KEYS,
  OPPONENT_PIT_CALLOUT_SETTING_KEYS,
  type OpponentFlagCalloutId,
  type OpponentPitCalloutId,
  OVERTAKE_CALLOUT_SETTING_KEYS,
  type OvertakeCalloutId,
  type OvertakeGate,
  PIT_BOX_CALLOUT_SETTING_KEYS,
  PIT_LIMITER_CALLOUT_SETTING_KEYS,
  PIT_READBACK_CALLOUT_SETTING_KEYS,
  PIT_SPEEDING_CALLOUT_SETTING_KEYS,
  PIT_STATUS_CALLOUT_SETTING_KEYS,
  PIT_WINDOW_CALLOUT_SETTING_KEYS,
  type PitBoxCalloutId,
  type PitCrewDeps,
  type PitLimiterCalloutId,
  type PitReadbackCalloutId,
  type PitSpeedingCalloutId,
  type PitStatusCalloutId,
  type PitWindowCalloutId,
  POSITION_CALLOUT_SETTING_KEYS,
  type PositionCalloutId,
  QUALIFYING_INVALIDATION_CALLOUT_SETTING_KEYS,
  type QualifyingInvalidationCalloutId,
  RACE_END_CALLOUT_SETTING_KEYS,
  RACE_START_CALLOUT_SETTING_KEYS,
  RACE_STATUS_CALLOUT_SETTING_KEYS,
  type RaceEndCalloutId,
  type RaceFinishedSnapshot,
  type RaceStartCalloutId,
  type RaceStatusCalloutId,
  resolveGapCooldownMs,
  resolveStillThereIntervalMs,
  ROLLING_START_CALLOUT_SETTING_KEYS,
  type RollingStartCalloutId,
  SESSION_START_CALLOUT_SETTING_KEYS,
  type SessionStartCalloutId,
  SPOTTER_CALLOUT_SETTING_KEYS,
  SPOTTER_STILL_THERE_SECONDS_KEY,
  type SpotterCalloutId,
  START_LIGHT_CALLOUT_SETTING_KEYS,
  type StartLightCalloutId,
  TIRE_WEAR_CALLOUT_SETTING_KEYS,
  type TireWearCalloutId,
  TRACK_CONDITIONS_CALLOUT_SETTING_KEYS,
  type TrackConditionsCalloutId,
} from "@iracedeck/audio-scenarios/pit-crew";
import { evaluateSetupWarning, getGlobalSettings, resolveActiveDriverName } from "@iracedeck/deck-core";

import type { RaceEngineerCaches } from "./caches.js";
import type { RaceEngineerWiringDeps } from "./wire-race-engineer.js";

/**
 * Every `registerPitCrew` dependency (#1349).
 *
 * Every opt-in below is a live-reading closure: the gate runs at
 * event-arrival time inside the scenario engine, before fire/expand, so a
 * mid-session toggle takes effect on the next event without re-registering
 * scenarios and without cutting a callout already playing. Per-key rationale
 * lives on `PitCrewDeps` in @iracedeck/audio-scenarios.
 */
export function buildPitCrewDeps(deps: RaceEngineerWiringDeps, caches: RaceEngineerCaches): Required<PitCrewDeps> {
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
    // The full-course caution sequence (issue #1127): the per-callout opt-ins,
    // the lineup the `caution.*` vocabulary reads at speak time, and the
    // translator's own caution phase — the boolean for the lap-time and
    // position-change silencings, the phase itself for the caution family,
    // which gates on WHICH stage the caution is in (the two pace-car callouts
    // because `paceCar.deployed` / `paceCar.off` also fire at a rolling start),
    // and the episode that scopes the lineup change's memory of the car last
    // named to one caution (issue #1286).
    getCautionCalloutEnabled: (id: CautionCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[CAUTION_CALLOUT_SETTING_KEYS[id]] !== false,
    getCautionLineup: () => sim.getCautionLineup(),
    getUnderFullCourseCaution: () => sim.isUnderFullCourseCaution(),
    getCautionPhase: () => sim.getCautionPhase(),
    getCautionEpisode: () => sim.getCautionEpisode(),
    getFlagCalloutEnabled: (id: FlagCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[FLAG_CALLOUT_SETTING_KEYS[id]] !== false,
    logger: logger.createScope("PitCrewScenarios"),
    getPitReadbackEnabled: (id: PitReadbackCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[PIT_READBACK_CALLOUT_SETTING_KEYS[id]] !== false,
    getPitActionsAllowed: () => sim.isPitActionsAllowed(),
    getPitServiceRequestsEnabled: () =>
      (getGlobalSettings() as Record<string, unknown>).calloutEnabledPitServiceRequests !== false,
    getReadbackSnapshot: () => sim.getReadbackSnapshot(),
    // The tire wear report after a pit stop (issue #1108), read live.
    getTireWearCalloutEnabled: (id: TireWearCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[TIRE_WEAR_CALLOUT_SETTING_KEYS[id]] !== false,
    getDamageCalloutEnabled: (id: DamageCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[DAMAGE_CALLOUT_SETTING_KEYS[id]] !== false,
    getPitStatusCalloutEnabled: (id: PitStatusCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[PIT_STATUS_CALLOUT_SETTING_KEYS[id]] !== false,
    getTrackConditionsCalloutEnabled: (id: TrackConditionsCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[TRACK_CONDITIONS_CALLOUT_SETTING_KEYS[id]] !== false,
    getIncidentCalloutEnabled: (id: IncidentCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[INCIDENT_CALLOUT_SETTING_KEYS[id]] !== false,
    getSessionStartCalloutEnabled: (id: SessionStartCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[SESSION_START_CALLOUT_SETTING_KEYS[id]] !== false,
    getSessionStartSnapshot: () => {
      const conditions = sim.getSessionStartConditions();

      if (!conditions) return null;

      const driverName = resolveActiveDriverName(voice.driverNames, "driver");

      // A voice with no name clips still briefs: the greeting is optional, the
      // rest of the brief is not about the name (#1284).
      return { ...conditions, driverName: driverName ?? "driver" };
    },
    getLapTimeCalloutEnabled: (id: LapTimeCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[LAP_TIME_CALLOUT_SETTING_KEYS[id]] !== false,
    getLapCompletedSnapshot: () => caches.lapCompleted(),
    getPositionCalloutEnabled: (id: PositionCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[POSITION_CALLOUT_SETTING_KEYS[id]] !== false,
    getQualifyingInvalidationCalloutEnabled: (id: QualifyingInvalidationCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[QUALIFYING_INVALIDATION_CALLOUT_SETTING_KEYS[id]] !== false,
    getQualifyingInvalidationSnapshot: () => sim.getQualifyingInvalidationSnapshot(),
    getRaceStatusCalloutEnabled: (id: RaceStatusCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[RACE_STATUS_CALLOUT_SETTING_KEYS[id]] !== false,
    getRaceFinishedFired: () => sim.isRaceFinished(),
    getRaceEndCalloutEnabled: (id: RaceEndCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[RACE_END_CALLOUT_SETTING_KEYS[id]] !== false,
    getRaceFinishedSnapshot: (): RaceFinishedSnapshot | null => {
      const finished = caches.raceFinished();

      if (!finished) return null;

      const driverName = resolveActiveDriverName(voice.driverNames, "driver");

      return driverName ? { ...finished, driverName } : null;
    },
    getRaceStartCalloutEnabled: (id: RaceStartCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[RACE_START_CALLOUT_SETTING_KEYS[id]] !== false,
    getRaceStartSnapshot: () => {
      const conditions = sim.getRaceStartConditions();

      if (!conditions) return null;

      const driverName = resolveActiveDriverName(voice.driverNames, "driver");

      // A voice with no name clips still briefs: the greeting is optional, the
      // rest of the brief is not about the name (#1284).
      return { ...conditions, driverName: driverName ?? "driver" };
    },
    getOvertakeCalloutEnabled: (id: OvertakeCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[OVERTAKE_CALLOUT_SETTING_KEYS[id]] !== false,
    getOvertakeDriverName: () => resolveActiveDriverName(voice.driverNames, "driver"),
    getLivePosition: () => sim.getLivePosition(),
    getOvertakeGate: getOvertakeGate,
    getPitBoxCalloutEnabled: (id: PitBoxCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[PIT_BOX_CALLOUT_SETTING_KEYS[id]] !== false,
    getAutoFuelCalloutEnabled: (id: AutoFuelCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[AUTO_FUEL_CALLOUT_SETTING_KEYS[id]] !== false,
    getSetupWarningMismatch: (kind) =>
      evaluateSetupWarning(kind, getGlobalSettings() as Record<string, unknown>, sim.getDriverSetupName()),
    getSpotterCalloutEnabled: (id: SpotterCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[SPOTTER_CALLOUT_SETTING_KEYS[id]] !== false,
    getSpotterTrackDirection: () => sim.getTrackDirection(),
    getSpotterStillThereIntervalMs: () =>
      resolveStillThereIntervalMs((getGlobalSettings() as Record<string, unknown>)[SPOTTER_STILL_THERE_SECONDS_KEY]),
    getSpotterNearestCarGapMeters: () => sim.getNearestCarGapMeters(),
    getPitWindowCalloutEnabled: (id: PitWindowCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[PIT_WINDOW_CALLOUT_SETTING_KEYS[id]] !== false,
    getRollingStartCalloutEnabled: (id: RollingStartCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[ROLLING_START_CALLOUT_SETTING_KEYS[id]] !== false,
    getStartLightCalloutEnabled: (id: StartLightCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[START_LIGHT_CALLOUT_SETTING_KEYS[id]] !== false,
    getFuelCalloutEnabled: (id: FuelCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[FUEL_CALLOUT_SETTING_KEYS[id]] !== false,
    getCornerNameCalloutEnabled: (id: CornerNameCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[CORNER_NAME_CALLOUT_SETTING_KEYS[id]] !== false,
    getCornerNameSnapshot: () => caches.cornerName(),
    getOpponentPitCalloutEnabled: (id: OpponentPitCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[OPPONENT_PIT_CALLOUT_SETTING_KEYS[id]] !== false,
    getOpponentPitLivePosition: resolvePendingCarLivePosition,
    getGapCalloutEnabled: (id: GapCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[GAP_CALLOUT_SETTING_KEYS[id]] !== false,
    getGapCooldownMs: () =>
      resolveGapCooldownMs((getGlobalSettings() as Record<string, unknown>).gapCalloutCooldownSeconds),
    getLiveGaps: () => sim.getLiveGaps(),
    getOpponentFlagCalloutEnabled: (id: OpponentFlagCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[OPPONENT_FLAG_CALLOUT_SETTING_KEYS[id]] !== false,
    getOpponentFlagLivePosition: resolvePendingCarLivePosition,
    getPitSpeedingCalloutEnabled: (id: PitSpeedingCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[PIT_SPEEDING_CALLOUT_SETTING_KEYS[id]] !== false,
    getPitLimiterCalloutEnabled: (id: PitLimiterCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[PIT_LIMITER_CALLOUT_SETTING_KEYS[id]] !== false,
    getNoLimiterCalloutEnabled: (id: NoLimiterCalloutId) =>
      (getGlobalSettings() as Record<string, unknown>)[NO_LIMITER_CALLOUT_SETTING_KEYS[id]] !== false,
    getRaceEngineerMasterEnabled: () =>
      (getGlobalSettings() as Record<string, unknown>).pitCrewRaceEngineerEnabled === true,
    getRadarMasterEnabled: () => (getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled === true,
  };
}
