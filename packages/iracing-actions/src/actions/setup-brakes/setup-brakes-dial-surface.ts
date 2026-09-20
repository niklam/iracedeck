/**
 * The dial surface of the merged Setup Brakes action (issue #775) — the former
 * standalone Setup Brakes Dial action (#730), ported behind a host interface
 * the same way Fuel Service hosts its `FuelDialSurface` (#759).
 *
 * Rotating adjusts one brake setup parameter (brake bias, peak bias, bias
 * fine, brake misc, engine braking, ABS adjust) via the same key bindings as
 * the keypad surface; the touch strip shows the live telemetry value in a
 * color-coded "dash box". Pressing runs a configurable gesture (default:
 * toggle ABS).
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

import { toggleStateFromLevel } from "../../icons/status-bar.js";
import { renderDialBox, resolveDialBoxColors } from "../../shared/dial-box.js";
import { renderDialNameIcon } from "../../shared/dial-name-icon.js";
import type { DialPendingPreview } from "../../shared/dial-preview.js";
import { formatViewValue, type ViewSettingId } from "../../shared/setup-view.js";
import {
  type GestureSlot,
  rotationKey,
  SETUP_BRAKES_GLOBAL_KEYS,
  type SetupBrakesDialSetting,
  type SetupBrakesDirection,
  type SetupBrakesSettings,
} from "./setup-brakes-settings.js";

/**
 * Minimum gap (ms) between change-driven feedback pushes. A fast spin moves the
 * telemetry value rapidly; the display re-renders the moment the value changes,
 * but no more than once per this window so a burst of telemetry can't exceed the
 * documented ≤10 `setFeedback`/sec/dial cap (mirrors the Fuel Service dial).
 */
const CHANGE_RENDER_MIN_INTERVAL_MS = 100;

/**
 * Maps each rotation setting to its shared `view-*` definition so the live value
 * reuses the same telemetry field + formatter the View sub-modes use (#541).
 */
const VIEW_ID: Record<SetupBrakesDialSetting, ViewSettingId> = {
  "brake-bias": "view-brake-bias",
  "brake-bias-fine": "view-brake-bias-fine",
  "peak-brake-bias": "view-peak-brake-bias",
  "brake-misc": "view-brake-misc",
  "engine-braking": "view-engine-braking",
  "abs-adjust": "view-abs-adjust",
};

/** Short label drawn on the dash box (e.g. the dashboard "BB" / "ABS" codes). */
const MODE_ABBR: Record<SetupBrakesDialSetting, string> = {
  "brake-bias": "BB",
  "brake-bias-fine": "BBF",
  "peak-brake-bias": "PEAK",
  "brake-misc": "MISC",
  "engine-braking": "ENG",
  "abs-adjust": "ABS",
};

/**
 * Per-setting accent color for the dash box's border, label, and value. These are
 * semantic (a glance distinguishes one configured dial from another, and yellow
 * ABS follows the sim-dashboard convention) and serve as the DEFAULT border,
 * label, and value color — each independently overridable per dial (issue #811).
 */
const MODE_COLOR: Record<SetupBrakesDialSetting, string> = {
  "brake-bias": "#e74c3c",
  "brake-bias-fine": "#e67e22",
  "peak-brake-bias": "#9b59b6",
  "brake-misc": "#3498db",
  "engine-braking": "#2ecc71",
  "abs-adjust": "#f39c12",
};

/** Friendly mode name for the encoder trigger description ("Adjust …"). */
const MODE_LABEL: Record<SetupBrakesDialSetting, string> = {
  "brake-bias": "Brake Bias",
  "brake-bias-fine": "Brake Bias Fine",
  "peak-brake-bias": "Peak Brake Bias",
  "brake-misc": "Brake Misc",
  "engine-braking": "Engine Braking",
  "abs-adjust": "ABS",
};

/**
 * @internal Exported for testing
 *
 * The value string shown on the dash box — the live telemetry value WITHOUT the
 * trailing `%` (the big number is the hero; bias values read as percentages). The
 * shared View formatter supplies the percent/integer formatting and the `---`
 * placeholder when telemetry is unavailable.
 */
export function formatDialValue(setting: SetupBrakesDialSetting, telemetry: TelemetryData | null): string {
  return formatViewValue(VIEW_ID[setting], telemetry).replace(/%$/, "");
}

/**
 * @internal Exported for testing
 *
 * Computes the encoder trigger descriptions from the current settings. `rotate`
 * names the bound setting; `push` carries the press action with the long-press as
 * a "(hold: …)" hint; `touch` / `longTouch` carry the touch-strip gestures.
 */
