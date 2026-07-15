import {
  assembleIcon,
  CAR_SELECTOR_PROFILE,
  CommonSettings,
  ConnectionStateAwareAction,
  extractGraphicContent,
  generateTitleText,
  getCommands,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckTouchTapEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  onGlobalSettingsChange,
  parseSvgViewBox,
  renderIconTemplate,
  requestProfileSwitch,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveProfileNameForDevice,
  resolveTitleSettings,
  svgToDataUri,
} from "@iracedeck/deck-core";
// Cycle icons
import cameraNextSvg from "@iracedeck/icons/camera-cycle/camera-next.svg";
import cameraPreviousSvg from "@iracedeck/icons/camera-cycle/camera-previous.svg";
import carNextSvg from "@iracedeck/icons/camera-cycle/car-next.svg";
import carPreviousSvg from "@iracedeck/icons/camera-cycle/car-previous.svg";
import drivingNextSvg from "@iracedeck/icons/camera-cycle/driving-next.svg";
import drivingPreviousSvg from "@iracedeck/icons/camera-cycle/driving-previous.svg";
import subCameraNextSvg from "@iracedeck/icons/camera-cycle/sub-camera-next.svg";
import subCameraPreviousSvg from "@iracedeck/icons/camera-cycle/sub-camera-previous.svg";
// Focus icons
import focusOnIncidentSvg from "@iracedeck/icons/camera-focus/focus-on-incident.svg";
import focusOnLeaderSvg from "@iracedeck/icons/camera-focus/focus-on-leader.svg";
import focusOnMostExcitingSvg from "@iracedeck/icons/camera-focus/focus-on-most-exciting.svg";
import focusSelectCarSvg from "@iracedeck/icons/camera-focus/focus-select-car.svg";
import focusYourCarSvg from "@iracedeck/icons/camera-focus/focus-your-car.svg";
import setCameraStateSvg from "@iracedeck/icons/camera-focus/set-camera-state.svg";
import switchByCarNumberSvg from "@iracedeck/icons/camera-focus/switch-by-car-number.svg";
import switchByPositionSvg from "@iracedeck/icons/camera-focus/switch-by-position.svg";
// Camera select icons (per-group icons for cycle-camera preview)
import blimpSvg from "@iracedeck/icons/camera-select/blimp.svg";
import chaseSvg from "@iracedeck/icons/camera-select/chase.svg";
import chopperSvg from "@iracedeck/icons/camera-select/chopper.svg";
import cockpitSvg from "@iracedeck/icons/camera-select/cockpit.svg";
import farChaseSvg from "@iracedeck/icons/camera-select/far-chase.svg";
import gearboxSvg from "@iracedeck/icons/camera-select/gearbox.svg";
import gyroSvg from "@iracedeck/icons/camera-select/gyro.svg";
import lfSuspSvg from "@iracedeck/icons/camera-select/lf-susp.svg";
import lrSuspSvg from "@iracedeck/icons/camera-select/lr-susp.svg";
import noseSvg from "@iracedeck/icons/camera-select/nose.svg";
import pitLane2Svg from "@iracedeck/icons/camera-select/pit-lane-2.svg";
import pitLaneSvg from "@iracedeck/icons/camera-select/pit-lane.svg";
import rearChaseSvg from "@iracedeck/icons/camera-select/rear-chase.svg";
import rfSuspSvg from "@iracedeck/icons/camera-select/rf-susp.svg";
import rollBarSvg from "@iracedeck/icons/camera-select/roll-bar.svg";
import rrSuspSvg from "@iracedeck/icons/camera-select/rr-susp.svg";
import scenicSvg from "@iracedeck/icons/camera-select/scenic.svg";
import tv1Svg from "@iracedeck/icons/camera-select/tv1.svg";
import tv2Svg from "@iracedeck/icons/camera-select/tv2.svg";
import tv3Svg from "@iracedeck/icons/camera-select/tv3.svg";
import { getCameraGroupsFromSessionInfo, getCarNumberRawFromSessionInfo } from "@iracedeck/iracing-sdk";
import { getLiveRacePositions } from "@iracedeck/sim-events-iracing";
import z from "zod";

import { setSelectIntent } from "../../shared/car-select-intent.js";
import { profileEntriesEqual } from "../../shared/profile-entries.js";
import { availableProfilesForDevice, deviceProfileEntries } from "../race-admin/race-admin-selector.js";
import { CameraDialSurface, type CarouselGlyph, DialSettings } from "./camera-dial-surface.js";
import {
  CAMERA_GROUPS_SETTING_KEY,
  DEFAULT_ENABLED_GROUPS,
  getNextSelectedGroupEntry,
  parseGroupSubset,
} from "./camera-groups.js";
import { migrateFocusOnExitingToMostExciting } from "./migrate-focus-on-exiting.js";

// Re-exported from the shared leaf so existing importers (and tests) keep their
// `camera-controls.js` import path (issue #803 rework).
export {
  CAMERA_GROUPS_SETTING_KEY,
  DEFAULT_CAMERA_GROUPS,
  DEFAULT_ENABLED_GROUPS,
  getNextSelectedGroup,
  parseGroupSubset,
} from "./camera-groups.js";

// --- Target types ---

const CYCLE_TARGET_VALUES = ["cycle-camera", "cycle-sub-camera", "cycle-car", "cycle-driving"] as const;

const FOCUS_TARGET_VALUES = [
  "focus-your-car",
  "focus-on-leader",
  "focus-on-incident",
  "focus-on-most-exciting",
  "focus-select-car",
  "switch-by-position",
  "switch-by-car-number",
  "set-camera-state",
] as const;

const CHANGE_CAMERA_TARGET_VALUES = ["change-camera"] as const;

