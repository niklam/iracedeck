import streamDeck, {
  action,
  DialRotateEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
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
 * Label configuration for each black box type
 */
const BLACK_BOX_LABELS: Record<string, { mainLabel: string; subLabel: string }> = {
  "lap-timing": { mainLabel: "LAP TIMING", subLabel: "TOGGLE" },
  standings: { mainLabel: "STANDINGS", subLabel: "TOGGLE" },
  relative: { mainLabel: "RELATIVE", subLabel: "TOGGLE" },
  fuel: { mainLabel: "FUEL", subLabel: "ADJUSTMENTS" },
  tires: { mainLabel: "TIRES", subLabel: "ADJUSTMENTS" },
  "tire-info": { mainLabel: "TIRE INFO", subLabel: "TOGGLE" },
  "pit-stop": { mainLabel: "PIT-STOP", subLabel: "ADJUSTMENTS" },
  "in-car": { mainLabel: "IN-CAR", subLabel: "ADJUSTMENTS" },
  mirror: { mainLabel: "GRAPHICS", subLabel: "ADJUSTMENTS" },
  radio: { mainLabel: "RADIO", subLabel: "CHANNELS" },
  weather: { mainLabel: "WEATHER", subLabel: "FORECAST" },
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
export function generateBlackBoxSelectorSvg(settings: BlackBoxSelectorSettings): string {
  const { mode, blackBox } = settings;

  let iconSvg: string;
  let labels: { mainLabel: string; subLabel: string };

  if (mode === "next") {
    iconSvg = CYCLE_ICONS.next;
    labels = { mainLabel: "NEXT", subLabel: "BLACK BOX" };
  } else if (mode === "previous") {
    iconSvg = CYCLE_ICONS.previous;
    labels = { mainLabel: "PREVIOUS", subLabel: "BLACK BOX" };
  } else {
    iconSvg = DIRECT_ICONS[blackBox] || DIRECT_ICONS["lap-timing"];
    labels = BLACK_BOX_LABELS[blackBox] || { mainLabel: "BLACK BOX", subLabel: "TOGGLE" };
  }

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Black Box Selector Action
 * Cycles through or directly selects iRacing black box screens via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.black-box-selector" })
export class BlackBoxSelector extends ConnectionStateAwareAction<BlackBoxSelectorSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("BlackBoxSelector"), LogLevel.Info);

  /**
   * When the action appears on the Stream Deck
   */
  override async onWillAppear(ev: WillAppearEvent<BlackBoxSelectorSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const parsed = BlackBoxSelectorSettings.safeParse(ev.payload.settings);
    const settings = parsed.success ? parsed.data : BlackBoxSelectorSettings.parse({});

    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  /**
   * When the action disappears from the Stream Deck
   */
  override async onWillDisappear(ev: WillDisappearEvent<BlackBoxSelectorSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  /**
   * Update display with current settings
   */
  private async updateDisplay(
    ev: WillAppearEvent<BlackBoxSelectorSettings> | any,
    settings: BlackBoxSelectorSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateBlackBoxSelectorSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }

  /**
   * When settings are received or updated
   */
  override async onDidReceiveSettings(ev: any): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const parsed = BlackBoxSelectorSettings.safeParse(ev.payload.settings);
    const settings = parsed.success ? parsed.data : BlackBoxSelectorSettings.parse({});

    await this.updateDisplay(ev, settings);
  }

  /**
   * When the key is pressed
   */
  override async onKeyDown(ev: KeyDownEvent<BlackBoxSelectorSettings>): Promise<void> {
    this.logger.info("Key down received");

    const parsed = BlackBoxSelectorSettings.safeParse(ev.payload.settings);
    const settings = parsed.success ? parsed.data : BlackBoxSelectorSettings.parse({});

    const { mode, blackBox } = settings;
    const globalSettings = getGlobalSettings() as Record<string, unknown>;

    let settingKey: string;

    if (mode === "direct") {
      settingKey = BLACK_BOX_GLOBAL_KEYS[blackBox];
    } else if (mode === "next") {
      settingKey = GLOBAL_KEYS.CYCLE_NEXT;
    } else {
      settingKey = GLOBAL_KEYS.CYCLE_PREVIOUS;
    }

    const binding = parseKeyBinding(globalSettings[settingKey]);

    this.logger.info(`Looking for key: ${settingKey}, found: ${JSON.stringify(binding)}`);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return;
    }

    await this.sendKeyBinding(binding);
  }

  /**
   * Send a key binding via the keyboard interface
   */
  private async sendKeyBinding(binding: KeyBindingValue): Promise<void> {
    const combination: KeyCombination = {
      key: binding.key as KeyboardKey,
      modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
      code: binding.code,
    };

    this.logger.debug(`Sending key combination: ${JSON.stringify(combination)}`);

    const keyboard = getKeyboard();

    if (!keyboard) {
      this.logger.error("Keyboard interface not available");

      return;
    }

    const success = await keyboard.sendKeyCombination(combination);

    if (success) {
      this.logger.info("Key sent successfully");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to send key");
      this.logger.debug(`Failed key combination: ${formatKeyBinding(binding)}`);
    }
  }

  /**
   * When the encoder dial is rotated (Stream Deck+)
   */
  override async onDialRotate(ev: DialRotateEvent<BlackBoxSelectorSettings>): Promise<void> {
    this.logger.info(`Dial rotated: ${ev.payload.ticks} ticks`);

    const globalSettings = getGlobalSettings() as Record<string, unknown>;

    // Clockwise (ticks > 0) = next, Counter-clockwise (ticks < 0) = previous
    const settingKey = ev.payload.ticks > 0 ? GLOBAL_KEYS.CYCLE_NEXT : GLOBAL_KEYS.CYCLE_PREVIOUS;

    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return;
    }

    await this.sendKeyBinding(binding);
  }
}
