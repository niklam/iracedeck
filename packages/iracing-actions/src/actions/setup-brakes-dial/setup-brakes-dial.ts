import {
  applyBindingWarning,
  classifyDialRelease,
  CommonSettings,
  ConnectionStateAwareAction,
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  getDualPressThresholdMs,
  type IDeckActionContext,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckTouchTapEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  svgToDataUri,
} from "@iracedeck/deck-core";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import { formatViewValue, type ViewSettingId } from "../../shared/setup-view.js";
import { SETUP_BRAKES_GLOBAL_KEYS } from "../setup-brakes/setup-brakes.js";

/** Background behind the dash box (the device screen is black). */
const BOX_BACKGROUND = "#0d0d0d";

/**
 * Minimum gap (ms) between change-driven feedback pushes. A fast spin moves the
 * telemetry value rapidly; the display re-renders the moment the value changes,
 * but no more than once per this window so a burst of telemetry can't exceed the
 * documented ≤10 `setFeedback`/sec/dial cap (mirrors Fuel Dial).
 */
const CHANGE_RENDER_MIN_INTERVAL_MS = 100;

/**
 * The directional brake adjustment settings the dial can drive. Mirrors the
 * directional subset of the key-based Setup Brakes action (View sub-modes are
 * omitted — the dial display itself shows the live value; ABS Toggle is omitted
 * as a rotation mode since on/off doesn't map to a rotary, but it remains
 * available as a configurable press gesture).
 */
const ROTATION_SETTINGS = [
  "brake-bias",
  "brake-bias-fine",
  "peak-brake-bias",
  "brake-misc",
  "engine-braking",
  "abs-adjust",
] as const;

type SetupBrakesDialSetting = (typeof ROTATION_SETTINGS)[number];

/**
 * The actions a dial-button / touch gesture (Push, Long Press, Tap Display, Long
 * Touch) can run, plus the "none" sentinel. `toggle-abs` taps the shared Setup
 * Brakes ABS Toggle key binding.
 */
const GESTURE_ACTIONS = ["toggle-abs", "none"] as const;
type GestureSlot = (typeof GESTURE_ACTIONS)[number];

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

const SetupBrakesDialSettings = CommonSettings.extend({
  setting: z.enum(ROTATION_SETTINGS).default("brake-bias"),
  // Push (short press) — fires on dialUp. Default: toggle ABS.
  pressAction: z.enum(GESTURE_ACTIONS).default("toggle-abs"),
  // Long Press (held dial button past the threshold, no rotation) — fires on dialUp.
  longPressAction: z.enum(GESTURE_ACTIONS).default("none"),
  // Tap Display (touch-strip tap, hold === false). Default None for VR safety.
  tapAction: z.enum(GESTURE_ACTIONS).default("none"),
  // Long Touch (touch-strip tap, hold === true). Default None for VR safety.
  longTouchAction: z.enum(GESTURE_ACTIONS).default("none"),
});

type SetupBrakesDialSettings = z.infer<typeof SetupBrakesDialSettings>;

type DirectionType = "increase" | "decrease";

/** Resolves the shared Setup Brakes global key binding for a setting + direction. */
function rotationKey(setting: SetupBrakesDialSetting, direction: DirectionType): string | undefined {
  return SETUP_BRAKES_GLOBAL_KEYS[`${setting}-${direction}`];
}

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
 * and the value as a large number (auto-shrunk to fit the box). Used for both the
 * 144×144 keypad icon and the (wider) dial touch-strip pixmap. When the rotation
 * binding is missing the label + value dim under the centered #612 warning
 * triangle (only meaningful at the 144×144 key size).
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
    `${bindingMissing ? applyBindingWarning(content) : content}</svg>`
  );
}

/**
 * @internal Exported for testing
 *
 * Computes the encoder trigger descriptions from the current settings. `rotate`
 * names the bound setting; `push` carries the press action with the long-press as
 * a "(hold: …)" hint; `touch` / `longTouch` carry the touch-strip gestures.
 */
