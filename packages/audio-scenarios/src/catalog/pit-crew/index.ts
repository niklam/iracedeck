/**
 * Pit Crew scenario catalog registration.
 *
 * The engine wires:
 *   - The directional radar (state-driven tick loop, not expressible in the
 *     scenario DSL)
 *   - Every family's vocabulary — the vars, conditions and cases its
 *     scripts may name — through its `register<Family>Vocabulary(engine)`,
 *     before any contract is registered. No pool is registered here any
 *     more: `POOL_REGISTRY` emptied family by family through #1064/#1065
 *     and was deleted with the last one, because a script addresses its
 *     clips directly as `pool:<group>/<base>` (members derived per voice
 *     from the manifest at fire time, issue #664) and names a pool under
 *     its own `pools` only where the name carries a decision
 *   - The twenty-four toggle-confirmation contracts (fuel on/off, windshield
 *     and fast-repair on/off via `pitService.toggled`; every meaningful
 *     tire-set selection — singles, diagonals, three-corner combos, the full
 *     clear — via `tireService.changed`; dry/wet via
 *     `tireService.compoundChanged`) — scripted since #1065, each an
 *     `acknowledgment → line` pair in the voice's `callouts.json`
 *   - Pit-window, pit-box count-in, damage, pit-status (transitions, the
 *     #951 repeat nags and the #1180 empty-stop release), pit-limiter and
 *     no-limiter contracts — all scripted
 *     since #1065; the repeat nags and the two delayed limiter warnings hang
 *     their bodies on the `pitStatus.still*` / `limiter.still*` conditions
 *     registered here, and the no-limiter entry line reads its spoken limit
 *     through the `pitSpeed.*` vars
 *   - Flag alert contracts (every transition the translator publishes:
 *     yellow scope-aware, yellow.cleared, green, blue, white, red, black,
 *     checkered, debris, meatball, …) — the first family whose wording lives
 *     in the voice's script rather than here (issue #1064): the code
 *     registers the contract and the `session.*` / `flag.*` vocabulary, the
 *     active voice's `callouts.json` supplies what is said
 *   - Pit-service readback contracts (entry / exit off
 *     `pitService.readbackRequested`) — scripted the same way since #1065,
 *     with the `readback.*` vocabulary reading the queued-services snapshot
 *     at fire time
 *   - The tire-wear report after a pit stop (`tireWear.reported`, issue
 *     #1108), whose `tireWear.*` vocabulary reads the event's own payload
 *   - The telemetry readouts on a Session Info key press (`telemetryReadout.requested`,
 *     issue #466) — the first callouts a deck action triggers; gated by the
 *     Race Engineer master only, since pressing the key is the opt-in
 *   - Laps-of-fuel-left contracts (counts 10 → 1 plus the box-this-lap call,
 *     via `fuel.lapsLeft.crossed` — issue #838; scripted since #1065)
 *
 * Nothing in this directory is dormant. The six never-registered files that
 * used to be parked here (welcome, racing tips, pit-approach, pit-exit,
 * stall-departure, service-reminder — no clips, no pools, no test) were
 * deleted in #1065; git keeps their intent. A callout that does not exist
 * yet is built as a contract here plus a script entry in the voice's
 * `callouts.json`, never staged as an unregistered file waiting for content.
 *
 * This list named incident alerts and the limiter family as dormant until
 * #1051; both are registered now (see the `INCIDENT_CONTRACTS` loop and the
 * two limiter families below). Treat prose in this file as a summary that can lag
 * the code, never as evidence that something is unwired — count the
 * references instead.
 *
 * `bus` is the event bus instance returned by `initializeEventBus(...)`;
 * passed through to `registerRadarEngine` so the radar engine and the
 * scenario engine share the same bus. Must be called once per plugin
 * startup, AFTER `initializeAudioScenarios(bus, …)`.
 *
 * `isCalloutEnabled` is consulted on every gated event arrival to decide
 * whether to fire the callout (issue #467; one lookup for every family since
 * #1350, each family resolving its own callout id to a settings key through
 * `@iracedeck/callout-settings`). It is read live, so a user toggling a
 * callout off mid-session takes effect on the very next event — without
 * cancelling a callout already playing, because the gate runs before
 * `attemptFire` (which owns expansion, preemption, and channel playback).
 * Default `() => true` preserves legacy behavior for callers that don't pass
 * the closure (e.g. tests).
 *
 * `getReadbackSnapshot` is consulted at fire time inside every `readback.*`
 * condition and case the pit-readback scripts branch on (issue #481; the
 * vocabulary is registered by `registerReadbackVocabulary`, since #1065 —
 * the two readback contracts themselves read nothing but the event). Plugins
 * wire it to `getReadbackSnapshot()` from `@iracedeck/sim-events-iracing` so
 * a deferred-replay readback (deferred behind a busier bus, or stashed when
 * an `interrupt` line cuts it) speaks the *current* queued-services state,
 * not the one frozen into the original event payload.
 */
import {
  AUTO_FUEL_CALLOUTS,
  type CalloutIdOf,
  calloutKey,
  type CalloutSettingKey,
  CAUTION_CALLOUTS,
  CORNER_NAME_CALLOUTS,
  DAMAGE_CALLOUTS,
  FLAG_CALLOUTS,
  FUEL_CALLOUTS,
  GAP_CALLOUTS,
  INCIDENT_CALLOUTS,
  LAP_TIME_CALLOUTS,
  NO_LIMITER_CALLOUTS,
  OPPONENT_FLAG_CALLOUTS,
  OPPONENT_PIT_CALLOUTS,
  OVERTAKE_CALLOUTS,
  PIT_BOX_CALLOUTS,
  PIT_LIMITER_CALLOUTS,
  PIT_READBACK_CALLOUTS,
  PIT_SERVICE_REQUEST_CALLOUTS,
  PIT_SPEEDING_CALLOUTS,
  PIT_STATUS_CALLOUTS,
  PIT_WINDOW_CALLOUTS,
  POSITION_CALLOUTS,
  QUALIFYING_INVALIDATION_CALLOUTS,
  RACE_END_CALLOUTS,
  RACE_START_CALLOUTS,
  RACE_STATUS_CALLOUTS,
  type RegisteredCalloutFamily,
  ROLLING_START_CALLOUTS,
  SESSION_START_CALLOUTS,
  SPOTTER_CALLOUTS,
  START_LIGHT_CALLOUTS,
  TIRE_WEAR_CALLOUTS,
  TRACK_CONDITIONS_CALLOUTS,
} from "@iracedeck/callout-settings";
import type { IEventBus, PitReadbackSnapshot, SessionStartSnapshot } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";
import { TrackDirection } from "@iracedeck/sim-events-iracing";

import type { ScenarioContract } from "../../dsl.js";
import { getScenarioEngine, isAudioScenariosInitialized } from "../../interpreter.js";
import {
  buildCautionContracts,
  type CautionEpisodeResolver,
  type CautionLineupResolver,
  type CautionPhaseResolver,
  registerCautionVocabulary,
  SCENARIO_ID_TO_CAUTION_ID,
  type UnderCautionResolver,
} from "./caution.js";
import {
  buildCornerNameContract,
  type CornerNameSnapshotResolver,
  registerCornerNameVocabulary,
  SCENARIO_ID_TO_CORNER_NAME_ID,
} from "./corner-name.js";
import { DAMAGE_CONTRACTS } from "./damage-alerts.js";
import { FLAG_CONTRACTS, registerFlagVocabulary } from "./flag-alerts.js";
import { FUEL_LAPS_LEFT_CONTRACTS } from "./fuel-laps-left.js";
import {
  buildGapThresholdContract,
  buildGapTrendContract,
  GAP_CALLOUT_DEFAULT_COOLDOWN_MS,
  type LiveGapsResolver,
  registerGapVocabulary,
  SCENARIO_ID_TO_GAP_ID,
} from "./gaps.js";
import { INCIDENT_CONTRACTS, registerIncidentVocabulary } from "./incidents.js";
import {
  buildLapTimeContract,
  type LapCompletedSnapshotResolver,
  registerLapTimeVocabulary,
  SCENARIO_ID_TO_LAP_TIME_ID,
} from "./lap-time.js";
import { NO_LIMITER_CONTRACTS, registerNoLimiterVocabulary, SCENARIO_ID_TO_NO_LIMITER_ID } from "./no-limiter.js";
import {
  OPPONENT_FLAG_CONTRACTS,
  OPPONENT_FLAG_OTHERS_SCENARIO_ID,
  type OpponentFlagLivePositionResolver,
  registerOpponentFlagVocabulary,
  SCENARIO_ID_TO_OPPONENT_FLAG_ID,
} from "./opponent-flags.js";
import {
  OPPONENT_PIT_CONTRACTS,
  type OpponentPitLivePositionResolver,
  registerOpponentPitVocabulary,
  SCENARIO_ID_TO_OPPONENT_PIT_ID,
} from "./opponent-pit.js";
import { type OvertakeGateResolver, PERMISSIVE_OVERTAKE_GATE } from "./overtake-gate.js";
import {
  buildOvertakeGainedContract,
  buildOvertakeLostContract,
  type OvertakeDriverNameResolver,
  registerOvertakeVocabulary,
  SCENARIO_ID_TO_OVERTAKE_ID,
} from "./overtake.js";
import { PIT_BOX_CONTRACTS } from "./pit-box.js";
import { PIT_LIMITER_CONTRACTS, registerPitLimiterVocabulary, SCENARIO_ID_TO_PIT_LIMITER_ID } from "./pit-limiter.js";
import { registerPitSpeedingEngine } from "./pit-speeding-engine.js";
import {
  PIT_STATUS_CONTRACTS,
  PIT_STATUS_NOTHING_TO_DO_CONTRACT,
  PIT_STATUS_NOTHING_TO_DO_SCENARIO_ID,
  PIT_STATUS_REPEAT_CONTRACTS,
  registerPitStatusVocabulary,
} from "./pit-status.js";
import { PIT_WINDOW_CONTRACTS } from "./pit-window.js";
import {
  buildOvertakeGainedPositionContract,
  buildOvertakeLostPositionContract,
  type LivePositionResolver,
  registerPositionReadoutVocabulary,
} from "./position-readout.js";
import { buildPositionContract, registerPositionVocabulary, SCENARIO_ID_TO_POSITION_ID } from "./position.js";
import {
  buildQualifyingInvalidationContract,
  type QualifyingInvalidationSnapshotResolver,
  registerQualifyingInvalidationVocabulary,
  SCENARIO_ID_TO_QUALIFYING_INVALIDATION_ID,
} from "./qualifying-invalidation.js";
import {
  buildRaceEndContract,
  type RaceFinishedSnapshotResolver,
  registerRaceEndVocabulary,
  SCENARIO_ID_TO_RACE_END_ID,
} from "./race-end.js";
import {
  buildRaceStartContract,
  type RaceStartSnapshotResolver,
  registerRaceStartVocabulary,
  SCENARIO_ID_TO_RACE_START_ID,
  type SetupWarningResolver,
} from "./race-start.js";
import { buildRaceStatusContract, registerRaceStatusVocabulary, SCENARIO_ID_TO_RACE_STATUS_ID } from "./race-status.js";
import { registerRadarEngine } from "./radar-engine.js";
import { PIT_READBACK_CONTRACTS, registerReadbackVocabulary, SCENARIO_ID_TO_PIT_READBACK_ID } from "./readback.js";
import { ROLLING_START_CONTRACTS } from "./rolling-start.js";
import {
  buildSessionStartContract,
  registerSessionStartVocabulary,
  SCENARIO_ID_TO_SESSION_START_ID,
} from "./session-start.js";
import { registerSpotterEngine, SPOTTER_STILL_THERE_DEFAULT_MS } from "./spotter-engine.js";
import { START_LIGHT_CONTRACTS } from "./start-lights.js";
import { registerTelemetryReadoutVocabulary, TELEMETRY_READOUT_CONTRACTS } from "./telemetry-readout.js";
import { registerTireWearVocabulary, TIRE_WEAR_CONTRACTS } from "./tire-wear.js";
import { AUTO_FUEL_CONTRACTS, TOGGLE_CONFIRMATION_CONTRACTS } from "./toggle-confirmations.js";
import { TRACK_CONDITIONS_CONTRACTS } from "./track-conditions.js";

