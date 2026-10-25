import {
  assembleIcon,
  CAR_SELECTOR_PROFILE,
  CommonSettings,
  extractGraphicContent,
  generateTitleText,
  getGlobalBorderSettings,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckTouchTapEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
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
import { getCommands, SimIRacingAction } from "@iracedeck/deck-iracing";
// Cycle icons
import cameraNextSvg from "@iracedeck/icons/camera-cycle/camera-next.svg";
import cameraPreviousSvg from "@iracedeck/icons/camera-cycle/camera-previous.svg";
import carNextSvg from "@iracedeck/icons/camera-cycle/car-next.svg";
import carPreviousSvg from "@iracedeck/icons/camera-cycle/car-previous.svg";
import drivingNextSvg from "@iracedeck/icons/camera-cycle/driving-next.svg";
import drivingPreviousSvg from "@iracedeck/icons/camera-cycle/driving-previous.svg";
import subCameraNextSvg from "@iracedeck/icons/camera-cycle/sub-camera-next.svg";
import subCameraPreviousSvg from "@iracedeck/icons/camera-cycle/sub-camera-previous.svg";
import trackPositionAheadSvg from "@iracedeck/icons/camera-cycle/track-position-ahead.svg";
import trackPositionBehindSvg from "@iracedeck/icons/camera-cycle/track-position-behind.svg";
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
import spectatorSvg from "@iracedeck/icons/camera-select/spectator.svg";
import spotterSvg from "@iracedeck/icons/camera-select/spotter.svg";
import tv1Svg from "@iracedeck/icons/camera-select/tv1.svg";
import tv2Svg from "@iracedeck/icons/camera-select/tv2.svg";
import tv3Svg from "@iracedeck/icons/camera-select/tv3.svg";
import tv4Svg from "@iracedeck/icons/camera-select/tv4.svg";
import tvMixedSvg from "@iracedeck/icons/camera-select/tv-mixed.svg";
import tvStaticSvg from "@iracedeck/icons/camera-select/tv-static.svg";
import {
  getAllCarNumbers,
  getCameraGroupsFromSessionInfo,
  getCarNumberRawByCarNumber,
  getCarNumberRawFromSessionInfo,
} from "@iracedeck/iracing-sdk";
import { requestCameraSwitch } from "@iracedeck/replay-engine";
import { getGlobalColors, getGlobalSettings, onGlobalSettingsChange } from "@iracedeck/settings";
import { getLiveRacePositions } from "@iracedeck/sim-events-iracing";
import z from "zod";

import { carCycleBindingKey } from "../../shared/car-cycle-bindings.js";
import { computeCarNumberTarget } from "../../shared/car-cycling.js";
import { setSelectIntent } from "../../shared/car-select-intent.js";
import { profileEntriesEqual } from "../../shared/profile-entries.js";
import { availableProfilesForDevice, deviceProfileEntries } from "../race-admin/race-admin-selector.js";
import { CameraDialSurface, type CarouselGlyph, DialSettings } from "./camera-dial-surface.js";
import {
  CAMERA_GROUPS_SETTING_KEY,
  CHANGE_CAMERA_GROUPS,
  DEFAULT_ENABLED_GROUPS,
  findSessionGroupByName,
  findSessionGroupByNum,
  getNextSelectedGroupEntry,
  normalizeGroupName,
  normalizeSessionGroups,
  parseGroupSubset,
} from "./camera-groups.js";
import { migrateFocusOnExitingToMostExciting } from "./migrate-focus-on-exiting.js";
import { subCameraBindingKey } from "./sub-camera-bindings.js";
import { type SwitchTargetSettings, switchTargetTemplateValues } from "./switch-target-value.js";

// Re-exported from the shared leaf so existing importers (and tests) keep their
// `camera-controls.js` import path (issue #803 rework).
export {
  CAMERA_GROUPS_SETTING_KEY,
  DEFAULT_CAMERA_GROUPS,
  DEFAULT_ENABLED_GROUPS,
  getNextSelectedGroup,
  parseGroupSubset,
} from "./camera-groups.js";

// Re-exported so consumers (and tests) can reach the keys through the action,
// while `sub-camera-bindings.ts` stays their single definition (issue #852).
export { SUB_CAMERA_BINDING_KEYS } from "./sub-camera-bindings.js";

// --- Target types ---

const CYCLE_TARGET_VALUES = [
  "cycle-camera",
  "cycle-sub-camera",
  "cycle-car",
  "cycle-track-order",
  "cycle-driving",
] as const;

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
type FocusOnTarget = "focus-on-leader" | "focus-on-incident" | "focus-on-most-exciting";

/** Who asked for a camera switch (#1428 / #1435): the key or dial context, and how the waiter's log names it. */
interface CameraSwitchAsk {
  readonly contextId: string;
  readonly surface: "the key" | "the dial";
  readonly asked: string;
}

/** What a camera switch is, for the waiter: its walk-interrupt name, its log name, and whether it changes the car. */
interface CameraSwitchWhat {
  /** The mode the switch interrupts a lap walk under, after `camera-controls `. */
  readonly by: string;
  readonly name: string;
  /** False for a switch of the camera's angle only, which leaves a lap walk alone. */
  readonly changesCar: boolean;
}

/** What a telemetry-driven cycle step's switch is called in the waiter's log, after its direction. */
const CYCLE_SWITCH_NAMES: Record<Exclude<CycleTarget, "cycle-sub-camera" | "cycle-track-order">, string> = {
  "cycle-camera": "camera group",
  "cycle-car": "car number",
  "cycle-driving": "driving camera",
};

/** What a focus one-shot's switch is called in the waiter's log. */
const FOCUS_ON_SWITCH_NAMES: Record<FocusOnTarget, string> = {
  "focus-on-leader": "leader",
  "focus-on-incident": "incident",
  "focus-on-most-exciting": "most exciting car",
};

/**
 * The binding key a keypad button depends on, or `null` for the SDK-driven
 * modes (which need no binding). Two modes tap an iRacing key binding: Cycle
 * Sub-Camera (Next / Previous Sub Camera, #852) and Cycle by Track Order (Next
 * / Previous Car, #1277). Drives the per-button missing-binding icon warning
 * (`isBindingMissing`) — deliberately NOT `setActiveBinding`, whose state is
 * one value per action-class instance and would bleed one button's mode onto
 * every other Camera Controls key (see the note in `updateDisplay`).
 */
export function resolveBindingKey(target: Target, direction: Direction = "next"): string | null {
  switch (target) {
    case "cycle-sub-camera":
      return subCameraBindingKey(direction);
    case "cycle-track-order":
      return carCycleBindingKey(direction);
    default:
      return null;
  }
}

function isCycleTarget(target: Target): target is CycleTarget {
  return (CYCLE_TARGET_VALUES as readonly string[]).includes(target);
}

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
  "cycle-track-order": { next: trackPositionAheadSvg, previous: trackPositionBehindSvg },
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
  // Track order (#960) titles the DESTINATION rather than the direction of
  // travel through a list: on a key the whole idea is which car you land on,
  // and "AHEAD" / "BEHIND" also reads distinctly against Cycle Car's
  // NEXT / PREV right beside it. iRacing's Next Car (the tap since #1277)
  // focuses the car ahead on track, Previous Car the car behind.
  "cycle-track-order": {
    next: "CAR\nAHEAD",
    previous: "CAR\nBEHIND",
  },
  "cycle-driving": {
    next: "DRIVING\nNEXT",
    previous: "DRIVING\nPREV",
  },
};

