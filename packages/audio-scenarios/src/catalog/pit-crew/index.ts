/**
 * Pit Crew scenario catalog registration.
 *
 * The engine wires:
 *   - The directional radar (state-driven tick loop, not expressible in the
 *     scenario DSL)
 *   - All pools defined in `pools.ts`, registered en masse via
 *     `registerPools(engine)` — manifest-derived registry pools plus the
 *     enumerated acknowledgment pools (issue #664)
 *   - The radio-frame include scenarios (`@pit-crew.radio-open` / `…close`)
 *   - Fuel toggle scenarios (on/off via `pitService.toggled`)
 *   - Tire toggle scenarios (every meaningful tire-set selection, including
 *     singles, diagonals, and three-corner combos, via `tireService.changed`)
 *   - Tire compound scenarios (dry/wet via `tireService.compoundChanged`)
 *   - Windshield-tearoff toggle scenarios (on/off via `pitService.toggled`)
 *   - Fast-repair toggle scenarios (on/off via `pitService.toggled`)
 *   - Flag alert scenarios (every transition the translator publishes:
 *     yellow scope-aware, yellow.cleared, green, blue, white, red, black,
 *     checkered with session-type branch, debris, meatball)
 *   - Laps-of-fuel-left scenarios (counts 10 → 1 plus the box-this-lap call,
 *     via `fuel.lapsLeft.crossed` — issue #838)
 *
 * Other voice scenarios (welcome, pit-approach, incident alerts, limiter
 * callouts, tips, drs/p2p toggles) are not currently registered; they'll be
 * added one at a time as their `voice/{voice}/…` content is generated and
 * the corresponding pools and scenarios are reintroduced.
 *
 * `bus` is the event bus instance returned by `initializeEventBus(...)`;
 * passed through to `registerRadarEngine` so the radar engine and the
 * scenario engine share the same bus. Must be called once per plugin
 * startup, AFTER `initializeAudioScenarios(bus, …)`.
 *
 * `getFlagCalloutEnabled` is consulted on every flag event arrival to
 * decide whether to fire the callout (issue #467). It is read live, so
 * a user toggling a flag off mid-session takes effect on the very next
 * event of that color — without cancelling a callout already playing,
 * because the gate runs before `attemptFire` (which owns expansion,
 * preemption, and channel playback). Default `() => true` preserves
 * legacy behavior for callers that don't pass the closure (e.g. tests).
 *
 * `getReadbackSnapshot` is consulted at fire time inside every conditional
 * predicate of the pit-readback scenarios (issue #481). Plugins wire it
 * to `getReadbackSnapshot()` from `@iracedeck/sim-events-iracing` so a
 * deferred-replay readback (deferred behind a busier bus, or stashed when
 * an `interrupt` line cuts it) speaks the *current* queued-services state,
 * not the one frozen into the original event payload.
 */
import type { IEventBus, PitReadbackSnapshot, SessionStartSnapshot } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";
import { TrackDirection } from "@iracedeck/sim-events-iracing";

