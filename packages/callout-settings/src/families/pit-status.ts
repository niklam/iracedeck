import { defineCalloutFamily } from "../define.js";

export const PIT_STATUS_CALLOUTS = defineCalloutFamily({
  id: "pit-status",
  callouts: {
    /**
     * Pit-service status callout opt-ins (issue #479). One boolean per
     * non-`None` `PlayerCarPitSvStatus` target — the silent idle state
     * has no opt-out because it never reaches the bus.
     *
     * Same forward-compat semantics as the other callout families:
     * default `true` so a future plugin upgrade automatically enables
     * a new subject for existing users (`.passthrough()` on the schema
     * makes that property hold without a migration). Canonical id↔key
     * mapping in this family.
     */
    "in-progress": { key: "calloutEnabledPitStatusInProgress", label: "In progress" },
    complete: { key: "calloutEnabledPitStatusComplete", label: "Complete" },
    "too-far-left": { key: "calloutEnabledPitStatusTooFarLeft", label: "Too far left" },
    "too-far-right": { key: "calloutEnabledPitStatusTooFarRight", label: "Too far right" },
    "too-far-forward": { key: "calloutEnabledPitStatusTooFarForward", label: "Too far forward" },
    "too-far-back": { key: "calloutEnabledPitStatusTooFarBack", label: "Too far back" },
    "bad-angle": { key: "calloutEnabledPitStatusBadAngle", label: "Bad angle" },
    "cant-fix-that": { key: "calloutEnabledPitStatusCantFixThat", label: "Can't fix that" },
  },
});
