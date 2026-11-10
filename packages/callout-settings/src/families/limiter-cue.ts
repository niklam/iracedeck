import { defineCalloutFamily } from "../define.js";

export const LIMITER_CUE_CALLOUTS = defineCalloutFamily({
  id: "limiter-cue",
  callouts: {
    /**
     * Opt-in for the limiter-on beep (issue #1272). One boolean for the family —
     * a single short tone the moment the player's pit limiter engages, anywhere
     * on track, the pit box included, rather than a spoken line. Rendered in
     * the Pit Limiter group after the pit-limiter family's lines, since a driver
     * looking for a limiter beep looks under the limiter (the maintainer,
     * 2026-09-27). A family of its own rather than an entry of `pit-limiter`,
     * because that family is held to its scenario map in both directions and
     * this cue is no scenario: it is read inside the code-owned limiter cue
     * engine. Defaults `false`, an exception to new Race Engineer functionality
     * shipping enabled: the maintainer's decision for both pit-lane beeps
     * (2026-11-09, the same as the pit exit beep), so a driver opts into the
     * tone. Canonical id↔key mapping in this family.
     */
    cue: { key: "calloutEnabledLimiterEngagedCue", label: "Limiter on beep", default: false },
  },
});
