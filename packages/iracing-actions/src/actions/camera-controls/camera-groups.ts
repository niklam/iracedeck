/**
 * Shared camera-group selection logic (issue #803 rework).
 *
 * The keypad Cycle Camera preview and the dial camera-carousel strip both walk
 * the SAME enabled camera-group subset — this leaf module holds the pure
 * selection helpers so neither surface duplicates the other (and so the dial
 * surface can import them without a cycle back into `camera-controls.ts`, which
 * mounts `DialSettings` at module-eval time). It carries NO runtime imports
 * (only the `CameraGroup` type), so importing it pulls in no icon SVGs or
 * global-settings machinery — keeping the dial-surface test free of those mocks.
 *
 * `getEnabledGroupNames` (which reads the global settings cache) and the
 * icon→artwork resolution stay in `camera-controls.ts`; only the pure subset
 * math lives here.
 */
import type { CameraGroup, CameraInGroup } from "@iracedeck/iracing-sdk";

/**
 * @internal Exported for testing
 *
 * Per-action / global settings key for camera group subset selection.
 */
export const CAMERA_GROUPS_SETTING_KEY = "cameraGroupSubset";

/**
 * @internal Exported for testing
 *
 * All known iRacing camera group names. The last five (#958) exist only on some
 * content — TV Static and TV Mixed on most, TV4 / Spotter / Spectator on the oval
 * and dirt captures — so they are listed but never enabled by default.
 */
export const DEFAULT_CAMERA_GROUPS = [
  "Nose",
  "Gearbox",
  "Roll Bar",
  "LF Susp",
  "LR Susp",
  "Gyro",
  "RF Susp",
  "RR Susp",
  "Cockpit",
  "Scenic",
  "TV1",
  "TV2",
  "TV3",
  "Pit Lane",
  "Pit Lane 2",
  "Chopper",
  "Blimp",
  "Chase",
  "Far Chase",
  "Rear Chase",
  "TV Static",
  "TV Mixed",
  "TV4",
  "Spotter",
  "Spectator",
];

/**
 * @internal Exported for testing
 *
 * Default enabled camera groups (used when no per-action or legacy global setting is saved).
 */
export const DEFAULT_ENABLED_GROUPS = ["Nose", "Cockpit", "Chase", "TV1", "TV2", "TV3"];

/**
 * @internal Exported for testing
 *
 * Change Camera's stored value → group name. The numbers are this plugin's own
 * enumeration (the PI dropdown's values), never the sim's — the sim renumbers
 * its groups per content, so a press resolves the NAME against the session. New
 * groups only ever go on the end (#958): inserting one would repoint every saved
 * Change Camera key.
 */
export const CHANGE_CAMERA_GROUPS: Readonly<Record<number, string>> = {
  1: "Nose",
  2: "Gearbox",
  3: "Roll Bar",
  4: "LF Susp",
  5: "LR Susp",
  6: "Gyro",
  7: "RF Susp",
  8: "RR Susp",
  9: "Cockpit",
  10: "Blimp",
  11: "Chopper",
  12: "Chase",
  13: "Far Chase",
  14: "Rear Chase",
  15: "Pit Lane",
  16: "Pit Lane 2",
  17: "TV1",
  18: "TV2",
  19: "TV3",
  20: "Scenic",
  21: "TV Static",
  22: "TV Mixed",
  23: "TV4",
  24: "Spotter",
  25: "Spectator",
};

/**
 * Name variants the sim (or an older saved subset) spells differently from the
 * canonical names above. One capture reports `Pit Lane2` where every other one
 * says `Pit Lane 2` (#958). The PI keeps a copy for the subsets it saves.
 */
const LEGACY_NAMES: Record<string, string> = { "Pit Lane2": "Pit Lane 2" };

/**
 * @internal Exported for testing
 *
 * Canonical spelling of a camera group name — the ONE normalisation, applied to
 * saved subsets (`parseGroupSubset`), to the session's group list where it is
 * read (`normalizeSessionGroups`), and to a name looked up by a caller.
 */
export function normalizeGroupName(name: string): string {
  return LEGACY_NAMES[name] ?? name;
}

