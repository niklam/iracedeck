import { defineCalloutFamily } from "../define.js";

export const CAUTION_CALLOUTS = defineCalloutFamily({
  id: "caution",
  callouts: {
    /**
     * Per-callout opt-ins for the narrated full-course caution sequence
     * (issue #1127), nine subjects: who to follow, the pace car coming out,
     * it picking up the field, an extra caution lap, the one-to-go warning,
     * the car ahead changing during the lineup, your race position on the
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
    "pace-car-off": { key: "calloutEnabledCautionPaceCarOff", label: "Pace car off" },
    restart: { key: "calloutEnabledCautionRestart", label: "Restart" },
    position: { key: "calloutEnabledCautionPosition", label: "Position on the last lap" },
  },
});