const TARGET_VALUES = [...CHANGE_CAMERA_TARGET_VALUES, ...CYCLE_TARGET_VALUES, ...FOCUS_TARGET_VALUES] as const;

type CycleTarget = (typeof CYCLE_TARGET_VALUES)[number];
type Target = (typeof TARGET_VALUES)[number];
type Direction = "next" | "previous";

function isCycleTarget(target: Target): target is CycleTarget {
  return (CYCLE_TARGET_VALUES as readonly string[]).includes(target);
}

// --- Settings schema ---

const CameraControlsSettings = CommonSettings.extend({
  target: z.enum(TARGET_VALUES).default("change-camera"),
  // Cycle-specific
  direction: z.enum(["next", "previous"]).default("next"),
  cameraGroupSubset: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  // Focus-specific
  position: z.coerce.number().int().min(1).default(1),
  carNumber: z.coerce.number().int().min(0).default(0),
  cameraState: z.coerce.number().int().min(0).default(0),
  // Change-camera-specific
  cameraGroup: z.coerce.number().int().min(1).max(20).default(9),
  // focus-select-car (#790): the profile the press switches to. May hold a
  // device-suffixed manifest name, a legacy name, or a name suffixed for
  // another device — resolved at press time.
  focusSelectorProfile: z.string().default(CAR_SELECTOR_PROFILE),
  /**
   * Runtime-populated list of profiles available for this button's device,
   * pushed for the PI dropdown as `{ name, label }` entries (#753 shape).
   * Not user-editable.
   */
  _deviceProfiles: z.array(z.union([z.string(), z.object({ name: z.string(), label: z.string() })])).optional(),
  // Dial-surface settings (#803), under the `dial` root so the two surfaces'
  // keys can't collide. catch: garbage inside the dial subtree (e.g. a value
  // written by a newer plugin version after a downgrade) degrades to dial
  // defaults instead of failing the whole parse — which would reset a KEYPAD
  // instance's mode via the full-defaults fallback in parseSettings.
  dial: DialSettings.catch(() => DialSettings.parse({})),
});

type CameraControlsSettings = z.infer<typeof CameraControlsSettings>;

// --- Icon maps ---

/**
 * @internal Exported for testing
 *
 * Cycle icon SVG lookup (target + direction → SVG)
 */
export const CYCLE_ICONS: Record<CycleTarget, Record<Direction, string>> = {
  "cycle-camera": { next: cameraNextSvg, previous: cameraPreviousSvg },
  "cycle-sub-camera": { next: subCameraNextSvg, previous: subCameraPreviousSvg },
  "cycle-car": { next: carNextSvg, previous: carPreviousSvg },
  "cycle-driving": { next: drivingNextSvg, previous: drivingPreviousSvg },
};

/**
 * @internal Exported for testing
 *
 * Cycle title configuration (target + direction → title string)
 */
export const CYCLE_TITLES: Record<CycleTarget, Record<Direction, string>> = {
  "cycle-camera": {
    next: "CAMERA\nNEXT",
    previous: "CAMERA\nPREV",
  },
  "cycle-sub-camera": {
    next: "SUB CAM\nNEXT",
    previous: "SUB CAM\nPREV",
  },
  "cycle-car": {
    next: "CAR\nNEXT",
    previous: "CAR\nPREV",
  },
  "cycle-driving": {
    next: "DRIVING\nNEXT",
    previous: "DRIVING\nPREV",
  },
};

/**
 * Camera group name → camera-select SVG icon for cycle-camera preview.
 * Shows the icon of the next camera group that will be activated.
 */
const CAMERA_SELECT_ICONS: Record<string, string> = {
  Nose: noseSvg,
  Gearbox: gearboxSvg,
  "Roll Bar": rollBarSvg,
  "LF Susp": lfSuspSvg,
  "LR Susp": lrSuspSvg,
  Gyro: gyroSvg,
  "RF Susp": rfSuspSvg,
  "RR Susp": rrSuspSvg,
  Cockpit: cockpitSvg,
  Scenic: scenicSvg,
  TV1: tv1Svg,
  TV2: tv2Svg,
  TV3: tv3Svg,
  "Pit Lane": pitLaneSvg,
  "Pit Lane 2": pitLane2Svg,
  Chopper: chopperSvg,
  Blimp: blimpSvg,
  Chase: chaseSvg,
  "Far Chase": farChaseSvg,
  "Rear Chase": rearChaseSvg,
};

/**
 * @internal Exported for testing
 *
 * Camera group number → name and icon SVG for change-camera target
 */
export const CAMERA_GROUP_MAP: Record<number, { name: string; icon: string }> = {
  1: { name: "Nose", icon: noseSvg },
  2: { name: "Gearbox", icon: gearboxSvg },
  3: { name: "Roll Bar", icon: rollBarSvg },
  4: { name: "LF Susp", icon: lfSuspSvg },
  5: { name: "LR Susp", icon: lrSuspSvg },
  6: { name: "Gyro", icon: gyroSvg },
  7: { name: "RF Susp", icon: rfSuspSvg },
  8: { name: "RR Susp", icon: rrSuspSvg },
  9: { name: "Cockpit", icon: cockpitSvg },
  10: { name: "Blimp", icon: blimpSvg },
  11: { name: "Chopper", icon: chopperSvg },
  12: { name: "Chase", icon: chaseSvg },
  13: { name: "Far Chase", icon: farChaseSvg },
  14: { name: "Rear Chase", icon: rearChaseSvg },
  15: { name: "Pit Lane", icon: pitLaneSvg },
  16: { name: "Pit Lane 2", icon: pitLane2Svg },
  17: { name: "TV1", icon: tv1Svg },
  18: { name: "TV2", icon: tv2Svg },
  19: { name: "TV3", icon: tv3Svg },
  20: { name: "Scenic", icon: scenicSvg },
};