export function buildTriggerDescription(settings: SetupBrakesDialSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = {
    rotate: `Adjust ${MODE_LABEL[settings.setting]}`,
  };

  const pushLabel = gestureLabel(settings.pressAction);
  const holdLabel = gestureLabel(settings.longPressAction);

  if (pushLabel && holdLabel) {
    description.push = `${pushLabel} (hold: ${holdLabel})`;
  } else if (pushLabel) {
    description.push = pushLabel;
  } else if (holdLabel) {
    description.push = `Hold: ${holdLabel}`;
  }

  const tapLabel = gestureLabel(settings.tapAction);

  if (tapLabel) {
    description.touch = tapLabel;
  }

  const longTouchLabel = gestureLabel(settings.longTouchAction);

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
  settings: SetupBrakesDialSettings;
  action: IDeckActionContext;
  /** Timestamp (ms) the current dial-button press started (dialDown). */
  pressStart: number;
  /**
   * Whether the dial was rotated while the button was held during the current
   * press. Set in onDialRotate (pressed === true), read once at dialUp so a
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
 * Setup Brakes Dial Action
 *
 * A Stream Deck+ dial-first action: rotating adjusts one brake setup parameter
 * (brake bias, peak bias, bias fine, brake misc, engine braking, ABS adjust) via
 * the same key bindings as the key-based Setup Brakes action; the touch strip
 * shows the live telemetry value in a color-coded "dash box". Pressing runs a
 * configurable gesture (default: toggle ABS). On a plain keypad it shows the same
 * box and a press runs the configured gesture.
 */
export const SETUP_BRAKES_DIAL_UUID = "com.iracedeck.sd.core.setup-brakes-dial" as const;

export class SetupBrakesDial extends ConnectionStateAwareAction<SetupBrakesDialSettings> {
  private readonly contextsState = new Map<string, SetupBrakesDialContext>();

  override async onWillAppear(ev: IDeckWillAppearEvent<SetupBrakesDialSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const ctx = this.ensureContext(ev.action, settings);
    this.applyActiveBinding(settings);

    await this.applyTriggerDescription(ctx);
    await this.render(ctx);

    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      const current = this.contextsState.get(ev.action.id);

      if (current) {
        this.onTelemetry(current, telemetry);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SetupBrakesDialSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.contextsState.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SetupBrakesDialSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const ctx = this.ensureContext(ev.action, settings);
    this.applyActiveBinding(settings);
    // Bust the memo so the next render reflects the new mode even if it happens
    // to format to the same value string as the previous one.
    ctx.lastRenderSig = null;

    await this.applyTriggerDescription(ctx);
    await this.render(ctx);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<SetupBrakesDialSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    const ctx = this.ensureContext(ev.action, settings);

    // A pressed rotation still adjusts the setting; the guard makes the dialUp
    // classifier skip the press gesture so holding-and-turning never also toggles
    // ABS. The displayed value settles a beat later from telemetry.
    if (ev.payload.pressed) {
      ctx.rotatedWhilePressed = true;
    }

    const direction: DirectionType = ev.payload.ticks > 0 ? "increase" : "decrease";
    await this.dispatchRotation(ctx, direction);
  }

  override async onDialDown(ev: IDeckDialDownEvent<SetupBrakesDialSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    const ctx = this.ensureContext(ev.action, settings);

    // Record the press start and clear the push+turn guard. Fire nothing and
    // start no timer — press vs long-press is classified once at dialUp.
    ctx.pressStart = Date.now();
    ctx.rotatedWhilePressed = false;
  }

  override async onDialUp(ev: IDeckDialUpEvent<SetupBrakesDialSettings>): Promise<void> {
    const ctx = this.contextsState.get(ev.action.id);

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

    const action = kind === "long" ? ctx.settings.longPressAction : ctx.settings.pressAction;

    if (action === "none") return;

    this.logger.info(kind === "long" ? "Setup brakes dial long-pressed" : "Setup brakes dial pressed");
    await this.doGesture(action);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<SetupBrakesDialSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.ensureContext(ev.action, settings);

    if (settings.pressAction === "none") return;

    this.logger.info("Setup brakes dial key pressed");
    await this.doGesture(settings.pressAction);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<SetupBrakesDialSettings>): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    const settings = this.parseSettings(ev.payload.settings);
    // hold === true → Long Touch slot; hold === false → Tap Display slot.
    const action = ev.payload.hold ? settings.longTouchAction : settings.tapAction;

    if (action === "none") return;

    this.ensureContext(ev.action, settings);
    this.logger.info(ev.payload.hold ? "Setup brakes dial long touch" : "Setup brakes dial tap");
    await this.doGesture(action);
  }

  private parseSettings(settings: unknown): SetupBrakesDialSettings {
    const parsed = SetupBrakesDialSettings.safeParse(settings);

    return parsed.success ? parsed.data : SetupBrakesDialSettings.parse({});
  }

  private ensureContext(action: IDeckActionContext, settings: SetupBrakesDialSettings): SetupBrakesDialContext {
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
  private async dispatchRotation(ctx: SetupBrakesDialContext, direction: DirectionType): Promise<void> {
    const key = rotationKey(ctx.settings.setting, direction);

    if (!key) {
      this.logger.warn(`No global key mapping for ${ctx.settings.setting} ${direction}`);

      return;
    }

    this.logger.info("Setup brakes dial rotated");
    this.logger.debug(`${ctx.settings.setting} ${direction}`);
    await this.tapBinding(key);
  }

  /** Runs a configured press / touch gesture. */
  private async doGesture(action: GestureSlot): Promise<void> {
    if (action === "none") return;

    if (action === "toggle-abs") {
      const key = SETUP_BRAKES_GLOBAL_KEYS["abs-toggle"];

      if (!key) {
        this.logger.warn("No global key mapping for abs-toggle");

        return;
      }

      this.logger.info("Setup brakes dial toggled ABS");
      await this.tapBinding(key);
    }
  }

  /**
   * Declares the binding the dial depends on so the base class tracks
   * keyboard/SimHub readiness (per keyboard-shortcuts.md), mirroring the sibling
   * Setup Brakes action. Rotation needs both directions and the dial has no
   * `direction` setting, so the increase binding stands in as the primary active
   * binding (its missing state is also what the #612 warning covers).
   */
  private applyActiveBinding(settings: SetupBrakesDialSettings): void {
    this.setActiveBinding(rotationKey(settings.setting, "increase") ?? null);
  }

  /**
   * Per-button missing-binding check for the icon warning overlay (#612). The
   * dial's primary function is rotation, which needs BOTH the increase and
   * decrease bindings of the bound setting; the ABS-toggle press gesture is
   * secondary and never gates the whole key.
   */
  private computeBindingMissing(settings: SetupBrakesDialSettings): boolean {
    const keys = [rotationKey(settings.setting, "increase"), rotationKey(settings.setting, "decrease")].filter(
      (key): key is string => key !== undefined,
    );

    return this.isBindingMissing(keys);
  }

  /** A compact signature of the displayed state; a feedback push is due when it changes. */
  private displayedSignature(ctx: SetupBrakesDialContext): string {
    const value = formatDialValue(ctx.settings.setting, this.sdkController.getCurrentTelemetry());

    return [ctx.settings.setting, value, this.computeBindingMissing(ctx.settings) ? "warn" : ""].join("|");
  }

  private onTelemetry(ctx: SetupBrakesDialContext, _telemetry: TelemetryData | null): void {
    const sig = this.displayedSignature(ctx);

    if (sig === ctx.lastRenderSig) return;

    if (Date.now() - ctx.lastChangeRenderAt >= CHANGE_RENDER_MIN_INTERVAL_MS) {
      ctx.lastRenderSig = sig;
      ctx.lastChangeRenderAt = Date.now();
      void this.render(ctx);
    } else {
      // Changed but feedback-throttled: refresh the keypad icon now, but do NOT
      // advance lastRenderSig so the throttled feedback still fires next window.
      void this.render(ctx, { skipFeedback: true });
    }
  }

  /** Pushes the encoder trigger descriptions for a dial (Elgato only). */
  private async applyTriggerDescription(ctx: SetupBrakesDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.settings));
  }

  /** Renders the keypad icon and (for dials) the touch-strip feedback. */
  private async render(ctx: SetupBrakesDialContext, opts?: { skipFeedback?: boolean }): Promise<void> {
    if (ctx.action.isKey()) {
      await this.updateKeyImageForContext(ctx, this.generateIcon(ctx));
    }

    if (!opts?.skipFeedback) {
      await this.renderFeedback(ctx);
    }
  }

  /** Builds the 144×144 keypad dash-box icon for a context from live telemetry. */
  private generateIcon(ctx: SetupBrakesDialContext): string {
    const setting = ctx.settings.setting;

    return svgToDataUri(
      renderBrakeDialBoxSvg({
        width: 144,
        height: 144,
        color: MODE_COLOR[setting],
        abbr: MODE_ABBR[setting],
        value: formatDialValue(setting, this.sdkController.getCurrentTelemetry()),
        bindingMissing: this.computeBindingMissing(ctx.settings),
      }),
    );
  }

  /** Stores the icon for a context and pushes it to the device. */
  private async updateKeyImageForContext(ctx: SetupBrakesDialContext, svg: string): Promise<void> {
    const updated = await this.updateKeyImage(ctx.action.id, svg);

    if (!updated) {
      // First render for this context — register via setKeyImage so BaseAction tracks it.
      await this.setKeyImage({ action: ctx.action, payload: { settings: ctx.settings } }, svg);
      this.setRegenerateCallback(ctx.action.id, () => this.generateIcon(ctx));
    }
  }

  /** Pushes the touch-strip feedback (the full-cell dash box) when this is a dial. */
  private async renderFeedback(ctx: SetupBrakesDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (!ctx.action.isDial()) return;

    const setting = ctx.settings.setting;
    const boxSvg = renderBrakeDialBoxSvg({
      width: 200,
      height: 100,
      color: MODE_COLOR[setting],
      abbr: MODE_ABBR[setting],
      value: formatDialValue(setting, this.sdkController.getCurrentTelemetry()),
    });
    const feedback: DeckFeedbackPayload = { box: svgToDataUri(boxSvg) };
    await ctx.action.setFeedback(feedback);

    // Reset the change-detector baseline so this pushed feedback doesn't
    // immediately re-fire the render-on-change path on the next telemetry tick.
    ctx.lastRenderSig = this.displayedSignature(ctx);
    ctx.lastChangeRenderAt = Date.now();
  }
}
