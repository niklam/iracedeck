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
  applyBindingWarning,
  classifyDialRelease,
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  getDualPressThresholdMs,
  type IDeckActionContext,
  svgToDataUri,
} from "@iracedeck/deck-core";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";

import { formatViewValue, type ViewSettingId } from "../../shared/setup-view.js";
import {
  type GestureSlot,
  rotationKey,
  SETUP_BRAKES_GLOBAL_KEYS,
  type SetupBrakesDialSetting,
  type SetupBrakesDirection,
  type SetupBrakesSettings,
} from "./setup-brakes-settings.js";

/** Background behind the dash box (the device screen is black). */
const BOX_BACKGROUND = "#0d0d0d";

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
 * ABS follows the sim-dashboard convention) and are intentionally not exposed as
 * user color overrides.
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
 * Bold Arial digits + "." average ~0.6 em wide; shrink the value font so the
 * number fits the box width, capped so short values (e.g. "3") stay sensible.
 */
function fitValueFontSize(text: string, maxWidth: number, cap: number): number {
  const approx = maxWidth / Math.max(1, text.length * 0.6);

  return Math.round(Math.min(cap, approx));
}

/**
 * @internal Exported for testing
 *
 * Renders the self-contained "dash box" SVG: a black rounded background, a
 * rounded border in the setting's accent color, the abbreviation label on top,
 * and the value as a large number (auto-shrunk to fit the box). Used for the
 * dial touch-strip pixmap. When the rotation binding is missing the label +
 * value dim under the centered #612 warning triangle (the same convention as
 * the Fuel Service strip).
 */
export function renderBrakeDialBoxSvg(args: {
  width: number;
  height: number;
  color: string;
  abbr: string;
  value: string;
  bindingMissing?: boolean;
}): string {
  const { width: w, height: h, color, abbr, value, bindingMissing = false } = args;
  const minSide = Math.min(w, h);
  const radius = Math.round(minSide * 0.16);
  const inset = Math.max(5, Math.round(minSide * 0.045));
  const strokeWidth = Math.max(5, Math.round(minSide * 0.05));
  const labelFontSize = Math.round(minSide * 0.15);
  const labelY = Math.round(h * 0.28);
  const valueFontSize = fitValueFontSize(
    value,
    w - 2 * (inset + strokeWidth + Math.round(w * 0.05)),
    Math.round(h * 0.52),
  );
  // Nudge the value down from the 0.64 anchor so it sits lower in the box.
  const valueY = Math.round(h * 0.64) + 13;

  const content =
    `<text x="${w / 2}" y="${labelY}" text-anchor="middle" dominant-baseline="central" fill="${color}" font-family="Arial, sans-serif" font-size="${labelFontSize}" font-weight="bold">${abbr}</text>` +
    `<text x="${w / 2}" y="${valueY}" text-anchor="middle" dominant-baseline="central" fill="${color}" font-family="Arial, sans-serif" font-size="${valueFontSize}" font-weight="bold">${value}</text>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" fill="${BOX_BACKGROUND}"/>` +
    `<rect x="${inset}" y="${inset}" width="${w - 2 * inset}" height="${h - 2 * inset}" rx="${Math.max(0, radius - inset)}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"/>` +
    `${bindingMissing ? applyBindingWarning(content, { width: w, height: h }) : content}</svg>`
  );
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

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  willDisappear(actionId: string): void {
    this.contextsState.delete(actionId);
  }

  async didReceiveSettings(action: IDeckActionContext, settings: SetupBrakesSettings): Promise<void> {
    const ctx = this.ensureContext(action, settings);
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
    }

    const direction: SetupBrakesDirection = ticks > 0 ? "increase" : "decrease";
    await this.dispatchRotation(ctx, direction);
  }

  down(action: IDeckActionContext, settings: SetupBrakesSettings): void {
    const ctx = this.ensureContext(action, settings);

    // Record the press start and clear the push+turn guard. Fire nothing and
    // start no timer — press vs long-press is classified once at dialUp.
    ctx.pressStart = Date.now();
    ctx.rotatedWhilePressed = false;
  }

  async up(actionId: string): Promise<void> {
    const ctx = this.contextsState.get(actionId);

    if (!ctx) return;

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
    void this.renderFeedback(ctx);
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
      void this.renderFeedback(ctx);
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
      };
      this.contextsState.set(action.id, ctx);
    } else {
      ctx.action = action;
      ctx.settings = settings;
    }

    return ctx;
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

  /** A compact signature of the displayed state; a feedback push is due when it changes. */
  private displayedSignature(ctx: SetupBrakesDialContext): string {
    const value = formatDialValue(ctx.settings.dial.setting, this.host.getTelemetry());

    return [ctx.settings.dial.setting, value, this.computeBindingMissing(ctx.settings) ? "warn" : ""].join("|");
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
    const boxSvg = renderBrakeDialBoxSvg({
      width: 200,
      height: 100,
      color: MODE_COLOR[setting],
      abbr: MODE_ABBR[setting],
      value: formatDialValue(setting, this.host.getTelemetry()),
      bindingMissing: this.computeBindingMissing(ctx.settings),
    });
    const feedback: DeckFeedbackPayload = { box: svgToDataUri(boxSvg) };
    await ctx.action.setFeedback(feedback);

    // Reset the change-detector baseline so this pushed feedback doesn't
    // immediately re-fire the render-on-change path on the next telemetry tick.
    ctx.lastRenderSig = this.displayedSignature(ctx);
    ctx.lastChangeRenderAt = Date.now();
  }
}
