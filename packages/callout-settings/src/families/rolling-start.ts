import { defineCalloutFamily } from "../define.js";

export const ROLLING_START_CALLOUTS = defineCalloutFamily({
  id: "rolling-start",
  callouts: {
    // Rolling-start pace-car callout opt-in (issue #660).
    "pace-car": { key: "calloutEnabledRollingStartPaceCar", label: "Pace car moving" },
    // The rolling start's last-pace-lap call (issues #480, #657). It says "One
    // lap to green" with the car and lane since #1167, which also moved it
    // here from the flag family so its switch sits under Rolling Start. The
    // key keeps the "Flag" in its name: it is a persisted setting, and a
    // rename would need a migration to carry every stored value across.
    "one-pace-lap-to-go": { key: "calloutEnabledFlagOnePaceLapToGo", label: "One lap to green" },
    // The car to form up behind changes during the formation (issue #1167).
    // Its own switch rather than the caution's: turning off the caution
    // narration is not a request to silence the start.
    "lineup-changed": { key: "calloutEnabledRollingStartLineupChanged", label: "Car ahead changed" },
  },
});
