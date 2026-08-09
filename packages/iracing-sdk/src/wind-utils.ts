/**
 * Pure wind-math primitives (issue #947): wind direction relative to the car,
 * compass naming, and speed-unit conversion. Stateless — callers pass raw
 * telemetry values in, formatting and rendering live in the consumer.
 *
 * ## iRacing's wind conventions (verified in-sim, 2026-08-09)
 *
 * These were established from static-weather captures rather than inferred
 * from the SDK docs, which only say "Wind direction at start/finish line".
 * Getting any of them wrong produces a display that looks entirely plausible
 * while being backwards, so they are encoded here once and nowhere else:
 *
 * - `WindDir` is a **clockwise compass bearing (rad) of the direction the wind
 *   blows FROM** — the meteorological convention. N = 0, E = π/2, S = π,
 *   W = 3π/2. Verified: wind set to N read exactly `0`, wind set to E read
 *   exactly `1.570796`. It is referenced to true north, NOT to the track, so
 *   `TrackNorthOffset` must never be applied to it.
 * - `YawNorth` is a **clockwise compass bearing (rad) of the car's heading** —
 *   the same rotational sense as `WindDir`, which is what makes subtracting
 *   the two meaningful. Verified: a 90° left turn moved it 51.23° → 320.37°.
 * - `Yaw` is counterclockwise-positive and TRACK-referenced
 *   (`YawNorth = TrackNorthOffset - Yaw`). It must NOT be substituted for
 *   `YawNorth` here: doing so mirrors crosswinds left/right while leaving
 *   head/tail readings correct, so the bug survives casual testing.
 * - `WindVel` is m/s.
 */

/** Wind speed units offered to the user. `ms` is iRacing's native unit. */
export type WindSpeedUnit = "ms" | "kmh" | "mph";

/** Metres per second → kilometres per hour. */
const MPS_TO_KMH = 3.6;

/** Metres per second → miles per hour. */
const MPS_TO_MPH = 2.23694;

/** Display suffix per unit. */
const WIND_SPEED_UNIT_LABELS: Record<WindSpeedUnit, string> = {
  ms: "m/s",
  kmh: "km/h",
  mph: "mph",
};

const RAD_TO_DEG = 180 / Math.PI;

/**
 * The 16-point compass, indexed clockwise from north. Index maps to a bearing
 * of `index * 22.5` degrees.
 */
export const COMPASS_POINTS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
] as const;

export type CompassPoint = (typeof COMPASS_POINTS)[number];

/** Normalizes any degree value into `[0, 360)`. */
export function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** Normalizes any degree value into `(-180, 180]`. */
export function normalizeSignedDegrees(degrees: number): number {
  const wrapped = normalizeDegrees(degrees);

  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/** True when a telemetry angle/speed is usable (present and finite). */
function isUsable(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The direction the wind PUSHES the car, as a signed angle in degrees relative
 * to the car's nose — the quantity a driver-facing arrow should point at.
 *
 * - `0` — the wind pushes the car forward (tailwind)
 * - `±180` — the wind pushes the car backward (headwind)
 * - `+90` — the wind pushes the car to its right (blowing in from the left)
 * - `-90` — the wind pushes the car to its left (blowing in from the right)
 *
 * Derived by taking the wind SOURCE bearing relative to the nose
 * (`windDir - yawNorth`, valid because both are clockwise bearings) and
 * rotating it by 180° to convert "where it comes from" into "where it pushes".
 *
 * Returns `null` when either input is missing or non-finite — the caller
 * renders a blank rather than a misleading zero.
 *
 * @param windDirRad `telemetry.WindDir` — clockwise bearing the wind blows from
 * @param yawNorthRad `telemetry.YawNorth` — clockwise bearing of the car's heading
 */
export function relativeWindAngleDeg(windDirRad: number | undefined, yawNorthRad: number | undefined): number | null {
  if (!isUsable(windDirRad) || !isUsable(yawNorthRad)) return null;

  const sourceRelativeDeg = (windDirRad - yawNorthRad) * RAD_TO_DEG;

  return normalizeSignedDegrees(sourceRelativeDeg + 180);
}

/**
 * The absolute (world) bearing in degrees the wind blows FROM — i.e.
 * `WindDir` converted to degrees and normalized. This is the value the
 * compass name describes, matching how iRacing itself labels wind ("N" for a
 * wind out of the north).
 *
 * Returns `null` when the input is missing or non-finite.
 */
export function absoluteWindBearingDeg(windDirRad: number | undefined): number | null {
  if (!isUsable(windDirRad)) return null;

  return normalizeDegrees(windDirRad * RAD_TO_DEG);
}

/**
 * The 16-point compass name for a bearing in degrees ("N", "ESE", …).
 * Returns `null` for a missing or non-finite bearing.
 */
export function compassPoint(bearingDeg: number | null): CompassPoint | null {
  if (bearingDeg === null || !Number.isFinite(bearingDeg)) return null;

  const index = Math.round(normalizeDegrees(bearingDeg) / 22.5) % COMPASS_POINTS.length;

  return COMPASS_POINTS[index] ?? null;
}

/**
 * Converts a wind speed from iRacing's native m/s into the requested unit.
 * Returns `null` when the input is missing or non-finite.
 */
export function convertWindSpeed(windVelMps: number | undefined, unit: WindSpeedUnit): number | null {
  if (!isUsable(windVelMps)) return null;

  if (unit === "kmh") return windVelMps * MPS_TO_KMH;

  if (unit === "mph") return windVelMps * MPS_TO_MPH;

  return windVelMps;
}

/** The display suffix for a wind speed unit ("m/s", "km/h", "mph"). */
export function windSpeedUnitLabel(unit: WindSpeedUnit): string {
  return WIND_SPEED_UNIT_LABELS[unit];
}

/**
 * A wind speed formatted for display with its suffix (e.g. `"11 km/h"`).
 *
 * m/s always keeps one decimal: it is the finest-grained of the three units,
 * so whole-number rounding would collapse a light breeze to `"0 m/s"` and lose
 * the distinction between a calm and a gusty session. km/h and mph are coarse
 * enough that a decimal adds width without adding information, so they round
 * to whole units.
 *
 * Returns `null` when the speed is unavailable, so the caller can blank the
 * key rather than print a placeholder number.
 */
export function formatWindSpeed(windVelMps: number | undefined, unit: WindSpeedUnit): string | null {
  const converted = convertWindSpeed(windVelMps, unit);

  if (converted === null) return null;

  const rounded = unit === "ms" ? converted.toFixed(1) : String(Math.round(converted));

  return `${rounded} ${windSpeedUnitLabel(unit)}`;
}