/**
 * Camera group name → camera-select SVG icon, shared by the cycle-camera key
 * (next or current group, #959), its grid, and the dial carousel. Keyed by the
 * canonical name — look it up through `cameraSelectIcon`, never directly.
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
  "TV Static": tvStaticSvg,
  "TV Mixed": tvMixedSvg,
  TV4: tv4Svg,
  Spotter: spotterSvg,
  Spectator: spectatorSvg,
};

/** The camera-select icon for a group name in any spelling the sim uses. */
function cameraSelectIcon(groupName: string): string | undefined {
  return CAMERA_SELECT_ICONS[normalizeGroupName(groupName)];
}

/**
 * @internal Exported for testing
 *
 * Change Camera's stored value → name and icon SVG, built from the shared
 * `CHANGE_CAMERA_GROUPS` list (camera-groups.ts), which the PI test also reads.
 */
export const CAMERA_GROUP_MAP: Record<number, { name: string; icon: string }> = Object.fromEntries(
  Object.entries(CHANGE_CAMERA_GROUPS).map(([num, name]) => [num, { name, icon: CAMERA_SELECT_ICONS[name] }]),
);

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
  "switch-by-position": "SWITCH\nTO POS",
  "switch-by-car-number": "SWITCH\nTO CAR",
  "set-camera-state": "SET\nCAM STATE",
};

// --- Settings schema ---

/**
 * @internal Exported for testing
 *
 * The highest Change Camera value the dropdown can store — derived from the map
 * so the next group added cannot be rejected by a bound nobody remembered (#958).
 */
export const MAX_CAMERA_GROUP = Math.max(...Object.keys(CAMERA_GROUP_MAP).map(Number));

/**
 * @internal Exported for testing
 *
 * Change Camera's stored group. `catch`: `parseSettings` falls back to FULL
 * defaults on any failure, so a value this build does not know (one written by
 * a newer build, say) must degrade this field alone rather than reset the key's
 * mode, direction and subset with it — the reason `dial` carries one too.
 */
export const CameraGroupField = z.coerce.number().int().min(1).max(MAX_CAMERA_GROUP).default(9).catch(9);