/**
 * @internal Exported for testing
 *
 * The session's camera groups with canonical names. Every reader of
 * `CameraInfo.Groups` goes through this once, so no consumer downstream — the
 * subset walk, the name lookup, an icon, a dial label — sees a variant spelling.
 */
export function normalizeSessionGroups(sessionGroups: CameraGroup[]): CameraGroup[] {
  return sessionGroups.map((g) => ({ ...g, groupName: normalizeGroupName(g.groupName) }));
}

/**
 * @internal Exported for testing
 *
 * The session's camera group carrying `name` (in any spelling). Undefined when
 * the session has no such group — the caller must then NOT fall back to a
 * plugin-side number, since the sim numbers its groups per content and ours
 * would pick an unrelated camera (#958). Expects `normalizeSessionGroups` output.
 */
export function findSessionGroupByName(sessionGroups: CameraGroup[], name: string): CameraGroup | undefined {
  const target = normalizeGroupName(name);

  return sessionGroups.find((g) => g.groupName === target);
}

/**
 * @internal Exported for testing
 *
 * The session's camera group numbered `groupNum` (the sim's own number, as
 * telemetry's `CamGroupNumber` reports it), or null when the session lists none.
 */
export function findSessionGroupByNum(sessionGroups: CameraGroup[], groupNum: number): CameraGroup | null {
  return sessionGroups.find((g) => g.groupNum === groupNum) ?? null;
}

/**
 * @internal Exported for testing
 *
 * Parse a camera group subset value (JSON string or object) into a list of enabled group names.
 * Returns undefined when the value is missing or unparseable, so the caller can distinguish
 * "no setting stored" from "all groups disabled".
 */
