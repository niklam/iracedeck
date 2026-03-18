import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import tcSlot1DecreaseIconSvg from "@iracedeck/icons/setup-traction/tc-slot-1-decrease.svg";
import tcSlot1IncreaseIconSvg from "@iracedeck/icons/setup-traction/tc-slot-1-increase.svg";
import tcSlot2DecreaseIconSvg from "@iracedeck/icons/setup-traction/tc-slot-2-decrease.svg";
import tcSlot2IncreaseIconSvg from "@iracedeck/icons/setup-traction/tc-slot-2-increase.svg";
import tcSlot3DecreaseIconSvg from "@iracedeck/icons/setup-traction/tc-slot-3-decrease.svg";
import tcSlot3IncreaseIconSvg from "@iracedeck/icons/setup-traction/tc-slot-3-increase.svg";
import tcSlot4DecreaseIconSvg from "@iracedeck/icons/setup-traction/tc-slot-4-decrease.svg";
import tcSlot4IncreaseIconSvg from "@iracedeck/icons/setup-traction/tc-slot-4-increase.svg";
import tcToggleIconSvg from "@iracedeck/icons/setup-traction/tc-toggle.svg";
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

type SetupTractionSetting = "tc-toggle" | "tc-slot-1" | "tc-slot-2" | "tc-slot-3" | "tc-slot-4";

type DirectionType = "increase" | "decrease";

/** Controls that have +/- direction */
const DIRECTIONAL_CONTROLS: Set<SetupTractionSetting> = new Set([
  "tc-slot-1",
  "tc-slot-2",
  "tc-slot-3",
  "tc-slot-4",
]);

/**
 * Flat icon lookup record mapping setting + direction keys to standalone SVG templates.
 */
const SETUP_TRACTION_ICONS: Record<string, string> = {
  "tc-toggle": tcToggleIconSvg,
  "tc-slot-1-increase": tcSlot1IncreaseIconSvg,
  "tc-slot-1-decrease": tcSlot1DecreaseIconSvg,
  "tc-slot-2-increase": tcSlot2IncreaseIconSvg,
  "tc-slot-2-decrease": tcSlot2DecreaseIconSvg,
  "tc-slot-3-increase": tcSlot3IncreaseIconSvg,
  "tc-slot-3-decrease": tcSlot3DecreaseIconSvg,
  "tc-slot-4-increase": tcSlot4IncreaseIconSvg,
  "tc-slot-4-decrease": tcSlot4DecreaseIconSvg,
};

/**
 * Label configuration for each setting + direction combination.
 */
const SETUP_TRACTION_LABELS: Record<string, { mainLabel: string; subLabel: string }> = {
  "tc-toggle": { mainLabel: "TC", subLabel: "TOGGLE" },
  "tc-slot-1-increase": { mainLabel: "TC SLOT 1", subLabel: "INCREASE" },
  "tc-slot-1-decrease": { mainLabel: "TC SLOT 1", subLabel: "DECREASE" },
  "tc-slot-2-increase": { mainLabel: "TC SLOT 2", subLabel: "INCREASE" },
  "tc-slot-2-decrease": { mainLabel: "TC SLOT 2", subLabel: "DECREASE" },
  "tc-slot-3-increase": { mainLabel: "TC SLOT 3", subLabel: "INCREASE" },
  "tc-slot-3-decrease": { mainLabel: "TC SLOT 3", subLabel: "DECREASE" },
  "tc-slot-4-increase": { mainLabel: "TC SLOT 4", subLabel: "INCREASE" },
  "tc-slot-4-decrease": { mainLabel: "TC SLOT 4", subLabel: "DECREASE" },
};

/**
 * @internal Exported for testing
 *
 * Mapping from setting + direction to global settings keys.
 * Directional controls use composite keys (e.g., "tc-slot-1-increase").
 */
export const SETUP_TRACTION_GLOBAL_KEYS: Record<string, string> = {
  "tc-toggle": "setupTractionTcToggle",
  "tc-slot-1-increase": "setupTractionTcSlot1Increase",
  "tc-slot-1-decrease": "setupTractionTcSlot1Decrease",
  "tc-slot-2-increase": "setupTractionTcSlot2Increase",
  "tc-slot-2-decrease": "setupTractionTcSlot2Decrease",
  "tc-slot-3-increase": "setupTractionTcSlot3Increase",
  "tc-slot-3-decrease": "setupTractionTcSlot3Decrease",
  "tc-slot-4-increase": "setupTractionTcSlot4Increase",
  "tc-slot-4-decrease": "setupTractionTcSlot4Decrease",
};

const SetupTractionSettings = CommonSettings.extend({
  setting: z.enum(["tc-toggle", "tc-slot-1", "tc-slot-2", "tc-slot-3", "tc-slot-4"]).default("tc-toggle"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type SetupTractionSettings = z.infer<typeof SetupTractionSettings>;

/**
 * Resolves the flat icon lookup key from setting and direction.
 */
function resolveIconKey(setting: SetupTractionSetting, direction: DirectionType): string {
  if (DIRECTIONAL_CONTROLS.has(setting)) {
    return `${setting}-${direction}`;
  }

  return setting;
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup traction action.
 */
export function generateSetupTractionSvg(settings: SetupTractionSettings): string {
  const iconKey = resolveIconKey(settings.setting, settings.direction);

  const iconSvg = SETUP_TRACTION_ICONS[iconKey] || SETUP_TRACTION_ICONS["tc-toggle"];
  const labels = SETUP_TRACTION_LABELS[iconKey] || { mainLabel: "TC", subLabel: "SETUP" };

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Setup Traction Action
 * Provides traction control in-car adjustments (TC Toggle, TC Slots 1-4)
 * via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.setup-traction" })
export class SetupTraction extends ConnectionStateAwareAction<SetupTractionSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("SetupTraction"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<SetupTractionSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<SetupTractionSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SetupTractionSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<SetupTractionSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialDown(ev: DialDownEvent<SetupTractionSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialRotate(ev: DialRotateEvent<SetupTractionSettings>): Promise<void> {
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

  private parseSettings(settings: unknown): SetupTractionSettings {
    const parsed = SetupTractionSettings.safeParse(settings);

    return parsed.success ? parsed.data : SetupTractionSettings.parse({});
  }

  private async executeSetting(setting: SetupTractionSetting, direction: DirectionType): Promise<void> {
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

  private resolveGlobalKey(setting: SetupTractionSetting, direction: DirectionType): string | null {
    if (DIRECTIONAL_CONTROLS.has(setting)) {
      const key = `${setting}-${direction}`;

      return SETUP_TRACTION_GLOBAL_KEYS[key] ?? null;
    }

    return SETUP_TRACTION_GLOBAL_KEYS[setting] ?? null;
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
    ev: WillAppearEvent<SetupTractionSettings> | DidReceiveSettingsEvent<SetupTractionSettings>,
    settings: SetupTractionSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateSetupTractionSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
