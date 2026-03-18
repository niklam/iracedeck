import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import absAdjustDecreaseIconSvg from "@iracedeck/icons/setup-brakes/abs-adjust-decrease.svg";
import absAdjustIncreaseIconSvg from "@iracedeck/icons/setup-brakes/abs-adjust-increase.svg";
import absToggleIconSvg from "@iracedeck/icons/setup-brakes/abs-toggle.svg";
import brakeBiasDecreaseIconSvg from "@iracedeck/icons/setup-brakes/brake-bias-decrease.svg";
import brakeBiasFineDecreaseIconSvg from "@iracedeck/icons/setup-brakes/brake-bias-fine-decrease.svg";
import brakeBiasFineIncreaseIconSvg from "@iracedeck/icons/setup-brakes/brake-bias-fine-increase.svg";
import brakeBiasIncreaseIconSvg from "@iracedeck/icons/setup-brakes/brake-bias-increase.svg";
import brakeMiscDecreaseIconSvg from "@iracedeck/icons/setup-brakes/brake-misc-decrease.svg";
import brakeMiscIncreaseIconSvg from "@iracedeck/icons/setup-brakes/brake-misc-increase.svg";
import engineBrakingDecreaseIconSvg from "@iracedeck/icons/setup-brakes/engine-braking-decrease.svg";
import engineBrakingIncreaseIconSvg from "@iracedeck/icons/setup-brakes/engine-braking-increase.svg";
import peakBrakeBiasDecreaseIconSvg from "@iracedeck/icons/setup-brakes/peak-brake-bias-decrease.svg";
import peakBrakeBiasIncreaseIconSvg from "@iracedeck/icons/setup-brakes/peak-brake-bias-increase.svg";
import z from "zod";

