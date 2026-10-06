import { defineCalloutFamily } from "../define.js";

export const CORNER_NAMES_TOGGLE_CALLOUTS = defineCalloutFamily({
  id: "corner-names-toggle",
  callouts: {
    /**
     * Corner Names toggle acknowledgment (issue #897). When enabled, the Pit
     * Crew Corner Names key speaks a short confirmation on every toggle
     * ("corner calls coming up" / "dropping the corner calls"). Only gates
     * the ack — the toggle itself always applies, and the ack additionally
     * requires the Race Engineer master gate to be on. UI-side, no scenario
     * engine. Read live in `toggleCornerNamesFeature()`. Default `true`.
     */
    ack: { key: "calloutEnabledToggleCornerNames", label: "Toggle on/off acknowledgment" },
  },
});
