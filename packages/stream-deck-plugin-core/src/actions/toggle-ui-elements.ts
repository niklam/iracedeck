import streamDeck, {
  action,
  DialDownEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import { CameraState, hasFlag } from "@iracedeck/iracing-sdk";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  getCommands,
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
} from "@iracedeck/stream-deck-shared";
import z from "zod";

import toggleUiElementsTemplate from "../../icons/toggle-ui-elements.svg";

const WHITE = "#ffffff";
const GRAY = "#888888";
const TEAL = "#2ecc71";

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

/**
 * Label configuration for each UI element (line1 bold, line2 subdued)
 */
const UI_ELEMENT_LABELS: Record<UiElement, { line1: string; line2: string }> = {
  "dash-box": { line1: "DASH BOX", line2: "TOGGLE" },
  "speed-gear-pedals": { line1: "INPUTS", line2: "TOGGLE" },
  "radio-display": { line1: "RADIO", line2: "DISPLAY" },
  "fps-network-display": { line1: "SYSTEM", line2: "METERS" },
  "weather-radar": { line1: "WEATHER", line2: "RADAR" },
  "virtual-mirror": { line1: "VIRTUAL", line2: "MIRROR" },
  "ui-edit-mode": { line1: "UI EDIT", line2: "MODE" },
  "display-ref-car": { line1: "REFERENCE", line2: "CAR" },
  "replay-ui": { line1: "REPLAY UI", line2: "TOGGLE" },
};

/**
 * SVG icon content for each UI element
 */
