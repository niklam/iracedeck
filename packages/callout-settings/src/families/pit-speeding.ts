import { defineCalloutFamily } from "../define.js";

export const PIT_SPEEDING_CALLOUTS = defineCalloutFamily({
  id: "pit-speeding",
  callouts: {
    /**
     * Opt-in for the repeating pit-road speeding cue (issue #912). One
     * boolean for the family — a repeating tick sounds while the car is over
     * the pit-lane speed limit, rather than a spoken line. Defaults `true`
     * because new Race Engineer functionality ships enabled. Canonical id↔key
     * mapping in this family.
     */
    cue: { key: "calloutEnabledPitSpeedingCue", label: "Pit road speeding" },
  },
});
