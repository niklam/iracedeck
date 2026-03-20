import streamDeck, {
  action,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import announceLeaderIconSvg from "@iracedeck/icons/ai-spotter-controls/announce-leader.svg";
import damageReportIconSvg from "@iracedeck/icons/ai-spotter-controls/damage-report.svg";
import louderIconSvg from "@iracedeck/icons/ai-spotter-controls/louder.svg";
import quieterIconSvg from "@iracedeck/icons/ai-spotter-controls/quieter.svg";
import silenceIconSvg from "@iracedeck/icons/ai-spotter-controls/silence.svg";
import toggleReportLapsIconSvg from "@iracedeck/icons/ai-spotter-controls/toggle-report-laps.svg";
import weatherReportIconSvg from "@iracedeck/icons/ai-spotter-controls/weather-report.svg";
import z from "zod";

import {
  CommonSettings,
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  getGlobalColors,
  getGlobalSettings,
  getKeyboard,
  type KeyBindingValue,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  LogLevel,
  parseKeyBinding,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "../shared/index.js";

type SpotterControl =
  | "damage-report"
  | "weather-report"
  | "toggle-report-laps"
  | "announce-leader"
  | "louder"
  | "quieter"
  | "silence";

/**
 * @internal Exported for testing
 *
 * Flat record mapping control keys to imported SVGs.
 */
export const SPOTTER_ICONS: Record<SpotterControl, string> = {
  "damage-report": damageReportIconSvg,
  "weather-report": weatherReportIconSvg,
  "toggle-report-laps": toggleReportLapsIconSvg,
  "announce-leader": announceLeaderIconSvg,
  louder: louderIconSvg,
  quieter: quieterIconSvg,
  silence: silenceIconSvg,
};

/**
 * @internal Exported for testing
 *
 * Label configuration for each spotter control.
 */
export const SPOTTER_LABELS: Record<SpotterControl, { mainLabel: string; subLabel: string }> = {
  "damage-report": { mainLabel: "DAMAGE", subLabel: "SPOTTER" },
  "weather-report": { mainLabel: "WEATHER", subLabel: "SPOTTER" },
  "toggle-report-laps": { mainLabel: "RPT LAPS", subLabel: "SPOTTER" },
  "announce-leader": { mainLabel: "LEADER", subLabel: "SPOTTER" },
  louder: { mainLabel: "LOUDER", subLabel: "SPOTTER" },
  quieter: { mainLabel: "QUIETER", subLabel: "SPOTTER" },
  silence: { mainLabel: "SILENCE", subLabel: "SPOTTER" },
};

/**
 * @internal Exported for testing
 *
 * Mapping from spotter control to global settings keys.
 */
export const SPOTTER_GLOBAL_KEYS: Record<SpotterControl, string> = {
  "damage-report": "spotterDamageReport",
  "weather-report": "spotterWeatherReport",
  "toggle-report-laps": "spotterToggleReportLaps",
  "announce-leader": "spotterAnnounceLeader",
  louder: "spotterLouder",
  quieter: "spotterQuieter",
  silence: "spotterSilence",
};

const AiSpotterControlsSettings = CommonSettings.extend({
  control: z
    .enum([
      "damage-report",
      "weather-report",
      "toggle-report-laps",
      "announce-leader",
      "louder",
      "quieter",
      "silence",
    ])
    .default("damage-report"),
});

type AiSpotterControlsSettings = z.infer<typeof AiSpotterControlsSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the AI spotter controls action.
 */
export function generateAiSpotterControlsSvg(settings: AiSpotterControlsSettings): string {
  const { control } = settings;
  const iconSvg = SPOTTER_ICONS[control] || SPOTTER_ICONS["damage-report"];
  const labels = SPOTTER_LABELS[control] || SPOTTER_LABELS["damage-report"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, { mainLabel: labels.mainLabel, subLabel: labels.subLabel, ...colors });

  return svgToDataUri(svg);
}

/**
 * AI Spotter Controls Action
 * Provides controls for the iRacing AI spotter: damage/weather reports, lap reporting,
 * leader announcements, and volume/silence controls.
 */
@action({ UUID: "com.iracedeck.sd.core.ai-spotter-controls" })
export class AiSpotterControls extends ConnectionStateAwareAction<AiSpotterControlsSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("AiSpotterControls"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<AiSpotterControlsSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<AiSpotterControlsSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<AiSpotterControlsSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<AiSpotterControlsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(settings.control);
  }

  private parseSettings(settings: unknown): AiSpotterControlsSettings {
    const parsed = AiSpotterControlsSettings.safeParse(settings);

    return parsed.success ? parsed.data : AiSpotterControlsSettings.parse({});
  }

  private async executeControl(control: SpotterControl): Promise<void> {
    this.logger.info("Control executed");
    this.logger.debug(`Executing ${control}`);

    const settingKey = SPOTTER_GLOBAL_KEYS[control];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${control}`);

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
    ev: WillAppearEvent<AiSpotterControlsSettings> | DidReceiveSettingsEvent<AiSpotterControlsSettings>,
    settings: AiSpotterControlsSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateAiSpotterControlsSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateAiSpotterControlsSvg(settings));
  }
}
