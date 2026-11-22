import { defineCalloutFamily } from "../define.js";

export const FUEL_COUNTDOWN_SESSION_CALLOUTS = defineCalloutFamily({
  id: "fuel-countdown-sessions",
  callouts: {
    /**
     * Family-wide session gates for the laps-of-fuel-left countdown (issue
     * #1702). The translator puts the countdown on the bus in every live
     * session; these four decide in which session kinds the Race Engineer
     * speaks it, by the `SessionClass` the catalog reads: Race is the `race`
     * category (heat races and warmups included), Practice is `practice`
     * without `testing`, Qualifying is `qualifying` solo or not, and Test is
     * `practice` with `testing`. The per-count opt-ins in `fuel` stay shared
     * across all four, so no migration is owed. "Enough fuel to finish" is a
     * race line and needs the Race gate.
     *
     * Read live when the event arrives, so a mid-session toggle takes effect
     * on the next count without cutting an in-flight clip. Default `true`, so
     * an existing install's race countdown now speaks in every session kind.
     */
    race: { key: "calloutEnabledFuelCountdownRace", label: "Race" },
    practice: { key: "calloutEnabledFuelCountdownPractice", label: "Practice" },
    qualifying: { key: "calloutEnabledFuelCountdownQualifying", label: "Qualifying" },
    test: { key: "calloutEnabledFuelCountdownTest", label: "Test" },
  },
});
