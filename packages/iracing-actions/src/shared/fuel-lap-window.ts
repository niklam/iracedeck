import { FUEL_LAP_HISTORY_CAP } from "@iracedeck/sim-events-iracing";
import { z } from "zod";

/** The average-fuel window a fresh key starts with, in valid laps. */
export const DEFAULT_FUEL_LAP_WINDOW = 5;

/**
 * How many recent valid laps an average-fuel figure covers — the one schema
 * Session Info's fuel average (#465) and Pit Crew's Telemetry Readout (#466)
 * share, so the two can never disagree about what "average over 5 laps"
 * means. Rounds and clamps into 1…`FUEL_LAP_HISTORY_CAP` instead of
 * validating hard: a hand-typed decimal (the PI number box doesn't
 * step-round) or an out-of-range persisted value must not fail the whole
 * settings parse, which would silently reset the action to its defaults.
 */
export const FuelLapWindow = z.preprocess(
  (val) => (val === "" || val === null || val === undefined ? undefined : val),
  z.coerce
    .number()
    .transform((val) => Math.min(FUEL_LAP_HISTORY_CAP, Math.max(1, Math.round(val))))
    .catch(DEFAULT_FUEL_LAP_WINDOW),
);
