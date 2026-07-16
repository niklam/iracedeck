/**
 * The dial surface of the View Adjustment action (issue #806) — the dual-surface
 * pattern established by Fuel Service (#759) and the Setup dials (#775, #795–#800),
 * ported behind a host interface.
 *
 * Self-contained leaf: it owns the `dial` settings schema and all dial key
 * bindings, and the owning action imports the schema + surface from here (so
 * there is no import cycle with the action's inline keypad settings). Its methods
 * operate on the `dial` sub-object (a {@link DialSettings}).
 *
 * Rotating adjusts one view value (FOV, horizon, driver height, UI size) via the
 * same key bindings as the keypad surface. Pressing runs a configurable gesture,
 * defaulting to **Recenter VR** — blind-safe (harmless if fired accidentally and
 * exactly the gesture a VR driver wants under their finger, which is the whole
 * motivation for this dial), so the encoders rule's "default None unless blind-
 * safe" carve-out lets it be the press default.
 *
 * iRacing exposes **no** telemetry for any of these values, so every setting is
 * identity-only: the touch strip shows the setting's label with no value (the
 * documented Audio-Controls voice-chat/master compromise, #782). This candidate
 * is rotation-fit-driven, not data-driven.
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

/** Minimum gap (ms) between change-driven feedback pushes (≤10 setFeedback/s/dial). */
const CHANGE_RENDER_MIN_INTERVAL_MS = 100;

/**
 * Cap on how many binding taps a single rotate event dispatches. A fast spin
 * coalesces into |ticks| > 1; scaling by ticks (capped) advances multiple
 * detents per event so the adjustment tracks the wheel, while the cap keeps
 * one flick from firing an unbounded burst.
 */
const MAX_TAPS_PER_EVENT = 5;

/**
 * The directional view adjustments the dial can drive. Recenter VR is absent —
 * it is non-directional (a one-shot), so it is offered as a press gesture below
 * rather than a rotation setting.
 */
export const ROTATION_SETTINGS = ["fov", "horizon", "driver-height", "ui-size"] as const;
export type ViewAdjustmentDialSetting = (typeof ROTATION_SETTINGS)[number];

/** Gesture slots. `recenter-vr` taps the shared View Adjustment Recenter VR binding. */
export const GESTURE_ACTIONS = ["recenter-vr", "none"] as const;
export type GestureSlot = (typeof GESTURE_ACTIONS)[number];

export type ViewAdjustmentDirection = "increase" | "decrease";

/**
 * Global key bindings the dial taps. These mirror the keypad
 * `VIEW_ADJUSTMENT_GLOBAL_KEYS` entries; kept here (not imported) so this module
 * stays a leaf with no cycle back to the action's inline settings.
 */
const DIAL_ROTATION_KEYS: Record<string, string> = {
  "fov-increase": "viewAdjustFovIncrease",
  "fov-decrease": "viewAdjustFovDecrease",
  "horizon-increase": "viewAdjustHorizonUp",
  "horizon-decrease": "viewAdjustHorizonDown",
  "driver-height-increase": "viewAdjustDriverHeightUp",
  "driver-height-decrease": "viewAdjustDriverHeightDown",
  "ui-size-increase": "viewAdjustUiSizeIncrease",
  "ui-size-decrease": "viewAdjustUiSizeDecrease",
};
const RECENTER_VR_KEY = "viewAdjustRecenterVr";

/** Resolves the shared increase/decrease binding for a dial setting + direction. */
export function rotationKey(
  setting: ViewAdjustmentDialSetting,
  direction: ViewAdjustmentDirection,
): string | undefined {
  return DIAL_ROTATION_KEYS[`${setting}-${direction}`];
}

/**
 * Dial-surface settings, stored under the `dial` root key of the action settings.
 * All fields default, so a keypad-only instance (or a fresh dial) parses `{}` to a
 * full object. Press defaults to Recenter VR (blind-safe, #806); the long-press
 * and touch slots default None so a VR driver who can't see the strip isn't
 * surprised.
 */
