import { defineCalloutFamily } from "../define.js";

export const RACE_STATUS_CALLOUTS = defineCalloutFamily({
  id: "race-status",
  callouts: {
    /**
     * Opt-in for the race-status periodic position update (issue #569). One
     * boolean for the family — the engineer announces the driver's current
     * position every 3 laps as long as position holds (counter resets on every
     * position change). **Fires only in race sessions**; qualifying / practice /
     * test stay silent because the standings-after-lap model doesn't fit. Leader
     * gets a dedicated "We're still leading the race. Keep it up." line;
     * everyone else hears the reused "We're currently P[n]" status. Defaults
     * `true` so a fresh install hears it. Canonical id↔key mapping in this family.
     */
    status: { key: "calloutEnabledRaceStatus", label: "Position status (every 3 laps)" },
  },
});