const FOCUS_ICONS: Record<string, string> = {
  "focus-your-car": focusYourCarSvg,
  "focus-on-leader": focusOnLeaderSvg,
  "focus-on-incident": focusOnIncidentSvg,
  "focus-on-most-exciting": focusOnMostExcitingSvg,
  "focus-select-car": focusSelectCarSvg,
  "switch-by-position": switchByPositionSvg,
  "switch-by-car-number": switchByCarNumberSvg,
  "set-camera-state": setCameraStateSvg,
};

const FOCUS_TITLES: Record<string, string> = {
  "focus-your-car": "FOCUS\nYOUR CAR",
  "focus-on-leader": "FOCUS\nLEADER",
  "focus-on-incident": "FOCUS\nINCIDENT",
  "focus-on-most-exciting": "MOST\nEXCITING",
  "focus-select-car": "FOCUS\nPICK CAR",
  "switch-by-position": "SWITCH\nPOSITION",
  "switch-by-car-number": "SWITCH\nCAR #",
  "set-camera-state": "SET\nCAM STATE",
};

// --- Icon generation ---

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the camera controls action.
 */
export function generateCameraControlsSvg(
  settings: {
    target: Target;
    direction?: Direction;
    cameraGroup?: number;
    cameraGroupSubset?: string | Record<string, unknown>;
  } & Partial<CommonSettings>,
): string {
  const { target, direction = "next" } = settings;

  let iconSvg: string;
  let defaultTitle: string;

  if (isCycleTarget(target)) {
    if (target === "cycle-camera") {
      const enabledNames = getEnabledGroupNames(settings.cameraGroupSubset);

      return generateCycleCameraGridSvg(
        enabledNames,
        direction,
        settings.colorOverrides,
        settings.titleOverrides,
        settings.borderOverrides,
        settings.graphicOverrides,
      );
    }

    iconSvg = CYCLE_ICONS[target]?.[direction] || CYCLE_ICONS["cycle-camera"]["next"];
    defaultTitle = CYCLE_TITLES[target]?.[direction] || CYCLE_TITLES["cycle-camera"]["next"];
  } else if (target === "change-camera") {
    const group = CAMERA_GROUP_MAP[settings.cameraGroup ?? 9] ?? CAMERA_GROUP_MAP[9];
    iconSvg = group.icon;
    defaultTitle = `CAMERA\n${group.name.toUpperCase()}`;
  } else {
    iconSvg = FOCUS_ICONS[target] || FOCUS_ICONS["focus-your-car"];
    defaultTitle = FOCUS_TITLES[target] || FOCUS_TITLES["focus-your-car"];
  }

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
}

/**
 * Generate an SVG data URI for a specific camera group icon.
 * Used to show which camera group will be activated next.
 */
function generateCameraSelectSvg(
  groupName: string,
  colorOverrides?: Partial<CommonSettings>["colorOverrides"],
  titleOverrides?: Partial<CommonSettings>["titleOverrides"],
  borderOverrides?: Partial<CommonSettings>["borderOverrides"],
  graphicOverrides?: Partial<CommonSettings>["graphicOverrides"],
): string {
  const iconSvg = CAMERA_SELECT_ICONS[groupName];

  if (!iconSvg) return generateCameraControlsSvg({ target: "cycle-camera", direction: "next" });

  const colors = resolveIconColors(iconSvg, getGlobalColors(), colorOverrides);
  const title = resolveTitleSettings(
    iconSvg,
    getGlobalTitleSettings(),
    titleOverrides,
    `CAMERA\n${groupName.toUpperCase()}`,
  );
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), borderOverrides);
  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
}

/**
 * @internal Exported for testing
 *
 * Extract artwork elements from a camera-select SVG template.
 * Strips the outer SVG, desc, background rect, filter group wrapper, and label text.
 */
export function extractIconArtwork(svgTemplate: string): string {
  return svgTemplate
    .replace(/<svg[^>]*>/g, "")
    .replace(/<\/svg>\s*/g, "")
    .replace(/<desc>[\s\S]*?<\/desc>/g, "")
    .replace(/<rect x="0" y="0" width="144" height="144"[^/]*\/>/g, "")
    .replace(/<g filter="url\(#activity-state\)">/g, "")
    .replace(/<text[^>]*y="138"[^>]*>[\s\S]*?<\/text>/g, "")
    .replace(/<text[^>]*y="116"[^>]*>[\s\S]*?<\/text>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/g>\s*$/g, "")
    .trim();
}

/**
 * @internal Exported for testing
 */
export interface ThumbnailPosition {
  x: number;
  y: number;
  size: number;
}

/**
 * @internal Exported for testing
 *
 * Compute grid positions for thumbnail icons within the content area (y=18 to y=86).
 * Returns positions for up to 6 thumbnails (capped at 6 for counts above 6).
 */
