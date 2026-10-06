import { defineCalloutFamily } from "../define.js";

export const FLAG_CALLOUTS = defineCalloutFamily({
  id: "flag",
  callouts: {
    /**
     * Per-callout opt-in toggles (issue #467). Each subject the Race
     * Engineer announces has its own boolean — when false, that specific
     * callout is suppressed at event-arrival time so currently playing
     * announcements continue uninterrupted but no new callout of that
     * subject fires until the user re-enables it. All default to true so
     * existing users automatically receive any newly added callout
     * subject in a future release (forward-compat by default — the load-
     * bearing reason this is per-item booleans rather than an array).
     *
     * Naming convention: `callout<Polarity><Family><Subject>`. Polarity
     * is always positive (`Enabled`); the family noun (`Flag`,
     * `PitAction`, …) groups every member of the family for grep. The
     * canonical id↔key mapping lives in this family. See
     * `.claude/rules/global-settings.md` for the full convention.
     */
    "yellow-local": { key: "calloutEnabledFlagYellowLocal", label: "Yellow (local)" },
    "yellow-full": { key: "calloutEnabledFlagYellowFull", label: "Yellow (full course)" },
    "yellow-cleared": { key: "calloutEnabledFlagYellowCleared", label: "Yellow cleared" },
    green: { key: "calloutEnabledFlagGreen", label: "Green" },
    blue: { key: "calloutEnabledFlagBlue", label: "Blue" },
    white: { key: "calloutEnabledFlagWhite", label: "White" },
    red: { key: "calloutEnabledFlagRed", label: "Red" },
    black: { key: "calloutEnabledFlagBlack", label: "Black" },
    checkered: { key: "calloutEnabledFlagCheckered", label: "Checkered" },
    debris: { key: "calloutEnabledFlagDebris", label: "Debris" },
    meatball: { key: "calloutEnabledFlagMeatball", label: "Meatball" },
    "yellow-waving": { key: "calloutEnabledFlagYellowWaving", label: "Yellow waving" },
    "caution-waving": { key: "calloutEnabledFlagCautionWaving", label: "Caution waving" },
    crossed: { key: "calloutEnabledFlagCrossed", label: "Crossed flags" },
    "one-pace-lap-to-go": { key: "calloutEnabledFlagOnePaceLapToGo", label: "One pace lap to go" },
    "green-held": { key: "calloutEnabledFlagGreenHeld", label: "Green held" },
    "ten-to-go": { key: "calloutEnabledFlagTenToGo", label: "Ten to go" },
    "five-to-go": { key: "calloutEnabledFlagFiveToGo", label: "Five to go" },
    /**
     * Missing-session-flag callout opt-ins (issue #480). Driver-black
     * (disqualify/furled/dq-scoring-invalid), race-progression
     * (crossed/one-pace-lap-to-go/green-held/ten-to-go/five-to-go), and
     * caution-waving (yellow-waving/caution-waving) variants. Plus two
     * grouped start-light opt-ins: `calloutEnabledStartLights` (the 3
     * gantry lines) and `calloutEnabledStartCountdown` (the 5 numeric
     * countdown clips). Same forward-compat semantics as the flag callouts
     * above — default `true` so existing users receive them automatically.
     * Canonical id↔key mappings in this family and `START_LIGHT_CALLOUTS`.
     */
    disqualify: { key: "calloutEnabledFlagDisqualify", label: "Disqualified" },
    furled: { key: "calloutEnabledFlagFurled", label: "Black flag furled" },
    // Furled-warning withdrawn callout opt-in (issue #669).
    "furled-cleared": { key: "calloutEnabledFlagFurledCleared", label: "Furled cleared" },
    "dq-scoring-invalid": { key: "calloutEnabledFlagDqScoringInvalid", label: "DQ (scoring)" },
  },
});
