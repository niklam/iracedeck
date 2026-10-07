import { defineCalloutFamily } from "../define.js";

export const ROLLING_START_CALLOUTS = defineCalloutFamily({
  id: "rolling-start",
  callouts: {
    // Rolling-start pace-car callout opt-in (issue #660).
    "pace-car": { key: "calloutEnabledRollingStartPaceCar", label: "Pace car moving" },
  },
});
