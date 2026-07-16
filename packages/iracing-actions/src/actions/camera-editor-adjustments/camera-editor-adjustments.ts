import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckTouchTapEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  onGlobalSettingsChange,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
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
  CameraEditorDialSurface,
  DialSettings,
  seedDialFromLegacySetting,
} from "./camera-editor-adjustments-dial-surface.js";

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
 * Title text for each adjustment + direction combination. The direction is carried by the
 * giant +/- glyph in the artwork, so titles are the adjustment name only.
 */
const CAMERA_EDITOR_TITLES: Record<string, string> = {
  "latitude-increase": "LATITUDE",
  "latitude-decrease": "LATITUDE",
  "longitude-increase": "LONGITUDE",
  "longitude-decrease": "LONGITUDE",
  "altitude-increase": "ALTITUDE",
  "altitude-decrease": "ALTITUDE",
  "yaw-increase": "YAW",
  "yaw-decrease": "YAW",
  "pitch-increase": "PITCH",
  "pitch-decrease": "PITCH",
  "fov-zoom-increase": "FOV ZOOM",
  "fov-zoom-decrease": "FOV ZOOM",
  "key-step-increase": "KEY STEP",
  "key-step-decrease": "KEY STEP",
  "vanish-x-increase": "VANISH X",
  "vanish-x-decrease": "VANISH X",
  "vanish-y-increase": "VANISH Y",
  "vanish-y-decrease": "VANISH Y",
  "blimp-radius-increase": "BLIMP RAD",
  "blimp-radius-decrease": "BLIMP RAD",
  "blimp-velocity-increase": "BLIMP VEL",
  "blimp-velocity-decrease": "BLIMP VEL",
  "mic-gain-increase": "MIC GAIN",
  "mic-gain-decrease": "MIC GAIN",
  "auto-set-mic-gain-increase": "MIC GAIN\nAUTO",
  "auto-set-mic-gain-decrease": "MIC GAIN\nAUTO",
  "f-number-increase": "F-NUMBER",
  "f-number-decrease": "F-NUMBER",
  "focus-depth-increase": "FOCUS DEPTH",
  "focus-depth-decrease": "FOCUS DEPTH",
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

const CameraEditorAdjustmentsSettings = CommonSettings.extend({
  adjustment: z.enum(ADJUSTMENT_VALUES).default("latitude"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
  // Dial-surface settings (#804), under the `dial` root so keypad and dial keys
  // can't collide. catch: dial garbage degrades to dial defaults instead of
  // failing the whole parse (which would reset a keypad instance).
  dial: DialSettings.catch(() => DialSettings.parse({})),
});

type CameraEditorAdjustmentsSettings = z.infer<typeof CameraEditorAdjustmentsSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the camera editor adjustments action.
 */
export function generateCameraEditorAdjustmentsSvg(
  settings: CameraEditorAdjustmentsSettings,
  bindingMissing = false,
): string {
  const { adjustment, direction } = settings;

  const iconKey = `${adjustment}-${direction}`;
  const iconSvg = ADJUSTMENT_ICONS[iconKey] || ADJUSTMENT_ICONS["latitude-increase"];
  const defaultTitle = CAMERA_EDITOR_TITLES[iconKey] || "LATITUDE";

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * Camera Editor Adjustments Action
 * Adjusts camera position, rotation, zoom, and other editor parameters via keyboard shortcuts.
 */
export const CAMERA_EDITOR_ADJUSTMENTS_UUID = "com.iracedeck.sd.core.camera-editor-adjustments" as const;

export class CameraEditorAdjustments extends ConnectionStateAwareAction<CameraEditorAdjustmentsSettings> {
  /**
   * The dial half of the action; all IDeck dial events route here (#804). No
   * `setActiveBinding` is delegated — it would bleed onto the keypad buttons.
   */
  private readonly dialSurface = new CameraEditorDialSurface({
    logger: this.logger,
    getTelemetry: () => this.sdkController.getCurrentTelemetry(),
    tapBinding: (settingKey) => this.tapBinding(settingKey),
    isBindingMissing: (keys) => this.isBindingMissing(keys),
  });

  /** Keeps the dial strips' #612 missing-binding warning live while iRacing is offline (#804). */
  private readonly unsubscribeGlobalSettings = onGlobalSettingsChange(() => this.dialSurface.refreshAll());

  override async onWillAppear(ev: IDeckWillAppearEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    await super.onWillAppear(ev);
    let settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      // #804 dial migration: a pre-dial-surface encoder placement drove the flat
      // keypad `adjustment` — carry a valid rotation value over to `dial.setting`.
      const seededDial = seedDialFromLegacySetting(ev.payload.settings);

      if (seededDial) {
        await ev.action.setSettings(seededDial);
        settings = this.parseSettings(seededDial);
      }

      await this.dialSurface.willAppear(ev.action, settings.dial);
      this.sdkController.subscribe(ev.action.id, (telemetry) => {
        this.dialSurface.onTelemetry(ev.action.id, telemetry);
      });

      return;
    }

    this.setActiveBinding(CAMERA_EDITOR_GLOBAL_KEYS[settings.adjustment]?.[settings.direction]);
    await this.updateDisplay(ev, settings);
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.dialSurface.willDisappear(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(
    ev: IDeckDidReceiveSettingsEvent<CameraEditorAdjustmentsSettings>,
  ): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      await this.dialSurface.didReceiveSettings(ev.action, settings.dial);

      return;
    }

    this.setActiveBinding(CAMERA_EDITOR_GLOBAL_KEYS[settings.adjustment]?.[settings.direction]);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeAdjustment(settings.adjustment, settings.direction);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.rotate(ev.action, settings.dial, ev.payload.ticks, ev.payload.pressed === true);
  }

  override async onDialDown(ev: IDeckDialDownEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.down(ev.action, settings.dial);
  }

  override async onDialUp(ev: IDeckDialUpEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    await this.dialSurface.up(ev.action.id);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<CameraEditorAdjustmentsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.touchTap(ev.action, settings.dial, ev.payload.hold === true);
  }

  private parseSettings(settings: unknown): CameraEditorAdjustmentsSettings {
    const parsed = CameraEditorAdjustmentsSettings.safeParse(settings);

    return parsed.success ? parsed.data : CameraEditorAdjustmentsSettings.parse({});
  }

  private async executeAdjustment(adjustment: AdjustmentType, direction: DirectionType): Promise<void> {
    const settingKey = CAMERA_EDITOR_GLOBAL_KEYS[adjustment]?.[direction];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${adjustment} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  private async updateDisplay(
    ev:
      | IDeckWillAppearEvent<CameraEditorAdjustmentsSettings>
      | IDeckDidReceiveSettingsEvent<CameraEditorAdjustmentsSettings>,
    settings: CameraEditorAdjustmentsSettings,
  ): Promise<void> {
    const activeKey = CAMERA_EDITOR_GLOBAL_KEYS[settings.adjustment]?.[settings.direction];
    const svgDataUri = generateCameraEditorAdjustmentsSvg(settings, this.isBindingMissing(activeKey));
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () =>
      generateCameraEditorAdjustmentsSvg(settings, this.isBindingMissing(activeKey)),
    );
  }
}