export function computeGridPositions(count: number): ThumbnailPosition[] {
  if (count <= 0) return [];

  // 1 icon: full original size and position
  if (count === 1) {
    return [{ x: 0, y: 0, size: 144 }];
  }

  // 2 icons: 70% size, tight and lowered
  if (count === 2) {
    const size = 100;
    const gap = -30;
    const totalWidth = size * 2 + gap;
    const startX = Math.round((144 - totalWidth) / 2);
    const y = 16;

    return [
      { x: startX, y, size },
      { x: startX + size + gap, y, size },
    ];
  }

  // 3 icons: 60% size, 1 on top centered, 2 on bottom with -40 gap
  if (count === 3) {
    const size = 86;
    const topX = Math.round((144 - size) / 2);
    const topY = -2;
    const bottomGap = -15;
    const bottomTotalWidth = size * 2 + bottomGap;
    const bottomStartX = Math.round((144 - bottomTotalWidth) / 2);
    const bottomY = size - 35;

    return [
      { x: topX, y: topY, size },
      { x: bottomStartX, y: bottomY, size },
      { x: bottomStartX + size + bottomGap, y: bottomY, size },
    ];
  }

  // 4 icons: 60% size, 2x2 grid using same positions as 3-icon layout
  if (count === 4) {
    const size = 86;
    const gap = -15;
    const totalWidth = size * 2 + gap;
    const startX = Math.round((144 - totalWidth) / 2);
    const topY = -2;
    const bottomY = size - 35;

    return [
      { x: startX, y: topY, size },
      { x: startX + size + gap, y: topY, size },
      { x: startX, y: bottomY, size },
      { x: startX + size + gap, y: bottomY, size },
    ];
  }

  // 5 icons: 50% size, 2 on top, 3 on bottom
  if (count === 5) {
    const size = 72;
    const topGap = -15;
    const bottomGap = -25;
    const topY = 5;
    const bottomY = size - 20;

    const topTotalWidth = size * 2 + topGap;
    const topStartX = Math.round((144 - topTotalWidth) / 2);

    const bottomTotalWidth = size * 3 + bottomGap * 2;
    const bottomStartX = Math.round((144 - bottomTotalWidth) / 2);

    return [
      { x: topStartX, y: topY, size },
      { x: topStartX + size + topGap, y: topY, size },
      { x: bottomStartX, y: bottomY, size },
      { x: bottomStartX + size + bottomGap, y: bottomY, size },
      { x: bottomStartX + (size + bottomGap) * 2, y: bottomY, size },
    ];
  }

  // 6+ icons: 50% size, 3x2 grid, x from 5's bottom row, y from 5
  {
    const size = 72;
    const gap = -25;
    const topY = 5;
    const bottomY = size - 20;

    const totalWidth = size * 3 + gap * 2;
    const startX = Math.round((144 - totalWidth) / 2);

    return [
      { x: startX, y: topY, size },
      { x: startX + size + gap, y: topY, size },
      { x: startX + (size + gap) * 2, y: topY, size },
      { x: startX, y: bottomY, size },
      { x: startX + size + gap, y: bottomY, size },
      { x: startX + (size + gap) * 2, y: bottomY, size },
    ];
  }
}

/**
 * @internal Exported for testing
 *
 * Generate an SVG data URI showing a grid of miniaturized camera-select icons
 * for the selected camera groups. Used as the default icon for cycle-camera actions.
 */
export function generateCycleCameraGridSvg(
  enabledGroupNames: string[],
  direction: Direction,
  colorOverrides?: Record<string, string>,
  titleOverrides?: Partial<CommonSettings>["titleOverrides"],
  borderOverrides?: Partial<CommonSettings>["borderOverrides"],
  graphicOverrides?: Partial<CommonSettings>["graphicOverrides"],
): string {
  // Resolve which groups have icons
  const groupsWithIcons = enabledGroupNames.filter((name) => CAMERA_SELECT_ICONS[name]);

  // Fall back to static cycle icon if no groups have icons (direct render, no recursion)
  if (groupsWithIcons.length === 0) {
    const iconSvg = CYCLE_ICONS["cycle-camera"][direction];
    const titleText = CYCLE_TITLES["cycle-camera"][direction];
    const colors = resolveIconColors(iconSvg, getGlobalColors(), colorOverrides);
    const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), titleOverrides, titleText);
    const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), borderOverrides);
    const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), graphicOverrides);

    return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
  }

  const displayGroups = groupsWithIcons.slice(0, 6);
  const positions = computeGridPositions(displayGroups.length);

  // Resolve colors from the cycle-camera base icon
  const baseSvg = CYCLE_ICONS["cycle-camera"][direction];
  const colors = resolveIconColors(baseSvg, getGlobalColors(), colorOverrides);
  const bgColor = colors.backgroundColor || "#2a3a4a";
  const textColor = colors.textColor || "#ffffff";

  // Resolve the label through the shared title pipeline so the grid honors the
  // per-action Title Text override (and show/hide, bold, font size, position)
  // exactly like every other icon. Default label is "CYCLE CAM".
  const title = resolveTitleSettings(baseSvg, getGlobalTitleSettings(), titleOverrides, "CYCLE CAM");
  const label = title.showTitle
    ? generateTitleText({
        text: title.titleText,
        fontSize: title.fontSize,
        bold: title.bold,
        position: title.position,
        customPosition: title.customPosition,
        fill: textColor,
      })
    : "";

  // Build thumbnail SVGs
  let thumbnails = "";

  for (let i = 0; i < displayGroups.length; i++) {
    const groupName = displayGroups[i];
    const iconSvg = CAMERA_SELECT_ICONS[groupName];
    const artColors = resolveIconColors(iconSvg, getGlobalColors(), colorOverrides);
    const rawGraphic = extractGraphicContent(iconSvg);
    const artwork = renderIconTemplate(rawGraphic, artColors);
    const pos = positions[i];

    // Each thumbnail icon is now trimmed to its artwork extent — fit the longer
    // side into a fraction of pos.size (THUMB_FIT) so the artwork doesn't crowd
    // its grid cell. Pre-trim, icons were 144x144 with internal padding so the
    // visible artwork already took up only ~60-70% of pos.size; this constant
    // restores that breathing room.
    const THUMB_FIT = 0.6;
    const viewBox = parseSvgViewBox(iconSvg);
    const sourceW = viewBox?.width ?? 144;
    const sourceH = viewBox?.height ?? 144;
    const scale = (pos.size * THUMB_FIT) / Math.max(sourceW, sourceH);
    const offsetX = (pos.size - sourceW * scale) / 2;
    const offsetY = (pos.size - sourceH * scale) / 2;
    thumbnails += `<g transform="translate(${pos.x + offsetX}, ${pos.y + offsetY}) scale(${scale})">${artwork}</g>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><g><rect x="0" y="0" width="144" height="144" fill="${bgColor}"/>${thumbnails}${label}</g></svg>`;

  return svgToDataUri(svg);
}

