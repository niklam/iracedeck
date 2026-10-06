import { defineCalloutFamily } from "../define.js";

export const GAP_CALLOUTS = defineCalloutFamily({
  id: "gap",
  callouts: {
    /**
     * Opt-ins for the gap callout family (issue #933): the sustained
     * trend-flip announcement ("we're gaining on the car ahead") and the
     * threshold-crossing alert ("we've caught the car ahead"), both against
     * the class-standings neighbors. Default `true`. Canonical id↔key
     * mapping in this family.
     */
    trend: { key: "calloutEnabledGapTrend", label: "Gap trend (gaining/losing)" },
    threshold: { key: "calloutEnabledGapThreshold", label: "Gap under threshold" },
  },
});
