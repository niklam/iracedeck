/**
 * Coerce a raw global-settings value to a finite number, or `null` when it is
 * MISSING — the one parsing step every numeric-setting sanitizer in this
 * package shares (gap threshold and movement gate, corner lead, opponent-flag
 * range), so the empty-field rule lives in exactly one place.
 *
 * Empty string and `null` must not become `0`: `Number("")` and
 * `Number(null)` are both a finite zero, so a cleared Property Inspector field
 * would silently mean "0 seconds" — which for the gap movement gate is the
 * value that turns the consistency gate OFF, and for every other setting
 * clamps to its minimum. A numeric string parses; anything else is missing.
 */
export function coerceSettingNumber(value: unknown): number | null {
  const n = typeof value === "string" && value !== "" ? Number(value) : value;

  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