/**
 * Stop any in-flight Race Engineer callout (and its looping ambient bed) and
 * free the scenario bus. Call this when the Race Engineer master gate is
 * toggled off so a mid-callout disable stops cleanly — otherwise the ambient
 * loop is orphaned (only muted by the bus volume, audible again on re-enable)
 * and the stuck `playingId` drops every later callout as "bus busy" for the
 * rest of the session (issue #587). No-op before the engine is initialized.
 */
export function stopRaceEngineerScenarios(): void {
  if (!isAudioScenariosInitialized()) return;

  getScenarioEngine().stopAll();
}

export { isBackgroundTestInFlight, playBackgroundTest } from "./background-test.js";
// The Race Engineer's section of the Telemetry Snapshot (issue #1387). Here
// rather than in the package's root barrel: the root is the engine and
// imports no sim package, and the reader aggregates this catalog's families.
export {
  raceEngineerStateHeadline,
  type RaceEngineerFamiliesState,
  type RaceEngineerState,
  readRaceEngineerState,
} from "./debug-state.js";
export { driverNameClipPath } from "./driver-name-clip.js";
export {
  getRadarVisualState,
  playRadarTest,
  setRadarEnabled,
  type RadarVisualState,
  subscribeRadarVisualState,
} from "./radar-engine.js";
export {
  registerSpotterEngine,
  resolveStillThereIntervalMs,
  SPOTTER_STILL_THERE_DEFAULT_MS,
  SPOTTER_STILL_THERE_DEFAULT_SECONDS,
  SPOTTER_STILL_THERE_MAX_SECONDS,
  SPOTTER_STILL_THERE_MIN_SECONDS,
} from "./spotter-engine.js";
export {
  PIT_READBACK_CONTRACTS,
  PIT_READBACK_SCENARIO_IDS,
  type PitReadbackCalloutId,
  type ReadbackSnapshotResolver,
} from "./readback.js";
export { type PitLimiterCalloutId, PIT_LIMITER_SCENARIO_IDS } from "./pit-limiter.js";
export {
  registerTireWearVocabulary,
  TIRE_WEAR_CLIP_SOURCES,
  TIRE_WEAR_CONTRACTS,
  TIRE_WEAR_SCENARIO_IDS,
  type TireWearSpotKey,
} from "./tire-wear.js";
export {
  registerTelemetryReadoutVocabulary,
  TELEMETRY_READOUT_CLIP_SOURCES,
  TELEMETRY_READOUT_CONTRACTS,
  TELEMETRY_READOUT_SCENARIO_IDS,
} from "./telemetry-readout.js";
export { type NoLimiterCalloutId, NO_LIMITER_SCENARIO_IDS } from "./no-limiter.js";
export {
  buildCornerNameContract,
  type CornerNameCalloutId,
  type CornerNameSnapshot,
  type CornerNameSnapshotResolver,
} from "./corner-name.js";
export {
  buildCautionContracts,
  CAUTION_FOLLOW_DELAY_MS,
  CAUTION_LINEUP_CHANGE_DELAY_MS,
  CAUTION_SCENARIO_IDS,
  type CautionCalloutId,
  type CautionContractDeps,
  type CautionEpisodeResolver,
  type CautionLineupResolver,
  type CautionPhaseResolver,
  registerCautionVocabulary,
  SCENARIO_ID_TO_CAUTION_ID,
  type UnderCautionResolver,
} from "./caution.js";
export {
  OPPONENT_FLAG_CLIP_SOURCES,
  OPPONENT_FLAG_CONTRACTS,
  OPPONENT_FLAG_SCENARIO_IDS,
  OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID,
  type OpponentFlagCalloutId,
  type OpponentFlagLivePositionResolver,
  type OpponentFlagPending,
  registerOpponentFlagVocabulary,
} from "./opponent-flags.js";
export {
  _resetOpponentPitPending,
  OPPONENT_PIT_CLIP_SOURCES,
  OPPONENT_PIT_CONTRACTS,
  OPPONENT_PIT_SCENARIO_IDS,
  type OpponentPitCalloutId,
  type OpponentPitLivePositionResolver,
  type OpponentPitPending,
  registerOpponentPitVocabulary,
} from "./opponent-pit.js";
export {
  buildLapTimeContract,
  LAP_TIME_SCENARIO_IDS,
  type LapCompletedSnapshot,
  type LapCompletedSnapshotResolver,
  type LapTimeCalloutId,
  registerLapTimeVocabulary,
  splitLapTime,
} from "./lap-time.js";
export {
  buildPositionContract,
  POSITION_CLIP_SOURCES,
  type PositionCalloutId,
  positionChangeIsAnnounceable,
  selectEffectivePosition,
} from "./position.js";
export {
  buildQualifyingInvalidationContract,
  QUALIFYING_INVALIDATION_SCENARIO_IDS,
  type QualifyingInvalidationCalloutId,
  type QualifyingInvalidationSnapshot,
  type QualifyingInvalidationSnapshotResolver,
  registerQualifyingInvalidationVocabulary,
  resetQualifyingInvalidationLatch,
} from "./qualifying-invalidation.js";
export {
  buildRaceEndContract,
  RACE_END_SCENARIO_IDS,
  type RaceEndCalloutId,
  type RaceFinishedSnapshot,
  type RaceFinishedSnapshotResolver,
  registerRaceEndVocabulary,
  selectEffectiveFinalPosition,
} from "./race-end.js";
export {
  buildRaceStartContract,
  isRaceSession,
  RACE_START_DELAY_MS,
  RACE_START_SCENARIO_IDS,
  type RaceStartCalloutId,
  type RaceStartSnapshotResolver,
  registerRaceStartVocabulary,
} from "./race-start.js";
export {
  buildRaceStatusContract,
  RACE_STATUS_LAP_INTERVAL,
  RACE_STATUS_SCENARIO_IDS,
  type RaceStatusCalloutId,
  raceStatusCadenceHits,
  registerRaceStatusVocabulary,
} from "./race-status.js";
export {
  _resetGapCalloutCooldown,
  buildGapThresholdContract,
  buildGapTrendContract,
  GAP_CALLOUT_DEFAULT_COOLDOWN_MS,
  GAP_CLIP_SOURCES,
  type GapCalloutId,
  type LiveGapsResolver,
  resolveGapCooldownMs,
  tryClaimGapCallout,
} from "./gaps.js";
export {
  buildSessionStartContract,
  registerSessionStartVocabulary,
  SESSION_START_SCENARIO_IDS,
  type SessionStartCalloutId,
  type SessionStartSnapshotResolver,
} from "./session-start.js";
export {
  buildOvertakeGainedContract,
  buildOvertakeLostContract,
  OVERTAKE_CLIP_SOURCES,
  type OvertakeCalloutId,
  type OvertakeDriverNameResolver,
  overtakeGainIsAnnounceable,
  overtakeLossIsAnnounceable,
} from "./overtake.js";
export {
  _resetPositionReadoutCooldown,
  _setReactionRandom,
  buildOvertakeGainedPositionContract,
  buildOvertakeLostPositionContract,
  canAnnouncePosition,
  commitIntroDecision,
  INTRO_COOLDOWN_MS,
  type IntroDecision,
  type LivePosition,
  type LivePositionResolver,
  POSITION_READOUT_COOLDOWN_MS,
  REACTION_CHANCE,
  shouldReactToOvertake,
  shouldSpeakIntro,
  tryClaimPositionAnnouncement,
} from "./position-readout.js";
export {
  type OvertakeGate,
  type OvertakeGateResolver,
  OVERTAKE_MIN_SPEED_KMH,
  OVERTAKE_RECENT_INCIDENT_MS,
  overtakeContextAllows,
  PERMISSIVE_OVERTAKE_GATE,
} from "./overtake-gate.js";

/**
 * Stable identifier for each user-toggleable flag callout (issue #467).
 * One id per contract in `FLAG_CONTRACTS`; the trailing segment of the
 * scenario id minus the `pit-crew.flag-` prefix.
 */
export type FlagCalloutId = CalloutIdOf<typeof FLAG_CALLOUTS>;

/** @internal Exported for the coverage test (`callout-settings-coverage.test.ts`). */
export const SCENARIO_ID_TO_FLAG_ID: Readonly<Record<string, FlagCalloutId>> = {
  "pit-crew.flag-yellow-local": "yellow-local",
  "pit-crew.flag-yellow-full": "yellow-full",
  "pit-crew.flag-yellow-cleared": "yellow-cleared",
  "pit-crew.flag-green": "green",
  "pit-crew.flag-blue": "blue",
  "pit-crew.flag-white": "white",
  // Stage 2 of the two-stage white (issue #772) — same subject, same opt-in.
  "pit-crew.flag-white-last-lap": "white",
  // Stage 3 — the leader's final lap (issue #936), same subject/opt-in.
  "pit-crew.flag-white-leader": "white",
  "pit-crew.flag-red": "red",
  "pit-crew.flag-black": "black",
  "pit-crew.flag-checkered": "checkered",
  "pit-crew.flag-debris": "debris",
  "pit-crew.flag-meatball": "meatball",
  "pit-crew.flag-disqualify": "disqualify",
  "pit-crew.flag-furled": "furled",
  "pit-crew.flag-furled-cleared": "furled-cleared",
  "pit-crew.flag-dq-scoring-invalid": "dq-scoring-invalid",
  "pit-crew.flag-crossed": "crossed",
  "pit-crew.flag-one-pace-lap-to-go": "one-pace-lap-to-go",
  "pit-crew.flag-green-held": "green-held",
  "pit-crew.flag-ten-to-go": "ten-to-go",
  "pit-crew.flag-five-to-go": "five-to-go",
  "pit-crew.flag-yellow-waving": "yellow-waving",
  "pit-crew.flag-caution-waving": "caution-waving",
};

/**
 * Stable identifier for each user-toggleable start-light callout (issue #480).
 * Two grouped subjects (mirrors the pit-box "many scenarios → one subject"
 * precedent): `lights` covers the two gantry lines (ready / go — #673) and
 * `countdown` covers the four numeric pre-start marks. The user gets two
 * checkboxes for the whole family rather than six.
 */
export type StartLightCalloutId = CalloutIdOf<typeof START_LIGHT_CALLOUTS>;

/** @internal Exported for the coverage test (`callout-settings-coverage.test.ts`). */
export const SCENARIO_ID_TO_START_LIGHT_ID: Readonly<Record<string, StartLightCalloutId>> = {
  "pit-crew.start-light-ready": "lights",
  "pit-crew.start-light-go": "lights",
  "pit-crew.start-light-countdown-90": "countdown",
  "pit-crew.start-light-countdown-60": "countdown",
  "pit-crew.start-light-countdown-30": "countdown",
  "pit-crew.start-light-countdown-10": "countdown",
};

/**
 * Stable identifier for the rolling-start callout family (issue #660). Single
 * subject (`pace-car`) — one toggle covers the "pace car is moving" line spoken
 * once at the start of a rolling-start formation lap. Future rolling-start
 * sub-callouts can append cleanly under the same family namespace.
 */
export type RollingStartCalloutId = CalloutIdOf<typeof ROLLING_START_CALLOUTS>;

/** @internal Exported for the coverage test (`callout-settings-coverage.test.ts`). */
export const SCENARIO_ID_TO_ROLLING_START_ID: Readonly<Record<string, RollingStartCalloutId>> = {
  "pit-crew.rolling-start-pace-car": "pace-car",
};

