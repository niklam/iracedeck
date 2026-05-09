/**
 * Pit Crew scenario catalog registration.
 *
 * The engine wires:
 *   - The directional radar (state-driven tick loop, not expressible in the
 *     scenario DSL)
 *   - All pools defined in `pools.ts`, registered en masse via
 *     `Object.entries(POOLS)` (acknowledgment, pit-action acknowledgment,
 *     per-action pit-action callouts, flag callouts)
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
 *
 * Other voice scenarios (welcome, pit-approach, fuel-warning, incident
 * alerts, limiter callouts, tips, drs/p2p toggles) are not currently
 * registered; they'll be added one at a time as their `voice/{voice}/…`
 * content is generated and the corresponding pools and scenarios are
 * reintroduced.
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
 * deferred-replay readback (busy-bus low-priority hold or urgent-flag
 * preempt) speaks the *current* queued-services state, not the one
 * frozen into the original event payload.
 */
import type { IEventBus, PitReadbackSnapshot } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";

import type { Scenario } from "../../dsl.js";
import { getScenarioEngine } from "../../interpreter.js";
import { DAMAGE_ALERTS } from "./damage-alerts.js";
import { FLAG_ALERTS } from "./flag-alerts.js";
import { INCIDENT_ALERTS } from "./incidents.js";
import { PIT_STATUS_ALERTS } from "./pit-status.js";
import { POOLS } from "./pools.js";
import { registerRadarEngine } from "./radar-engine.js";
import { RADIO_CLOSE, RADIO_OPEN } from "./radio-frame.js";
import { buildPitReadbackScenarios, type PitReadbackCalloutId, SCENARIO_ID_TO_PIT_READBACK_ID } from "./readback.js";
import {
  FAST_REPAIR_TOGGLE_SCENARIOS,
  FUEL_TOGGLE_SCENARIOS,
  TIRE_COMPOUND_SCENARIOS,
  TIRE_TOGGLE_SCENARIOS,
  WINDSHIELD_TOGGLE_SCENARIOS,
} from "./toggle-confirmations.js";
import { TRACK_CONDITIONS_ALERTS } from "./track-conditions.js";

export { isBackgroundTestInFlight, playBackgroundTest } from "./background-test.js";
export {
  getRadarVisualState,
  playRadarTest,
  setRadarEnabled,
  type RadarVisualState,
  subscribeRadarVisualState,
} from "./radar-engine.js";
export {
  buildPitReadbackScenarios,
  PIT_READBACK_CALLOUT_SETTING_KEYS,
  type PitReadbackCalloutId,
  type ReadbackSnapshotResolver,
} from "./readback.js";

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
  | "meatball";

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
};

const SCENARIO_ID_TO_FLAG_ID: Record<string, FlagCalloutId> = {
  "pit-crew.flag-yellow-local": "yellow-local",
  "pit-crew.flag-yellow-full": "yellow-full",
  "pit-crew.flag-yellow-cleared": "yellow-cleared",
  "pit-crew.flag-green": "green",
  "pit-crew.flag-blue": "blue",
  "pit-crew.flag-white": "white",
  "pit-crew.flag-red": "red",
  "pit-crew.flag-black": "black",
  "pit-crew.flag-checkered": "checkered",
  "pit-crew.flag-debris": "debris",
  "pit-crew.flag-meatball": "meatball",
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
  | "off-track"
  | "out-of-control"
  | "contact-world"
  | "collision-world"
  | "contact-car"
  | "collision-car";

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

  const engine = getScenarioEngine();

  Object.entries(POOLS).forEach(([key, value]) => {
    engine.definePool(key, value as string[]);
  });

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

  for (const s of INCIDENT_ALERTS) {
    engine.defineScenario(
      wrapWithMaster(
        wrapCalloutScenario(s, SCENARIO_ID_TO_INCIDENT_ID, getIncidentCalloutEnabled, "incident callout", logger),
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
