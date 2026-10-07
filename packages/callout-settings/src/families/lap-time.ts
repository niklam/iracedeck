import { defineCalloutFamily } from "../define.js";

export const LAP_TIME_CALLOUTS = defineCalloutFamily({
  id: "lap-time",
  callouts: {
    /**
     * Opt-in for the lap-time best-lap callout (issue #555). One boolean for
     * the family — the engineer announces the lap time after S/F when the
     * driver sets a new personal best (or completes their first valid lap of
     * the session). Defaults `true` so a fresh install hears it; the user can
     * silence it from the PI mid-session and the change takes effect on the
     * next lap completion without cutting an in-flight clip. Canonical id↔key
     * mapping in this family.
     */
    "best-lap": { key: "calloutEnabledLapTimeBestLap", label: "New best lap" },
  },
});