/**
 * Stable identifier for the pit-window callout family (issue #655). Single
 * subject (`pit-open-closed`) — both directions (pits opened / closed) share one
 * opt-in, the same "one opt-in over multiple scenarios" shape track-conditions
 * uses. Future pit-window sub-callouts can append cleanly under this family.
 */
export type PitWindowCalloutId = CalloutIdOf<typeof PIT_WINDOW_CALLOUTS>;

/** @internal Exported for the coverage test (`callout-settings-coverage.test.ts`). */
export const SCENARIO_ID_TO_PIT_WINDOW_ID: Readonly<Record<string, PitWindowCalloutId>> = {
  "pit-crew.pit-window-opened": "pit-open-closed",
  "pit-crew.pit-window-closed": "pit-open-closed",
};

/**
 * Stable identifier for each user-toggleable damage callout (issue #489).
 * One id today (`repair-needed`) covering the combined
 * `MandRepNeeded | OptRepNeeded` rising edge. Future bits could split into
 * separate subjects without changing the wrapper.
 */
export type DamageCalloutId = CalloutIdOf<typeof DAMAGE_CALLOUTS>;

/** @internal Exported for the coverage test (`callout-settings-coverage.test.ts`). */
export const SCENARIO_ID_TO_DAMAGE_ID: Readonly<Record<string, DamageCalloutId>> = {
  "pit-crew.damage-repair-needed": "repair-needed",
};

/**
 * Stable identifier for the tire-wear callout family (issue #1108). Single
 * subject (`report`) — the whole post-stop report is one toggle. Future
 * tire-wear callouts (a mid-stint estimate, a worn-out warning) can append
 * cleanly under this family.
 */
export type TireWearCalloutId = CalloutIdOf<typeof TIRE_WEAR_CALLOUTS>;

/** @internal Exported for the coverage test (`callout-settings-coverage.test.ts`). */
export const SCENARIO_ID_TO_TIRE_WEAR_ID: Readonly<Record<string, TireWearCalloutId>> = {
  "pit-crew.tire-wear-report": "report",
};

/**
 * Stable identifier for each user-toggleable pit-service-status callout
 * (issue #479). One id per non-`None` `PlayerCarPitSvStatus` target — the
 * idle state never reaches the bus, so it has no opt-out either. Eight
 * subjects today; future statuses (if iRacing ever extends `PitSvStatus`)
 * append cleanly because the wrapper is generic over `TId`.
 */
export type PitStatusCalloutId = CalloutIdOf<typeof PIT_STATUS_CALLOUTS>;

/** @internal Exported for the coverage test (`callout-settings-coverage.test.ts`). */
export const SCENARIO_ID_TO_PIT_STATUS_ID: Readonly<Record<string, PitStatusCalloutId>> = {
  "pit-crew.pit-status-in-progress": "in-progress",
  "pit-crew.pit-status-complete": "complete",
  "pit-crew.pit-status-too-far-left": "too-far-left",
  "pit-crew.pit-status-too-far-right": "too-far-right",
  "pit-crew.pit-status-too-far-forward": "too-far-forward",
  "pit-crew.pit-status-too-far-back": "too-far-back",
  "pit-crew.pit-status-bad-angle": "bad-angle",
  "pit-crew.pit-status-cant-fix-that": "cant-fix-that",
  // The repeat nags (issue #951) map onto the SAME subject as their
  // transition sibling — one opt-in silences both stages of a positioning
  // callout, the #772 two-stage white-flag precedent.
  "pit-crew.pit-status-too-far-left-repeat": "too-far-left",
  "pit-crew.pit-status-too-far-right-repeat": "too-far-right",
  "pit-crew.pit-status-too-far-forward-repeat": "too-far-forward",
  "pit-crew.pit-status-too-far-back-repeat": "too-far-back",
  "pit-crew.pit-status-bad-angle-repeat": "bad-angle",
  // The empty-stop release (issue #1180) is the same "you can go" call as
  // Complete, so it rides Complete's opt-in rather than a setting of its own —
  // one checkbox silences both, the #951 precedent above.
  [PIT_STATUS_NOTHING_TO_DO_SCENARIO_ID]: "complete",
};

/**
 * Stable identifier for each user-toggleable incident callout (issue #530).
 * Mirrors the bus's `IncidentType` discriminator one-to-one. All six
 * default `true` in `GlobalSettingsSchema` (verified in the #938 review —
 * an earlier revision of this comment wrongly claimed `out-of-control`
 * defaulted off).
 */
export type IncidentCalloutId = CalloutIdOf<typeof INCIDENT_CALLOUTS>;

/** @internal Exported for the coverage test (`callout-settings-coverage.test.ts`). */
export const SCENARIO_ID_TO_INCIDENT_ID: Readonly<Record<string, IncidentCalloutId>> = {
  "pit-crew.incident-off-track": "off-track",
  "pit-crew.incident-out-of-control": "out-of-control",
  "pit-crew.incident-contact-world": "contact-world",
  "pit-crew.incident-collision-world": "collision-world",
  "pit-crew.incident-contact-car": "contact-car",
  "pit-crew.incident-collision-car": "collision-car",
};

/**
 * Stable identifier for the track-conditions callout family (issue #526).
 * Single subject for v1 — every (direction × target) combination is gated by
 * the same opt-in. Future sub-callouts (per-state opt-out, threshold-cross,
 * etc.) can append cleanly under the same `Track` family namespace without
 * reshaping the persistence model.
 */
export type TrackConditionsCalloutId = CalloutIdOf<typeof TRACK_CONDITIONS_CALLOUTS>;

// Position callout id is defined in ./position.ts and re-exported above.
// Its scenario-id map lives there too; its ids and keys live in the
// registry (`POSITION_CALLOUTS` in `@iracedeck/callout-settings`).

/** @internal Exported for the coverage test (`callout-settings-coverage.test.ts`). */
export const SCENARIO_ID_TO_TRACK_CONDITIONS_ID: Readonly<Record<string, TrackConditionsCalloutId>> = {
  "pit-crew.track-conditions-worsening-mostly-dry": "wetness",
  "pit-crew.track-conditions-worsening-very-lightly-wet": "wetness",
  "pit-crew.track-conditions-worsening-lightly-wet": "wetness",
  "pit-crew.track-conditions-worsening-moderately-wet": "wetness",
  "pit-crew.track-conditions-worsening-very-wet": "wetness",
  "pit-crew.track-conditions-worsening-extremely-wet": "wetness",
  "pit-crew.track-conditions-drying-dry": "wetness",
  "pit-crew.track-conditions-drying-mostly-dry": "wetness",
  "pit-crew.track-conditions-drying-very-lightly-wet": "wetness",
  "pit-crew.track-conditions-drying-lightly-wet": "wetness",
  "pit-crew.track-conditions-drying-moderately-wet": "wetness",
  "pit-crew.track-conditions-drying-very-wet": "wetness",
};

/**
 * Stable identifier for the pit-box count-in family (issue #600). Single
 * subject — one toggle covers the whole five → pit-now countdown. The six
 * per-mark scenarios all map to this one id (the same multi-scenario →
 * single-subject shape track-conditions uses), so the user gets one checkbox
 * for the feature rather than six.
 */
export type PitBoxCalloutId = CalloutIdOf<typeof PIT_BOX_CALLOUTS>;

/** @internal Exported for the coverage test (`callout-settings-coverage.test.ts`). */
export const SCENARIO_ID_TO_PIT_BOX_ID: Readonly<Record<string, PitBoxCalloutId>> = {
  "pit-crew.pit-box-five": "count-in",
  "pit-crew.pit-box-four": "count-in",
  "pit-crew.pit-box-three": "count-in",
  "pit-crew.pit-box-two": "count-in",
  "pit-crew.pit-box-one": "count-in",
  "pit-crew.pit-box-pit-now": "count-in",
};

/**
 * Stable identifier for the autofuel callout (issue #474). Single subject —
 * one toggle covers autofuel being switched either way and whatever that
 * leaves the fuel request at, so all four scenarios map to it (the pit-box
 * shape). Independent of the pit-service requests opt-in in both directions:
 * a driver may want their own presses confirmed and autofuel's news silent,
 * or the reverse.
 */
export type AutoFuelCalloutId = CalloutIdOf<typeof AUTO_FUEL_CALLOUTS>;

/** @internal Exported for the coverage test (`callout-settings-coverage.test.ts`). */
export const SCENARIO_ID_TO_AUTO_FUEL_ID: Readonly<Record<string, AutoFuelCalloutId>> = {
  "pit-crew.auto-fuel-on-refuel": "changed",
  "pit-crew.auto-fuel-on-no-refuel": "changed",
  "pit-crew.auto-fuel-off-refuel": "changed",
  "pit-crew.auto-fuel-off-no-refuel": "changed",
};

/**
 * Stable identifier for the pit-road speeding cue (issue #912). Single
 * subject — one toggle covers the whole repeating tick.
 */
export type PitSpeedingCalloutId = CalloutIdOf<typeof PIT_SPEEDING_CALLOUTS>;

// No `SCENARIO_ID_TO_PIT_SPEEDING_ID` and no `wrapCalloutScenario` loop: the
// cue is an imperative engine playing direct, not a scenario, so there is no
// `where:` predicate to wrap. Its opt-in is read inside the engine's tick
// instead — the same shape the spotter's two opt-ins use.

/**
 * Stable identifier for each user-toggleable laps-of-fuel-left callout
 * (issue #838). One id per spoken count — the trailing segment of the
 * scenario id minus the `pit-crew.fuel-` prefix. `laps-left-box` is the
 * count-0 "box this lap for fuel" call.
 */
export type FuelCalloutId = CalloutIdOf<typeof FUEL_CALLOUTS>;

/** @internal Exported for the coverage test (`callout-settings-coverage.test.ts`). */
export const SCENARIO_ID_TO_FUEL_ID: Readonly<Record<string, FuelCalloutId>> = {
  "pit-crew.fuel-laps-left-10": "laps-left-10",
  "pit-crew.fuel-laps-left-9": "laps-left-9",
  "pit-crew.fuel-laps-left-8": "laps-left-8",
  "pit-crew.fuel-laps-left-7": "laps-left-7",
  "pit-crew.fuel-laps-left-6": "laps-left-6",
  "pit-crew.fuel-laps-left-5": "laps-left-5",
  "pit-crew.fuel-laps-left-4": "laps-left-4",
  "pit-crew.fuel-laps-left-3": "laps-left-3",
  "pit-crew.fuel-laps-left-2": "laps-left-2",
  "pit-crew.fuel-laps-left-1": "laps-left-1",
  "pit-crew.fuel-laps-left-box": "laps-left-box",
  "pit-crew.fuel-laps-left-race-covered": "race-covered",
};

/** Stable id for each spotter PI opt-in (issue #651). */
export type SpotterCalloutId = CalloutIdOf<typeof SPOTTER_CALLOUTS>;

/** Global-settings key for the user-configurable "still there" cadence (seconds, issue #651). */
export const SPOTTER_STILL_THERE_SECONDS_KEY = "spotterStillThereSeconds";

/**
 * Resolver the plugins pass to {@link registerPitCrew}: given the current
 * session kind, returns whether the loaded setup name looks wrong for it (opt-in
 * on AND the session-kind pattern matches). Read live at fire time inside the
 * `setupWarning.qualifyingMismatch` / `setupWarning.raceMismatch` conditions
 * the session-start / race-start scripts branch on (issue #625; scripted
 * since #1065). Defined beside the race-start vocabulary and re-exported here.
 *
 * Unlike the other callout families, the setup warning is a conditional clause
 * appended to the existing session-start / race-start intros — not its own
 * contract — so it has no `SCENARIO_ID_TO_*` map and no gate here: the opt-in
 * (`SETUP_WARNING_CALLOUTS` in `@iracedeck/callout-settings`) is read inside
 * this resolver (the plugins compose it from `evaluateSetupWarning`, whose key
 * is `SETUP_WARNING_ENABLED_KEY` in `@iracedeck/settings`), not via
 * `wrapCalloutScenario`.
 */
