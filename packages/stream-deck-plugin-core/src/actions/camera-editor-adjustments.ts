import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import z from "zod";

import cameraEditorAdjustmentsTemplate from "../../icons/camera-editor-adjustments.svg";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  getGlobalSettings,
  getKeyboard,
  type KeyBindingValue,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  LogLevel,
  parseKeyBinding,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";

const WHITE = "#ffffff";
const GRAY = "#888888";

const ADJUSTMENT_VALUES = [
  "latitude",
  "longitude",
  "altitude",
  "yaw",
  "pitch",
  "fov-zoom",
  "key-step",
  "vanish-x",
  "vanish-y",
  "blimp-radius",
  "blimp-velocity",
  "mic-gain",
  "auto-set-mic-gain",
  "f-number",
  "focus-depth",
] as const;

type AdjustmentType = (typeof ADJUSTMENT_VALUES)[number];
type DirectionType = "increase" | "decrease";

/**
 * Label configuration for each adjustment + direction combination.
 * Inverted layout: line1 = primary (bold, bottom), line2 = secondary (subdued, top).
 */
const CAMERA_EDITOR_LABELS: Record<AdjustmentType, Record<DirectionType, { line1: string; line2: string }>> = {
  latitude: {
    increase: { line1: "+", line2: "LATITUDE" },
    decrease: { line1: "-", line2: "LATITUDE" },
  },
  longitude: {
    increase: { line1: "+", line2: "LONGITUDE" },
    decrease: { line1: "-", line2: "LONGITUDE" },
  },
  altitude: {
    increase: { line1: "+", line2: "ALTITUDE" },
    decrease: { line1: "-", line2: "ALTITUDE" },
  },
  yaw: {
    increase: { line1: "+", line2: "YAW" },
    decrease: { line1: "-", line2: "YAW" },
  },
  pitch: {
    increase: { line1: "+", line2: "PITCH" },
    decrease: { line1: "-", line2: "PITCH" },
  },
  "fov-zoom": {
    increase: { line1: "+", line2: "FOV ZOOM" },
    decrease: { line1: "-", line2: "FOV ZOOM" },
  },
  "key-step": {
    increase: { line1: "+", line2: "KEY STEP" },
    decrease: { line1: "-", line2: "KEY STEP" },
  },
  "vanish-x": {
    increase: { line1: "+", line2: "VANISH X" },
    decrease: { line1: "-", line2: "VANISH X" },
  },
  "vanish-y": {
    increase: { line1: "+", line2: "VANISH Y" },
    decrease: { line1: "-", line2: "VANISH Y" },
  },
  "blimp-radius": {
    increase: { line1: "+", line2: "BLIMP RAD" },
    decrease: { line1: "-", line2: "BLIMP RAD" },
  },
  "blimp-velocity": {
    increase: { line1: "+", line2: "BLIMP VEL" },
    decrease: { line1: "-", line2: "BLIMP VEL" },
  },
  "mic-gain": {
    increase: { line1: "+", line2: "MIC GAIN" },
    decrease: { line1: "-", line2: "MIC GAIN" },
  },
  "auto-set-mic-gain": {
    increase: { line1: "AUTO", line2: "MIC GAIN" },
    decrease: { line1: "AUTO", line2: "MIC GAIN" },
  },
  "f-number": {
    increase: { line1: "+", line2: "F-NUMBER" },
    decrease: { line1: "-", line2: "F-NUMBER" },
  },
  "focus-depth": {
    increase: { line1: "+", line2: "FOCUS DEPTH" },
    decrease: { line1: "-", line2: "FOCUS DEPTH" },
  },
};

/**
 * SVG icon content for each adjustment type, grouped by concept.
 */
