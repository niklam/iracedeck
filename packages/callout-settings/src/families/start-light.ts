import { defineCalloutFamily } from "../define.js";

/**
 * Two grouped start-light opt-ins (issue #480): `calloutEnabledStartLights`
 * (the 3 gantry lines) and `calloutEnabledStartCountdown` (the 5 numeric
 * countdown clips). Default `true` so existing users receive them
 * automatically.
 */
export const START_LIGHT_CALLOUTS = defineCalloutFamily({
  id: "start-light",
  callouts: {
    lights: { key: "calloutEnabledStartLights", label: "Lights & go" },
    countdown: {
      key: "calloutEnabledStartCountdown",
      label: "Countdown",
      description:
        "Before a standing start, calls 90, 60, 30 and 10 seconds to go, even while you are still in the garage.",
    },
  },
});
