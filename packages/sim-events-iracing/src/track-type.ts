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
