import {
  CommonSettings,
  ConnectionStateAwareAction,
  formatKeyBinding,
  getCommands,
  getGlobalColors,
  getGlobalSettings,
  getKeyboard,
  getSimHub,
  type IDeckDialDownEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  isSimHubBinding,
  isSimHubInitialized,
  type KeyBindingValue,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  parseBinding,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "@iracedeck/deck-core";
import dashBoxIconSvg from "@iracedeck/icons/toggle-ui-elements/dash-box.svg";
import displayRefCarIconSvg from "@iracedeck/icons/toggle-ui-elements/display-ref-car.svg";
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
  "display-ref-car": displayRefCarIconSvg,
  "replay-ui": replayUiIconSvg,
};

/**
 * Label configuration for each UI element
 */
const UI_ELEMENT_LABELS: Record<UiElement, { mainLabel: string; subLabel: string }> = {
  "dash-box": { mainLabel: "DASH BOX", subLabel: "TOGGLE" },
  "speed-gear-pedals": { mainLabel: "INPUTS", subLabel: "TOGGLE" },
  "radio-display": { mainLabel: "RADIO", subLabel: "DISPLAY" },
  "fps-network-display": { mainLabel: "SYSTEM", subLabel: "METERS" },
  "weather-radar": { mainLabel: "WEATHER", subLabel: "RADAR" },
  "virtual-mirror": { mainLabel: "VIRTUAL", subLabel: "MIRROR" },
  "ui-edit-mode": { mainLabel: "UI EDIT", subLabel: "MODE" },
  "display-ref-car": { mainLabel: "REFERENCE", subLabel: "CAR" },
  "replay-ui": { mainLabel: "REPLAY UI", subLabel: "TOGGLE" },
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
export function generateToggleUiElementsSvg(settings: ToggleUiElementsSettings): string {
  const { element } = settings;

  const iconSvg = ELEMENT_ICONS[element] || ELEMENT_ICONS["dash-box"];
  const labels = UI_ELEMENT_LABELS[element] || UI_ELEMENT_LABELS["dash-box"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
    ...colors,
  });

  return svgToDataUri(svg);
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
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<ToggleUiElementsSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<ToggleUiElementsSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
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

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseBinding(globalSettings[settingKey]);

    if (!binding) {
      this.logger.warn(`No binding configured for ${settingKey}`);

      return;
    }

    if (isSimHubBinding(binding)) {
      this.logger.info("Triggering SimHub role");
      this.logger.debug(`SimHub role: ${binding.role}`);

      if (isSimHubInitialized()) {
        const simHub = getSimHub();
        await simHub.startRole(binding.role);
        await simHub.stopRole(binding.role);
      } else {
        this.logger.warn("SimHub service not initialized");
      }

      return;
    }

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
    ev: IDeckWillAppearEvent<ToggleUiElementsSettings> | IDeckDidReceiveSettingsEvent<ToggleUiElementsSettings>,
    settings: ToggleUiElementsSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateToggleUiElementsSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateToggleUiElementsSvg(settings));
  }
}
