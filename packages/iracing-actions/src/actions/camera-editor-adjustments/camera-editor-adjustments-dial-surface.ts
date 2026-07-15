/**
 * The dial surface of the Camera Editor Adjustments action (issue #804) — the
 * dual-surface pattern (Fuel Service #759 / Setup Brakes #775), behind a host
 * interface. Precision rotary control of the camera editor's 14 adjustable
 * parameters for broadcast camera operators.
 *
 * Self-contained leaf (owns the `dial` schema + dial key bindings; operates on
 * the `dial` sub-object). Rotating adjusts one camera-tool parameter via the
 * same `camEdit*Increase`/`Decrease` key bindings as the keypad surface; the
 * press gesture can tap Auto Set Mic Gain.
 *
 * iRacing exposes NO camera-tool state (no telemetry for any parameter), so
 * every value is identity-only: the touch strip shows the selected parameter's
 * label only, never a live number — the documented #782 voice-chat/master
 * compromise, not an implementation gap.
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

const CHANGE_RENDER_MIN_INTERVAL_MS = 100;

/**
 * Cap on how many binding taps a single rotate event dispatches. A fast spin
 * coalesces into |ticks| > 1; scaling by ticks (capped) advances multiple
 * detents per event so precision camera work tracks the wheel, while the cap
 * keeps one flick from firing an unbounded burst.
 */
const MAX_TAPS_PER_EVENT = 5;

/**
 * The 14 rotatable camera-tool parameters, ordered by family (position →
 * orientation → lens → vanish → blimp → misc). Auto Set Mic Gain is excluded —
 * it is a one-shot with no direction, offered only as a press gesture below.
 */
export const ROTATION_SETTINGS = [
  // Position
  "latitude",
  "longitude",
  "altitude",
  // Orientation
  "yaw",
  "pitch",
  // Lens
  "fov-zoom",
  "f-number",
  "focus-depth",
  // Vanishing point
  "vanish-x",
  "vanish-y",
  // Blimp
  "blimp-radius",
  "blimp-velocity",
  // Misc
  "key-step",
  "mic-gain",
] as const;
export type CameraEditorDialSetting = (typeof ROTATION_SETTINGS)[number];

/** `auto-mic-gain` taps the Auto Set Mic Gain binding. */
export const GESTURE_ACTIONS = ["auto-mic-gain", "none"] as const;
export type GestureSlot = (typeof GESTURE_ACTIONS)[number];

export type CameraEditorDirection = "increase" | "decrease";

const DIAL_ROTATION_KEYS: Record<string, string> = {
  "latitude-increase": "camEditLatitudeIncrease",
  "latitude-decrease": "camEditLatitudeDecrease",
  "longitude-increase": "camEditLongitudeIncrease",
  "longitude-decrease": "camEditLongitudeDecrease",
  "altitude-increase": "camEditAltitudeIncrease",
  "altitude-decrease": "camEditAltitudeDecrease",
  "yaw-increase": "camEditYawIncrease",
  "yaw-decrease": "camEditYawDecrease",
  "pitch-increase": "camEditPitchIncrease",
  "pitch-decrease": "camEditPitchDecrease",
  "fov-zoom-increase": "camEditFovZoomIncrease",
  "fov-zoom-decrease": "camEditFovZoomDecrease",
  "f-number-increase": "camEditFNumberIncrease",
  "f-number-decrease": "camEditFNumberDecrease",
  "focus-depth-increase": "camEditFocusDepthIncrease",
  "focus-depth-decrease": "camEditFocusDepthDecrease",
  "vanish-x-increase": "camEditVanishXIncrease",
  "vanish-x-decrease": "camEditVanishXDecrease",
  "vanish-y-increase": "camEditVanishYIncrease",
  "vanish-y-decrease": "camEditVanishYDecrease",
  "blimp-radius-increase": "camEditBlimpRadiusIncrease",
  "blimp-radius-decrease": "camEditBlimpRadiusDecrease",
  "blimp-velocity-increase": "camEditBlimpVelocityIncrease",
  "blimp-velocity-decrease": "camEditBlimpVelocityDecrease",
  "key-step-increase": "camEditKeyStepIncrease",
  "key-step-decrease": "camEditKeyStepDecrease",
  "mic-gain-increase": "camEditMicGainIncrease",
  "mic-gain-decrease": "camEditMicGainDecrease",
};
const AUTO_MIC_GAIN_KEY = "camEditAutoSetMicGain";

export function rotationKey(setting: CameraEditorDialSetting, direction: CameraEditorDirection): string | undefined {
  return DIAL_ROTATION_KEYS[`${setting}-${direction}`];
}

