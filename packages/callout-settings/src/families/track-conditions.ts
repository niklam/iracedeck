import { defineCalloutFamily } from "../define.js";

export const TRACK_CONDITIONS_CALLOUTS = defineCalloutFamily({
  id: "track-conditions",
  callouts: {
    /**
     * Master opt-in for the track-conditions callout family (issue #526).
     * Single subject for v1 — every (direction × target) combination of the
     * Race Engineer's track-wetness change announcement is gated by this one
     * boolean. Forward-compat: future track-related callouts (temperature,
     * weather type) join the same `Track` family with their own per-subject
     * keys, following the
     * `callout<Polarity><Family><Subject>` convention. See the canonical
     * id↔key mapping in this family.
     */
    wetness: { key: "calloutEnabledTrackWetness", label: "Wetness changes" },
  },
});
