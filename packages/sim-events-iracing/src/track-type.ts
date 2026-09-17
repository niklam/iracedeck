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

/**
 * `WeekendInfo.Category` values that settle the oval question outright, in
 * BOTH directions. Lower-cased with whitespace stripped, so `"Dirt Oval"` and
 * `"DirtOval"` are the same answer.
 */
const OVAL_CATEGORIES = new Set(["oval", "dirtoval"]);
const NON_OVAL_CATEGORIES = new Set(["road", "dirtroad"]);

/**
 * Whether the session runs on an oval — the only discipline whose caution
 * restart lines are named inside and outside (issue #1127; the spec gates that
 * wording on it, and takes pace line 0 to be the inside on the grounds that no
 * right-handed oval is known).
 *
 * `Category` is the primary test because it is an ENUMERATION and therefore
 * answers both ways: a value it recognizes is final, and the substring fallback
 * below never runs. `TrackType` is a fallback rather than the rule because a
 * substring can be wrong in both directions — `"superspeedway"` never says
 * oval, and `"roval"` contains it while being a road course. An unrecognized
 * `Category` falls through rather than reading false, so a value iRacing adds
 * later degrades to the substring instead of silently turning every oval into a
 * road course.
 *
 * Measured once, at one track, on one discipline: Homestead-Miami reported
 * `Category: "Oval"` with `TrackType: "medium oval"` (2026-09-17, see the #1127
 * spec). Every other value here comes from iRacing's own vocabulary rather than
 * from a capture, which is why both signals are kept: the claim that either one
 * alone suffices is not something this repo has measured. Getting it wrong
 * costs a side name, not a car — everything else in the caution lineup is
 * discipline-agnostic.
 */
export function isOvalTrack(sessionInfo: Record<string, unknown> | null): boolean {
  const weekendInfo = sessionInfo?.WeekendInfo as Record<string, unknown> | undefined;
  const category = weekendInfo?.Category;

  if (typeof category === "string") {
    const normalized = category.trim().toLowerCase().replace(/\s+/g, "");

    if (OVAL_CATEGORIES.has(normalized)) return true;

    if (NON_OVAL_CATEGORIES.has(normalized)) return false;
  }

  const trackType = weekendInfo?.TrackType;

  if (typeof trackType !== "string") return false;

  const normalized = trackType.toLowerCase();

  return normalized.includes("oval") || normalized.includes("speedway");
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