export const DialSettings = z
  .object({
    setting: z.enum(ROTATION_SETTINGS).default("latitude"),
    pressAction: z.enum(GESTURE_ACTIONS).default("none"),
    longPressAction: z.enum(GESTURE_ACTIONS).default("none"),
    tapAction: z.enum(GESTURE_ACTIONS).default("none"),
    longTouchAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Dash-box appearance overrides (colors, issue #811).
    ...dialAppearanceFields,
  })
  .prefault({});

export type DialSettings = z.infer<typeof DialSettings>;

/**
 * A pre-dial-surface encoder placement drove the flat keypad `adjustment`
 * setting. Carry a valid rotation value over to `dial.setting`. Auto Set Mic
 * Gain (a one-shot, not a rotation value) and anything else is left to default.
 */
export function seedDialFromLegacySetting(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;

  if (obj.dial !== undefined) return null;

  const legacy = obj.adjustment;

  if (typeof legacy !== "string" || !(ROTATION_SETTINGS as readonly string[]).includes(legacy)) return null;

  return { ...obj, dial: { setting: legacy } };
}

/** Short dash-box label per setting. */
const MODE_ABBR: Record<CameraEditorDialSetting, string> = {
  latitude: "LAT",
  longitude: "LON",
  altitude: "ALT",
  yaw: "YAW",
  pitch: "PITCH",
  "fov-zoom": "FOV",
  "f-number": "F-NUM",
  "focus-depth": "FOCUS",
  "vanish-x": "VAN X",
  "vanish-y": "VAN Y",
  "blimp-radius": "B-RAD",
  "blimp-velocity": "B-VEL",
  "key-step": "STEP",
  "mic-gain": "MIC",
};

/** Per-setting accent color, grouped by parameter family. */
const MODE_COLOR: Record<CameraEditorDialSetting, string> = {
  latitude: "#3498db",
  longitude: "#2980b9",
  altitude: "#5dade2",
  yaw: "#9b59b6",
  pitch: "#8e44ad",
  "fov-zoom": "#1abc9c",
  "f-number": "#16a085",
  "focus-depth": "#48c9b0",
  "vanish-x": "#e67e22",
  "vanish-y": "#d35400",
  "blimp-radius": "#2ecc71",
  "blimp-velocity": "#27ae60",
  "key-step": "#95a5a6",
  "mic-gain": "#e74c3c",
};

/** Human label for "Adjust <label>" trigger descriptions. */
const MODE_LABEL: Record<CameraEditorDialSetting, string> = {
  latitude: "Latitude",
  longitude: "Longitude",
  altitude: "Altitude",
  yaw: "Yaw",
  pitch: "Pitch",
  "fov-zoom": "FOV Zoom",
  "f-number": "F-number",
  "focus-depth": "Focus Depth",
  "vanish-x": "Vanish X",
  "vanish-y": "Vanish Y",
  "blimp-radius": "Blimp Radius",
  "blimp-velocity": "Blimp Velocity",
  "key-step": "Key Step",
  "mic-gain": "Mic Gain",
};

/**
 * @internal Exported for testing
 *
 * Every camera-tool parameter is identity-only (iRacing exposes no camera-tool
 * telemetry), so the dash box always renders label-only.
 */
export function formatDialValue(_setting: CameraEditorDialSetting, _telemetry: TelemetryData | null): string {
  return "";
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
    case "auto-mic-gain":
      return "Auto Mic Gain";
    case "none":
      return undefined;
  }
}

interface CameraEditorDialContext {
  dial: DialSettings;
  action: IDeckActionContext;
  pressStart: number;
  rotatedWhilePressed: boolean;
  lastRenderSig: string | null;
  lastChangeRenderAt: number;
}

export interface CameraEditorDialHost {
  readonly logger: ILogger;
  getTelemetry(): TelemetryData | null;
  tapBinding(settingKey: string): Promise<void>;
  isBindingMissing(keys: string | string[] | null | undefined): boolean;
}

export class CameraEditorDialSurface {
  private readonly contextsState = new Map<string, CameraEditorDialContext>();

  constructor(private readonly host: CameraEditorDialHost) {}

  async willAppear(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    action
      .setImage(renderDialNameIcon({ line1: "CAM EDIT", line2: "ADJUST", backgroundColor: "#1a2a3a" }))
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

    if (ticks === 0) return;

    const direction: CameraEditorDirection = ticks > 0 ? "increase" : "decrease";
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

    this.host.logger.info(kind === "long" ? "Camera editor dial long-pressed" : "Camera editor dial pressed");
    await this.doGesture(action);
  }

  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    const gesture = hold ? dial.longTouchAction : dial.tapAction;

    if (gesture === "none") return;

    this.ensureContext(action, dial);
    this.host.logger.info(hold ? "Camera editor dial long touch" : "Camera editor dial tap");
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

  private ensureContext(action: IDeckActionContext, dial: DialSettings): CameraEditorDialContext {
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
    ctx: CameraEditorDialContext,
    direction: CameraEditorDirection,
    taps: number,
  ): Promise<void> {
    const key = rotationKey(ctx.dial.setting, direction);

    if (!key) {
      this.host.logger.warn(`No global key mapping for ${ctx.dial.setting} ${direction}`);

      return;
    }

    this.host.logger.info("Camera editor dial rotated");
    this.host.logger.debug(`${ctx.dial.setting} ${direction} x${taps}`);

    for (let i = 0; i < taps; i++) {
      await this.host.tapBinding(key);
    }
  }

  private async doGesture(action: GestureSlot): Promise<void> {
    if (action === "none") return;

    if (action === "auto-mic-gain") {
      this.host.logger.info("Camera editor dial auto-set mic gain");
      await this.host.tapBinding(AUTO_MIC_GAIN_KEY);
    }
  }

  private computeBindingMissing(dial: DialSettings): boolean {
    const keys = [rotationKey(dial.setting, "increase"), rotationKey(dial.setting, "decrease")].filter(
      (key): key is string => key !== undefined,
    );

    return this.host.isBindingMissing(keys);
  }

  private displayedSignature(ctx: CameraEditorDialContext): string {
    const value = formatDialValue(ctx.dial.setting, this.host.getTelemetry());

    return [ctx.dial.setting, value, this.computeBindingMissing(ctx.dial) ? "warn" : ""].join("|");
  }

  private async applyTriggerDescription(ctx: CameraEditorDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.dial));
  }

  private async renderFeedback(ctx: CameraEditorDialContext): Promise<void> {
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
