/**
 * The FFB force readout, shown either as iRacing's max force in Nm or as its
 * Strength value (issue #1451). Shared so the Force Feedback dial and a keypad
 * View key (#1268) format the one value the same way.
 *
 * iRacing reports only the max force (`SteeringWheelMaxForceNm`); there is no
 * Strength variable. The model, from a live reading (see the #1451 spec):
 * iRacing stores Strength in 0.01 steps, sets the max force to exactly
 * `FFB_STRENGTH_K / Strength`, and shows both numbers to one decimal.
 */

/** The constant (Nm) that links Strength and max force: `Strength = FFB_STRENGTH_K / maxForceNm`. */
export const FFB_STRENGTH_K = 340;

/** Which number the FFB force readout shows. */
export const FFB_READOUTS = ["max-force", "strength"] as const;
export type FfbReadout = (typeof FFB_READOUTS)[number];

/** The readout shown when there is no usable value. */
const NO_VALUE = "---";

/** A usable max force: a finite, strictly positive number. */
function usableNm(nm: number | null | undefined): nm is number {
  return typeof nm === "number" && Number.isFinite(nm) && nm > 0;
}

/** The Strength for a usable max force, in whole hundredths (its stored grid), or `null` if not finite. */
function strengthHundredths(nm: number): number | null {
  const hundredths = Math.round((FFB_STRENGTH_K / nm) * 100);

  return Number.isFinite(hundredths) ? hundredths : null;
}

/**
 * iRacing's Strength for a max force in Nm, on its 0.01 grid, or `null`
 * without a usable value (missing, non-finite, zero or negative Nm). Snapping
 * to the grid undoes the float32 noise in the telemetry value, so the
 * one-decimal display rounds the stored Strength rather than a neighbour of it.
 */
export function ffbStrengthFromNm(nm: number | null | undefined): number | null {
  if (!usableNm(nm)) return null;

  const hundredths = strengthHundredths(nm);

  return hundredths === null ? null : hundredths / 100;
}

/**
 * The readout string: `11.5 Nm` for max force, `33.5` (no unit, as iRacing
 * shows it) for Strength, and `---` in either without a usable value.
 */
export function formatFfbReadout(nm: number | null | undefined, readout: FfbReadout): string {
  if (!usableNm(nm)) return NO_VALUE;

  if (readout === "max-force") return `${nm.toFixed(1)} Nm`;

  const hundredths = strengthHundredths(nm);

  if (hundredths === null) return NO_VALUE;

  // Round the whole hundredths to tenths as integers: `toFixed(1)` on the
  // double 10.55 could land either side of the half.
  return (Math.round(hundredths / 10) / 10).toFixed(1);
}
