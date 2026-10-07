import { defineCalloutFamily } from "../define.js";

export const RACE_START_CALLOUTS = defineCalloutFamily({
  id: "race-start",
  callouts: {
    /**
     * Opt-in for the race-start greeting + qualifying-position readout (issue
     * #568). One boolean for the family — the engineer fires ~3 s after the
     * iRacing session changes to a race session (even if the driver is still
     * in pit/garage), greets the driver by name, reports the grid position,
     * and reads the track + air temperature + wetness brief. **Replaces** the
     * session-start callout in race sessions so there is no double-greeting.
     * Defaults `true` so a fresh install hears it; the user can silence it
     * from the PI mid-session and the change takes effect on the next
     * `session.changed` without cutting an in-flight clip. Canonical id↔key
     * mapping in this family.
     */
    "race-start": { key: "calloutEnabledRaceStart", label: "Race start" },
  },
});
