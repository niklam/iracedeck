import type { CalloutFamily } from "./define.js";
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

export interface CalloutPiGroup {
  readonly id: string;
  /** The `<sdpi-item label>` heading. */
  readonly title: string;
  /** Rendered in this order; each family's entries in their own order. */
  readonly families: readonly CalloutFamily[];
}

/** The PI / settings-window headings, in render order. */
export const CALLOUT_PI_GROUPS = [
  { id: "flags", title: "Flags", families: [FLAG_CALLOUTS] },
  { id: "start-lights", title: "Start Lights", families: [START_LIGHT_CALLOUTS] },
  { id: "rolling-start", title: "Rolling Start", families: [ROLLING_START_CALLOUTS] },
  { id: "pit-window", title: "Pit Window", families: [PIT_WINDOW_CALLOUTS] },
  { id: "pit-limiter", title: "Pit Limiter", families: [PIT_LIMITER_CALLOUTS] },
  { id: "no-pit-limiter", title: "No Pit Limiter", families: [NO_LIMITER_CALLOUTS] },
  { id: "opponent-pits", title: "Opponent Pits", families: [OPPONENT_PIT_CALLOUTS] },
  { id: "opponent-flags", title: "Opponent Flags", families: [OPPONENT_FLAG_CALLOUTS] },
  {
    id: "pit-service",
    title: "Pit Service",
    families: [PIT_READBACK_CALLOUTS, TIRE_WEAR_CALLOUTS, PIT_SERVICE_REQUEST_CALLOUTS, AUTO_FUEL_CALLOUTS],
  },
  { id: "pit-service-status", title: "Pit Service Status", families: [PIT_STATUS_CALLOUTS] },
  { id: "damage", title: "Damage", families: [DAMAGE_CALLOUTS] },
  { id: "track-conditions", title: "Track Conditions", families: [TRACK_CONDITIONS_CALLOUTS] },
  { id: "incidents", title: "Incidents", families: [INCIDENT_CALLOUTS] },
  { id: "session-start", title: "Session Start", families: [SESSION_START_CALLOUTS] },
  { id: "race-engineer-toggle", title: "Race Engineer Toggle", families: [RACE_ENGINEER_TOGGLE_CALLOUTS] },
  { id: "telemetry-connect", title: "Telemetry Connect", families: [TELEMETRY_CONNECT_CALLOUTS] },
  { id: "lap-time", title: "Lap Time", families: [LAP_TIME_CALLOUTS] },
  { id: "position", title: "Position", families: [POSITION_CALLOUTS] },
  { id: "qualifying", title: "Qualifying", families: [QUALIFYING_INVALIDATION_CALLOUTS] },
  { id: "race", title: "Race", families: [RACE_START_CALLOUTS, RACE_STATUS_CALLOUTS, RACE_END_CALLOUTS] },
  { id: "overtakes", title: "Overtakes", families: [OVERTAKE_CALLOUTS] },
  { id: "gaps", title: "Gaps", families: [GAP_CALLOUTS] },
  { id: "spotter", title: "Spotter", families: [SPOTTER_CALLOUTS] },
  { id: "pit-box", title: "Pit Box", families: [PIT_BOX_CALLOUTS] },
  { id: "pit-speeding", title: "Pit Speeding", families: [PIT_SPEEDING_CALLOUTS] },
  { id: "fuel", title: "Fuel", families: [FUEL_CALLOUTS] },
  { id: "corner-names", title: "Corner Names", families: [CORNER_NAME_CALLOUTS, CORNER_NAMES_TOGGLE_CALLOUTS] },
  { id: "setup-warning", title: "Setup Warning", families: [SETUP_WARNING_CALLOUTS] },
  { id: "caution", title: "Caution", families: [CAUTION_CALLOUTS] },
] as const satisfies readonly CalloutPiGroup[];