export const DialSettings = z
  .object({
    setting: z.enum(ROTATION_SETTINGS).default("fov"),
    pressAction: z.enum(GESTURE_ACTIONS).default("recenter-vr"),
    longPressAction: z.enum(GESTURE_ACTIONS).default("none"),
    tapAction: z.enum(GESTURE_ACTIONS).default("none"),
    longTouchAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Dash-box appearance overrides (colors, issue #811).
    ...dialAppearanceFields,
  })
  .prefault({});

export type DialSettings = z.infer<typeof DialSettings>;

/**
 * Seeds the dial config from a pre-dial-surface encoder placement that drove the
 * flat keypad `adjustment` setting. Returns seeded raw settings to persist, or
 * null when no migration applies. (View Adjustment's keypad mode setting is
 * `adjustment`, not `setting`.) `recenter-vr` is deliberately not a rotation
 * value, so a legacy Recenter VR encoder falls through to the default `fov`.
 */
export function seedDialFromLegacySetting(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;

  if (obj.dial !== undefined) return null;

  const legacy = obj.adjustment;

  if (typeof legacy !== "string" || !(ROTATION_SETTINGS as readonly string[]).includes(legacy)) return null;

  return { ...obj, dial: { setting: legacy } };
}

/** Short label drawn on the identity-only dash box. */
const MODE_ABBR: Record<ViewAdjustmentDialSetting, string> = {
  fov: "FOV",
  horizon: "HORIZON",
  "driver-height": "HEIGHT",
  "ui-size": "UI SIZE",
};

/** Per-setting accent — the DEFAULT dash-box border/label color, overridable per dial (#811). */
const MODE_COLOR: Record<ViewAdjustmentDialSetting, string> = {
  fov: "#3498db",
  horizon: "#2ecc71",
  "driver-height": "#f39c12",
  "ui-size": "#9b59b6",
};

/** Friendly mode name for the encoder trigger description ("Adjust …"). */
const MODE_LABEL: Record<ViewAdjustmentDialSetting, string> = {
  fov: "FOV",
  horizon: "Horizon",
  "driver-height": "Driver Height",
  "ui-size": "UI Size",
};

/**
 * @internal Exported for testing
 *
 * The dash-box value string. Every View Adjustment setting is identity-only —
 * iRacing exposes no telemetry for FOV/horizon/driver-height/UI-size — so this
 * always returns an empty string, which the renderer draws as a label-only box
 * (#782). Kept as a function (rather than inlined) for family-shape parity with
 * the readback surfaces and so the displayed-signature machinery has a stable
 * value component.
 */
export function formatDialValue(_setting: ViewAdjustmentDialSetting): string {
  return "";
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
    case "recenter-vr":
      return "Recenter VR";
    case "none":
      return undefined;
  }
}

/** Per-context runtime state. */
interface ViewAdjustmentDialContext {
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
export interface ViewAdjustmentDialHost {
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
export class ViewAdjustmentDialSurface {
  private readonly contextsState = new Map<string, ViewAdjustmentDialContext>();

  constructor(private readonly host: ViewAdjustmentDialHost) {}

  async willAppear(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    action.setImage(renderDialNameIcon({ line1: "VIEW", line2: "ADJUST", backgroundColor: "#1a2a3a" })).catch((err) => {
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

    if (ticks === 0) return;

    const direction: ViewAdjustmentDirection = ticks > 0 ? "increase" : "decrease";
    const taps = Math.min(Math.abs(ticks), MAX_TAPS_PER_EVENT);
    await this.dispatchRotation(ctx, direction, taps);
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

    this.host.logger.info(kind === "long" ? "View adjustment dial long-pressed" : "View adjustment dial pressed");
    await this.doGesture(action);
  }

  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    const gesture = hold ? dial.longTouchAction : dial.tapAction;

    if (gesture === "none") return;

    this.ensureContext(action, dial);
    this.host.logger.info(hold ? "View adjustment dial long touch" : "View adjustment dial tap");
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

  private ensureContext(action: IDeckActionContext, dial: DialSettings): ViewAdjustmentDialContext {
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

  private async dispatchRotation(
    ctx: ViewAdjustmentDialContext,
    direction: ViewAdjustmentDirection,
    taps: number,
  ): Promise<void> {
    const key = rotationKey(ctx.dial.setting, direction);

    if (!key) {
      this.host.logger.warn(`No global key mapping for ${ctx.dial.setting} ${direction}`);

      return;
    }

    this.host.logger.info("View adjustment dial rotated");
    this.host.logger.debug(`${ctx.dial.setting} ${direction} x${taps}`);

    for (let i = 0; i < taps; i++) {
      await this.host.tapBinding(key);
    }
  }

  private async doGesture(action: GestureSlot): Promise<void> {
    if (action === "none") return;

    if (action === "recenter-vr") {
      this.host.logger.info("View adjustment dial recentered VR");
      await this.host.tapBinding(RECENTER_VR_KEY);
    }
  }

  private computeBindingMissing(dial: DialSettings): boolean {
    const keys = [rotationKey(dial.setting, "increase"), rotationKey(dial.setting, "decrease")].filter(
      (key): key is string => key !== undefined,
    );

    return this.host.isBindingMissing(keys);
  }

  private displayedSignature(ctx: ViewAdjustmentDialContext): string {
    const value = formatDialValue(ctx.dial.setting);

    return [ctx.dial.setting, value, this.computeBindingMissing(ctx.dial) ? "warn" : ""].join("|");
  }

  private async applyTriggerDescription(ctx: ViewAdjustmentDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.dial));
  }

  private async renderFeedback(ctx: ViewAdjustmentDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (!ctx.action.isDial()) return;

    const setting = ctx.dial.setting;
    const boxSvg = renderDialBox({
      width: 200,
      height: 100,
      abbr: MODE_ABBR[setting],
      value: formatDialValue(setting),
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
