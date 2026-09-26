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
  createHoldPreview,
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  getDualPressThresholdMs,
  type HoldPreview,
  type IDeckActionContext,
  svgToDataUri,
} from "@iracedeck/deck-core";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import z from "zod";

import { toggleStateFromLevel } from "../../icons/status-bar.js";
import { dialAppearanceFields, renderDialBox, resolveDialBoxColors } from "../../shared/dial-box.js";
import { renderDialNameIcon } from "../../shared/dial-name-icon.js";
import type { DialPendingPreview } from "../../shared/dial-preview.js";
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

/**
 * The hold preview compiled out on the hosts with no plugin touch strip. Every
 * call site stays unconditional and `__FEATURE_DIAL_FEEDBACK__` folds to `false`
 * there, so terser drops this object's users and `createHoldPreview` with them.
 */
const NOOP_HOLD_PREVIEW: HoldPreview = {
  down: () => {},
  up: () => {},
  rotated: () => {},
  dispose: () => {},
  showing: false,
};

/**
 * @internal Exported for testing
 *
 * What the strip shows once the hold passes the long-press threshold (#1120):
 * the state releasing now would leave the car in. `toggle-tc` flips the live TC
 * state, so the outcome is knowable — but only while telemetry reports one. A
 * `na` reading means the plugin does not know which way the toggle will go, and
 * a guess drawn as a promise is worse than a strip that stays still, so it
 * previews nothing and the helper arms no revert.
 *
 * The tri-state comes from the one shared rule the keypad's TC Toggle key uses
 * (`toggleStateFromLevel`: `dcTractionControl > 0` is on). Note that
 * `dcTractionControl` is slot 1 only (see `shared/setup-view.ts`, `view-tc-slot-1`):
 * a car with several TC presets exposes the others as `dcTractionControl2`/`3`/`4`,
 * so the preview predicts the CANONICAL TC — which is exactly what the TC Toggle
 * binding this gesture taps acts on, whichever slot the dial happens to rotate.
 *
 * It is imported from `icons/status-bar.ts` rather than from `setup-traction.ts`'s
 * `tcToggleState` wrapper, which names the same field: `setup-traction.ts`
 * imports THIS module, so reaching back into it would close a workspace import
 * cycle, which the plugin build fails on (#1176).
 */
export function pendingGesturePreview(
  gesture: GestureSlot,
  telemetry: TelemetryData | null,
  color: string,
): DialPendingPreview | null {
  if (gesture !== "toggle-tc") return null;

  const state = toggleStateFromLevel(telemetry?.dcTractionControl);

  if (state === "na") return null;

  return { text: state === "on" ? "TC OFF" : "TC ON", color };
}

/** Per-context runtime state. */
interface SetupTractionDialContext {
  dial: DialSettings;
  action: IDeckActionContext;
  pressStart: number;
  rotatedWhilePressed: boolean;
  lastRenderSig: string | null;
  lastChangeRenderAt: number;
  /**
   * The pending long-press outcome currently on the strip (#1120), or null for
   * the normal display. Read by EVERY render path rather than pushed as a
   * one-off frame: a telemetry tick mid-hold would otherwise redraw the live
   * value over the preview, and the baseline that one-off frame stamped would
   * make the revert look like "nothing changed".
   */
  preview: DialPendingPreview | null;
  /** Arms the preview at the long-press threshold and reverts it on release. */
  holdPreview: HoldPreview;
}

/**
 * The delegates the surface needs from its owning action. Deliberately NO
 * `setActiveBinding`: it is one value per action-class instance and setting it
 * from a dial context would bleed onto the keypad buttons.
 */
