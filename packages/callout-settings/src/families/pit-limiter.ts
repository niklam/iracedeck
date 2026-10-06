import { defineCalloutFamily } from "../define.js";

export const PIT_LIMITER_CALLOUTS = defineCalloutFamily({
  id: "pit-limiter",
  callouts: {
    // pit road entered with the limiter off
    missing: { key: "calloutEnabledLimiterMissing", label: "Limiter off on pit road" },
    // the limiter came off while still between the cones
    dropped: { key: "calloutEnabledLimiterDropped", label: "Limiter dropped" },
    // over the pit limit, on a car that HAS a limiter
    speeding: { key: "calloutEnabledLimiterSpeeding", label: "Speeding (limiter car)" },
    /**
     * Per-callout opt-ins for the two pit-road speed families (issue #1051).
     *
     * TWO families, split by equipment, because they differ by REMEDY and not
     * merely by wording: a limiter car speeding on pit road is usually speeding
     * because the limiter is off and the fix is the button; a car without one
     * has to lift. `calloutEnabledLimiter*` gate the limiter-framed callouts
     * (`hasPitLimiter` per #639); `calloutEnabledNoLimiter*` gate their mirror
     * for cars that have no limiter, whose lines never mention one.
     *
     * All default true — new Race Engineer functionality ships on — and, like
     * every other `calloutEnabled*` field, carry no `.catch`: the
     * union-plus-transform chain has no throw path, which is the exemption
     * `global-settings.md` names.
     */
    // the limiter was engaged while out on track
    "on-track": { key: "calloutEnabledLimiterOnTrack", label: "Limiter still on after pit exit" },
  },
});
