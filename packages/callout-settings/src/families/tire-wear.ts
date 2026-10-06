import { defineCalloutFamily } from "../define.js";

export const TIRE_WEAR_CALLOUTS = defineCalloutFamily({
  id: "tire-wear",
  callouts: {
    /**
     * Tire-wear report opt-in (issue #1108). The remaining tread of all four
     * tires, spoken after a pit stop the driver drove into, right behind the
     * exit readback. Same forward-compat semantics as the flag callouts —
     * default `true`, opt-out read at event arrival without cutting an
     * in-flight report. Canonical id↔key mapping in this family.
     */
    report: { key: "calloutEnabledTireWearReport", label: "Tire wear report" },
  },
});
