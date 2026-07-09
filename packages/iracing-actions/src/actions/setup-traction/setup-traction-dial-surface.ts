/**
 * The dial surface of the Setup Traction action (issue #795) — the dual-surface
 * pattern established by Fuel Service (#759) and Setup Brakes (#775), ported
 * behind a host interface. Coexists with the keypad "paired adjust key styles"
 * feature (#810): key styles govern the keypad key rendering, this governs the
 * encoder surface — the two are orthogonal.
 *
 * This module is a self-contained leaf: it owns the `dial` settings schema and
 * all dial key bindings, and the owning action imports the schema + surface from
 * here (so there is no import cycle with the action's inline keypad settings).
 * Its methods operate on the `dial` sub-object (a {@link DialSettings}).
 *
 * Rotating adjusts one TC slot (TC1–TC4) via the same key bindings as the keypad
 * surface; the touch strip shows the live telemetry value in a color-coded "dash
 * box". Pressing runs a configurable gesture (default: toggle TC). The dash box
 * also ships a label-only (identity-only) branch — an empty value draws just the
 * centered label — for family uniformity with the setup dials whose values
 * iRacing exposes no `dc*` telemetry for. No Traction setting triggers it.
 */
import {
  classifyDialRelease,
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  getDualPressThresholdMs,
  type IDeckActionContext,
  svgToDataUri,
} from "@iracedeck/deck-core";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import z from "zod";

import { dialAppearanceFields, renderDialBox, resolveDialBoxColors } from "../../shared/dial-box.js";
import { renderDialNameIcon } from "../../shared/dial-name-icon.js";
import { formatViewValue, type ViewSettingId } from "../../shared/setup-view.js";

/** Minimum gap (ms) between change-driven feedback pushes (≤10 setFeedback/s/dial). */
const CHANGE_RENDER_MIN_INTERVAL_MS = 100;

/**
 * The directional TC-slot adjustments the dial can drive. Mirrors the directional
 * subset of the keypad surface (View sub-modes and TC Toggle are omitted — the
 * dial display shows the live value; on/off doesn't map to a rotary).
 */
export const ROTATION_SETTINGS = ["tc-slot-1", "tc-slot-2", "tc-slot-3", "tc-slot-4"] as const;
export type SetupTractionDialSetting = (typeof ROTATION_SETTINGS)[number];

/** Gesture slots. `toggle-tc` taps the shared Setup Traction TC Toggle binding. */
export const GESTURE_ACTIONS = ["toggle-tc", "none"] as const;
export type GestureSlot = (typeof GESTURE_ACTIONS)[number];

export type SetupTractionDirection = "increase" | "decrease";

/**
 * Global key bindings the dial taps. These mirror the keypad
 * `SETUP_TRACTION_GLOBAL_KEYS` entries; kept here (not imported) so this module
 * stays a leaf with no cycle back to the action's inline settings.
 */
const DIAL_ROTATION_KEYS: Record<string, string> = {
  "tc-slot-1-increase": "setupTractionTcSlot1Increase",
  "tc-slot-1-decrease": "setupTractionTcSlot1Decrease",
  "tc-slot-2-increase": "setupTractionTcSlot2Increase",
  "tc-slot-2-decrease": "setupTractionTcSlot2Decrease",
  "tc-slot-3-increase": "setupTractionTcSlot3Increase",
  "tc-slot-3-decrease": "setupTractionTcSlot3Decrease",
  "tc-slot-4-increase": "setupTractionTcSlot4Increase",
  "tc-slot-4-decrease": "setupTractionTcSlot4Decrease",
};
const TC_TOGGLE_KEY = "setupTractionTcToggle";

/** Resolves the shared increase/decrease binding for a dial setting + direction. */
export function rotationKey(setting: SetupTractionDialSetting, direction: SetupTractionDirection): string | undefined {
  return DIAL_ROTATION_KEYS[`${setting}-${direction}`];
}

/**
 * Dial-surface settings, stored under the `dial` root key of the action settings.
 * All fields default, so a keypad-only instance (or a fresh dial) parses `{}` to a
 * full object.
 */
