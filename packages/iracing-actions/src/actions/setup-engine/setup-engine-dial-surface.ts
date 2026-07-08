/**
 * The dial surface of the Setup Engine action (issue #798) — the dual-surface
 * pattern (Fuel Service #759 / Setup Brakes #775), behind a host interface.
 * Coexists with the keypad "paired adjust key styles" feature (#810).
 *
 * Self-contained leaf (owns the `dial` schema + dial key bindings; operates on
 * the `dial` sub-object). Rotating adjusts one engine setup value via the same
 * key bindings as the keypad surface; the touch strip shows the live value.
 * Setup Engine has no natural toggle, so no press gesture is offered.
 *
 * `boost-level` has no `dc*` telemetry (iRacing exposes no engine boost value),
 * so it renders label-only via the dash box's identity-only branch — the
 * Audio-Controls voice-chat/master compromise (#782). The other three settings
 * show the live value.
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
import z from "zod";

import { renderDialNameIcon } from "../../shared/dial-name-icon.js";
import { formatViewValue, type ViewSettingId } from "../../shared/setup-view.js";

const BOX_BACKGROUND = "#0d0d0d";
const CHANGE_RENDER_MIN_INTERVAL_MS = 100;

export const ROTATION_SETTINGS = ["engine-power", "throttle-shaping", "boost-level", "launch-rpm"] as const;
export type SetupEngineDialSetting = (typeof ROTATION_SETTINGS)[number];

/** Setup Engine has no natural toggle gesture, so `none` is the only option. */
export const GESTURE_ACTIONS = ["none"] as const;
export type GestureSlot = (typeof GESTURE_ACTIONS)[number];

export type SetupEngineDirection = "increase" | "decrease";

const DIAL_ROTATION_KEYS: Record<string, string> = {
  "engine-power-increase": "setupEngineEnginePowerIncrease",
  "engine-power-decrease": "setupEngineEnginePowerDecrease",
  "throttle-shaping-increase": "setupEngineThrottleShapingIncrease",
  "throttle-shaping-decrease": "setupEngineThrottleShapingDecrease",
  "boost-level-increase": "setupEngineBoostLevelIncrease",
  "boost-level-decrease": "setupEngineBoostLevelDecrease",
  "launch-rpm-increase": "setupEngineLaunchRpmIncrease",
  "launch-rpm-decrease": "setupEngineLaunchRpmDecrease",
};

export function rotationKey(setting: SetupEngineDialSetting, direction: SetupEngineDirection): string | undefined {
  return DIAL_ROTATION_KEYS[`${setting}-${direction}`];
}

export const DialSettings = z
  .object({
    setting: z.enum(ROTATION_SETTINGS).default("engine-power"),
    pressAction: z.enum(GESTURE_ACTIONS).default("none"),
    longPressAction: z.enum(GESTURE_ACTIONS).default("none"),
    tapAction: z.enum(GESTURE_ACTIONS).default("none"),
    longTouchAction: z.enum(GESTURE_ACTIONS).default("none"),
  })
  .prefault({});

export type DialSettings = z.infer<typeof DialSettings>;

export function seedDialFromLegacySetting(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;

  if (obj.dial !== undefined) return null;

  const legacy = obj.setting;

  if (typeof legacy !== "string" || !(ROTATION_SETTINGS as readonly string[]).includes(legacy)) return null;

  return { ...obj, dial: { setting: legacy } };
}

/** `boost-level` has no `view-*` entry (no `dc*` readback) → identity-only. */
const VIEW_ID: Record<SetupEngineDialSetting, ViewSettingId | undefined> = {
  "engine-power": "view-engine-power",
  "throttle-shaping": "view-throttle-shape",
  "boost-level": undefined,
  "launch-rpm": "view-launch-rpm",
};

const MODE_ABBR: Record<SetupEngineDialSetting, string> = {
  "engine-power": "POWER",
  "throttle-shaping": "THR",
  "boost-level": "BOOST",
  "launch-rpm": "LAUNCH",
};

const MODE_COLOR: Record<SetupEngineDialSetting, string> = {
  "engine-power": "#e74c3c",
  "throttle-shaping": "#3498db",
  "boost-level": "#f39c12",
  "launch-rpm": "#2ecc71",
};

const MODE_LABEL: Record<SetupEngineDialSetting, string> = {
  "engine-power": "Engine Power",
  "throttle-shaping": "Throttle Shaping",
  "boost-level": "Boost Level",
  "launch-rpm": "Launch RPM",
};

/** @internal Exported for testing */
export function formatDialValue(setting: SetupEngineDialSetting, telemetry: TelemetryData | null): string {
  const viewId = VIEW_ID[setting];

  if (!viewId) return "";

  return formatViewValue(viewId, telemetry).replace(/%$/, "");
}

function fitValueFontSize(text: string, maxWidth: number, cap: number): number {
  const approx = maxWidth / Math.max(1, text.length * 0.6);

  return Math.round(Math.min(cap, approx));
}

