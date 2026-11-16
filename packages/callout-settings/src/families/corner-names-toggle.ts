import { defineCalloutFamily } from "../define.js";

export const CORNER_NAMES_TOGGLE_CALLOUTS = defineCalloutFamily({
  id: "corner-names-toggle",
  callouts: {
    /**
     * Corner Names toggle acknowledgment (issues #897, #1699). When enabled,
     * the Pit Crew Corner Names key speaks a short confirmation on every
     * toggle, whichever target the press names: corners ("corner calls
     * coming up" / "dropping the corner calls"), sectors ("sector calls …")
     * or both ("corner and sector calls …"). One opt-in for all three,
     * because nobody wants one target's ack and not another's from the same
     * key; the key and label keep their #897 names. Only gates the ack — the
     * toggle itself always applies, and the ack additionally requires the
     * Race Engineer master gate to be on. UI-side, no scenario engine. Read
     * live in `toggleTrackCallouts()`. Default `true`.
     */
    ack: { key: "calloutEnabledToggleCornerNames", label: "Toggle on/off acknowledgment" },
  },
});
