/**
 * The dial surface of the Setup Aero action (issue #799) — the dual-surface
 * pattern (Fuel Service #759 / Setup Brakes #775), behind a host interface.
 * Coexists with the keypad "paired adjust key styles" feature (#810).
 *
 * Self-contained leaf (owns the `dial` schema + dial key bindings; operates on
 * the `dial` sub-object). Rotating adjusts front wing, rear wing, or qualifying
 * tape via the same key bindings as the keypad surface; the touch strip shows
 * the live value. The press gesture can toggle the RF brake ducts.
 *
 * `qualifying-tape` has no `dc*` telemetry, so it renders label-only via the
 * dash box's identity-only branch (#782). Front/rear wing show the live value.
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

const CHANGE_RENDER_MIN_INTERVAL_MS = 100;

export const ROTATION_SETTINGS = ["front-wing", "rear-wing", "qualifying-tape"] as const;
export type SetupAeroDialSetting = (typeof ROTATION_SETTINGS)[number];

/** `toggle-rf-brake` taps the Setup Aero RF Brake Attached binding. */
export const GESTURE_ACTIONS = ["toggle-rf-brake", "none"] as const;
export type GestureSlot = (typeof GESTURE_ACTIONS)[number];

export type SetupAeroDirection = "increase" | "decrease";

const DIAL_ROTATION_KEYS: Record<string, string> = {
  "front-wing-increase": "setupAeroFrontWingIncrease",
  "front-wing-decrease": "setupAeroFrontWingDecrease",
  "rear-wing-increase": "setupAeroRearWingIncrease",
  "rear-wing-decrease": "setupAeroRearWingDecrease",
  "qualifying-tape-increase": "setupAeroQualifyingTapeIncrease",
  "qualifying-tape-decrease": "setupAeroQualifyingTapeDecrease",
};
const RF_BRAKE_KEY = "setupAeroRfBrakeAttached";

export function rotationKey(setting: SetupAeroDialSetting, direction: SetupAeroDirection): string | undefined {
  return DIAL_ROTATION_KEYS[`${setting}-${direction}`];
}

export const DialSettings = z
  .object({
    setting: z.enum(ROTATION_SETTINGS).default("front-wing"),
    pressAction: z.enum(GESTURE_ACTIONS).default("none"),
    longPressAction: z.enum(GESTURE_ACTIONS).default("none"),
    tapAction: z.enum(GESTURE_ACTIONS).default("none"),
    longTouchAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Dash-box appearance overrides (colors, issue #811).
    ...dialAppearanceFields,
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

/** `qualifying-tape` has no `view-*` entry (no `dc*` readback) → identity-only. */
const VIEW_ID: Record<SetupAeroDialSetting, ViewSettingId | undefined> = {
  "front-wing": "view-front-wing",
  "rear-wing": "view-rear-wing",
  "qualifying-tape": undefined,
};

const MODE_ABBR: Record<SetupAeroDialSetting, string> = {
  "front-wing": "FRONT",
  "rear-wing": "REAR",
  "qualifying-tape": "TAPE",
};

const MODE_COLOR: Record<SetupAeroDialSetting, string> = {
  "front-wing": "#3498db",
  "rear-wing": "#e67e22",
  "qualifying-tape": "#9b59b6",
};

const MODE_LABEL: Record<SetupAeroDialSetting, string> = {
  "front-wing": "Front Wing",
  "rear-wing": "Rear Wing",
  "qualifying-tape": "Qualifying Tape",
};

/** @internal Exported for testing */
export function formatDialValue(setting: SetupAeroDialSetting, telemetry: TelemetryData | null): string {
  const viewId = VIEW_ID[setting];

  if (!viewId) return "";

  return formatViewValue(viewId, telemetry).replace(/%$/, "");
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
    case "toggle-rf-brake":
      return "Toggle RF Brake";
    case "none":
      return undefined;
  }
}

interface SetupAeroDialContext {
  dial: DialSettings;
  action: IDeckActionContext;
  pressStart: number;
  rotatedWhilePressed: boolean;
  lastRenderSig: string | null;
  lastChangeRenderAt: number;
}

export interface SetupAeroDialHost {
  readonly logger: ILogger;
  getTelemetry(): TelemetryData | null;
  tapBinding(settingKey: string): Promise<void>;
  isBindingMissing(keys: string | string[] | null | undefined): boolean;
}

export class SetupAeroDialSurface {
  private readonly contextsState = new Map<string, SetupAeroDialContext>();

  constructor(private readonly host: SetupAeroDialHost) {}

  async willAppear(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    action.setImage(renderDialNameIcon({ line1: "SETUP", line2: "AERO", backgroundColor: "#1a3a3a" })).catch((err) => {
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

    const direction: SetupAeroDirection = ticks > 0 ? "increase" : "decrease";
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

    this.host.logger.info(kind === "long" ? "Setup aero dial long-pressed" : "Setup aero dial pressed");
    await this.doGesture(action);
  }

  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    const gesture = hold ? dial.longTouchAction : dial.tapAction;

    if (gesture === "none") return;

    this.ensureContext(action, dial);
    this.host.logger.info(hold ? "Setup aero dial long touch" : "Setup aero dial tap");
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

  private ensureContext(action: IDeckActionContext, dial: DialSettings): SetupAeroDialContext {
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

  private async dispatchRotation(ctx: SetupAeroDialContext, direction: SetupAeroDirection): Promise<void> {
    const key = rotationKey(ctx.dial.setting, direction);

    if (!key) {
      this.host.logger.warn(`No global key mapping for ${ctx.dial.setting} ${direction}`);

      return;
    }

    this.host.logger.info("Setup aero dial rotated");
    this.host.logger.debug(`${ctx.dial.setting} ${direction}`);
    await this.host.tapBinding(key);
  }

  private async doGesture(action: GestureSlot): Promise<void> {
    if (action === "none") return;

    if (action === "toggle-rf-brake") {
      this.host.logger.info("Setup aero dial toggled RF brake");
      await this.host.tapBinding(RF_BRAKE_KEY);
    }
  }

  private computeBindingMissing(dial: DialSettings): boolean {
    const keys = [rotationKey(dial.setting, "increase"), rotationKey(dial.setting, "decrease")].filter(
      (key): key is string => key !== undefined,
    );

    return this.host.isBindingMissing(keys);
  }

  private displayedSignature(ctx: SetupAeroDialContext): string {
    const value = formatDialValue(ctx.dial.setting, this.host.getTelemetry());

    return [ctx.dial.setting, value, this.computeBindingMissing(ctx.dial) ? "warn" : ""].join("|");
  }

  private async applyTriggerDescription(ctx: SetupAeroDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.dial));
  }

  private async renderFeedback(ctx: SetupAeroDialContext): Promise<void> {
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
