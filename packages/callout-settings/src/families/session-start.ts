import { defineCalloutFamily } from "../define.js";

export const SESSION_START_CALLOUTS = defineCalloutFamily({
  id: "session-start",
  callouts: {
    /**
     * Opt-in for the session-start readout (issues #542, #668). One boolean
     * for the whole readout — the engineer's greeting + session-type line +
     * pit speed limit + track/air temperature + track wetness. Fired when a
     * practice or qualifying session starts (on `session.changed`, ~3 s in),
     * whether or not the driver leaves the garage; also fires when the plugin
     * connects into a practice/qualifying session mid-way (fresh-connect
     * synthesis). Defaults `true` so a fresh install hears it; the user can
     * silence it from the PI mid-session and the change takes effect on the
     * next session without cutting an in-flight clip. Canonical id↔key mapping
     * in this family.
     */
    "session-start": { key: "calloutEnabledSessionStart", label: "Session start conditions" },
  },
});