/** @internal Exported for testing */
export function renderEngineDialBoxSvg(args: {
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
  const identityOnly = value === "";

  const labelFontSize = identityOnly ? Math.round(minSide * 0.24) : Math.round(minSide * 0.15);
  const labelY = identityOnly ? Math.round(h * 0.5) : Math.round(h * 0.28);

  const labelText = `<text x="${w / 2}" y="${labelY}" text-anchor="middle" dominant-baseline="central" fill="${color}" font-family="Arial, sans-serif" font-size="${labelFontSize}" font-weight="bold">${abbr}</text>`;

  let valueText = "";

  if (!identityOnly) {
    const valueFontSize = fitValueFontSize(
      value,
      w - 2 * (inset + strokeWidth + Math.round(w * 0.05)),
      Math.round(h * 0.52),
    );
    const valueY = Math.round(h * 0.64) + 13;
    valueText = `<text x="${w / 2}" y="${valueY}" text-anchor="middle" dominant-baseline="central" fill="${color}" font-family="Arial, sans-serif" font-size="${valueFontSize}" font-weight="bold">${value}</text>`;
  }

  const content = labelText + valueText;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" fill="${BOX_BACKGROUND}"/>` +
    `<rect x="${inset}" y="${inset}" width="${w - 2 * inset}" height="${h - 2 * inset}" rx="${Math.max(0, radius - inset)}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"/>` +
    `${bindingMissing ? applyBindingWarning(content, { width: w, height: h }) : content}</svg>`
  );
}

/** @internal Exported for testing */
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

function gestureLabel(action: GestureSlot): string | undefined {
  switch (action) {
    case "none":
      return undefined;
  }
}

interface SetupEngineDialContext {
  dial: DialSettings;
  action: IDeckActionContext;
  pressStart: number;
  rotatedWhilePressed: boolean;
  lastRenderSig: string | null;
  lastChangeRenderAt: number;
}

export interface SetupEngineDialHost {
  readonly logger: ILogger;
  getTelemetry(): TelemetryData | null;
  tapBinding(settingKey: string): Promise<void>;
  isBindingMissing(keys: string | string[] | null | undefined): boolean;
}

export class SetupEngineDialSurface {
  private readonly contextsState = new Map<string, SetupEngineDialContext>();

  constructor(private readonly host: SetupEngineDialHost) {}

  async willAppear(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    action
      .setImage(renderDialNameIcon({ line1: "SETUP", line2: "ENGINE", backgroundColor: "#2a3a1a" }))
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

    const direction: SetupEngineDirection = ticks > 0 ? "increase" : "decrease";
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

    this.host.logger.info(kind === "long" ? "Setup engine dial long-pressed" : "Setup engine dial pressed");
    await this.doGesture(action);
  }

  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    const gesture = hold ? dial.longTouchAction : dial.tapAction;

    if (gesture === "none") return;

    this.ensureContext(action, dial);
    this.host.logger.info(hold ? "Setup engine dial long touch" : "Setup engine dial tap");
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

  refreshAll(): void {
    for (const ctx of this.contextsState.values()) {
      ctx.lastRenderSig = null;
      this.renderFeedback(ctx).catch((err) => {
        this.host.logger.debug(`Dial feedback refresh failed: ${String(err)}`);
      });
    }
  }

  private ensureContext(action: IDeckActionContext, dial: DialSettings): SetupEngineDialContext {
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

  private async dispatchRotation(ctx: SetupEngineDialContext, direction: SetupEngineDirection): Promise<void> {
    const key = rotationKey(ctx.dial.setting, direction);

    if (!key) {
      this.host.logger.warn(`No global key mapping for ${ctx.dial.setting} ${direction}`);

      return;
    }

    this.host.logger.info("Setup engine dial rotated");
    this.host.logger.debug(`${ctx.dial.setting} ${direction}`);
    await this.host.tapBinding(key);
  }

  private async doGesture(action: GestureSlot): Promise<void> {
    if (action === "none") return;
  }

  private computeBindingMissing(dial: DialSettings): boolean {
    const keys = [rotationKey(dial.setting, "increase"), rotationKey(dial.setting, "decrease")].filter(
      (key): key is string => key !== undefined,
    );

    return this.host.isBindingMissing(keys);
  }

  private displayedSignature(ctx: SetupEngineDialContext): string {
    const value = formatDialValue(ctx.dial.setting, this.host.getTelemetry());

    return [ctx.dial.setting, value, this.computeBindingMissing(ctx.dial) ? "warn" : ""].join("|");
  }

  private async applyTriggerDescription(ctx: SetupEngineDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.dial));
  }

  private async renderFeedback(ctx: SetupEngineDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (!ctx.action.isDial()) return;

    const setting = ctx.dial.setting;
    const boxSvg = renderEngineDialBoxSvg({
      width: 200,
      height: 100,
      color: MODE_COLOR[setting],
      abbr: MODE_ABBR[setting],
      value: formatDialValue(setting, this.host.getTelemetry()),
      bindingMissing: this.computeBindingMissing(ctx.dial),
    });
    const feedback: DeckFeedbackPayload = { box: svgToDataUri(boxSvg) };
    await ctx.action.setFeedback(feedback);

    ctx.lastRenderSig = this.displayedSignature(ctx);
    ctx.lastChangeRenderAt = Date.now();
  }
}
