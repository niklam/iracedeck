import type { CalloutEntry, CalloutKeyOf } from "./define.js";
import { AUTO_FUEL_CALLOUTS } from "./families/auto-fuel.js";
import { CAUTION_CALLOUTS } from "./families/caution.js";
import { CORNER_NAME_CALLOUTS } from "./families/corner-name.js";
import { CORNER_NAMES_TOGGLE_CALLOUTS } from "./families/corner-names-toggle.js";
import { DAMAGE_CALLOUTS } from "./families/damage.js";
import { FLAG_CALLOUTS } from "./families/flag.js";
import { FUEL_CALLOUTS } from "./families/fuel.js";
import { GAP_CALLOUTS } from "./families/gaps.js";
import { INCIDENT_CALLOUTS } from "./families/incident.js";
import { LAP_TIME_CALLOUTS } from "./families/lap-time.js";
import { NO_LIMITER_CALLOUTS } from "./families/no-limiter.js";
import { OPPONENT_FLAG_CALLOUTS } from "./families/opponent-flags.js";
import { OPPONENT_PIT_CALLOUTS } from "./families/opponent-pit.js";
import { OVERTAKE_CALLOUTS } from "./families/overtake.js";
import { PIT_BOX_CALLOUTS } from "./families/pit-box.js";
import { PIT_LIMITER_CALLOUTS } from "./families/pit-limiter.js";
import { PIT_SERVICE_REQUEST_CALLOUTS } from "./families/pit-service-requests.js";
import { PIT_SPEEDING_CALLOUTS } from "./families/pit-speeding.js";
import { PIT_STATUS_CALLOUTS } from "./families/pit-status.js";
import { PIT_WINDOW_CALLOUTS } from "./families/pit-window.js";
import { POSITION_CALLOUTS } from "./families/position.js";
import { QUALIFYING_INVALIDATION_CALLOUTS } from "./families/qualifying-invalidation.js";
import { RACE_END_CALLOUTS } from "./families/race-end.js";
import { RACE_ENGINEER_TOGGLE_CALLOUTS } from "./families/race-engineer-toggle.js";
import { RACE_START_CALLOUTS } from "./families/race-start.js";
import { RACE_STATUS_CALLOUTS } from "./families/race-status.js";
import { PIT_READBACK_CALLOUTS } from "./families/readback.js";
import { ROLLING_START_CALLOUTS } from "./families/rolling-start.js";
import { SESSION_START_CALLOUTS } from "./families/session-start.js";
import { SETUP_WARNING_CALLOUTS } from "./families/setup-warning.js";
import { SPOTTER_CALLOUTS } from "./families/spotter.js";
import { START_LIGHT_CALLOUTS } from "./families/start-light.js";
import { TELEMETRY_CONNECT_CALLOUTS } from "./families/telemetry-connect.js";
import { TIRE_WEAR_CALLOUTS } from "./families/tire-wear.js";
import { TRACK_CONDITIONS_CALLOUTS } from "./families/track-conditions.js";

export * from "./define.js";
export {
  AUTO_FUEL_CALLOUTS,
  CAUTION_CALLOUTS,
  CORNER_NAME_CALLOUTS,
  CORNER_NAMES_TOGGLE_CALLOUTS,
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
  RACE_ENGINEER_TOGGLE_CALLOUTS,
  RACE_START_CALLOUTS,
  RACE_STATUS_CALLOUTS,
  ROLLING_START_CALLOUTS,
  SESSION_START_CALLOUTS,
  SETUP_WARNING_CALLOUTS,
  SPOTTER_CALLOUTS,
  START_LIGHT_CALLOUTS,
  TELEMETRY_CONNECT_CALLOUTS,
  TIRE_WEAR_CALLOUTS,
  TRACK_CONDITIONS_CALLOUTS,
};
export { CALLOUT_PI_GROUPS, type CalloutPiGroup } from "./pi-groups.js";

/** Every family, in PI order. */
export const CALLOUT_FAMILIES = [
  FLAG_CALLOUTS,
  START_LIGHT_CALLOUTS,
  ROLLING_START_CALLOUTS,
  PIT_WINDOW_CALLOUTS,
  PIT_LIMITER_CALLOUTS,
  NO_LIMITER_CALLOUTS,
  OPPONENT_PIT_CALLOUTS,
  OPPONENT_FLAG_CALLOUTS,
  PIT_READBACK_CALLOUTS,
  TIRE_WEAR_CALLOUTS,
  PIT_SERVICE_REQUEST_CALLOUTS,
  AUTO_FUEL_CALLOUTS,
  PIT_STATUS_CALLOUTS,
  DAMAGE_CALLOUTS,
  TRACK_CONDITIONS_CALLOUTS,
  INCIDENT_CALLOUTS,
  SESSION_START_CALLOUTS,
  RACE_ENGINEER_TOGGLE_CALLOUTS,
  TELEMETRY_CONNECT_CALLOUTS,
  LAP_TIME_CALLOUTS,
  POSITION_CALLOUTS,
  QUALIFYING_INVALIDATION_CALLOUTS,
  RACE_START_CALLOUTS,
  RACE_STATUS_CALLOUTS,
  RACE_END_CALLOUTS,
  OVERTAKE_CALLOUTS,
  GAP_CALLOUTS,
  SPOTTER_CALLOUTS,
  PIT_BOX_CALLOUTS,
  PIT_SPEEDING_CALLOUTS,
  FUEL_CALLOUTS,
  CORNER_NAME_CALLOUTS,
  CORNER_NAMES_TOGGLE_CALLOUTS,
  SETUP_WARNING_CALLOUTS,
  CAUTION_CALLOUTS,
] as const;

/** Every persisted callout opt-in key. */
export type CalloutSettingKey = CalloutKeyOf<(typeof CALLOUT_FAMILIES)[number]>;

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
