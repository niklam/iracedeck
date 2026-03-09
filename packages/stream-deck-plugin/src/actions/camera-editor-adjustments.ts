import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import altitudeDecreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/altitude-decrease.svg";
import altitudeIncreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/altitude-increase.svg";
import autoSetMicGainDecreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/auto-set-mic-gain-decrease.svg";
import autoSetMicGainIncreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/auto-set-mic-gain-increase.svg";
import blimpRadiusDecreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/blimp-radius-decrease.svg";
import blimpRadiusIncreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/blimp-radius-increase.svg";
import blimpVelocityDecreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/blimp-velocity-decrease.svg";
import blimpVelocityIncreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/blimp-velocity-increase.svg";
import fNumberDecreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/f-number-decrease.svg";
import fNumberIncreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/f-number-increase.svg";
import focusDepthDecreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/focus-depth-decrease.svg";
import focusDepthIncreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/focus-depth-increase.svg";
import fovZoomDecreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/fov-zoom-decrease.svg";
import fovZoomIncreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/fov-zoom-increase.svg";
import keyStepDecreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/key-step-decrease.svg";
import keyStepIncreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/key-step-increase.svg";
import latitudeDecreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/latitude-decrease.svg";
import latitudeIncreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/latitude-increase.svg";
import longitudeDecreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/longitude-decrease.svg";
import longitudeIncreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/longitude-increase.svg";
import micGainDecreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/mic-gain-decrease.svg";
import micGainIncreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/mic-gain-increase.svg";
import pitchDecreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/pitch-decrease.svg";
import pitchIncreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/pitch-increase.svg";
import vanishXDecreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/vanish-x-decrease.svg";
import vanishXIncreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/vanish-x-increase.svg";
import vanishYDecreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/vanish-y-decrease.svg";
import vanishYIncreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/vanish-y-increase.svg";
import yawDecreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/yaw-decrease.svg";
import yawIncreaseIconSvg from "@iracedeck/icons/camera-editor-adjustments/yaw-increase.svg";
import z from "zod";

