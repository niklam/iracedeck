import { defineCalloutFamily } from "../define.js";

export const TRAFFIC_CALLOUTS = defineCalloutFamily({
  id: "traffic",
  callouts: {
    /**
     * Approaching-traffic warnings (issue #1113). `rejoin` gates the calls while
     * the player is stopped or crawling on track — clear, notice, hold and the
     * "clear, go" after a hold — and `pit-exit` the one verdict spoken on the
     * way out of the pits, traffic or clear at the end of the exit blend. Their
     * windows are the `traffic*Seconds` settings beside these rows in the
     * settings window. Grouped under their own heading after Spotter rather than
     * under Pit Speeding, where the pit exit beep (#1161) lives: the beep is a
     * pit-lane tone, this is a warning about cars on track. Both default on, as
     * new Race Engineer functionality does. Canonical id↔key mapping in this
     * family.
     */
    rejoin: { key: "calloutEnabledTrafficRejoin", label: "Traffic when rejoining" },
    "pit-exit": { key: "calloutEnabledTrafficPitExit", label: "Traffic at pit exit" },
  },
});