export type { SetupWarningResolver } from "./race-start.js";
/**
 * Everything `registerPitCrew` needs beyond the bus. Every key is optional;
 * an omitted or `undefined` key takes its entry from {@link DEFAULT_DEPS}.
 *
 * Keys are unordered by construction — that is the point of #1052. Do not
 * reintroduce a placement convention here.
 */
export type PitCrewDeps = {
  /**
   * Whether the user has a callout switched on (#1350). One lookup for every
   * family: each resolves its own id to a key through `@iracedeck/callout-settings`.
   * Read live, so a settings change applies to the next callout.
   */
  isCalloutEnabled?: (key: CalloutSettingKey) => boolean;
  logger?: ILogger;
  // Allow / suppress per-toggle pit-action confirmations (issue #476).
  // Plugins wire this to `isPitActionsAllowed()` from
  // `@iracedeck/sim-events-iracing` so the cooldowns set by `pitLane.exited`
  // and pre-start grid entry silence the toggle callouts during those
  // windows. Default `() => true` preserves legacy behavior for tests
  // that don't supply a closure.
  getPitActionsAllowed?: () => boolean;
  // Pit-readback queued-services snapshot (issue #481). Plugins wire this
  // to `getReadbackSnapshot()` from `@iracedeck/sim-events-iracing`, which
  // builds a snapshot from the latest telemetry tick. Read at fire time
  // inside every `readback.*` condition and case the readback scripts
  // name so deferred replays speak the *current* queue rather than a
  // snapshot frozen into the original event. Default `() => null`
  // collapses every readback to the empty-fallback clip — a safe stub for
  // tests that don't supply a resolver.
  getReadbackSnapshot?: () => PitReadbackSnapshot | null;
  // Session-start conditions snapshot (issue #542). Plugins wire this to a
  // closure that composes `getSessionStartConditions()` from
  // `@iracedeck/sim-events-iracing` with the Property Inspector driver-name
  // pick. Read at fire time inside the scenario's `where:` predicate and
  // per-clip `var` resolvers. Default `() => null` makes the scenario's
  // `where:` short-circuit — a safe stub for tests that don't supply a
  // resolver.
  getSessionStartSnapshot?: () => SessionStartSnapshot | null;
  // Last `lap.completed` event payload (issue #555). Plugins wire this to a
  // closure backed by an event-bus subscription that captures the most
  // recent payload. Read at fire time inside the scenario's per-clip `var`
  // resolvers so a deferred replay still speaks the lap data that was frozen
  // at S/F crossing. Default `() => null` makes the var resolvers return
  // null — a safe stub for tests that don't supply a resolver. Reused by the
  // position-change callout (issue #566) — both scenarios subscribe to the
  // same `lap.completed` event and share the snapshot cache.
  getLapCompletedSnapshot?: LapCompletedSnapshotResolver;
  // Snapshot resolver for the qualifying lap-invalidation callout (issue
  // #567). Plugins wire this to a closure that builds the snapshot from the
  // latest telemetry tick + session info. Read at event arrival inside the
  // scenario's `where:` predicate (qualifying gate + the per-lap latch's pure
  // check, stashing the approved snapshot for the contract's `speakGate`,
  // which latches it at speak time — #1137, #1138) and again inside the
  // tail's conditional branches and the lap-count `var` resolver.
  // Default `() => null` makes the scenario's `where:` short-circuit — a safe
  // stub for tests that don't supply a resolver.
  getQualifyingInvalidationSnapshot?: QualifyingInvalidationSnapshotResolver;
  // Race-end latch (issue #569). Plugins wire this to a getter exposed by
  // `@iracedeck/sim-events-iracing` that reads the translator's
  // `state.raceFinishedFired`. Race-status `where:` reads it live so the
  // periodic status callout suppresses itself on the final lap (race-end
  // fires on the same `lap.completed` tick — the diff emits `race.finished`
  // first into the pending queue, latch flips synchronously before
  // `lap.completed` publishes). Default `() => false` (race never ends) keeps
  // legacy behavior for tests that don't supply a closure.
  getRaceFinishedFired?: () => boolean;
  // Race-end snapshot resolver (issue #569). Plugins compose this from the
  // cached `race.finished` event payload plus the Property Inspector
  // driver-name pick. Read at fire time inside the scenario's `where:`
  // predicate and per-clip `var` resolvers — same deferred-snapshot pattern
  // as session-start. Default `() => null` makes the scenario's `where:`
  // short-circuit — a safe stub for tests that don't supply a resolver.
  getRaceFinishedSnapshot?: RaceFinishedSnapshotResolver;
  // Race-start conditions snapshot (issue #568). Plugins wire this to a
  // closure that composes `getRaceStartConditions()` from
  // `@iracedeck/sim-events-iracing` with the Property Inspector driver-name
  // pick. Read at fire time inside the scenario's `where:` predicate and
  // per-clip `var` resolvers. Default `() => null` makes the scenario's
  // `where:` short-circuit — a safe stub for tests that don't supply a
  // resolver.
  getRaceStartSnapshot?: RaceStartSnapshotResolver;
  // Driver-name resolver for the loss-line "Come on, <name>" composition
  // (issue #574). Plugins wire this to `resolveActiveDriverName(driverNames,
  // "driver")` so the resolver returns the user-picked name when valid and
  // falls back to the pre-recorded `"driver"` clip otherwise — the loss
  // line stays a complete sentence even when the user's name isn't in the
  // greeting pool. Default `() => null` skips the name step (rare; tests).
  getOvertakeDriverName?: OvertakeDriverNameResolver;
  // Live position resolver (issue #574 follow-up). Plugins wire this to
  // `getLivePosition()` from `@iracedeck/sim-events-iracing`. Read at
  // speak-time inside the "We're currently P[n]" var resolvers (overtake
  // readout, race position-change, race-status) so the spoken position is
  // accurate to the moment it's said, not frozen at the triggering event.
  // Default `() => null` makes those readouts stay silent — a safe stub for
  // tests that don't supply a resolver.
  getLivePosition?: LivePositionResolver;
  // Overtake gate (issue #574 follow-up). Plugins compose this from
  // `getOvertakeTelemetryGate()` (`@iracedeck/sim-events-iracing`) plus a
  // tracked `incident.scored` timestamp (the type-blind signal, #1122 — an
  // untyped counted burst is still a moment). Read at event time to suppress the
  // WHOLE overtake callout (reaction + position, both directions) when the
  // swap wasn't a clean racing moment — cars alongside, off-track, crawling,
  // pit road, or a recent incident. Default permissive so callers that don't
  // wire it (tests) still fire; the real plugin gate returns `null` only when
  // telemetry is unavailable, which suppresses.
  getOvertakeGate?: OvertakeGateResolver;
  // Setup-mismatch warning resolver (issue #625). Plugins wire this to read the
  // live opt-in + the session-kind regex pattern from global settings and test it
  // against the live setup name. Consumed inside the session-start and race-start
  // scenarios' `if` clauses (not via `wrapCalloutScenario`, since the warning is a
  // clause inside those intros, not its own scenario). Default `() => false` —
  // tests that don't supply a closure never append the warning clause.
  getSetupWarningMismatch?: SetupWarningResolver;
  // Spotter road/oval terminology (issue #651). Plugins wire this to
  // `getTrackDirection()` from `@iracedeck/sim-events-iracing`. Default Neutral (road).
  getSpotterTrackDirection?: () => TrackDirection;
  // Spotter "still there" reminder cadence in ms (issue #651). Plugins wire this
  // to `resolveStillThereIntervalMs(spotterStillThereSeconds)`; read live each
  // tick so a slider change takes effect on the next reminder. Default 3 s.
  getSpotterStillThereIntervalMs?: () => number;
  // Spotter nearest-car gap in meters (issue #651) for the → clear confirmation
  // buffer. Plugins wire this to `getNearestCarGapMeters()` from
  // `@iracedeck/sim-events-iracing`. Default `() => null` disables the buffer.
  getSpotterNearestCarGapMeters?: () => number | null;
  // Corner-name snapshot (issue #888). Plugins cache the latest
  // `cornerName.approaching` payload (the lap-time subscription pattern) and
  // pass the getter; the clip resolver reads it at expansion time. Default
  // `() => null` makes the scenario's `where:` short-circuit — a safe stub
  // for tests.
  getCornerNameSnapshot?: CornerNameSnapshotResolver;
  // Opponent-pit live position resolver (issue #622). Plugins wire
  // `getLiveCarPosition` so the nearby line's number is fresh at speak time,
  // read in the projection the event was classified in (the pending stash's
  // `isMultiClass`). The pitting car itself is carried by a module-scope
  // stash written in the nearby scenario's `where:` (the #922 shape), so a
  // later event of a different relation can never repoint a deferred line.
  // Default `() => null` falls back to the emit-time payload position — a
  // safe stub for tests and the harness.
  getOpponentPitLivePosition?: OpponentPitLivePositionResolver;
  // Shared gap-callout cooldown in ms (issue #933). Plugins wire this to
  // `resolveGapCooldownMs(gapCalloutCooldownSeconds)`; read live at event
  // arrival so a slider change applies to the next callout. Default 30 s.
  getGapCooldownMs?: () => number;
  // Live gaps resolver (issue #933). Plugins wire `getLiveGaps()` from the
  // translator; the spoken gap number reads it at speak time (the #574
  // live-at-speak-time pattern). Default `() => null` skips the readout
  // clause — a safe stub for tests.
  getLiveGaps?: LiveGapsResolver;
  // Opponent-flag live position resolver (issue #936). Plugins wire
  // `getLiveCarPosition` so the `opponentFlag.number` var — the 3.3.0
  // position var, kept for third-party packs; the bundled pack names the car
  // by number since #1274 — is fresh at speak time, read in the projection
  // the event was classified in (the payload's `isMultiClass`). The var reads
  // the expanding fire's own event, so a later flag event can never repoint
  // a deferred line. Default `() => null` falls back to the emit-time
  // payload position — a safe stub for tests and the harness.
  getOpponentFlagLivePosition?: OpponentFlagLivePositionResolver;
  // Caution lineup resolver (issue #1127). Plugins wire `getCautionLineup()`
  // from `@iracedeck/sim-events-iracing`. Read at SPEAK time inside every
  // `caution.*` var, condition and case, so a call that waited behind a busier
  // bus names the car that is ahead now rather than the one that was ahead
  // when it fired — the lineup keeps moving while the field re-forms. Default
  // `() => null` leaves every caution line numberless and laneless, which is a
  // safe stub for tests.
  getCautionLineup?: CautionLineupResolver;
  // Whether a full-course caution is out (issue #1127). Plugins wire
  // `isUnderFullCourseCaution()` from `@iracedeck/sim-events-iracing` — the
  // translator's own caution phase not being "none", never a re-derivation of
  // the caution bits. Read by the lap-time and position-change contracts,
  // which fall silent under a caution. Default `() => false` is the truthful
  // answer for a caller that wires no reader.
  getUnderFullCourseCaution?: UnderCautionResolver;
  // WHICH stage the caution is in (issue #1127, second review). Plugins wire
  // `getCautionPhase()` from `@iracedeck/sim-events-iracing` — the same phase
  // the boolean above is derived from, exposed whole. The caution family is
  // built against it: the two pace-car callouts speak only under a live phase
  // (their events fire at a rolling start too), the follow call only while
  // the field is still waving, the pickup only once the phase settled on
  // caught, the pace-car-off call only under one to go, and every speak-time
  // gate asks it for "still out". Default `() => "none"` is the truthful
  // answer for a caller that wires no reader — note what it costs, though:
  // the whole family then never speaks, so the scenario harness MUST wire it
  // (`main.ts` does) or every caution button is silent for the wrong reason.
  getCautionPhase?: CautionPhaseResolver;
  // WHICH caution is out (issue #1286). Plugins wire `getCautionEpisode()`
  // from `@iracedeck/sim-events-iracing`: an id that never repeats, and the
  // caution's first readable follow car. It scopes the lineup-change call's
  // memory of the car last named to one caution, so a car named in an earlier
  // caution — or session — never silences a change. Default `() => null`
  // leaves the change call silent, never wrong: with no episode there is
  // nothing to judge a change against.
  getCautionEpisode?: CautionEpisodeResolver;
  // Master gate for the Race Engineer voice subsystem (issue #515).
  // Plugins wire this to `pitCrewRaceEngineerEnabled === true`. Read live
  // on every event arrival and applied as the OUTERMOST wrapper around
  // every voice scenario, so a fresh install (or a deck with no Pit Crew
  // button) suppresses dispatch entirely — independent of audio bus
  // volumes, per-callout opt-ins, or pit-action cooldowns. Default
  // `() => true` preserves legacy behavior for tests that don't supply a
  // closure.
  getRaceEngineerMasterEnabled?: () => boolean;
  // Master gate for the directional radar (issue #515). Plumbed into
  // `registerRadarEngine` and consulted on every `radar.changed` arrival
  // and on every scheduled tick — same defense-in-depth shape as the
  // voice master gate, but inside the imperative engine since radar
  // isn't expressed as a scenario. Default `() => true` preserves legacy
  // behavior for tests that don't supply a closure.
  getRadarMasterEnabled?: () => boolean;
};

