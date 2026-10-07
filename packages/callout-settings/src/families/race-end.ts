import { defineCalloutFamily } from "../define.js";

export const RACE_END_CALLOUTS = defineCalloutFamily({
  id: "race-end",
  callouts: {
    /**
     * Opt-in for the race-end final-result callout (issue #569). One boolean
     * for the family — the engineer greets the driver by name and speaks the
     * final result after the driver crosses S/F under the checkered flag in a
     * race session. Per-position branches: P1 ("we won!"), P2 ("second place"),
     * P3 ("podium"), P4+ ("the race is over. The final result for us is P[n]").
     * Defaults `true` so a fresh install hears it. Canonical id↔key mapping in this family.
     */
    "race-end": { key: "calloutEnabledRaceEnd", label: "Final result" },
  },
});
