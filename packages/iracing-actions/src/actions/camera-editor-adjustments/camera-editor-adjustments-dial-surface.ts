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
 * full name only, never a live number — the documented #782 voice-chat/master
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

/**
 * Dial gesture-slot values. `auto-mic-gain` taps the Auto Set Mic Gain binding;
 * every camera-tool id (e.g. `open-camera-tool`) taps the matching Camera Editor
 * Controls one-shot (#804). This is a cross-action binding reuse — the `camCtrl*`
 * keys are plugin-global (precedent: Cockpit Misc's `ffb-max-force` reusing Force
 * Feedback's keys). Every Camera Editor Controls control is a plain parameterless
 * one-shot tap, so all of them qualify; their ids and `camCtrl*` binding keys are
 * reused verbatim.
 */
export const GESTURE_ACTIONS = [
  "auto-mic-gain",
  "open-camera-tool",
  "key-acceleration-toggle",
  "key-10x-toggle",
  "parabolic-mic-toggle",
  "cycle-position-type",
  "cycle-aim-type",
  "acquire-start",
  "acquire-end",
  "temporary-edits-toggle",
  "dampening-toggle",
  "zoom-toggle",
  "beyond-fence-toggle",
  "in-cockpit-toggle",
  "mouse-navigation-toggle",
  "pitch-gyro-toggle",
  "roll-gyro-toggle",
  "limit-shot-range-toggle",
  "show-camera-toggle",
  "shot-selection-toggle",
  "manual-focus-toggle",
  "insert-camera",
  "remove-camera",
  "copy-camera",
  "paste-camera",
  "copy-group",
  "paste-group",
  "save-track-camera",
  "load-track-camera",
  "save-car-camera",
  "load-car-camera",
  "none",
] as const;
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
/**
 * Binding key each non-`none` gesture taps. Auto Set Mic Gain uses the
 * camera-editor's own `camEditAutoSetMicGain`; every camera-tool one-shot reuses
 * Camera Editor Controls' `camCtrl*` key verbatim (#804). The `Record` over
 * `Exclude<GestureSlot, "none">` makes a missing entry a compile error.
 */
const GESTURE_BINDING_KEYS: Record<Exclude<GestureSlot, "none">, string> = {
  "auto-mic-gain": "camEditAutoSetMicGain",
  "open-camera-tool": "camCtrlOpenCameraTool",
  "key-acceleration-toggle": "camCtrlKeyAccelerationToggle",
  "key-10x-toggle": "camCtrlKey10xToggle",
  "parabolic-mic-toggle": "camCtrlParabolicMicToggle",
  "cycle-position-type": "camCtrlCyclePositionType",
  "cycle-aim-type": "camCtrlCycleAimType",
  "acquire-start": "camCtrlAcquireStart",
  "acquire-end": "camCtrlAcquireEnd",
  "temporary-edits-toggle": "camCtrlTemporaryEditsToggle",
  "dampening-toggle": "camCtrlDampeningToggle",
  "zoom-toggle": "camCtrlZoomToggle",
  "beyond-fence-toggle": "camCtrlBeyondFenceToggle",
  "in-cockpit-toggle": "camCtrlInCockpitToggle",
  "mouse-navigation-toggle": "camCtrlMouseNavigationToggle",
  "pitch-gyro-toggle": "camCtrlPitchGyroToggle",
  "roll-gyro-toggle": "camCtrlRollGyroToggle",
  "limit-shot-range-toggle": "camCtrlLimitShotRangeToggle",
  "show-camera-toggle": "camCtrlShowCameraToggle",
  "shot-selection-toggle": "camCtrlShotSelectionToggle",
  "manual-focus-toggle": "camCtrlManualFocusToggle",
  "insert-camera": "camCtrlInsertCamera",
  "remove-camera": "camCtrlRemoveCamera",
  "copy-camera": "camCtrlCopyCamera",
  "paste-camera": "camCtrlPasteCamera",
  "copy-group": "camCtrlCopyGroup",
  "paste-group": "camCtrlPasteGroup",
  "save-track-camera": "camCtrlSaveTrackCamera",
  "load-track-camera": "camCtrlLoadTrackCamera",
  "save-car-camera": "camCtrlSaveCarCamera",
  "load-car-camera": "camCtrlLoadCarCamera",
};