/**
 * The single home for every default. Referenced by name from the
 * destructure below, so a default is stated once and is greppable.
 */
const DEFAULT_DEPS = {
  isCalloutEnabled: () => true,
  getPitActionsAllowed: () => true,
  getReadbackSnapshot: () => null,
  getSessionStartSnapshot: () => null,
  getLapCompletedSnapshot: () => null,
  getQualifyingInvalidationSnapshot: () => null,
  getRaceFinishedFired: () => false,
  getRaceFinishedSnapshot: () => null,
  getRaceStartSnapshot: () => null,
  getOvertakeDriverName: () => null,
  getLivePosition: () => null,
  getOvertakeGate: () => PERMISSIVE_OVERTAKE_GATE,
  getSetupWarningMismatch: () => false,
  getSpotterTrackDirection: () => TrackDirection.Neutral,
  getSpotterStillThereIntervalMs: () => SPOTTER_STILL_THERE_DEFAULT_MS,
  getSpotterNearestCarGapMeters: () => null,
  getCornerNameSnapshot: () => null,
  getOpponentPitLivePosition: () => null,
  getGapCooldownMs: () => GAP_CALLOUT_DEFAULT_COOLDOWN_MS,
  getLiveGaps: () => null,
  getOpponentFlagLivePosition: () => null,
  getCautionLineup: () => null,
  getUnderFullCourseCaution: () => false,
  getCautionPhase: () => "none",
  getCautionEpisode: () => null,
  getRaceEngineerMasterEnabled: () => true,
  getRadarMasterEnabled: () => true,
} satisfies Omit<Required<PitCrewDeps>, "logger">;

