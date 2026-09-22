/**
 * The temperature figure the session-start and race-start briefs speak
 * (issue #1187) — one rule shared by the four `*TempNumber` resolvers so the
 * two briefs can never name a reading differently.
 *
 * **The figure says "degrees" itself — the `numbers-degrees` group.** Each
 * line records the number and the word as one utterance ("twenty eight
 * degrees,"), so a temperature clause is intro plus one clip, with a single
 * join left — the intro-to-value one, which the recordings are conditioned
 * on. The unit is not spoken: Celsius and Fahrenheit readings draw from the
 * same group, so the recorded range is the union of both units' spans,
 * −20 … 176 (−20 °C is −4 °F, and 80 °C is exactly 176 °F).
 *
 * **Below zero is spelled, never `String(n)`.** The snapshot hands the
 * resolver a rounded integer, and a cold session's `-4` must reach a clip:
 * `-4.mp3` would be read by the engine's take rule as a take of an empty
 * base, and `minus-4` as a take of `minus`. So negatives are named
 * `minus<N>` (`minus4`, `minus20`). No range is checked here (issue #836):
 * a reading the active voice has no clip for resolves to an empty pool and
 * aborts the optional clause it sits in.
 */
import { poolRef } from "../../dsl.js";

/** The clip group every temperature figure is drawn from. */
export const TEMPERATURE_NUMBER_GROUP = "numbers-degrees";

/**
 * The clip name a whole-number temperature is recorded under: the number
 * itself at zero and above, `minus<N>` below zero.
 *
 * @internal Exported for testing
 */
export function temperatureClipName(value: number): string {
  // Rounded here too: the snapshot builder rounds, but the harness and any
  // future caller may not, and `28.5` names a clip no voice records.
  const n = Math.round(value);

  return n < 0 ? `minus${-n}` : String(n);
}

/** The pool step that speaks `value` as a temperature figure. */
export function temperatureNumberRef(value: number): string {
  return poolRef(TEMPERATURE_NUMBER_GROUP, temperatureClipName(value));
}

/** The display unit a snapshot reports temperatures in. */
export type TemperatureUnit = "celsius" | "fahrenheit";

/**
 * The pool step for the OPTIONAL unit word after a figure — `unit-celsius` /
 * `unit-fahrenheit` under `session-start`. Not `degrees-*`: the figure already
 * says "degrees", so the unit clip carries only the unit's name. The
 * reference voice records neither and its script never names the var; a pack
 * that wants its engineer to say the unit records both and adds the step.
 */
export function temperatureUnitRef(unit: TemperatureUnit): string {
  return poolRef("session-start", `unit-${unit}`);
}

/**
 * The shared description of both `*.degreesUnit` vars, naming each clip in
 * the `group/base` form `descriptionNamesGroup` reads.
 */
export const TEMPERATURE_UNIT_DESCRIPTION =
  "Optional: the temperature unit's name alone, per the driver's display setting — composes after a numbers-degrees figure, which already says the word degrees, to make \"twenty eight degrees, Celsius\". Draws session-start/unit-celsius or session-start/unit-fahrenheit. The reference voice records neither and its script does not use it; a pack records both to have its engineer say the unit.";

/**
 * The shared tail of every `*TempNumber` description. It names the group in
 * the "<group> clip group" form `descriptionNamesGroup` reads, so `lint:pack`
 * and the pack reference both count the group as var-driven.
 */
export function temperatureNumberDescription(what: "track" | "air"): string {
  return `The ${what} temperature as a whole number in the driver's display unit, Celsius or Fahrenheit alike. Draws from the ${TEMPERATURE_NUMBER_GROUP} clip group, whose lines carry the word degrees themselves and are recorded for -20 to 176 (below zero named minus1 to minus20); a reading the voice has no clip for aborts the clause it sits in.`;
}
