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
 */
import type { IEventBus } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";

import type { Scenario } from "../../dsl.js";
import { getScenarioEngine } from "../../interpreter.js";
import { FLAG_ALERTS } from "./flag-alerts.js";
import { POOLS } from "./pools.js";
import { registerRadarEngine } from "./radar-engine.js";
import { RADIO_CLOSE, RADIO_OPEN } from "./radio-frame.js";
import { PIT_READBACK_SCENARIOS, type PitReadbackCalloutId, SCENARIO_ID_TO_PIT_READBACK_ID } from "./readback.js";
import {
  FAST_REPAIR_TOGGLE_SCENARIOS,
  FUEL_TOGGLE_SCENARIOS,
  TIRE_COMPOUND_SCENARIOS,
  TIRE_TOGGLE_SCENARIOS,
  WINDSHIELD_TOGGLE_SCENARIOS,
} from "./toggle-confirmations.js";

export { isBackgroundTestInFlight, playBackgroundTest } from "./background-test.js";
export {
  getRadarVisualState,
  playRadarTest,
  setRadarEnabled,
  type RadarVisualState,
  subscribeRadarVisualState,
} from "./radar-engine.js";
export { PIT_READBACK_CALLOUT_SETTING_KEYS, type PitReadbackCalloutId, PIT_READBACK_SCENARIOS } from "./readback.js";

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
): void {
  registerRadarEngine(bus);

  const engine = getScenarioEngine();

  Object.entries(POOLS).forEach(([key, value]) => {
    engine.definePool(key, value as string[]);
  });

  engine.defineScenario(RADIO_OPEN);
  engine.defineScenario(RADIO_CLOSE);

  // Each pit-service toggle scenario is wrapped twice. Outer wrapper
  // applies the user opt-in (`calloutEnabledPitServiceRequests`); inner
  // wrapper applies the engine-internal cooldown (`isPitActionsAllowed`).
  // Outer-first because the user gate is the cheap, persistent check —
  // if the user has opted out, we never even ask about the cooldown.
  const wrapToggle = (s: Scenario): Scenario =>
    wrapPitServiceRequestsScenario(
      wrapPitActionScenario(s, getPitActionsAllowed, logger),
      getPitServiceRequestsEnabled,
      logger,
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
      wrapCalloutScenario(s, SCENARIO_ID_TO_FLAG_ID, getFlagCalloutEnabled, "flag callout", logger),
    );
  }

  for (const s of PIT_READBACK_SCENARIOS) {
    engine.defineScenario(
      wrapCalloutScenario(s, SCENARIO_ID_TO_PIT_READBACK_ID, getPitReadbackEnabled, "pit readback callout", logger),
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
