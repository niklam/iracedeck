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
import frontWingDecreaseIconSvg from "@iracedeck/icons/setup-aero/front-wing-decrease.svg";
import frontWingIncreaseIconSvg from "@iracedeck/icons/setup-aero/front-wing-increase.svg";
import qualifyingTapeDecreaseIconSvg from "@iracedeck/icons/setup-aero/qualifying-tape-decrease.svg";
import qualifyingTapeIncreaseIconSvg from "@iracedeck/icons/setup-aero/qualifying-tape-increase.svg";
import rearWingDecreaseIconSvg from "@iracedeck/icons/setup-aero/rear-wing-decrease.svg";
import rearWingIncreaseIconSvg from "@iracedeck/icons/setup-aero/rear-wing-increase.svg";
import rfBrakeAttachedIconSvg from "@iracedeck/icons/setup-aero/rf-brake-attached.svg";
import z from "zod";

type SetupAeroSetting = "front-wing" | "rear-wing" | "qualifying-tape" | "rf-brake-attached";

type DirectionType = "increase" | "decrease";

/** Controls that have +/- direction */
const DIRECTIONAL_CONTROLS: Set<SetupAeroSetting> = new Set([
  "front-wing",
  "rear-wing",
  "qualifying-tape",
]);

/**
 * Flat icon lookup record mapping setting + direction keys to imported SVGs.
 */
const SETUP_AERO_ICONS: Record<string, string> = {
  "front-wing-increase": frontWingIncreaseIconSvg,
  "front-wing-decrease": frontWingDecreaseIconSvg,
  "rear-wing-increase": rearWingIncreaseIconSvg,
  "rear-wing-decrease": rearWingDecreaseIconSvg,
  "qualifying-tape-increase": qualifyingTapeIncreaseIconSvg,
  "qualifying-tape-decrease": qualifyingTapeDecreaseIconSvg,
  "rf-brake-attached": rfBrakeAttachedIconSvg,
};

/**
 * Label configuration for each setting + direction combination.
 * Standard layout: mainLabel = primary (bold, top), subLabel = secondary (subdued, bottom).
 */
const SETUP_AERO_LABELS: Record<
  SetupAeroSetting,
  Record<DirectionType, { mainLabel: string; subLabel: string }> | { mainLabel: string; subLabel: string }
> = {
  "front-wing": {
    increase: { mainLabel: "FRONT WING", subLabel: "INCREASE" },
    decrease: { mainLabel: "FRONT WING", subLabel: "DECREASE" },
  },
  "rear-wing": {
    increase: { mainLabel: "REAR WING", subLabel: "INCREASE" },
    decrease: { mainLabel: "REAR WING", subLabel: "DECREASE" },
  },
  "qualifying-tape": {
    increase: { mainLabel: "QUAL TAPE", subLabel: "INCREASE" },
    decrease: { mainLabel: "QUAL TAPE", subLabel: "DECREASE" },
  },
  "rf-brake-attached": { mainLabel: "RF BRAKE", subLabel: "TOGGLE" },
};

/**
 * @internal Exported for testing
 *
 * Mapping from setting + direction to global settings keys.
 * Directional controls use composite keys (e.g., "front-wing-increase").
 */
export const SETUP_AERO_GLOBAL_KEYS: Record<string, string> = {
  "front-wing-increase": "setupAeroFrontWingIncrease",
  "front-wing-decrease": "setupAeroFrontWingDecrease",
  "rear-wing-increase": "setupAeroRearWingIncrease",
  "rear-wing-decrease": "setupAeroRearWingDecrease",
  "qualifying-tape-increase": "setupAeroQualifyingTapeIncrease",
  "qualifying-tape-decrease": "setupAeroQualifyingTapeDecrease",
  "rf-brake-attached": "setupAeroRfBrakeAttached",
};

const SetupAeroSettings = CommonSettings.extend({
  setting: z.enum(["front-wing", "rear-wing", "qualifying-tape", "rf-brake-attached"]).default("front-wing"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type SetupAeroSettings = z.infer<typeof SetupAeroSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup aero action.
 */
export function generateSetupAeroSvg(settings: SetupAeroSettings): string {
  const { setting, direction } = settings;

  const iconKey = DIRECTIONAL_CONTROLS.has(setting) ? `${setting}-${direction}` : setting;
  const iconSvg = SETUP_AERO_ICONS[iconKey] || SETUP_AERO_ICONS["rf-brake-attached"];

  const labelEntry = SETUP_AERO_LABELS[setting];
  const labels: { mainLabel: string; subLabel: string } =
    "mainLabel" in labelEntry ? labelEntry : (labelEntry[direction] ?? { mainLabel: "AERO", subLabel: "SETUP" });

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Setup Aero Action
 * Provides aerodynamic in-car adjustments (front wing, rear wing,
 * qualifying tape, RF brake attached) via keyboard shortcuts.
 */
export const SETUP_AERO_UUID = "com.iracedeck.sd.core.setup-aero" as const;

export class SetupAero extends ConnectionStateAwareAction<SetupAeroSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<SetupAeroSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SetupAeroSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SetupAeroSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<SetupAeroSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialDown(ev: IDeckDialDownEvent<SetupAeroSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<SetupAeroSettings>): Promise<void> {
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

  private parseSettings(settings: unknown): SetupAeroSettings {
    const parsed = SetupAeroSettings.safeParse(settings);

    return parsed.success ? parsed.data : SetupAeroSettings.parse({});
  }

  private async executeSetting(setting: SetupAeroSetting, direction: DirectionType): Promise<void> {
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

  private resolveGlobalKey(setting: SetupAeroSetting, direction: DirectionType): string | null {
    if (DIRECTIONAL_CONTROLS.has(setting)) {
      const key = `${setting}-${direction}`;

      return SETUP_AERO_GLOBAL_KEYS[key] ?? null;
    }

    return SETUP_AERO_GLOBAL_KEYS[setting] ?? null;
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
    ev: IDeckWillAppearEvent<SetupAeroSettings> | IDeckDidReceiveSettingsEvent<SetupAeroSettings>,
    settings: SetupAeroSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateSetupAeroSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateSetupAeroSvg(settings));
  }
}