import type { Scenario } from "../../dsl.js";
import { getScenarioEngine, isAudioScenariosInitialized } from "../../interpreter.js";
import {
  buildCornerNameScenario,
  type CornerNameCalloutId,
  type CornerNameSnapshotResolver,
  registerCornerNameVars,
  SCENARIO_ID_TO_CORNER_NAME_ID,
} from "./corner-name.js";
import { DAMAGE_ALERTS } from "./damage-alerts.js";
import { FLAG_ALERTS } from "./flag-alerts.js";
import { FUEL_LAPS_LEFT_ALERTS } from "./fuel-laps-left.js";
import {
  buildGapThresholdScenario,
  buildGapTrendScenario,
  GAP_CALLOUT_DEFAULT_COOLDOWN_MS,
  type GapCalloutId,
  type LiveGapsResolver,
  registerGapVars,
  SCENARIO_ID_TO_GAP_ID,
} from "./gaps.js";
import { INCIDENT_ALERTS, registerIncidentVars } from "./incidents.js";
import {
  buildLapTimeScenario,
  type LapCompletedSnapshotResolver,
  type LapTimeCalloutId,
  registerLapTimeVars,
  SCENARIO_ID_TO_LAP_TIME_ID,
} from "./lap-time.js";
import {
  OPPONENT_PIT_ALERTS,
  type OpponentPitCalloutId,
  type OpponentPitLivePositionResolver,
  registerOpponentPitVars,
  SCENARIO_ID_TO_OPPONENT_PIT_ID,
} from "./opponent-pit.js";
import { type OvertakeGateResolver, PERMISSIVE_OVERTAKE_GATE } from "./overtake-gate.js";
import {
  buildOvertakeGainedScenario,
  buildOvertakeLostScenario,
  type OvertakeCalloutId,
  type OvertakeDriverNameResolver,
  registerOvertakeVars,
  SCENARIO_ID_TO_OVERTAKE_ID,
} from "./overtake.js";
import { PIT_BOX_ALERTS } from "./pit-box.js";
import { PIT_STATUS_ALERTS } from "./pit-status.js";
import { PIT_WINDOW_ALERTS } from "./pit-window.js";
import { registerPools } from "./pools.js";
import {
  buildOvertakeGainedPositionScenario,
  buildOvertakeLostPositionScenario,
  type LivePositionResolver,
  registerPositionReadoutVars,
} from "./position-readout.js";
import {
  buildPositionScenario,
  type PositionCalloutId,
  registerPositionVars,
  SCENARIO_ID_TO_POSITION_ID,
} from "./position.js";
import {
  buildQualifyingInvalidationScenario,
  type QualifyingInvalidationCalloutId,
  type QualifyingInvalidationSnapshotResolver,
  SCENARIO_ID_TO_QUALIFYING_INVALIDATION_ID,
} from "./qualifying-invalidation.js";
import {
  buildRaceEndScenario,
  type RaceEndCalloutId,
  type RaceFinishedSnapshotResolver,
  registerRaceEndVars,
  SCENARIO_ID_TO_RACE_END_ID,
} from "./race-end.js";
import {
  buildRaceStartScenario,
  type RaceStartCalloutId,
  type RaceStartSnapshotResolver,
  registerRaceStartVars,
  SCENARIO_ID_TO_RACE_START_ID,
} from "./race-start.js";
import {
  buildRaceStatusScenario,
  type RaceStatusCalloutId,
  registerRaceStatusVars,
  SCENARIO_ID_TO_RACE_STATUS_ID,
} from "./race-status.js";
import { registerRadarEngine } from "./radar-engine.js";
import { RADIO_CLOSE, RADIO_OPEN } from "./radio-frame.js";
import { buildPitReadbackScenarios, type PitReadbackCalloutId, SCENARIO_ID_TO_PIT_READBACK_ID } from "./readback.js";
import { ROLLING_START_ALERTS } from "./rolling-start.js";
import {
  buildSessionStartScenario,
  registerSessionStartVars,
  SCENARIO_ID_TO_SESSION_START_ID,
  type SessionStartCalloutId,
} from "./session-start.js";
import { registerSpotterEngine, SPOTTER_STILL_THERE_DEFAULT_MS } from "./spotter-engine.js";
import { START_LIGHT_ALERTS } from "./start-lights.js";
import {
  FAST_REPAIR_TOGGLE_SCENARIOS,
  FUEL_TOGGLE_SCENARIOS,
  TIRE_COMPOUND_SCENARIOS,
  TIRE_TOGGLE_SCENARIOS,
  WINDSHIELD_TOGGLE_SCENARIOS,
} from "./toggle-confirmations.js";
import { TRACK_CONDITIONS_ALERTS } from "./track-conditions.js";

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
  buildPitReadbackScenarios,
  PIT_READBACK_CALLOUT_SETTING_KEYS,
  type PitReadbackCalloutId,
  type ReadbackSnapshotResolver,
} from "./readback.js";
export {
  buildCornerNameScenario,
  CORNER_NAME_CALLOUT_SETTING_KEYS,
  type CornerNameCalloutId,
  type CornerNameSnapshot,
  type CornerNameSnapshotResolver,
} from "./corner-name.js";
export {
  _resetOpponentPitPending,
  OPPONENT_PIT_ALERTS,
  OPPONENT_PIT_CALLOUT_SETTING_KEYS,
  OPPONENT_PIT_POOL_NAMES,
  OPPONENT_PIT_SCENARIO_IDS,
  type OpponentPitCalloutId,
  type OpponentPitLivePositionResolver,
  type OpponentPitPending,
  registerOpponentPitVars,
} from "./opponent-pit.js";
export {
  buildLapTimeScenario,
  LAP_TIME_CALLOUT_SETTING_KEYS,
  type LapCompletedSnapshot,
  type LapCompletedSnapshotResolver,
  type LapTimeCalloutId,
  splitLapTime,
} from "./lap-time.js";
export {
  buildPositionScenario,
  POSITION_CALLOUT_SETTING_KEYS,
  type PositionCalloutId,
  positionChangeIsAnnounceable,
  selectEffectivePosition,
} from "./position.js";
export {
  buildQualifyingInvalidationScenario,
  QUALIFYING_INVALIDATION_CALLOUT_SETTING_KEYS,
  type QualifyingInvalidationCalloutId,
  type QualifyingInvalidationSnapshot,
  type QualifyingInvalidationSnapshotResolver,
  resetQualifyingInvalidationLatch,
} from "./qualifying-invalidation.js";
export {
  buildRaceEndScenario,
  RACE_END_CALLOUT_SETTING_KEYS,
  type RaceEndCalloutId,
  type RaceFinishedSnapshot,
  type RaceFinishedSnapshotResolver,
  selectEffectiveFinalPosition,
} from "./race-end.js";
export {
  buildRaceStartScenario,
  isRaceSession,
  RACE_START_CALLOUT_SETTING_KEYS,
  RACE_START_DELAY_MS,
  type RaceStartCalloutId,
  type RaceStartSnapshotResolver,
} from "./race-start.js";
export {
  buildRaceStatusScenario,
  RACE_STATUS_CALLOUT_SETTING_KEYS,
  RACE_STATUS_LAP_INTERVAL,
  type RaceStatusCalloutId,
  raceStatusCadenceHits,
} from "./race-status.js";
export {
  _resetGapCalloutCooldown,
  _setLastGapEvent,
  buildGapThresholdScenario,
  buildGapTrendScenario,
  GAP_CALLOUT_DEFAULT_COOLDOWN_MS,
  GAP_CALLOUT_SETTING_KEYS,
  type GapCalloutId,
  type LiveGapsResolver,
  resolveGapCooldownMs,
  tryClaimGapCallout,
} from "./gaps.js";
export {
  buildSessionStartScenario,
  SESSION_START_CALLOUT_SETTING_KEYS,
  type SessionStartCalloutId,
  type SessionStartSnapshotResolver,
} from "./session-start.js";
export {
  buildOvertakeGainedScenario,
  buildOvertakeLostScenario,
  OVERTAKE_CALLOUT_SETTING_KEYS,
  type OvertakeCalloutId,
  type OvertakeDriverNameResolver,
  overtakeGainIsAnnounceable,
  overtakeLossIsAnnounceable,
} from "./overtake.js";
export {
  _resetPositionReadoutCooldown,
  _setReactionRandom,
  buildOvertakeGainedPositionScenario,
  buildOvertakeLostPositionScenario,
  canAnnouncePosition,
  INTRO_COOLDOWN_MS,
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
 * One id per scenario in `FLAG_ALERTS`; the trailing segment of the
 * scenario id minus the `pit-crew.flag-` prefix.
 */
export type FlagCalloutId =
  | "yellow-local"
  | "yellow-full"
  | "yellow-cleared"
  | "green"
  | "blue"
  | "white"
  | "red"
  | "black"
  | "checkered"
  | "debris"
  | "meatball"
  // Issue #480 — missing-session-flag callouts.
  | "disqualify"
  | "furled"
  | "furled-cleared"
  | "dq-scoring-invalid"
  | "crossed"
  | "one-pace-lap-to-go"
  | "green-held"
  | "ten-to-go"
  | "five-to-go"
  | "yellow-waving"
  | "caution-waving";

/**
 * Canonical mapping from `FlagCalloutId` to its plugin-global setting
 * key in `GlobalSettingsSchema`. Plugin entry points use this to read
 * the live opt-in for each flag without duplicating the key strings.
 */
export const FLAG_CALLOUT_SETTING_KEYS: Record<FlagCalloutId, string> = {
  "yellow-local": "calloutEnabledFlagYellowLocal",
  "yellow-full": "calloutEnabledFlagYellowFull",
  "yellow-cleared": "calloutEnabledFlagYellowCleared",
  green: "calloutEnabledFlagGreen",
  blue: "calloutEnabledFlagBlue",
  white: "calloutEnabledFlagWhite",
  red: "calloutEnabledFlagRed",
  black: "calloutEnabledFlagBlack",
  checkered: "calloutEnabledFlagCheckered",
  debris: "calloutEnabledFlagDebris",
  meatball: "calloutEnabledFlagMeatball",
  disqualify: "calloutEnabledFlagDisqualify",
  furled: "calloutEnabledFlagFurled",
  "furled-cleared": "calloutEnabledFlagFurledCleared",
  "dq-scoring-invalid": "calloutEnabledFlagDqScoringInvalid",
  crossed: "calloutEnabledFlagCrossed",
  "one-pace-lap-to-go": "calloutEnabledFlagOnePaceLapToGo",
  "green-held": "calloutEnabledFlagGreenHeld",
  "ten-to-go": "calloutEnabledFlagTenToGo",
  "five-to-go": "calloutEnabledFlagFiveToGo",
  "yellow-waving": "calloutEnabledFlagYellowWaving",
  "caution-waving": "calloutEnabledFlagCautionWaving",
};

const SCENARIO_ID_TO_FLAG_ID: Record<string, FlagCalloutId> = {
  "pit-crew.flag-yellow-local": "yellow-local",
  "pit-crew.flag-yellow-full": "yellow-full",
  "pit-crew.flag-yellow-cleared": "yellow-cleared",
  "pit-crew.flag-green": "green",
  "pit-crew.flag-blue": "blue",
  "pit-crew.flag-white": "white",
  // Stage 2 of the two-stage white (issue #772) — same subject, same opt-in.
  "pit-crew.flag-white-last-lap": "white",
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
export type StartLightCalloutId = "lights" | "countdown";

/**
 * Canonical mapping from `StartLightCalloutId` to its plugin-global setting key
 * in `GlobalSettingsSchema`. Plugin entry points use this to read the live
 * opt-in without duplicating the key strings.
 */
export const START_LIGHT_CALLOUT_SETTING_KEYS: Record<StartLightCalloutId, string> = {
  lights: "calloutEnabledStartLights",
  countdown: "calloutEnabledStartCountdown",
};

const SCENARIO_ID_TO_START_LIGHT_ID: Record<string, StartLightCalloutId> = {
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
export type RollingStartCalloutId = "pace-car";

/**
 * Canonical mapping from `RollingStartCalloutId` to its plugin-global setting
 * key in `GlobalSettingsSchema`. Plugin entry points use this to read the live
 * opt-in without duplicating the key strings.
 */
export const ROLLING_START_CALLOUT_SETTING_KEYS: Record<RollingStartCalloutId, string> = {
  "pace-car": "calloutEnabledRollingStartPaceCar",
};

const SCENARIO_ID_TO_ROLLING_START_ID: Record<string, RollingStartCalloutId> = {
  "pit-crew.rolling-start-pace-car": "pace-car",
};

/**
 * Stable identifier for the pit-window callout family (issue #655). Single
 * subject (`pit-open-closed`) — both directions (pits opened / closed) share one
 * opt-in, the same "one opt-in over multiple scenarios" shape track-conditions
 * uses. Future pit-window sub-callouts can append cleanly under this family.
 */
export type PitWindowCalloutId = "pit-open-closed";

/**
 * Canonical mapping from `PitWindowCalloutId` to its plugin-global setting key
 * in `GlobalSettingsSchema`. Plugin entry points use this to read the live
 * opt-in without duplicating the key string.
 */
export const PIT_WINDOW_CALLOUT_SETTING_KEYS: Record<PitWindowCalloutId, string> = {
  "pit-open-closed": "calloutEnabledPitOpenClosed",
};

const SCENARIO_ID_TO_PIT_WINDOW_ID: Record<string, PitWindowCalloutId> = {
  "pit-crew.pit-window-opened": "pit-open-closed",
  "pit-crew.pit-window-closed": "pit-open-closed",
};

/**
 * Stable identifier for each user-toggleable damage callout (issue #489).
 * One id today (`repair-needed`) covering the combined
 * `MandRepNeeded | OptRepNeeded` rising edge. Future bits could split into
 * separate subjects without changing the wrapper.
 */
export type DamageCalloutId = "repair-needed";

/**
 * Canonical mapping from `DamageCalloutId` to its plugin-global setting key
 * in `GlobalSettingsSchema`. Plugin entry points use this to read the live
 * opt-in for each damage callout without duplicating key strings.
 */
export const DAMAGE_CALLOUT_SETTING_KEYS: Record<DamageCalloutId, string> = {
  "repair-needed": "calloutEnabledDamageRepairNeeded",
};

const SCENARIO_ID_TO_DAMAGE_ID: Record<string, DamageCalloutId> = {
  "pit-crew.damage-repair-needed": "repair-needed",
};

/**
 * Stable identifier for each user-toggleable pit-service-status callout
 * (issue #479). One id per non-`None` `PlayerCarPitSvStatus` target — the
 * idle state never reaches the bus, so it has no opt-out either. Eight
 * subjects today; future statuses (if iRacing ever extends `PitSvStatus`)
 * append cleanly because the wrapper is generic over `TId`.
 */
export type PitStatusCalloutId =
  | "in-progress"
  | "complete"
  | "too-far-left"
  | "too-far-right"
  | "too-far-forward"
  | "too-far-back"
  | "bad-angle"
  | "cant-fix-that";

/**
 * Canonical mapping from `PitStatusCalloutId` to its plugin-global setting
 * key in `GlobalSettingsSchema`. Plugin entry points use this to read the
 * live opt-in for each status callout without duplicating key strings.
 */
export const PIT_STATUS_CALLOUT_SETTING_KEYS: Record<PitStatusCalloutId, string> = {
  "in-progress": "calloutEnabledPitStatusInProgress",
  complete: "calloutEnabledPitStatusComplete",
  "too-far-left": "calloutEnabledPitStatusTooFarLeft",
  "too-far-right": "calloutEnabledPitStatusTooFarRight",
  "too-far-forward": "calloutEnabledPitStatusTooFarForward",
  "too-far-back": "calloutEnabledPitStatusTooFarBack",
  "bad-angle": "calloutEnabledPitStatusBadAngle",
  "cant-fix-that": "calloutEnabledPitStatusCantFixThat",
};

const SCENARIO_ID_TO_PIT_STATUS_ID: Record<string, PitStatusCalloutId> = {
  "pit-crew.pit-status-in-progress": "in-progress",
  "pit-crew.pit-status-complete": "complete",
  "pit-crew.pit-status-too-far-left": "too-far-left",
  "pit-crew.pit-status-too-far-right": "too-far-right",
  "pit-crew.pit-status-too-far-forward": "too-far-forward",
  "pit-crew.pit-status-too-far-back": "too-far-back",
  "pit-crew.pit-status-bad-angle": "bad-angle",
  "pit-crew.pit-status-cant-fix-that": "cant-fix-that",
};

/**
 * Stable identifier for each user-toggleable incident callout (issue #530).
 * Mirrors the bus's `IncidentType` discriminator one-to-one. `out-of-control`
 * defaults `false` in the schema (the spin is usually obvious to the
 * driver); the other five default `true`.
 */
export type IncidentCalloutId =
  "off-track" | "out-of-control" | "contact-world" | "collision-world" | "contact-car" | "collision-car";

/**
 * Canonical mapping from `IncidentCalloutId` to its plugin-global setting key
 * in `GlobalSettingsSchema`. Plugin entry points use this to read the live
 * opt-in for each incident type without duplicating key strings.
 */
export const INCIDENT_CALLOUT_SETTING_KEYS: Record<IncidentCalloutId, string> = {
  "off-track": "calloutEnabledIncidentOffTrack",
  "out-of-control": "calloutEnabledIncidentOutOfControl",
  "contact-world": "calloutEnabledIncidentContactWorld",
  "collision-world": "calloutEnabledIncidentCollisionWorld",
  "contact-car": "calloutEnabledIncidentContactCar",
  "collision-car": "calloutEnabledIncidentCollisionCar",
};

const SCENARIO_ID_TO_INCIDENT_ID: Record<string, IncidentCalloutId> = {
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
export type TrackConditionsCalloutId = "wetness";

/**
 * Canonical mapping from `TrackConditionsCalloutId` to its plugin-global
 * setting key in `GlobalSettingsSchema`. Plugin entry points use this to
 * read the live opt-in for each subject without duplicating key strings.
 */
export const TRACK_CONDITIONS_CALLOUT_SETTING_KEYS: Record<TrackConditionsCalloutId, string> = {
  wetness: "calloutEnabledTrackWetness",
};

// Position callout id is defined in ./position.ts and re-exported above.
// The setting-key map and scenario-id map both live there too so the
// canonical id↔key↔scenario triplet stays in one file.

const SCENARIO_ID_TO_TRACK_CONDITIONS_ID: Record<string, TrackConditionsCalloutId> = {
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
export type PitBoxCalloutId = "count-in";

/**
 * Canonical mapping from `PitBoxCalloutId` to its plugin-global setting key in
 * `GlobalSettingsSchema`. Plugin entry points use this to read the live opt-in
 * without duplicating the key string.
 */
export const PIT_BOX_CALLOUT_SETTING_KEYS: Record<PitBoxCalloutId, string> = {
  "count-in": "calloutEnabledPitBoxCountIn",
};

const SCENARIO_ID_TO_PIT_BOX_ID: Record<string, PitBoxCalloutId> = {
  "pit-crew.pit-box-five": "count-in",
  "pit-crew.pit-box-four": "count-in",
  "pit-crew.pit-box-three": "count-in",
  "pit-crew.pit-box-two": "count-in",
  "pit-crew.pit-box-one": "count-in",
  "pit-crew.pit-box-pit-now": "count-in",
};

/**
 * Stable identifier for each user-toggleable laps-of-fuel-left callout
 * (issue #838). One id per spoken count — the trailing segment of the
 * scenario id minus the `pit-crew.fuel-` prefix. `laps-left-box` is the
 * count-0 "box this lap for fuel" call.
 */
export type FuelCalloutId =
  | "laps-left-10"
  | "laps-left-9"
  | "laps-left-8"
  | "laps-left-7"
  | "laps-left-6"
  | "laps-left-5"
  | "laps-left-4"
  | "laps-left-3"
  | "laps-left-2"
  | "laps-left-1"
  | "laps-left-box"
  | "race-covered";

/**
 * Canonical mapping from `FuelCalloutId` to its plugin-global setting key in
 * `GlobalSettingsSchema`. Plugin entry points use this to read the live
 * opt-in for each count without duplicating the key strings. Defaults are
 * NOT uniform (unlike most callout families): 5, 3, 2, 1, Box, and the
 * enough-fuel confirmation (`race-covered`, issue #880) ship ON; counts
 * 10–6 and 4 ship OFF — see the schema fields in deck-core.
 */
export const FUEL_CALLOUT_SETTING_KEYS: Record<FuelCalloutId, string> = {
  "laps-left-10": "calloutEnabledFuelLapsLeft10",
  "laps-left-9": "calloutEnabledFuelLapsLeft9",
  "laps-left-8": "calloutEnabledFuelLapsLeft8",
  "laps-left-7": "calloutEnabledFuelLapsLeft7",
  "laps-left-6": "calloutEnabledFuelLapsLeft6",
  "laps-left-5": "calloutEnabledFuelLapsLeft5",
  "laps-left-4": "calloutEnabledFuelLapsLeft4",
  "laps-left-3": "calloutEnabledFuelLapsLeft3",
  "laps-left-2": "calloutEnabledFuelLapsLeft2",
  "laps-left-1": "calloutEnabledFuelLapsLeft1",
  "laps-left-box": "calloutEnabledFuelLapsLeftBox",
  "race-covered": "calloutEnabledFuelLapsLeftRaceCovered",
};

const SCENARIO_ID_TO_FUEL_ID: Record<string, FuelCalloutId> = {
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
export type SpotterCalloutId = "cars" | "still-there";

/** Canonical map from {@link SpotterCalloutId} to its global-settings key. */
export const SPOTTER_CALLOUT_SETTING_KEYS: Record<SpotterCalloutId, string> = {
  cars: "calloutEnabledSpotterCars",
  "still-there": "calloutEnabledSpotterStillThere",
};

/** Global-settings key for the user-configurable "still there" cadence (seconds, issue #651). */
export const SPOTTER_STILL_THERE_SECONDS_KEY = "spotterStillThereSeconds";

/**
 * Resolver the plugins pass to {@link registerPitCrew}: given the current
 * session kind, returns whether the loaded setup name looks wrong for it (opt-in
 * on AND the session-kind pattern matches). Read live at fire time inside the
 * session-start / race-start `if` clauses (issue #625).
 *
 * Unlike the other callout families, the setup warning is a conditional clause
 * appended to the existing session-start / race-start intros — not its own
 * scenario — so it has no `SCENARIO_ID_TO_*` map and no `*_CALLOUT_SETTING_KEYS`
 * map here: the opt-in is read inside this resolver (the plugins compose it from
 * `evaluateSetupWarning`, whose canonical key is `SETUP_WARNING_ENABLED_KEY` in
 * `@iracedeck/deck-core`), not via `wrapCalloutScenario`.
 */
export type SetupWarningResolver = (kind: "qualifying" | "race") => boolean;

export function registerPitCrew(
  bus: IEventBus,
  getFlagCalloutEnabled: (id: FlagCalloutId) => boolean = () => true,
  logger?: ILogger,
  getPitReadbackEnabled: (id: PitReadbackCalloutId) => boolean = () => true,
  // Allow / suppress per-toggle pit-action confirmations (issue #476).
  // Plugins wire this to `isPitActionsAllowed()` from
  // `@iracedeck/sim-events-iracing` so the cooldowns set by `pitLane.exited`
  // and pre-start grid entry silence the toggle callouts during those
  // windows. Default `() => true` preserves legacy behavior for tests
  // that don't supply a closure.
  getPitActionsAllowed: () => boolean = () => true,
  // User opt-in for the per-toggle pit-service request confirmations
  // (issue #468). Plugins wire this to the `calloutEnabledPitServiceRequests`
  // global setting — read live so a toggle off mid-session takes effect on
  // the next event arrival without cutting an in-flight clip. Distinct
  // from `getPitActionsAllowed` (engine-internal cooldown vs persistent
  // user preference) so they can move independently.
  getPitServiceRequestsEnabled: () => boolean = () => true,
  // Pit-readback queued-services snapshot (issue #481). Plugins wire this
  // to `getReadbackSnapshot()` from `@iracedeck/sim-events-iracing`, which
  // builds a snapshot from the latest telemetry tick. Read at fire time
  // inside every readback predicate so deferred replays speak the
  // *current* queue rather than a snapshot frozen into the original
  // event. Default `() => null` collapses every readback to the
  // empty-fallback clip — a safe stub for tests that don't supply a
  // resolver.
  getReadbackSnapshot: () => PitReadbackSnapshot | null = () => null,
  // User opt-in for the damage-alert callout (issue #489). Same
  // gate-at-event-arrival shape as the flag and pit-readback callouts —
  // toggling off mid-session takes effect on the next event without
  // cutting an in-flight clip. Default `() => true` preserves legacy
  // behavior for tests that don't supply a closure.
  getDamageCalloutEnabled: (id: DamageCalloutId) => boolean = () => true,
  // User opt-in for the per-status pit-service callouts (issue #479).
  // Same gate-at-event-arrival shape as the other callout families.
  // Default `() => true` preserves legacy behavior for tests that don't
  // supply a closure.
  getPitStatusCalloutEnabled: (id: PitStatusCalloutId) => boolean = () => true,
  // User opt-in for the track-conditions callouts (issue #526).
  // Single subject (`wetness`) today; same gate-at-event-arrival shape as
  // the other callout families. Default `() => true` preserves legacy
  // behavior for tests that don't supply a closure.
  getTrackConditionsCalloutEnabled: (id: TrackConditionsCalloutId) => boolean = () => true,
  // User opt-in for the per-incident-type callouts (issue #530). Plugins
  // wire this to each `calloutEnabledIncident*` global setting via
  // `INCIDENT_CALLOUT_SETTING_KEYS` — read live so a toggle off
  // mid-session takes effect on the next event without cutting an
  // in-flight clip. Default `() => true` preserves legacy behavior for
  // tests that don't supply a closure.
  getIncidentCalloutEnabled: (id: IncidentCalloutId) => boolean = () => true,
  // User opt-in for the session-start readout (issues #542, #668). Fired when
  // a practice or qualifying session starts (on session.changed, ~3 s in),
  // whether or not the driver leaves the garage. Plugins wire this to the
  // `calloutEnabledSessionStart` global setting via
  // `SESSION_START_CALLOUT_SETTING_KEYS` — read live, same gate-at-event-
  // arrival shape as the other callout families. Default `() => true`
  // preserves legacy behavior for tests that don't supply a closure.
  getSessionStartCalloutEnabled: (id: SessionStartCalloutId) => boolean = () => true,
  // Session-start conditions snapshot (issue #542). Plugins wire this to a
  // closure that composes `getSessionStartConditions()` from
  // `@iracedeck/sim-events-iracing` with the Property Inspector driver-name
  // pick. Read at fire time inside the scenario's `where:` predicate and
  // per-clip `var` resolvers. Default `() => null` makes the scenario's
  // `where:` short-circuit — a safe stub for tests that don't supply a
  // resolver.
  getSessionStartSnapshot: () => SessionStartSnapshot | null = () => null,
  // User opt-in for the lap-time best-lap callout (issue #555). Same
  // gate-at-event-arrival shape as the other callout families. Default
  // `() => true` preserves legacy behavior for tests that don't supply a
  // closure.
  getLapTimeCalloutEnabled: (id: LapTimeCalloutId) => boolean = () => true,
  // Last `lap.completed` event payload (issue #555). Plugins wire this to a
  // closure backed by an event-bus subscription that captures the most
  // recent payload. Read at fire time inside the scenario's per-clip `var`
  // resolvers so a deferred replay still speaks the lap data that was frozen
  // at S/F crossing. Default `() => null` makes the var resolvers return
  // null — a safe stub for tests that don't supply a resolver. Reused by the
  // position-change callout (issue #566) — both scenarios subscribe to the
  // same `lap.completed` event and share the snapshot cache.
  getLapCompletedSnapshot: LapCompletedSnapshotResolver = () => null,
  // User opt-in for the position-change callout (issue #566). Single subject;
  // same gate-at-event-arrival shape as the other callout families. Default
  // `() => true` preserves legacy behavior for tests that don't supply a
  // closure.
  getPositionCalloutEnabled: (id: PositionCalloutId) => boolean = () => true,
  // User opt-in for the qualifying lap-invalidation callout (issue #567).
  // Single subject; same gate-at-event-arrival shape as the other callout
  // families. Default `() => true` preserves legacy behavior for tests that
  // don't supply a closure.
  getQualifyingInvalidationCalloutEnabled: (id: QualifyingInvalidationCalloutId) => boolean = () => true,
  // Snapshot resolver for the qualifying lap-invalidation callout (issue
  // #567). Plugins wire this to a closure that builds the snapshot from the
  // latest telemetry tick + session info. Read at fire time inside the
  // scenario's `where:` predicate (qualifying gate + per-lap latch) and again
  // inside the tail's conditional branches and the lap-count `var` resolver.
  // Default `() => null` makes the scenario's `where:` short-circuit — a safe
  // stub for tests that don't supply a resolver.
  getQualifyingInvalidationSnapshot: QualifyingInvalidationSnapshotResolver = () => null,
  // User opt-in for the race-status periodic position update (issue #569).
  // Single subject; same gate-at-event-arrival shape as the other callout
  // families. Default `() => true` preserves legacy behavior for tests that
  // don't supply a closure.
  getRaceStatusCalloutEnabled: (id: RaceStatusCalloutId) => boolean = () => true,
  // Race-end latch (issue #569). Plugins wire this to a getter exposed by
  // `@iracedeck/sim-events-iracing` that reads the translator's
  // `state.raceFinishedFired`. Race-status `where:` reads it live so the
  // periodic status callout suppresses itself on the final lap (race-end
  // fires on the same `lap.completed` tick — the diff emits `race.finished`
  // first into the pending queue, latch flips synchronously before
  // `lap.completed` publishes). Default `() => false` (race never ends) keeps
  // legacy behavior for tests that don't supply a closure.
  getRaceFinishedFired: () => boolean = () => false,
  // User opt-in for the race-end final-result callout (issue #569). Single
  // subject; same gate-at-event-arrival shape as the other callout families.
  // Default `() => true` preserves legacy behavior for tests that don't
  // supply a closure.
  getRaceEndCalloutEnabled: (id: RaceEndCalloutId) => boolean = () => true,
  // Race-end snapshot resolver (issue #569). Plugins compose this from the
  // cached `race.finished` event payload plus the Property Inspector
  // driver-name pick. Read at fire time inside the scenario's `where:`
  // predicate and per-clip `var` resolvers — same deferred-snapshot pattern
  // as session-start. Default `() => null` makes the scenario's `where:`
  // short-circuit — a safe stub for tests that don't supply a resolver.
  getRaceFinishedSnapshot: RaceFinishedSnapshotResolver = () => null,
  // User opt-in for the race-start greeting + qualifying-position readout
  // (issue #568). Single subject; same gate-at-event-arrival shape as the
  // other callout families. Default `() => true` preserves legacy behavior
  // for tests that don't supply a closure.
  getRaceStartCalloutEnabled: (id: RaceStartCalloutId) => boolean = () => true,
  // Race-start conditions snapshot (issue #568). Plugins wire this to a
  // closure that composes `getRaceStartConditions()` from
  // `@iracedeck/sim-events-iracing` with the Property Inspector driver-name
  // pick. Read at fire time inside the scenario's `where:` predicate and
  // per-clip `var` resolvers. Default `() => null` makes the scenario's
  // `where:` short-circuit — a safe stub for tests that don't supply a
  // resolver.
  getRaceStartSnapshot: RaceStartSnapshotResolver = () => null,
  // User opt-in for the overtake callouts (issue #574). Two subjects —
  // `gained` and `lost` — independently toggleable. Same gate-at-event-
  // arrival shape as the other callout families. Default `() => true`
  // preserves legacy behavior for tests that don't supply a closure.
  getOvertakeCalloutEnabled: (id: OvertakeCalloutId) => boolean = () => true,
  // Driver-name resolver for the loss-line "Come on, <name>" composition
  // (issue #574). Plugins wire this to `resolveActiveDriverName(driverNames,
  // "driver")` so the resolver returns the user-picked name when valid and
  // falls back to the pre-recorded `"driver"` clip otherwise — the loss
  // line stays a complete sentence even when the user's name isn't in the
  // greeting pool. Default `() => null` skips the name step (rare; tests).
  getOvertakeDriverName: OvertakeDriverNameResolver = () => null,
  // Live position resolver (issue #574 follow-up). Plugins wire this to
  // `getLivePosition()` from `@iracedeck/sim-events-iracing`. Read at
  // speak-time inside the "We're currently P[n]" var resolvers (overtake
  // readout, race position-change, race-status) so the spoken position is
  // accurate to the moment it's said, not frozen at the triggering event.
  // Default `() => null` makes those readouts stay silent — a safe stub for
  // tests that don't supply a resolver.
  getLivePosition: LivePositionResolver = () => null,
  // Overtake gate (issue #574 follow-up). Plugins compose this from
  // `getOvertakeTelemetryGate()` (`@iracedeck/sim-events-iracing`) plus a
  // tracked `incident.occurred` timestamp. Read at event time to suppress the
  // WHOLE overtake callout (reaction + position, both directions) when the
  // swap wasn't a clean racing moment — cars alongside, off-track, crawling,
  // pit road, or a recent incident. Default permissive so callers that don't
  // wire it (tests) still fire; the real plugin gate returns `null` only when
  // telemetry is unavailable, which suppresses.
  getOvertakeGate: OvertakeGateResolver = () => PERMISSIVE_OVERTAKE_GATE,
  // User opt-in for the pit-box count-in (issue #600). Single subject
  // (`count-in`) gating all six distance-mark scenarios. Same gate-at-event-
  // arrival shape as the other callout families — toggling off mid-session
  // takes effect on the next mark without cutting an in-flight clip. Placed
  // before the master gate so the master stays the last per-callout opt-in.
  // Default `() => true` preserves legacy behavior for tests that don't supply
  // a closure.
  getPitBoxCalloutEnabled: (id: PitBoxCalloutId) => boolean = () => true,
  // Setup-mismatch warning resolver (issue #625). Plugins wire this to read
  // the live opt-in + the session-kind regex pattern from global settings and
  // test it against the live setup name. Consumed inside the session-start and
  // race-start scenarios' `if` clauses (not via `wrapCalloutScenario`, since the
  // warning is a clause inside those intros, not its own scenario). Placed
  // before the master gate so the master stays the last per-callout opt-in.
  // Default `() => false` — tests that don't supply a closure never append the
  // warning clause.
  getSetupWarningMismatch: SetupWarningResolver = () => false,
  // Spotter per-callout opt-ins (issue #651). The spotter is a Race Engineer
  // callout family (no standalone master) — it rides `getRaceEngineerMasterEnabled`
  // below. "cars" gates every transition call; "still-there" gates the repeating
  // reminder. Read live. Default `() => true`. Placed before the master gates so
  // the masters stay the last params (the registerPitCrew convention).
  getSpotterCalloutEnabled: (id: SpotterCalloutId) => boolean = () => true,
  // Spotter road/oval terminology (issue #651). Plugins wire this to
  // `getTrackDirection()` from `@iracedeck/sim-events-iracing`. Default Neutral (road).
  getSpotterTrackDirection: () => TrackDirection = () => TrackDirection.Neutral,
  // Spotter "still there" reminder cadence in ms (issue #651). Plugins wire this
  // to `resolveStillThereIntervalMs(spotterStillThereSeconds)`; read live each
  // tick so a slider change takes effect on the next reminder. Default 3 s.
  getSpotterStillThereIntervalMs: () => number = () => SPOTTER_STILL_THERE_DEFAULT_MS,
  // Spotter nearest-car gap in meters (issue #651) for the → clear confirmation
  // buffer. Plugins wire this to `getNearestCarGapMeters()` from
  // `@iracedeck/sim-events-iracing`. Default `() => null` disables the buffer.
  getSpotterNearestCarGapMeters: () => number | null = () => null,
  // User opt-in for the pit-window open/closed callout (issue #655). Single
  // subject (`pit-open-closed`) gating both directional scenarios. Same
  // gate-at-event-arrival shape as the other callout families: read live so a
  // toggle off mid-session takes effect on the next event without cutting an
  // in-flight clip. Placed before the master gate so the master stays the last
  // per-callout opt-in. Default `() => true` preserves legacy behavior for tests
  // that don't supply a closure.
  getPitWindowCalloutEnabled: (id: PitWindowCalloutId) => boolean = () => true,
  // User opt-in for the rolling-start callout (issue #660). Single subject
  // (`pace-car`) gating the "pace car is moving" line. Same gate-at-event-
  // arrival shape as the other callout families: read live so a toggle off
  // mid-session takes effect on the next event without cutting an in-flight
  // clip. Placed before the master gate so the master stays the last
  // per-callout opt-in. Default `() => true` preserves legacy behavior for
  // tests that don't supply a closure.
  getRollingStartCalloutEnabled: (id: RollingStartCalloutId) => boolean = () => true,
  // User opt-in for the start-light callouts (issue #480). Two grouped
  // subjects — `lights` (the three gantry lines) and `countdown` (the five
  // numeric marks) — mirroring the pit-box "many scenarios → one subject"
  // shape. Same gate-at-event-arrival shape as the other callout families:
  // read live so a toggle off mid-session takes effect on the next event
  // without cutting an in-flight clip. Placed before the master gate so the
  // master stays the last per-callout opt-in. Default `() => true` preserves
  // legacy behavior for tests that don't supply a closure.
  getStartLightCalloutEnabled: (id: StartLightCalloutId) => boolean = () => true,
  // User opt-in for the laps-of-fuel-left callouts (issue #838). One boolean
  // per spoken count (10 → 1 plus the count-0 box call). Same gate-at-event-
  // arrival shape as the other callout families: read live so a toggle off
  // mid-session takes effect on the next crossing without cutting an
  // in-flight clip. Placed before the master gate so the master stays the
  // last per-callout opt-in. Default `() => true` preserves legacy behavior
  // for tests that don't supply a closure.
  getFuelCalloutEnabled: (id: FuelCalloutId) => boolean = () => true,
  // User opt-in for the corner-name callouts (issue #888). Single subject
  // gating the practice/test corner announcements. Same gate-at-event-arrival
  // shape as the other callout families. Placed before the master gate so the
  // master stays the last per-callout opt-in. Default `() => true` preserves
  // legacy behavior for tests that don't supply a closure.
  getCornerNameCalloutEnabled: (id: CornerNameCalloutId) => boolean = () => true,
  // Corner-name snapshot (issue #888). Plugins cache the latest
  // `cornerName.approaching` payload (the lap-time subscription pattern) and
  // pass the getter; the clip resolver reads it at expansion time. Default
  // `() => null` makes the scenario's `where:` short-circuit — a safe stub
  // for tests.
  getCornerNameSnapshot: CornerNameSnapshotResolver = () => null,
  // User opt-ins for the opponent-pit callouts (issue #622). Two subjects —
  // `leader` (the race/class leader entering the pits) and `nearby` (same-lap
  // cars within ±2 effective positions, incl. the aggregate tail). Same
  // gate-at-event-arrival shape as the other callout families. Placed before
  // the master gate so the master stays the last per-callout opt-in. Default
  // `() => true` preserves legacy behavior for tests that don't supply a
  // closure.
  getOpponentPitCalloutEnabled: (id: OpponentPitCalloutId) => boolean = () => true,
  // Opponent-pit live position resolver (issue #622). Plugins wire
  // `getLiveCarPosition` so the nearby line's number is fresh at speak time,
  // read in the projection the event was classified in (the pending stash's
  // `isMultiClass`). The pitting car itself is carried by a module-scope
  // stash written in the nearby scenario's `where:` (the #922 shape), so a
  // later event of a different relation can never repoint a deferred line.
  // Default `() => null` falls back to the emit-time payload position — a
  // safe stub for tests and the harness.
  getOpponentPitLivePosition: OpponentPitLivePositionResolver = () => null,
  // Gap callout opt-ins (issue #933). One boolean per callout type (trend
  // flip / threshold crossing); same gate-at-event-arrival shape as the
  // other callout families — read live so a toggle off mid-session takes
  // effect on the next event without cutting an in-flight clip. Placed
  // before the master gates so the masters stay the last args. Default
  // `() => true` preserves legacy behavior for tests that don't supply a
  // closure.
  getGapCalloutEnabled: (id: GapCalloutId) => boolean = () => true,
  // Shared gap-callout cooldown in ms (issue #933). Plugins wire this to
  // `resolveGapCooldownMs(gapCalloutCooldownSeconds)`; read live at event
  // arrival so a slider change applies to the next callout. Default 30 s.
  getGapCooldownMs: () => number = () => GAP_CALLOUT_DEFAULT_COOLDOWN_MS,
  // Live gaps resolver (issue #933). Plugins wire `getLiveGaps()` from the
  // translator; the spoken gap number reads it at speak time (the #574
  // live-at-speak-time pattern). Default `() => null` skips the readout
  // clause — a safe stub for tests.
  getLiveGaps: LiveGapsResolver = () => null,
  // Master gate for the Race Engineer voice subsystem (issue #515).
  // Plugins wire this to `pitCrewRaceEngineerEnabled === true`. Read live
  // on every event arrival and applied as the OUTERMOST wrapper around
  // every voice scenario, so a fresh install (or a deck with no Pit Crew
  // button) suppresses dispatch entirely — independent of audio bus
  // volumes, per-callout opt-ins, or pit-action cooldowns. Default
  // `() => true` preserves legacy behavior for tests that don't supply a
  // closure.
  getRaceEngineerMasterEnabled: () => boolean = () => true,
  // Master gate for the directional radar (issue #515). Plumbed into
  // `registerRadarEngine` and consulted on every `radar.changed` arrival
  // and on every scheduled tick — same defense-in-depth shape as the
  // voice master gate, but inside the imperative engine since radar
  // isn't expressed as a scenario. Default `() => true` preserves legacy
  // behavior for tests that don't supply a closure.
  getRadarMasterEnabled: () => boolean = () => true,
): void {
  registerRadarEngine(bus, getRadarMasterEnabled);

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

  registerPools(engine);

  engine.defineScenario(RADIO_OPEN);
  engine.defineScenario(RADIO_CLOSE);

  // Master gate is applied as the outermost wrapper so per-callout opt-ins,
  // pit-action cooldowns, and readback predicates only run when the
  // engineer is on at all. Cheap short-circuit on the master saves every
  // inner wrapper from running on every event arrival.
  const wrapWithMaster = (s: Scenario): Scenario => wrapRaceEngineerMasterGate(s, getRaceEngineerMasterEnabled, logger);

  // Each pit-service toggle scenario is wrapped three times. Outermost
  // wrapper applies the master gate (`pitCrewRaceEngineerEnabled`); next
  // applies the user opt-in (`calloutEnabledPitServiceRequests`);
  // innermost applies the engine-internal cooldown
  // (`isPitActionsAllowed`). Outer-first because the master gate is the
  // cheapest, most-persistent check.
  const wrapToggle = (s: Scenario): Scenario =>
    wrapWithMaster(
      wrapPitServiceRequestsScenario(
        wrapPitActionScenario(s, getPitActionsAllowed, logger),
        getPitServiceRequestsEnabled,
        logger,
      ),
    );

  for (const s of FUEL_TOGGLE_SCENARIOS) {
    engine.defineScenario(wrapToggle(s));
  }

  for (const s of TIRE_TOGGLE_SCENARIOS) {
    engine.defineScenario(wrapToggle(s));
  }

  for (const s of TIRE_COMPOUND_SCENARIOS) {
    engine.defineScenario(wrapToggle(s));
  }

  for (const s of WINDSHIELD_TOGGLE_SCENARIOS) {
    engine.defineScenario(wrapToggle(s));
  }

  for (const s of FAST_REPAIR_TOGGLE_SCENARIOS) {
    engine.defineScenario(wrapToggle(s));
  }

  for (const s of FLAG_ALERTS) {
    engine.defineScenario(
      wrapWithMaster(wrapCalloutScenario(s, SCENARIO_ID_TO_FLAG_ID, getFlagCalloutEnabled, "flag callout", logger)),
    );
  }

  // Start-light family (issue #480). The `start-light-*` pools are already
  // registered en masse above via `registerPools(engine)` (same as the flag
  // pools), so no explicit pool loop is needed here — `START_LIGHT_POOL_NAMES`
  // exists for the catalog tests to register pools in isolation. Two grouped
  // opt-ins (`lights`, `countdown`) gate the five scenarios via
  // `SCENARIO_ID_TO_START_LIGHT_ID`.
  for (const s of START_LIGHT_ALERTS) {
    engine.defineScenario(
      wrapWithMaster(
        wrapCalloutScenario(
          s,
          SCENARIO_ID_TO_START_LIGHT_ID,
          getStartLightCalloutEnabled,
          "start-light callout",
          logger,
        ),
      ),
    );
  }

  // Pit-window family (issue #655). The `pit-window-*` pools are already
  // registered en masse above via `registerPools(engine)`, so no explicit pool
  // loop is needed here — `PIT_WINDOW_POOL_NAMES` exists for the catalog tests
  // to register pools in isolation. Single subject (`pit-open-closed`) gates
  // both directional scenarios via `SCENARIO_ID_TO_PIT_WINDOW_ID`.
  for (const s of PIT_WINDOW_ALERTS) {
    engine.defineScenario(
      wrapWithMaster(
        wrapCalloutScenario(s, SCENARIO_ID_TO_PIT_WINDOW_ID, getPitWindowCalloutEnabled, "pit-window callout", logger),
      ),
    );
  }

  // Opponent-pit family (issue #622). The `opponent-pit-*` pools are already
  // registered en masse above via `registerPools(engine)`;
  // `OPPONENT_PIT_POOL_NAMES` exists for the catalog tests. Two subjects gate
  // the five scenarios via `SCENARIO_ID_TO_OPPONENT_PIT_ID`; the scenarios
  // deliberately carry NO `family` so a pit train queues politely instead of
  // truncating in-flight lines about different cars (see the module header).
  registerOpponentPitVars(engine, getOpponentPitLivePosition);

  for (const s of OPPONENT_PIT_ALERTS) {
    engine.defineScenario(
      wrapWithMaster(
        wrapCalloutScenario(
          s,
          SCENARIO_ID_TO_OPPONENT_PIT_ID,
          getOpponentPitCalloutEnabled,
          "opponent-pit callout",
          logger,
        ),
      ),
    );
  }

  // Rolling-start family (issue #660). The `rolling-start-*` pool is already
  // registered en masse above via `registerPools(engine)`, so no explicit pool
  // loop is needed here — `ROLLING_START_POOL_NAMES` exists for the catalog
  // tests to register pools in isolation. Single subject (`pace-car`) gates the
  // scenario via `SCENARIO_ID_TO_ROLLING_START_ID`.
  for (const s of ROLLING_START_ALERTS) {
    engine.defineScenario(
      wrapWithMaster(
        wrapCalloutScenario(
          s,
          SCENARIO_ID_TO_ROLLING_START_ID,
          getRollingStartCalloutEnabled,
          "rolling-start callout",
          logger,
        ),
      ),
    );
  }

  for (const s of buildPitReadbackScenarios(getReadbackSnapshot)) {
    engine.defineScenario(
      wrapWithMaster(
        wrapCalloutScenario(s, SCENARIO_ID_TO_PIT_READBACK_ID, getPitReadbackEnabled, "pit readback callout", logger),
      ),
    );
  }

  for (const s of DAMAGE_ALERTS) {
    engine.defineScenario(
      wrapWithMaster(
        wrapCalloutScenario(s, SCENARIO_ID_TO_DAMAGE_ID, getDamageCalloutEnabled, "damage callout", logger),
      ),
    );
  }

  for (const s of PIT_STATUS_ALERTS) {
    engine.defineScenario(
      wrapWithMaster(
        wrapCalloutScenario(s, SCENARIO_ID_TO_PIT_STATUS_ID, getPitStatusCalloutEnabled, "pit-status callout", logger),
      ),
    );
  }

  for (const s of TRACK_CONDITIONS_ALERTS) {
    engine.defineScenario(
      wrapWithMaster(
        wrapCalloutScenario(
          s,
          SCENARIO_ID_TO_TRACK_CONDITIONS_ID,
          getTrackConditionsCalloutEnabled,
          "track-conditions callout",
          logger,
        ),
      ),
    );
  }

  // Pit-box count-in (issue #600). Six per-mark scenarios all gated by the one
  // `count-in` opt-in via `SCENARIO_ID_TO_PIT_BOX_ID`. No registration-order
  // concern — `pitBox.countdown` has no other subscribers.
  for (const s of PIT_BOX_ALERTS) {
    engine.defineScenario(
      wrapWithMaster(
        wrapCalloutScenario(s, SCENARIO_ID_TO_PIT_BOX_ID, getPitBoxCalloutEnabled, "pit-box callout", logger),
      ),
    );
  }

  // Laps-of-fuel-left callouts (issue #838). Eleven per-count scenarios plus
  // the enough-fuel confirmation (issue #880), one opt-in each via
  // `SCENARIO_ID_TO_FUEL_ID` — the fuel-laps-left pools are already
  // registered en masse above via `registerPools(engine)`;
  // `FUEL_LAPS_LEFT_POOL_NAMES` exists for the catalog tests. No
  // registration-order concern — `fuel.lapsLeft.crossed` and
  // `fuel.lapsLeft.raceCovered` have no other subscribers.
  for (const s of FUEL_LAPS_LEFT_ALERTS) {
    engine.defineScenario(
      wrapWithMaster(wrapCalloutScenario(s, SCENARIO_ID_TO_FUEL_ID, getFuelCalloutEnabled, "fuel callout", logger)),
    );
  }

  // Qualifying lap-invalidation callout (issue #567). MUST be registered
  // BEFORE the incident scenarios below — both gate on `incident.occurred`,
  // share the Voice bus, and run at the default `WEIGHT.NORMAL` band in
  // different families. The scenario engine dispatches subscribers in
  // registration order, and a second equal-weight scenario hitting a busy bus
  // is silently dropped (see `attemptFire` in interpreter.ts). The shape we want:
  //
  //   Qualifying + valid flying lap → qualifying scenario grabs the bus,
  //                                     incident scenario drops (no double-up).
  //   Qualifying + out-lap / post-pit lap → qualifying scenario's `where:`
  //                                     returns false (no fire, no bus grab),
  //                                     incident scenario fires with generic
  //                                     "mind the kerbs" coaching.
  //   Race / practice / unknown        → qualifying scenario's `where:`
  //                                     returns false (sessionType mismatch),
  //                                     incident scenario fires normally.
  //
  // Registration order is the SOLE mechanism here — incident.ts deliberately
  // does NOT gate on session type, because doing so would silence incidents
  // on out-laps too (where the qualifying scenario also stays silent).
  //
  // The per-lap latch is module-scope inside qualifying-invalidation.ts and
  // rolls over naturally as `(sessionNum, lapCompleted)` advances. No
  // `defineVar` call — every tail branch is a direct pool lookup keyed on
  // `lapsRemaining`.
  engine.defineScenario(
    wrapWithMaster(
      wrapCalloutScenario(
        buildQualifyingInvalidationScenario(getQualifyingInvalidationSnapshot),
        SCENARIO_ID_TO_QUALIFYING_INVALIDATION_ID,
        getQualifyingInvalidationCalloutEnabled,
        "qualifying lap-invalidation callout",
        logger,
      ),
    ),
  );

  // Incident scenarios read the `incident.points` count-clause var (issue
  // #922) — register-vars-before-scenario ordering, same as session-start.
  registerIncidentVars(engine);

  for (const s of INCIDENT_ALERTS) {
    engine.defineScenario(
      wrapWithMaster(
        wrapCalloutScenario(s, SCENARIO_ID_TO_INCIDENT_ID, getIncidentCalloutEnabled, "incident callout", logger),
      ),
    );
  }

  // Session-start readout (issue #542). The scenario's `var` steps must be
  // registered before `defineScenario` runs — load-time validation rejects a
  // `{ var }` step whose name isn't registered yet.
  registerSessionStartVars(engine, getSessionStartSnapshot);
  engine.defineScenario(
    wrapWithMaster(
      wrapCalloutScenario(
        buildSessionStartScenario(getSessionStartSnapshot, getSetupWarningMismatch),
        SCENARIO_ID_TO_SESSION_START_ID,
        getSessionStartCalloutEnabled,
        "session-start callout",
        logger,
      ),
    ),
  );

  // Lap-time best-lap callout (issue #555). Same register-vars-before-scenario
  // ordering as session-start.
  registerLapTimeVars(engine, getLapCompletedSnapshot);
  engine.defineScenario(
    wrapWithMaster(
      wrapCalloutScenario(
        // Pass the race-finished resolver so the best-lap callout is
        // suppressed on the final lap of a race (issue #569) — race-end
        // takes the floor.
        buildLapTimeScenario(getLapCompletedSnapshot, getRaceFinishedFired),
        SCENARIO_ID_TO_LAP_TIME_ID,
        getLapTimeCalloutEnabled,
        "lap-time callout",
        logger,
      ),
    ),
  );

  // Corner-name callout (issue #888). Register-vars-before-scenario ordering,
  // same as session-start / lap-time.
  registerCornerNameVars(engine, getCornerNameSnapshot);
  engine.defineScenario(
    wrapWithMaster(
      wrapCalloutScenario(
        buildCornerNameScenario(getCornerNameSnapshot),
        SCENARIO_ID_TO_CORNER_NAME_ID,
        getCornerNameCalloutEnabled,
        "corner-name callout",
        logger,
      ),
    ),
  );

  // Position-change callout (issue #566). Ordering with the lap-time scenario
  // above is enforced by the position scenario's `weight: WEIGHT.CHATTER` +
  // `queueable: true`, NOT by registration order — the engine drops (not queues)
  // cross-family equal-weight (`WEIGHT.NORMAL`) scenarios when the bus is busy,
  // but defers and replays the lower-weight queueable position fire once the bus
  // goes idle (see `position.ts` header).
  // The change-DETECTION (improved/worsened/first-fix) reads the frozen
  // `lap.completed` snapshot; in race the spoken NUMBER reads LIVE telemetry
  // at speak-time via `getLivePosition` (issue #574) and shares the position
  // cooldown so an overtake readout + a lap readout seconds apart don't double.
  registerPositionVars(engine, getLapCompletedSnapshot, getLivePosition);
  engine.defineScenario(
    wrapWithMaster(
      wrapCalloutScenario(
        // Pass the race-finished resolver so position-change is suppressed on
        // the final lap of a race (issue #569) — race-end takes the floor, and
        // without the gate position-change would queue "We're currently P[n]"
        // behind race-end and play it after the result speech.
        buildPositionScenario(getLapCompletedSnapshot, getRaceFinishedFired, getLivePosition),
        SCENARIO_ID_TO_POSITION_ID,
        getPositionCalloutEnabled,
        "position callout",
        logger,
      ),
    ),
  );

  // Race-status periodic position update (issue #569). The cadence DECISION
  // reads the frozen `lap.completed` snapshot; in race the spoken number +
  // leader detection read LIVE telemetry at speak-time (issue #574) and share
  // the position cooldown.
  registerRaceStatusVars(engine, getLivePosition);
  engine.defineScenario(
    wrapWithMaster(
      wrapCalloutScenario(
        buildRaceStatusScenario(getLapCompletedSnapshot, getRaceFinishedFired, getLivePosition),
        SCENARIO_ID_TO_RACE_STATUS_ID,
        getRaceStatusCalloutEnabled,
        "race-status callout",
        logger,
      ),
    ),
  );

  // Gap callouts (issue #933): sustained trend flips + threshold crossings
  // against the class-standings neighbors. The decision reads the event
  // payload; the spoken gap number reads LIVE gaps at speak time. Both
  // scenarios share one cooldown, claimed as the last where: gate.
  registerGapVars(engine, getLiveGaps);

  for (const s of [
    buildGapTrendScenario(getRaceFinishedFired, getOvertakeGate, getGapCooldownMs),
    buildGapThresholdScenario(getRaceFinishedFired, getOvertakeGate, getGapCooldownMs),
  ]) {
    engine.defineScenario(
      wrapWithMaster(wrapCalloutScenario(s, SCENARIO_ID_TO_GAP_ID, getGapCalloutEnabled, "gap callout", logger)),
    );
  }

  // Race-end final-result callout (issue #569). Snapshot resolver is owned by
  // the plugin (caches `race.finished` payload via event-bus subscription,
  // composes with the Property Inspector driver-name pick).
  registerRaceEndVars(engine, getRaceFinishedSnapshot);
  engine.defineScenario(
    wrapWithMaster(
      wrapCalloutScenario(
        buildRaceEndScenario(getRaceFinishedSnapshot),
        SCENARIO_ID_TO_RACE_END_ID,
        getRaceEndCalloutEnabled,
        "race-end callout",
        logger,
      ),
    ),
  );

  // Race-start greeting + qualifying-position readout (issue #568). Fires on
  // `session.changed` in race sessions only; the session-start scenario's
  // `where:` already skips race sessions so the two never double-greet.
  // Snapshot resolver is owned by the plugin (composes
  // `getRaceStartConditions()` from `@iracedeck/sim-events-iracing` with the
  // Property Inspector driver-name pick).
  registerRaceStartVars(engine, getRaceStartSnapshot);
  engine.defineScenario(
    wrapWithMaster(
      wrapCalloutScenario(
        buildRaceStartScenario(getRaceStartSnapshot, logger, getSetupWarningMismatch),
        SCENARIO_ID_TO_RACE_START_ID,
        getRaceStartCalloutEnabled,
        "race-start callout",
        logger,
      ),
    ),
  );

  // Overtake callouts (issue #574). Each direction is TWO scenarios: a
  // reaction (immediate, `family: "overtake"`) and a position readout
  // (`weight: WEIGHT.CHATTER` + `queueable: true`, `family: "position-readout"`)
  // that defers behind the reaction and speaks "We're currently P[n]" from LIVE telemetry at
  // speak-time. Both share the same per-direction opt-in via
  // `SCENARIO_ID_TO_OVERTAKE_ID`, and all are suppressed once the race is over
  // (`getRaceFinishedFired`). The driver-name resolver (loss reaction) is
  // composed in the plugin from `resolveActiveDriverName(driverNames, "driver")`.
  registerOvertakeVars(engine, getOvertakeDriverName);
  registerPositionReadoutVars(engine, getLivePosition);

  for (const s of [
    buildOvertakeGainedScenario(getRaceFinishedFired, getOvertakeGate),
    buildOvertakeLostScenario(getRaceFinishedFired, getOvertakeGate),
  ]) {
    engine.defineScenario(
      wrapWithMaster(
        wrapCalloutScenario(s, SCENARIO_ID_TO_OVERTAKE_ID, getOvertakeCalloutEnabled, "overtake callout", logger),
      ),
    );
  }

  for (const s of [
    buildOvertakeGainedPositionScenario(getLivePosition, getRaceFinishedFired, getOvertakeGate),
    buildOvertakeLostPositionScenario(getLivePosition, getRaceFinishedFired, getOvertakeGate),
  ]) {
    engine.defineScenario(
      wrapWithMaster(
        wrapCalloutScenario(
          s,
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
 * Returns the scenario unchanged when it has no `when:` block (e.g. the
 * `@pit-crew.radio-open` / `…close` include scenarios), since includes
 * only run when triggered by a parent scenario whose master-gate check
 * has already passed.
 */
function wrapRaceEngineerMasterGate(s: Scenario, getEnabled: () => boolean, logger: ILogger | undefined): Scenario {
  if (!s.when) return s;

  const baseWhere = s.when.where;

  return {
    ...s,
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
function wrapPitActionScenario(s: Scenario, getAllowed: () => boolean, logger: ILogger | undefined): Scenario {
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
function wrapPitServiceRequestsScenario(s: Scenario, getEnabled: () => boolean, logger: ILogger | undefined): Scenario {
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

function wrapCalloutScenario<TId extends string>(
  s: Scenario,
  scenarioIdToCalloutId: Record<string, TId>,
  getCalloutEnabled: (id: TId) => boolean,
  description: string,
  logger: ILogger | undefined,
): Scenario {
  const calloutId = scenarioIdToCalloutId[s.id];

  if (!calloutId) {
    throw new Error(`registerPitCrew: no callout id mapping for scenario "${s.id}"`);
  }

  if (!s.when) return s;

  const baseWhere = s.when.where;

  return {
    ...s,
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