const CAMERA_EDITOR_ICONS: Record<AdjustmentType, Record<DirectionType, string>> = {
  // Position group: Camera with XYZ axis arrows
  latitude: {
    increase: `
    <rect x="18" y="12" width="24" height="18" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="42,15 54,9 54,33 42,27" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <line x1="30" y1="30" x2="40" y2="30" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="37,27 40,30 37,33" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="18" y="12" width="24" height="18" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="42,15 54,9 54,33 42,27" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <line x1="30" y1="30" x2="20" y2="30" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="23,27 20,30 23,33" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  longitude: {
    increase: `
    <rect x="18" y="12" width="24" height="18" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="42,15 54,9 54,33 42,27" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <line x1="30" y1="30" x2="30" y2="40" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="27,37 30,40 33,37" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="18" y="12" width="24" height="18" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="42,15 54,9 54,33 42,27" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <line x1="30" y1="40" x2="30" y2="30" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="27,33 30,30 33,33" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  altitude: {
    increase: `
    <rect x="18" y="14" width="24" height="18" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="42,17 54,11 54,35 42,29" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <line x1="14" y1="32" x2="14" y2="12" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="11,15 14,12 17,15" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="18" y="14" width="24" height="18" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="42,17 54,11 54,35 42,29" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <line x1="14" y1="12" x2="14" y2="32" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="11,29 14,32 17,29" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  // Rotation group: Camera with rotation arcs
  yaw: {
    increase: `
    <rect x="22" y="14" width="20" height="16" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="42,17 52,12 52,32 42,27" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M24 38 A12 6 0 0 1 48 38" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <polyline points="45,35 48,38 45,41" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="22" y="14" width="20" height="16" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="42,17 52,12 52,32 42,27" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M48 38 A12 6 0 0 1 24 38" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <polyline points="27,35 24,38 27,41" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  pitch: {
    increase: `
    <rect x="22" y="16" width="20" height="16" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="42,19 52,14 52,34 42,29" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M56 34 A8 12 0 0 0 56 10" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <polyline points="53,13 56,10 59,13" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="22" y="16" width="20" height="16" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="42,19 52,14 52,34 42,29" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M56 10 A8 12 0 0 1 56 34" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <polyline points="53,31 56,34 59,31" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  // Zoom/FOV group: Lens with zoom indicator
  "fov-zoom": {
    increase: `
    <circle cx="32" cy="22" r="12" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="32" cy="22" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="32" cy="22" r="2" fill="${WHITE}"/>
    <line x1="50" y1="22" x2="58" y2="22" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="54" y1="18" x2="54" y2="26" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>`,
    decrease: `
    <circle cx="32" cy="22" r="12" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="32" cy="22" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="32" cy="22" r="2" fill="${WHITE}"/>
    <line x1="50" y1="22" x2="58" y2="22" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>`,
  },
  "key-step": {
    increase: `
    <rect x="14" y="12" width="44" height="4" rx="1" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <rect x="14" y="12" width="28" height="4" rx="1" fill="${WHITE}" fill-opacity="0.3"/>
    <line x1="20" y1="24" x2="20" y2="38" stroke="${GRAY}" stroke-width="1" stroke-dasharray="2,2"/>
    <line x1="36" y1="24" x2="36" y2="38" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="52" y1="24" x2="52" y2="38" stroke="${GRAY}" stroke-width="1" stroke-dasharray="2,2"/>
    <polyline points="33,28 36,24 39,28" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="14" y="12" width="44" height="4" rx="1" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <rect x="14" y="12" width="28" height="4" rx="1" fill="${WHITE}" fill-opacity="0.3"/>
    <line x1="20" y1="24" x2="20" y2="38" stroke="${GRAY}" stroke-width="1" stroke-dasharray="2,2"/>
    <line x1="36" y1="24" x2="36" y2="38" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="52" y1="24" x2="52" y2="38" stroke="${GRAY}" stroke-width="1" stroke-dasharray="2,2"/>
    <polyline points="33,34 36,38 39,34" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  // Vanish point group: Perspective grid lines
  "vanish-x": {
    increase: `
    <circle cx="36" cy="22" r="2" fill="${WHITE}"/>
    <line x1="36" y1="22" x2="14" y2="10" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="22" x2="14" y2="34" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="22" x2="58" y2="10" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="22" x2="58" y2="34" stroke="${GRAY}" stroke-width="1"/>
    <line x1="40" y1="22" x2="54" y2="22" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="51,19 54,22 51,25" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="36" cy="22" r="2" fill="${WHITE}"/>
    <line x1="36" y1="22" x2="14" y2="10" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="22" x2="14" y2="34" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="22" x2="58" y2="10" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="22" x2="58" y2="34" stroke="${GRAY}" stroke-width="1"/>
    <line x1="32" y1="22" x2="18" y2="22" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="21,19 18,22 21,25" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  "vanish-y": {
    increase: `
    <circle cx="36" cy="22" r="2" fill="${WHITE}"/>
    <line x1="36" y1="22" x2="14" y2="10" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="22" x2="14" y2="34" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="22" x2="58" y2="10" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="22" x2="58" y2="34" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="18" x2="36" y2="10" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="33,13 36,10 39,13" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="36" cy="22" r="2" fill="${WHITE}"/>
    <line x1="36" y1="22" x2="14" y2="10" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="22" x2="14" y2="34" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="22" x2="58" y2="10" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="22" x2="58" y2="34" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="26" x2="36" y2="38" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="33,35 36,38 39,35" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  // Blimp group: Circular orbit path
  "blimp-radius": {
    increase: `
    <circle cx="36" cy="22" r="14" fill="none" stroke="${GRAY}" stroke-width="1" stroke-dasharray="3,3"/>
    <circle cx="36" cy="22" r="3" fill="${WHITE}"/>
    <circle cx="50" cy="22" r="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="52" y1="22" x2="58" y2="22" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="55,19 58,22 55,25" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="36" cy="22" r="14" fill="none" stroke="${GRAY}" stroke-width="1" stroke-dasharray="3,3"/>
    <circle cx="36" cy="22" r="3" fill="${WHITE}"/>
    <circle cx="50" cy="22" r="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="48" y1="22" x2="42" y2="22" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="45,19 42,22 45,25" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  "blimp-velocity": {
    increase: `
    <circle cx="36" cy="22" r="14" fill="none" stroke="${GRAY}" stroke-width="1" stroke-dasharray="3,3"/>
    <circle cx="36" cy="22" r="3" fill="${WHITE}"/>
    <circle cx="22" cy="22" r="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <path d="M20 20 A14 14 0 0 1 46 12" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polyline points="43,10 46,12 44,15" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="36" cy="22" r="14" fill="none" stroke="${GRAY}" stroke-width="1" stroke-dasharray="3,3"/>
    <circle cx="36" cy="22" r="3" fill="${WHITE}"/>
    <circle cx="22" cy="22" r="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <path d="M20 20 A14 14 0 0 1 46 12" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <path d="M20 24 A14 14 0 0 0 30 34" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polyline points="27,32 30,34 28,37" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  // Audio group: Microphone icon
  "mic-gain": {
    increase: `
    <rect x="30" y="10" width="12" height="18" rx="6" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <path d="M24 24 A12 10 0 0 0 48 24" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="34" x2="36" y2="38" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="54" y1="18" x2="54" y2="26" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="50" y1="22" x2="58" y2="22" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>`,
    decrease: `
    <rect x="30" y="10" width="12" height="18" rx="6" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <path d="M24 24 A12 10 0 0 0 48 24" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="34" x2="36" y2="38" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="50" y1="22" x2="58" y2="22" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>`,
  },
  "auto-set-mic-gain": {
    increase: `
    <rect x="30" y="10" width="12" height="18" rx="6" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <path d="M24 24 A12 10 0 0 0 48 24" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="34" x2="36" y2="38" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <text x="54" y="22" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">A</text>`,
    decrease: `
    <rect x="30" y="10" width="12" height="18" rx="6" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <path d="M24 24 A12 10 0 0 0 48 24" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="36" y1="34" x2="36" y2="38" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <text x="54" y="22" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">A</text>`,
  },
  // Depth-of-field group: Aperture/iris blades
  "f-number": {
    increase: `
    <circle cx="36" cy="22" r="14" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <polygon points="36,10 44,14 44,30 36,34 28,30 28,14" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="36" cy="22" r="5" fill="none" stroke="${WHITE}" stroke-width="1"/>
    <line x1="54" y1="18" x2="54" y2="26" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="50" y1="22" x2="58" y2="22" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>`,
    decrease: `
    <circle cx="36" cy="22" r="14" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <polygon points="36,10 44,14 44,30 36,34 28,30 28,14" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="36" cy="22" r="5" fill="none" stroke="${WHITE}" stroke-width="1"/>
    <line x1="50" y1="22" x2="58" y2="22" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>`,
  },
  "focus-depth": {
    increase: `
    <circle cx="26" cy="22" r="8" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="26" cy="22" r="3" fill="${WHITE}"/>
    <circle cx="48" cy="22" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="48" cy="22" r="2" fill="${GRAY}"/>
    <line x1="36" y1="36" x2="46" y2="36" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="43,33 46,36 43,39" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="26" cy="22" r="8" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="26" cy="22" r="3" fill="${GRAY}"/>
    <circle cx="48" cy="22" r="6" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="48" cy="22" r="2" fill="${WHITE}"/>
    <line x1="36" y1="36" x2="26" y2="36" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="29,33 26,36 29,39" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
};

/**
 * @internal Exported for testing
 *
 * Mapping from adjustment + direction to global settings keys.
 */
export const CAMERA_EDITOR_GLOBAL_KEYS: Record<AdjustmentType, Record<DirectionType, string>> = {
  latitude: { increase: "camEditLatitudeIncrease", decrease: "camEditLatitudeDecrease" },
  longitude: { increase: "camEditLongitudeIncrease", decrease: "camEditLongitudeDecrease" },
  altitude: { increase: "camEditAltitudeIncrease", decrease: "camEditAltitudeDecrease" },
  yaw: { increase: "camEditYawIncrease", decrease: "camEditYawDecrease" },
  pitch: { increase: "camEditPitchIncrease", decrease: "camEditPitchDecrease" },
  "fov-zoom": { increase: "camEditFovZoomIncrease", decrease: "camEditFovZoomDecrease" },
  "key-step": { increase: "camEditKeyStepIncrease", decrease: "camEditKeyStepDecrease" },
  "vanish-x": { increase: "camEditVanishXIncrease", decrease: "camEditVanishXDecrease" },
  "vanish-y": { increase: "camEditVanishYIncrease", decrease: "camEditVanishYDecrease" },
  "blimp-radius": { increase: "camEditBlimpRadiusIncrease", decrease: "camEditBlimpRadiusDecrease" },
  "blimp-velocity": { increase: "camEditBlimpVelocityIncrease", decrease: "camEditBlimpVelocityDecrease" },
  "mic-gain": { increase: "camEditMicGainIncrease", decrease: "camEditMicGainDecrease" },
  "auto-set-mic-gain": { increase: "camEditAutoSetMicGain", decrease: "camEditAutoSetMicGain" },
  "f-number": { increase: "camEditFNumberIncrease", decrease: "camEditFNumberDecrease" },
  "focus-depth": { increase: "camEditFocusDepthIncrease", decrease: "camEditFocusDepthDecrease" },
};

const CameraEditorAdjustmentsSettings = z.object({
  adjustment: z.enum(ADJUSTMENT_VALUES).default("latitude"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type CameraEditorAdjustmentsSettings = z.infer<typeof CameraEditorAdjustmentsSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the camera editor adjustments action.
 */
export function generateCameraEditorAdjustmentsSvg(settings: CameraEditorAdjustmentsSettings): string {
  const { adjustment, direction } = settings;

  const iconContent = CAMERA_EDITOR_ICONS[adjustment]?.[direction] || CAMERA_EDITOR_ICONS.latitude.increase;
  const labels = CAMERA_EDITOR_LABELS[adjustment]?.[direction] || CAMERA_EDITOR_LABELS.latitude.increase;

  const svg = renderIconTemplate(cameraEditorAdjustmentsTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Camera Editor Adjustments Action
 * Adjusts camera position, rotation, zoom, and other editor parameters via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.camera-editor-adjustments" })
export class CameraEditorAdjustments extends ConnectionStateAwareAction<CameraEditorAdjustmentsSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("CameraEditorAdjustments"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAdjustment(settings.adjustment, settings.direction);
  }

  override async onDialDown(ev: DialDownEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAdjustment(settings.adjustment, settings.direction);
  }

  override async onDialRotate(ev: DialRotateEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);

    // Auto Set Mic Gain has no directional adjustment — ignore rotation
    if (settings.adjustment === "auto-set-mic-gain") {
      this.logger.debug("Rotation ignored for Auto Set Mic Gain");

      return;
    }

    // Clockwise (ticks > 0) = increase, Counter-clockwise (ticks < 0) = decrease
    const direction: DirectionType = ev.payload.ticks > 0 ? "increase" : "decrease";
    await this.executeAdjustment(settings.adjustment, direction);
  }

  private parseSettings(settings: unknown): CameraEditorAdjustmentsSettings {
    const parsed = CameraEditorAdjustmentsSettings.safeParse(settings);

    return parsed.success ? parsed.data : CameraEditorAdjustmentsSettings.parse({});
  }

  private async executeAdjustment(adjustment: AdjustmentType, direction: DirectionType): Promise<void> {
    this.logger.info("Adjustment triggered");
    this.logger.debug(`Executing ${adjustment} ${direction}`);

    const settingKey = CAMERA_EDITOR_GLOBAL_KEYS[adjustment]?.[direction];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${adjustment} ${direction}`);

      return;
    }

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return;
    }

    this.logger.debug(`Key binding for ${settingKey}: ${formatKeyBinding(binding)} (code=${binding.code ?? "none"})`);

    await this.sendKeyBinding(binding);
  }

  private async sendKeyBinding(binding: KeyBindingValue): Promise<void> {
    const combination: KeyCombination = {
      key: binding.key as KeyboardKey,
      modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
      code: binding.code,
    };

    const success = await getKeyboard().sendKeyCombination(combination);

    if (success) {
      this.logger.info("Key sent successfully");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to send key");
      this.logger.debug(`Failed key combination: ${formatKeyBinding(binding)}`);
    }
  }

  private async updateDisplay(
    ev: WillAppearEvent<CameraEditorAdjustmentsSettings> | DidReceiveSettingsEvent<CameraEditorAdjustmentsSettings>,
    settings: CameraEditorAdjustmentsSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateCameraEditorAdjustmentsSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
