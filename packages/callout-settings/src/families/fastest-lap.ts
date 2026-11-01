import { defineCalloutFamily } from "../define.js";

export const FASTEST_LAP_CALLOUTS = defineCalloutFamily({
  id: "fastest-lap",
  callouts: {
    /**
     * Opt-in for the fastest lap of the race (issue #1571): the engineer
     * announces a new fastest lap of the race in the player's class, whoever
     * set it, from each car's third completed lap on. With it off, a fastest
     * lap the player sets is read out by the best-lap call instead (#555).
     * Ships on; rendered under Lap Time, after the lap-time family's rows.
     */
    "fastest-lap": { key: "calloutEnabledFastestLap", label: "Fastest lap of the race" },
  },
});