// --- Camera group subset helpers ---

/**
 * @internal Exported for testing
 *
 * Get the list of enabled camera group names from per-action settings.
 * Falls back to the legacy global setting (for users upgrading from older versions),
 * then to DEFAULT_ENABLED_GROUPS.
 */
export function getEnabledGroupNames(raw: string | Record<string, unknown> | undefined): string[] {
  // Try per-action setting first
  const fromAction = parseGroupSubset(raw);

  if (fromAction !== undefined) return fromAction;

  // Fall back to legacy global setting (migration path for existing users)
  const globalSettings = getGlobalSettings() as Record<string, unknown>;
  const globalRaw = globalSettings[CAMERA_GROUPS_SETTING_KEY] as string | Record<string, unknown> | undefined;
  const fromGlobal = parseGroupSubset(globalRaw);

  if (fromGlobal !== undefined) return fromGlobal;

  return DEFAULT_ENABLED_GROUPS;
}

/**
 * Resolve a camera-group name to its dial-carousel glyph — the colour-resolved
 * inner artwork of the group's camera-select icon plus its source dimensions.
 * Returns null for an unmapped group name so the carousel can render name-only.
 * Shared with the keypad cycle-camera preview via `CAMERA_SELECT_ICONS`.
 */
function resolveGroupGlyph(groupName: string): CarouselGlyph | null {
  const iconSvg = CAMERA_SELECT_ICONS[groupName];

  if (!iconSvg) return null;

  const colors = resolveIconColors(iconSvg, {}, undefined);
  const artwork = renderIconTemplate(extractGraphicContent(iconSvg), colors);
  const viewBox = parseSvgViewBox(iconSvg);

  return { artwork, width: viewBox?.width ?? 144, height: viewBox?.height ?? 144 };
}

// --- Action ---

/**
 * Camera Controls
 * Cycles through cameras, sub-cameras, cars, and driving cameras,
 * and focuses on specific targets (your car, leader, incidents,
 * most exciting, positions, car numbers, camera state)
 * via iRacing SDK commands.
 */
export const CAMERA_FOCUS_UUID = "com.iracedeck.sd.core.camera-focus" as const;
export const CAMERA_CONTROLS_UUID = CAMERA_FOCUS_UUID;

export class CameraControls extends ConnectionStateAwareAction<CameraControlsSettings> {
  /** Settings per action context for telemetry-driven icon updates */
  private activeContexts = new Map<string, CameraControlsSettings>();

  /** Last displayed group name per context to avoid redundant re-renders */
  private lastDisplayedGroup = new Map<string, string>();

  /**
   * The dial half of the action (#803); all IDeck dial events route here.
   * Rotation reuses the keypad's own `executeCycle` / focus dispatch — the dial
   * duplicates no camera logic. No `setActiveBinding`/`tapBinding` is delegated:
   * every camera action is an SDK command, so there is no binding to configure.
   */
  private readonly dialSurface = new CameraDialSurface({
    logger: this.logger,
    getTelemetry: () => this.sdkController.getCurrentTelemetry(),
    getSessionInfo: () => this.sdkController.getSessionInfo(),
    // Canonical live race order (race-positions.md) — the dial's race-position
    // mode consumes it, official CarIdxPosition only as the fallback.
    getRacePositions: () => getLiveRacePositions(),
    // The camera-carousel preview walks the SAME global subset the dial rotation
    // honors: executeCycle("cycle-camera", …) passes no per-action subset, so
    // both resolve through getEnabledGroupNames(undefined) → the global setting.
    getEnabledCameraGroups: () => getEnabledGroupNames(undefined),
    getGroupGlyph: (groupName) => resolveGroupGlyph(groupName),
    cycle: (target, direction) => this.executeCycle(target, direction),
    focusCarNumber: (carNumberRaw) => this.focusCarNumber(carNumberRaw),
    focusMyCar: () => this.focusMyCar(),
    changeCamera: () => this.executeCycle("cycle-camera", "next"),
    focusOnLeader: () => this.focusOn("focus-on-leader"),
    focusOnIncident: () => this.focusOn("focus-on-incident"),
    focusOnMostExciting: () => this.focusOn("focus-on-most-exciting"),
  });

  /**
   * Keeps the dial strips' dash-box appearance (#811) live: telemetry ticks
   * only arrive while iRacing is connected, so without this a color override
   * saved with the sim closed would leave the strip stale until the next
   * connect. The subscription lives for the plugin's lifetime.
   */
  private readonly unsubscribeGlobalSettings = onGlobalSettingsChange(() => this.dialSurface.refreshAll());

  override async onWillAppear(ev: IDeckWillAppearEvent<CameraControlsSettings>): Promise<void> {
    await super.onWillAppear(ev);

    if (ev.action.isDial()) {
      const settings = this.parseSettings(ev.payload.settings);
      await this.dialSurface.willAppear(ev.action, settings.dial);
      this.sdkController.subscribe(ev.action.id, (telemetry) => {
        this.dialSurface.onTelemetry(ev.action.id, telemetry);
      });

      return;
    }

    await this.persistMigratedSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    await this.pushDeviceProfiles(ev, settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
      this.updateCycleIcon(ev.action.id);
    });

