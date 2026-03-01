import streamDeck, {
  action,
  DialDownEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import z from "zod";

import cameraEditorControlsTemplate from "../../icons/camera-editor-controls.svg";
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

const CONTROL_VALUES = [
  "open-camera-tool",
  "key-acceleration-toggle",
  "key-10x-toggle",
  "parabolic-mic-toggle",
  "cycle-position-type",
  "cycle-aim-type",
  "acquire-start",
  "acquire-end",
  "temporary-edits-toggle",
  "dampening-toggle",
  "zoom-toggle",
  "beyond-fence-toggle",
  "in-cockpit-toggle",
  "mouse-navigation-toggle",
  "pitch-gyro-toggle",
  "roll-gyro-toggle",
  "limit-shot-range-toggle",
  "show-camera-toggle",
  "shot-selection-toggle",
  "manual-focus-toggle",
  "insert-camera",
  "remove-camera",
  "copy-camera",
  "paste-camera",
  "copy-group",
  "paste-group",
  "save-track-camera",
  "load-track-camera",
  "save-car-camera",
  "load-car-camera",
] as const;

type ControlType = (typeof CONTROL_VALUES)[number];

/**
 * Label configuration for each control.
 * Inverted layout: line1 = primary (bold, bottom), line2 = secondary (subdued, top).
 */
const CAMERA_EDITOR_CONTROLS_LABELS: Record<ControlType, { line1: string; line2: string }> = {
  "open-camera-tool": { line1: "OPEN", line2: "CAM TOOL" },
  "key-acceleration-toggle": { line1: "KEY ACCEL", line2: "TOGGLE" },
  "key-10x-toggle": { line1: "KEY 10X", line2: "TOGGLE" },
  "parabolic-mic-toggle": { line1: "PARA MIC", line2: "TOGGLE" },
  "cycle-position-type": { line1: "POS TYPE", line2: "CYCLE" },
  "cycle-aim-type": { line1: "AIM TYPE", line2: "CYCLE" },
  "acquire-start": { line1: "ACQ START", line2: "ACQUIRE" },
  "acquire-end": { line1: "ACQ END", line2: "ACQUIRE" },
  "temporary-edits-toggle": { line1: "TEMP EDIT", line2: "TOGGLE" },
  "dampening-toggle": { line1: "DAMPEN", line2: "TOGGLE" },
  "zoom-toggle": { line1: "ZOOM", line2: "TOGGLE" },
  "beyond-fence-toggle": { line1: "BND FENCE", line2: "TOGGLE" },
  "in-cockpit-toggle": { line1: "IN COCKPIT", line2: "TOGGLE" },
  "mouse-navigation-toggle": { line1: "MOUSE NAV", line2: "TOGGLE" },
  "pitch-gyro-toggle": { line1: "PITCH GYRO", line2: "TOGGLE" },
  "roll-gyro-toggle": { line1: "ROLL GYRO", line2: "TOGGLE" },
  "limit-shot-range-toggle": { line1: "SHOT RNG", line2: "TOGGLE" },
  "show-camera-toggle": { line1: "SHOW CAM", line2: "TOGGLE" },
  "shot-selection-toggle": { line1: "SHOT SEL", line2: "TOGGLE" },
  "manual-focus-toggle": { line1: "MAN FOCUS", line2: "TOGGLE" },
  "insert-camera": { line1: "INSERT", line2: "CAMERA" },
  "remove-camera": { line1: "REMOVE", line2: "CAMERA" },
  "copy-camera": { line1: "COPY", line2: "CAMERA" },
  "paste-camera": { line1: "PASTE", line2: "CAMERA" },
  "copy-group": { line1: "COPY", line2: "GROUP" },
  "paste-group": { line1: "PASTE", line2: "GROUP" },
  "save-track-camera": { line1: "SAVE", line2: "TRACK CAM" },
  "load-track-camera": { line1: "LOAD", line2: "TRACK CAM" },
  "save-car-camera": { line1: "SAVE", line2: "CAR CAM" },
  "load-car-camera": { line1: "LOAD", line2: "CAR CAM" },
};

/**
 * SVG icon content for each control type.
 */
const CAMERA_EDITOR_CONTROLS_ICONS: Record<ControlType, string> = {
  // Tool: Camera body with wrench
  "open-camera-tool": `
    <rect x="18" y="12" width="24" height="18" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="42,15 54,9 54,33 42,27" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="30" cy="21" r="5" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="30" cy="21" r="2" fill="${WHITE}"/>`,

  // Key Input: Key shape with speed lines
  "key-acceleration-toggle": `
    <rect x="24" y="12" width="24" height="18" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <text x="36" y="22" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">KEY</text>
    <line x1="18" y1="18" x2="22" y2="18" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="16" y1="22" x2="22" y2="22" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="18" y1="26" x2="22" y2="26" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>`,

  // Key Input: Key shape with "10x" text
  "key-10x-toggle": `
    <rect x="24" y="12" width="24" height="18" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <text x="36" y="22" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">10x</text>`,

  // Audio: Parabolic dish
  "parabolic-mic-toggle": `
    <path d="M22 12 Q36 28 50 12" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="36" y1="20" x2="36" y2="36" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="36" cy="20" r="2" fill="${WHITE}"/>
    <path d="M30 38 L42 38" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>`,

  // Cycle: Circular arrow with "P"
  "cycle-position-type": `
    <circle cx="36" cy="22" r="12" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <path d="M36 10 A12 12 0 1 1 24 22" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="22,18 24,22 28,20" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="36" y="24" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="10" font-weight="bold">P</text>`,

  // Cycle: Circular arrow with crosshair
  "cycle-aim-type": `
    <circle cx="36" cy="22" r="12" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <path d="M36 10 A12 12 0 1 1 24 22" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="22,18 24,22 28,20" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="36" cy="22" r="4" fill="none" stroke="${WHITE}" stroke-width="1"/>
    <line x1="36" y1="16" x2="36" y2="18" stroke="${WHITE}" stroke-width="1" stroke-linecap="round"/>
    <line x1="36" y1="26" x2="36" y2="28" stroke="${WHITE}" stroke-width="1" stroke-linecap="round"/>
    <line x1="30" y1="22" x2="32" y2="22" stroke="${WHITE}" stroke-width="1" stroke-linecap="round"/>
    <line x1="40" y1="22" x2="42" y2="22" stroke="${WHITE}" stroke-width="1" stroke-linecap="round"/>`,

  // Acquire: Timeline with left bracket
  "acquire-start": `
    <line x1="16" y1="22" x2="56" y2="22" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="28" y1="14" x2="28" y2="30" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="28" y1="14" x2="34" y2="14" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="28" y1="30" x2="34" y2="30" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="38,18 42,22 38,26" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,

  // Acquire: Timeline with right bracket
  "acquire-end": `
    <line x1="16" y1="22" x2="56" y2="22" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="44" y1="14" x2="44" y2="30" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="38" y1="14" x2="44" y2="14" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="38" y1="30" x2="44" y2="30" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="34,18 30,22 34,26" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,

  // Toggle: Pencil with clock indicator
  "temporary-edits-toggle": `
    <line x1="20" y1="36" x2="42" y2="14" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="20" y1="36" x2="22" y2="30" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="20" y1="36" x2="26" y2="34" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="50" cy="30" r="8" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="50" y1="30" x2="50" y2="25" stroke="${WHITE}" stroke-width="1" stroke-linecap="round"/>
    <line x1="50" y1="30" x2="54" y2="30" stroke="${WHITE}" stroke-width="1" stroke-linecap="round"/>`,

  // Toggle: Damped sine wave
  "dampening-toggle": `
    <path d="M16 22 Q22 10 28 22 Q34 34 40 22 Q44 16 48 22 Q50 26 52 22 Q54 20 56 22"
          fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="16" y1="36" x2="56" y2="36" stroke="${GRAY}" stroke-width="1" stroke-linecap="round"/>`,

  // Toggle: Magnifying glass
  "zoom-toggle": `
    <circle cx="32" cy="20" r="10" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="39" y1="27" x2="50" y2="38" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="28" y1="20" x2="36" y2="20" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="32" y1="16" x2="32" y2="24" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>`,

  // Toggle: Fence with arrow going over
  "beyond-fence-toggle": `
    <line x1="16" y1="34" x2="16" y2="14" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="30" y1="34" x2="30" y2="14" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="16" y1="20" x2="30" y2="20" stroke="${GRAY}" stroke-width="1"/>
    <line x1="16" y1="28" x2="30" y2="28" stroke="${GRAY}" stroke-width="1"/>
    <path d="M36 30 Q42 8 54 16" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="50,12 54,16 50,18" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,

  // Toggle: Steering wheel outline
  "in-cockpit-toggle": `
    <circle cx="36" cy="22" r="14" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="22" r="4" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="22" y1="22" x2="32" y2="22" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="40" y1="22" x2="50" y2="22" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="36" y1="26" x2="36" y2="36" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>`,

  // Toggle: Mouse cursor with arrows
  "mouse-navigation-toggle": `
    <polygon points="28,12 28,32 33,27 38,36 42,34 37,25 44,25" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <line x1="48" y1="18" x2="56" y2="18" stroke="${GRAY}" stroke-width="1" stroke-linecap="round"/>
    <polyline points="53,15 56,18 53,21" fill="none" stroke="${GRAY}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="48" y1="30" x2="56" y2="30" stroke="${GRAY}" stroke-width="1" stroke-linecap="round"/>
    <polyline points="53,27 56,30 53,33" fill="none" stroke="${GRAY}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>`,

  // Toggle: Vertical rotation arc
  "pitch-gyro-toggle": `
    <path d="M36 10 A16 16 0 0 1 36 38" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M36 38 A16 16 0 0 1 36 10" fill="none" stroke="${GRAY}" stroke-width="1" stroke-dasharray="3,3"/>
    <polyline points="33,13 36,10 39,13" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="36" cy="24" r="2" fill="${WHITE}"/>`,

  // Toggle: Angled rotation arc
  "roll-gyro-toggle": `
    <path d="M20 30 A16 12 30 0 1 52 30" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M52 30 A16 12 30 0 1 20 30" fill="none" stroke="${GRAY}" stroke-width="1" stroke-dasharray="3,3"/>
    <polyline points="23,27 20,30 24,32" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="36" cy="22" r="2" fill="${WHITE}"/>`,

  // Toggle: Bounded line segment
  "limit-shot-range-toggle": `
    <line x1="20" y1="22" x2="52" y2="22" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="20" y1="16" x2="20" y2="28" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="52" y1="16" x2="52" y2="28" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="14" y1="22" x2="18" y2="22" stroke="${GRAY}" stroke-width="1" stroke-dasharray="2,2"/>
    <line x1="54" y1="22" x2="58" y2="22" stroke="${GRAY}" stroke-width="1" stroke-dasharray="2,2"/>`,

  // Toggle: Eye/visibility icon
  "show-camera-toggle": `
    <path d="M14 22 Q36 8 58 22 Q36 36 14 22 Z" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="22" r="6" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="22" r="2" fill="${WHITE}"/>`,

  // Toggle: Film frame selection
  "shot-selection-toggle": `
    <rect x="18" y="12" width="36" height="24" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="18" y1="18" x2="54" y2="18" stroke="${GRAY}" stroke-width="1"/>
    <line x1="18" y1="30" x2="54" y2="30" stroke="${GRAY}" stroke-width="1"/>
    <line x1="26" y1="12" x2="26" y2="36" stroke="${GRAY}" stroke-width="1"/>
    <line x1="46" y1="12" x2="46" y2="36" stroke="${GRAY}" stroke-width="1"/>
    <rect x="28" y="19" width="16" height="10" fill="none" stroke="${WHITE}" stroke-width="1.5"/>`,

  // Toggle: Lens ring with "M"
  "manual-focus-toggle": `
    <circle cx="36" cy="22" r="14" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="22" r="9" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <text x="36" y="24" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="12" font-weight="bold">M</text>`,

  // Camera CRUD: Camera + "+"
  "insert-camera": `
    <rect x="14" y="14" width="20" height="16" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="34,17 44,12 44,32 34,27" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <line x1="52" y1="20" x2="52" y2="32" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="46" y1="26" x2="58" y2="26" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>`,

  // Camera CRUD: Camera + "×"
  "remove-camera": `
    <rect x="14" y="14" width="20" height="16" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="34,17 44,12 44,32 34,27" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <line x1="48" y1="20" x2="56" y2="32" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="56" y1="20" x2="48" y2="32" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>`,

  // Camera CRUD: Camera + copy sheets
  "copy-camera": `
    <rect x="14" y="14" width="18" height="14" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="32,17 40,13 40,30 32,26" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <rect x="44" y="18" width="10" height="12" rx="1" fill="none" stroke="${WHITE}" stroke-width="1"/>
    <rect x="48" y="14" width="10" height="12" rx="1" fill="none" stroke="${WHITE}" stroke-width="1"/>`,

  // Camera CRUD: Camera + clipboard
  "paste-camera": `
    <rect x="14" y="14" width="18" height="14" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <polygon points="32,17 40,13 40,30 32,26" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>
    <rect x="46" y="16" width="12" height="16" rx="1" fill="none" stroke="${WHITE}" stroke-width="1"/>
    <rect x="49" y="13" width="6" height="4" rx="1" fill="none" stroke="${WHITE}" stroke-width="1"/>`,

  // Group ops: Stacked rectangles + copy
  "copy-group": `
    <rect x="16" y="18" width="20" height="14" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="20" y="14" width="20" height="14" rx="2" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <rect x="46" y="20" width="10" height="12" rx="1" fill="none" stroke="${WHITE}" stroke-width="1"/>
    <rect x="50" y="16" width="10" height="12" rx="1" fill="none" stroke="${WHITE}" stroke-width="1"/>`,

  // Group ops: Stacked rectangles + clipboard
  "paste-group": `
    <rect x="16" y="18" width="20" height="14" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="20" y="14" width="20" height="14" rx="2" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <rect x="46" y="18" width="12" height="16" rx="1" fill="none" stroke="${WHITE}" stroke-width="1"/>
    <rect x="49" y="15" width="6" height="4" rx="1" fill="none" stroke="${WHITE}" stroke-width="1"/>`,

  // File ops: Floppy disk + down arrow + "T"
  "save-track-camera": `
    <rect x="18" y="10" width="22" height="24" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="22" y="10" width="14" height="8" rx="1" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="52" y1="14" x2="52" y2="28" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="48,24 52,28 56,24" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="52" y="38" text-anchor="middle" dominant-baseline="central"
          fill="${GRAY}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">T</text>`,

  // File ops: Floppy disk + up arrow + "T"
  "load-track-camera": `
    <rect x="18" y="10" width="22" height="24" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="22" y="10" width="14" height="8" rx="1" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="52" y1="28" x2="52" y2="14" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="48,18 52,14 56,18" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="52" y="38" text-anchor="middle" dominant-baseline="central"
          fill="${GRAY}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">T</text>`,

  // File ops: Floppy disk + down arrow + "C"
  "save-car-camera": `
    <rect x="18" y="10" width="22" height="24" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="22" y="10" width="14" height="8" rx="1" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="52" y1="14" x2="52" y2="28" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="48,24 52,28 56,24" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="52" y="38" text-anchor="middle" dominant-baseline="central"
          fill="${GRAY}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">C</text>`,

  // File ops: Floppy disk + up arrow + "C"
  "load-car-camera": `
    <rect x="18" y="10" width="22" height="24" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="22" y="10" width="14" height="8" rx="1" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="52" y1="28" x2="52" y2="14" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="48,18 52,14 56,18" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="52" y="38" text-anchor="middle" dominant-baseline="central"
          fill="${GRAY}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">C</text>`,
};

/**
 * @internal Exported for testing
 *
 * Mapping from control setting values (kebab-case) to global settings keys.
 */
export const CAMERA_EDITOR_CONTROLS_GLOBAL_KEYS: Record<ControlType, string> = {
  "open-camera-tool": "camCtrlOpenCameraTool",
  "key-acceleration-toggle": "camCtrlKeyAccelerationToggle",
  "key-10x-toggle": "camCtrlKey10xToggle",
  "parabolic-mic-toggle": "camCtrlParabolicMicToggle",
  "cycle-position-type": "camCtrlCyclePositionType",
  "cycle-aim-type": "camCtrlCycleAimType",
  "acquire-start": "camCtrlAcquireStart",
  "acquire-end": "camCtrlAcquireEnd",
  "temporary-edits-toggle": "camCtrlTemporaryEditsToggle",
  "dampening-toggle": "camCtrlDampeningToggle",
  "zoom-toggle": "camCtrlZoomToggle",
  "beyond-fence-toggle": "camCtrlBeyondFenceToggle",
  "in-cockpit-toggle": "camCtrlInCockpitToggle",
  "mouse-navigation-toggle": "camCtrlMouseNavigationToggle",
  "pitch-gyro-toggle": "camCtrlPitchGyroToggle",
  "roll-gyro-toggle": "camCtrlRollGyroToggle",
  "limit-shot-range-toggle": "camCtrlLimitShotRangeToggle",
  "show-camera-toggle": "camCtrlShowCameraToggle",
  "shot-selection-toggle": "camCtrlShotSelectionToggle",
  "manual-focus-toggle": "camCtrlManualFocusToggle",
  "insert-camera": "camCtrlInsertCamera",
  "remove-camera": "camCtrlRemoveCamera",
  "copy-camera": "camCtrlCopyCamera",
  "paste-camera": "camCtrlPasteCamera",
  "copy-group": "camCtrlCopyGroup",
  "paste-group": "camCtrlPasteGroup",
  "save-track-camera": "camCtrlSaveTrackCamera",
  "load-track-camera": "camCtrlLoadTrackCamera",
  "save-car-camera": "camCtrlSaveCarCamera",
  "load-car-camera": "camCtrlLoadCarCamera",
};

const CameraEditorControlsSettings = z.object({
  control: z.enum(CONTROL_VALUES).default("open-camera-tool"),
});

type CameraEditorControlsSettings = z.infer<typeof CameraEditorControlsSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the camera editor controls action.
 */
export function generateCameraEditorControlsSvg(settings: CameraEditorControlsSettings): string {
  const { control } = settings;

  const iconContent = CAMERA_EDITOR_CONTROLS_ICONS[control] || CAMERA_EDITOR_CONTROLS_ICONS["open-camera-tool"];
  const labels = CAMERA_EDITOR_CONTROLS_LABELS[control] || CAMERA_EDITOR_CONTROLS_LABELS["open-camera-tool"];

  const svg = renderIconTemplate(cameraEditorControlsTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Camera Editor Controls Action
 * Camera editor toggles and management controls for broadcasters and content creators.
 */
@action({ UUID: "com.iracedeck.sd.core.camera-editor-controls" })
export class CameraEditorControls extends ConnectionStateAwareAction<CameraEditorControlsSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("CameraEditorControls"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<CameraEditorControlsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<CameraEditorControlsSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CameraEditorControlsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<CameraEditorControlsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(settings.control);
  }

  override async onDialDown(ev: DialDownEvent<CameraEditorControlsSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(settings.control);
  }

  private parseSettings(settings: unknown): CameraEditorControlsSettings {
    const parsed = CameraEditorControlsSettings.safeParse(settings);

    return parsed.success ? parsed.data : CameraEditorControlsSettings.parse({});
  }

  private async executeControl(control: ControlType): Promise<void> {
    this.logger.info("Control triggered");
    this.logger.debug(`Executing ${control}`);

    const settingKey = CAMERA_EDITOR_CONTROLS_GLOBAL_KEYS[control];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${control}`);

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
    ev: WillAppearEvent<CameraEditorControlsSettings> | DidReceiveSettingsEvent<CameraEditorControlsSettings>,
    settings: CameraEditorControlsSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateCameraEditorControlsSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
