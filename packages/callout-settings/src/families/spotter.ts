import { defineCalloutFamily } from "../define.js";

export const SPOTTER_CALLOUTS = defineCalloutFamily({
  id: "spotter",
  callouts: {
    /**
     * Spotter per-callout opt-ins (issue #651). The spoken Spotter proximity
     * calls are a Race Engineer callout family — there is no standalone master;
     * they ride `pitCrewRaceEngineerEnabled` like flags/position/lap-time.
     * "Cars" gates every transition call (car/two cars/one car/three wide/clear/
     * combined); "StillThere" gates the repeating reminder while alongside (its
     * cadence is set by `spotterStillThereSeconds`).
     * Default `true` so users discover the calls (with Race Engineer enabled)
     * and turn off what they don't want; opt-out takes effect at event-arrival
     * time without cutting in-flight playback. Canonical id↔key mapping in this family.
     */
    cars: { key: "calloutEnabledSpotterCars", label: "Announce cars around you" },
    "still-there": { key: "calloutEnabledSpotterStillThere", label: "Repeat reminder while alongside" },
  },
});
