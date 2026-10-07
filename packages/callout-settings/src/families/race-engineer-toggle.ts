import { defineCalloutFamily } from "../define.js";

export const RACE_ENGINEER_TOGGLE_CALLOUTS = defineCalloutFamily({
  id: "race-engineer-toggle",
  callouts: {
    /**
     * Opt-in for the Race Engineer audible toggle acknowledgement
     * (issue #554). When enabled, pressing the Race Engineer button on the
     * Pit Crew action plays a short voice line confirming the new state
     * ("going silent" on disable, "resuming communication" on enable). UI-side
     * acknowledgement only — the scenario engine isn't involved. Read live in
     * `PitCrew.toggleRaceEngineer()`; if disabled, the toggle remains silent
     * (border/status indicator still updates). Default `true` so existing
     * users get the ack without editing settings.
     */
    ack: { key: "calloutEnabledToggleRaceEngineer", label: "Toggle on/off acknowledgment" },
  },
});
