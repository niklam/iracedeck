import {
  CommonSettings,
  ConnectionStateAwareAction,
  formatKeyBinding,
  getGlobalColors,
  getGlobalSettings,
  getKeyboard,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  type KeyBindingValue,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  parseKeyBinding,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "@iracedeck/deck-core";
import disableFuelCutIconSvg from "@iracedeck/icons/setup-fuel/disable-fuel-cut.svg";
import fcyModeToggleIconSvg from "@iracedeck/icons/setup-fuel/fcy-mode-toggle.svg";
import fuelCutPositionDecreaseIconSvg from "@iracedeck/icons/setup-fuel/fuel-cut-position-decrease.svg";
import fuelCutPositionIncreaseIconSvg from "@iracedeck/icons/setup-fuel/fuel-cut-position-increase.svg";
import fuelMixtureDecreaseIconSvg from "@iracedeck/icons/setup-fuel/fuel-mixture-decrease.svg";
import fuelMixtureIncreaseIconSvg from "@iracedeck/icons/setup-fuel/fuel-mixture-increase.svg";
import lowFuelAcceptIconSvg from "@iracedeck/icons/setup-fuel/low-fuel-accept.svg";
import z from "zod";

type SetupFuelSetting =
  | "fuel-mixture"
  | "fuel-cut-position"
  | "disable-fuel-cut"
  | "low-fuel-accept"
  | "fcy-mode-toggle";

type DirectionType = "increase" | "decrease";

/** Controls that have +/- direction */
const DIRECTIONAL_CONTROLS: Set<SetupFuelSetting> = new Set(["fuel-mixture", "fuel-cut-position"]);

/**
 * Flat icon lookup record mapping setting + direction keys to imported SVGs.
 */
const SETUP_FUEL_ICONS: Record<string, string> = {
  "fuel-mixture-increase": fuelMixtureIncreaseIconSvg,
  "fuel-mixture-decrease": fuelMixtureDecreaseIconSvg,
  "fuel-cut-position-increase": fuelCutPositionIncreaseIconSvg,
  "fuel-cut-position-decrease": fuelCutPositionDecreaseIconSvg,
  "disable-fuel-cut": disableFuelCutIconSvg,
  "low-fuel-accept": lowFuelAcceptIconSvg,
  "fcy-mode-toggle": fcyModeToggleIconSvg,
};

/**
 * Label configuration for each setting + direction combination.
 * Standard layout: mainLabel = primary (bold, top), subLabel = secondary (subdued, bottom).
 */
const SETUP_FUEL_LABELS: Record<
  SetupFuelSetting,
  Record<DirectionType, { mainLabel: string; subLabel: string }> | { mainLabel: string; subLabel: string }
> = {
  "fuel-mixture": {
    increase: { mainLabel: "FUEL MIX", subLabel: "INCREASE" },
    decrease: { mainLabel: "FUEL MIX", subLabel: "DECREASE" },
  },
  "fuel-cut-position": {
    increase: { mainLabel: "FUEL CUT", subLabel: "INCREASE" },
    decrease: { mainLabel: "FUEL CUT", subLabel: "DECREASE" },
  },
  "disable-fuel-cut": { mainLabel: "FUEL CUT", subLabel: "DISABLE" },
  "low-fuel-accept": { mainLabel: "LOW FUEL", subLabel: "ACCEPT" },
  "fcy-mode-toggle": { mainLabel: "FCY MODE", subLabel: "TOGGLE" },
};

/**
 * @internal Exported for testing
 *
 * Mapping from setting + direction to global settings keys.
 * Directional controls use composite keys (e.g., "fuel-mixture-increase").
 */
export const SETUP_FUEL_GLOBAL_KEYS: Record<string, string> = {
  "fuel-mixture-increase": "setupFuelFuelMixtureIncrease",
  "fuel-mixture-decrease": "setupFuelFuelMixtureDecrease",
  "fuel-cut-position-increase": "setupFuelFuelCutPositionIncrease",
  "fuel-cut-position-decrease": "setupFuelFuelCutPositionDecrease",
  "disable-fuel-cut": "setupFuelDisableFuelCut",
  "low-fuel-accept": "setupFuelLowFuelAccept",
  "fcy-mode-toggle": "setupFuelFcyModeToggle",
};

const SetupFuelSettings = CommonSettings.extend({
  setting: z
    .enum(["fuel-mixture", "fuel-cut-position", "disable-fuel-cut", "low-fuel-accept", "fcy-mode-toggle"])
    .default("fuel-mixture"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type SetupFuelSettings = z.infer<typeof SetupFuelSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup fuel action.
 */
export function generateSetupFuelSvg(settings: SetupFuelSettings): string {
  const { setting, direction } = settings;

  const iconKey = DIRECTIONAL_CONTROLS.has(setting) ? `${setting}-${direction}` : setting;
  const iconSvg = SETUP_FUEL_ICONS[iconKey] || SETUP_FUEL_ICONS["disable-fuel-cut"];

  const labelEntry = SETUP_FUEL_LABELS[setting];
  const labels: { mainLabel: string; subLabel: string } =
    "mainLabel" in labelEntry ? labelEntry : (labelEntry[direction] ?? { mainLabel: "FUEL", subLabel: "SETUP" });

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Setup Fuel Action
 * Provides fuel-related in-car adjustments (fuel mixture, fuel cut position,
 * disable fuel cut, low fuel accept, FCY mode) via keyboard shortcuts.
 */
export const SETUP_FUEL_UUID = "com.iracedeck.sd.core.setup-fuel" as const;

export class SetupFuel extends ConnectionStateAwareAction<SetupFuelSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<SetupFuelSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SetupFuelSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SetupFuelSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<SetupFuelSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialDown(ev: IDeckDialDownEvent<SetupFuelSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<SetupFuelSettings>): Promise<void> {
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

  private parseSettings(settings: unknown): SetupFuelSettings {
    const parsed = SetupFuelSettings.safeParse(settings);

    return parsed.success ? parsed.data : SetupFuelSettings.parse({});
  }

  private async executeSetting(setting: SetupFuelSetting, direction: DirectionType): Promise<void> {
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

  private resolveGlobalKey(setting: SetupFuelSetting, direction: DirectionType): string | null {
    if (DIRECTIONAL_CONTROLS.has(setting)) {
      const key = `${setting}-${direction}`;

      return SETUP_FUEL_GLOBAL_KEYS[key] ?? null;
    }

    return SETUP_FUEL_GLOBAL_KEYS[setting] ?? null;
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
    ev: IDeckWillAppearEvent<SetupFuelSettings> | IDeckDidReceiveSettingsEvent<SetupFuelSettings>,
    settings: SetupFuelSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateSetupFuelSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateSetupFuelSvg(settings));
  }
}
