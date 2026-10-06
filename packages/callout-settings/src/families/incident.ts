import { defineCalloutFamily } from "../define.js";

export const INCIDENT_CALLOUTS = defineCalloutFamily({
  id: "incident",
  callouts: {
    /**
     * Per-incident-type callout opt-ins (issue #530). One boolean per
     * `irsdk_IncidentFlags` report-byte category surfaced by the bus.
     * Every category defaults `true` so a fresh install gets full
     * type-specific coaching (track limits / composure / contact vs
     * collision-with-penalty) — the user can silence individual
     * categories from the PI mid-session and the change takes effect on
     * the next event arrival without cutting an in-flight clip. Same
     * forward-compat semantics as the other callout families. Canonical
     * id↔key mapping in this family.
     */
    "off-track": { key: "calloutEnabledIncidentOffTrack", label: "Off track" },
    "out-of-control": { key: "calloutEnabledIncidentOutOfControl", label: "Out of control" },
    "contact-world": { key: "calloutEnabledIncidentContactWorld", label: "Contact (wall)" },
    "collision-world": { key: "calloutEnabledIncidentCollisionWorld", label: "Collision (wall)" },
    "contact-car": { key: "calloutEnabledIncidentContactCar", label: "Contact (car)" },
    "collision-car": { key: "calloutEnabledIncidentCollisionCar", label: "Collision (car)" },
  },
});