import {
  CommonSettings,
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

type SetupBrakesSetting =
  | "abs-toggle"
  | "abs-adjust"
  | "brake-bias"
  | "brake-bias-fine"
  | "peak-brake-bias"
  | "brake-misc"
  | "engine-braking";

type DirectionType = "increase" | "decrease";

/** Controls that have +/- direction */
const DIRECTIONAL_CONTROLS: Set<SetupBrakesSetting> = new Set([
  "abs-adjust",
  "brake-bias",
  "brake-bias-fine",
  "peak-brake-bias",
  "brake-misc",
  "engine-braking",
]);

/**
 * Flat icon lookup mapping setting + direction keys to standalone SVG templates.
 */
const SETUP_BRAKES_ICONS: Record<string, string> = {
  "abs-toggle": absToggleIconSvg,
  "abs-adjust-increase": absAdjustIncreaseIconSvg,
  "abs-adjust-decrease": absAdjustDecreaseIconSvg,
  "brake-bias-increase": brakeBiasIncreaseIconSvg,
  "brake-bias-decrease": brakeBiasDecreaseIconSvg,
  "brake-bias-fine-increase": brakeBiasFineIncreaseIconSvg,
  "brake-bias-fine-decrease": brakeBiasFineDecreaseIconSvg,
  "peak-brake-bias-increase": peakBrakeBiasIncreaseIconSvg,
  "peak-brake-bias-decrease": peakBrakeBiasDecreaseIconSvg,
  "brake-misc-increase": brakeMiscIncreaseIconSvg,
  "brake-misc-decrease": brakeMiscDecreaseIconSvg,
  "engine-braking-increase": engineBrakingIncreaseIconSvg,
  "engine-braking-decrease": engineBrakingDecreaseIconSvg,
};

/**
 * Label configuration for each setting + direction combination.
 * mainLabel = primary (bold, white), subLabel = secondary (subdued).
 */
const SETUP_BRAKES_LABELS: Record<string, { mainLabel: string; subLabel: string }> = {
  "abs-toggle": { mainLabel: "ABS", subLabel: "TOGGLE" },
  "abs-adjust-increase": { mainLabel: "ABS", subLabel: "INCREASE" },
  "abs-adjust-decrease": { mainLabel: "ABS", subLabel: "DECREASE" },
  "brake-bias-increase": { mainLabel: "BRAKE BIAS", subLabel: "INCREASE" },
  "brake-bias-decrease": { mainLabel: "BRAKE BIAS", subLabel: "DECREASE" },
  "brake-bias-fine-increase": { mainLabel: "BIAS FINE", subLabel: "INCREASE" },
  "brake-bias-fine-decrease": { mainLabel: "BIAS FINE", subLabel: "DECREASE" },
  "peak-brake-bias-increase": { mainLabel: "PEAK BIAS", subLabel: "INCREASE" },
  "peak-brake-bias-decrease": { mainLabel: "PEAK BIAS", subLabel: "DECREASE" },
  "brake-misc-increase": { mainLabel: "BRAKE MISC", subLabel: "INCREASE" },
  "brake-misc-decrease": { mainLabel: "BRAKE MISC", subLabel: "DECREASE" },
  "engine-braking-increase": { mainLabel: "ENG BRAKE", subLabel: "INCREASE" },
  "engine-braking-decrease": { mainLabel: "ENG BRAKE", subLabel: "DECREASE" },
};

/**
 * @internal Exported for testing
 *
 * Mapping from setting + direction to global settings keys.
 * Directional controls use composite keys (e.g., "brake-bias-increase").
 */
export const SETUP_BRAKES_GLOBAL_KEYS: Record<string, string> = {
  "abs-toggle": "setupBrakesAbsToggle",
  "abs-adjust-increase": "setupBrakesAbsAdjustIncrease",
  "abs-adjust-decrease": "setupBrakesAbsAdjustDecrease",
  "brake-bias-increase": "setupBrakesBrakeBiasIncrease",
  "brake-bias-decrease": "setupBrakesBrakeBiasDecrease",
  "brake-bias-fine-increase": "setupBrakesBrakeBiasFineIncrease",
  "brake-bias-fine-decrease": "setupBrakesBrakeBiasFineDecrease",
  "peak-brake-bias-increase": "setupBrakesPeakBrakeBiasIncrease",
  "peak-brake-bias-decrease": "setupBrakesPeakBrakeBiasDecrease",
  "brake-misc-increase": "setupBrakesBrakeMiscIncrease",
  "brake-misc-decrease": "setupBrakesBrakeMiscDecrease",
  "engine-braking-increase": "setupBrakesEngineBrakingIncrease",
  "engine-braking-decrease": "setupBrakesEngineBrakingDecrease",
};

const SetupBrakesSettings = CommonSettings.extend({
  setting: z
    .enum([
      "abs-toggle",
      "abs-adjust",
      "brake-bias",
      "brake-bias-fine",
      "peak-brake-bias",
      "brake-misc",
      "engine-braking",
    ])
    .default("brake-bias"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type SetupBrakesSettings = z.infer<typeof SetupBrakesSettings>;

/**
 * Resolves the flat icon lookup key for a given setting and direction.
 */
function resolveIconKey(setting: SetupBrakesSetting, direction: DirectionType): string {
  if (DIRECTIONAL_CONTROLS.has(setting)) {
    return `${setting}-${direction}`;
  }

  return setting;
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup brakes action.
 */
export function generateSetupBrakesSvg(settings: SetupBrakesSettings): string {
  const { setting, direction } = settings;

  const iconKey = resolveIconKey(setting, direction);
  const iconSvg = SETUP_BRAKES_ICONS[iconKey] || SETUP_BRAKES_ICONS["abs-toggle"];
  const labels = SETUP_BRAKES_LABELS[iconKey] || { mainLabel: "BRAKE", subLabel: "SETUP" };

  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
  });

  return svgToDataUri(svg);
}

/**
 * Setup Brakes Action
 * Provides brake-related in-car adjustments (ABS, brake bias, peak bias,
 * engine braking) via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.setup-brakes" })
export class SetupBrakes extends ConnectionStateAwareAction<SetupBrakesSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("SetupBrakes"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<SetupBrakesSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<SetupBrakesSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SetupBrakesSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<SetupBrakesSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialDown(ev: DialDownEvent<SetupBrakesSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialRotate(ev: DialRotateEvent<SetupBrakesSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);

    // Non-directional controls have no +/- adjustment — ignore rotation
    if (!DIRECTIONAL_CONTROLS.has(settings.setting)) {
      this.logger.debug(`Rotation ignored for ${settings.setting}`);

      return;
    }

    // Clockwise (ticks > 0) = increase, Counter-clockwise (ticks < 0) = decrease
    const direction: DirectionType = ev.payload.ticks > 0 ? "increase" : "decrease";
    await this.executeSetting(settings.setting, direction);
  }

  private parseSettings(settings: unknown): SetupBrakesSettings {
    const parsed = SetupBrakesSettings.safeParse(settings);

    return parsed.success ? parsed.data : SetupBrakesSettings.parse({});
  }

  private async executeSetting(setting: SetupBrakesSetting, direction: DirectionType): Promise<void> {
    this.logger.info("Setting executed");
    this.logger.debug(`Executing ${setting} ${direction}`);

    const settingKey = this.resolveGlobalKey(setting, direction);

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

  private resolveGlobalKey(setting: SetupBrakesSetting, direction: DirectionType): string | null {
    if (DIRECTIONAL_CONTROLS.has(setting)) {
      const key = `${setting}-${direction}`;

      return SETUP_BRAKES_GLOBAL_KEYS[key] ?? null;
    }

    return SETUP_BRAKES_GLOBAL_KEYS[setting] ?? null;
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
    ev: WillAppearEvent<SetupBrakesSettings> | DidReceiveSettingsEvent<SetupBrakesSettings>,
    settings: SetupBrakesSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateSetupBrakesSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
