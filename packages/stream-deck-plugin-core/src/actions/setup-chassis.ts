import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
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
} from "@iracedeck/stream-deck-shared";
import z from "zod";

import setupChassisTemplate from "../../icons/setup-chassis.svg";

const WHITE = "#ffffff";
const GRAY = "#888888";
const YELLOW = "#f1c40f";

type SetupChassisSetting =
  | "differential-preload"
  | "differential-entry"
  | "differential-middle"
  | "differential-exit"
  | "front-arb"
  | "rear-arb"
  | "left-spring"
  | "right-spring"
  | "lf-shock"
  | "rf-shock"
  | "lr-shock"
  | "rr-shock"
  | "power-steering";

type DirectionType = "increase" | "decrease";

/**
 * Label configuration for each setting + direction combination.
 * Standard layout: line1 = primary (bold, top), line2 = secondary (subdued, bottom).
 * All chassis settings are directional (+/-).
 */
const SETUP_CHASSIS_LABELS: Record<SetupChassisSetting, Record<DirectionType, { line1: string; line2: string }>> = {
  "differential-preload": {
    increase: { line1: "DIFF PRELOAD", line2: "INCREASE" },
    decrease: { line1: "DIFF PRELOAD", line2: "DECREASE" },
  },
  "differential-entry": {
    increase: { line1: "DIFF ENTRY", line2: "INCREASE" },
    decrease: { line1: "DIFF ENTRY", line2: "DECREASE" },
  },
  "differential-middle": {
    increase: { line1: "DIFF MIDDLE", line2: "INCREASE" },
    decrease: { line1: "DIFF MIDDLE", line2: "DECREASE" },
  },
  "differential-exit": {
    increase: { line1: "DIFF EXIT", line2: "INCREASE" },
    decrease: { line1: "DIFF EXIT", line2: "DECREASE" },
  },
  "front-arb": {
    increase: { line1: "FRONT ARB", line2: "INCREASE" },
    decrease: { line1: "FRONT ARB", line2: "DECREASE" },
  },
  "rear-arb": {
    increase: { line1: "REAR ARB", line2: "INCREASE" },
    decrease: { line1: "REAR ARB", line2: "DECREASE" },
  },
  "left-spring": {
    increase: { line1: "LEFT SPRING", line2: "INCREASE" },
    decrease: { line1: "LEFT SPRING", line2: "DECREASE" },
  },
  "right-spring": {
    increase: { line1: "RIGHT SPRING", line2: "INCREASE" },
    decrease: { line1: "RIGHT SPRING", line2: "DECREASE" },
  },
  "lf-shock": {
    increase: { line1: "LF SHOCK", line2: "INCREASE" },
    decrease: { line1: "LF SHOCK", line2: "DECREASE" },
  },
  "rf-shock": {
    increase: { line1: "RF SHOCK", line2: "INCREASE" },
    decrease: { line1: "RF SHOCK", line2: "DECREASE" },
  },
  "lr-shock": {
    increase: { line1: "LR SHOCK", line2: "INCREASE" },
    decrease: { line1: "LR SHOCK", line2: "DECREASE" },
  },
  "rr-shock": {
    increase: { line1: "RR SHOCK", line2: "INCREASE" },
    decrease: { line1: "RR SHOCK", line2: "DECREASE" },
  },
  "power-steering": {
    increase: { line1: "PWR STEER", line2: "INCREASE" },
    decrease: { line1: "PWR STEER", line2: "DECREASE" },
  },
};

/**
 * SVG icon content for each setting.
 * All chassis settings are directional with per-direction arrow variants.
 */
