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
 * All known iRacing camera group names.
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

  if (!subset?.groups) {
    return undefined;
  }

  const groups = subset.groups as Record<string, boolean>;

  // Normalize legacy name variants to canonical names
  const LEGACY_NAMES: Record<string, string> = { "Pit Lane2": "Pit Lane 2" };

  return Object.entries(groups)
    .filter(([, isEnabled]) => isEnabled)
    .map(([name]) => LEGACY_NAMES[name] ?? name);
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
 * neighbours one detent counter-clockwise (`prev`) and clockwise (`next`) —
 * exactly what a single turn would switch to.
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
  const current = currentGroupNum !== null ? (sessionGroups.find((g) => g.groupNum === currentGroupNum) ?? null) : null;
  const base = currentGroupNum ?? 0;

  return {
    current,
    prev: getNextSelectedGroupEntry(base, enabledGroupNames, sessionGroups, -1),
    next: getNextSelectedGroupEntry(base, enabledGroupNames, sessionGroups, 1),
  };
}

/**
 * The three sub-cameras the dial sub-camera carousel shows: the camera the group
 * is currently on plus the cameras one detent counter-clockwise (`prev`) and
 * clockwise (`next`) within the SAME group — exactly what one turn would switch
 * to. `null` slots when there is no camera to show for that position.
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
 * / `next` are the neighbours one detent away, wrapping at the ends. This is the
 * SINGLE source both the dial preview and the keypad/dial sub-camera dispatch
 * step through — the dispatch focuses `next.cameraNum` / `prev.cameraNum`, so
 * the previewed camera and the switched-to camera can never diverge (mirrors how
 * `computeCameraCarousel` + `getNextSelectedGroupEntry` back the camera mode).
 *
 * A single-camera group can't cycle, so `prev` / `next` are `null` (current
 * only). When the current camera number isn't found in the list, `current` is
 * `null` (the caller renders its identity fallback and the dispatch falls back
 * to the raw ± 1 wrap iRacing resolves internally).
 */
export function computeSubCameraCarousel(currentCameraNum: number | null, cameras: CameraInGroup[]): SubCameraCarousel {
  if (cameras.length === 0) return { current: null, prev: null, next: null };

  const sorted = [...cameras].sort((a, b) => a.cameraNum - b.cameraNum);
  const idx = currentCameraNum === null ? -1 : sorted.findIndex((c) => c.cameraNum === currentCameraNum);
  const current = idx >= 0 ? sorted[idx] : null;

  // A single camera (or an unresolved current camera) has no meaningful
  // neighbours — show the current only.
  if (sorted.length === 1 || idx < 0) return { current, prev: null, next: null };

  return {
    current,
    prev: sorted[(idx - 1 + sorted.length) % sorted.length],
    next: sorted[(idx + 1) % sorted.length],
  };
}
