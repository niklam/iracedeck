/**
 * The dial surface of the Setup Fuel action (issue #797) — the dual-surface
 * pattern (Fuel Service #759 / Setup Brakes #775), behind a host interface.
 * Coexists with the keypad "paired adjust key styles" feature (#810).
 *
 * Self-contained leaf (owns the `dial` schema + dial key bindings; operates on
 * the `dial` sub-object). Rotating adjusts fuel mixture or fuel cut position via
 * the same key bindings as the keypad surface; the touch strip shows the live
 * value. The press gesture can toggle FCY mode. Distinct from the Fuel *Service*
 * dial (#759), which controls pit-stop fueling — this controls the in-car fuel
 * mixture / cut settings. The dash box ships an identity-only branch for family
 * uniformity; no Fuel setting triggers it.
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

export const ROTATION_SETTINGS = ["fuel-mixture", "fuel-cut-position"] as const;
export type SetupFuelDialSetting = (typeof ROTATION_SETTINGS)[number];

/** `toggle-fcy` taps the Setup Fuel FCY Mode Toggle binding. */
export const GESTURE_ACTIONS = ["toggle-fcy", "none"] as const;
export type GestureSlot = (typeof GESTURE_ACTIONS)[number];

export type SetupFuelDirection = "increase" | "decrease";

const DIAL_ROTATION_KEYS: Record<string, string> = {
  "fuel-mixture-increase": "setupFuelFuelMixtureIncrease",
  "fuel-mixture-decrease": "setupFuelFuelMixtureDecrease",
  "fuel-cut-position-increase": "setupFuelFuelCutPositionIncrease",
  "fuel-cut-position-decrease": "setupFuelFuelCutPositionDecrease",
};
const FCY_TOGGLE_KEY = "setupFuelFcyModeToggle";

export function rotationKey(setting: SetupFuelDialSetting, direction: SetupFuelDirection): string | undefined {
  return DIAL_ROTATION_KEYS[`${setting}-${direction}`];
}

export const DialSettings = z
  .object({
    setting: z.enum(ROTATION_SETTINGS).default("fuel-mixture"),
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

const VIEW_ID: Record<SetupFuelDialSetting, ViewSettingId | undefined> = {
  "fuel-mixture": "view-fuel-mixture",
  "fuel-cut-position": "view-fuel-cut-position",
};

const MODE_ABBR: Record<SetupFuelDialSetting, string> = {
  "fuel-mixture": "MIX",
  "fuel-cut-position": "CUT",
};

const MODE_COLOR: Record<SetupFuelDialSetting, string> = {
  "fuel-mixture": "#e67e22",
  "fuel-cut-position": "#3498db",
};

const MODE_LABEL: Record<SetupFuelDialSetting, string> = {
  "fuel-mixture": "Fuel Mixture",
  "fuel-cut-position": "Fuel Cut",
};

/** @internal Exported for testing */
export function formatDialValue(setting: SetupFuelDialSetting, telemetry: TelemetryData | null): string {
  const viewId = VIEW_ID[setting];

  if (!viewId) return "";

  return formatViewValue(viewId, telemetry).replace(/%$/, "");
}

function fitValueFontSize(text: string, maxWidth: number, cap: number): number {
  const approx = maxWidth / Math.max(1, text.length * 0.6);

  return Math.round(Math.min(cap, approx));
}

/** @internal Exported for testing */
export function renderFuelDialBoxSvg(args: {
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
    case "toggle-fcy":
      return "Toggle FCY";
    case "none":
      return undefined;
  }
}

interface SetupFuelDialContext {
  dial: DialSettings;
  action: IDeckActionContext;
  pressStart: number;
  rotatedWhilePressed: boolean;
  lastRenderSig: string | null;
  lastChangeRenderAt: number;
}

export interface SetupFuelDialHost {
  readonly logger: ILogger;
  getTelemetry(): TelemetryData | null;
  tapBinding(settingKey: string): Promise<void>;
  isBindingMissing(keys: string | string[] | null | undefined): boolean;
}

export class SetupFuelDialSurface {
  private readonly contextsState = new Map<string, SetupFuelDialContext>();

  constructor(private readonly host: SetupFuelDialHost) {}

  async willAppear(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    action.setImage(renderDialNameIcon({ line1: "SETUP", line2: "FUEL", backgroundColor: "#1a2a3a" })).catch((err) => {
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

    const direction: SetupFuelDirection = ticks > 0 ? "increase" : "decrease";
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

    this.host.logger.info(kind === "long" ? "Setup fuel dial long-pressed" : "Setup fuel dial pressed");
    await this.doGesture(action);
  }

  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    const gesture = hold ? dial.longTouchAction : dial.tapAction;

    if (gesture === "none") return;

    this.ensureContext(action, dial);
    this.host.logger.info(hold ? "Setup fuel dial long touch" : "Setup fuel dial tap");
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

  private ensureContext(action: IDeckActionContext, dial: DialSettings): SetupFuelDialContext {
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

  private async dispatchRotation(ctx: SetupFuelDialContext, direction: SetupFuelDirection): Promise<void> {
    const key = rotationKey(ctx.dial.setting, direction);

    if (!key) {
      this.host.logger.warn(`No global key mapping for ${ctx.dial.setting} ${direction}`);

      return;
    }

    this.host.logger.info("Setup fuel dial rotated");
    this.host.logger.debug(`${ctx.dial.setting} ${direction}`);
    await this.host.tapBinding(key);
  }

  private async doGesture(action: GestureSlot): Promise<void> {
    if (action === "none") return;

    if (action === "toggle-fcy") {
      this.host.logger.info("Setup fuel dial toggled FCY mode");
      await this.host.tapBinding(FCY_TOGGLE_KEY);
    }
  }

  private computeBindingMissing(dial: DialSettings): boolean {
    const keys = [rotationKey(dial.setting, "increase"), rotationKey(dial.setting, "decrease")].filter(
      (key): key is string => key !== undefined,
    );

    return this.host.isBindingMissing(keys);
  }

  private displayedSignature(ctx: SetupFuelDialContext): string {
    const value = formatDialValue(ctx.dial.setting, this.host.getTelemetry());

    return [ctx.dial.setting, value, this.computeBindingMissing(ctx.dial) ? "warn" : ""].join("|");
  }

  private async applyTriggerDescription(ctx: SetupFuelDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.dial));
  }

  private async renderFeedback(ctx: SetupFuelDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (!ctx.action.isDial()) return;

    const setting = ctx.dial.setting;
    const boxSvg = renderFuelDialBoxSvg({
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