export function registerPitCrew(bus: IEventBus, deps: PitCrewDeps = {}): void {
  const {
    isCalloutEnabled = DEFAULT_DEPS.isCalloutEnabled,
    logger,
    getPitActionsAllowed = DEFAULT_DEPS.getPitActionsAllowed,
    getReadbackSnapshot = DEFAULT_DEPS.getReadbackSnapshot,
    getSessionStartSnapshot = DEFAULT_DEPS.getSessionStartSnapshot,
    getLapCompletedSnapshot = DEFAULT_DEPS.getLapCompletedSnapshot,
    getQualifyingInvalidationSnapshot = DEFAULT_DEPS.getQualifyingInvalidationSnapshot,
    getRaceFinishedFired = DEFAULT_DEPS.getRaceFinishedFired,
    getRaceFinishedSnapshot = DEFAULT_DEPS.getRaceFinishedSnapshot,
    getRaceStartSnapshot = DEFAULT_DEPS.getRaceStartSnapshot,
    getOvertakeDriverName = DEFAULT_DEPS.getOvertakeDriverName,
    getLivePosition = DEFAULT_DEPS.getLivePosition,
    getOvertakeGate = DEFAULT_DEPS.getOvertakeGate,
    getSetupWarningMismatch = DEFAULT_DEPS.getSetupWarningMismatch,
    getSpotterTrackDirection = DEFAULT_DEPS.getSpotterTrackDirection,
    getSpotterStillThereIntervalMs = DEFAULT_DEPS.getSpotterStillThereIntervalMs,
    getSpotterNearestCarGapMeters = DEFAULT_DEPS.getSpotterNearestCarGapMeters,
    getCornerNameSnapshot = DEFAULT_DEPS.getCornerNameSnapshot,
    getOpponentPitLivePosition = DEFAULT_DEPS.getOpponentPitLivePosition,
    getGapCooldownMs = DEFAULT_DEPS.getGapCooldownMs,
    getLiveGaps = DEFAULT_DEPS.getLiveGaps,
    getOpponentFlagLivePosition = DEFAULT_DEPS.getOpponentFlagLivePosition,
    getCautionLineup = DEFAULT_DEPS.getCautionLineup,
    getUnderFullCourseCaution = DEFAULT_DEPS.getUnderFullCourseCaution,
    getCautionPhase = DEFAULT_DEPS.getCautionPhase,
    getCautionEpisode = DEFAULT_DEPS.getCautionEpisode,
    getRaceEngineerMasterEnabled = DEFAULT_DEPS.getRaceEngineerMasterEnabled,
    getRadarMasterEnabled = DEFAULT_DEPS.getRadarMasterEnabled,
  } = deps;

  // The per-family gates, each resolving its own callout id to a settings key
  // through the registry and asking the one `isCalloutEnabled` lookup (#1350).
  // Every gate is read live at event arrival, before `attemptFire`, so a
  // callout switched off mid-session suppresses only future events and never
  // cuts one already playing.
  const enabledIn =
    <F extends RegisteredCalloutFamily>(family: F) =>
    (id: CalloutIdOf<F>): boolean =>
      isCalloutEnabled(calloutKey(family, id));

  const getFlagCalloutEnabled = enabledIn(FLAG_CALLOUTS);
  const getPitReadbackEnabled = enabledIn(PIT_READBACK_CALLOUTS);
  // One opt-in for every pit-service toggle confirmation (issue #468). A
  // persistent user preference, distinct from `getPitActionsAllowed` (the
  // engine-internal cooldown), so the two move independently.
  const getPitServiceRequestsEnabled = (): boolean =>
    isCalloutEnabled(calloutKey(PIT_SERVICE_REQUEST_CALLOUTS, "requests"));
  // Independent of the pit-service requests opt-in in both directions (issue
  // #474): neither gate reads the other.
  const getAutoFuelCalloutEnabled = enabledIn(AUTO_FUEL_CALLOUTS);
  const getTireWearCalloutEnabled = enabledIn(TIRE_WEAR_CALLOUTS);
  const getDamageCalloutEnabled = enabledIn(DAMAGE_CALLOUTS);
  const getPitStatusCalloutEnabled = enabledIn(PIT_STATUS_CALLOUTS);
  const getTrackConditionsCalloutEnabled = enabledIn(TRACK_CONDITIONS_CALLOUTS);
  const getIncidentCalloutEnabled = enabledIn(INCIDENT_CALLOUTS);
  const getSessionStartCalloutEnabled = enabledIn(SESSION_START_CALLOUTS);
  const getLapTimeCalloutEnabled = enabledIn(LAP_TIME_CALLOUTS);
  const getPositionCalloutEnabled = enabledIn(POSITION_CALLOUTS);
  const getQualifyingInvalidationCalloutEnabled = enabledIn(QUALIFYING_INVALIDATION_CALLOUTS);
  const getRaceStatusCalloutEnabled = enabledIn(RACE_STATUS_CALLOUTS);
  const getRaceEndCalloutEnabled = enabledIn(RACE_END_CALLOUTS);
  const getRaceStartCalloutEnabled = enabledIn(RACE_START_CALLOUTS);
  const getOvertakeCalloutEnabled = enabledIn(OVERTAKE_CALLOUTS);
  const getPitBoxCalloutEnabled = enabledIn(PIT_BOX_CALLOUTS);
  // The spotter has no standalone master; it rides the Race Engineer's
  // (issue #651). "cars" gates every transition call, "still-there" the
  // repeating reminder; both are read inside the engine's tick.
  const getSpotterCalloutEnabled = enabledIn(SPOTTER_CALLOUTS);
  const getPitWindowCalloutEnabled = enabledIn(PIT_WINDOW_CALLOUTS);
  const getRollingStartCalloutEnabled = enabledIn(ROLLING_START_CALLOUTS);
  const getStartLightCalloutEnabled = enabledIn(START_LIGHT_CALLOUTS);
  const getFuelCalloutEnabled = enabledIn(FUEL_CALLOUTS);
  const getCornerNameCalloutEnabled = enabledIn(CORNER_NAME_CALLOUTS);
  const getOpponentPitCalloutEnabled = enabledIn(OPPONENT_PIT_CALLOUTS);
  const getGapCalloutEnabled = enabledIn(GAP_CALLOUTS);
  // The aggregate tail is not per-flag-gated (see its registration below).
  const getOpponentFlagCalloutEnabled = enabledIn(OPPONENT_FLAG_CALLOUTS);
  const getCautionCalloutEnabled = enabledIn(CAUTION_CALLOUTS);
  // Read inside the imperative speeding engine (issue #912): the cue plays
  // direct, so there is no `where:` to gate.
  const getPitSpeedingCalloutEnabled = enabledIn(PIT_SPEEDING_CALLOUTS);
  const getPitLimiterCalloutEnabled = enabledIn(PIT_LIMITER_CALLOUTS);
  const getNoLimiterCalloutEnabled = enabledIn(NO_LIMITER_CALLOUTS);

  registerRadarEngine(bus, getRadarMasterEnabled);

  registerPitSpeedingEngine(bus, {
    getMasterEnabled: getRaceEngineerMasterEnabled,
    getCueEnabled: () => getPitSpeedingCalloutEnabled("cue"),
    logger,
  });

  registerSpotterEngine(bus, {
    getMasterEnabled: getRaceEngineerMasterEnabled,
    getCarsEnabled: () => getSpotterCalloutEnabled("cars"),
    getStillThereEnabled: () => getSpotterCalloutEnabled("still-there"),
    getStillThereIntervalMs: getSpotterStillThereIntervalMs,
    getTrackDirection: getSpotterTrackDirection,
    getNearestCarGapMeters: getSpotterNearestCarGapMeters,
    logger,
  });

  const engine = getScenarioEngine();

  // The vocabulary the flag scripts name (issue #1064) — the `session.type`
  // case var, the furled speak-time gates and the `session.is*` conditions.
  // Registered before any contract so the first `setScripts` compile sees it;
  // a later registration would only mark the compiled scripts dirty.
  registerFlagVocabulary(engine);

  // The vocabulary the readback scripts name (issue #1065) — the seven
  // `readback.*` slot conditions and the `readback.tirePattern` case, every
  // one reading the queued-services snapshot through the resolver at
  // expansion time (issue #481), which is why the resolver is handed here
  // rather than to the contracts.
  registerReadbackVocabulary(engine, getReadbackSnapshot);

  // The vocabulary the pit-status repeat nags name (issue #1065) — the five
  // `pitStatus.still*` speak-time gates, each re-reading live telemetry when
  // its nag comes to speak.
  registerPitStatusVocabulary(engine);

  // The vocabulary the tire-wear script names (issue #1108) — the per-tire
  // and most-worn `tireWear.*Tread` vars, the `tireWear.hasWear` condition and
  // the three `tireWear.heaviest*` cases, every one reading the fire's own
  // `tireWear.reported` payload.
  registerTireWearVocabulary(engine);

  // The vocabulary the readout scripts name (issue #466) — the `readout.*`
  // figure vars, every one reading the fire's own `telemetryReadout.requested`
  // payload, which the Pit Crew action captured at the moment of the press.
  registerTelemetryReadoutVocabulary(engine);

  // No radio-frame fragments are registered here any more (issue #1064): the
  // engine wraps every scenario in the frame its `frame` field names — the
  // active voice's `radio` frame unless the scenario opts out with
  // `frame: NO_FRAME` — so no sequence in this catalog spells the ticks.

  // Master gate is applied as the outermost wrapper so per-callout opt-ins,
  // pit-action cooldowns, and readback predicates only run when the
  // engineer is on at all. Cheap short-circuit on the master saves every
  // inner wrapper from running on every event arrival.
  const wrapWithMaster = <T extends Gated>(s: T): T =>
    wrapRaceEngineerMasterGate(s, getRaceEngineerMasterEnabled, logger);

  // Each pit-service toggle contract is wrapped three times. Outermost
  // wrapper applies the master gate (`pitCrewRaceEngineerEnabled`); next
  // applies the user opt-in (`calloutEnabledPitServiceRequests`);
  // innermost applies the engine-internal cooldown
  // (`isPitActionsAllowed`). Outer-first because the master gate is the
  // cheapest, most-persistent check.
  const wrapToggle = <T extends Gated>(s: T): T =>
    wrapWithMaster(
      wrapPitServiceRequestsScenario(
        wrapPitActionScenario(s, getPitActionsAllowed, logger),
        getPitServiceRequestsEnabled,
        logger,
      ),
    );

  // The twenty-four toggle confirmations — contracts since #1065, in their
  // five groups (fuel, tire set, compound, windshield, fast repair): each is
  // the active voice's `acknowledgment → line` pair in its `callouts.json`,
  // addressing `pool:pit-actions/<base>`.
  for (const c of TOGGLE_CONFIRMATION_CONTRACTS) {
    engine.defineContract(wrapToggle(c));
  }

  // The four autofuel lines (issue #474) — autofuel switched on or off for
  // the next stop, and what that left the fuel request at, published together
  // as `pitService.autoFuelSwitched`. A fuel flip made while autofuel is armed
  // is published as nothing at all, so no contract here reads the fuel bit.
  // The toggles' own three layers, with the middle one swapped: master gate
  // outermost, then the autofuel opt-in (`calloutEnabledPitServiceAutoFuel`,
  // via `SCENARIO_ID_TO_AUTO_FUEL_ID` — one checkbox for all four), never the
  // pit-service requests gate, since the two preferences are independent; then
  // the pit-action cooldown innermost, so the sim's post-stop reset of the
  // service queue at pit exit (and the pre-grid window) stays as quiet here as
  // it does for a press. The cooldown does NOT reach the pit approach, where
  // the #474 capture showed the sim arming autofuel and wiping the driver's
  // fuel request in one tick — the moment this callout exists to announce.
  for (const c of AUTO_FUEL_CONTRACTS) {
    engine.defineContract(
      wrapWithMaster(
        wrapCalloutScenario(
          wrapPitActionScenario(c, getPitActionsAllowed, logger),
          SCENARIO_ID_TO_AUTO_FUEL_ID,
          getAutoFuelCalloutEnabled,
          "auto-fuel callout",
          logger,
        ),
      ),
    );
  }

  // Contracts, not scenarios (issue #1064): the flag family's wording is the
  // active voice's business (`scenarios["pit-crew.flag-*"]` in its
  // `callouts.json`, compiled by `setScripts`); the gates wrap the contract's
  // `where:` exactly as they wrap a legacy scenario's.
  for (const c of FLAG_CONTRACTS) {
    engine.defineContract(
      wrapWithMaster(wrapCalloutScenario(c, SCENARIO_ID_TO_FLAG_ID, getFlagCalloutEnabled, "flag callout", logger)),
    );
  }

  // Full-course caution family (issue #1127) — the narrated sequence around a
  // caution: who to follow, the pace car out and off, the pickup (two to
  // green), each extra lap, one lap to green, a change to the car ahead, your
  // race position on the last lap, and the green. Registered right after the
  // flags because it is part of the same conversation: six of the nine share
  // `family: "flag"` so a newer caution call supersedes a stale one; the
  // follow, position and lineup-change calls deliberately do not, because each
  // shares its moment with a call it must queue behind rather than cut (the
  // follow call rides the very event that fires `pit-crew.flag-caution-waving`;
  // see `caution.ts`). The contracts take the episode reader and the live
  // opt-in too: the lineup change is judged against the car last named in
  // THIS caution, and before anything is named it asks whether the follow
  // call is switched on (issue #1286).
  //
  // The vocabulary goes first, as every family's does; it carries the lineup
  // resolver because every lineup entry reads it at SPEAK time — the lineup is
  // never frozen into an event payload — and the SAME `getLivePosition` the
  // position and race-status vocabularies take, because the position call on
  // the last caution lap speaks the race position, not the lineup's.
  registerCautionVocabulary(engine, getCautionLineup, getLivePosition, logger);

  for (const c of buildCautionContracts({
    getCautionPhase,
    getCautionLineup,
    getCautionEpisode,
    isCautionCalloutEnabled: getCautionCalloutEnabled,
  })) {
    engine.defineContract(
      wrapWithMaster(
        wrapCalloutScenario(c, SCENARIO_ID_TO_CAUTION_ID, getCautionCalloutEnabled, "caution callout", logger),
      ),
    );
  }

  // Pit-limiter family (issue #1051) — cars WITH a limiter. Dormant from the
  // day it was written until #1051: nothing imported this module, so the
  // translator published `limiter.missing` / `.dropped` / `.speeding` and
  // `carControl.limiterToggled` into a bus with no subscriber. Contracts since
  // #1065: each line is the active voice's (`scenarios["pit-crew.limiter-*"]`,
  // addressing `pool:pit-limiter/<base>`), and the two delayed warnings'
  // scripts wrap their body in the `limiter.still*` gates registered here —
  // before the contracts, as every vocabulary is.
  registerPitLimiterVocabulary(engine);

  for (const c of PIT_LIMITER_CONTRACTS) {
    engine.defineContract(
      wrapWithMaster(
        wrapCalloutScenario(
          c,
          SCENARIO_ID_TO_PIT_LIMITER_ID,
          getPitLimiterCalloutEnabled,
          "pit-limiter callout",
          logger,
        ),
      ),
    );
  }

  // No-limiter family (issue #1051) — the mirror, for cars with NO limiter;
  // contracts since #1065 (`scenarios["pit-crew.no-limiter-*"]` in the voice's
  // `callouts.json`). Its `pitSpeed.*` vars back the entry script's optional
  // spoken-limit clause and read the SAME snapshot resolver the session-start
  // brief uses, so the two can never disagree about the number.
  registerNoLimiterVocabulary(engine, getSessionStartSnapshot);

  for (const c of NO_LIMITER_CONTRACTS) {
    engine.defineContract(
      wrapWithMaster(
        wrapCalloutScenario(c, SCENARIO_ID_TO_NO_LIMITER_ID, getNoLimiterCalloutEnabled, "no-limiter callout", logger),
      ),
    );
  }

  // Start-light contracts (issue #480; scripted since #1065): the two gantry
  // lines and the four countdown marks are the active voice's business
  // (`scenarios["pit-crew.start-light-*"]`, addressed as
  // `pool:start-lights/<base>`). Two grouped opt-ins (`lights`, `countdown`)
  // gate the six contracts via `SCENARIO_ID_TO_START_LIGHT_ID`.
  for (const c of START_LIGHT_CONTRACTS) {
    engine.defineContract(
      wrapWithMaster(
        wrapCalloutScenario(
          c,
          SCENARIO_ID_TO_START_LIGHT_ID,
          getStartLightCalloutEnabled,
          "start-light callout",
          logger,
        ),
      ),
    );
  }

  // Pit-window family (issue #655) — contracts since #1065: the two lines are
  // the active voice's business (`scenarios["pit-crew.pit-window-*"]` in its
  // `callouts.json`, addressing `pool:pit-window/<base>` directly). Single
  // subject (`pit-open-closed`) gates both directional contracts via
  // `SCENARIO_ID_TO_PIT_WINDOW_ID`.
  for (const c of PIT_WINDOW_CONTRACTS) {
    engine.defineContract(
      wrapWithMaster(
        wrapCalloutScenario(c, SCENARIO_ID_TO_PIT_WINDOW_ID, getPitWindowCalloutEnabled, "pit-window callout", logger),
      ),
    );
  }

  // Opponent-pit family (issue #622; scripted since #1065). The vocabulary
  // (the speak-time `opponentPit.number` var) registers before the contracts;
  // the lines themselves are the voice script's `pool:opponent-pit/<base>`
  // steps. Two subjects gate the five contracts via
  // `SCENARIO_ID_TO_OPPONENT_PIT_ID`; the contracts deliberately carry NO
  // `family` so a pit train queues politely instead of truncating in-flight
  // lines about different cars (see the module header).
  registerOpponentPitVocabulary(engine, getOpponentPitLivePosition);

  for (const c of OPPONENT_PIT_CONTRACTS) {
    engine.defineContract(
      wrapWithMaster(
        wrapCalloutScenario(
          c,
          SCENARIO_ID_TO_OPPONENT_PIT_ID,
          getOpponentPitCalloutEnabled,
          "opponent-pit callout",
          logger,
        ),
      ),
    );
  }

  // Opponent-flag family (issue #936; scripted since #1065; reworked for
  // #1274). One contract per flag × relation (ahead/behind) so every line is
  // individually harness-firable, all at normal weight; both diff triggers
  // ride the same contracts, and the lines themselves are the voice script's
  // steps (the bundled lines name the car with the `opponentFlag.carNumber`
  // var, registered first, before a `pool:opponent-flags/<base>` tail).
  // Family-less + queueable for the same reason as opponent-pit: the lines
  // describe DIFFERENT cars — queue, never chop. The aggregate (`opponent-flag-others`) registers
  // master-gated but NOT per-flag-gated: the translator diff enforces the
  // per-flag opt-ins before anything feeds the aggregation, so the aggregate
  // by construction only describes enabled flags — gating it on one subject's
  // toggle would let a disabled subject silence it (#936 review).
  registerOpponentFlagVocabulary(engine, getOpponentFlagLivePosition);

  for (const c of OPPONENT_FLAG_CONTRACTS) {
    engine.defineContract(
      c.id === OPPONENT_FLAG_OTHERS_SCENARIO_ID
        ? wrapWithMaster(c)
        : wrapWithMaster(
            wrapCalloutScenario(
              c,
              SCENARIO_ID_TO_OPPONENT_FLAG_ID,
              getOpponentFlagCalloutEnabled,
              "opponent-flag callout",
              logger,
            ),
          ),
    );
  }

  // Rolling-start contract (issue #660; scripted since #1065): the pace-car
  // line is the active voice's business
  // (`scenarios["pit-crew.rolling-start-pace-car"]`, addressed as
  // `pool:rolling-start/pace-car-moving`). Single subject (`pace-car`) gates
  // the contract via `SCENARIO_ID_TO_ROLLING_START_ID`.
  for (const c of ROLLING_START_CONTRACTS) {
    engine.defineContract(
      wrapWithMaster(
        wrapCalloutScenario(
          c,
          SCENARIO_ID_TO_ROLLING_START_ID,
          getRollingStartCalloutEnabled,
          "rolling-start callout",
          logger,
        ),
      ),
    );
  }

  // Contracts (issue #1065): what a readback reads back is the active voice's
  // business (`scenarios["pit-crew.pit-readback-*"]` plus the `readback-body`
  // fragment in its `callouts.json`); the snapshot resolver went into the
  // `readback.*` vocabulary above, so the contracts are constants.
  for (const c of PIT_READBACK_CONTRACTS) {
    engine.defineContract(
      wrapWithMaster(
        wrapCalloutScenario(c, SCENARIO_ID_TO_PIT_READBACK_ID, getPitReadbackEnabled, "pit readback callout", logger),
      ),
    );
  }

  // Tire-wear report (issue #1108): what the report says is the active voice's
  // business (`scenarios["pit-crew.tire-wear-report"]`, addressing
  // `pool:tire-wear/<base>` and reading the numbers through the `tireWear.*`
  // vocabulary registered above). Published right after the exit readback,
  // from the same settle timer, so it queues behind it (see `tire-wear.ts`).
  // Single subject (`report`) gates the contract via
  // `SCENARIO_ID_TO_TIRE_WEAR_ID`.
  for (const c of TIRE_WEAR_CONTRACTS) {
    engine.defineContract(
      wrapWithMaster(
        wrapCalloutScenario(c, SCENARIO_ID_TO_TIRE_WEAR_ID, getTireWearCalloutEnabled, "tire-wear callout", logger),
      ),
    );
  }

  // Telemetry readouts on a Session Info key press (issue #466): what each
  // says is the active voice's business (`scenarios["pit-crew.readout-*"]`).
  // Master gate ONLY, like the opponent-flag aggregate: pressing the key is
  // the opt-in, and the key's own Speak value on press the one other switch,
  // so there is no per-callout setting, no callout id map and no
  // `PitCrewDeps` key — a Race Engineer checkbox that could leave a key doing
  // nothing would be a trap.
  for (const c of TELEMETRY_READOUT_CONTRACTS) {
    engine.defineContract(wrapWithMaster(c));
  }

  // Damage heads-up (issue #489) — a contract since #1065: the line is the
  // active voice's (`scenarios["pit-crew.damage-repair-needed"]`, addressing
  // `pool:damage/repair-needed`). Queueable since #1211: the event fires once
  // per damage episode, so a line dropped below the spotter's floor or behind
  // another line (the incident for the same crash, a caution call — #1288)
  // was never heard. It waits behind the incident and lap-invalidation
  // contracts registered below through `queueBehind`, which matches by id at
  // fire time, so registering it first is fine; its `speakGate` skips it once
  // the repair bits have cleared.
  for (const c of DAMAGE_CONTRACTS) {
    engine.defineContract(
      wrapWithMaster(
        wrapCalloutScenario(c, SCENARIO_ID_TO_DAMAGE_ID, getDamageCalloutEnabled, "damage callout", logger),
      ),
    );
  }

  // Pit-status contracts (issue #479; scripted since #1065): each line is the
  // active voice's (`scenarios["pit-crew.pit-status-*"]`, addressing
  // `pool:pit-status/<id>`), and each repeat nag re-checks the car at speak
  // time through its contract's `speakGate` (#1138). The repeat nags (issue
  // #951) ride the SAME per-status opt-ins as their transition siblings —
  // they're a modifier of one callout, not a new subject (the #572
  // precedent), so `SCENARIO_ID_TO_PIT_STATUS_ID` maps both spellings of each
  // id onto the same `PitStatusCalloutId`. The empty-stop release (issue
  // #1180) rides Complete's opt-in the same way.
  for (const c of [...PIT_STATUS_CONTRACTS, ...PIT_STATUS_REPEAT_CONTRACTS, PIT_STATUS_NOTHING_TO_DO_CONTRACT]) {
    engine.defineContract(
      wrapWithMaster(
        wrapCalloutScenario(c, SCENARIO_ID_TO_PIT_STATUS_ID, getPitStatusCalloutEnabled, "pit-status callout", logger),
      ),
    );
  }

  // Track-conditions contracts (issue #526; scripted since #1065): each
  // direction × target line is the active voice's business
  // (`scenarios["pit-crew.track-conditions-*"]`), addressed as
  // `pool:track-conditions/<direction>-<slug>`; the contract keeps the
  // direction / target filter and the family preemption.
  for (const c of TRACK_CONDITIONS_CONTRACTS) {
    engine.defineContract(
      wrapWithMaster(
        wrapCalloutScenario(
          c,
          SCENARIO_ID_TO_TRACK_CONDITIONS_ID,
          getTrackConditionsCalloutEnabled,
          "track-conditions callout",
          logger,
        ),
      ),
    );
  }

  // Pit-box count-in (issue #600) — contracts since #1065: each mark's clip is
  // the active voice's business (`scenarios["pit-crew.pit-box-*"]`, addressing
  // `pool:pit-box/<mark>`); the terse no-frame delivery stays on the contract.
  // Six per-mark contracts all gated by the one `count-in` opt-in via
  // `SCENARIO_ID_TO_PIT_BOX_ID`. No registration-order concern —
  // `pitBox.countdown` has no other subscribers.
  for (const c of PIT_BOX_CONTRACTS) {
    engine.defineContract(
      wrapWithMaster(
        wrapCalloutScenario(c, SCENARIO_ID_TO_PIT_BOX_ID, getPitBoxCalloutEnabled, "pit-box callout", logger),
      ),
    );
  }

  // Laps-of-fuel-left contracts (issue #838; scripted since #1065). Eleven
  // per-count contracts plus the enough-fuel confirmation (issue #880), one
  // opt-in each via `SCENARIO_ID_TO_FUEL_ID`; each line is the active voice's
  // business (`scenarios["pit-crew.fuel-laps-left-*"]`, addressed as
  // `pool:fuel/<base>`). No registration-order concern —
  // `fuel.lapsLeft.crossed` and `fuel.lapsLeft.raceCovered` have no other
  // subscribers.
  for (const c of FUEL_LAPS_LEFT_CONTRACTS) {
    engine.defineContract(
      wrapWithMaster(wrapCalloutScenario(c, SCENARIO_ID_TO_FUEL_ID, getFuelCalloutEnabled, "fuel callout", logger)),
    );
  }

  // Qualifying lap-invalidation contract (issue #567; scripted since #1065).
  // It shares the Voice bus with the incident contracts below at the default
  // `WEIGHT.NORMAL` band in a different family, and both are queueable since
  // #1211, so a line that meets a busy bus or the spotter's floor waits
  // rather than drops. The shape we want:
  //
  //   Qualifying + valid flying lap → the lap-invalidation line plays, the
  //                                     incident line yields (no double-up).
  //   Qualifying + out-lap / post-pit lap → qualifying contract's `where:`
  //                                     returns false (no fire),
  //                                     incident contract fires with generic
  //                                     "mind the kerbs" coaching.
  //   Race / practice / unknown        → qualifying contract's `where:`
  //                                     returns false (sessionType mismatch),
  //                                     incident contract fires normally.
  //
  // The first row is decided by a stash, not by the bus (#1211): this
  // contract fires on `incident.scored`, which the translator publishes
  // before `incident.occurred` on the same flush tick (#1122), and its
  // `where:` records the approved envelope's timestamp; the incident
  // contracts' `where:` refuses an `incident.occurred` with that timestamp.
  // Until #1211 the qualifying line merely took an idle bus first and the
  // incident line dropped as "bus busy" — which protected nothing on a busy
  // bus, and under the floor dropped the qualifying line while a queueable
  // incident line would have parked and played alone. The block still sits
  // before the incident loop for the reader; the order decides nothing.
  // incidents.ts deliberately does NOT gate on session type, because doing so
  // would silence incidents on out-laps too (where the qualifying contract
  // also stays silent).
  //
  // The per-lap latch is module-scope inside qualifying-invalidation.ts and
  // rolls over naturally as `(sessionNum, lapCompleted)` advances. The tail
  // is the `qualifying.*` vocabulary: the speakable gate as a condition and
  // the laps-left lookup as a case, both reading the snapshot at expansion
  // time.
  registerQualifyingInvalidationVocabulary(engine, getQualifyingInvalidationSnapshot);
  engine.defineContract(
    wrapWithMaster(
      wrapCalloutScenario(
        buildQualifyingInvalidationContract(getQualifyingInvalidationSnapshot),
        SCENARIO_ID_TO_QUALIFYING_INVALIDATION_ID,
        getQualifyingInvalidationCalloutEnabled,
        "qualifying lap-invalidation callout",
        logger,
      ),
    ),
  );

  // Incident contracts (scripted since #1065): the script's count clause
  // reads the `incident.points` var (issue #922) — vocabulary-before-contract
  // ordering, same as session-start. They fire on `incident.occurred`, which
  // the translator publishes AFTER the qualifying contract's `incident.scored`
  // on the same flush, and yield to a lap-invalidation line that approved it
  // (see the comment block above). Queueable since #1211: a collision nearly
  // always happens with a car alongside, and the spotter's floor dropped the
  // line; now it waits for the floor's release, and its `speakGate` refuses
  // it once the incident is more than ten seconds old.
  registerIncidentVocabulary(engine);

  for (const c of INCIDENT_CONTRACTS) {
    engine.defineContract(
      wrapWithMaster(
        wrapCalloutScenario(c, SCENARIO_ID_TO_INCIDENT_ID, getIncidentCalloutEnabled, "incident callout", logger),
      ),
    );
  }

  // Session-start readout (issue #542; scripted since #1065). The
  // `sessionStart.*` vars and the `setupWarning.qualifyingMismatch` condition
  // read their resolvers at expansion time; the contract's `where:` reads the
  // snapshot to refuse a fire with no telemetry at all and to leave race
  // sessions to race-start.
  registerSessionStartVocabulary(engine, getSessionStartSnapshot, getSetupWarningMismatch);
  engine.defineContract(
    wrapWithMaster(
      wrapCalloutScenario(
        buildSessionStartContract(getSessionStartSnapshot, logger),
        SCENARIO_ID_TO_SESSION_START_ID,
        getSessionStartCalloutEnabled,
        "session-start callout",
        logger,
      ),
    ),
  );

  // Lap-time best-lap contract (issue #555; scripted since #1065). The
  // readout's four components and the minute gate are the `lapTime.*`
  // vocabulary, reading the snapshot at expansion time; the contract keeps
  // only the race-finished gate and the full-course-caution gate its
  // `where:` reads.
  registerLapTimeVocabulary(engine, getLapCompletedSnapshot);
  engine.defineContract(
    wrapWithMaster(
      wrapCalloutScenario(
        // Pass the race-finished resolver so the best-lap callout is
        // suppressed on the final lap of a race (issue #569) — race-end
        // takes the floor — and the caution resolver so a pace lap under a
        // full-course caution never registers as a best lap (issue #1127).
        buildLapTimeContract(getRaceFinishedFired, getUnderFullCourseCaution),
        SCENARIO_ID_TO_LAP_TIME_ID,
        getLapTimeCalloutEnabled,
        "lap-time callout",
        logger,
      ),
    ),
  );

  // Corner-name callout (issue #888; scripted since #1065). The vocabulary
  // (the `cornerName.clip` var) registers before the contract, same as
  // session-start / lap-time; the name itself is the voice script's one step.
  registerCornerNameVocabulary(engine, getCornerNameSnapshot);
  engine.defineContract(
    wrapWithMaster(
      wrapCalloutScenario(
        buildCornerNameContract(getCornerNameSnapshot),
        SCENARIO_ID_TO_CORNER_NAME_ID,
        getCornerNameCalloutEnabled,
        "corner-name callout",
        logger,
      ),
    ),
  );

  // Position-change callout (issue #566; scripted since #1065). Ordering with
  // the lap-time scenario above is enforced by the position contract's
  // `weight: WEIGHT.CHATTER` + `queueable: true`, NOT by registration order —
  // the engine drops (not queues) cross-family equal-weight (`WEIGHT.NORMAL`)
  // fires when the bus is busy, but defers and replays the lower-weight
  // queueable position fire once the bus goes idle (see `position.ts` header).
  // The change-DETECTION (improved/worsened/first-fix) reads the frozen
  // `lap.completed` snapshot in `where:`; the readout's SHAPE and intro read
  // the same snapshot through the `position.*` vocabulary, and in race the
  // spoken NUMBER reads LIVE telemetry at speak-time via `getLivePosition`
  // (issue #574) and shares the position cooldown so an overtake readout + a
  // lap readout seconds apart don't double.
  registerPositionVocabulary(engine, getLapCompletedSnapshot, getLivePosition);
  engine.defineContract(
    wrapWithMaster(
      wrapCalloutScenario(
        // Pass the race-finished resolver so position-change is suppressed on
        // the final lap of a race (issue #569) — race-end takes the floor, and
        // without the gate position-change would queue "We're currently P[n]"
        // behind race-end and play it after the result speech. The caution
        // resolver silences the callout while a full-course caution is out
        // (issue #1127) — the frozen order catching up to official positions
        // is not a position change, and the caution sequence's own position
        // call, a third of the way into the last caution lap, reads the race
        // position out.
        buildPositionContract(getRaceFinishedFired, getLivePosition, getUnderFullCourseCaution),
        SCENARIO_ID_TO_POSITION_ID,
        getPositionCalloutEnabled,
        "position callout",
        logger,
      ),
    ),
  );

  // Race-status periodic position update (issue #569; scripted since #1065).
  // The cadence DECISION reads the frozen `lap.completed` snapshot in the
  // contract's `where:`; the spoken number and the leader condition are the
  // `raceStatus.*` vocabulary, reading LIVE telemetry at speak-time (issue
  // #574) and sharing the position cooldown.
  registerRaceStatusVocabulary(engine, getLivePosition);
  engine.defineContract(
    wrapWithMaster(
      wrapCalloutScenario(
        buildRaceStatusContract(getRaceFinishedFired, getLivePosition),
        SCENARIO_ID_TO_RACE_STATUS_ID,
        getRaceStatusCalloutEnabled,
        "race-status callout",
        logger,
      ),
    ),
  );

  // Gap callouts (issue #933; scripted since #1065): sustained trend flips +
  // threshold crossings against the class-standings neighbors. The decision
  // reads the event payload; the spoken line and the live gap number are the
  // voice script's `gap.*` vars, read LIVE at speak time. Both contracts
  // share one cooldown: the `where:` runs its pure check, the contract's
  // `speakGate` claims it (#1137).
  registerGapVocabulary(engine, getLiveGaps);

  for (const c of [
    buildGapTrendContract(getRaceFinishedFired, getOvertakeGate, getGapCooldownMs),
    buildGapThresholdContract(getRaceFinishedFired, getOvertakeGate, getGapCooldownMs),
  ]) {
    engine.defineContract(
      wrapWithMaster(wrapCalloutScenario(c, SCENARIO_ID_TO_GAP_ID, getGapCalloutEnabled, "gap callout", logger)),
    );
  }

  // Race-end final-result contract (issue #569; scripted since #1065). The
  // snapshot resolver is owned by the plugin (caches `race.finished` payload
  // via event-bus subscription, composes with the Property Inspector
  // driver-name pick); the `raceEnd.*` vars and the `raceEnd.result` case
  // read it at expansion time, the contract's `where:` reads it to refuse a
  // fire with no speakable position.
  registerRaceEndVocabulary(engine, getRaceFinishedSnapshot);
  engine.defineContract(
    wrapWithMaster(
      wrapCalloutScenario(
        buildRaceEndContract(getRaceFinishedSnapshot),
        SCENARIO_ID_TO_RACE_END_ID,
        getRaceEndCalloutEnabled,
        "race-end callout",
        logger,
      ),
    ),
  );

  // Race-start greeting + qualifying-position readout (issue #568; scripted
  // since #1065). Fires on `session.changed` in race sessions only; the
  // session-start contract's `where:` already skips race sessions so the two
  // never double-greet. Snapshot resolver is owned by the plugin (composes
  // `getRaceStartConditions()` from `@iracedeck/sim-events-iracing` with the
  // Property Inspector driver-name pick); the `raceStart.*` vars, the
  // grid-position case and the `setupWarning.raceMismatch` condition read
  // their resolvers at expansion time, the contract's `where:` reads the
  // snapshot to refuse a fire with no telemetry at all; `settle` waits for
  // the conditions themselves (#1284).
  registerRaceStartVocabulary(engine, getRaceStartSnapshot, getSetupWarningMismatch);
  engine.defineContract(
    wrapWithMaster(
      wrapCalloutScenario(
        buildRaceStartContract(getRaceStartSnapshot, logger),
        SCENARIO_ID_TO_RACE_START_ID,
        getRaceStartCalloutEnabled,
        "race-start callout",
        logger,
      ),
    ),
  );

  // Overtake callouts (issue #574; scripted since #1065). Each direction is
  // TWO contracts: a reaction (immediate, `family: "overtake"`) and a position
  // readout (`weight: WEIGHT.CHATTER` + `queueable: true`,
  // `family: "position-readout"`) that defers behind the reaction and speaks
  // "We're currently P[n]" from LIVE telemetry at speak-time. Both share the
  // same per-direction opt-in via `SCENARIO_ID_TO_OVERTAKE_ID`, and all are
  // suppressed once the race is over (`getRaceFinishedFired`). The lines are
  // the voice script's: the gained reaction branches on the
  // `overtake.gainedReaction` case, the lost reaction opens with the
  // `overtake.lost.comeOn` var (the driver-name resolver is composed in the
  // plugin from `resolveActiveDriverName(driverNames, "driver")`), and the
  // readouts speak the `positionReadout.*` vars.
  registerOvertakeVocabulary(engine, getOvertakeDriverName);
  registerPositionReadoutVocabulary(engine, getLivePosition);

  for (const c of [
    buildOvertakeGainedContract(getRaceFinishedFired, getOvertakeGate),
    buildOvertakeLostContract(getRaceFinishedFired, getOvertakeGate),
  ]) {
    engine.defineContract(
      wrapWithMaster(
        wrapCalloutScenario(c, SCENARIO_ID_TO_OVERTAKE_ID, getOvertakeCalloutEnabled, "overtake callout", logger),
      ),
    );
  }

  for (const c of [
    buildOvertakeGainedPositionContract(getLivePosition, getRaceFinishedFired, getOvertakeGate),
    buildOvertakeLostPositionContract(getLivePosition, getRaceFinishedFired, getOvertakeGate),
  ]) {
    engine.defineContract(
      wrapWithMaster(
        wrapCalloutScenario(
          c,
          SCENARIO_ID_TO_OVERTAKE_ID,
          getOvertakeCalloutEnabled,
          "overtake position readout",
          logger,
        ),
      ),
    );
  }
}

