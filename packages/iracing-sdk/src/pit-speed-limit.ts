/**
 * `WeekendInfo.TrackPitSpeedLimit` parsing (#1476).
 *
 * The one reader of that session-YAML string, shared by the translator's
 * pit-speeding threshold (#1059) and the Pit Speed Limiter key. It reports
 * what iRacing published and nothing more: each consumer applies its own
 * reading on top (the translator its half-unit correction, the key its
 * display conversion).
 */

/** A pit speed limit as published: the number, its unit and its precision. */
export type ParsedPitSpeedLimit = {
  /** The number as written, e.g. `72.42` for `"72.42 kph"`. May be `0`. */
  value: number;
  /** The unit the string names; a string with no unit reads as `"kmh"`. */
  unit: "kmh" | "mph";
  /** How many decimal places were published: `2` for `"72.42 kph"`, `0` for `"60 kph"`. */
  decimals: number;
};

/**
 * A number followed by a unit, anywhere in the string, any case. This is the
 * pattern the translator matched before #1476; it stays unanchored and first so
 * that every string it accepted still parses to the same value and unit.
 */
const WITH_UNIT = /([\d.]+)\s*(kph|mph|kmh|km\/h)/i;

/** The whole (trimmed) string is a plain decimal number with no unit. */
const BARE_NUMBER = /^\d+(?:\.\d+)?$/;

/**
 * Parse `WeekendInfo.TrackPitSpeedLimit` (`"80.00 kph"`, `"45 mph"`, `"60"`).
 *
 * Returns the published value, its unit and the number of decimals it was
 * published with, or `null` when `raw` is not a string or does not parse.
 * A bare number with no unit is read as km/h, because km/h is what iRacing
 * publishes.
 *
 * The value is returned exactly as written. No #1059 correction is applied
 * here (a limit published as a rounded conversion sits up to half a unit below
 * the true one), and a published `0` comes back as `0`: deciding that 0 means
 * "unknown", and widening a threshold by the rounding window, are the
 * consumers' calls.
 */
export function parseTrackPitSpeedLimit(raw: unknown): ParsedPitSpeedLimit | null {
  if (typeof raw !== "string") return null;

  const match = WITH_UNIT.exec(raw);

  if (match) {
    const unit = match[2]!.toLowerCase() === "mph" ? "mph" : "kmh";

    return fromDigits(match[1]!, unit);
  }

  const trimmed = raw.trim();

  if (BARE_NUMBER.test(trimmed)) return fromDigits(trimmed, "kmh");

  return null;
}

function fromDigits(digits: string, unit: ParsedPitSpeedLimit["unit"]): ParsedPitSpeedLimit | null {
  const value = parseFloat(digits);

  if (!Number.isFinite(value)) return null;

  return { value, unit, decimals: (digits.split(".")[1] ?? "").length };
}