/**
 * @internal Exported for testing
 *
 * What a Cycle Camera key's icon shows (#959): the group the next press selects
 * (`next`, the behaviour before the setting existed) or the group the sim is on
 * now (`current`). Keypad only — the dial strip already centres the current group.
 */
export const CycleIconModeField = z.enum(["next", "current"]).default("next").catch("next");

/**
 * @internal Exported for testing
 *
 * Reads a stored Switch by Car Number value as the digits the user typed,
 * leading zeros kept (#1353). The field has always stored its text; until
 * #1353 the schema coerced that text to an integer, which is where the zeros
 * went. Digits are therefore kept exactly as stored. Any other stored value is
 * read the way that schema read it — as a number, so `"7.0"` is still car 7
 * rather than the car 70 its digits would spell — and what it refused, an
 * empty field included, reads as `"0"`, the old default.
 */
export function normalizeCarNumber(value: unknown): string {
  const stored = typeof value === "string" ? value.trim() : value;

  if (typeof stored === "string" && /^[0-9]+$/.test(stored)) return stored;

  const legacy = typeof stored === "string" || typeof stored === "number" ? Number(stored) : Number.NaN;

  return Number.isSafeInteger(legacy) && legacy >= 0 ? String(legacy) : "0";
}

/**
 * @internal Exported for testing
 *
 * Switch by Car Number's target, a digit string so `07` and `7` stay different
 * cars (#1353). It cannot fail a parse, so an odd stored value never resets
 * the key's mode. The PI stores digits only (`irdDigitsOnly`), which a build
 * from before #1353 coerces back to an integer: a downgrade returns to the old
 * behaviour rather than to a failed parse.
 */
export const CarNumberField = z.preprocess(normalizeCarNumber, z.string()).default("0");

/**
 * @internal Exported for testing
 *
 * The number a Switch by Car Number press sends for the parsed `carNumber`
 * setting, or `null` to send nothing (#1353). iRacing's camera broadcast takes
 * `CarNumberRaw`, which the session's roster states for every car, so the
 * roster is asked first. A number without a leading zero that the roster does
 * not list is sent as the integer it is — the raw number of such a car, and
 * what the key sent before — which covers a roster that has not caught up. It
 * is sent only up to four digits, the longest a raw number gets: the broadcast
 * carries it in 16 bits, and a longer one would arrive as some other number.
 * A number with a leading zero that the roster does not list is not sent.
 */
export function resolveSwitchCarNumberRaw(sessionInfo: unknown, carNumber: string): number | null {
  const fromRoster = getCarNumberRawByCarNumber(sessionInfo, carNumber);

  if (fromRoster !== null) return fromRoster;

  return /^(0|[1-9][0-9]{0,3})$/.test(carNumber) ? Number(carNumber) : null;
}

/**
 * @internal Exported for testing
 *
 * The action's own settings fields, extended onto `CommonSettings` below —
 * exported so a test can parse through the real fields rather than a mock.
 */
export const CameraControlsSettingsFields = {
  target: z.enum(TARGET_VALUES).default("change-camera"),
  // Cycle-specific
  direction: z.enum(["next", "previous"]).default("next"),
  cameraGroupSubset: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  // Focus-specific
  position: z.coerce.number().int().min(1).default(1),
  carNumber: CarNumberField,
  cameraState: z.coerce.number().int().min(0).default(0),
  // Cycle-camera-specific (#959): what a Cycle Camera key's icon shows.
  cycleIconMode: CycleIconModeField,
  // Change-camera-specific
  cameraGroup: CameraGroupField,
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
};

const CameraControlsSettings = CommonSettings.extend(CameraControlsSettingsFields);

type CameraControlsSettings = z.infer<typeof CameraControlsSettings>;

// --- Icon generation ---

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the camera controls action.
 *
 * Switch by Car Number and Switch by Position draw their configured target in
 * the artwork (#1352), so `carNumber` / `position` are part of what the icon is
 * drawn from.
 */
export function generateCameraControlsSvg(
  settings: {
    target: Target;
    direction?: Direction;
    cameraGroup?: number;
    cameraGroupSubset?: string | Record<string, unknown>;
  } & SwitchTargetSettings &
    Partial<CommonSettings>,
  bindingMissing = false,
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
  const templateValues = switchTargetTemplateValues(target, settings);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, templateValues, bindingMissing });
}

/**
 * @internal Exported for testing
 *
 * The settings a Cycle Camera key's telemetry-driven icon is drawn from.
 */
export type CycleCameraKeySettings = {
  direction?: Direction;
  cameraGroupSubset?: string | Record<string, unknown>;
} & Partial<CommonSettings>;

/**
 * @internal Exported for testing
 *
 * Generate an SVG data URI for a specific camera group icon — the group a Cycle
 * Camera key's next press selects, or the group the sim is on now (#959).
 *
 * A group without an icon of its own falls back to the key's own grid icon,
 * drawn from the KEY's subset, direction and appearance overrides: it is a
 * placeholder, and it must look like the key the user configured.
 */
