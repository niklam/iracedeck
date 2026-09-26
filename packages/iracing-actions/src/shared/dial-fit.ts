/**
 * Value fitting for the dash-box renderers (#1013): one primitive shared by the
 * Stream Deck+ strip (`dial-strip-box.ts`) and the Stream Dock knob
 * (`dial-knob-box.ts`), so the two drawings can never fit a value differently.
 */

/**
 * Bold Arial digits + "." average ~0.6 em wide; shrink the value font so the
 * number fits the box width, capped so short values (e.g. "3") stay sensible.
 */
export function fitValueFontSize(text: string, maxWidth: number, cap: number): number {
  const approx = maxWidth / Math.max(1, text.length * 0.6);

  return Math.round(Math.min(cap, approx));
}
