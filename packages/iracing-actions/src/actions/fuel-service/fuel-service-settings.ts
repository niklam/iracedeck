/**
 * Fuel Service settings schema (issue #759).
 *
 * One action, two surfaces: keypad settings stay FLAT (they predate the merge
 * and migrating them is risk with no benefit); dial settings live under the
 * `dial` root object. The `unit` field is shared by both surfaces — "shared"
 * means one schema field and one PI control per surface, not one value spanning
 * surfaces (settings are per-instance).
 */
import { CommonSettings } from "@iracedeck/deck-core";
import { DisplayUnits } from "@iracedeck/iracing-sdk";
import z from "zod";

/** Global-settings keys for the shared fuel key bindings (both surfaces). */
export const TOGGLE_AUTOFUEL_KEY = "fuelServiceToggleAutofuel";
export const LAP_MARGIN_INCREASE_KEY = "fuelServiceLapMarginIncrease";
export const LAP_MARGIN_DECREASE_KEY = "fuelServiceLapMarginDecrease";

/**
 * Mapping from keyboard-based keypad modes to global settings keys.
 * Chat-free API modes (toggle-fuel-fill, add/reduce/set fuel, clear-fuel) are NOT included.
 */
export const FUEL_SERVICE_GLOBAL_KEYS: Record<string, string> = {
  "toggle-autofuel": TOGGLE_AUTOFUEL_KEY,
  "lap-margin-increase": LAP_MARGIN_INCREASE_KEY,
  "lap-margin-decrease": LAP_MARGIN_DECREASE_KEY,
};

/**
 * Fuel units for the shared `unit` setting. `auto` resolves from iRacing's
 * live `DisplayUnits` telemetry and is the default for NEW instances (#759);
 * legacy instances are coerced to `l` in {@link parseFuelServiceSettings} so
 * their behavior never changes. `k` (kilograms) is keypad-only — the dial PI
 * doesn't offer it, and the dial display treats it as `auto`.
 */
export const FuelUnit = z.enum(["auto", "l", "g", "k"]);
export type FuelUnit = z.infer<typeof FuelUnit>;

/**
 * The actions a dial-button / touch gesture (Push, Long Press, Tap Display,
 * Long Touch) can run, plus the "none" sentinel. `fill-to-max` toggles a full
 * tank vs no fuel; `toggle-autofuel-mode` flips iRacing's autofuel via its key
 * binding (switching which mode the bare turn adjusts); `switch-mode` flips the
 * manual dial mode between Add Amount and Target Amount.
 */
export const DIAL_GESTURE_ACTIONS = [
  "toggle-fueling",
  "fill-to-max",
  "toggle-autofuel-mode",
  "switch-mode",
  "none",
] as const;

/** A configurable gesture-slot value (one of {@link DIAL_GESTURE_ACTIONS}). */
export type DialGestureSlot = (typeof DIAL_GESTURE_ACTIONS)[number];

/** Replaces a decimal comma with a dot before numeric coercion. */
const commaToDot = (val: unknown) => (typeof val === "string" ? val.replace(",", ".") : val);

/**
 * Dial-surface settings, stored under the `dial` root key. All fields default,
 * so a keypad-only instance (or a fresh dial) parses `{}` to a full object.
 */
