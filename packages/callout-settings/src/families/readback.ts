import { defineCalloutFamily } from "../define.js";

export const PIT_READBACK_CALLOUTS = defineCalloutFamily({
  id: "pit-readback",
  callouts: {
    /**
     * Pit-service readback opt-ins (issue #476). Two subjects: the
     * "We're …" callout on pit entry and the "To confirm: …" callout
     * after pit exit. Same forward-compat semantics as flag callouts —
     * default `true` so existing users receive the readback without
     * editing settings, opt-out toggles them off at event-arrival
     * time without cutting in-flight playback. Canonical id↔key
     * mapping in this family.
     */
    "pit-readback-entry": { key: "calloutEnabledPitReadbackEntry", label: "Pit entry readback" },
    "pit-readback-exit": { key: "calloutEnabledPitReadbackExit", label: "Pit exit readback" },
  },
});