const UI_ELEMENT_ICONS: Record<UiElement, string> = {
  // Dash Box: Dashboard panel with gauges
  "dash-box": `
    <rect x="12" y="10" width="48" height="26" rx="3" fill="#1a2a2a" stroke="${GRAY}" stroke-width="1.5"/>
    <circle cx="28" cy="23" r="8" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="28" y1="23" x2="32" y2="17" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="48" cy="23" r="5" fill="none" stroke="${WHITE}" stroke-width="1"/>
    <line x1="48" y1="23" x2="50" y2="20" stroke="${WHITE}" stroke-width="1"/>
    <rect x="16" y="32" width="8" height="2" rx="0.5" fill="${GRAY}"/>
    <rect x="26" y="32" width="8" height="2" rx="0.5" fill="${GRAY}"/>`,

  // Speed/Gear/Pedals: Speedometer + gear indicator
  "speed-gear-pedals": `
    <circle cx="36" cy="20" r="12" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="36" y1="20" x2="42" y2="13" stroke="${WHITE}" stroke-width="2"/>
    <text x="36" y="26" text-anchor="middle" fill="${WHITE}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">3</text>
    <rect x="18" y="34" width="6" height="8" rx="1" fill="${TEAL}" opacity="0.8"/>
    <rect x="26" y="36" width="6" height="6" rx="1" fill="${GRAY}" opacity="0.6"/>
    <rect x="42" y="35" width="6" height="7" rx="1" fill="${WHITE}" opacity="0.5"/>`,

  // Radio Display: Radio/comms panel
  "radio-display": `
    <rect x="14" y="10" width="44" height="26" rx="3" fill="#1a2a2a" stroke="${GRAY}" stroke-width="1.5"/>
    <rect x="18" y="14" width="36" height="10" rx="1" fill="#0a1a1a"/>
    <text x="36" y="22" text-anchor="middle" fill="${TEAL}" font-family="Arial, sans-serif" font-size="7">CH 01</text>
    <circle cx="24" cy="30" r="2" fill="${GRAY}"/>
    <circle cx="36" cy="30" r="2" fill="${GRAY}"/>
    <circle cx="48" cy="30" r="2" fill="${GRAY}"/>`,

  // FPS/Network Display: Monitor with stats
  "fps-network-display": `
    <rect x="14" y="10" width="44" height="26" rx="2" fill="#1a2a2a" stroke="${GRAY}" stroke-width="1.5"/>
    <text x="18" y="20" fill="${GRAY}" font-family="Arial, sans-serif" font-size="5">FPS</text>
    <text x="42" y="20" fill="${TEAL}" font-family="Arial, sans-serif" font-size="6" font-weight="bold">60</text>
    <text x="18" y="28" fill="${GRAY}" font-family="Arial, sans-serif" font-size="5">PING</text>
    <text x="42" y="28" fill="${WHITE}" font-family="Arial, sans-serif" font-size="6">42ms</text>
    <text x="18" y="34" fill="${GRAY}" font-family="Arial, sans-serif" font-size="5">Q</text>
    <text x="42" y="34" fill="${TEAL}" font-family="Arial, sans-serif" font-size="6">100%</text>`,

  // Weather Radar: Radar sweep icon
  "weather-radar": `
    <circle cx="36" cy="24" r="14" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <circle cx="36" cy="24" r="9" fill="none" stroke="${GRAY}" stroke-width="0.5"/>
    <circle cx="36" cy="24" r="4" fill="none" stroke="${GRAY}" stroke-width="0.5"/>
    <line x1="36" y1="24" x2="36" y2="10" stroke="${WHITE}" stroke-width="1.5"/>
    <path d="M36 24 L30 12" fill="none" stroke="${TEAL}" stroke-width="1" opacity="0.6"/>
    <circle cx="42" cy="18" r="2" fill="${TEAL}" opacity="0.5"/>
    <circle cx="30" cy="16" r="1.5" fill="${TEAL}" opacity="0.3"/>`,

  // Virtual Mirror: Mirror reflection
  "virtual-mirror": `
    <rect x="10" y="12" width="52" height="20" rx="3" fill="#0a1a1a" stroke="${GRAY}" stroke-width="1.5"/>
    <rect x="14" y="15" width="44" height="14" rx="1" fill="#1a2a2a"/>
    <line x1="22" y1="16" x2="28" y2="27" stroke="${WHITE}" stroke-width="1.5" opacity="0.4"/>
    <line x1="26" y1="16" x2="32" y2="27" stroke="${WHITE}" stroke-width="1" opacity="0.25"/>
    <circle cx="44" cy="21" r="3" fill="${WHITE}" opacity="0.15"/>
    <circle cx="50" cy="22" r="2" fill="${WHITE}" opacity="0.1"/>`,

  // UI Edit Mode: Crosshair/move arrows
  "ui-edit-mode": `
    <rect x="16" y="12" width="40" height="22" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-dasharray="3 2"/>
    <line x1="36" y1="10" x2="36" y2="36" stroke="${GRAY}" stroke-width="1"/>
    <line x1="14" y1="23" x2="58" y2="23" stroke="${GRAY}" stroke-width="1"/>
    <path d="M36 10 l-3 4 h6 z" fill="${WHITE}"/>
    <path d="M36 36 l-3 -4 h6 z" fill="${WHITE}"/>
    <path d="M14 23 l4 -3 v6 z" fill="${WHITE}"/>
    <path d="M58 23 l-4 -3 v6 z" fill="${WHITE}"/>`,

  // Display Reference Car: Car outline with ref marker
  "display-ref-car": `
    <rect x="22" y="12" width="28" height="14" rx="4" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="18" y="18" width="6" height="8" rx="2" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <rect x="48" y="18" width="6" height="8" rx="2" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="30" y1="12" x2="30" y2="26" stroke="${GRAY}" stroke-width="0.5"/>
    <line x1="42" y1="12" x2="42" y2="26" stroke="${GRAY}" stroke-width="0.5"/>
    <text x="36" y="34" text-anchor="middle" fill="${TEAL}" font-family="Arial, sans-serif" font-size="6" font-weight="bold">REF</text>`,

  // Replay UI: Play/video controls
  "replay-ui": `
    <rect x="14" y="10" width="44" height="26" rx="3" fill="#1a2a2a" stroke="${GRAY}" stroke-width="1.5"/>
    <polygon points="30,16 30,30 44,23" fill="${WHITE}"/>
    <rect x="18" y="34" width="36" height="2" rx="1" fill="${GRAY}"/>
    <circle cx="30" cy="35" r="2.5" fill="${WHITE}"/>`,
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

const ToggleUiElementsSettings = z.object({
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

  const iconContent = UI_ELEMENT_ICONS[element] || UI_ELEMENT_ICONS["dash-box"];
  const labels = UI_ELEMENT_LABELS[element] || UI_ELEMENT_LABELS["dash-box"];

  const svg = renderIconTemplate(toggleUiElementsTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Toggle UI Elements Action
 * Toggles iRacing UI elements on/off via keyboard shortcuts or SDK commands.
 */
@action({ UUID: "com.iracedeck.sd.core.toggle-ui-elements" })
export class ToggleUiElements extends ConnectionStateAwareAction<ToggleUiElementsSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("ToggleUiElements"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<ToggleUiElementsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<ToggleUiElementsSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ToggleUiElementsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<ToggleUiElementsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeToggle(settings.element);
  }

  override async onDialDown(ev: DialDownEvent<ToggleUiElementsSettings>): Promise<void> {
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
    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

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
    ev: WillAppearEvent<ToggleUiElementsSettings> | DidReceiveSettingsEvent<ToggleUiElementsSettings>,
    settings: ToggleUiElementsSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateToggleUiElementsSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
