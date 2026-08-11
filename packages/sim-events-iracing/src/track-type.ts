/**
 * Track-type classification.
 *
 * iRacing reports the track discipline as a `WeekendInfo.TrackType` YAML string.
 * `resolveTrackType` normalizes that string onto a small, sim-agnostic enum so
 * the translator's diff logic can branch behaviour per discipline (e.g. the
 * dirt-oval pit-entry path in `diff/pit-lane.ts`).
 *
 * The enum lives here (local to the iRacing adapter) rather than on the bus
 * because it rides in no event payload and has a single consumer today; a
 * future refactor extracts a shared sim-agnostic domain-types home and promotes
 * it there. Add members (asphalt oval, dirt road, …) as we encounter them.
 */

/** Canonical track discipline. Unrecognized track types map to `Unknown`. */
export enum TrackType {
  Unknown = "unknown",
  RoadCourse = "road-course",
  DirtOval = "dirt-oval",
}

/**
 * Resolve `WeekendInfo.TrackType` to a {@link TrackType}.
 *
 * Case-insensitive string map; null/missing session info or any unrecognized
 * value yields {@link TrackType.Unknown} (which uses the default approach-zone
 * pit-entry behaviour).
 *
 * @internal Exported for testing.
 */
export function resolveTrackType(sessionInfo: Record<string, unknown> | null): TrackType {
  if (!sessionInfo) return TrackType.Unknown;

  const weekendInfo = sessionInfo.WeekendInfo as Record<string, unknown> | undefined;
  const raw = weekendInfo?.TrackType;

  if (typeof raw !== "string") return TrackType.Unknown;

  switch (raw.trim().toLowerCase()) {
    case "road course":
      return TrackType.RoadCourse;
    case "dirt oval":
      return TrackType.DirtOval;
    default:
      return TrackType.Unknown;
  }
}

/**
 * Whether the session runs on a dirt surface (`WeekendInfo.TrackType`
 * contains "dirt"). Drives the discipline-dependent `collision-car`
 * incident value (Sporting Code §3.5.1: heavy car contact scores 2x on
 * dirt, 4x on pavement — issue #938). Null/missing/unrecognized session
 * info reads as pavement.
 */
export function isDirtTrack(sessionInfo: Record<string, unknown> | null): boolean {
  if (!sessionInfo) return false;

  const weekendInfo = sessionInfo.WeekendInfo as Record<string, unknown> | undefined;
  const raw = weekendInfo?.TrackType;

  return typeof raw === "string" && raw.toLowerCase().includes("dirt");
}

/** Track rotation direction. Unknown/neutral tracks (road courses) map to `Neutral`. */
export enum TrackDirection {
  Neutral = "neutral",
  Left = "left",
  Right = "right",
}

/**
 * Resolve `WeekendInfo.TrackDirection` to a {@link TrackDirection}. Drives the
 * spotter's road (left/right) vs oval (inside/outside) terminology (issue #651):
 * a left-going oval makes the left side "inside"; a right-going oval reverses it;
 * neutral/unknown stays left/right.
 *
 * @internal Exported for testing.
 */
export function resolveTrackDirection(sessionInfo: Record<string, unknown> | null): TrackDirection {
  if (!sessionInfo) return TrackDirection.Neutral;

  const weekendInfo = sessionInfo.WeekendInfo as Record<string, unknown> | undefined;
  const raw = weekendInfo?.TrackDirection;

  if (typeof raw !== "string") return TrackDirection.Neutral;

  switch (raw.trim().toLowerCase()) {
    case "left":
      return TrackDirection.Left;
    case "right":
      return TrackDirection.Right;
    default:
      return TrackDirection.Neutral;
  }
}
