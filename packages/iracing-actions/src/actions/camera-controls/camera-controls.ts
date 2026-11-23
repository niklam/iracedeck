import {
  applyGraphicTransform,
  assembleIcon,
  CAR_SELECTOR_PROFILE,
  CommonSettings,
  computeGraphicArea,
  DIMMED_OPACITY,
  extractGraphicContent,
  generateBorderParts,
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
  type PressShape,
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
import autoGroupArtworkSvg from "@iracedeck/icons/camera-focus/auto-group.svg";
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
import customGroupSvg from "@iracedeck/icons/camera-select/custom.svg";
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
  type CameraGroup,
  getAllCarNumbers,
  getCameraGroupsFromSessionInfo,
  getCarNumberRawByCarNumber,
  getCarNumberRawFromSessionInfo,
} from "@iracedeck/iracing-sdk";
import { requestCameraSwitch } from "@iracedeck/replay-engine";
import { getGlobalColors, getGlobalSettings, onGlobalSettingsChange } from "@iracedeck/settings";
import { getLiveRacePositions } from "@iracedeck/sim-events-iracing";
import z from "zod";

import autoGroupTemplate from "../../../icons/camera-controls-auto-group.svg";
import {
  borderColorForState,
  statusBarNA,
  statusBarOff,
  statusBarOn,
  type ToggleState,
} from "../../icons/status-bar.js";
import { carCycleBindingKey } from "../../shared/car-cycle-bindings.js";
import { computeCarNumberTarget } from "../../shared/car-cycling.js";
import { setSelectIntent } from "../../shared/car-select-intent.js";
import { availableProfilesForDevice, deviceProfileEntries, profileEntriesEqual } from "../../shared/profile-entries.js";
import { unavailableLook } from "../../shared/unavailable-look.js";
import {
  autoGroupNames,
  type AutoGroupPick,
  AutoGroupPickField,
  AutoGroupSubsetField,
  isAutoGroupUnavailable,
} from "./auto-group-pick.js";
import {
  isAutoGroupOwner,
  onAutoGroupChange,
  stopAutoGroup,
  toggleAutoGroup,
  updateAutoGroupSettings,
} from "./auto-group.js";
import type { CarouselGlyph } from "./camera-dial-render.js";
import { CameraDialSurface, dialOffersAutoGroup, DialSettings } from "./camera-dial-surface.js";
import {
  CAMERA_GROUPS_SETTING_KEY,
  CHANGE_CAMERA_GROUPS,
  DEFAULT_ENABLED_GROUPS,
  findSessionGroupByNum,
  foldGroupName,
  getNextSelectedGroupEntry,
  matchSessionGroup,
  normalizeGroupName,
  normalizeSessionGroups,
  parseGroupSubset,
  resolveEnabledSessionGroups,
  type SessionGroupMatch,
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

/** Auto Group on Car Change (#1656): a press turns the plugin's one automation on or off. */
const AUTO_GROUP_TARGET_VALUES = ["auto-group"] as const;

const TARGET_VALUES = [
  ...CHANGE_CAMERA_TARGET_VALUES,
  ...CYCLE_TARGET_VALUES,
  ...FOCUS_TARGET_VALUES,
  ...AUTO_GROUP_TARGET_VALUES,
] as const;

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
 * (`isBindingMissing`), which is stateless per call so one button's mode never
 * bleeds onto another Camera Controls key.
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

/** {@link CAMERA_SELECT_ICONS} keyed by folded name, for a name typed in another case. */
const CAMERA_SELECT_ICONS_FOLDED = new Map(
  Object.entries(CAMERA_SELECT_ICONS).map(([name, svg]) => [foldGroupName(name), svg]),
);

/**
 * The camera-select icon for a group name in any spelling the sim uses. An own
 * key only: a camera file may name a group `constructor` or `toString` (#1653),
 * which the map would otherwise answer from its prototype.
 */
function cameraSelectIcon(groupName: string): string | undefined {
  const name = normalizeGroupName(groupName);

  if (Object.hasOwn(CAMERA_SELECT_ICONS, name)) return CAMERA_SELECT_ICONS[name];

  // A standard group typed in another case (#1653) is still that group: the
  // press finds it case-insensitively, so its key shows its own artwork.
  return CAMERA_SELECT_ICONS_FOLDED.get(foldGroupName(name));
}

/**
 * The artwork for any named camera group (#1653, spec decision 9): its own
 * camera-select icon, or the one generic custom-group icon for a name without
 * artwork of its own — a group a camera file defines beyond the 25 standard
 * ones. The group's name is the key's title, so one icon serves them all.
 */
function groupIcon(groupName: string): string {
  return cameraSelectIcon(groupName) ?? customGroupSvg;
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

/**
 * @internal Exported for testing
 *
 * Auto Group on Car Change's default title (#1656, spec decision 7), in every
 * state. Its template hides it and locks Show title off, as on the Pit Crew
 * toggles: the status bar already reads the state, and the artwork says what
 * the key is. A per-key override can still show it, at the top.
 */
export const AUTO_GROUP_TITLE = "AUTO\nGROUP";

/** Top of the tri-state status bar every toggle key draws over y 100–144 (`status-bar.ts`). */
const STATUS_BAR_TOP = 100;
/** Gap kept between the artwork and the status bar, the Pit Crew toggles' padding. */
const STATUS_BAR_GAP = 8;

const AUTO_GROUP_STATUS_BARS: Record<ToggleState, () => string> = {
  on: statusBarOn,
  off: statusBarOff,
  na: statusBarNA,
};

/**
 * @internal Exported for testing
 *
 * The tri-state an Auto Group on Car Change key shows (#1656): N/A while a
 * loaded session's camera groups hold no candidate of the key's list (an empty
 * list included), whether or not the key owns the run; otherwise on while the
 * key owns the run and off when it does not. N/A wins over on because it is
 * what the run can do on this track, which is nothing; it keeps running, and
 * the bar goes back to on by itself on a track that has a candidate.
 */
export function autoGroupKeyState(owner: boolean, noCandidate: boolean): ToggleState {
  if (noCandidate) return "na";

  return owner ? "on" : "off";
}

/**
 * @internal Exported for testing
 *
 * Draws an Auto Group on Car Change key (#1656) on the tri-state toggle
 * layout of the Pit Crew toggles (Race Engineer, Corner Names): its 144×144
 * chrome template, the artwork scaled into the area above the status bar, the
 * title (hidden unless a per-key override shows it), the full-width ON / OFF /
 * N/A bar, and the key border in the same state colour. The artwork is a
 * standalone snippet, read through its own viewBox like every other Camera
 * Controls icon, and coloured with the template's resolved slots.
 */
export function generateAutoGroupKeySvg(settings: Partial<CommonSettings>, state: ToggleState): string {
  const colors = resolveIconColors(autoGroupTemplate, getGlobalColors(), settings.colorOverrides) as Record<
    string,
    string
  >;
  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);
  const title = resolveTitleSettings(
    autoGroupTemplate,
    getGlobalTitleSettings(),
    settings.titleOverrides,
    AUTO_GROUP_TITLE,
  );

  // The status bar takes y 100–144, so the artwork is fitted above it.
  const fullArea = computeGraphicArea(title);
  const graphicArea = {
    ...fullArea,
    height: Math.min(fullArea.height, STATUS_BAR_TOP - STATUS_BAR_GAP - fullArea.y),
  };
  const bounds = parseSvgViewBox(autoGroupArtworkSvg);
  const artwork = renderIconTemplate(extractGraphicContent(autoGroupArtworkSvg), colors);
  const scaledGraphic =
    title.showGraphics && bounds ? applyGraphicTransform(artwork, bounds, graphicArea, graphic.scale) : "";

  const titleText = title.showTitle
    ? generateTitleText({
        text: title.titleText ?? AUTO_GROUP_TITLE,
        fontSize: title.fontSize,
        bold: title.bold,
        position: title.position,
        customPosition: title.customPosition,
        fill: colors.textColor ?? "#ffffff",
      })
    : "";

  const border = resolveBorderSettings(
    autoGroupTemplate,
    getGlobalBorderSettings(),
    settings.borderOverrides,
    borderColorForState(state),
  );
  const borderSvg = generateBorderParts(border);

  const svg = renderIconTemplate(autoGroupTemplate, {
    iconContent: scaledGraphic + titleText + AUTO_GROUP_STATUS_BARS[state](),
    borderDefs: borderSvg.defs,
    borderContent: borderSvg.rects,
    ...colors,
  });

  return svgToDataUri(svg);
}

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
 * Change Camera's stored group NAME (#1653, spec decision 5): any camera group
 * a camera file defines. A non-empty name wins over `cameraGroup`; an empty one
 * — every key saved before the field existed — means "read `cameraGroup`
 * through `CHANGE_CAMERA_GROUPS`", exactly as before. `catch`, for the reason
 * `CameraGroupField` carries one: an odd stored value degrades this field
 * alone, to the number, rather than resetting the key.
 */
export const CameraGroupNameField = z.string().trim().default("").catch("");

/**
 * @internal Exported for testing
 *
 * The group a Change Camera key names, in its canonical spelling: its stored
 * name when it has one, else its stored number read through
 * `CHANGE_CAMERA_GROUPS` (Cockpit for a number the map lacks, as the schema
 * would have it). Trimmed here too, since not every caller has parsed.
 */
export function changeCameraGroupName(settings: { cameraGroup?: number; cameraGroupName?: string }): string {
  const name = settings.cameraGroupName?.trim() ?? "";

  if (name !== "") return normalizeGroupName(name);

  return CHANGE_CAMERA_GROUPS[settings.cameraGroup ?? 9] ?? CHANGE_CAMERA_GROUPS[9];
}

/** Whether a Change Camera key stores a group name, rather than only the number every older key has. */
function hasStoredGroupName(settings: { cameraGroupName?: string }): boolean {
  return (settings.cameraGroupName?.trim() ?? "") !== "";
}

/**
 * @internal Exported for testing
 *
 * Whether a Change Camera key's group is missing from the loaded session
 * (#1653, spec decision 8): the session lists its groups and the key's name
 * resolves to none of them, or to several differing only in case. No session,
 * or one whose groups cannot be read, is never "unavailable" — there is
 * nothing to check the name against. Expects `normalizeSessionGroups` output.
 */
export function isChangeCameraUnavailable(groupName: string, sessionGroups: CameraGroup[]): boolean {
  return sessionGroups.length > 0 && matchSessionGroup(sessionGroups, groupName).kind !== "found";
}

/**
 * @internal Exported for testing
 *
 * Whether a Cycle Camera key's enabled subset names no group of the loaded
 * session (#1653, spec decision 8), so a press would cycle nowhere. Like
 * {@link isChangeCameraUnavailable}, never with no session, and never for an
 * empty subset, which has no name to check.
 */
export function isCycleCameraUnavailable(enabledGroupNames: string[], sessionGroups: CameraGroup[]): boolean {
  return (
    sessionGroups.length > 0 &&
    enabledGroupNames.length > 0 &&
    resolveEnabledSessionGroups(enabledGroupNames, sessionGroups).groups.length === 0
  );
}

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
  // #1653: the group by name, any group a camera file defines; wins when set.
  cameraGroupName: CameraGroupNameField,
  // Auto Group on Car Change (#1656, spec decision 6): the key's own list and
  // pick order. Each `.catch`es to its default alone, so junk never resets the
  // key's mode through the full-defaults fallback in parseSettings.
  autoGroupSubset: AutoGroupSubsetField,
  autoGroupPick: AutoGroupPickField,
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
 *
 * An Auto Group on Car Change key (#1656) is a tri-state toggle, drawn by
 * {@link generateAutoGroupKeySvg} in `autoGroupState`. It never takes the
 * unavailable look, since its N/A state says the same thing, and it has no
 * binding, so neither `unavailable` nor `bindingMissing` applies to it.
 */
export function generateCameraControlsSvg(
  settings: {
    target: Target;
    direction?: Direction;
    cameraGroup?: number;
    cameraGroupSubset?: string | Record<string, unknown>;
    cameraGroupName?: string;
  } & SwitchTargetSettings &
    Partial<CommonSettings>,
  bindingMissing = false,
  unavailable = false,
  autoGroupState: ToggleState = "off",
): string {
  const { target, direction = "next" } = settings;

  if (target === "auto-group") return generateAutoGroupKeySvg(settings, autoGroupState);

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
        unavailable,
      );
    }

    iconSvg = CYCLE_ICONS[target]?.[direction] || CYCLE_ICONS["cycle-camera"]["next"];
    defaultTitle = CYCLE_TITLES[target]?.[direction] || CYCLE_TITLES["cycle-camera"]["next"];
  } else if (target === "change-camera") {
    const groupName = changeCameraGroupName(settings);
    iconSvg = groupIcon(groupName);
    defaultTitle = `CAMERA\n${groupName.toUpperCase()}`;
  } else {
    iconSvg = FOCUS_ICONS[target] || FOCUS_ICONS["focus-your-car"];
    defaultTitle = FOCUS_TITLES[target] || FOCUS_TITLES["focus-your-car"];
  }

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);
  const templateValues = switchTargetTemplateValues(target, settings);

  return assembleIcon({
    graphicSvg: iconSvg,
    title,
    graphic,
    templateValues,
    bindingMissing,
    // A key whose press would do nothing now (#1653): its own icon, greyed.
    ...(unavailable ? unavailableLook(colors, border) : { colors, border }),
  });
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
 * A group without an icon of its own (a custom group, #1653) draws the generic
 * custom-group icon with its name, since that is what is on screen. Only an
 * empty name — the sim reports a group its session does not list — falls back
 * to the key's own grid icon, drawn from the KEY's subset, direction and
 * appearance overrides: it is a placeholder, and it must look like the key the
 * user configured.
 *
 * `unavailable` (#1653) draws the icon greyed, for a key whose press would
 * cycle nowhere in this session — the group's icon, or the grid placeholder
 * when there is no name to show.
 */
export function generateCameraSelectSvg(
  groupName: string,
  settings: CycleCameraKeySettings,
  unavailable = false,
): string {
  if (groupName === "") return generateCameraControlsSvg({ ...settings, target: "cycle-camera" }, false, unavailable);

  const iconSvg = groupIcon(groupName);
  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(
    iconSvg,
    getGlobalTitleSettings(),
    settings.titleOverrides,
    `CAMERA\n${normalizeGroupName(groupName).toUpperCase()}`,
  );
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);
  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({
    graphicSvg: iconSvg,
    title,
    graphic,
    ...(unavailable ? unavailableLook(colors, border) : { colors, border }),
  });
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
 *
 * `unavailable` (#1653) draws it in the shared unavailable look: every colour
 * but the background grey, and the thumbnails and label faded as
 * `assembleIcon`'s `dimmed` fades a key — the grid is assembled by hand, so it
 * applies the look itself.
 */
export function generateCycleCameraGridSvg(
  enabledGroupNames: string[],
  direction: Direction,
  colorOverrides?: Record<string, string>,
  titleOverrides?: Partial<CommonSettings>["titleOverrides"],
  borderOverrides?: Partial<CommonSettings>["borderOverrides"],
  graphicOverrides?: Partial<CommonSettings>["graphicOverrides"],
  unavailable = false,
): string {
  // Every named group gets a thumbnail: its own artwork, or the generic
  // custom-group icon (#1653) — a custom group was dropped from the grid before.
  const groupsWithIcons = enabledGroupNames.filter((name) => name !== "");

  // Fall back to static cycle icon if no group is enabled (direct render, no recursion)
  if (groupsWithIcons.length === 0) {
    const iconSvg = CYCLE_ICONS["cycle-camera"][direction];
    const titleText = CYCLE_TITLES["cycle-camera"][direction];
    const colors = resolveIconColors(iconSvg, getGlobalColors(), colorOverrides);
    const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), titleOverrides, titleText);
    const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), borderOverrides);
    const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), graphicOverrides);

    return assembleIcon({
      graphicSvg: iconSvg,
      title,
      graphic,
      ...(unavailable ? unavailableLook(colors, border) : { colors, border }),
    });
  }

  const displayGroups = groupsWithIcons.slice(0, 6);
  const positions = computeGridPositions(displayGroups.length);

  // Resolve colors from the cycle-camera base icon
  const baseSvg = CYCLE_ICONS["cycle-camera"][direction];
  const colors = gridColors(resolveIconColors(baseSvg, getGlobalColors(), colorOverrides), unavailable);
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
    const iconSvg = groupIcon(groupName);
    const artColors = gridColors(resolveIconColors(iconSvg, getGlobalColors(), colorOverrides), unavailable);
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

  const content = unavailable ? `<g opacity="${DIMMED_OPACITY}">${thumbnails}${label}</g>` : `${thumbnails}${label}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><g><rect x="0" y="0" width="144" height="144" fill="${bgColor}"/>${content}</g></svg>`;

  return svgToDataUri(svg);
}