export const DialSettings = z
  .object({
    setting: z.enum(ROTATION_SETTINGS).default("tc-slot-1"),
    pressAction: z.enum(GESTURE_ACTIONS).default("toggle-tc"),
    longPressAction: z.enum(GESTURE_ACTIONS).default("none"),
    tapAction: z.enum(GESTURE_ACTIONS).default("none"),
    longTouchAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Dash-box appearance overrides (colors, issue #811).
    ...dialAppearanceFields,
  })
  .prefault({});

export type DialSettings = z.infer<typeof DialSettings>;

/**
 * Seeds the dial config from a pre-dial-surface encoder placement (Ulanzi 2.0
 * alphas drove the flat keypad `setting`). Returns seeded raw settings to persist,
 * or null when no migration applies.
 */
export function seedDialFromLegacySetting(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;

  if (obj.dial !== undefined) return null;

  const legacy = obj.setting;

  if (typeof legacy !== "string" || !(ROTATION_SETTINGS as readonly string[]).includes(legacy)) return null;

  return { ...obj, dial: { setting: legacy } };
}

/**
 * Maps each rotation setting to its shared `view-*` definition so the live value
 * reuses the same telemetry field + formatter the View sub-modes use (#541). A
 * setting with no entry (`undefined`) is identity-only and renders label-only.
 */
const VIEW_ID: Record<SetupTractionDialSetting, ViewSettingId | undefined> = {
  "tc-slot-1": "view-tc-slot-1",
  "tc-slot-2": "view-tc-slot-2",
  "tc-slot-3": "view-tc-slot-3",
  "tc-slot-4": "view-tc-slot-4",
};

/** Short label drawn on the dash box. */
const MODE_ABBR: Record<SetupTractionDialSetting, string> = {
  "tc-slot-1": "TC1",
  "tc-slot-2": "TC2",
  "tc-slot-3": "TC3",
  "tc-slot-4": "TC4",
};

/** Per-setting accent — the DEFAULT dash-box border/label/value color, overridable per dial (#811). */
const MODE_COLOR: Record<SetupTractionDialSetting, string> = {
  "tc-slot-1": "#3498db",
  "tc-slot-2": "#2ecc71",
  "tc-slot-3": "#f39c12",
  "tc-slot-4": "#9b59b6",
};

/** Friendly mode name for the encoder trigger description ("Adjust …"). */
const MODE_LABEL: Record<SetupTractionDialSetting, string> = {
  "tc-slot-1": "TC 1",
  "tc-slot-2": "TC 2",
  "tc-slot-3": "TC 3",
  "tc-slot-4": "TC 4",
};

/**
 * @internal Exported for testing
 *
 * The dash-box value string — the live telemetry value WITHOUT a trailing `%`.
 * Returns an empty string for an identity-only setting (no `view-*` mapping),
 * which the renderer draws as label-only.
 */
export function formatDialValue(setting: SetupTractionDialSetting, telemetry: TelemetryData | null): string {
  const viewId = VIEW_ID[setting];

  if (!viewId) return "";

  return formatViewValue(viewId, telemetry).replace(/%$/, "");
}

/**
 * @internal Exported for testing
 *
 * Computes the encoder trigger descriptions from the current dial settings.
 */
export function buildTriggerDescription(dial: DialSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = {
    rotate: `Adjust ${MODE_LABEL[dial.setting]}`,
  };

  const pushLabel = gestureLabel(dial.pressAction);
  const holdLabel = gestureLabel(dial.longPressAction);

  if (pushLabel && holdLabel) {
    description.push = `${pushLabel} (hold: ${holdLabel})`;
  } else if (pushLabel) {
    description.push = pushLabel;
  } else if (holdLabel) {
    description.push = `Hold: ${holdLabel}`;
  }

  const tapLabel = gestureLabel(dial.tapAction);

  if (tapLabel) {
    description.touch = tapLabel;
  }

  const longTouchLabel = gestureLabel(dial.longTouchAction);

  if (longTouchLabel) {
    description.longTouch = longTouchLabel;
  }

  return description;
}

/** Human-readable label for a gesture slot (for the trigger description). */
function gestureLabel(action: GestureSlot): string | undefined {
  switch (action) {
    case "toggle-tc":
      return "Toggle TC";
    case "none":
      return undefined;
  }
}

/** Per-context runtime state. */
interface SetupTractionDialContext {
  dial: DialSettings;
  action: IDeckActionContext;
  pressStart: number;
  rotatedWhilePressed: boolean;
  lastRenderSig: string | null;
  lastChangeRenderAt: number;
}

/**
 * The delegates the surface needs from its owning action. Deliberately NO
 * `setActiveBinding`: it is one value per action-class instance and setting it
 * from a dial context would bleed onto the keypad buttons.
 */
export interface SetupTractionDialHost {
  readonly logger: ILogger;
  getTelemetry(): TelemetryData | null;
  tapBinding(settingKey: string): Promise<void>;
  isBindingMissing(keys: string | string[] | null | undefined): boolean;
}

/**
 * Owns all per-dial-context state, dispatches rotations and gestures, and renders
 * the touch-strip feedback. The owning action routes every dial lifecycle/input
 * event here and forwards telemetry ticks per subscribed context.
 */
export class SetupTractionDialSurface {
  private readonly contextsState = new Map<string, SetupTractionDialContext>();

  constructor(private readonly host: SetupTractionDialHost) {}

  async willAppear(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    action
      .setImage(renderDialNameIcon({ line1: "SETUP", line2: "TRACTION", backgroundColor: "#1a3a2a" }))
      .catch((err) => {
        this.host.logger.debug(`Dial name icon push failed: ${String(err)}`);
      });

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  willDisappear(actionId: string): void {
    this.contextsState.delete(actionId);
  }

  async didReceiveSettings(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);
    ctx.lastRenderSig = null;

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  async rotate(action: IDeckActionContext, dial: DialSettings, ticks: number, pressed: boolean): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    if (pressed) {
      ctx.rotatedWhilePressed = true;
    }

    const direction: SetupTractionDirection = ticks > 0 ? "increase" : "decrease";
    await this.dispatchRotation(ctx, direction);
  }

  down(action: IDeckActionContext, dial: DialSettings): void {
    const ctx = this.ensureContext(action, dial);

    ctx.pressStart = Date.now();
    ctx.rotatedWhilePressed = false;
  }

  async up(actionId: string): Promise<void> {
    const ctx = this.contextsState.get(actionId);

    if (!ctx) return;

    const pressStartMs = ctx.pressStart;
    ctx.pressStart = 0;

    if (pressStartMs === 0) return;

    const kind = classifyDialRelease({
      pressStartMs,
      nowMs: Date.now(),
      rotatedWhilePressed: ctx.rotatedWhilePressed,
      thresholdMs: getDualPressThresholdMs(),
    });

    if (kind === "push-turn") return;

    const action = kind === "long" ? ctx.dial.longPressAction : ctx.dial.pressAction;

    if (action === "none") return;

    this.host.logger.info(kind === "long" ? "Setup traction dial long-pressed" : "Setup traction dial pressed");
    await this.doGesture(action);
  }

  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    const gesture = hold ? dial.longTouchAction : dial.tapAction;

    if (gesture === "none") return;

    this.ensureContext(action, dial);
    this.host.logger.info(hold ? "Setup traction dial long touch" : "Setup traction dial tap");
    await this.doGesture(gesture);
  }

  onTelemetry(actionId: string, _telemetry: TelemetryData | null): void {
    const ctx = this.contextsState.get(actionId);

    if (!ctx) return;

    const sig = this.displayedSignature(ctx);

    if (sig === ctx.lastRenderSig) return;

    if (Date.now() - ctx.lastChangeRenderAt < CHANGE_RENDER_MIN_INTERVAL_MS) return;

    ctx.lastRenderSig = sig;
    ctx.lastChangeRenderAt = Date.now();
    this.renderFeedback(ctx).catch((err) => {
      this.host.logger.debug(`Dial feedback render failed: ${String(err)}`);
    });
  }

  /** Re-renders every dial context so the #612 warning tracks live bindings offline. */
  refreshAll(): void {
    for (const ctx of this.contextsState.values()) {
      ctx.lastRenderSig = null;
      this.renderFeedback(ctx).catch((err) => {
        this.host.logger.debug(`Dial feedback refresh failed: ${String(err)}`);
      });
    }
  }

  private ensureContext(action: IDeckActionContext, dial: DialSettings): SetupTractionDialContext {
    let ctx = this.contextsState.get(action.id);

    if (!ctx) {
      ctx = {
        dial,
        action,
        pressStart: 0,
        rotatedWhilePressed: false,
        lastRenderSig: null,
        lastChangeRenderAt: 0,
      };
      this.contextsState.set(action.id, ctx);
    } else {
      ctx.action = action;
      ctx.dial = dial;
    }

    return ctx;
  }

  private async dispatchRotation(ctx: SetupTractionDialContext, direction: SetupTractionDirection): Promise<void> {
    const key = rotationKey(ctx.dial.setting, direction);

    if (!key) {
      this.host.logger.warn(`No global key mapping for ${ctx.dial.setting} ${direction}`);

      return;
    }

    this.host.logger.info("Setup traction dial rotated");
    this.host.logger.debug(`${ctx.dial.setting} ${direction}`);
    await this.host.tapBinding(key);
  }

  private async doGesture(action: GestureSlot): Promise<void> {
    if (action === "none") return;

    if (action === "toggle-tc") {
      this.host.logger.info("Setup traction dial toggled TC");
      await this.host.tapBinding(TC_TOGGLE_KEY);
    }
  }

  private computeBindingMissing(dial: DialSettings): boolean {
    const keys = [rotationKey(dial.setting, "increase"), rotationKey(dial.setting, "decrease")].filter(
      (key): key is string => key !== undefined,
    );

    return this.host.isBindingMissing(keys);
  }

  private displayedSignature(ctx: SetupTractionDialContext): string {
    const value = formatDialValue(ctx.dial.setting, this.host.getTelemetry());

    return [ctx.dial.setting, value, this.computeBindingMissing(ctx.dial) ? "warn" : ""].join("|");
  }

  private async applyTriggerDescription(ctx: SetupTractionDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.dial));
  }

  private async renderFeedback(ctx: SetupTractionDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (!ctx.action.isDial()) return;

    const setting = ctx.dial.setting;
    const boxSvg = renderDialBox({
      width: 200,
      height: 100,
      abbr: MODE_ABBR[setting],
      value: formatDialValue(setting, this.host.getTelemetry()),
      colors: resolveDialBoxColors(ctx.dial.colors, MODE_COLOR[setting]),
      identityLabelScale: 0.24,
      bindingMissing: this.computeBindingMissing(ctx.dial),
    });
    const feedback: DeckFeedbackPayload = { box: svgToDataUri(boxSvg) };
    await ctx.action.setFeedback(feedback);

    ctx.lastRenderSig = this.displayedSignature(ctx);
    ctx.lastChangeRenderAt = Date.now();
  }
}