export function parseGroupSubset(raw: string | Record<string, unknown> | undefined): string[] | undefined {
  let subset: Record<string, unknown> | undefined;

  if (typeof raw === "string" && raw) {
    try {
      subset = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  } else if (typeof raw === "object" && raw !== null) {
    subset = raw as Record<string, unknown>;
  }

  // Only a plain name→boolean map is a valid subset — a malformed shape (e.g.
  // `groups: "Nose"`, whose Object.entries would yield numeric character keys)
  // must fall back like a missing setting, not read as "nothing enabled".
  const rawGroups = subset?.groups;

  if (typeof rawGroups !== "object" || rawGroups === null || Array.isArray(rawGroups)) {
    return undefined;
  }

  const groups = rawGroups as Record<string, unknown>;

  return Object.entries(groups)
    .filter(([, isEnabled]) => isEnabled === true)
    .map(([name]) => normalizeGroupName(name));
}

/**
 * @internal Exported for testing
 *
 * Find the next camera group in the selected subset.
 */
export function getNextSelectedGroup(
  currentGroupNum: number,
  enabledGroupNames: string[],
  sessionGroups: CameraGroup[],
  direction: 1 | -1,
): number | null {
  return getNextSelectedGroupEntry(currentGroupNum, enabledGroupNames, sessionGroups, direction)?.groupNum ?? null;
}

/**
 * @internal Exported for testing
 *
 * Find the next camera group entry in the selected subset.
 * Returns both groupNum and groupName, or null if no enabled groups exist.
 */
export function getNextSelectedGroupEntry(
  currentGroupNum: number,
  enabledGroupNames: string[],
  sessionGroups: CameraGroup[],
  direction: 1 | -1,
): CameraGroup | null {
  const enabled = sessionGroups
    .filter((g) => enabledGroupNames.includes(g.groupName))
    .sort((a, b) => a.groupNum - b.groupNum);

  if (enabled.length === 0) return null;

  const currentIndex = enabled.findIndex((g) => g.groupNum === currentGroupNum);

  if (currentIndex === -1) {
    if (direction === 1) {
      return enabled.find((g) => g.groupNum > currentGroupNum) ?? enabled[0];
    } else {
      return [...enabled].reverse().find((g) => g.groupNum < currentGroupNum) ?? enabled[enabled.length - 1];
    }
  }

  const nextIndex = (currentIndex + direction + enabled.length) % enabled.length;

  return enabled[nextIndex];
}

/**
 * The three camera groups the dial carousel shows: the group the camera is
 * currently on (may sit outside the enabled subset), plus the enabled-subset
 * ORDERING neighbours one cycle step back (`prev`) and forward (`next`).
 * Which physical turn lands on which neighbour is not fixed here — the
 * consumer maps them to strip sides via `clockwiseDirection` (#884).
 */
export interface CameraCarousel {
  current: CameraGroup | null;
  prev: CameraGroup | null;
  next: CameraGroup | null;
}

/**
 * @internal Exported for testing
 *
 * Build the dial camera carousel from the current camera group and the ENABLED
 * subset. `prev` / `next` are the enabled-subset neighbours (wrapping at the
 * ends) that one detent would switch to — computed from the same subset walk
 * (`getNextSelectedGroupEntry`) the dial rotation uses, so the preview and the
 * behaviour can never diverge. `current` is resolved straight from the session
 * groups so it renders even when the active group is not in the enabled subset.
 */
export function computeCameraCarousel(
  currentGroupNum: number | null,
  enabledGroupNames: string[],
  sessionGroups: CameraGroup[],
): CameraCarousel {
  const current = currentGroupNum !== null ? findSessionGroupByNum(sessionGroups, currentGroupNum) : null;
  const base = currentGroupNum ?? 0;

  return {
    current,
    prev: getNextSelectedGroupEntry(base, enabledGroupNames, sessionGroups, -1),
    next: getNextSelectedGroupEntry(base, enabledGroupNames, sessionGroups, 1),
  };
}

/**
 * The three sub-cameras the dial sub-camera carousel shows: the camera the group
 * is currently on plus the ORDERING neighbours one cycle step back (`prev`) and
 * forward (`next`) within the SAME group. Which physical turn lands on which
 * neighbour is not fixed here — the consumer maps them to strip sides via
 * `clockwiseDirection` (#884). `null` slots when there is no camera to show
 * for that position.
 */
export interface SubCameraCarousel {
  current: CameraInGroup | null;
  prev: CameraInGroup | null;
  next: CameraInGroup | null;
}

/**
 * @internal Exported for testing
 *
 * Build the dial sub-camera carousel from the current sub-camera number and the
 * group's camera list (session YAML `CameraInfo.Groups[].Cameras[]`, via
 * `getCamerasInGroup`). The cameras are ordered by ascending `cameraNum`; `prev`
 * / `next` are the neighbours either side, wrapping at the ends.
 *
 * It feeds the dial PREVIEW only. Since #852 the sub-camera step itself is
 * iRacing's own Next / Previous Sub Camera binding — the switch broadcasts never
 * select a sub-camera — so the sim, not this list, decides which camera a detent
 * lands on, and the side names are a guide to the group's cameras rather than a
 * promise of the next one.
 *
 * A single-camera group can't cycle, so `prev` / `next` are `null` (current
 * only). When the current camera number isn't found in the list (the Scenic
 * reality — a large multi-camera group whose active `CamCameraNumber` the
 * carousel can't anchor on, issue #803), `current` is `null` but `prev` / `next`
 * still name the list ends (next → first, previous → last), so the strip shows
 * real cameras of the group rather than nothing.
 */
export function computeSubCameraCarousel(currentCameraNum: number | null, cameras: CameraInGroup[]): SubCameraCarousel {
  if (cameras.length === 0) return { current: null, prev: null, next: null };

  const sorted = [...cameras].sort((a, b) => a.cameraNum - b.cameraNum);
  const idx = currentCameraNum === null ? -1 : sorted.findIndex((c) => c.cameraNum === currentCameraNum);

  // Current camera not located in the group's list — recover at the natural end
  // (next → first, previous → last) so the dispatch targets a real group camera
  // rather than a synthetic cameraNum ± 1 iRacing would reject (issue #803).
  if (idx < 0) return { current: null, prev: sorted[sorted.length - 1], next: sorted[0] };

  const current = sorted[idx];

  // A single located camera has no neighbour to cycle to.
  if (sorted.length === 1) return { current, prev: null, next: null };

  return {
    current,
    prev: sorted[(idx - 1 + sorted.length) % sorted.length],
    next: sorted[(idx + 1) % sorted.length],
  };
}