export const DialSettings = z
  .object({
    mode: z.enum(["add-amount", "fill-to"]).default("add-amount"),
    stepSize: z.preprocess(commaToDot, z.coerce.number().min(0.1).max(50).default(1)),
    // Push (short press) — fires on dialUp. Default: toggle fuel-fill on/off.
    pressAction: z.enum(DIAL_GESTURE_ACTIONS).default("toggle-fueling"),
    // Long Press (held dial button past the threshold, no rotation) — fires on
    // dialUp. Default: toggle autofuel mode (blind-safe for VR).
    longPressAction: z.enum(DIAL_GESTURE_ACTIONS).default("toggle-autofuel-mode"),
    // Push + Turn — a single bidirectional pair, dispatched per pressed rotation
    // (clockwise → cw action, counter-clockwise → ccw action) via the shared dial
    // convention. "full-empty": CW fills the tank, CCW empties it (no fuel).
    pushTurnAction: z.enum(["none", "full-empty"]).default("none"),
    // Tap Display (touch-strip tap, hold === false). Default None for VR safety.
    tapAction: z.enum(DIAL_GESTURE_ACTIONS).default("none"),
    // Long Touch (touch-strip tap, hold === true). Default None for VR safety.
    longTouchAction: z.enum(DIAL_GESTURE_ACTIONS).default("none"),
  })
  // prefault (not default): a missing `dial` parses {} THROUGH the schema so
  // the per-field defaults apply — same shape as a partially-persisted object.
  .prefault({});

export type DialSettings = z.infer<typeof DialSettings>;

export const FUEL_SERVICE_MODES = [
  "toggle-fuel-fill",
  "add-fuel",
  "reduce-fuel",
  "set-fuel-amount",
  "clear-fuel",
  "toggle-autofuel",
  "lap-margin-increase",
  "lap-margin-decrease",
] as const;

export type FuelServiceMode = (typeof FUEL_SERVICE_MODES)[number];

export const FuelServiceSettings = CommonSettings.extend({
  mode: z.enum(FUEL_SERVICE_MODES).default("toggle-fuel-fill"),
  amount: z.preprocess(commaToDot, z.coerce.number().min(0).default(1)),
  // .catch maps an unknown persisted unit — e.g. a value written into a shared
  // profile by a newer version — to auto instead of failing the whole parse,
  // which would discard the stored mode and render the key as toggle-fuel-fill
  // (the same hardening master applies for 2.0's "auto" on its side).
  unit: FuelUnit.default("auto").catch("auto"),
  dial: DialSettings,
});

export type FuelServiceSettings = z.infer<typeof FuelServiceSettings>;

/**
 * Parses raw settings with the legacy-unit migration applied, falling back to
 * full defaults when the whole parse fails.
 */
export function parseFuelServiceSettings(raw: unknown): FuelServiceSettings {
  const parsed = FuelServiceSettings.safeParse(migrateLegacyUnit(raw));

  return parsed.success ? parsed.data : FuelServiceSettings.parse({});
}

/**
 * @internal Exported for testing
 *
 * Pre-#759 instances defaulted `unit` to liters, and the PI only persisted the
 * field when the user touched it. Changing the schema default to `auto` would
 * therefore flip behavior for existing imperial-unit users who configured a
 * fuel mode but never opened the Unit dropdown. A persisted `mode` with no
 * persisted `unit` marks such a legacy instance — coerce it to `l`. A truly
 * fresh instance has no `mode` either (and unit is only consulted by the
 * amount modes, which require the PI to set `mode` first), so new instances
 * still get the `auto` default.
 */
export function migrateLegacyUnit(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;

  const obj = raw as Record<string, unknown>;

  if (obj.unit === undefined && obj.mode !== undefined) {
    return { ...obj, unit: "l" };
  }

  return raw;
}

/**
 * @internal Exported for testing
 *
 * Resolves the effective iRacing DisplayUnits value for the shared unit
 * setting (dial display + step conversion). `l` forces metric, `g` forces
 * english; `auto` follows telemetry (metric when unknown). `k` has no display
 * representation on the dial and falls back to `auto` behavior.
 */
export function resolveDisplayUnits(unit: FuelUnit, telemetryUnits: number | undefined): number {
  if (unit === "l") return DisplayUnits.Metric;

  if (unit === "g") return DisplayUnits.English;

  // auto (and keypad-only k): follow telemetry; default to metric when unknown.
  return telemetryUnits === undefined ? DisplayUnits.Metric : telemetryUnits;
}
