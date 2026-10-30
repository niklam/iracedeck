/**
 * The sim's query side as the Race Engineer reads it (#1349, #1378).
 *
 * One object, built once by the sim phase, so the wiring never imports a
 * translator's getters at a call site and the harness can pass the same
 * object. Declared member by member rather than derived from what the
 * translator happens to export, so the surface the catalog may read is this
 * list and nothing else. iRacing-shaped on purpose: the payload types are
 * the translator's own until #714 replaces them with a sim-neutral read
 * model, and nothing a deck host needs is added here (#1500 declares its
 * own interface in `plugin-runtime`).
 *
 * The only value imports are the getters {@link createIracingSimRuntime}
 * assembles; every payload type is imported type-only.
 */
import type {
  PitReadbackSnapshot,
  QualifyingInvalidationSnapshot,
  RaceStartConditions,
  SessionStartConditions,
} from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import {
  type CautionEpisode,
  type CautionGap,
  type CautionPhase,
  getCautionEpisode,
  getCautionGap,
  getCautionPhase,
  getDriverSetupName,
  getLatestTelemetry,
  getLiveCarPosition,
  getLiveGaps,
  getLivePosition,
  getNearestCarGapMeters,
  getOvertakeTelemetryGate,
  getPaceLineup,
  getQualifyingInvalidationSnapshot,
  getRaceStartConditions,
  getReadbackSnapshot,
  getRollingStartFormation,
  getSessionStartConditions,
  getSessionType,
  getStandingStart,
  getTrackDirection,
  isDamageRepairNeeded,
  isPitActionsAllowed,
  isRaceFinished,
  isUnderFullCourseCaution,
  type LiveGaps,
  type LivePosition,
  type OvertakeTelemetryGate,
  type PaceLineup,
  type RollingStartFormation,
  type TrackDirection,
} from "@iracedeck/sim-events-iracing";

/**
 * Every read the Race Engineer makes of the running sim. A member's
 * no-translator value — what it answers before the translator is initialised
 * or after it is reset — is on the member, so injecting nothing changes
 * nothing for a caller that wires no reader.
 */
export interface SimRuntime {
  /** WHICH caution is out (#1286): an id that never repeats plus its first readable follow car; `null` outside one. */
  getCautionEpisode(): CautionEpisode | null;
  /** The gap to the car you line up behind under caution, and whether closing it is warranted (#1168); `null` while the player holds no pace row. */
  getCautionGap(): CautionGap | null;
  /** WHICH stage the full-course caution is in (#1127); `"none"` outside one. */
  getCautionPhase(): CautionPhase;
  /** The loaded setup's file name, for the setup-mismatch warning (#625); `undefined` when unknown. */
  getDriverSetupName(): string | undefined;
  /** The latest telemetry tick as the sim reported it; `null` before the first tick or once disconnected. */
  getLatestTelemetry(): TelemetryData | null;
  /** One car's canonical live position in both projections (`race-positions.md`); `null` when unknown. */
  getLiveCarPosition(carIdx: number): LivePosition | null;
  /** The live gaps to the cars ahead and behind (#933); `null` when unavailable. */
  getLiveGaps(): LiveGaps | null;
  /** The player's canonical live position in both projections; `null` when unknown. */
  getLivePosition(): LivePosition | null;
  /** Distance in metres to the nearest car on track, for the spotter's clear buffer (#651); `null` when unavailable. */
  getNearestCarGapMeters(): number | null;
  /** The telemetry half of the overtake gate (#574); `null` when telemetry is unavailable. */
  getOvertakeTelemetryGate(): OvertakeTelemetryGate | null;
  /** The pace lineup the caution and formation callouts name cars from (#1127, #1167); `null` outside one. */
  getPaceLineup(): PaceLineup | null;
  /** The qualifying lap-invalidation snapshot (#567); `null` when it cannot be built. */
  getQualifyingInvalidationSnapshot(): QualifyingInvalidationSnapshot | null;
  /** The race-start brief's conditions (#568); `null` when they cannot be read. */
  getRaceStartConditions(): RaceStartConditions | null;
  /** The queued pit services as of the latest tick (#481); `null` when unavailable. */
  getReadbackSnapshot(): PitReadbackSnapshot | null;
  /** WHICH rolling-start formation is running (#1167); `null` while none is. */
  getRollingStartFormation(): RollingStartFormation | null;
  /** The session-start brief's conditions (#542); `null` when they cannot be read. */
  getSessionStartConditions(): SessionStartConditions | null;
  /** The sim's own session type name (`"Race"`, `"Practice"`, `"Lone Qualify"`, …); `""` when unavailable. */
  getSessionType(): string;
  /** The track's rotation direction, for the spotter's road / oval terminology (#651); `Neutral` when unknown. */
  getTrackDirection(): TrackDirection;
  /** Whether the car needs a repair, debounced by the translator (#1138); `null` before the first damage read. */
  isDamageRepairNeeded(): boolean | null;
  /** Whether the pit-service toggle confirmations may speak right now (#476). */
  isPitActionsAllowed(): boolean;
  /** Whether the race has finished for the player this session (#569). */
  isRaceFinished(): boolean;
  /** Whether the race starts from a standing grid rather than behind the pace car (#480); `false` when unknown. */
  isStandingStart(): boolean;
  /** Whether a full-course caution is out (#1127). */
  isUnderFullCourseCaution(): boolean;
}

/**
 * The iRacing translator's getters, the one implementation of
 * {@link SimRuntime}. The translator itself is initialised by the caller
 * first. The one member whose translator name differs is `isStandingStart`,
 * over the translator's `getStandingStart`.
 */
export function createIracingSimRuntime(): SimRuntime {
  return {
    getCautionEpisode,
    getCautionGap,
    getCautionPhase,
    getDriverSetupName,
    getLatestTelemetry,
    getLiveCarPosition,
    getLiveGaps,
    getLivePosition,
    getNearestCarGapMeters,
    getOvertakeTelemetryGate,
    getPaceLineup,
    getQualifyingInvalidationSnapshot,
    getRaceStartConditions,
    getReadbackSnapshot,
    getRollingStartFormation,
    getSessionStartConditions,
    getSessionType,
    getTrackDirection,
    isDamageRepairNeeded,
    isPitActionsAllowed,
    isRaceFinished,
    isStandingStart: getStandingStart,
    isUnderFullCourseCaution,
  };
}
