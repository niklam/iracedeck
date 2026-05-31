import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getCommands,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import dashBoxIconSvg from "@iracedeck/icons/toggle-ui-elements/dash-box.svg";
import displayRefCarIconSvg from "@iracedeck/icons/toggle-ui-elements/display-ref-car.svg";
import drivingLineIconSvg from "@iracedeck/icons/toggle-ui-elements/driving-line.svg";
import fpsNetworkDisplayIconSvg from "@iracedeck/icons/toggle-ui-elements/fps-network-display.svg";
import radioDisplayIconSvg from "@iracedeck/icons/toggle-ui-elements/radio-display.svg";
import replayUiIconSvg from "@iracedeck/icons/toggle-ui-elements/replay-ui.svg";
import speedGearPedalsIconSvg from "@iracedeck/icons/toggle-ui-elements/speed-gear-pedals.svg";
import uiEditModeIconSvg from "@iracedeck/icons/toggle-ui-elements/ui-edit-mode.svg";
import virtualMirrorIconSvg from "@iracedeck/icons/toggle-ui-elements/virtual-mirror.svg";
import weatherRadarIconSvg from "@iracedeck/icons/toggle-ui-elements/weather-radar.svg";
import { CameraState, hasFlag } from "@iracedeck/iracing-sdk";
import z from "zod";

type UiElement =
  | "dash-box"
  | "speed-gear-pedals"
  | "radio-display"
  | "fps-network-display"
  | "weather-radar"
  | "virtual-mirror"
  | "ui-edit-mode"
  | "driving-line"
  | "display-ref-car"
  | "replay-ui";

const ELEMENT_ICONS: Record<UiElement, string> = {
  "dash-box": dashBoxIconSvg,
  "speed-gear-pedals": speedGearPedalsIconSvg,
  "radio-display": radioDisplayIconSvg,
  "fps-network-display": fpsNetworkDisplayIconSvg,
  "weather-radar": weatherRadarIconSvg,
  "virtual-mirror": virtualMirrorIconSvg,
  "ui-edit-mode": uiEditModeIconSvg,
  "driving-line": drivingLineIconSvg,
  "display-ref-car": displayRefCarIconSvg,
  "replay-ui": replayUiIconSvg,
};

/**
 * Title configuration for each UI element
 */
const UI_ELEMENT_TITLES: Record<UiElement, string> = {
  "dash-box": "TOGGLE\nDASH BOX",
  "speed-gear-pedals": "TOGGLE\nINPUTS",
  "radio-display": "DISPLAY\nRADIO",
  "fps-network-display": "METERS\nSYSTEM",
  "weather-radar": "RADAR\nWEATHER",
  "virtual-mirror": "MIRROR\nVIRTUAL",
  "ui-edit-mode": "MODE\nUI EDIT",
  "driving-line": "TOGGLE\nDRIVING LINE",
  "display-ref-car": "CAR\nREFERENCE",
  "replay-ui": "TOGGLE\nREPLAY UI",
};

/**
 * @internal Exported for testing
 *
 * Mapping from UI element setting values (kebab-case) to global settings keys.
 * Does not include "replay-ui" since that uses the SDK, not keyboard shortcuts.
 */
export const UI_ELEMENT_GLOBAL_KEYS: Record<string, string> = {
  "dash-box": "toggleUiDashBox",
  "speed-gear-pedals": "toggleUiSpeedGearPedals",
  "radio-display": "toggleUiRadioDisplay",
  "fps-network-display": "toggleUiFpsNetworkDisplay",
  "weather-radar": "toggleUiWeatherRadar",
  "virtual-mirror": "toggleUiVirtualMirror",
  "ui-edit-mode": "toggleUiEditMode",
  "driving-line": "toggleUiDrivingLine",
  "display-ref-car": "toggleUiDisplayRefCar",
};

const ToggleUiElementsSettings = CommonSettings.extend({
  element: z
    .enum([
      "dash-box",
      "speed-gear-pedals",
      "radio-display",
      "fps-network-display",
      "weather-radar",
      "virtual-mirror",
      "ui-edit-mode",
      "driving-line",
      "display-ref-car",
      "replay-ui",
    ])
    .default("dash-box"),
});

type ToggleUiElementsSettings = z.infer<typeof ToggleUiElementsSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the toggle UI elements action.
 */
export function generateToggleUiElementsSvg(settings: ToggleUiElementsSettings, bindingMissing = false): string {
  const { element } = settings;

  const iconSvg = ELEMENT_ICONS[element] || ELEMENT_ICONS["dash-box"];
  const defaultTitle = UI_ELEMENT_TITLES[element] || UI_ELEMENT_TITLES["dash-box"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * Toggle UI Elements Action
 * Toggles iRacing UI elements on/off via keyboard shortcuts or SDK commands.
 */
export const TOGGLE_UI_ELEMENTS_UUID = "com.iracedeck.sd.core.toggle-ui-elements" as const;

export class ToggleUiElements extends ConnectionStateAwareAction<ToggleUiElementsSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<ToggleUiElementsSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const activeKey = UI_ELEMENT_GLOBAL_KEYS[settings.element];
    this.setActiveBinding(activeKey ?? null);

    await this.updateDisplay(ev, settings);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<ToggleUiElementsSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const activeKey = UI_ELEMENT_GLOBAL_KEYS[settings.element];
    this.setActiveBinding(activeKey ?? null);

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<ToggleUiElementsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeToggle(settings.element);
  }

  override async onDialDown(ev: IDeckDialDownEvent<ToggleUiElementsSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeToggle(settings.element);
  }

  private parseSettings(settings: unknown): ToggleUiElementsSettings {
    const parsed = ToggleUiElementsSettings.safeParse(settings);

    return parsed.success ? parsed.data : ToggleUiElementsSettings.parse({});
  }

  private async executeToggle(element: UiElement): Promise<void> {
    if (element === "replay-ui") {
      await this.toggleReplayUi();
    } else {
      await this.sendKeyBindingForElement(element);
    }
  }

  private async toggleReplayUi(): Promise<void> {
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("Cannot toggle replay UI: no telemetry data available");

      return;
    }

    const cameraState = telemetry.CamCameraState;
    const camera = getCommands().camera;

    if (hasFlag(cameraState, CameraState.UIHidden)) {
      this.logger.info("Showing replay UI");
      const success = camera.showUI(cameraState);

      if (!success) {
        this.logger.warn("Failed to show replay UI");
      }
    } else {
      this.logger.info("Hiding replay UI");
      const success = camera.hideUI(cameraState);

      if (!success) {
        this.logger.warn("Failed to hide replay UI");
      }
    }
  }

  private async sendKeyBindingForElement(element: string): Promise<void> {
    const settingKey = UI_ELEMENT_GLOBAL_KEYS[element];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for element: ${element}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<ToggleUiElementsSettings> | IDeckDidReceiveSettingsEvent<ToggleUiElementsSettings>,
    settings: ToggleUiElementsSettings,
  ): Promise<void> {
    const svgDataUri = generateToggleUiElementsSvg(
      settings,
      this.isBindingMissing(UI_ELEMENT_GLOBAL_KEYS[settings.element]),
    );
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () =>
      generateToggleUiElementsSvg(settings, this.isBindingMissing(UI_ELEMENT_GLOBAL_KEYS[settings.element])),
    );
  }
}
