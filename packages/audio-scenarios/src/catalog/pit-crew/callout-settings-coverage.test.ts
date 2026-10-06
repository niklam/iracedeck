import {
  AUTO_FUEL_CALLOUTS,
  CALLOUT_SETTING_KEYS,
  type CalloutFamily,
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
  PIT_STATUS_CALLOUTS,
  PIT_WINDOW_CALLOUTS,
  POSITION_CALLOUTS,
  QUALIFYING_INVALIDATION_CALLOUTS,
  RACE_END_CALLOUTS,
  RACE_START_CALLOUTS,
  RACE_STATUS_CALLOUTS,
  ROLLING_START_CALLOUTS,
  SESSION_START_CALLOUTS,
  START_LIGHT_CALLOUTS,
  TIRE_WEAR_CALLOUTS,
  TRACK_CONDITIONS_CALLOUTS,
} from "@iracedeck/callout-settings";
import { describe, expect, it } from "vitest";

import { SCENARIO_ID_TO_CORNER_NAME_ID } from "./corner-name.js";
import { SCENARIO_ID_TO_GAP_ID } from "./gaps.js";
import {
  SCENARIO_ID_TO_AUTO_FUEL_ID,
  SCENARIO_ID_TO_CAUTION_ID,
  SCENARIO_ID_TO_DAMAGE_ID,
  SCENARIO_ID_TO_FLAG_ID,
  SCENARIO_ID_TO_FUEL_ID,
  SCENARIO_ID_TO_INCIDENT_ID,
  SCENARIO_ID_TO_PIT_BOX_ID,
  SCENARIO_ID_TO_PIT_STATUS_ID,
  SCENARIO_ID_TO_PIT_WINDOW_ID,
  SCENARIO_ID_TO_ROLLING_START_ID,
  SCENARIO_ID_TO_START_LIGHT_ID,
  SCENARIO_ID_TO_TIRE_WEAR_ID,
  SCENARIO_ID_TO_TRACK_CONDITIONS_ID,
} from "./index.js";
import { SCENARIO_ID_TO_LAP_TIME_ID } from "./lap-time.js";
import { SCENARIO_ID_TO_NO_LIMITER_ID } from "./no-limiter.js";
import { SCENARIO_ID_TO_OPPONENT_FLAG_ID } from "./opponent-flags.js";
import { SCENARIO_ID_TO_OPPONENT_PIT_ID } from "./opponent-pit.js";
import { SCENARIO_ID_TO_OVERTAKE_ID } from "./overtake.js";
import { SCENARIO_ID_TO_PIT_LIMITER_ID } from "./pit-limiter.js";
import { SCENARIO_ID_TO_POSITION_ID } from "./position.js";
import { SCENARIO_ID_TO_QUALIFYING_INVALIDATION_ID } from "./qualifying-invalidation.js";
import { SCENARIO_ID_TO_RACE_END_ID } from "./race-end.js";
import { SCENARIO_ID_TO_RACE_START_ID } from "./race-start.js";
import { SCENARIO_ID_TO_RACE_STATUS_ID } from "./race-status.js";
import { SCENARIO_ID_TO_PIT_READBACK_ID } from "./readback.js";
import { SCENARIO_ID_TO_SESSION_START_ID } from "./session-start.js";

interface GatedFamily {
  readonly name: string;
  readonly scenarios: Readonly<Record<string, string>>;
  readonly family: CalloutFamily;
}

/**
 * Contract id → key, at the source (#1350): every scenario a family gates
 * resolves to a registry key, and every id of a scenario-backed family is
 * reached by at least one scenario.
 *
 * One row per `SCENARIO_ID_TO_*` map. The registry families with no such map,
 * and how each is gated instead:
 *
 * - `SPOTTER_CALLOUTS` (`cars`, `still-there`) and `PIT_SPEEDING_CALLOUTS`
 *   (`cue`): read inside their imperative engines (`registerSpotterEngine`,
 *   `registerPitSpeedingEngine`), which play direct rather than through a
 *   scenario `where:`.
 * - `PIT_SERVICE_REQUEST_CALLOUTS` (`requests`): one gate over all the toggle
 *   confirmations, applied by `wrapPitServiceRequestsScenario`.
 * - `SETUP_WARNING_CALLOUTS` (`warning`): a clause inside the session-start and
 *   race-start intros, read by the plugins' `getSetupWarningMismatch` resolver.
 * - `RACE_ENGINEER_TOGGLE_CALLOUTS`, `CORNER_NAMES_TOGGLE_CALLOUTS` (`ack`) and
 *   `TELEMETRY_CONNECT_CALLOUTS` (`radio-check`): played by deck actions in
 *   `@iracedeck/iracing-actions`, never by `registerPitCrew`.
 */
