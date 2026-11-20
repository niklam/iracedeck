import { defineCalloutFamily } from "../define.js";

export const TRAFFIC_CALLOUTS = defineCalloutFamily({
  id: "traffic",
  callouts: {
    /**
     * Approaching-traffic warnings (issue #1113). `rejoin` gates the calls while
     * the player is stopped or crawling on track — right behind, near with its
     * seconds and the group call, warnings only (amended 2026-11-20: nothing
     * reassures) — and `pit-exit` the verdict
     * spoken about three seconds before the end of pit road, traffic or clear at
     * the end of the exit blend, and the merge warning in the exit lane (amended
     * 2026-11-20). The pit-exit window and the merge threshold are the three
     * `trafficPitExit*Seconds` settings beside these rows in the settings
     * window; rejoin has none. Grouped under their own heading after Spotter rather than
     * under Pit Speeding, where the pit exit beep (#1161) lives: the beep is a
     * pit-lane tone, this is a warning about cars on track. `pit-exit` defaults
     * on, as new Race Engineer functionality does; `rejoin` ships experimental
     * and off, its label saying so — the maintainer's call after his in-game
     * test (2026-11-20, the #1113 spec's amendment of that date), a deliberate
     * exception to that rule. Canonical id↔key mapping in this family.
     */
    rejoin: { key: "calloutEnabledTrafficRejoin", label: "Traffic when rejoining (experimental)", default: false },
    "pit-exit": { key: "calloutEnabledTrafficPitExit", label: "Traffic at pit exit" },
  },
});
