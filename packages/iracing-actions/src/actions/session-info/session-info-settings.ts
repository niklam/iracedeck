/**
 * Session Info settings schema — its own module so the action and the readout
 * builder (`readout-request.ts`, issue #466) both read it without importing
 * each other (the `audio-controls-settings.ts` pattern).
 */
import { CommonSettings } from "@iracedeck/deck-core";
import { FUEL_LAP_HISTORY_CAP } from "@iracedeck/sim-events-iracing";
import z from "zod";

/**
 * One Tire Temperatures color threshold (issue #254), by the `fuelLapWindow`
 * rule: a blank field is the default, and so is anything that does not read as
 * a number, so one malformed field never fails the whole settings parse and
 * resets the key. A number the driver typed is kept as typed: the three are
 * never clamped into order, since the bands are evaluated hottest first.
 */
function tireTempThreshold(fallback: number) {
  return z.preprocess(
    (val) => (val === null || val === undefined || (typeof val === "string" && val.trim() === "") ? undefined : val),
    z.coerce.number().catch(fallback),
  );
}

export const SessionInfoSettings = CommonSettings.extend({
  mode: z
    .enum([
      "incidents",
      "time-remaining",
      "laps",
      "position",
      "irating",
      "gaps",
      "fuel",
      "flags",
      "track-wetness",
      "laps-to-empty",
      "wind",
      "track-temp",
      "air-temp",
      "tire-temps",
    ])
    .default("incidents"),
  fontSize: z.preprocess(
    (val) => (val === "" || val === null || val === undefined ? undefined : val),
    z.coerce.number().min(5).max(36).optional(),
  ),
  positionType: z.enum(["class", "overall"]).default("class"),
  positionShowTotal: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(false),
  fuelFormat: z.enum(["amount", "percentage"]).default("amount"),
  // Fuel consumption sub-modes (issue #465): "now" is the pre-existing tank
  // level display; "lastLap" / "avgN" read the translator's validated fuel lap
  // history via getFuelStats(). fuelLapWindow rounds + clamps instead of
  // validating hard — a hand-typed decimal (the PI number box doesn't
  // step-round) or an out-of-range persisted value must not fail the whole
  // settings parse, which would silently reset the action to its defaults.
  fuelSubMode: z.enum(["now", "lastLap", "avgN"]).default("now"),
  fuelLapWindow: z.preprocess(
    (val) => (val === "" || val === null || val === undefined ? undefined : val),
    z.coerce
      .number()
      .transform((val) => Math.min(FUEL_LAP_HISTORY_CAP, Math.max(1, Math.round(val))))
      .catch(5),
  ),
  blankWhenNoFlag: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(false),
  // Gaps mode row toggles (issue #933): which of the two class-neighbor gap
  // rows the key shows. Both default on; a single enabled row renders larger.
  gapShowAhead: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(true),
  gapShowBehind: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(true),
  // Wind mode (issue #947). "relative" points the arrow where the wind pushes
  // the car (the useful reading mid-corner); "absolute" points it where the
  // wind travels in world space, north up, and names the compass direction it
  // blows FROM — matching how iRacing itself labels wind.
  windDirectionMode: z.enum(["relative", "absolute"]).default("relative"),
  windSpeedUnit: z.enum(["ms", "kmh", "mph"]).default("kmh"),
  // Tire Temperatures (issue #254): the tire temperatures of the last pit
  // stop, never live ones. "all" shows one figure per tire, summarized from
  // its three zones by tireTempMethod; a single corner shows that tire's three
  // zones, where the method does not apply.
  tireTempCorner: z.enum(["all", "lf", "rf", "lr", "rr"]).default("all"),
  tireTempMethod: z.enum(["weighted", "average", "max", "middle"]).default("weighted"),
  tireTempColors: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(true),
  // The unit the color thresholds are typed in. Each unit keeps its own stored
  // set, so switching the selector never leaves Celsius numbers standing as
  // Fahrenheit ones, and nothing the driver typed is rewritten or lost on the
  // way back. It is stored with the key and does not follow iRacing's
  // DisplayUnits, which would silently change what a stored "100" means.
  tireTempThresholdUnit: z.enum(["c", "f"]).default("c"),
  tireTempColdBelow: tireTempThreshold(75),
  tireTempHotAbove: tireTempThreshold(90),
  tireTempCriticalAbove: tireTempThreshold(100),
  tireTempColdBelowF: tireTempThreshold(165),
  tireTempHotAboveF: tireTempThreshold(195),
  tireTempCriticalAboveF: tireTempThreshold(210),
  // Speak value on press (issue #466): a press has the Race Engineer read out
  // the value the key shows. One switch for the whole action, on every item —
  // an item with no speech yet ignores the press, and one that gains speech
  // later needs no settings change. Defaults on, like new Race Engineer
  // functionality; the Race Engineer master still gates every readout.
  speakOnPress: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(true),
});

export type SessionInfoSettings = z.infer<typeof SessionInfoSettings>;
