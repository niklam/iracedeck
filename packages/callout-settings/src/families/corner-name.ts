import { defineCalloutFamily } from "../define.js";

export const CORNER_NAME_CALLOUTS = defineCalloutFamily({
  id: "corner-name",
  callouts: {
    /**
     * Opt-in for the corner-name callouts (issue #888). One boolean for the
     * family — the engineer announces the upcoming corner's name in practice
     * and test sessions. Defaults `true`. Canonical id↔key mapping in this family.
     */
    "corner-names": { key: "calloutEnabledCornerNames", label: "Corner names (practice/test)" },
  },
});