/**
 * What the gate wrappers below need of their input: an id (for the log line)
 * and an optional trigger whose `where:` they narrow. Both a legacy
 * `Scenario` and a `ScenarioContract` (issue #1064) satisfy it, and each
 * wrapper is generic over it so what goes in comes out with the same type —
 * a contract never grows a sequence by being gated.
 */
type Gated = { id: string; when?: ScenarioContract["when"]; settle?: ScenarioContract["settle"] };

/**
 * The `settle` of a gated callout, answered as ready while the gate is closed
 * (issue #1284). The settle wait runs before `where:`, so without this a
 * callout switched off would still wait out its window and log `proceeding
 * without …` at info for a fire its gate then refuses — a line that reads as
 * a callout that went ahead. Absent when the scenario declares no settle.
 */
function gatedSettle<T extends Gated>(s: T, isOpen: () => boolean): Pick<Gated, "settle"> {
  const settle = s.settle;

  if (!settle) return {};

  return { settle: { ...settle, pending: (ctx) => (isOpen() ? settle.pending(ctx) : null) } };
}

/**
 * Wrap a Race Engineer voice scenario with the plugin-wide master gate
 * (issue #515). Plugins compose the closure from
 * `pitCrewRaceEngineerEnabled === true`. Read live on every event
 * arrival and short-circuits before `attemptFire` so a clip already in
 * flight is NOT cut — only future events are suppressed. Applied as the
 * outermost wrapper inside `registerPitCrew` so a `false` master is the
 * cheapest possible early-out, ahead of per-callout opt-ins and
 * pit-action cooldowns.
 *
 * Returns the scenario unchanged when it has no `when:` block — a fragment
 * only ever reached through an `@` include (the radio frame was one until
 * issue #1064 moved it into the engine) runs inside a parent scenario whose
 * master-gate check has already passed.
 */