export interface SetupTractionDialHost {
  readonly logger: ILogger;
  getTelemetry(): TelemetryData | null;
  tapBinding(settingKey: string): Promise<boolean>;
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
    // The context is gone, so a frame pushed at it would be wasted: tear the
    // preview down without reverting.
    this.contextsState.get(actionId)?.holdPreview.dispose();
    this.contextsState.delete(actionId);
  }

  async didReceiveSettings(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);
    // The gesture may be the thing that just changed, so a preview armed under
    // the old one is void. Drop it without a revert frame — the re-render below
    // IS the revert.
    ctx.holdPreview.dispose();
    ctx.preview = null;
    ctx.lastRenderSig = null;

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  async rotate(action: IDeckActionContext, dial: DialSettings, ticks: number, pressed: boolean): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    if (pressed) {
      ctx.rotatedWhilePressed = true;
      // Push+turn pre-empts the press, so the preview goes at once rather than
      // waiting for the release. Placed beside the guard it mirrors: this
      // surface has no zero-tick early return, so the two always agree.
      ctx.holdPreview.rotated();
    }

    const direction: SetupTractionDirection = ticks > 0 ? "increase" : "decrease";
    await this.dispatchRotation(ctx, direction);
  }

  down(action: IDeckActionContext, dial: DialSettings): void {
    const ctx = this.ensureContext(action, dial);

    ctx.pressStart = Date.now();
    ctx.rotatedWhilePressed = false;
    // The only timer this arms DRAWS and never dispatches — press vs long-press
    // is still classified once at dialUp (#1120).
    ctx.holdPreview.down();
  }

  async up(actionId: string): Promise<void> {
    const ctx = this.contextsState.get(actionId);

    if (!ctx) return;

    // Take the preview off the strip before ANY of the early returns below: a
    // release that fires no gesture (a stray dialUp, a push+turn, a `none`
    // slot) must still revert what the hold drew.
    ctx.holdPreview.up();

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
        preview: null,
        // Replaced immediately below — the preview's callbacks close over the
        // very context being built. On a host with no plugin touch strip the
        // no-op is what stays.
        holdPreview: NOOP_HOLD_PREVIEW,
      };
      ctx.holdPreview = this.createPreview(ctx);
      this.contextsState.set(action.id, ctx);
    } else {
      ctx.action = action;
      ctx.dial = dial;
    }

    return ctx;
  }

  /** The per-context hold preview, or the no-op where there is no touch strip. */
  private createPreview(ctx: SetupTractionDialContext): HoldPreview {
    if (!__FEATURE_DIAL_FEEDBACK__) return NOOP_HOLD_PREVIEW;

    return createHoldPreview({
      // The same value the release classifier reads, so the strip changes at
      // exactly the instant a release starts counting as a long press.
      thresholdMs: () => getDualPressThresholdMs(),
      onThreshold: () => this.showPreview(ctx),
      onCancel: () => this.hidePreview(ctx),
    });
  }

  /**
   * Draws the long-press outcome. Returns whether anything was drawn — a
   * gesture with no knowable outcome leaves the strip alone, which is what
   * stops the release pushing a pointless revert frame.
   */
  private showPreview(ctx: SetupTractionDialContext): boolean {
    const pending = pendingGesturePreview(
      ctx.dial.longPressAction,
      this.host.getTelemetry(),
      resolveDialBoxColors(ctx.dial.colors, MODE_COLOR[ctx.dial.setting]).value,
    );

    if (!pending) return false;

    ctx.preview = pending;
    this.renderFeedback(ctx).catch((err) => {
      this.host.logger.debug(`Dial hold preview render failed: ${String(err)}`);
    });

    return true;
  }

  /** Reverts to the normal strip after a preview that was showing. */
  private hidePreview(ctx: SetupTractionDialContext): void {
    ctx.preview = null;
    this.renderFeedback(ctx).catch((err) => {
      this.host.logger.debug(`Dial hold preview revert failed: ${String(err)}`);
    });
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

  /**
   * The pending preview is part of the DISPLAYED state, so it belongs in the
   * signature: without it, arming and reverting a preview would both leave the
   * baseline unchanged and the next telemetry tick would decide the strip was
   * already correct.
   */
  private displayedSignature(ctx: SetupTractionDialContext): string {
    const value = formatDialValue(ctx.dial.setting, this.host.getTelemetry());

    return [
      ctx.dial.setting,
      value,
      this.computeBindingMissing(ctx.dial) ? "warn" : "",
      ctx.preview ? `pending:${ctx.preview.text}` : "",
    ].join("|");
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
      // EVERY render path carries the pending preview, so a telemetry tick or a
      // global-settings refresh mid-hold redraws it instead of wiping it.
      pending: ctx.preview,
    });
    const feedback: DeckFeedbackPayload = { box: svgToDataUri(boxSvg) };
    await ctx.action.setFeedback(feedback);

    ctx.lastRenderSig = this.displayedSignature(ctx);
    ctx.lastChangeRenderAt = Date.now();
  }
}
