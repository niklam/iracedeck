import { defineCalloutFamily } from "../define.js";

/** See `PIT_LIMITER_CALLOUTS` for the shared rationale (#1051). */
export const NO_LIMITER_CALLOUTS = defineCalloutFamily({
  id: "no-limiter",
  callouts: {
    // over the pit limit, on a car with NO limiter
    speeding: { key: "calloutEnabledNoLimiterSpeeding", label: "Speeding (no limiter)" },
    // pit entry reminder plus the spoken limit, cars with NO limiter
    entry: { key: "calloutEnabledNoLimiterEntry", label: "Pit entry speed reminder" },
  },
});