function wrapRaceEngineerMasterGate<T extends Gated>(s: T, getEnabled: () => boolean, logger: ILogger | undefined): T {
  if (!s.when) return s;

  const baseWhere = s.when.where;

  return {
    ...s,
    ...gatedSettle(s, getEnabled),
    when: {
      event: s.when.event,
      where: (ev) => {
        if (!getEnabled()) {
          logger?.debug(`race engineer master gate suppressed: ${s.id}`);

          return false;
        }

        return baseWhere ? baseWhere(ev) : true;
      },
    },
  };
}

/**
 * Wrap a per-toggle pit-action scenario so the cooldown set by
 * `pitLane.exited` / pre-start grid entry suppresses fires during the
 * cooldown window. Same gate-at-event-arrival shape as
 * `wrapCalloutScenario`, but global rather than per-id.
 */
function wrapPitActionScenario<T extends Gated>(s: T, getAllowed: () => boolean, logger: ILogger | undefined): T {
  if (!s.when) return s;

  const baseWhere = s.when.where;

  return {
    ...s,
    when: {
      event: s.when.event,
      where: (ev) => {
        if (!getAllowed()) {
          logger?.debug(`pit-action suppressed (cooldown active): ${s.id}`);

          return false;
        }

        return baseWhere ? baseWhere(ev) : true;
      },
    },
  };
}

/**
 * Wrap a per-toggle pit-service-request scenario with the user opt-in
 * gate (`calloutEnabledPitServiceRequests`, issue #468). Read live so a
 * toggle off mid-session takes effect on the next event arrival without
 * cutting an in-flight clip — same gate-at-event-arrival shape as the
 * other wrappers.
 */
function wrapPitServiceRequestsScenario<T extends Gated>(
  s: T,
  getEnabled: () => boolean,
  logger: ILogger | undefined,
): T {
  if (!s.when) return s;

  const baseWhere = s.when.where;

  return {
    ...s,
    when: {
      event: s.when.event,
      where: (ev) => {
        if (!getEnabled()) {
          logger?.debug(`pit service request suppressed: ${s.id}`);

          return false;
        }

        return baseWhere ? baseWhere(ev) : true;
      },
    },
  };
}

/**
 * Wrap a scenario's `where:` predicate so the user's plugin-global opt-in
 * is consulted on every event arrival. The wrapper short-circuits BEFORE
 * `attemptFire`, so disabling a callout while its scenario is already
 * playing does NOT cut playback — only future events are suppressed.
 *
 * Generic over the callout id type so flags (issue #467) and pit-readback
 * callouts (issue #476) share one wrapper. Throws if the scenario id is
 * missing from the id mapping — better to fail loudly at startup than
 * silently leak the unmapped scenario past the toggle.
 */
function wrapCalloutScenario<T extends Gated, TId extends string>(
  s: T,
  scenarioIdToCalloutId: Record<string, TId>,
  getCalloutEnabled: (id: TId) => boolean,
  description: string,
  logger: ILogger | undefined,
): T {
  const calloutId = scenarioIdToCalloutId[s.id];

  if (!calloutId) {
    throw new Error(`registerPitCrew: no callout id mapping for scenario "${s.id}"`);
  }

  if (!s.when) return s;

  const baseWhere = s.when.where;

  return {
    ...s,
    ...gatedSettle(s, () => getCalloutEnabled(calloutId)),
    when: {
      event: s.when.event,
      where: (ev) => {
        if (!getCalloutEnabled(calloutId)) {
          logger?.debug(`${description} suppressed: ${calloutId}`);

          return false;
        }

        return baseWhere ? baseWhere(ev) : true;
      },
    },
  };
}
