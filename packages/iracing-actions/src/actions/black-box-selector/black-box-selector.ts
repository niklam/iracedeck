import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import fuelIconSvg from "@iracedeck/icons/black-box-selector/fuel.svg";
import inCarIconSvg from "@iracedeck/icons/black-box-selector/in-car.svg";
import lapTimingIconSvg from "@iracedeck/icons/black-box-selector/lap-timing.svg";
import mirrorIconSvg from "@iracedeck/icons/black-box-selector/mirror.svg";
import nextIconSvg from "@iracedeck/icons/black-box-selector/next.svg";
import pitStopIconSvg from "@iracedeck/icons/black-box-selector/pit-stop.svg";
import previousIconSvg from "@iracedeck/icons/black-box-selector/previous.svg";
import radioIconSvg from "@iracedeck/icons/black-box-selector/radio.svg";
import relativeIconSvg from "@iracedeck/icons/black-box-selector/relative.svg";
import standingsIconSvg from "@iracedeck/icons/black-box-selector/standings.svg";
import tireInfoIconSvg from "@iracedeck/icons/black-box-selector/tire-info.svg";
import tiresIconSvg from "@iracedeck/icons/black-box-selector/tires.svg";
import weatherIconSvg from "@iracedeck/icons/black-box-selector/weather.svg";
import z from "zod";

const DIRECT_ICONS: Record<string, string> = {
  "lap-timing": lapTimingIconSvg,
  standings: standingsIconSvg,
  relative: relativeIconSvg,
  fuel: fuelIconSvg,
  tires: tiresIconSvg,
  "tire-info": tireInfoIconSvg,
  "pit-stop": pitStopIconSvg,
  "in-car": inCarIconSvg,
  mirror: mirrorIconSvg,
  radio: radioIconSvg,
  weather: weatherIconSvg,
};

const CYCLE_ICONS: Record<string, string> = {
  next: nextIconSvg,
  previous: previousIconSvg,
};

/**
 * Title text for each black box type. Single-line — a leading newline
 * would reserve a phantom first line in the title block and pull the
 * artwork upward (see .claude/rules/icons.md).
 */
const BLACK_BOX_TITLE_TEXT: Record<string, string> = {
  "lap-timing": "LAP TIMING",
  standings: "STANDINGS",
  relative: "RELATIVE",
  fuel: "FUEL",
  tires: "TIRES",
  "tire-info": "TIRE INFO",
  "pit-stop": "PIT-STOP",
  "in-car": "IN-CAR",
  mirror: "GRAPHICS",
  radio: "RADIO",
  weather: "WEATHER",
};

/**
 * @internal Exported for testing
 *
 * Mapping from blackBox setting values (kebab-case) to global settings keys
 */
export const BLACK_BOX_GLOBAL_KEYS: Record<string, string> = {
  "lap-timing": "blackBoxLapTiming",
  standings: "blackBoxStandings",
  relative: "blackBoxRelative",
  fuel: "blackBoxFuel",
  tires: "blackBoxTires",
  "tire-info": "blackBoxTireInfo",
  "pit-stop": "blackBoxPitStop",
  "in-car": "blackBoxInCar",
  mirror: "blackBoxMirror",
  radio: "blackBoxRadio",
  weather: "blackBoxWeather",
};

const BlackBoxSelectorSettings = CommonSettings.extend({
  mode: z.enum(["direct", "next", "previous"]).default("direct"),
  blackBox: z
    .enum([
      "lap-timing",
      "standings",
      "relative",
      "fuel",
      "tires",
      "tire-info",
      "pit-stop",
      "in-car",
      "mirror",
      "radio",
      "weather",
    ])
    .default("lap-timing"),
});

type BlackBoxSelectorSettings = z.infer<typeof BlackBoxSelectorSettings>;

/**
 * Global settings keys for cycle actions
 */
const GLOBAL_KEYS = {
  CYCLE_NEXT: "blackBoxCycleNext",
  CYCLE_PREVIOUS: "blackBoxCyclePrevious",
} as const;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the black box selector action.
 */
export function generateBlackBoxSelectorSvg(settings: BlackBoxSelectorSettings, bindingMissing = false): string {
  const { mode, blackBox } = settings;

  let iconSvg: string;
  let defaultTitle: string;

  if (mode === "next") {
    iconSvg = CYCLE_ICONS.next;
    defaultTitle = "NEXT";
  } else if (mode === "previous") {
    iconSvg = CYCLE_ICONS.previous;
    defaultTitle = "PREVIOUS";
  } else {
    iconSvg = DIRECT_ICONS[blackBox] || DIRECT_ICONS["lap-timing"];
    defaultTitle = BLACK_BOX_TITLE_TEXT[blackBox] || "BLACK BOX";
  }

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * Black Box Selector Action
 * Cycles through or directly selects iRacing black box screens via keyboard shortcuts.
 */
export const BLACK_BOX_SELECTOR_UUID = "com.iracedeck.sd.core.black-box-selector" as const;

export class BlackBoxSelector extends ConnectionStateAwareAction<BlackBoxSelectorSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<BlackBoxSelectorSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.setActiveBinding(this.resolveSettingKey(settings));
    await this.updateDisplay(ev, settings);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<BlackBoxSelectorSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.setActiveBinding(this.resolveSettingKey(settings));
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<BlackBoxSelectorSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.tapBinding(this.resolveSettingKey(settings));
  }

  private parseSettings(settings: unknown): BlackBoxSelectorSettings {
    const parsed = BlackBoxSelectorSettings.safeParse(settings);

    return parsed.success ? parsed.data : BlackBoxSelectorSettings.parse({});
  }

  private resolveSettingKey(settings: BlackBoxSelectorSettings): string {
    const { mode, blackBox } = settings;

    return mode === "direct"
      ? BLACK_BOX_GLOBAL_KEYS[blackBox]
      : mode === "next"
        ? GLOBAL_KEYS.CYCLE_NEXT
        : GLOBAL_KEYS.CYCLE_PREVIOUS;
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<BlackBoxSelectorSettings> | IDeckDidReceiveSettingsEvent<BlackBoxSelectorSettings>,
    settings: BlackBoxSelectorSettings,
  ): Promise<void> {
    const svgDataUri = generateBlackBoxSelectorSvg(settings, this.isBindingMissing(this.resolveSettingKey(settings)));
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () =>
      generateBlackBoxSelectorSvg(settings, this.isBindingMissing(this.resolveSettingKey(settings))),
    );
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<BlackBoxSelectorSettings>): Promise<void> {
    this.logger.info(`Dial rotated: ${ev.payload.ticks} ticks`);

    // Clockwise (ticks > 0) = next, Counter-clockwise (ticks < 0) = previous
    const settingKey = ev.payload.ticks > 0 ? GLOBAL_KEYS.CYCLE_NEXT : GLOBAL_KEYS.CYCLE_PREVIOUS;

    await this.tapBinding(settingKey);
  }
}
