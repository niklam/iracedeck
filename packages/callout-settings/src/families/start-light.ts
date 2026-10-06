import { defineCalloutFamily } from "../define.js";

export const START_LIGHT_CALLOUTS = defineCalloutFamily({
  id: "start-light",
  callouts: {
    lights: { key: "calloutEnabledStartLights", label: "Lights & go" },
    countdown: { key: "calloutEnabledStartCountdown", label: "Countdown" },
  },
});
