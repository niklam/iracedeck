import { defineCalloutFamily } from "../define.js";

export const FUEL_CALLOUTS = defineCalloutFamily({
  id: "fuel",
  callouts: {
    /**
     * Per-count opt-ins for the estimated laps-of-fuel-left callouts (issue
     * #838). One boolean per spoken count 10 → 1 plus the count-0 "box this
     * lap for fuel" call. Unlike most callout families the defaults are NOT
     * uniform: 5, 3, 2, 1 and Box ship ON, the rest OFF (the Discord-request
     * baseline) — a driver who wants the full countdown opts the other counts
     * in. Canonical id↔key mapping in this family; the margin slider
     * (`fuelCalloutMarginLaps`) tunes the estimate they all speak.
     */
    "laps-left-10": { key: "calloutEnabledFuelLapsLeft10", label: "10 laps of fuel left", default: false },
    "laps-left-9": { key: "calloutEnabledFuelLapsLeft9", label: "9 laps of fuel left", default: false },
    "laps-left-8": { key: "calloutEnabledFuelLapsLeft8", label: "8 laps of fuel left", default: false },
    "laps-left-7": { key: "calloutEnabledFuelLapsLeft7", label: "7 laps of fuel left", default: false },
    "laps-left-6": { key: "calloutEnabledFuelLapsLeft6", label: "6 laps of fuel left", default: false },
    "laps-left-5": { key: "calloutEnabledFuelLapsLeft5", label: "5 laps of fuel left" },
    "laps-left-4": { key: "calloutEnabledFuelLapsLeft4", label: "4 laps of fuel left", default: false },
    "laps-left-3": { key: "calloutEnabledFuelLapsLeft3", label: "3 laps of fuel left" },
    "laps-left-2": { key: "calloutEnabledFuelLapsLeft2", label: "2 laps of fuel left" },
    "laps-left-1": { key: "calloutEnabledFuelLapsLeft1", label: "1 lap of fuel left" },
    "laps-left-box": { key: "calloutEnabledFuelLapsLeftBox", label: "Box this lap" },
    // "We have enough fuel to finish the race. No need to box for fuel." —
    // fires once per stint in the race endgame (10 or fewer laps to go by
    // the binding limit) when the tank covers the remaining distance with a
    // lap in hand — even when no warning was ever close (issue #880).
    "race-covered": { key: "calloutEnabledFuelLapsLeftRaceCovered", label: "Enough fuel to finish" },
  },
});