const SETUP_CHASSIS_ICONS: Record<SetupChassisSetting, Record<DirectionType, string>> = {
  // Differential Preload: Circular gear outline with compression arrows pointing inward
  "differential-preload": {
    increase: `
    <circle cx="34" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="34" cy="24" r="8" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="28" y1="24" x2="31" y2="24" stroke="${YELLOW}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="37" y1="24" x2="40" y2="24" stroke="${YELLOW}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="34" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="34" cy="24" r="8" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="28" y1="24" x2="31" y2="24" stroke="${YELLOW}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="37" y1="24" x2="40" y2="24" stroke="${YELLOW}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Differential Entry: Circular gear with left-side arc marker
  "differential-entry": {
    increase: `
    <circle cx="34" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="34" cy="24" r="8" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <path d="M26,18 A12,12 0 0,0 26,30" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="34" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="34" cy="24" r="8" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <path d="M26,18 A12,12 0 0,0 26,30" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Differential Middle: Circular gear with center dot
  "differential-middle": {
    increase: `
    <circle cx="34" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="34" cy="24" r="8" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="34" cy="24" r="3" fill="${YELLOW}"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="34" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="34" cy="24" r="8" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="34" cy="24" r="3" fill="${YELLOW}"/>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Differential Exit: Circular gear with right-side arc marker
  "differential-exit": {
    increase: `
    <circle cx="34" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="34" cy="24" r="8" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <path d="M42,18 A12,12 0 0,1 42,30" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="34" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="34" cy="24" r="8" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <path d="M42,18 A12,12 0 0,1 42,30" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Front ARB: Horizontal bar with U-bend, positioned higher (y~16)
  "front-arb": {
    increase: `
    <line x1="18" y1="18" x2="28" y2="18" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <path d="M28,18 C28,28 40,28 40,18" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="40" y1="18" x2="50" y2="18" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <text x="34" y="36" text-anchor="middle" fill="${GRAY}" font-family="Arial, sans-serif" font-size="7">FRONT</text>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <line x1="18" y1="18" x2="28" y2="18" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <path d="M28,18 C28,28 40,28 40,18" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="40" y1="18" x2="50" y2="18" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <text x="34" y="36" text-anchor="middle" fill="${GRAY}" font-family="Arial, sans-serif" font-size="7">FRONT</text>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Rear ARB: Horizontal bar with U-bend, positioned lower (y~28)
  "rear-arb": {
    increase: `
    <line x1="18" y1="18" x2="28" y2="18" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <path d="M28,18 C28,28 40,28 40,18" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="40" y1="18" x2="50" y2="18" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <text x="34" y="36" text-anchor="middle" fill="${GRAY}" font-family="Arial, sans-serif" font-size="7">REAR</text>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <line x1="18" y1="18" x2="28" y2="18" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <path d="M28,18 C28,28 40,28 40,18" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="40" y1="18" x2="50" y2="18" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <text x="34" y="36" text-anchor="middle" fill="${GRAY}" font-family="Arial, sans-serif" font-size="7">REAR</text>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Left Spring: Zigzag coil spring, shifted left of center
  "left-spring": {
    increase: `
    <polyline points="28,12 24,16 32,20 24,24 32,28 24,32 32,36 28,40" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="22" y1="12" x2="34" y2="12" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="22" y1="40" x2="34" y2="40" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <polyline points="28,12 24,16 32,20 24,24 32,28 24,32 32,36 28,40" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="22" y1="12" x2="34" y2="12" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="22" y1="40" x2="34" y2="40" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Right Spring: Zigzag coil spring, shifted right of center
  "right-spring": {
    increase: `
    <polyline points="38,12 34,16 42,20 34,24 42,28 34,32 42,36 38,40" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="32" y1="12" x2="44" y2="12" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="32" y1="40" x2="44" y2="40" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <polyline points="38,12 34,16 42,20 34,24 42,28 34,32 42,36 38,40" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="32" y1="12" x2="44" y2="12" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="32" y1="40" x2="44" y2="40" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // LF Shock: Shock absorber (cylinder + shaft) with "LF" text
  "lf-shock": {
    increase: `
    <rect x="30" y="12" width="10" height="16" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="35" y1="28" x2="35" y2="40" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="31" y1="40" x2="39" y2="40" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <text x="22" y="28" text-anchor="middle" fill="${GRAY}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">LF</text>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="30" y="12" width="10" height="16" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="35" y1="28" x2="35" y2="40" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="31" y1="40" x2="39" y2="40" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <text x="22" y="28" text-anchor="middle" fill="${GRAY}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">LF</text>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // RF Shock: Shock absorber with "RF" text
  "rf-shock": {
    increase: `
    <rect x="30" y="12" width="10" height="16" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="35" y1="28" x2="35" y2="40" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="31" y1="40" x2="39" y2="40" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <text x="22" y="28" text-anchor="middle" fill="${GRAY}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">RF</text>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="30" y="12" width="10" height="16" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="35" y1="28" x2="35" y2="40" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="31" y1="40" x2="39" y2="40" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <text x="22" y="28" text-anchor="middle" fill="${GRAY}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">RF</text>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // LR Shock: Shock absorber with "LR" text
  "lr-shock": {
    increase: `
    <rect x="30" y="12" width="10" height="16" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="35" y1="28" x2="35" y2="40" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="31" y1="40" x2="39" y2="40" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <text x="22" y="28" text-anchor="middle" fill="${GRAY}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">LR</text>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="30" y="12" width="10" height="16" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="35" y1="28" x2="35" y2="40" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="31" y1="40" x2="39" y2="40" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <text x="22" y="28" text-anchor="middle" fill="${GRAY}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">LR</text>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // RR Shock: Shock absorber with "RR" text
  "rr-shock": {
    increase: `
    <rect x="30" y="12" width="10" height="16" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="35" y1="28" x2="35" y2="40" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="31" y1="40" x2="39" y2="40" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <text x="22" y="28" text-anchor="middle" fill="${GRAY}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">RR</text>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="30" y="12" width="10" height="16" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="35" y1="28" x2="35" y2="40" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="31" y1="40" x2="39" y2="40" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <text x="22" y="28" text-anchor="middle" fill="${GRAY}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">RR</text>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Power Steering: Steering wheel circle with lightning bolt
  "power-steering": {
    increase: `
    <circle cx="34" cy="22" r="14" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="34" cy="22" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="34" y1="26" x2="34" y2="36" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="32,16 34,20 32,20 34,24" fill="none" stroke="${YELLOW}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="34" cy="22" r="14" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="34" cy="22" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="34" y1="26" x2="34" y2="36" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="32,16 34,20 32,20 34,24" fill="none" stroke="${YELLOW}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
};

/**
 * @internal Exported for testing
 *
 * Mapping from setting + direction to global settings keys.
 * All chassis settings are directional, using composite keys (e.g., "differential-preload-increase").
 */
export const SETUP_CHASSIS_GLOBAL_KEYS: Record<string, string> = {
  "differential-preload-increase": "setupChassisDifferentialPreloadIncrease",
  "differential-preload-decrease": "setupChassisDifferentialPreloadDecrease",
  "differential-entry-increase": "setupChassisDifferentialEntryIncrease",
  "differential-entry-decrease": "setupChassisDifferentialEntryDecrease",
  "differential-middle-increase": "setupChassisDifferentialMiddleIncrease",
  "differential-middle-decrease": "setupChassisDifferentialMiddleDecrease",
  "differential-exit-increase": "setupChassisDifferentialExitIncrease",
  "differential-exit-decrease": "setupChassisDifferentialExitDecrease",
  "front-arb-increase": "setupChassisFrontArbIncrease",
  "front-arb-decrease": "setupChassisFrontArbDecrease",
  "rear-arb-increase": "setupChassisRearArbIncrease",
  "rear-arb-decrease": "setupChassisRearArbDecrease",
  "left-spring-increase": "setupChassisLeftSpringIncrease",
  "left-spring-decrease": "setupChassisLeftSpringDecrease",
  "right-spring-increase": "setupChassisRightSpringIncrease",
  "right-spring-decrease": "setupChassisRightSpringDecrease",
  "lf-shock-increase": "setupChassisLfShockIncrease",
  "lf-shock-decrease": "setupChassisLfShockDecrease",
  "rf-shock-increase": "setupChassisRfShockIncrease",
  "rf-shock-decrease": "setupChassisRfShockDecrease",
  "lr-shock-increase": "setupChassisLrShockIncrease",
  "lr-shock-decrease": "setupChassisLrShockDecrease",
  "rr-shock-increase": "setupChassisRrShockIncrease",
  "rr-shock-decrease": "setupChassisRrShockDecrease",
  "power-steering-increase": "setupChassisPowerSteeringIncrease",
  "power-steering-decrease": "setupChassisPowerSteeringDecrease",
};

const SetupChassisSettings = z.object({
  setting: z
    .enum([
      "differential-preload",
      "differential-entry",
      "differential-middle",
      "differential-exit",
      "front-arb",
      "rear-arb",
      "left-spring",
      "right-spring",
      "lf-shock",
      "rf-shock",
      "lr-shock",
      "rr-shock",
      "power-steering",
    ])
    .default("differential-preload"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type SetupChassisSettings = z.infer<typeof SetupChassisSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup chassis action.
 */
export function generateSetupChassisSvg(settings: SetupChassisSettings): string {
  const { setting, direction } = settings;

  const iconContent = SETUP_CHASSIS_ICONS[setting]?.[direction] ?? SETUP_CHASSIS_ICONS["differential-preload"].increase;

  const labels = SETUP_CHASSIS_LABELS[setting]?.[direction] ?? { line1: "CHASSIS", line2: "SETUP" };

  const svg = renderIconTemplate(setupChassisTemplate, {
    iconContent: iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Setup Chassis Action
 * Provides chassis-related in-car adjustments (differentials, anti-roll bars,
 * springs, shocks, power steering) via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.setup-chassis" })
export class SetupChassis extends ConnectionStateAwareAction<SetupChassisSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("SetupChassis"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<SetupChassisSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<SetupChassisSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SetupChassisSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<SetupChassisSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialDown(ev: DialDownEvent<SetupChassisSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialRotate(ev: DialRotateEvent<SetupChassisSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);

    // Clockwise (ticks > 0) = increase, Counter-clockwise (ticks < 0) = decrease
    const direction: DirectionType = ev.payload.ticks > 0 ? "increase" : "decrease";
    await this.executeSetting(settings.setting, direction);
  }

  private parseSettings(settings: unknown): SetupChassisSettings {
    const parsed = SetupChassisSettings.safeParse(settings);

    return parsed.success ? parsed.data : SetupChassisSettings.parse({});
  }

  private async executeSetting(setting: SetupChassisSetting, direction: DirectionType): Promise<void> {
    this.logger.info("Setting executed");
    this.logger.debug(`Executing ${setting} ${direction}`);

    const settingKey = SETUP_CHASSIS_GLOBAL_KEYS[`${setting}-${direction}`];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${setting} ${direction}`);

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
    ev: WillAppearEvent<SetupChassisSettings> | DidReceiveSettingsEvent<SetupChassisSettings>,
    settings: SetupChassisSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateSetupChassisSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
