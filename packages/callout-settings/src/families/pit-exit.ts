import { defineCalloutFamily } from "../define.js";

export const PIT_EXIT_CALLOUTS = defineCalloutFamily({
  id: "pit-exit",
  callouts: {
    /**
     * Opt-in for the pit exit beep (issue #1161). One boolean for the family —
     * a single short tone the moment the player crosses the pit exit line,
     * where the pit speed limit ends, rather than a spoken line. Rendered
     * beside "Pit road speeding" so both pit-lane tones are switched in one
     * place. Defaults `false`, an exception to new Race Engineer functionality
     * shipping enabled: the maintainer's decision after the manual test
     * (2026-11-09), so a driver opts into the tone. Canonical id↔key mapping
     * in this family.
     */
    cue: { key: "calloutEnabledPitExitCue", label: "Pit exit beep", default: false },
  },
});
