/**
 * Setup Brakes settings schema (issue #775).
 *
 * One action, two surfaces (the Fuel Service pattern, #759): keypad settings
 * stay FLAT (`setting`, `direction`, `dualPressEnabled` — they predate the
 * merge and migrating them is risk with no benefit); dial settings live under
 * the `dial` root object. The two surfaces deliberately share nothing at the
 * top level — the keypad `setting` enum (13 sub-modes incl. View) and the dial
 * rotation `dial.setting` enum (6 values) would otherwise collide on one key.
 */
import { CommonSettings } from "@iracedeck/deck-core";
import z from "zod";

/**
 * @internal Exported for testing
 *
 * Mapping from setting + direction to global settings keys.
 * Directional controls use composite keys (e.g., "brake-bias-increase").
 * Shared by both surfaces — the dial adds no global keys of its own.
 */
export const SETUP_BRAKES_GLOBAL_KEYS: Record<string, string> = {
  "abs-toggle": "setupBrakesAbsToggle",
  "abs-adjust-increase": "setupBrakesAbsAdjustIncrease",
  "abs-adjust-decrease": "setupBrakesAbsAdjustDecrease",
  "brake-bias-increase": "setupBrakesBrakeBiasIncrease",
  "brake-bias-decrease": "setupBrakesBrakeBiasDecrease",
  "brake-bias-fine-increase": "setupBrakesBrakeBiasFineIncrease",
  "brake-bias-fine-decrease": "setupBrakesBrakeBiasFineDecrease",
  "peak-brake-bias-increase": "setupBrakesPeakBrakeBiasIncrease",
  "peak-brake-bias-decrease": "setupBrakesPeakBrakeBiasDecrease",
  "brake-misc-increase": "setupBrakesBrakeMiscIncrease",
  "brake-misc-decrease": "setupBrakesBrakeMiscDecrease",
  "engine-braking-increase": "setupBrakesEngineBrakingIncrease",
  "engine-braking-decrease": "setupBrakesEngineBrakingDecrease",
};

/**
 * The directional brake adjustment settings the dial can drive. Mirrors the
 * directional subset of the keypad surface (View sub-modes are omitted — the
 * dial display itself shows the live value; ABS Toggle is omitted as a
 * rotation mode since on/off doesn't map to a rotary, but it remains
 * available as a configurable press gesture).
 */
export const ROTATION_SETTINGS = [
  "brake-bias",
  "brake-bias-fine",
  "peak-brake-bias",
  "brake-misc",
  "engine-braking",
  "abs-adjust",
] as const;

export type SetupBrakesDialSetting = (typeof ROTATION_SETTINGS)[number];

/**
 * The actions a dial-button / touch gesture (Push, Long Press, Tap Display,
 * Long Touch) can run, plus the "none" sentinel. `toggle-abs` taps the shared
 * Setup Brakes ABS Toggle key binding.
 */
export const GESTURE_ACTIONS = ["toggle-abs", "none"] as const;
export type GestureSlot = (typeof GESTURE_ACTIONS)[number];

type DirectionType = "increase" | "decrease";

/** Resolves the shared Setup Brakes global key binding for a dial setting + direction. */
export function rotationKey(setting: SetupBrakesDialSetting, direction: DirectionType): string | undefined {
  return SETUP_BRAKES_GLOBAL_KEYS[`${setting}-${direction}`];
}

/**
 * Dial-surface settings, stored under the `dial` root key. All fields default,
 * so a keypad-only instance (or a fresh dial) parses `{}` to a full object.
 */
export const DialSettings = z
  .object({
    setting: z.enum(ROTATION_SETTINGS).default("brake-bias"),
    // Push (short press) — fires on dialUp. Default: toggle ABS.
    pressAction: z.enum(GESTURE_ACTIONS).default("toggle-abs"),
    // Long Press (held dial button past the threshold, no rotation) — fires on dialUp.
    longPressAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Tap Display (touch-strip tap, hold === false). Default None for VR safety.
    tapAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Long Touch (touch-strip tap, hold === true). Default None for VR safety.
    longTouchAction: z.enum(GESTURE_ACTIONS).default("none"),
  })
  // prefault (not default): a missing `dial` parses {} THROUGH the schema so
  // the per-field defaults apply — same shape as a partially-persisted object.
  .prefault({});

export type DialSettings = z.infer<typeof DialSettings>;

export const SetupBrakesSettings = CommonSettings.extend({
  setting: z
    .enum([
      // View sub-modes (read-only telemetry display) — listed first to appear at the top of the PI dropdown.
      "view-brake-bias",
      "view-brake-bias-fine",
      "view-peak-brake-bias",
      "view-brake-misc",
      "view-engine-braking",
      "view-abs-adjust",
      // Adjustment sub-modes (existing).
      "abs-toggle",
      "abs-adjust",
      "brake-bias",
      "brake-bias-fine",
      "peak-brake-bias",
      "brake-misc",
      "engine-braking",
    ])
    .default("brake-bias"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
  /**
   * Dual-press opt-in for View sub-modes (issue #540). When `true` (default),
   * a View key fires the global tap direction on a short press and the
   * opposite on a long press (held ≥ `dualPressThresholdMs`). When `false`,
   * the View stays purely read-only. Ignored for adjustment / toggle
   * sub-modes. The tap direction itself is the plugin-wide
   * `dualPressDirections` global setting.
   */
  dualPressEnabled: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true")
    .default(true),
  dial: DialSettings,
});

export type SetupBrakesSettings = z.infer<typeof SetupBrakesSettings>;

/** Parses raw settings, falling back to full defaults when the whole parse fails. */
export function parseSetupBrakesSettings(raw: unknown): SetupBrakesSettings {
  const parsed = SetupBrakesSettings.safeParse(raw);

  return parsed.success ? parsed.data : SetupBrakesSettings.parse({});
}
