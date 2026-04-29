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
 *   - Flag alert scenarios (every transition the translator publishes:
 *     yellow scope-aware, yellow.cleared, green, blue, white, red, black,
 *     checkered with session-type branch, debris, meatball)
 *
 * Other voice scenarios (welcome, pit-approach, fuel-warning, incident
 * alerts, limiter callouts, tips, windshield/fastRepair/drs/p2p toggles)
 * are not currently registered; they'll be added one at a time as their
 * `voice/{voice}/…` content is generated and the corresponding pools and
 * scenarios are reintroduced.
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
import { FUEL_TOGGLE_SCENARIOS, TIRE_COMPOUND_SCENARIOS, TIRE_TOGGLE_SCENARIOS } from "./toggle-confirmations.js";

export { isBackgroundTestInFlight, playBackgroundTest } from "./background-test.js";
export {
  getRadarVisualState,
  playRadarTest,
  setRadarEnabled,
  type RadarVisualState,
  subscribeRadarVisualState,
} from "./radar-engine.js";

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
): void {
  registerRadarEngine(bus);

  const engine = getScenarioEngine();

  Object.entries(POOLS).forEach(([key, value]) => {
    engine.definePool(key, value as string[]);
  });

  engine.defineScenario(RADIO_OPEN);
  engine.defineScenario(RADIO_CLOSE);

  for (const s of FUEL_TOGGLE_SCENARIOS) engine.defineScenario(s);

  for (const s of TIRE_TOGGLE_SCENARIOS) engine.defineScenario(s);

  for (const s of TIRE_COMPOUND_SCENARIOS) engine.defineScenario(s);

  for (const s of FLAG_ALERTS) {
    engine.defineScenario(wrapFlagScenario(s, getFlagCalloutEnabled, logger));
  }
}

/**
 * Wrap a flag scenario's `where:` predicate so the user's plugin-global
 * opt-in is consulted on every event arrival. The wrapper short-circuits
 * BEFORE `attemptFire`, so disabling a flag while its callout is already
 * playing does NOT cut playback — only future events are suppressed.
 *
 * Throws if the scenario id is missing from `SCENARIO_ID_TO_FLAG_ID`,
 * which would mean a new flag scenario was added without registering its
 * id mapping (better to fail loudly at startup than silently leak the
 * unmapped flag past the toggle).
 */
function wrapFlagScenario(
  s: Scenario,
  getFlagCalloutEnabled: (id: FlagCalloutId) => boolean,
  logger: ILogger | undefined,
): Scenario {
  const flagId = SCENARIO_ID_TO_FLAG_ID[s.id];

  if (!flagId) {
    throw new Error(`registerPitCrew: no FlagCalloutId mapping for scenario "${s.id}"`);
  }

  if (!s.when) return s;

  const baseWhere = s.when.where;

  return {
    ...s,
    when: {
      event: s.when.event,
      where: (ev) => {
        if (!getFlagCalloutEnabled(flagId)) {
          logger?.debug(`flag callout suppressed: ${flagId}`);

          return false;
        }

        return baseWhere ? baseWhere(ev) : true;
      },
    },
  };
}
