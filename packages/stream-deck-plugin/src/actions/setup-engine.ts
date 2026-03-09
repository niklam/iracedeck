import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import boostLevelDecreaseIconSvg from "@iracedeck/icons/setup-engine/boost-level-decrease.svg";
import boostLevelIncreaseIconSvg from "@iracedeck/icons/setup-engine/boost-level-increase.svg";
import enginePowerDecreaseIconSvg from "@iracedeck/icons/setup-engine/engine-power-decrease.svg";
import enginePowerIncreaseIconSvg from "@iracedeck/icons/setup-engine/engine-power-increase.svg";
import launchRpmDecreaseIconSvg from "@iracedeck/icons/setup-engine/launch-rpm-decrease.svg";
import launchRpmIncreaseIconSvg from "@iracedeck/icons/setup-engine/launch-rpm-increase.svg";
import throttleShapingDecreaseIconSvg from "@iracedeck/icons/setup-engine/throttle-shaping-decrease.svg";
import throttleShapingIncreaseIconSvg from "@iracedeck/icons/setup-engine/throttle-shaping-increase.svg";
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

type SetupEngineSetting = "engine-power" | "throttle-shaping" | "boost-level" | "launch-rpm";

type DirectionType = "increase" | "decrease";

/**
 * Flat icon lookup mapping setting + direction keys to standalone SVG templates.
 */
const SETUP_ENGINE_ICONS: Record<string, string> = {
  "engine-power-increase": enginePowerIncreaseIconSvg,
  "engine-power-decrease": enginePowerDecreaseIconSvg,
  "throttle-shaping-increase": throttleShapingIncreaseIconSvg,
  "throttle-shaping-decrease": throttleShapingDecreaseIconSvg,
  "boost-level-increase": boostLevelIncreaseIconSvg,
  "boost-level-decrease": boostLevelDecreaseIconSvg,
  "launch-rpm-increase": launchRpmIncreaseIconSvg,
  "launch-rpm-decrease": launchRpmDecreaseIconSvg,
};

/**
 * Label configuration for each setting + direction combination.
 * mainLabel = primary (bold, white), subLabel = secondary (subdued).
 */
const SETUP_ENGINE_LABELS: Record<string, { mainLabel: string; subLabel: string }> = {
  "engine-power-increase": { mainLabel: "ENG POWER", subLabel: "INCREASE" },
  "engine-power-decrease": { mainLabel: "ENG POWER", subLabel: "DECREASE" },
  "throttle-shaping-increase": { mainLabel: "THROTTLE", subLabel: "INCREASE" },
  "throttle-shaping-decrease": { mainLabel: "THROTTLE", subLabel: "DECREASE" },
  "boost-level-increase": { mainLabel: "BOOST", subLabel: "INCREASE" },
  "boost-level-decrease": { mainLabel: "BOOST", subLabel: "DECREASE" },
  "launch-rpm-increase": { mainLabel: "LAUNCH RPM", subLabel: "INCREASE" },
  "launch-rpm-decrease": { mainLabel: "LAUNCH RPM", subLabel: "DECREASE" },
};

/**
 * @internal Exported for testing
 *
 * Mapping from setting + direction to global settings keys.
 * All engine settings are directional, using composite keys (e.g., "engine-power-increase").
 */
export const SETUP_ENGINE_GLOBAL_KEYS: Record<string, string> = {
  "engine-power-increase": "setupEngineEnginePowerIncrease",
  "engine-power-decrease": "setupEngineEnginePowerDecrease",
  "throttle-shaping-increase": "setupEngineThrottleShapingIncrease",
  "throttle-shaping-decrease": "setupEngineThrottleShapingDecrease",
  "boost-level-increase": "setupEngineBoostLevelIncrease",
  "boost-level-decrease": "setupEngineBoostLevelDecrease",
  "launch-rpm-increase": "setupEngineLaunchRpmIncrease",
  "launch-rpm-decrease": "setupEngineLaunchRpmDecrease",
};

const SetupEngineSettings = z.object({
  setting: z.enum(["engine-power", "throttle-shaping", "boost-level", "launch-rpm"]).default("engine-power"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type SetupEngineSettings = z.infer<typeof SetupEngineSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup engine action.
 */
export function generateSetupEngineSvg(settings: SetupEngineSettings): string {
  const { setting, direction } = settings;

  const iconKey = `${setting}-${direction}`;
  const iconSvg = SETUP_ENGINE_ICONS[iconKey] || SETUP_ENGINE_ICONS["engine-power-increase"];
  const labels = SETUP_ENGINE_LABELS[iconKey] || { mainLabel: "ENGINE", subLabel: "SETUP" };

  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
  });

  return svgToDataUri(svg);
}

/**
 * Setup Engine Action
 * Provides engine-related in-car adjustments (engine power, throttle shaping,
 * boost level, launch RPM) via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.setup-engine" })
export class SetupEngine extends ConnectionStateAwareAction<SetupEngineSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("SetupEngine"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<SetupEngineSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<SetupEngineSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SetupEngineSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<SetupEngineSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialDown(ev: DialDownEvent<SetupEngineSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialRotate(ev: DialRotateEvent<SetupEngineSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);

    // Clockwise (ticks > 0) = increase, Counter-clockwise (ticks < 0) = decrease
    const direction: DirectionType = ev.payload.ticks > 0 ? "increase" : "decrease";
    await this.executeSetting(settings.setting, direction);
  }

  private parseSettings(settings: unknown): SetupEngineSettings {
    const parsed = SetupEngineSettings.safeParse(settings);

    return parsed.success ? parsed.data : SetupEngineSettings.parse({});
  }

  private async executeSetting(setting: SetupEngineSetting, direction: DirectionType): Promise<void> {
    this.logger.info("Setting executed");
    this.logger.debug(`Executing ${setting} ${direction}`);

    const settingKey = SETUP_ENGINE_GLOBAL_KEYS[`${setting}-${direction}`];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${setting} ${direction}`);

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
    ev: WillAppearEvent<SetupEngineSettings> | DidReceiveSettingsEvent<SetupEngineSettings>,
    settings: SetupEngineSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateSetupEngineSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
