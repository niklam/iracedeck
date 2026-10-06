import { defineCalloutFamily } from "../define.js";

export const PIT_WINDOW_CALLOUTS = defineCalloutFamily({
  id: "pit-window",
  callouts: {
    // Pit-window open/closed callout opt-in (issue #655). One subject covers
    // both directions (pits opened / closed). Canonical id↔key mapping in this family.
    "pit-open-closed": { key: "calloutEnabledPitOpenClosed", label: "Pit open/closed" },
  },
});