const GATED: readonly GatedFamily[] = [
  { name: "auto-fuel", scenarios: SCENARIO_ID_TO_AUTO_FUEL_ID, family: AUTO_FUEL_CALLOUTS },
  { name: "caution", scenarios: SCENARIO_ID_TO_CAUTION_ID, family: CAUTION_CALLOUTS },
  { name: "corner-name", scenarios: SCENARIO_ID_TO_CORNER_NAME_ID, family: CORNER_NAME_CALLOUTS },
  { name: "damage", scenarios: SCENARIO_ID_TO_DAMAGE_ID, family: DAMAGE_CALLOUTS },
  { name: "flag", scenarios: SCENARIO_ID_TO_FLAG_ID, family: FLAG_CALLOUTS },
  { name: "fuel", scenarios: SCENARIO_ID_TO_FUEL_ID, family: FUEL_CALLOUTS },
  { name: "gap", scenarios: SCENARIO_ID_TO_GAP_ID, family: GAP_CALLOUTS },
  { name: "incident", scenarios: SCENARIO_ID_TO_INCIDENT_ID, family: INCIDENT_CALLOUTS },
  { name: "lap-time", scenarios: SCENARIO_ID_TO_LAP_TIME_ID, family: LAP_TIME_CALLOUTS },
  { name: "no-limiter", scenarios: SCENARIO_ID_TO_NO_LIMITER_ID, family: NO_LIMITER_CALLOUTS },
  { name: "opponent-flag", scenarios: SCENARIO_ID_TO_OPPONENT_FLAG_ID, family: OPPONENT_FLAG_CALLOUTS },
  { name: "opponent-pit", scenarios: SCENARIO_ID_TO_OPPONENT_PIT_ID, family: OPPONENT_PIT_CALLOUTS },
  { name: "overtake", scenarios: SCENARIO_ID_TO_OVERTAKE_ID, family: OVERTAKE_CALLOUTS },
  { name: "pit-box", scenarios: SCENARIO_ID_TO_PIT_BOX_ID, family: PIT_BOX_CALLOUTS },
  { name: "pit-limiter", scenarios: SCENARIO_ID_TO_PIT_LIMITER_ID, family: PIT_LIMITER_CALLOUTS },
  { name: "pit-readback", scenarios: SCENARIO_ID_TO_PIT_READBACK_ID, family: PIT_READBACK_CALLOUTS },
  { name: "pit-status", scenarios: SCENARIO_ID_TO_PIT_STATUS_ID, family: PIT_STATUS_CALLOUTS },
  { name: "pit-window", scenarios: SCENARIO_ID_TO_PIT_WINDOW_ID, family: PIT_WINDOW_CALLOUTS },
  { name: "position", scenarios: SCENARIO_ID_TO_POSITION_ID, family: POSITION_CALLOUTS },
  {
    name: "qualifying-invalidation",
    scenarios: SCENARIO_ID_TO_QUALIFYING_INVALIDATION_ID,
    family: QUALIFYING_INVALIDATION_CALLOUTS,
  },
  { name: "race-end", scenarios: SCENARIO_ID_TO_RACE_END_ID, family: RACE_END_CALLOUTS },
  { name: "race-start", scenarios: SCENARIO_ID_TO_RACE_START_ID, family: RACE_START_CALLOUTS },
  { name: "race-status", scenarios: SCENARIO_ID_TO_RACE_STATUS_ID, family: RACE_STATUS_CALLOUTS },
  { name: "rolling-start", scenarios: SCENARIO_ID_TO_ROLLING_START_ID, family: ROLLING_START_CALLOUTS },
  { name: "session-start", scenarios: SCENARIO_ID_TO_SESSION_START_ID, family: SESSION_START_CALLOUTS },
  { name: "start-light", scenarios: SCENARIO_ID_TO_START_LIGHT_ID, family: START_LIGHT_CALLOUTS },
  { name: "tire-wear", scenarios: SCENARIO_ID_TO_TIRE_WEAR_ID, family: TIRE_WEAR_CALLOUTS },
  { name: "track-conditions", scenarios: SCENARIO_ID_TO_TRACK_CONDITIONS_ID, family: TRACK_CONDITIONS_CALLOUTS },
];

describe.each(GATED)("$name scenarios", ({ scenarios, family }) => {
  it("resolve every scenario id to a registry key", () => {
    for (const id of Object.values(scenarios)) {
      expect(CALLOUT_SETTING_KEYS).toContain(family.callouts[id]?.key);
    }
  });

  it("reach every callout id of the family", () => {
    expect(new Set(Object.values(scenarios))).toEqual(new Set(Object.keys(family.callouts)));
  });
});
