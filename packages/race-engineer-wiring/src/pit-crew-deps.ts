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
 *
 * Takes no `overrides`: `wireRaceEngineer` applies them over what this
 * returns, so accepting them here would let a caller pass ones that do nothing.
 */
/**
 * A family gate: on unless the user turned that callout off. Each family's
 * `*_CALLOUT_SETTING_KEYS` maps a callout id to its global-settings key, and an
 * absent key counts as on (#1350 replaces these gates).
 */
function optIn<Id extends string>(keys: Readonly<Record<Id, string>>): (id: Id) => boolean {
  return (id) => (getGlobalSettings() as Record<string, unknown>)[keys[id]] !== false;
}

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
    // The full-course caution sequence (issue #1127): the per-callout opt-ins,
    // the lineup the `caution.*` vocabulary reads at speak time, and the
    // translator's own caution phase — the boolean for the lap-time and
    // position-change silencings, the phase itself for the caution family,
    // which gates on WHICH stage the caution is in (the two pace-car callouts
    // because `paceCar.deployed` / `paceCar.off` also fire at a rolling start),
    // and the episode that scopes the lineup change's memory of the car last
    // named to one caution (issue #1286).
    getCautionCalloutEnabled: optIn<CautionCalloutId>(CAUTION_CALLOUT_SETTING_KEYS),
    getCautionLineup: () => sim.getCautionLineup(),
    getUnderFullCourseCaution: () => sim.isUnderFullCourseCaution(),
    getCautionPhase: () => sim.getCautionPhase(),
    getCautionEpisode: () => sim.getCautionEpisode(),
    getFlagCalloutEnabled: optIn<FlagCalloutId>(FLAG_CALLOUT_SETTING_KEYS),
    logger: logger.createScope("PitCrewScenarios"),
    getPitReadbackEnabled: optIn<PitReadbackCalloutId>(PIT_READBACK_CALLOUT_SETTING_KEYS),
    getPitActionsAllowed: () => sim.isPitActionsAllowed(),
    getPitServiceRequestsEnabled: () =>
      (getGlobalSettings() as Record<string, unknown>).calloutEnabledPitServiceRequests !== false,
    getReadbackSnapshot: () => sim.getReadbackSnapshot(),
    // The tire wear report after a pit stop (issue #1108), read live.
    getTireWearCalloutEnabled: optIn<TireWearCalloutId>(TIRE_WEAR_CALLOUT_SETTING_KEYS),
    getDamageCalloutEnabled: optIn<DamageCalloutId>(DAMAGE_CALLOUT_SETTING_KEYS),
    getPitStatusCalloutEnabled: optIn<PitStatusCalloutId>(PIT_STATUS_CALLOUT_SETTING_KEYS),
    getTrackConditionsCalloutEnabled: optIn<TrackConditionsCalloutId>(TRACK_CONDITIONS_CALLOUT_SETTING_KEYS),
    getIncidentCalloutEnabled: optIn<IncidentCalloutId>(INCIDENT_CALLOUT_SETTING_KEYS),
    getSessionStartCalloutEnabled: optIn<SessionStartCalloutId>(SESSION_START_CALLOUT_SETTING_KEYS),
    getSessionStartSnapshot: () => {
      const conditions = sim.getSessionStartConditions();

      if (!conditions) return null;

      const driverName = resolveActiveDriverName(voice.driverNames, "driver");

      // A voice with no name clips still briefs: the greeting is optional, the
      // rest of the brief is not about the name (#1284).
      return { ...conditions, driverName: driverName ?? "driver" };
    },
    getLapTimeCalloutEnabled: optIn<LapTimeCalloutId>(LAP_TIME_CALLOUT_SETTING_KEYS),
    getLapCompletedSnapshot: () => caches.lapCompleted(),
    getPositionCalloutEnabled: optIn<PositionCalloutId>(POSITION_CALLOUT_SETTING_KEYS),
    getQualifyingInvalidationCalloutEnabled: optIn<QualifyingInvalidationCalloutId>(
      QUALIFYING_INVALIDATION_CALLOUT_SETTING_KEYS,
    ),
    getQualifyingInvalidationSnapshot: () => sim.getQualifyingInvalidationSnapshot(),
    getRaceStatusCalloutEnabled: optIn<RaceStatusCalloutId>(RACE_STATUS_CALLOUT_SETTING_KEYS),
    getRaceFinishedFired: () => sim.isRaceFinished(),
    getRaceEndCalloutEnabled: optIn<RaceEndCalloutId>(RACE_END_CALLOUT_SETTING_KEYS),
    getRaceFinishedSnapshot: (): RaceFinishedSnapshot | null => {
      const finished = caches.raceFinished();

      if (!finished) return null;

      const driverName = resolveActiveDriverName(voice.driverNames, "driver");

      return driverName ? { ...finished, driverName } : null;
    },
    getRaceStartCalloutEnabled: optIn<RaceStartCalloutId>(RACE_START_CALLOUT_SETTING_KEYS),
    getRaceStartSnapshot: () => {
      const conditions = sim.getRaceStartConditions();

      if (!conditions) return null;

      const driverName = resolveActiveDriverName(voice.driverNames, "driver");

      // A voice with no name clips still briefs: the greeting is optional, the
      // rest of the brief is not about the name (#1284).
      return { ...conditions, driverName: driverName ?? "driver" };
    },
    getOvertakeCalloutEnabled: optIn<OvertakeCalloutId>(OVERTAKE_CALLOUT_SETTING_KEYS),
    getOvertakeDriverName: () => resolveActiveDriverName(voice.driverNames, "driver"),
    getLivePosition: () => sim.getLivePosition(),
    getOvertakeGate: getOvertakeGate,
    getPitBoxCalloutEnabled: optIn<PitBoxCalloutId>(PIT_BOX_CALLOUT_SETTING_KEYS),
    getAutoFuelCalloutEnabled: optIn<AutoFuelCalloutId>(AUTO_FUEL_CALLOUT_SETTING_KEYS),
    getSetupWarningMismatch: (kind) =>
      evaluateSetupWarning(kind, getGlobalSettings() as Record<string, unknown>, sim.getDriverSetupName()),
    getSpotterCalloutEnabled: optIn<SpotterCalloutId>(SPOTTER_CALLOUT_SETTING_KEYS),
    getSpotterTrackDirection: () => sim.getTrackDirection(),
    getSpotterStillThereIntervalMs: () =>
      resolveStillThereIntervalMs((getGlobalSettings() as Record<string, unknown>)[SPOTTER_STILL_THERE_SECONDS_KEY]),
    getSpotterNearestCarGapMeters: () => sim.getNearestCarGapMeters(),
    getPitWindowCalloutEnabled: optIn<PitWindowCalloutId>(PIT_WINDOW_CALLOUT_SETTING_KEYS),
    getRollingStartCalloutEnabled: optIn<RollingStartCalloutId>(ROLLING_START_CALLOUT_SETTING_KEYS),
    getStartLightCalloutEnabled: optIn<StartLightCalloutId>(START_LIGHT_CALLOUT_SETTING_KEYS),
    getFuelCalloutEnabled: optIn<FuelCalloutId>(FUEL_CALLOUT_SETTING_KEYS),
    getCornerNameCalloutEnabled: optIn<CornerNameCalloutId>(CORNER_NAME_CALLOUT_SETTING_KEYS),
    getCornerNameSnapshot: () => caches.cornerName(),
    getOpponentPitCalloutEnabled: optIn<OpponentPitCalloutId>(OPPONENT_PIT_CALLOUT_SETTING_KEYS),
    getOpponentPitLivePosition: resolvePendingCarLivePosition,
    getGapCalloutEnabled: optIn<GapCalloutId>(GAP_CALLOUT_SETTING_KEYS),
    getGapCooldownMs: () =>
      resolveGapCooldownMs((getGlobalSettings() as Record<string, unknown>).gapCalloutCooldownSeconds),
    getLiveGaps: () => sim.getLiveGaps(),
    getOpponentFlagCalloutEnabled: optIn<OpponentFlagCalloutId>(OPPONENT_FLAG_CALLOUT_SETTING_KEYS),
    getOpponentFlagLivePosition: resolvePendingCarLivePosition,
    getPitSpeedingCalloutEnabled: optIn<PitSpeedingCalloutId>(PIT_SPEEDING_CALLOUT_SETTING_KEYS),
    getPitLimiterCalloutEnabled: optIn<PitLimiterCalloutId>(PIT_LIMITER_CALLOUT_SETTING_KEYS),
    getNoLimiterCalloutEnabled: optIn<NoLimiterCalloutId>(NO_LIMITER_CALLOUT_SETTING_KEYS),
    getRaceEngineerMasterEnabled: () =>
      (getGlobalSettings() as Record<string, unknown>).pitCrewRaceEngineerEnabled === true,
    getRadarMasterEnabled: () => (getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled === true,
  };
}
