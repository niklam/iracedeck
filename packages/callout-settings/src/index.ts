import type { CalloutEntry, CalloutKeyOf } from "./define.js";
import { CALLOUT_PI_GROUPS } from "./pi-groups.js";

export * from "./define.js";
export { AUTO_FUEL_CALLOUTS } from "./families/auto-fuel.js";
export { CAUTION_CALLOUTS } from "./families/caution.js";
export { CORNER_NAMES_TOGGLE_CALLOUTS } from "./families/corner-names-toggle.js";
export { CORNER_NAME_CALLOUTS } from "./families/corner-name.js";
export { DAMAGE_CALLOUTS } from "./families/damage.js";
export { FLAG_CALLOUTS } from "./families/flag.js";
export { FUEL_CALLOUTS } from "./families/fuel.js";
export { GAP_CALLOUTS } from "./families/gaps.js";
export { INCIDENT_CALLOUTS } from "./families/incident.js";
export { LAP_TIME_CALLOUTS } from "./families/lap-time.js";
export { NO_LIMITER_CALLOUTS } from "./families/no-limiter.js";
export { OPPONENT_FLAG_CALLOUTS } from "./families/opponent-flags.js";
export { OPPONENT_PIT_CALLOUTS } from "./families/opponent-pit.js";
export { OVERTAKE_CALLOUTS } from "./families/overtake.js";
export { PIT_BOX_CALLOUTS } from "./families/pit-box.js";
export { PIT_LIMITER_CALLOUTS } from "./families/pit-limiter.js";
export { PIT_READBACK_CALLOUTS } from "./families/readback.js";
export { PIT_SERVICE_REQUEST_CALLOUTS } from "./families/pit-service-requests.js";
export { PIT_SPEEDING_CALLOUTS } from "./families/pit-speeding.js";
export { PIT_STATUS_CALLOUTS } from "./families/pit-status.js";
export { PIT_WINDOW_CALLOUTS } from "./families/pit-window.js";
export { POSITION_CALLOUTS } from "./families/position.js";
export { QUALIFYING_INVALIDATION_CALLOUTS } from "./families/qualifying-invalidation.js";
export { RACE_END_CALLOUTS } from "./families/race-end.js";
export { RACE_ENGINEER_TOGGLE_CALLOUTS } from "./families/race-engineer-toggle.js";
export { RACE_START_CALLOUTS } from "./families/race-start.js";
export { RACE_STATUS_CALLOUTS } from "./families/race-status.js";
export { ROLLING_START_CALLOUTS } from "./families/rolling-start.js";
export { SESSION_START_CALLOUTS } from "./families/session-start.js";
export { SETUP_WARNING_CALLOUTS } from "./families/setup-warning.js";
export { SPOTTER_CALLOUTS } from "./families/spotter.js";
export { START_LIGHT_CALLOUTS } from "./families/start-light.js";
export { TELEMETRY_CONNECT_CALLOUTS } from "./families/telemetry-connect.js";
export { TIRE_WEAR_CALLOUTS } from "./families/tire-wear.js";
export { TRACK_CONDITIONS_CALLOUTS } from "./families/track-conditions.js";
export { CALLOUT_PI_GROUPS, type CalloutPiGroup } from "./pi-groups.js";

/** Any family in the registry: one placed in a `CALLOUT_PI_GROUPS` heading. A generic helper that must yield a `CalloutSettingKey` constrains on this, not on `CalloutFamily`. */
export type RegisteredCalloutFamily = (typeof CALLOUT_PI_GROUPS)[number]["families"][number];

/** Every family, in PI order — derived from `CALLOUT_PI_GROUPS`, so placing a family there is what registers it. */
export const CALLOUT_FAMILIES: readonly RegisteredCalloutFamily[] = CALLOUT_PI_GROUPS.flatMap(
  (group): readonly RegisteredCalloutFamily[] => group.families,
);

/** Every persisted callout opt-in key. */
export type CalloutSettingKey = CalloutKeyOf<RegisteredCalloutFamily>;

const ENTRIES = new Map<string, CalloutEntry>(
  CALLOUT_FAMILIES.flatMap((family) => Object.values(family.callouts).map((entry) => [entry.key, entry] as const)),
);

export const CALLOUT_SETTING_KEYS = [...ENTRIES.keys()] as readonly CalloutSettingKey[];

export function calloutEntry(key: CalloutSettingKey): CalloutEntry {
  const entry = ENTRIES.get(key);

  if (!entry) throw new Error(`Unknown callout setting key: ${key}`);

  return entry;
}

/** The schema default: `true` unless the entry ships the callout off. */
export function calloutDefault(key: CalloutSettingKey): boolean {
  return calloutEntry(key).default !== false;
}
