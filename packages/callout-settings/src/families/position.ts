import { defineCalloutFamily } from "../define.js";

export const POSITION_CALLOUTS = defineCalloutFamily({
  id: "position",
  callouts: {
    /**
     * Opt-in for the position-change callout (issues #566 + #569). One boolean
     * for the family — the engineer announces the driver's current position
     * after a qualifying or race lap whose effective position changed. In
     * qualifying the engineer also speaks a status line when position holds on
     * a non-PB lap and a dedicated pole call on an improvement to P1; in race
     * only real changes fire, because the every-3-laps race-status callout
     * (`calloutEnabledRaceStatus`) owns hold-position updates. Practice /
     * test sessions stay silent. Defaults `true`; the user can silence it
     * mid-session and the change takes effect on the next lap completion
     * without cutting an in-flight clip. Canonical id↔key mapping in this family.
     */
    change: { key: "calloutEnabledPositionChange", label: "Position changed" },
  },
});