    // Seed cycle icon immediately if telemetry is already available
    this.updateCycleIcon(ev.action.id);
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<CameraControlsSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.dialSurface.willDisappear(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastDisplayedGroup.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<CameraControlsSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);

    if (ev.action.isDial()) {
      const settings = this.parseSettings(ev.payload.settings);
      await this.dialSurface.didReceiveSettings(ev.action, settings.dial);

      return;
    }

    await this.persistMigratedSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.lastDisplayedGroup.delete(ev.action.id);
    await this.pushDeviceProfiles(ev, settings);
    await this.updateDisplay(ev, settings);
    this.updateCycleIcon(ev.action.id);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<CameraControlsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.target === "focus-select-car") {
      await this.executeFocusSelectCar(ev, settings);

      return;
    }

    if (isCycleTarget(settings.target)) {
      this.executeCycle(settings.target, settings.direction, settings.cameraGroupSubset);
    } else if (settings.target === "change-camera") {
      this.executeChangeCamera(settings.cameraGroup);
    } else {
      this.executeFocus(settings);
    }
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<CameraControlsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.rotate(ev.action, settings.dial, ev.payload.ticks, ev.payload.pressed === true);
  }

  override async onDialDown(ev: IDeckDialDownEvent<CameraControlsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.down(ev.action, settings.dial);
  }

  override async onDialUp(ev: IDeckDialUpEvent<CameraControlsSettings>): Promise<void> {
    await this.dialSurface.up(ev.action.id);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<CameraControlsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.touchTap(ev.action, settings.dial, ev.payload.hold === true);
  }

  private parseSettings(settings: unknown): CameraControlsSettings {
    const { migrated } = migrateFocusOnExitingToMostExciting(settings);
    const parsed = CameraControlsSettings.safeParse(migrated);

    return parsed.success ? parsed.data : CameraControlsSettings.parse({});
  }

  /**
   * Detect a legacy `target: "focus-on-exiting"` setting and persist the
   * migrated shape (`target: "focus-on-most-exciting"`) so the legacy value
   * is permanently dropped. Logs and swallows persist failures — the runtime
   * always reads via `parseSettings`, so a failed persist doesn't block
   * functionality.
   */
  private async persistMigratedSettings(
    ev: IDeckWillAppearEvent<CameraControlsSettings> | IDeckDidReceiveSettingsEvent<CameraControlsSettings>,
  ): Promise<void> {
    const { migrated, changed } = migrateFocusOnExitingToMostExciting(ev.payload.settings);

    if (!changed) return;

    try {
      await ev.action.setSettings(migrated);
    } catch (err) {
      this.logger.warn(
        `Failed to persist migrated camera-controls settings: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private executeCycle(
    target: CycleTarget,
    direction: Direction,
    cameraGroupSubset?: string | Record<string, unknown>,
  ): void {
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("No telemetry available for camera cycle");

      return;
    }

    const camera = getCommands().camera;
    const carIdx = telemetry.CamCarIdx ?? 0;
    const groupNum = telemetry.CamGroupNumber ?? 1;
    const cameraNum = telemetry.CamCameraNumber ?? 1;
    const dir = direction === "next" ? 1 : -1;

    switch (target) {
      case "cycle-camera": {
        const sessionInfo = this.sdkController.getSessionInfo();
        const sessionGroups = sessionInfo ? getCameraGroupsFromSessionInfo(sessionInfo) : [];

        if (sessionGroups.length === 0) {
          const success = camera.cycleCamera(carIdx, groupNum, dir);
          this.logger.info("Camera group cycled (fallback)");
          this.logger.debug(`Result: ${success}, direction: ${direction}`);
          break;
        }

        const enabledNames = getEnabledGroupNames(cameraGroupSubset);
        const nextEntry = getNextSelectedGroupEntry(groupNum, enabledNames, sessionGroups, dir);

        if (nextEntry === null) {
          this.logger.warn("No enabled camera groups found in session");
          break;
        }

        // Use switchNum with car number to keep focus on the same car.
        // switchPos takes race position (not carIdx), so using it would
        // switch to whatever car is at that position.
        const carNumberRaw = getCarNumberRawFromSessionInfo(sessionInfo, carIdx);

        if (carNumberRaw !== null) {
          const success = camera.switchNum(carNumberRaw, nextEntry.groupNum, 0);
          this.logger.info("Camera group switched");
          this.logger.debug(`Result: ${success}, direction: ${direction}, targetGroup: ${nextEntry.groupNum}`);
        } else {
          // Fallback if car number lookup fails
          const success = camera.cycleCamera(carIdx, groupNum, dir);
          this.logger.info("Camera group cycled (car number fallback)");
          this.logger.debug(`Result: ${success}, direction: ${direction}`);
        }

        break;
      }
      case "cycle-sub-camera": {
        const success = camera.cycleSubCamera(carIdx, groupNum, cameraNum, dir);
        this.logger.info("Sub-camera cycled");
        this.logger.debug(`Result: ${success}, direction: ${direction}`);
        break;
      }
      case "cycle-car": {
        const success = camera.cycleCar(carIdx, dir);
        this.logger.info("Car cycled");
        this.logger.debug(`Result: ${success}, direction: ${direction}`);
        break;
      }
      case "cycle-driving": {
        const success = camera.cycleDrivingCamera(carIdx, groupNum, dir);
        this.logger.info("Driving camera cycled");
        this.logger.debug(`Result: ${success}, direction: ${direction}`);
        break;
      }
    }
  }

  /**
   * Center the camera on the player's own car — the Focus Your Car mode. Shared
   * by the keypad `focus-your-car` mode and the dial's Focus My Car press
   * gesture (#803) so both go through one SDK dispatch. Reads its own telemetry
   * so the dial can call it without a settings object.
   */
  private focusMyCar(): void {
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("No telemetry available for focus on your car");

      return;
    }

    const playerCarIdx = telemetry.PlayerCarIdx ?? 0;
    const sessionInfo = this.sdkController.getSessionInfo();
    const carNumberRaw = sessionInfo ? getCarNumberRawFromSessionInfo(sessionInfo, playerCarIdx) : null;

    if (carNumberRaw === null) {
      this.logger.warn("Cannot focus on your car: car number not found in session info");

      return;
    }

    const camera = getCommands().camera;
    const groupNum = telemetry.CamGroupNumber ?? 1;
    const cameraNum = telemetry.CamCameraNumber ?? 1;
    const success = camera.switchNum(carNumberRaw, groupNum, cameraNum);
    this.logger.info("Focus on your car executed");
    this.logger.debug(`Result: ${success}, carNumberRaw: ${carNumberRaw}`);
  }

  /**
   * Focus a car by its raw car number — the dial's car-number cycle target,
   * and also its race-position target (#803 rework review): race-position
   * resolves to a car number via the SAME canonical-first order the carousel
   * preview uses, rather than dispatching a bare position through `switchPos`
   * (which iRacing resolves against its own OFFICIAL position order — a
   * mismatch in tow/finish/freeze cases would otherwise focus a different car
   * than the one previewed). Reuses the keypad Switch by Car Number command
   * surface, reading the active camera group / sub-camera from telemetry so
   * the angle is preserved.
   */
  private focusCarNumber(carNumberRaw: number): void {
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("No telemetry available for camera focus by car number");

      return;
    }

    const camera = getCommands().camera;
    const groupNum = telemetry.CamGroupNumber ?? 1;
    const cameraNum = telemetry.CamCameraNumber ?? 1;
    const success = camera.switchNum(carNumberRaw, groupNum, cameraNum);
    this.logger.info("Camera dial focus by car number");
    this.logger.debug(`Result: ${success}, carNumberRaw: ${carNumberRaw}`);
  }

  /**
   * The parameterless focus one-shots (leader / incident / most-exciting) —
   * shared by the keypad focus modes and the dial's focus gestures (#803), each
   * reusing the same SDK camera command.
   */
  private focusOn(target: "focus-on-leader" | "focus-on-incident" | "focus-on-most-exciting"): void {
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("No telemetry available for camera focus");

      return;
    }

    const camera = getCommands().camera;
    const groupNum = telemetry.CamGroupNumber ?? 1;
    const cameraNum = telemetry.CamCameraNumber ?? 1;

    switch (target) {
      case "focus-on-leader": {
        const success = camera.focusOnLeader(groupNum, cameraNum);
        this.logger.info("Focus on leader executed");
        this.logger.debug(`Result: ${success}`);

        return;
      }
      case "focus-on-incident": {
        const success = camera.focusOnIncident(groupNum, cameraNum);
        this.logger.info("Focus on incident executed");
        this.logger.debug(`Result: ${success}`);

        return;
      }
      case "focus-on-most-exciting": {
        const success = camera.focusOnMostExciting(groupNum, cameraNum);
        this.logger.info("Focus on most exciting executed");
        this.logger.debug(`Result: ${success}`);

        return;
      }
    }
  }

  private executeFocus(settings: CameraControlsSettings): void {
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("No telemetry available for camera focus");

      return;
    }

    const camera = getCommands().camera;
    const groupNum = telemetry.CamGroupNumber ?? 1;
    const cameraNum = telemetry.CamCameraNumber ?? 1;

    switch (settings.target) {
      case "focus-your-car": {
        this.focusMyCar();

        break;
      }
      case "focus-on-leader":
      case "focus-on-incident":
      case "focus-on-most-exciting": {
        // Shared with the dial's focus gestures (#803) so both surfaces use one dispatch.
        this.focusOn(settings.target);
        break;
      }
      case "switch-by-position": {
        const success = camera.switchPos(settings.position, groupNum, cameraNum);
        this.logger.info("Switch by position executed");
        this.logger.debug(`Result: ${success}, position: ${settings.position}`);
        break;
      }
      case "switch-by-car-number": {
        const success = camera.switchNum(settings.carNumber, groupNum, cameraNum);
        this.logger.info("Switch by car number executed");
        this.logger.debug(`Result: ${success}, carNumber: ${settings.carNumber}`);
        break;
      }
      case "set-camera-state": {
        const success = camera.setState(settings.cameraState);
        this.logger.info("Set camera state executed");
        this.logger.debug(`Result: ${success}, state: ${settings.cameraState}`);
        break;
      }
    }
  }

  /**
   * focus-select-car press (#790): arm the per-device focus intent and open
   * the Car Selector profile — each car press there focuses the camera and
   * stays on the grid; the grid's Back key returns here. The intent is only
   * set when a selector profile actually resolves for this device, so a
   * device without bundled profiles never carries a dangling intent.
   */
  private async executeFocusSelectCar(
    ev: IDeckKeyDownEvent<CameraControlsSettings>,
    settings: CameraControlsSettings,
  ): Promise<void> {
    const stored = settings.focusSelectorProfile.trim() || CAR_SELECTOR_PROFILE;
    const available = availableProfilesForDevice(ev.action.deviceType);
    const profile =
      resolveProfileNameForDevice(stored, ev.action.deviceType, available) ??
      resolveProfileNameForDevice(CAR_SELECTOR_PROFILE, ev.action.deviceType, available);

    if (!profile) {
      this.logger.warn(
        `No car-selector profile available for device ${ev.action.deviceId ?? "(unknown)"}; ignoring press`,
      );

      return;
    }

    setSelectIntent(ev.action.deviceId, { action: "focus-camera" });
    this.logger.info("Focus car selector opened");
    this.logger.debug(`Switching device ${ev.action.deviceId ?? "(unknown)"} to profile "${profile}"`);
    // Page 0: named switches always open a profile on its first page (#754).
    await requestProfileSwitch(ev.action.deviceId, profile, 0);
  }

  /**
   * Push the device-filtered profile list for the focus-select-car PI dropdown
   * (guarded against the setSettings→onDidReceiveSettings echo loop by only
   * writing on change — the Switch Profile pattern).
   */
  private async pushDeviceProfiles(
    ev: IDeckWillAppearEvent<CameraControlsSettings> | IDeckDidReceiveSettingsEvent<CameraControlsSettings>,
    settings: CameraControlsSettings,
  ): Promise<void> {
    if (settings.target !== "focus-select-car") return;

    const entries = deviceProfileEntries(ev.action.deviceType);
    const raw = (ev.payload.settings ?? {}) as Record<string, unknown>;
    const current = Array.isArray(raw._deviceProfiles) ? (raw._deviceProfiles as unknown[]) : [];

    if (profileEntriesEqual(current, entries)) return;

    try {
      await ev.action.setSettings({ ...raw, _deviceProfiles: entries });
    } catch (err) {
      this.logger.warn(`Failed to push device profiles: ${err instanceof Error ? err.message : err}`);
    }
  }

  private executeChangeCamera(cameraGroup: number): void {
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("No telemetry available for change camera");

      return;
    }

    const camera = getCommands().camera;
    const carIdx = telemetry.CamCarIdx ?? 0;
    const sessionInfo = this.sdkController.getSessionInfo();
    const sessionGroups = sessionInfo ? getCameraGroupsFromSessionInfo(sessionInfo) : [];

    // Resolve the actual group number from session info (camera group numbers can vary by track)
    const targetName = CAMERA_GROUP_MAP[cameraGroup]?.name;
    const resolvedGroup = targetName
      ? (sessionGroups.find((g) => g.groupName === targetName)?.groupNum ?? cameraGroup)
      : cameraGroup;

    const carNumberRaw = sessionInfo ? getCarNumberRawFromSessionInfo(sessionInfo, carIdx) : null;

    if (carNumberRaw !== null) {
      const success = camera.switchNum(carNumberRaw, resolvedGroup, 0);
      this.logger.info("Camera changed");
      this.logger.debug(`Result: ${success}, cameraGroup: ${resolvedGroup} (${targetName ?? cameraGroup})`);
    } else {
      this.logger.warn("Cannot change camera: car number not found in session info");
    }
  }

  /**
   * Update the icon for cycle-camera contexts based on current telemetry.
   * Shows the icon of the next camera group that will be activated.
   */
  private async updateCycleIcon(contextId: string): Promise<void> {
    const settings = this.activeContexts.get(contextId);

    if (!settings || settings.target !== "cycle-camera") return;

    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      // Connection lost — restore grid icon if we were showing a telemetry-driven icon
      if (this.lastDisplayedGroup.has(contextId)) {
        this.lastDisplayedGroup.delete(contextId);
        const svgDataUri = generateCycleCameraGridSvg(
          getEnabledGroupNames(settings.cameraGroupSubset),
          settings.direction,
          settings.colorOverrides,
          settings.titleOverrides,
          settings.borderOverrides,
          settings.graphicOverrides,
        );
        await this.updateKeyImage(contextId, svgDataUri);
        this.setRegenerateCallback(contextId, () =>
          generateCycleCameraGridSvg(
            getEnabledGroupNames(settings.cameraGroupSubset),
            settings.direction,
            settings.colorOverrides,
            settings.titleOverrides,
            settings.borderOverrides,
            settings.graphicOverrides,
          ),
        );
      }

      return;
    }

    const sessionInfo = this.sdkController.getSessionInfo();
    const sessionGroups = sessionInfo ? getCameraGroupsFromSessionInfo(sessionInfo) : [];

    if (sessionGroups.length === 0) return;

    const groupNum = telemetry.CamGroupNumber ?? 1;
    const dir = settings.direction === "next" ? 1 : -1;
    const enabledNames = getEnabledGroupNames(settings.cameraGroupSubset);
    const nextEntry = getNextSelectedGroupEntry(groupNum, enabledNames, sessionGroups, dir);

    if (!nextEntry) return;

    // Skip re-render if the next group hasn't changed
    if (this.lastDisplayedGroup.get(contextId) === nextEntry.groupName) return;

    this.lastDisplayedGroup.set(contextId, nextEntry.groupName);
    const svgDataUri = generateCameraSelectSvg(
      nextEntry.groupName,
      settings.colorOverrides,
      settings.titleOverrides,
      settings.borderOverrides,
      settings.graphicOverrides,
    );
    await this.updateKeyImage(contextId, svgDataUri);
    this.setRegenerateCallback(contextId, () =>
      generateCameraSelectSvg(
        nextEntry.groupName,
        settings.colorOverrides,
        settings.titleOverrides,
        settings.borderOverrides,
        settings.graphicOverrides,
      ),
    );
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<CameraControlsSettings> | IDeckDidReceiveSettingsEvent<CameraControlsSettings>,
    settings: CameraControlsSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateCameraControlsSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateCameraControlsSvg(settings));
  }
}

// Backward-compatible alias
export { CameraControls as CameraFocus };