/**
 * Human label per gesture, for the Stream Deck+ trigger-description tooltip. The
 * camera-tool labels match the Camera Editor Controls PI verbatim; Auto Set Mic
 * Gain stays "Auto Mic Gain" to fit the touch-strip trigger line.
 */
const GESTURE_LABELS: Record<Exclude<GestureSlot, "none">, string> = {
  "auto-mic-gain": "Auto Mic Gain",
  "open-camera-tool": "Open Camera Tool",
  "key-acceleration-toggle": "Key Acceleration Toggle",
  "key-10x-toggle": "Key 10x Toggle",
  "parabolic-mic-toggle": "Parabolic Mic Toggle",
  "cycle-position-type": "Cycle Position Type",
  "cycle-aim-type": "Cycle Aim Type",
  "acquire-start": "Acquire Start",
  "acquire-end": "Acquire End",
  "temporary-edits-toggle": "Temporary Edits Toggle",
  "dampening-toggle": "Dampening Toggle",
  "zoom-toggle": "Zoom Toggle",
  "beyond-fence-toggle": "Beyond Fence Toggle",
  "in-cockpit-toggle": "In Cockpit Toggle",
  "mouse-navigation-toggle": "Mouse Navigation Toggle",
  "pitch-gyro-toggle": "Pitch Gyro Toggle",
  "roll-gyro-toggle": "Roll Gyro Toggle",
  "limit-shot-range-toggle": "Limit Shot Range Toggle",
  "show-camera-toggle": "Show Camera Toggle",
  "shot-selection-toggle": "Shot Selection Toggle",
  "manual-focus-toggle": "Manual Focus Toggle",
  "insert-camera": "Insert Camera",
  "remove-camera": "Remove Camera",
  "copy-camera": "Copy Camera",
  "paste-camera": "Paste Camera",
  "copy-group": "Copy Group",
  "paste-group": "Paste Group",
  "save-track-camera": "Save Track Camera",
  "load-track-camera": "Load Track Camera",
  "save-car-camera": "Save Car Camera",
  "load-car-camera": "Load Car Camera",
};

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

/**
 * Full mixed-case parameter name — used both for "Adjust <label>" trigger
 * descriptions and as the touch-strip dash-box label (#804). Mixed case, never
 * uppercased, for readability of the longer names.
 */
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
 * Length-based font scale for the identity-only name label, as a fraction of
 * the box's shorter side, so the longest name ("Blimp Velocity") still fits
 * inside the frame with margin. No in-process text measurement is available, so
 * a character-count step suffices.
 */
export function identityLabelScaleFor(label: string): number {
  if (label.length <= 8) return 0.18;

  if (label.length <= 11) return 0.16;

  return 0.14;
}

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
  return action === "none" ? undefined : GESTURE_LABELS[action];
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

    this.host.logger.info("Camera editor dial gesture");
    this.host.logger.debug(`Gesture: ${action}`);
    await this.host.tapBinding(GESTURE_BINDING_KEYS[action]);
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
    const label = MODE_LABEL[setting];
    const colors = resolveDialBoxColors(ctx.dial.colors, MODE_COLOR[setting]);
    const boxSvg = renderDialBox({
      width: 200,
      height: 100,
      // The full mixed-case name, centered, scaled down for longer names.
      abbr: label,
      value: formatDialValue(setting, this.host.getTelemetry()),
      colors,
      identityLabelScale: identityLabelScaleFor(label),
      bindingMissing: this.computeBindingMissing(ctx.dial),
    });
    const feedback: DeckFeedbackPayload = { box: svgToDataUri(boxSvg) };
    await ctx.action.setFeedback(feedback);

    ctx.lastRenderSig = this.displayedSignature(ctx);
    ctx.lastChangeRenderAt = Date.now();
  }
}