export function generateCameraSelectSvg(groupName: string, settings: CycleCameraKeySettings): string {
  const iconSvg = cameraSelectIcon(groupName);

  if (!iconSvg) return generateCameraControlsSvg({ ...settings, target: "cycle-camera" });

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(
    iconSvg,
    getGlobalTitleSettings(),
    settings.titleOverrides,
    `CAMERA\n${normalizeGroupName(groupName).toUpperCase()}`,
  );
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);
  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

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
  const groupsWithIcons = enabledGroupNames.filter((name) => cameraSelectIcon(name) !== undefined);

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
    const iconSvg = cameraSelectIcon(groupName) as string;
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
 * Shared with the keypad cycle-camera preview via `cameraSelectIcon`.
 */
function resolveGroupGlyph(groupName: string): CarouselGlyph | null {
  const iconSvg = cameraSelectIcon(groupName);

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

export class CameraControls extends SimIRacingAction<CameraControlsSettings> {
  /** Settings per action context for telemetry-driven icon updates */
  private activeContexts = new Map<string, CameraControlsSettings>();

  /** Last displayed group name per context to avoid redundant re-renders */
  private lastDisplayedGroup = new Map<string, string>();

  /** Per context, the newest cycle-icon render started (`showCycleIcon`) */
  private cycleIconGeneration = new Map<string, number>();

  /**
   * The dial half of the action (#803); all IDeck dial events route here.
   * Rotation reuses the keypad's own `executeCycle` / focus dispatch — the dial
   * duplicates no camera logic. `isBindingMissing` is delegated for the strip's
   * #612 warning (Sub-Camera is binding-driven since #852, Track Order since
   * #1277); `setActiveBinding`
   * is NOT — it is one value per action-class instance and would bleed a dial
   * context's state onto the keypad buttons (see global-settings.md).
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
    // Every dispatch below is the keypad's own, through the engine's camera
    // waiter (#1428 / #1435): the waiter logs a send that fails and never
    // rejects for one, so nothing here catches.
    cycle: (target, direction, contextId) =>
      this.executeCycle(target, direction, this.dialAsk(contextId, `${target} ${direction}`)),
    isBindingMissing: (keys) => this.isBindingMissing(keys),
    focusCarNumber: (carNumberRaw, contextId) =>
      this.focusCarNumber(carNumberRaw, this.dialAsk(contextId, `car number ${carNumberRaw}`)),
    focusMyCar: (contextId) => this.focusMyCar(this.dialAsk(contextId, "focus my car")),
    changeCamera: (contextId) => this.executeCycle("cycle-camera", "next", this.dialAsk(contextId, "change camera")),
    focusOnLeader: (contextId) => this.focusOn("focus-on-leader", this.dialAsk(contextId, "focus on leader")),
    focusOnIncident: (contextId) => this.focusOn("focus-on-incident", this.dialAsk(contextId, "focus on incident")),
    focusOnMostExciting: (contextId) =>
      this.focusOn("focus-on-most-exciting", this.dialAsk(contextId, "focus on most exciting")),
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
    this.cycleIconGeneration.delete(ev.action.id);
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
    await this.pushDeviceProfiles(ev, settings);
    await this.updateDisplay(ev, settings);
    // Cleared only now: a telemetry tick during the awaits above can render the
    // new settings' group and record it, and updateDisplay then paints the grid
    // over it — clearing earlier would leave the dedupe believing the group is
    // still on the key, and the key stuck on its grid.
    this.lastDisplayedGroup.delete(ev.action.id);
    this.updateCycleIcon(ev.action.id);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<CameraControlsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.target === "focus-select-car") {
      await this.executeFocusSelectCar(ev, settings);

      return;
    }

    const ask = this.keyAsk(ev.action.id, settings.target);

    if (isCycleTarget(settings.target)) {
      this.executeCycle(settings.target, settings.direction, ask, settings.cameraGroupSubset);
    } else if (settings.target === "change-camera") {
      this.executeChangeCamera(settings.cameraGroup, ask);
    } else {
      this.executeFocus(settings, ask);
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

  /** A key's ask for a camera switch: its context, and how the waiter's log names the press. */
  private keyAsk(contextId: string, target: Target): CameraSwitchAsk {
    return { contextId, surface: "the key", asked: `${target} pressed` };
  }

  /** A dial's ask for a camera switch: its context, and how the waiter's log names the input. */
  private dialAsk(contextId: string, asked: string): CameraSwitchAsk {
    return { contextId, surface: "the dial", asked: `dial ${asked}` };
  }

  /** Whether a key or dial context of this action is still on screen. */
  private isOnScreen(contextId: string): boolean {
    return this.activeContexts.has(contextId) || this.dialSurface.isOnScreen(contextId);
  }

  /**
   * Every camera switch this action's keypad and dial make (#1428 / #1435,
   * `docs/superpowers/specs/2026-10-24-issue-1428-camera-keys-during-replay-jump.md`)
   * goes through the replay engine's one camera-switch waiter, as Replay
   * Control's do: on a quiet replay, and outside a replay, `send` runs at
   * once, in this call; behind a position jump it waits for the landing as the
   * one switch that waits for the whole plugin, and is dropped if the wait
   * gives up, or if by then its key or dial has left the screen or the replay
   * has been left. A switch of the camera's car interrupts a Jump to Fastest
   * Lap or Jump to Race Start walk, which puts the replay back first; one of
   * the angle only (`interruptsWalks: false`) leaves a walk alone.
   *
   * `send` works out its target when it runs, from the camera then, so a
   * switch that waited steps from the car the jump left on screen. The waiter
   * logs a send that fails and never rejects for one, and the promise may stay
   * pending for as long as a jump takes, so it is not awaited.
   */
  private requestSwitch(ask: CameraSwitchAsk, what: CameraSwitchWhat, send: () => unknown): void {
    void requestCameraSwitch(send, {
      by: `camera-controls ${what.by}`,
      interruptsWalks: what.changesCar,
      label: "Camera controls",
      name: what.name,
      asked: ask.asked,
      surface: ask.surface,
      stillValid: () => this.isOnScreen(ask.contextId) && this.sdkController.getReplayState().inReplay,
      logger: this.logger,
    });
  }

  /**
   * One cycle step, keypad and dial alike, through {@link requestSwitch}.
   * Cycle by Car # and Cycle by Track Order change the camera's car; Cycle
   * Camera, Cycle Driving Cam and Cycle Sub-Camera change only its angle.
   */
  private executeCycle(
    target: CycleTarget,
    direction: Direction,
    ask: CameraSwitchAsk,
    cameraGroupSubset?: string | Record<string, unknown>,
  ): void {
    // The two binding-driven modes are dispatched BEFORE the telemetry guard:
    // they tap an iRacing key binding (Sub-Camera #852, Track Order #1277) and
    // read no telemetry at all, so a momentary gap in the SDK feed (reconnect
    // window, menus, a stalled tick) must not swallow the press — every other
    // keyboard-driven action taps unconditionally, and the plugin-wide offline
    // handling already gates presses while iRacing is not running.
    if (target === "cycle-sub-camera") {
      this.cycleSubCamera(direction, ask);

      return;
    }

    if (target === "cycle-track-order") {
      this.cycleTrackOrder(direction, ask);

      return;
    }

    this.requestSwitch(
      ask,
      { by: target, name: `${direction} ${CYCLE_SWITCH_NAMES[target]}`, changesCar: target === "cycle-car" },
      () => this.sendCycle(target, direction, cameraGroupSubset),
    );
  }

  /** A Cycle Camera, Cycle by Car # or Cycle Driving Cam step, from the camera as it is when the switch goes out. */
  private sendCycle(
    target: Exclude<CycleTarget, "cycle-sub-camera" | "cycle-track-order">,
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
        const sessionGroups = sessionInfo ? normalizeSessionGroups(getCameraGroupsFromSessionInfo(sessionInfo)) : [];

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
      case "cycle-car": {
        // Cycle to the neighbouring car by ascending car number and focus it BY
        // NUMBER — the same switchNum-not-switchPos correction the other cycle
        // branches use (issue #803). cycleCar's switchPos(carIdx ± 1) treats the
        // car INDEX as a race POSITION, so it lands on whatever car sits at that
        // position and stalls when the focused (pace) car has no valid position.
        // Reuses the dial car-number mode's walk (computeCarNumberTarget) over
        // the same competitor list so both surfaces agree — every car the
        // session has had, departed ones included, since a switch to one
        // works (#1281); falls back to the raw cycle helper only out of
        // session (no car list).
        const sessionInfo = this.sdkController.getSessionInfo();
        const cars = getAllCarNumbers(sessionInfo, true, true);
        const targetCar = computeCarNumberTarget(carIdx, cars, direction);

        if (targetCar) {
          const success = camera.switchNum(targetCar.carNumberRaw, groupNum, cameraNum);
          this.logger.info("Car switched");
          this.logger.debug(`Result: ${success}, direction: ${direction}, carNumberRaw: ${targetCar.carNumberRaw}`);
        } else if (cars.length === 0) {
          // Only fall back to the raw SDK cycle out of session (no car list).
          // When the focused car is the only one listed there is nowhere to
          // go, so do nothing — matching the dial's no-fallback contract.
          const success = camera.cycleCar(carIdx, dir);
          this.logger.info("Car cycled (fallback)");
          this.logger.debug(`Result: ${success}, direction: ${direction}`);
        }

        break;
      }
      case "cycle-driving": {
        // Driving cameras are camera groups too, so keep focus on the CURRENTLY
        // focused car by number and advance the group — the same
        // switchNum-not-switchPos correction cycle-camera / cycle-sub-camera use.
        // cycleDrivingCamera's switchPos(carIdx, group ± 1) treats the car INDEX
        // as a race POSITION, which the pace car has none of, stalling the cycle
        // (issue #803). Fall back to the raw cycle helper only when the car
        // number can't be resolved (out of session).
        const sessionInfo = this.sdkController.getSessionInfo();
        const carNumberRaw = sessionInfo ? getCarNumberRawFromSessionInfo(sessionInfo, carIdx) : null;

        if (carNumberRaw !== null) {
          const success = camera.switchNum(carNumberRaw, groupNum + dir, 0);
          this.logger.info("Driving camera switched");
          this.logger.debug(`Result: ${success}, direction: ${direction}, carNumberRaw: ${carNumberRaw}`);
        } else {
          const success = camera.cycleDrivingCamera(carIdx, groupNum, dir);
          this.logger.info("Driving camera cycled (car number fallback)");
          this.logger.debug(`Result: ${success}, direction: ${direction}`);
        }

        break;
      }
    }
  }

  /**
   * Step one sub-camera within the focused camera group.
   *
   * Keyboard-only by necessity (issue #852). iRacing's camera switch broadcasts
   * act on the FOCUS and the camera GROUP; their `camera` argument does not
   * select a sub-camera, so no SDK dispatch can step one — four rounds of live
   * testing across three dispatch shapes never moved the camera, and the
   * pre-#803 "working" behavior was the focus jumping to another car (carIdx
   * passed where a race position belongs), which makes the sim re-pick the
   * in-group shot. iRacing exposes the real function only as a key binding, so
   * tap it: the sim owns the stepping and the wrap, which also makes this
   * independent of the focus target (pace car, scenic view, or a classified car
   * all behave the same).
   *
   * Shared by the keypad Cycle Sub-Camera mode and the dial's Sub-Camera mode.
   */
  private cycleSubCamera(direction: Direction, ask: CameraSwitchAsk): void {
    this.tapCycleBinding(subCameraBindingKey(direction), direction, "Sub-camera", ask, {
      by: "cycle-sub-camera",
      name: `${direction} sub-camera`,
      changesCar: false,
    });
  }

  /**
   * Focus the car ahead of / behind the focused car on track — the keypad
   * Cycle by Track Order mode (CAR AHEAD / CAR BEHIND) and the dial's Track
   * Order mode.
   *
   * Keyboard-driven since #1277: iRacing's own Next Car (`next`, the car ahead
   * on track) / Previous Car (`previous`, the car behind) bindings pick the
   * car. Computing the neighbour ourselves read the LIVE car placement, so in
   * a replay watched inside a still-connected session it followed the live
   * field rather than the replay the driver sees — the sim's control follows
   * the replay. The binding keys are the ones Replay Control's Next Car /
   * Previous Car modes tap (`shared/car-cycle-bindings.ts`): one sim control,
   * one setting.
   */
  private cycleTrackOrder(direction: Direction, ask: CameraSwitchAsk): void {
    this.tapCycleBinding(carCycleBindingKey(direction), direction, "Track order car", ask, {
      by: "cycle-track-order",
      name: direction === "next" ? "next car" : "previous car",
      changesCar: true,
    });
  }

  /**
   * Taps one of the binding-driven cycle modes' iRacing key bindings through
   * {@link requestSwitch}, or warns when it is unset. The binding is checked
   * at the press: an unset one has nothing to send, so it never replaces a
   * switch waiting behind a jump.
   */
  private tapCycleBinding(
    settingKey: string,
    direction: Direction,
    what: string,
    ask: CameraSwitchAsk,
    switchWhat: CameraSwitchWhat,
  ): void {
    // `tapBinding` returns void, so check first: without this an unset binding
    // logs a successful cycle and a support log hides the real cause.
    if (this.isBindingMissing(settingKey)) {
      this.logger.warn(`${what} binding not configured — nothing sent`);
      this.logger.debug(`direction: ${direction}, binding: ${settingKey}`);

      return;
    }

    this.requestSwitch(ask, switchWhat, async () => {
      await this.tapBinding(settingKey);
      this.logger.info(`${what} cycled`);
      this.logger.debug(`direction: ${direction}, binding: ${settingKey}`);
    });
  }

  /**
   * Center the camera on the player's own car — the Focus Your Car mode. Shared
   * by the keypad `focus-your-car` mode and the dial's Focus My Car press
   * gesture (#803) so both go through one SDK dispatch. Reads its own telemetry
   * so the dial can call it without a settings object.
   */
  private focusMyCar(ask: CameraSwitchAsk): void {
    this.requestSwitch(ask, { by: "focus-your-car", name: "my car", changesCar: true }, () => this.sendFocusMyCar());
  }

  /** Focus Your Car's switch, worked out when it goes out. */
  private sendFocusMyCar(): void {
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
   *
   * The car is the one the dial resolved at the detent, from the order its
   * strip previewed; the angle is read when the switch goes out.
   */
  private focusCarNumber(carNumberRaw: number, ask: CameraSwitchAsk): void {
    this.requestSwitch(ask, { by: "focus-car-number", name: `car number ${carNumberRaw}`, changesCar: true }, () =>
      this.sendFocusCarNumber(carNumberRaw),
    );
  }

  /** The dial's focus-by-car-number switch, its angle read when it goes out. */
  private sendFocusCarNumber(carNumberRaw: number): void {
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
  private focusOn(target: FocusOnTarget, ask: CameraSwitchAsk): void {
    this.requestSwitch(ask, { by: target, name: FOCUS_ON_SWITCH_NAMES[target], changesCar: true }, () =>
      this.sendFocusOn(target),
    );
  }

  /** A focus one-shot's switch, its angle read when it goes out. */
  private sendFocusOn(target: FocusOnTarget): void {
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

  private executeFocus(settings: CameraControlsSettings, ask: CameraSwitchAsk): void {
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("No telemetry available for camera focus");

      return;
    }

    switch (settings.target) {
      case "focus-your-car": {
        this.focusMyCar(ask);

        break;
      }
      case "focus-on-leader":
      case "focus-on-incident":
      case "focus-on-most-exciting": {
        // Shared with the dial's focus gestures (#803) so both surfaces use one dispatch.
        this.focusOn(settings.target, ask);
        break;
      }
      case "switch-by-position": {
        const { position } = settings;

        this.requestSwitch(ask, { by: "switch-by-position", name: `position ${position}`, changesCar: true }, () => {
          const { groupNum, cameraNum } = this.currentAngle();
          const success = getCommands().camera.switchPos(position, groupNum, cameraNum);
          this.logger.info("Switch by position executed");
          this.logger.debug(`Result: ${success}, position: ${position}`);
        });
        break;
      }
      case "switch-by-car-number": {
        // The car is the key's setting, resolved through the roster at the
        // press: one that resolves to nothing has nothing to send, and never
        // replaces a switch waiting behind a jump.
        const { carNumber } = settings;
        const carNumberRaw = resolveSwitchCarNumberRaw(this.sdkController.getSessionInfo(), carNumber);

        if (carNumberRaw === null) {
          this.logger.info("Switch by car number skipped: car number not found in session info");
          this.logger.debug(`carNumber: ${carNumber}`);
          break;
        }

        this.requestSwitch(ask, { by: "switch-by-car-number", name: `car #${carNumber}`, changesCar: true }, () => {
          const { groupNum, cameraNum } = this.currentAngle();
          const success = getCommands().camera.switchNum(carNumberRaw, groupNum, cameraNum);
          this.logger.info("Switch by car number executed");
          this.logger.debug(`Result: ${success}, carNumber: ${carNumber}, carNumberRaw: ${carNumberRaw}`);
        });
        break;
      }
      case "set-camera-state": {
        // Not a camera target but flags on the camera (UI hidden and so on),
        // which nothing says a seek drops: sent at once, never through the
        // waiter (#1428 / #1435).
        const camera = getCommands().camera;
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

  /**
   * The camera group and sub-camera on screen, read when a switch goes out:
   * the angle a car switch keeps. The fallbacks are the ones each mode read
   * at the press before #1428 / #1435.
   */
  private currentAngle(): { groupNum: number; cameraNum: number } {
    const telemetry = this.sdkController.getCurrentTelemetry();

    return { groupNum: telemetry?.CamGroupNumber ?? 1, cameraNum: telemetry?.CamCameraNumber ?? 1 };
  }

  /** Change Camera, through {@link requestSwitch}: a switch of the angle only, so it leaves a lap walk alone. */
  private executeChangeCamera(cameraGroup: number, ask: CameraSwitchAsk): void {
    const name = `${CAMERA_GROUP_MAP[cameraGroup]?.name ?? `group ${cameraGroup}`} camera`;

    this.requestSwitch(ask, { by: "change-camera", name, changesCar: false }, () => this.sendChangeCamera(cameraGroup));
  }

  /** Change Camera's switch, onto the car the camera is on when it goes out. */
  private sendChangeCamera(cameraGroup: number): void {
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("No telemetry available for change camera");

      return;
    }

    const camera = getCommands().camera;
    const carIdx = telemetry.CamCarIdx ?? 0;
    const sessionInfo = this.sdkController.getSessionInfo();
    const sessionGroups = sessionInfo ? normalizeSessionGroups(getCameraGroupsFromSessionInfo(sessionInfo)) : [];

    // Resolve the group by NAME against the session: the sim numbers its groups
    // per content, so our stored number is only an index into CAMERA_GROUP_MAP.
    const targetName = CAMERA_GROUP_MAP[cameraGroup]?.name;
    let resolvedGroup = cameraGroup;

    if (targetName && sessionGroups.length > 0) {
      const match = findSessionGroupByName(sessionGroups, targetName);

      // The session lists its groups and this one is not among them (TV4 on
      // road content, say). Our own number would pick an unrelated camera, so
      // the press does nothing rather than something wrong (#958). The raw
      // number below survives only for a session whose groups are unreadable.
      if (!match) {
        this.logger.info("Camera change skipped: group not in this session");
        this.logger.debug(`Group "${targetName}" (${cameraGroup}) is not in the session's camera groups`);

        return;
      }

      resolvedGroup = match.groupNum;
    }

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
   * Update the icon for cycle-camera contexts based on current telemetry: the
   * group the next press selects, or — with Icon Shows = Current camera (#959)
   * — the group the sim is on now, even outside the key's enabled subset,
   * because that is still what is on screen.
   */
  private async updateCycleIcon(contextId: string): Promise<void> {
    const settings = this.activeContexts.get(contextId);

    if (!settings || settings.target !== "cycle-camera") return;

    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      // Connection lost — restore grid icon if we were showing a telemetry-driven icon
      if (this.lastDisplayedGroup.has(contextId)) {
        this.lastDisplayedGroup.delete(contextId);
        await this.showCycleIcon(contextId, () => generateCameraControlsSvg(settings));
      }

      return;
    }

    const sessionInfo = this.sdkController.getSessionInfo();
    const sessionGroups = sessionInfo ? normalizeSessionGroups(getCameraGroupsFromSessionInfo(sessionInfo)) : [];

    if (sessionGroups.length === 0) return;

    let shownGroupName: string;

    if (settings.cycleIconMode === "current") {
      // A group number the telemetry does not report, or the session does not
      // list, has no name to show; the empty name draws the key's placeholder
      // rather than a guess.
      const camGroup = telemetry.CamGroupNumber;
      shownGroupName = camGroup === undefined ? "" : (findSessionGroupByNum(sessionGroups, camGroup)?.groupName ?? "");
    } else {
      const groupNum = telemetry.CamGroupNumber ?? 1;
      const dir = settings.direction === "next" ? 1 : -1;
      const enabledNames = getEnabledGroupNames(settings.cameraGroupSubset);
      const nextEntry = getNextSelectedGroupEntry(groupNum, enabledNames, sessionGroups, dir);

      if (!nextEntry) return;

      shownGroupName = nextEntry.groupName;
    }

    // Skip re-render if the shown group hasn't changed
    if (this.lastDisplayedGroup.get(contextId) === shownGroupName) return;

    this.lastDisplayedGroup.set(contextId, shownGroupName);
    await this.showCycleIcon(contextId, () => generateCameraSelectSvg(shownGroupName, settings));
  }

  /**
   * Push a Cycle Camera key's telemetry-driven icon and register it for
   * regeneration — unless a newer render for the same key started while this
   * one's image was in flight. `setRegenerateCallback` reconciles on
   * registration, so a late, older registration would put its older image back
   * on the key while the dedupe records the newer group, and the key would stay
   * wrong until the group next changed.
   */
  private async showCycleIcon(contextId: string, render: () => string): Promise<void> {
    const generation = (this.cycleIconGeneration.get(contextId) ?? 0) + 1;
    this.cycleIconGeneration.set(contextId, generation);
    await this.updateKeyImage(contextId, render());

    if (this.cycleIconGeneration.get(contextId) !== generation) return;

    this.setRegenerateCallback(contextId, render);
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<CameraControlsSettings> | IDeckDidReceiveSettingsEvent<CameraControlsSettings>,
    settings: CameraControlsSettings,
  ): Promise<void> {
    this.updateConnectionState();

    // Per-BUTTON missing-binding state (#612): never the shared
    // isActiveBindingMissing(), which is one value per action-class instance and
    // would bleed one button's mode onto every other Camera Controls button.
    //
    // For the same reason this action never calls `setActiveBinding`: readiness
    // would then be governed class-wide by whichever button appeared last, so a
    // single unbound Cycle Sub-Camera key would dim the twelve SDK-driven camera
    // keys around it (and an SDK-mode button would clear the tracking the
    // sub-camera key needs). Readiness stays tied to the iRacing connection —
    // correct for every mode, since no camera control works out of a session —
    // and the binding state is surfaced per button by this warning and by the
    // PI's own status line.
    const bindingKey = resolveBindingKey(settings.target, settings.direction);
    const svgDataUri = generateCameraControlsSvg(settings, this.isBindingMissing(bindingKey));
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () =>
      generateCameraControlsSvg(settings, this.isBindingMissing(bindingKey)),
    );
  }
}

// Backward-compatible alias
export { CameraControls as CameraFocus };
