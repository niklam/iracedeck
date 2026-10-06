import { defineCalloutFamily } from "../define.js";

export const OVERTAKE_CALLOUTS = defineCalloutFamily({
  id: "overtake",
  callouts: {
    /**
     * Opt-ins for the overtake gain / loss callouts (issue #574). Two booleans
     * — independently toggleable so a driver who wants congratulations but not
     * chastisement (or vice versa) gets per-direction control. The engineer
     * fires mid-race when the driver gains a position ("Nice pass. That puts
     * us to P[n].") or loses one ("Come on, [name]. Don't give up positions
     * like that. We're now in P[n]."), and the gain side has a dedicated
     * "we're now leading race" line when the pass takes the player to P1.
     * Both default `true`. Canonical id↔key mapping in this family.
     */
    gained: { key: "calloutEnabledOvertakeGained", label: "Gained position" },
    lost: { key: "calloutEnabledOvertakeLost", label: "Lost position" },
  },
});