import {
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  getGlobalSettings,
  getKeyboard,
  type KeyBindingValue,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  LogLevel,
  parseKeyBinding,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";

const ADJUSTMENT_VALUES = [
  "latitude",
  "longitude",
  "altitude",
  "yaw",
  "pitch",
  "fov-zoom",
  "key-step",
  "vanish-x",
  "vanish-y",
  "blimp-radius",
  "blimp-velocity",
  "mic-gain",
  "auto-set-mic-gain",
  "f-number",
  "focus-depth",
] as const;

type AdjustmentType = (typeof ADJUSTMENT_VALUES)[number];
type DirectionType = "increase" | "decrease";

/**
 * Icon SVG lookup for each adjustment + direction combination.
 */
const ADJUSTMENT_ICONS: Record<string, string> = {
  "latitude-increase": latitudeIncreaseIconSvg,
  "latitude-decrease": latitudeDecreaseIconSvg,
  "longitude-increase": longitudeIncreaseIconSvg,
  "longitude-decrease": longitudeDecreaseIconSvg,
  "altitude-increase": altitudeIncreaseIconSvg,
  "altitude-decrease": altitudeDecreaseIconSvg,
  "yaw-increase": yawIncreaseIconSvg,
  "yaw-decrease": yawDecreaseIconSvg,
  "pitch-increase": pitchIncreaseIconSvg,
  "pitch-decrease": pitchDecreaseIconSvg,
  "fov-zoom-increase": fovZoomIncreaseIconSvg,
  "fov-zoom-decrease": fovZoomDecreaseIconSvg,
  "key-step-increase": keyStepIncreaseIconSvg,
  "key-step-decrease": keyStepDecreaseIconSvg,
  "vanish-x-increase": vanishXIncreaseIconSvg,
  "vanish-x-decrease": vanishXDecreaseIconSvg,
  "vanish-y-increase": vanishYIncreaseIconSvg,
  "vanish-y-decrease": vanishYDecreaseIconSvg,
  "blimp-radius-increase": blimpRadiusIncreaseIconSvg,
  "blimp-radius-decrease": blimpRadiusDecreaseIconSvg,
  "blimp-velocity-increase": blimpVelocityIncreaseIconSvg,
  "blimp-velocity-decrease": blimpVelocityDecreaseIconSvg,
  "mic-gain-increase": micGainIncreaseIconSvg,
  "mic-gain-decrease": micGainDecreaseIconSvg,
  "auto-set-mic-gain-increase": autoSetMicGainIncreaseIconSvg,
  "auto-set-mic-gain-decrease": autoSetMicGainDecreaseIconSvg,
  "f-number-increase": fNumberIncreaseIconSvg,
  "f-number-decrease": fNumberDecreaseIconSvg,
  "focus-depth-increase": focusDepthIncreaseIconSvg,
  "focus-depth-decrease": focusDepthDecreaseIconSvg,
};

/**
 * Label configuration for each adjustment + direction combination.
 * mainLabel = primary (bold, bottom), subLabel = secondary (subdued, top).
 */
const CAMERA_EDITOR_LABELS: Record<AdjustmentType, Record<DirectionType, { mainLabel: string; subLabel: string }>> = {
  latitude: {
    increase: { mainLabel: "+", subLabel: "LATITUDE" },
    decrease: { mainLabel: "-", subLabel: "LATITUDE" },
  },
  longitude: {
    increase: { mainLabel: "+", subLabel: "LONGITUDE" },
    decrease: { mainLabel: "-", subLabel: "LONGITUDE" },
  },
  altitude: {
    increase: { mainLabel: "+", subLabel: "ALTITUDE" },
    decrease: { mainLabel: "-", subLabel: "ALTITUDE" },
  },
  yaw: {
    increase: { mainLabel: "+", subLabel: "YAW" },
    decrease: { mainLabel: "-", subLabel: "YAW" },
  },
  pitch: {
    increase: { mainLabel: "+", subLabel: "PITCH" },
    decrease: { mainLabel: "-", subLabel: "PITCH" },
  },
  "fov-zoom": {
    increase: { mainLabel: "+", subLabel: "FOV ZOOM" },
    decrease: { mainLabel: "-", subLabel: "FOV ZOOM" },
  },
  "key-step": {
    increase: { mainLabel: "+", subLabel: "KEY STEP" },
    decrease: { mainLabel: "-", subLabel: "KEY STEP" },
  },
  "vanish-x": {
    increase: { mainLabel: "+", subLabel: "VANISH X" },
    decrease: { mainLabel: "-", subLabel: "VANISH X" },
  },
  "vanish-y": {
    increase: { mainLabel: "+", subLabel: "VANISH Y" },
    decrease: { mainLabel: "-", subLabel: "VANISH Y" },
  },
  "blimp-radius": {
    increase: { mainLabel: "+", subLabel: "BLIMP RAD" },
    decrease: { mainLabel: "-", subLabel: "BLIMP RAD" },
  },
  "blimp-velocity": {
    increase: { mainLabel: "+", subLabel: "BLIMP VEL" },
    decrease: { mainLabel: "-", subLabel: "BLIMP VEL" },
  },
  "mic-gain": {
    increase: { mainLabel: "+", subLabel: "MIC GAIN" },
    decrease: { mainLabel: "-", subLabel: "MIC GAIN" },
  },
  "auto-set-mic-gain": {
    increase: { mainLabel: "AUTO", subLabel: "MIC GAIN" },
    decrease: { mainLabel: "AUTO", subLabel: "MIC GAIN" },
  },
  "f-number": {
    increase: { mainLabel: "+", subLabel: "F-NUMBER" },
    decrease: { mainLabel: "-", subLabel: "F-NUMBER" },
  },
  "focus-depth": {
    increase: { mainLabel: "+", subLabel: "FOCUS DEPTH" },
    decrease: { mainLabel: "-", subLabel: "FOCUS DEPTH" },
  },
};

/**
 * @internal Exported for testing
 *
 * Mapping from adjustment + direction to global settings keys.
 */
export const CAMERA_EDITOR_GLOBAL_KEYS: Record<AdjustmentType, Record<DirectionType, string>> = {
  latitude: { increase: "camEditLatitudeIncrease", decrease: "camEditLatitudeDecrease" },
  longitude: { increase: "camEditLongitudeIncrease", decrease: "camEditLongitudeDecrease" },
  altitude: { increase: "camEditAltitudeIncrease", decrease: "camEditAltitudeDecrease" },
  yaw: { increase: "camEditYawIncrease", decrease: "camEditYawDecrease" },
  pitch: { increase: "camEditPitchIncrease", decrease: "camEditPitchDecrease" },
  "fov-zoom": { increase: "camEditFovZoomIncrease", decrease: "camEditFovZoomDecrease" },
  "key-step": { increase: "camEditKeyStepIncrease", decrease: "camEditKeyStepDecrease" },
  "vanish-x": { increase: "camEditVanishXIncrease", decrease: "camEditVanishXDecrease" },
  "vanish-y": { increase: "camEditVanishYIncrease", decrease: "camEditVanishYDecrease" },
  "blimp-radius": { increase: "camEditBlimpRadiusIncrease", decrease: "camEditBlimpRadiusDecrease" },
  "blimp-velocity": { increase: "camEditBlimpVelocityIncrease", decrease: "camEditBlimpVelocityDecrease" },
  "mic-gain": { increase: "camEditMicGainIncrease", decrease: "camEditMicGainDecrease" },
  "auto-set-mic-gain": { increase: "camEditAutoSetMicGain", decrease: "camEditAutoSetMicGain" },
  "f-number": { increase: "camEditFNumberIncrease", decrease: "camEditFNumberDecrease" },
  "focus-depth": { increase: "camEditFocusDepthIncrease", decrease: "camEditFocusDepthDecrease" },
};

const CameraEditorAdjustmentsSettings = z.object({
  adjustment: z.enum(ADJUSTMENT_VALUES).default("latitude"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type CameraEditorAdjustmentsSettings = z.infer<typeof CameraEditorAdjustmentsSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the camera editor adjustments action.
 */
export function generateCameraEditorAdjustmentsSvg(settings: CameraEditorAdjustmentsSettings): string {
  const { adjustment, direction } = settings;

  const iconKey = `${adjustment}-${direction}`;
  const iconSvg = ADJUSTMENT_ICONS[iconKey] || ADJUSTMENT_ICONS["latitude-increase"];
  const labels = CAMERA_EDITOR_LABELS[adjustment]?.[direction] || CAMERA_EDITOR_LABELS.latitude.increase;

  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
  });

  return svgToDataUri(svg);
}

/**
 * Camera Editor Adjustments Action
 * Adjusts camera position, rotation, zoom, and other editor parameters via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.camera-editor-adjustments" })
export class CameraEditorAdjustments extends ConnectionStateAwareAction<CameraEditorAdjustmentsSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("CameraEditorAdjustments"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAdjustment(settings.adjustment, settings.direction);
  }

  override async onDialDown(ev: DialDownEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAdjustment(settings.adjustment, settings.direction);
  }

  override async onDialRotate(ev: DialRotateEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);

    // Auto Set Mic Gain has no directional adjustment — ignore rotation
    if (settings.adjustment === "auto-set-mic-gain") {
      this.logger.debug("Rotation ignored for Auto Set Mic Gain");

      return;
    }

    // Clockwise (ticks > 0) = increase, Counter-clockwise (ticks < 0) = decrease
    const direction: DirectionType = ev.payload.ticks > 0 ? "increase" : "decrease";
    await this.executeAdjustment(settings.adjustment, direction);
  }

  private parseSettings(settings: unknown): CameraEditorAdjustmentsSettings {
    const parsed = CameraEditorAdjustmentsSettings.safeParse(settings);

    return parsed.success ? parsed.data : CameraEditorAdjustmentsSettings.parse({});
  }

  private async executeAdjustment(adjustment: AdjustmentType, direction: DirectionType): Promise<void> {
    this.logger.info("Adjustment triggered");
    this.logger.debug(`Executing ${adjustment} ${direction}`);

    const settingKey = CAMERA_EDITOR_GLOBAL_KEYS[adjustment]?.[direction];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${adjustment} ${direction}`);

      return;
    }

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return;
    }

    this.logger.debug(`Key binding for ${settingKey}: ${formatKeyBinding(binding)} (code=${binding.code ?? "none"})`);

    await this.sendKeyBinding(binding);
  }

  private async sendKeyBinding(binding: KeyBindingValue): Promise<void> {
    const combination: KeyCombination = {
      key: binding.key as KeyboardKey,
      modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
      code: binding.code,
    };

    const success = await getKeyboard().sendKeyCombination(combination);

    if (success) {
      this.logger.info("Key sent successfully");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to send key");
      this.logger.debug(`Failed key combination: ${formatKeyBinding(binding)}`);
    }
  }

  private async updateDisplay(
    ev: WillAppearEvent<CameraEditorAdjustmentsSettings> | DidReceiveSettingsEvent<CameraEditorAdjustmentsSettings>,
    settings: CameraEditorAdjustmentsSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateCameraEditorAdjustmentsSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