export function buildTriggerDescription(settings: SetupBrakesSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = {
    rotate: `Adjust ${MODE_LABEL[settings.dial.setting]}`,
  };

  const pushLabel = gestureLabel(settings.dial.pressAction);
  const holdLabel = gestureLabel(settings.dial.longPressAction);

  if (pushLabel && holdLabel) {
    description.push = `${pushLabel} (hold: ${holdLabel})`;
  } else if (pushLabel) {
    description.push = pushLabel;
  } else if (holdLabel) {
    description.push = `Hold: ${holdLabel}`;
  }

  const tapLabel = gestureLabel(settings.dial.tapAction);

  if (tapLabel) {
    description.touch = tapLabel;
  }

  const longTouchLabel = gestureLabel(settings.dial.longTouchAction);

  if (longTouchLabel) {
    description.longTouch = longTouchLabel;
  }

  return description;
}

/** Human-readable label for a gesture slot (for the trigger description). */
function gestureLabel(action: GestureSlot): string | undefined {
  switch (action) {
    case "toggle-abs":
      return "Toggle ABS";
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
 * the state releasing now would leave the car in. `toggle-abs` flips the live
 * ABS state, so the outcome is knowable — but only while telemetry reports one.
 * A `na` reading means the plugin does not know which way the toggle will go,
 * and a guess drawn as a promise is worse than a strip that stays still, so it
 * previews nothing and the helper arms no revert.
 *
 * The tri-state comes from the one shared rule the keypad's ABS Toggle key uses
 * (`toggleStateFromLevel`: `dcABS > 0` is on). It is imported from
 * `icons/status-bar.ts` rather than from `setup-brakes.ts`'s `absToggleState`
 * wrapper, which names the same field: `setup-brakes.ts` imports THIS module,
 * so reaching back into it would close a workspace import cycle, which the
 * plugin build fails on (#1176).
 */
export function pendingGesturePreview(
  gesture: GestureSlot,
  telemetry: TelemetryData | null,
  color: string,
): DialPendingPreview | null {
  if (gesture !== "toggle-abs") return null;

  const state = toggleStateFromLevel(telemetry?.dcABS);

  if (state === "na") return null;

  return { text: state === "on" ? "ABS OFF" : "ABS ON", color };
}

/** Per-context runtime state. */
interface SetupBrakesDialContext {
  settings: SetupBrakesSettings;
  action: IDeckActionContext;
  /** Timestamp (ms) the current dial-button press started (dialDown). */
  pressStart: number;
  /**
   * Whether the dial was rotated while the button was held during the current
   * press. Set in rotate (pressed === true), read once at dialUp so a
   * push+turn (used to adjust without firing the press gesture) fires no gesture
   * on release.
   */
  rotatedWhilePressed: boolean;
  /** Signature of the DISPLAYED state at the last change-driven render. */
  lastRenderSig: string | null;
  /** Timestamp (ms) of the last change-driven feedback push (throttle gate). */
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
 * The delegates the surface needs from its owning action. Binding dispatch
 * stays on the action so keyboard/SimHub routing is unchanged. Deliberately
 * NO `setActiveBinding`: readiness state is one value per action-class
 * instance and setting it from a dial context would bleed onto the action's
 * keypad buttons (see global-settings.md), so dial instances don't declare
 * active bindings — same call as the Fuel Service dial surface.
 */
export interface SetupBrakesDialHost {
  readonly logger: ILogger;
  getTelemetry(): TelemetryData | null;
  tapBinding(settingKey: string): Promise<void>;
  isBindingMissing(keys: string | string[] | null | undefined): boolean;
}

/**
 * Owns all per-dial-context state, dispatches rotations and gestures, and
 * renders the touch-strip feedback. The owning action routes every dial
 * lifecycle/input event here and forwards telemetry ticks per subscribed
 * context.
 */
export class SetupBrakesDialSurface {
  private readonly contextsState = new Map<string, SetupBrakesDialContext>();

  constructor(private readonly host: SetupBrakesDialHost) {}

  async willAppear(action: IDeckActionContext, settings: SetupBrakesSettings): Promise<void> {
    const ctx = this.ensureContext(action, settings);

    // The deck-app image for the dial: just the action name (#775). Without
    // this the app falls back to keypad iconography for the dial slot.
    action
      .setImage(renderDialNameIcon({ line1: "SETUP", line2: "BRAKES", backgroundColor: "#3a2a1a" }))
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

  async didReceiveSettings(action: IDeckActionContext, settings: SetupBrakesSettings): Promise<void> {
    const ctx = this.ensureContext(action, settings);
    // The gesture may be the thing that just changed, so a preview armed under
    // the old one is void. Drop it without a revert frame — the re-render below
    // IS the revert.
    ctx.holdPreview.dispose();
    ctx.preview = null;
    // Bust the memo so the next render reflects the new mode even if it happens
    // to format to the same value string as the previous one.
    ctx.lastRenderSig = null;

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  async rotate(
    action: IDeckActionContext,
    settings: SetupBrakesSettings,
    ticks: number,
    pressed: boolean,
  ): Promise<void> {
    const ctx = this.ensureContext(action, settings);

    // A pressed rotation still adjusts the setting; the guard makes the dialUp
    // classifier skip the press gesture so holding-and-turning never also toggles
    // ABS. The displayed value settles a beat later from telemetry.
    if (pressed) {
      ctx.rotatedWhilePressed = true;
      // Push+turn pre-empts the press, so the preview goes at once rather than
      // waiting for the release. Placed beside the guard it mirrors: this
      // surface has no zero-tick early return, so the two always agree.
      ctx.holdPreview.rotated();
    }

    const direction: SetupBrakesDirection = ticks > 0 ? "increase" : "decrease";
    await this.dispatchRotation(ctx, direction);
  }

  down(action: IDeckActionContext, settings: SetupBrakesSettings): void {
    const ctx = this.ensureContext(action, settings);

    // Record the press start and clear the push+turn guard. Fire nothing: the
    // only timer armed here DRAWS and never dispatches — press vs long-press is
    // still classified once at dialUp (#1120).
    ctx.pressStart = Date.now();
    ctx.rotatedWhilePressed = false;
    ctx.holdPreview.down();
  }

  async up(actionId: string): Promise<void> {
    const ctx = this.contextsState.get(actionId);

    if (!ctx) return;

    // Take the preview off the strip before ANY of the early returns below: a
    // release that fires no gesture (a stray dialUp, a push+turn, a `none`
    // slot) must still revert what the hold drew.
    ctx.holdPreview.up();

    // Consume the press start immediately so a stray dialUp without a preceding
    // dialDown can't reclassify. A 0 sentinel means "no press in progress".
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

    const action = kind === "long" ? ctx.settings.dial.longPressAction : ctx.settings.dial.pressAction;

    if (action === "none") return;

    this.host.logger.info(kind === "long" ? "Setup brakes dial long-pressed" : "Setup brakes dial pressed");
    await this.doGesture(action);
  }

  async touchTap(action: IDeckActionContext, settings: SetupBrakesSettings, hold: boolean): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    // hold === true → Long Touch slot; hold === false → Tap Display slot.
    const gesture = hold ? settings.dial.longTouchAction : settings.dial.tapAction;

    if (gesture === "none") return;

    this.ensureContext(action, settings);
    this.host.logger.info(hold ? "Setup brakes dial long touch" : "Setup brakes dial tap");
    await this.doGesture(gesture);
  }

  onTelemetry(actionId: string, _telemetry: TelemetryData | null): void {
    const ctx = this.contextsState.get(actionId);

    if (!ctx) return;

    const sig = this.displayedSignature(ctx);

    if (sig === ctx.lastRenderSig) return;

    // Changed but feedback-throttled: do nothing and do NOT advance
    // lastRenderSig, so the throttled feedback still fires next window.
    if (Date.now() - ctx.lastChangeRenderAt < CHANGE_RENDER_MIN_INTERVAL_MS) return;

    // Advance the baseline SYNCHRONOUSLY before the async render: 60 Hz ticks
    // arriving while the setFeedback push is still in flight would otherwise
    // each fire another push inside the same 100 ms window, defeating the
    // ≤10 setFeedback/sec/dial throttle.
    ctx.lastRenderSig = sig;
    ctx.lastChangeRenderAt = Date.now();
    this.renderFeedback(ctx).catch((err) => {
      this.host.logger.debug(`Dial feedback render failed: ${String(err)}`);
    });
  }

  /**
   * Re-renders every dial context (settings-memo busted). Called by the owning
   * action on global-settings changes so the strip's #612 missing-binding
   * warning tracks live binding configuration even while iRacing is offline
   * (no telemetry ticks arrive to trigger the render-on-change path).
   */
  refreshAll(): void {
    for (const ctx of this.contextsState.values()) {
      ctx.lastRenderSig = null;
      this.renderFeedback(ctx).catch((err) => {
        this.host.logger.debug(`Dial feedback refresh failed: ${String(err)}`);
      });
    }
  }

  private ensureContext(action: IDeckActionContext, settings: SetupBrakesSettings): SetupBrakesDialContext {
    let ctx = this.contextsState.get(action.id);

    if (!ctx) {
      ctx = {
        settings,
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
      ctx.settings = settings;
    }

    return ctx;
  }

  /** The per-context hold preview, or the no-op where there is no touch strip. */
  private createPreview(ctx: SetupBrakesDialContext): HoldPreview {
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
  private showPreview(ctx: SetupBrakesDialContext): boolean {
    const setting = ctx.settings.dial.setting;
    const pending = pendingGesturePreview(
      ctx.settings.dial.longPressAction,
      this.host.getTelemetry(),
      resolveDialBoxColors(ctx.settings.dial.colors, MODE_COLOR[setting]).value,
    );

    if (!pending) return false;

    ctx.preview = pending;
    this.renderFeedback(ctx).catch((err) => {
      this.host.logger.debug(`Dial hold preview render failed: ${String(err)}`);
    });

    return true;
  }

  /** Reverts to the normal strip after a preview that was showing. */
  private hidePreview(ctx: SetupBrakesDialContext): void {
    ctx.preview = null;
    this.renderFeedback(ctx).catch((err) => {
      this.host.logger.debug(`Dial hold preview revert failed: ${String(err)}`);
    });
  }

  /** Taps the shared Setup Brakes increase/decrease binding for the bound setting. */
  private async dispatchRotation(ctx: SetupBrakesDialContext, direction: SetupBrakesDirection): Promise<void> {
    const key = rotationKey(ctx.settings.dial.setting, direction);

    if (!key) {
      this.host.logger.warn(`No global key mapping for ${ctx.settings.dial.setting} ${direction}`);

      return;
    }

    this.host.logger.info("Setup brakes dial rotated");
    this.host.logger.debug(`${ctx.settings.dial.setting} ${direction}`);
    await this.host.tapBinding(key);
  }

  /** Runs a configured press / touch gesture. */
  private async doGesture(action: GestureSlot): Promise<void> {
    if (action === "none") return;

    if (action === "toggle-abs") {
      const key = SETUP_BRAKES_GLOBAL_KEYS["abs-toggle"];

      if (!key) {
        this.host.logger.warn("No global key mapping for abs-toggle");

        return;
      }

      this.host.logger.info("Setup brakes dial toggled ABS");
      await this.host.tapBinding(key);
    }
  }

  /**
   * The dial's primary function is rotation, which needs BOTH the increase and
   * decrease bindings of the bound setting (#612); the ABS-toggle press gesture
   * is secondary and never gates the strip warning.
   */
  private computeBindingMissing(settings: SetupBrakesSettings): boolean {
    const keys = [
      rotationKey(settings.dial.setting, "increase"),
      rotationKey(settings.dial.setting, "decrease"),
    ].filter((key): key is string => key !== undefined);

    return this.host.isBindingMissing(keys);
  }

  /**
   * A compact signature of the displayed state; a feedback push is due when it
   * changes. The pending preview is part of the DISPLAYED state, so it belongs
   * here: without it, arming and reverting a preview would both leave the
   * baseline unchanged and the next telemetry tick would decide the strip was
   * already correct.
   */
  private displayedSignature(ctx: SetupBrakesDialContext): string {
    const value = formatDialValue(ctx.settings.dial.setting, this.host.getTelemetry());

    return [
      ctx.settings.dial.setting,
      value,
      this.computeBindingMissing(ctx.settings) ? "warn" : "",
      ctx.preview ? `pending:${ctx.preview.text}` : "",
    ].join("|");
  }

  /** Pushes the encoder trigger descriptions for a dial (Elgato only). */
  private async applyTriggerDescription(ctx: SetupBrakesDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.settings));
  }

  /** Pushes the touch-strip feedback (the full-cell dash box) when this is a dial. */
  private async renderFeedback(ctx: SetupBrakesDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (!ctx.action.isDial()) return;

    const setting = ctx.settings.dial.setting;
    const boxSvg = renderDialBox({
      width: 200,
      height: 100,
      abbr: MODE_ABBR[setting],
      value: formatDialValue(setting, this.host.getTelemetry()),
      colors: resolveDialBoxColors(ctx.settings.dial.colors, MODE_COLOR[setting]),
      bindingMissing: this.computeBindingMissing(ctx.settings),
      // EVERY render path carries the pending preview, so a telemetry tick or a
      // global-settings refresh mid-hold redraws it instead of wiping it.
      pending: ctx.preview,
    });
    const feedback: DeckFeedbackPayload = { box: svgToDataUri(boxSvg) };
    await ctx.action.setFeedback(feedback);

    // Reset the change-detector baseline so this pushed feedback doesn't
    // immediately re-fire the render-on-change path on the next telemetry tick.
    ctx.lastRenderSig = this.displayedSignature(ctx);
    ctx.lastChangeRenderAt = Date.now();
  }
}
