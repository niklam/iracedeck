import { defineCalloutFamily } from "../define.js";

export const QUALIFYING_INVALIDATION_CALLOUTS = defineCalloutFamily({
  id: "qualifying-invalidation",
  callouts: {
    /**
     * Opt-in for the qualifying lap-invalidation callout (issue #567). One
     * boolean for the family — the engineer announces "This lap will be
     * invalidated." plus a tail picked from the snapshot's `lapsRemaining`
     * (out-of-laps / per-N counted line / plenty-of-laps fallback). **Fires
     * only in qualifying sessions** — race / practice stay silent because the
     * lap-invalidation phrasing only makes sense for a timed qualifying lap.
     * Defaults `true` so a fresh install hears it; the user can silence it
     * from the PI mid-session and the change takes effect on the next event
     * without cutting an in-flight clip. Canonical id↔key mapping in this family.
     */
    "lap-invalidated": { key: "calloutEnabledQualifyingLapInvalidated", label: "Lap invalidated" },
  },
});
