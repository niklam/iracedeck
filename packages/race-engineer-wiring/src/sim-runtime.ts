/**
 * The translator's query side as the Race Engineer reads it (#1349).
 *
 * One object, built once by the sim phase, so the wiring never imports a
 * translator's getters at a call site and the harness can pass the same
 * object. iRacing-shaped on purpose: a sim-neutral shape and a second
 * translator beside this one are #1351.
 */
import {
  getCautionEpisode,
  getCautionLineup,
  getCautionPhase,
  getDriverSetupName,
  getLiveCarPosition,
  getLiveGaps,
  getLivePosition,
  getNearestCarGapMeters,
  getOvertakeTelemetryGate,
  getQualifyingInvalidationSnapshot,
  getRaceStartConditions,
  getReadbackSnapshot,
  getSessionStartConditions,
  getTrackDirection,
  isPitActionsAllowed,
  isRaceFinished,
  isUnderFullCourseCaution,
} from "@iracedeck/sim-events-iracing";

export interface SimRuntime {
  readonly getCautionEpisode: typeof getCautionEpisode;
  readonly getCautionLineup: typeof getCautionLineup;
  readonly getCautionPhase: typeof getCautionPhase;
  readonly getDriverSetupName: typeof getDriverSetupName;
  readonly getLiveCarPosition: typeof getLiveCarPosition;
  readonly getLiveGaps: typeof getLiveGaps;
  readonly getLivePosition: typeof getLivePosition;
  readonly getNearestCarGapMeters: typeof getNearestCarGapMeters;
  readonly getOvertakeTelemetryGate: typeof getOvertakeTelemetryGate;
  readonly getQualifyingInvalidationSnapshot: typeof getQualifyingInvalidationSnapshot;
  readonly getRaceStartConditions: typeof getRaceStartConditions;
  readonly getReadbackSnapshot: typeof getReadbackSnapshot;
  readonly getSessionStartConditions: typeof getSessionStartConditions;
  readonly getTrackDirection: typeof getTrackDirection;
  readonly isPitActionsAllowed: typeof isPitActionsAllowed;
  readonly isRaceFinished: typeof isRaceFinished;
  readonly isUnderFullCourseCaution: typeof isUnderFullCourseCaution;
}

/** The iRacing translator's getters. The translator itself is initialised by the caller first. */
export function createIracingSimRuntime(): SimRuntime {
  return {
    getCautionEpisode,
    getCautionLineup,
    getCautionPhase,
    getDriverSetupName,
    getLiveCarPosition,
    getLiveGaps,
    getLivePosition,
    getNearestCarGapMeters,
    getOvertakeTelemetryGate,
    getQualifyingInvalidationSnapshot,
    getRaceStartConditions,
    getReadbackSnapshot,
    getSessionStartConditions,
    getTrackDirection,
    isPitActionsAllowed,
    isRaceFinished,
    isUnderFullCourseCaution,
  };
}
