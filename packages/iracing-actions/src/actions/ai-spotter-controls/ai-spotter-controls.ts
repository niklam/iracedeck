import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import announceLeaderIconSvg from "@iracedeck/icons/ai-spotter-controls/announce-leader.svg";
import damageReportIconSvg from "@iracedeck/icons/ai-spotter-controls/damage-report.svg";
import louderIconSvg from "@iracedeck/icons/ai-spotter-controls/louder.svg";
import quieterIconSvg from "@iracedeck/icons/ai-spotter-controls/quieter.svg";
import silenceIconSvg from "@iracedeck/icons/ai-spotter-controls/silence.svg";
import toggleReportLapsIconSvg from "@iracedeck/icons/ai-spotter-controls/toggle-report-laps.svg";
import weatherReportIconSvg from "@iracedeck/icons/ai-spotter-controls/weather-report.svg";
import z from "zod";

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
 * Title text for each spotter control (format: "subLabel\nmainLabel")
 */
export const SPOTTER_TITLES: Record<SpotterControl, string> = {
  "damage-report": "REPORT\nDAMAGE",
  "weather-report": "REPORT\nWEATHER",
  "toggle-report-laps": "REPORT\nLAPS",
  "announce-leader": "SPOTTER\nLEADER",
  louder: "VOL UP\nSPOTTER",
  quieter: "VOL DOWN\nSPOTTER",
  silence: "MUTE\nSPOTTER",
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
export function generateAiSpotterControlsSvg(settings: AiSpotterControlsSettings, bindingMissing = false): string {
  const { control } = settings;
  const iconSvg = SPOTTER_ICONS[control] || SPOTTER_ICONS["damage-report"];
  const defaultTitle = SPOTTER_TITLES[control] || SPOTTER_TITLES["damage-report"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * AI Spotter Controls Action
 * Provides controls for the iRacing AI spotter: damage/weather reports, lap reporting,
 * leader announcements, and volume/silence controls.
 */
export const AI_SPOTTER_CONTROLS_UUID = "com.iracedeck.sd.core.ai-spotter-controls" as const;

export class AiSpotterControls extends ConnectionStateAwareAction<AiSpotterControlsSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<AiSpotterControlsSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.setActiveBinding(SPOTTER_GLOBAL_KEYS[settings.control]);
    await this.updateDisplay(ev, settings);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<AiSpotterControlsSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.setActiveBinding(SPOTTER_GLOBAL_KEYS[settings.control]);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<AiSpotterControlsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);

    const settingKey = SPOTTER_GLOBAL_KEYS[settings.control];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${settings.control}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  private parseSettings(settings: unknown): AiSpotterControlsSettings {
    const parsed = AiSpotterControlsSettings.safeParse(settings);

    return parsed.success ? parsed.data : AiSpotterControlsSettings.parse({});
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<AiSpotterControlsSettings> | IDeckDidReceiveSettingsEvent<AiSpotterControlsSettings>,
    settings: AiSpotterControlsSettings,
  ): Promise<void> {
    const svgDataUri = generateAiSpotterControlsSvg(
      settings,
      this.isBindingMissing(SPOTTER_GLOBAL_KEYS[settings.control]),
    );
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () =>
      generateAiSpotterControlsSvg(settings, this.isBindingMissing(SPOTTER_GLOBAL_KEYS[settings.control])),
    );
  }
}
