import { defineCalloutFamily } from "../define.js";

export const CAUTION_CALLOUTS = defineCalloutFamily({
  id: "caution",
  callouts: {
    /**
     * Per-callout opt-ins for the narrated full-course caution sequence
     * (issues #1127, #1168), eleven subjects: who to follow, the pace car
     * coming out, it picking up the field, an extra caution lap, the
     * one-to-go warning, the car ahead changing during the lineup, a gap
     * opened to the car ahead and its reminders, your race position on the
     * last caution lap, the pace car peeling off, and the restart itself.
     * The canonical id↔key mapping lives in this family. All default true —
     * new Race Engineer functionality ships on.
     */
    follow: { key: "calloutEnabledCautionFollow", label: "Who to follow" },
    "pace-car-out": { key: "calloutEnabledCautionPaceCarOut", label: "Pace car out" },
    "field-caught": { key: "calloutEnabledCautionFieldCaught", label: "Two to green" },
    "extra-lap": { key: "calloutEnabledCautionExtraLap", label: "Another caution lap" },
    "one-to-go": { key: "calloutEnabledCautionOneToGo", label: "One lap to green" },
    "lineup-changed": { key: "calloutEnabledCautionLineupChanged", label: "Car ahead changed" },
    // Catch the car ahead (issue #1168): the first call when you have dropped
    // back from the car you line up behind, and its reminders. Two switches,
    // so a driver who finds the reminders naggy keeps the first call.
    "catch-up": { key: "calloutEnabledCautionCatchUp", label: "Catch the car ahead" },
    "catch-up-reminder": { key: "calloutEnabledCautionCatchUpReminder", label: "Catch-up reminders" },
    "pace-car-off": { key: "calloutEnabledCautionPaceCarOff", label: "Pace car off" },
    restart: { key: "calloutEnabledCautionRestart", label: "Restart" },
    position: { key: "calloutEnabledCautionPosition", label: "Position on the last lap" },
  },
});
