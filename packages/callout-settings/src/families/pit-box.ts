import { defineCalloutFamily } from "../define.js";

export const PIT_BOX_CALLOUTS = defineCalloutFamily({
  id: "pit-box",
  callouts: {
    /**
     * Opt-in for the pit-box count-in (issue #600). One boolean for the whole
     * countdown — as the driver drives down pit road toward their box the
     * engineer counts the remaining distance down ("five… four… three… two…
     * one… pit now") so they know when to stop without overshooting the stall.
     * The box position comes from `DriverInfo.DriverPitTrkPct`, so it works on
     * the first stop of a session. Fires whenever the car is on pit road and
     * approaching the box (including drive-throughs). Defaults `true` so a fresh
     * install hears it; the user can silence it mid-session and the change takes
     * effect on the next mark without cutting an in-flight clip. Canonical
     * id↔key mapping in this family.
     */
    "count-in": { key: "calloutEnabledPitBoxCountIn", label: "Count-in to pit box" },
  },
});