/**
 * A grid's colour slots, in the unavailable look when asked (#1653). The grid
 * draws no border, so only the look's colours are taken.
 */
function gridColors(colors: Record<string, string>, unavailable: boolean): Record<string, string> {
  return unavailable ? unavailableLook(colors, { borderColor: "" }).colors : colors;
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
  const globalSettings = getGlobalSettings();
  const globalRaw = globalSettings[CAMERA_GROUPS_SETTING_KEY] as string | Record<string, unknown> | undefined;
  const fromGlobal = parseGroupSubset(globalRaw);

  if (fromGlobal !== undefined) return fromGlobal;

  return DEFAULT_ENABLED_GROUPS;
}

/**
 * Resolve a camera-group name to its dial-carousel glyph — the colour-resolved
 * inner artwork of the group's camera-select icon, or the generic custom-group
 * icon for a group without one (#1653), plus its source dimensions. Returns
 * null only for an empty name, which the carousel renders name-only. Shared
 * with the keypad cycle-camera preview via `groupIcon`.
 */
function resolveGroupGlyph(groupName: string): CarouselGlyph | null {
  if (groupName === "") return null;

  const iconSvg = groupIcon(groupName);

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

/**
 * A look a key can show (#1653 review): what identifies it, so the writer
 * knows whether the key shows it already, and the renderer that draws it. The
 * renderer is registered as the key's regeneration callback once the look is
 * on the key, so regeneration redraws that same look with fresh colours and
 * bindings and never another one the writer has not recorded.
 */
interface KeyLook {
  /** The settings version, the kind, the availability and — for a group icon — its name. */
  id: string;
  /** The settings version the look was drawn for. */
  version: number;
  /** The key's resting icon (its grid, or its group's icon), or a Cycle Camera key's group icon. */
  kind: "rest" | "group";
  /** Drawn unavailable, greyed (#1653). */
  unavailable: boolean;
  render: () => string;
}

type KeyEvent = IDeckWillAppearEvent<CameraControlsSettings> | IDeckDidReceiveSettingsEvent<CameraControlsSettings>;

/** How a failed redraw's log line names the keys whose look follows the sim or the plugin's own state. */
const REDRAWN_KEY_NAMES: Partial<Record<Target, string>> = {
  "change-camera": "Change Camera",
  "cycle-camera": "Cycle Camera",
  "auto-group": "Auto Group",
};

/** Who awaits a settings write: the handler that asked for it. */
interface SettingsWaiter {
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** New settings waiting to reach the key, through the host event that writes the title and image. */
interface SettingsWrite {
  ev: KeyEvent;
  waiters: SettingsWaiter[];
  /** The write is under way: newer settings queue behind it rather than replace it. */
  started: boolean;
}

/**
 * One key's image writer (#1653 review). Every write to a key — new settings,
 * a telemetry tick's icon, the grid put back — goes through it, and at most
 * one runs at a time, so no two writes for one key ever interleave. A request
 * made while a write is out only marks the key for another pass; each pass
 * decides the key's look at the moment it runs, from the current settings,
 * telemetry and session, and writes it unless the key already shows it.
 */
interface KeyRender {
  /** Raised by every settings update, so a look drawn for older settings is never taken for current. */
  settingsVersion: number;
  /** Settings to write before anything else; kept after a refused write, so the next request retries it. */
  settingsWrite: SettingsWrite | null;
  /**
   * The settings write under way, which newer settings no longer point to: the
   * key leaving releases its waiters too, rather than leave them on a host call
   * that may never settle (#1653 review).
   */
  settingsInFlight: SettingsWrite | null;
  /** The look the last successful write put on the key; null when a write failed and the key's look is unknown. */
  written: KeyLook | null;
  running: boolean;
  /** Something asked for a pass while a write was out. */
  requested: boolean;
  /** Waiters of a settings write that went out, released once the pass that follows it is under way. */
  settled: SettingsWaiter[];
}

function newKeyRender(): KeyRender {
  return {
    settingsVersion: 0,
    settingsWrite: null,
    settingsInFlight: null,
    written: null,
    running: false,
    requested: false,
    settled: [],
  };
}

export class CameraControls extends SimIRacingAction<CameraControlsSettings> {
  /** Settings per action context for telemetry-driven icon updates */
  private activeContexts = new Map<string, CameraControlsSettings>();

  /** Per key, its image writer (#1653 review): every write to a key goes through it. */
  private keyRenders = new Map<string, KeyRender>();

  /**
   * The session's normalised camera groups, read once per session-info update
   * for the Change Camera keys' per-tick availability check (#1653). The SDK
   * hands back the same session-info object until iRacing publishes a new one,
   * so its identity says when the group list may have changed.
   */
  private sessionGroupsCache: {
    sessionInfo: unknown;
    groups: CameraGroup[];
    /** Per group name, whether it is unavailable in this session; filled on first ask (#1653 review). */
    unavailable: Map<string, boolean>;
    /** Per Auto Group list (its names as JSON), whether it leaves no candidate in this session (#1656). */
    autoGroupUnavailable: Map<string, boolean>;
  } | null = null;

  /**
   * The dial half of the action (#803); all IDeck dial events route here.
   * Rotation reuses the keypad's own `executeCycle` / focus dispatch — the dial
   * duplicates no camera logic. `isBindingMissing` is delegated for the strip's
   * #612 warning (Sub-Camera is binding-driven since #852, Track Order since
   * #1277).
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
    // Auto Group on/off (#1656, spec decision 9): the key's press, with the
    // dial as the owner and its own list and pick order.
    toggleAutoGroup: (contextId, dial) => this.toggleAutoGroupFor(contextId, dial.autoGroupSubset, dial.autoGroupPick),
    isAutoGroupOwner: (contextId) => isAutoGroupOwner(contextId),
  });

  /**
   * Keeps the dial strips' dash-box appearance (#811) live: telemetry ticks
   * only arrive while iRacing is connected, so without this a color override
   * saved with the sim closed would leave the strip stale until the next
   * connect. The subscription lives for the plugin's lifetime.
   */
  private readonly unsubscribeGlobalSettings = onGlobalSettingsChange(() => this.dialSurface.refreshAll());

  /**
   * Redraws this instance's Auto Group keys whenever the automation's owner
   * changes (#1656, spec decision 2): a start, a takeover or a stop. The owner
   * is module state shared by every Camera Controls instance (the camera-focus
   * action and the legacy camera-cycle UUID), so each instance hears every
   * change and redraws only its own contexts. Lives for the plugin's lifetime,
   * like the global-settings listener above.
   */
  private readonly unsubscribeAutoGroup = onAutoGroupChange(() => this.onAutoGroupOwnerChange());

  /**
   * Removes this instance's global-settings and Auto Group listeners.
   * Production instances listen for the plugin's lifetime and never call this;
   * a test that constructs many instances calls it in `afterEach`, because
   * the Auto Group listener set is module state that outlives each test.
   *
   * @internal Exported for testing
   */
  _dispose(): void {
    this.unsubscribeGlobalSettings();
    this.unsubscribeAutoGroup();
  }

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

    // A fresh writer for this placement; one left from an earlier placement of
    // the same context stops at its next step.
    this.dropKeyRender(ev.action.id);
    this.keyRenders.set(ev.action.id, newKeyRender());

    // The settings are queued first, so the writer's first pass writes them —
    // the subscription below may tick at once, inside subscribe, and a pass that
    // tick started would otherwise draw a telemetry look before the key has its
    // settings (#1653 review). It subscribes before that write is awaited, so a
    // first write the host refuses is retried by the next tick and the key
    // recovers. The writer draws the telemetry-driven look right after the
    // settings' own.
    const settingsWritten = this.requestSettingsWrite(ev);

    this.sdkController.subscribe(ev.action.id, () => {
      this.requestRender(ev.action.id);
    });

    await settingsWritten;
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<CameraControlsSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.dialSurface.willDisappear(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.dropKeyRender(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<CameraControlsSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);

    if (ev.action.isDial()) {
      const settings = this.parseSettings(ev.payload.settings);

      // The running automation's own dial: its edited list and pick order
      // apply at once (spec decision 2); any other dial's edit is ignored. An
      // owning dial with no slot left on the gesture could never stop it, so
      // the edit stops it.
      if (dialOffersAutoGroup(settings.dial)) {
        updateAutoGroupSettings(
          ev.action.id,
          autoGroupNames(settings.dial.autoGroupSubset),
          settings.dial.autoGroupPick,
        );
      } else {
        this.stopAutoGroupOffered(ev.action.id, "dial");
      }

      await this.dialSurface.didReceiveSettings(ev.action, settings.dial);

      return;
    }

    await this.persistMigratedSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);

    // The running automation's own key: its edited list and pick order apply
    // at once (spec decision 2). Any other key's edit waits for its press. An
    // owning key moved to another mode could never stop it, so the edit stops it.
    if (settings.target === "auto-group") {
      updateAutoGroupSettings(ev.action.id, autoGroupNames(settings.autoGroupSubset), settings.autoGroupPick);
    } else {
      this.stopAutoGroupOffered(ev.action.id, "key");
    }

    await this.pushDeviceProfiles(ev, settings);
    await this.requestSettingsWrite(ev);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<CameraControlsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.target === "focus-select-car") {
      await this.executeFocusSelectCar(ev, settings);

      return;
    }

    if (settings.target === "auto-group") {
      this.toggleAutoGroupFor(ev.action.id, settings.autoGroupSubset, settings.autoGroupPick);

      return;
    }

    const ask = this.keyAsk(ev.action.id, settings.target);

    if (isCycleTarget(settings.target)) {
      this.executeCycle(settings.target, settings.direction, ask, settings.cameraGroupSubset);
    } else if (settings.target === "change-camera") {
      this.executeChangeCamera(settings, ask);
    } else {
      this.executeFocus(settings, ask);
    }
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<CameraControlsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.rotate(ev.action, settings.dial, ev.payload.ticks, ev.payload.pressed === true);
  }

  /**
   * The press shape of a dial press (#269), from the dial surface, which
   * classifies the release.
   */
  dialPressShape(ev: IDeckDialDownEvent<CameraControlsSettings>): PressShape {
    return this.dialSurface.pressShape(ev.action, this.parseSettings(ev.payload.settings).dial);
  }

  /** The press shape of a touch on the strip (#269), from the dial surface. */
  touchPressShape(ev: IDeckTouchTapEvent<CameraControlsSettings>): PressShape {
    return this.dialSurface.touchShape(
      ev.action,
      this.parseSettings(ev.payload.settings).dial,
      ev.payload.hold === true,
    );
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

  /**
   * Auto Group on Car Change's press (#1656, spec decision 2), from a key or a
   * dial gesture alike: off when `owner` runs the automation, otherwise on with
   * its own list and pick order, taking it over from any other key or dial.
   * The module logs what the press did. A start can fail only when the SDK
   * controller refuses the telemetry subscription; that is logged here and
   * leaves the automation off.
   */
  private toggleAutoGroupFor(
    owner: string,
    subset: string | Record<string, unknown> | undefined,
    pick: AutoGroupPick,
  ): void {
    try {
      toggleAutoGroup({ owner, names: autoGroupNames(subset), pick, logger: this.logger });
    } catch (err) {
      this.logger.warn(`Auto group could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Stops the automation when `contextId` owns it and its settings no longer
   * offer Auto Group (#1656): a key moved to another mode, a dial with no slot
   * left on the gesture. Nothing else could stop it then. The listener redraws
   * every key and dial as for any stop; a non-owner's edit changes nothing.
   */
  private stopAutoGroupOffered(contextId: string, control: "key" | "dial"): void {
    if (!isAutoGroupOwner(contextId)) return;

    this.logger.info(`Auto group stopped: its ${control} no longer offers it`);
    stopAutoGroup();
  }

  /**
   * The automation's owner changed: every Auto Group key of this instance
   * redraws its on or off look, and every dial its on marker.
   */
  private onAutoGroupOwnerChange(): void {
    for (const [contextId, settings] of this.activeContexts) {
      if (settings.target === "auto-group") this.requestRender(contextId);
    }

    this.dialSurface.refreshAutoGroup();
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

    // A Cycle Camera press whose subset names no group of this session has
    // nothing to send, and never replaces a switch waiting behind a jump.
    if (target === "cycle-camera" && !this.cycleCameraHasTarget(cameraGroupSubset)) return;

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
          // No number for the focused car (#1653 review). The sim's own cycle
          // would ignore the enabled groups and take the car index for a race
          // position, so nothing is sent; the next press, once the car has a
          // number, switches as usual.
          this.logger.info("Camera group switch skipped: the focused car has no car number");
          this.logger.debug(`carIdx: ${carIdx}, targetGroup: ${nextEntry.groupNum}`);
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
        // session (no car list). The walk takes CamCarIdx as read, as the
        // dial does, rather than `carIdx`, whose `?? 0` gives the raw SDK
        // calls the number they need: car index 0 is a listed competitor in
        // a session with no pace car, so an unknown camera car read as 0
        // would step from that car instead of entering at an end (#1072).
        const sessionInfo = this.sdkController.getSessionInfo();
        const cars = getAllCarNumbers(sessionInfo, true, true);
        const targetCar = computeCarNumberTarget(telemetry.CamCarIdx, cars, direction);

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

  /**
   * Whether a Cycle Camera press has a group to go to (#1653): the session's
   * groups cannot be read (the raw cycle fallback then runs), or the enabled
   * subset resolves to at least one of them. Logs, at the press and never per
   * tick, the names it had to skip as ambiguous and a press it skips.
   */
  private cycleCameraHasTarget(cameraGroupSubset?: string | Record<string, unknown>): boolean {
    const sessionGroups = this.readSessionGroupsFresh();

    if (sessionGroups.length === 0) return true;

    const resolved = resolveEnabledSessionGroups(getEnabledGroupNames(cameraGroupSubset), sessionGroups);

    if (resolved.ambiguous.length > 0) {
      this.logger.info("Camera cycle skipped group names that match more than one group in this session");
      this.logger.debug(`Ambiguous camera group names: ${resolved.ambiguous.join(", ")}`);
    }

    if (resolved.groups.length > 0) return true;

    this.logger.info("Camera cycle skipped: no enabled camera group in this session");

    return false;
  }

  /**
   * Change Camera, through {@link requestSwitch}: a switch of the angle only, so
   * it leaves a lap walk alone. A key whose group the session lacks has nothing
   * to send (#1653), and never replaces a switch waiting behind a jump; the
   * group is resolved again when the switch goes out, since a switch that
   * waited may meet another camera file.
   */
  private executeChangeCamera(settings: CameraControlsSettings, ask: CameraSwitchAsk): void {
    const target = this.resolveChangeCameraTarget(settings);

    if (target === null) return;

    this.requestSwitch(ask, { by: "change-camera", name: `${target.displayName} camera`, changesCar: false }, () =>
      this.sendChangeCamera(settings),
    );
  }

  /**
   * The group number a Change Camera key sends, and the group's name as the
   * session spells it, or null — logged — when it sends nothing.
   *
   * Resolved by NAME against the session (#958, #1653 decision 6): the sim
   * numbers its groups per content, so our stored number is only an index into
   * `CHANGE_CAMERA_GROUPS`. The raw stored number is sent only for a key with no
   * stored name whose session's groups cannot be read; a stored name has no
   * number of its own to fall back to.
   */
  private resolveChangeCameraTarget(
    settings: CameraControlsSettings,
  ): { groupNum: number; displayName: string } | null {
    const groupName = changeCameraGroupName(settings);
    const sessionGroups = this.readSessionGroupsFresh();

    if (sessionGroups.length === 0) {
      if (!hasStoredGroupName(settings)) return { groupNum: settings.cameraGroup, displayName: groupName };

      this.logger.info("Camera change skipped: the session's camera groups cannot be read");
      this.logger.debug(`Group "${groupName}" is stored by name and has no number to fall back to`);

      return null;
    }

    const match = matchSessionGroup(sessionGroups, groupName);

    if (match.kind === "found") return { groupNum: match.group.groupNum, displayName: match.group.groupName };

    this.logChangeCameraSkip(groupName, settings.cameraGroup, match);

    return null;
  }

  /** Logs a Change Camera press that names no group of the session, or more than one. */
  private logChangeCameraSkip(
    groupName: string,
    cameraGroup: number,
    match: Exclude<SessionGroupMatch, { kind: "found" }>,
  ): void {
    // The session lists its groups and this one is not among them (TV4 on road
    // content, a custom group of another track's camera file). Our own number
    // would pick an unrelated camera, so the press does nothing rather than
    // something wrong (#958).
    if (match.kind === "absent") {
      this.logger.info("Camera change skipped: group not in this session");
      this.logger.debug(`Group "${groupName}" (${cameraGroup}) is not in the session's camera groups`);

      return;
    }

    this.logger.info("Camera change skipped: group name matches more than one group in this session");
    this.logger.debug(
      `Group "${groupName}" matches ${match.candidates.map((g) => `"${g.groupName}" (${g.groupNum})`).join(", ")}`,
    );
  }

  /** Change Camera's switch, onto the car the camera is on when it goes out. */
  private sendChangeCamera(settings: CameraControlsSettings): void {
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("No telemetry available for change camera");

      return;
    }

    const target = this.resolveChangeCameraTarget(settings);

    if (target === null) return;

    const camera = getCommands().camera;
    const carIdx = telemetry.CamCarIdx ?? 0;
    const sessionInfo = this.sdkController.getSessionInfo();
    const carNumberRaw = sessionInfo ? getCarNumberRawFromSessionInfo(sessionInfo, carIdx) : null;

    if (carNumberRaw !== null) {
      const success = camera.switchNum(carNumberRaw, target.groupNum, 0);
      this.logger.info("Camera changed");
      this.logger.debug(`Result: ${success}, cameraGroup: ${target.groupNum} (${target.displayName})`);
    } else {
      this.logger.warn("Cannot change camera: car number not found in session info");
    }
  }

  /** The session's normalised camera groups, read now; empty with no session or no readable group list. */
  private readSessionGroupsFresh(): CameraGroup[] {
    const sessionInfo = this.sdkController.getSessionInfo();

    return sessionInfo ? normalizeSessionGroups(getCameraGroupsFromSessionInfo(sessionInfo)) : [];
  }

  /**
   * The session's normalised camera groups for a per-tick check, re-read only
   * when the session info is a new object — that is, when iRacing has
   * published an update.
   */
  private readSessionGroupsCached(): CameraGroup[] {
    const sessionInfo = this.sdkController.getSessionInfo();

    if (!sessionInfo) return [];

    if (this.sessionGroupsCache?.sessionInfo !== sessionInfo) {
      this.sessionGroupsCache = {
        sessionInfo,
        groups: normalizeSessionGroups(getCameraGroupsFromSessionInfo(sessionInfo)),
        unavailable: new Map(),
        autoGroupUnavailable: new Map(),
      };
    }

    return this.sessionGroupsCache.groups;
  }

  /**
   * Whether a Change Camera key's group is missing from the session, computed
   * once per name per session-info update: the per-tick check of every key
   * would otherwise re-run the name lookup, case-folding every group of a
   * 40-50 group file, on each tick for an answer that changes only with the
   * session info.
   */
  private isChangeCameraUnavailableCached(groupName: string): boolean {
    const groups = this.readSessionGroupsCached();
    const cache = this.sessionGroupsCache;

    // No session: never unavailable, and nothing to cache against.
    if (cache === null || groups.length === 0) return false;

    let unavailable = cache.unavailable.get(groupName);

    if (unavailable === undefined) {
      unavailable = isChangeCameraUnavailable(groupName, groups);
      cache.unavailable.set(groupName, unavailable);
    }

    return unavailable;
  }

  /**
   * Whether an Auto Group key's list leaves no candidate in the session (#1656,
   * spec decision 5): an empty list included, never with no session. Computed
   * once per list per session-info update, as for a Change Camera key's group,
   * since the key is drawn on every tick.
   */
  private isAutoGroupUnavailableCached(names: readonly string[]): boolean {
    const groups = this.readSessionGroupsCached();
    const cache = this.sessionGroupsCache;

    if (cache === null || groups.length === 0) return false;

    const key = JSON.stringify(names);
    let unavailable = cache.autoGroupUnavailable.get(key);

    if (unavailable === undefined) {
      unavailable = isAutoGroupUnavailable(names, groups);
      cache.autoGroupUnavailable.set(key, unavailable);
    }

    return unavailable;
  }

  /**
   * Write new settings to the key (#1653 review): its title and resting icon,
   * then — in the same pass — whatever telemetry-driven look the settings call
   * for. Resolves once the settings reached the key and the pass after them is
   * under way; rejects when the host refused the write, which the next tick
   * then retries. Newer settings that arrive before this write starts replace
   * it and take over its waiters.
   */
  private requestSettingsWrite(ev: KeyEvent): Promise<void> {
    const contextId = ev.action.id;
    let render = this.keyRenders.get(contextId);

    if (!render) {
      render = newKeyRender();
      this.keyRenders.set(contextId, render);
    }

    const state = render;
    state.settingsVersion++;

    return new Promise<void>((resolve, reject) => {
      const queued = state.settingsWrite;
      const waiters = queued && !queued.started ? queued.waiters : [];
      waiters.push({ resolve, reject });
      state.settingsWrite = { ev, waiters, started: false };
      this.requestRender(contextId);
    });
  }

  /** Forget a key's writer, releasing anyone still awaiting its settings. */
  private dropKeyRender(contextId: string): void {
    const render = this.keyRenders.get(contextId);

    if (!render) return;

    this.keyRenders.delete(contextId);
    const waiters = [
      ...render.settled.splice(0),
      ...(render.settingsInFlight?.waiters.splice(0) ?? []),
      ...(render.settingsWrite?.waiters.splice(0) ?? []),
    ];

    for (const waiter of waiters) waiter.resolve();
  }

  /**
   * Ask for a pass of the key's writer: a telemetry tick, or new settings. A
   * pass already running takes the request as a reason for one more pass.
   */
  private requestRender(contextId: string): void {
    const render = this.keyRenders.get(contextId);

    if (!render) return;

    if (render.running) {
      render.requested = true;

      return;
    }

    void this.runRenders(contextId, render);
  }

  /**
   * The key's single writer. Each pass writes pending settings first, or else
   * decides the key's look now and writes it unless the key shows it already.
   * It stops when the key shows its look, when its writer was replaced (the key
   * left), or after a refused write unless something asked again meanwhile — a
   * host that keeps refusing gets one write per request, not a busy loop.
   */
  private async runRenders(contextId: string, render: KeyRender): Promise<void> {
    render.running = true;

    try {
      for (;;) {
        render.requested = false;

        const settingsWrite = render.settingsWrite;
        let write: Promise<boolean>;

        if (settingsWrite) {
          write = this.writeSettingsLook(contextId, render, settingsWrite);
        } else {
          const look = this.computeLook(contextId, render);

          if (look === null || look.id === render.written?.id) return;

          write = this.writeLook(contextId, render, look);
        }

        // The next write is out: a settings handler awaiting an earlier one may go on.
        this.releaseSettled(render);
        const written = await write;

        if (this.keyRenders.get(contextId) !== render) return;

        if (!written && !render.requested) return;
      }
    } finally {
      render.running = false;
      this.releaseSettled(render);
    }
  }

  private releaseSettled(render: KeyRender): void {
    for (const waiter of render.settled.splice(0)) waiter.resolve();
  }

  /**
   * Write pending settings: the title cleared and the resting icon, through
   * the host event — which also gives the key its context, so no other write
   * can land before it. A refused write leaves the settings pending for the
   * next request and the key's look unknown.
   */
  private async writeSettingsLook(contextId: string, render: KeyRender, write: SettingsWrite): Promise<boolean> {
    write.started = true;

    const settings = this.activeContexts.get(contextId);

    if (!settings) {
      if (render.settingsWrite === write) render.settingsWrite = null;

      render.settled.push(...write.waiters.splice(0));

      return true;
    }

    const look = this.restingLook(contextId, settings, render.settingsVersion);
    render.settingsInFlight = write;

    try {
      await write.ev.action.setTitle("");

      // The key left while the title was out, and may be back under the same
      // context with a writer of its own (#1653 review): this write's settings
      // are no longer the key's, so its image never goes out.
      if (this.keyRenders.get(contextId) !== render) return true;

      await this.setKeyImage(write.ev, look.render());
    } catch (err) {
      write.started = false;
      render.written = null;

      for (const waiter of write.waiters.splice(0)) waiter.reject(err);

      return false;
    } finally {
      if (render.settingsInFlight === write) render.settingsInFlight = null;
    }

    if (render.settingsWrite === write) render.settingsWrite = null;

    render.settled.push(...write.waiters.splice(0));

    if (this.keyRenders.get(contextId) !== render) return true;

    render.written = look;
    this.setRegenerateCallback(contextId, look.render);

    return true;
  }

  /**
   * Write a look to the key. Only a write that went out records the look and
   * registers it for regeneration; a refused one leaves the key's look unknown,
   * so the next pass draws it again — or the grid, where there is no group to
   * judge by.
   */
  private async writeLook(contextId: string, render: KeyRender, look: KeyLook): Promise<boolean> {
    let written: boolean;

    try {
      written = await this.updateKeyImage(contextId, look.render());
    } catch (err) {
      // Debug, not warn: a host that keeps refusing would log this every tick.
      const target = this.activeContexts.get(contextId)?.target;
      const which = (target && REDRAWN_KEY_NAMES[target]) ?? "Camera Controls";
      this.logger.debug(`Failed to redraw a ${which} key: ${err instanceof Error ? err.message : err}`);
      written = false;
    }

    if (this.keyRenders.get(contextId) !== render) return false;

    if (written === false) {
      render.written = null;

      return false;
    }

    render.written = look;
    this.setRegenerateCallback(contextId, look.render);

    return true;
  }

  /**
   * The look the key should show now, or null to leave it as it is.
   *
   * A Change Camera key shows its icon, drawn unavailable while the session
   * lacks its group (#1653, spec decision 8); any other key but Cycle Camera
   * its resting icon. A Cycle Camera key shows the group the next press
   * selects, or — with Icon Shows = Current camera (#959) — the group the sim
   * is on now, even outside the key's enabled subset, since that is still
   * what is on screen; and its configured grid with no telemetry, or with no
   * group to preview.
   */
  private computeLook(contextId: string, render: KeyRender): KeyLook | null {
    const settings = this.activeContexts.get(contextId);

    if (!settings) return null;

    const version = render.settingsVersion;

    if (settings.target !== "cycle-camera") return this.restingLook(contextId, settings, version);

    const telemetry = this.sdkController.getCurrentTelemetry();

    // Connection lost: the grid, in place of a telemetry-driven icon — greyed
    // for a Current camera key whose enabled groups the session still lists
    // none of, since a press stays unusable (#1653 review). An unreadable list
    // and the next-group look keep the normal grid.
    if (!telemetry) {
      if (settings.cycleIconMode !== "current") return this.restingLook(contextId, settings, version);

      const groups = this.readSessionGroupsFresh();
      const unusable = isCycleCameraUnavailable(getEnabledGroupNames(settings.cameraGroupSubset), groups);

      return unusable ? this.groupLook(settings, version, "", true) : this.restingLook(contextId, settings, version);
    }

    const sessionGroups = this.readSessionGroupsFresh();

    if (sessionGroups.length === 0) {
      // No readable group list, so nothing to judge availability by (#1653
      // review). In Current camera mode, a group icon drawn available stays
      // until there is a list to judge it by: it still says what is on screen.
      // A next-group preview does not — the next press takes the sim's own
      // cycle, not the previewed group — and anything else, a greyed icon or
      // a look the key may not show after a refused write, goes back to the
      // configured grid.
      const shown = render.written;

      if (
        settings.cycleIconMode === "current" &&
        shown?.kind === "group" &&
        !shown.unavailable &&
        shown.version === version
      ) {
        return null;
      }

      return this.restingLook(contextId, settings, version);
    }

    if (settings.cycleIconMode === "current") {
      // A group number the telemetry does not report, or the session does not
      // list, has no name to show; the empty name draws the key's placeholder
      // rather than a guess. With no enabled group in this session the key
      // shows what is on screen greyed, since a press would cycle nowhere.
      const camGroup = telemetry.CamGroupNumber;
      const name = camGroup === undefined ? "" : (findSessionGroupByNum(sessionGroups, camGroup)?.groupName ?? "");
      const unavailable = isCycleCameraUnavailable(getEnabledGroupNames(settings.cameraGroupSubset), sessionGroups);

      return this.groupLook(settings, version, name, unavailable);
    }

    const groupNum = telemetry.CamGroupNumber ?? 1;
    const dir = settings.direction === "next" ? 1 : -1;
    const enabledNames = getEnabledGroupNames(settings.cameraGroupSubset);
    const nextEntry = getNextSelectedGroupEntry(groupNum, enabledNames, sessionGroups, dir);

    // No enabled group in this session, so no next group to preview (#1653
    // review): a press does nothing, and the key shows its configured grid.
    if (!nextEntry) return this.restingLook(contextId, settings, version);

    return this.groupLook(settings, version, nextEntry.groupName, false);
  }

  /**
   * A key's resting icon. A Change Camera key's is drawn unavailable while the
   * session lacks its group (#1653); the binding state is read when it is drawn.
   *
   * An Auto Group key's (#1656) is its tri-state toggle: on only while this key
   * owns the running automation, N/A while its list leaves no candidate in the
   * session (owner or not), off otherwise. Ownership and the N/A condition are
   * both in the look's id, so an owner change, which redraws the key, and a
   * session update that flips the candidates each write it once.
   */
  private restingLook(contextId: string, settings: CameraControlsSettings, version: number): KeyLook {
    const { unavailable, autoGroupOwner, autoGroupNoCandidate } = this.restingState(contextId, settings);
    const autoGroupState = autoGroupKeyState(autoGroupOwner, autoGroupNoCandidate);

    return {
      id: `rest:${version}:${unavailable ? 1 : 0}:${autoGroupOwner ? 1 : 0}:${autoGroupNoCandidate ? 1 : 0}`,
      version,
      kind: "rest",
      unavailable,
      render: () => {
        // Per-BUTTON missing-binding state (#612): computed from this button's
        // own mode, so one unbound Cycle Sub-Camera key never marks the
        // SDK-driven camera keys around it.
        const bindingMissing = this.isBindingMissing(resolveBindingKey(settings.target, settings.direction));

        return generateCameraControlsSvg(settings, bindingMissing, unavailable, autoGroupState);
      },
    };
  }

  /**
   * What a key's resting icon depends on beyond its settings, read now. An
   * Auto Group key is never `unavailable` (#1656): its N/A state is the
   * tri-state toggle's own answer to the same condition.
   */
  private restingState(
    contextId: string,
    settings: CameraControlsSettings,
  ): { unavailable: boolean; autoGroupOwner: boolean; autoGroupNoCandidate: boolean } {
    switch (settings.target) {
      case "change-camera":
        return {
          unavailable: this.isChangeCameraUnavailableCached(changeCameraGroupName(settings)),
          autoGroupOwner: false,
          autoGroupNoCandidate: false,
        };
      case "auto-group":
        return {
          unavailable: false,
          autoGroupOwner: isAutoGroupOwner(contextId),
          autoGroupNoCandidate: this.isAutoGroupUnavailableCached(autoGroupNames(settings.autoGroupSubset)),
        };
      default:
        return { unavailable: false, autoGroupOwner: false, autoGroupNoCandidate: false };
    }
  }

  /** A Cycle Camera key's group icon. */
  private groupLook(settings: CameraControlsSettings, version: number, name: string, unavailable: boolean): KeyLook {
    return {
      id: `group:${version}:${unavailable ? 1 : 0}:${name}`,
      version,
      kind: "group",
      unavailable,
      render: () => generateCameraSelectSvg(name, settings, unavailable),
    };
  }
}

// Backward-compatible alias
export { CameraControls as CameraFocus };
