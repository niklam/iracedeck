import {
  CommonSettings,
  ConnectionStateAwareAction,
  formatKeyBinding,
  getGlobalColors,
  getGlobalSettings,
  getKeyboard,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
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
import hysBoostIconSvg from "@iracedeck/icons/setup-hybrid/hys-boost.svg";
import hysNoBoostIconSvg from "@iracedeck/icons/setup-hybrid/hys-no-boost.svg";
import hysRegenIconSvg from "@iracedeck/icons/setup-hybrid/hys-regen.svg";
import mgukDeployModeDecreaseIconSvg from "@iracedeck/icons/setup-hybrid/mguk-deploy-mode-decrease.svg";
import mgukDeployModeIncreaseIconSvg from "@iracedeck/icons/setup-hybrid/mguk-deploy-mode-increase.svg";
import mgukFixedDeployDecreaseIconSvg from "@iracedeck/icons/setup-hybrid/mguk-fixed-deploy-decrease.svg";
import mgukFixedDeployIncreaseIconSvg from "@iracedeck/icons/setup-hybrid/mguk-fixed-deploy-increase.svg";
import mgukRegenGainDecreaseIconSvg from "@iracedeck/icons/setup-hybrid/mguk-regen-gain-decrease.svg";
import mgukRegenGainIncreaseIconSvg from "@iracedeck/icons/setup-hybrid/mguk-regen-gain-increase.svg";
import z from "zod";

type SetupHybridSetting =
  | "mguk-regen-gain"
  | "mguk-deploy-mode"
  | "mguk-fixed-deploy"
  | "hys-boost"
  | "hys-regen"
  | "hys-no-boost";

type DirectionType = "increase" | "decrease";

/** Controls that have +/- direction */
const DIRECTIONAL_CONTROLS: Set<SetupHybridSetting> = new Set([
  "mguk-regen-gain",
  "mguk-deploy-mode",
  "mguk-fixed-deploy",
]);

/** Controls that use long-press hold behavior */
const HOLD_CONTROLS: Set<SetupHybridSetting> = new Set(["hys-boost", "hys-regen"]);

/**
 * Flat icon lookup record mapping setting + direction keys to standalone SVG templates.
 */
const SETUP_HYBRID_ICONS: Record<string, string> = {
  "mguk-regen-gain-increase": mgukRegenGainIncreaseIconSvg,
  "mguk-regen-gain-decrease": mgukRegenGainDecreaseIconSvg,
  "mguk-deploy-mode-increase": mgukDeployModeIncreaseIconSvg,
  "mguk-deploy-mode-decrease": mgukDeployModeDecreaseIconSvg,
  "mguk-fixed-deploy-increase": mgukFixedDeployIncreaseIconSvg,
  "mguk-fixed-deploy-decrease": mgukFixedDeployDecreaseIconSvg,
  "hys-boost": hysBoostIconSvg,
  "hys-regen": hysRegenIconSvg,
  "hys-no-boost": hysNoBoostIconSvg,
};

/**
 * Label configuration for each setting + direction combination.
 */
const SETUP_HYBRID_LABELS: Record<string, { mainLabel: string; subLabel: string }> = {
  "mguk-regen-gain-increase": { mainLabel: "REGEN GAIN", subLabel: "INCREASE" },
  "mguk-regen-gain-decrease": { mainLabel: "REGEN GAIN", subLabel: "DECREASE" },
  "mguk-deploy-mode-increase": { mainLabel: "DEPLOY MODE", subLabel: "INCREASE" },
  "mguk-deploy-mode-decrease": { mainLabel: "DEPLOY MODE", subLabel: "DECREASE" },
  "mguk-fixed-deploy-increase": { mainLabel: "FIXED DEPLOY", subLabel: "INCREASE" },
  "mguk-fixed-deploy-decrease": { mainLabel: "FIXED DEPLOY", subLabel: "DECREASE" },
  "hys-boost": { mainLabel: "HYS", subLabel: "BOOST" },
  "hys-regen": { mainLabel: "HYS", subLabel: "REGEN" },
  "hys-no-boost": { mainLabel: "HYS", subLabel: "NO BOOST" },
};

/**
 * @internal Exported for testing
 *
 * Mapping from setting + direction to global settings keys.
 * Directional controls use composite keys (e.g., "mguk-regen-gain-increase").
 */
export const SETUP_HYBRID_GLOBAL_KEYS: Record<string, string> = {
  "mguk-regen-gain-increase": "setupHybridMgukRegenGainIncrease",
  "mguk-regen-gain-decrease": "setupHybridMgukRegenGainDecrease",
  "mguk-deploy-mode-increase": "setupHybridMgukDeployModeIncrease",
  "mguk-deploy-mode-decrease": "setupHybridMgukDeployModeDecrease",
  "mguk-fixed-deploy-increase": "setupHybridMgukFixedDeployIncrease",
  "mguk-fixed-deploy-decrease": "setupHybridMgukFixedDeployDecrease",
  "hys-boost": "setupHybridHysBoost",
  "hys-regen": "setupHybridHysRegen",
  "hys-no-boost": "setupHybridHysNoBoost",
};

const SetupHybridSettings = CommonSettings.extend({
  setting: z
    .enum([
      "mguk-regen-gain",
      "mguk-deploy-mode",
      "mguk-fixed-deploy",
      "hys-boost",
      "hys-regen",
      "hys-no-boost",
    ])
    .default("mguk-regen-gain"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type SetupHybridSettings = z.infer<typeof SetupHybridSettings>;

/**
 * Resolves the flat icon lookup key from setting and direction.
 */
function resolveIconKey(setting: SetupHybridSetting, direction: DirectionType): string {
  if (DIRECTIONAL_CONTROLS.has(setting)) {
    return `${setting}-${direction}`;
  }

  return setting;
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup hybrid action.
 */
export function generateSetupHybridSvg(settings: SetupHybridSettings): string {
  const iconKey = resolveIconKey(settings.setting, settings.direction);

  const iconSvg = SETUP_HYBRID_ICONS[iconKey] || SETUP_HYBRID_ICONS["hys-boost"];
  const labels = SETUP_HYBRID_LABELS[iconKey] || { mainLabel: "HYBRID", subLabel: "SETUP" };

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Setup Hybrid Action
 * Provides hybrid/ERS system adjustments (MGU-K regen gain, deploy modes,
 * HYS boost/regen) via keyboard shortcuts.
 * Supports three behavior types: directional tap, long-press hold, and toggle.
 */
export const SETUP_HYBRID_UUID = "com.iracedeck.sd.core.setup-hybrid" as const;

export class SetupHybrid extends ConnectionStateAwareAction<SetupHybridSettings> {
  /** Currently held key combinations per action context, tracked for cleanup on release/disappear */
  private heldCombinations = new Map<string, KeyCombination>();

  override async onWillAppear(ev: IDeckWillAppearEvent<SetupHybridSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SetupHybridSettings>): Promise<void> {
    await this.releaseHeldKey(ev.action.id);
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SetupHybridSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<SetupHybridSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (HOLD_CONTROLS.has(settings.setting)) {
      await this.pressHold(ev.action.id, settings.setting);
    } else {
      await this.executeTap(settings.setting, settings.direction);
    }
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<SetupHybridSettings>): Promise<void> {
    this.logger.info("Key up received");
    await this.releaseHeldKey(ev.action.id);
  }

  override async onDialDown(ev: IDeckDialDownEvent<SetupHybridSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (HOLD_CONTROLS.has(settings.setting)) {
      await this.pressHold(ev.action.id, settings.setting);
    } else {
      await this.executeTap(settings.setting, settings.direction);
    }
  }

  override async onDialUp(ev: IDeckDialUpEvent<SetupHybridSettings>): Promise<void> {
    this.logger.info("Dial up received");
    await this.releaseHeldKey(ev.action.id);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<SetupHybridSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);

    if (!DIRECTIONAL_CONTROLS.has(settings.setting)) {
      this.logger.debug(`Rotation ignored for ${settings.setting}`);

      return;
    }

    const direction: DirectionType = ev.payload.ticks > 0 ? "increase" : "decrease";
    await this.executeTap(settings.setting, direction);
  }

  private parseSettings(settings: unknown): SetupHybridSettings {
    const parsed = SetupHybridSettings.safeParse(settings);

    return parsed.success ? parsed.data : SetupHybridSettings.parse({});
  }

  private resolveGlobalKey(setting: SetupHybridSetting, direction: DirectionType): string | null {
    if (DIRECTIONAL_CONTROLS.has(setting)) {
      const key = `${setting}-${direction}`;

      return SETUP_HYBRID_GLOBAL_KEYS[key] ?? null;
    }

    return SETUP_HYBRID_GLOBAL_KEYS[setting] ?? null;
  }

  private resolveCombination(
    setting: SetupHybridSetting,
    direction: DirectionType,
  ): { combination: KeyCombination; binding: KeyBindingValue } | null {
    const settingKey = this.resolveGlobalKey(setting, direction);

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${setting} ${direction}`);

      return null;
    }

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return null;
    }

    this.logger.debug(`Key binding for ${settingKey}: ${formatKeyBinding(binding)} (code=${binding.code ?? "none"})`);

    return {
      combination: {
        key: binding.key as KeyboardKey,
        modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
        code: binding.code,
      },
      binding,
    };
  }

  private async executeTap(setting: SetupHybridSetting, direction: DirectionType): Promise<void> {
    this.logger.info("Setting executed");
    this.logger.debug(`Executing tap ${setting} ${direction}`);

    const resolved = this.resolveCombination(setting, direction);

    if (!resolved) {
      return;
    }

    await this.sendKeyBinding(resolved.binding, resolved.combination);
  }

  private async pressHold(actionId: string, setting: SetupHybridSetting): Promise<void> {
    this.logger.debug(`Pressing hold for ${setting}`);

    const resolved = this.resolveCombination(setting, "increase");

    if (!resolved) {
      return;
    }

    const success = await getKeyboard().pressKeyCombination(resolved.combination);

    if (success) {
      this.heldCombinations.set(actionId, resolved.combination);
      this.logger.info("Key pressed (holding)");
      this.logger.debug(`Key combination: ${formatKeyBinding(resolved.binding)}`);
    } else {
      this.logger.warn("Failed to press key");
    }
  }

  private async releaseHeldKey(actionId: string): Promise<void> {
    const combination = this.heldCombinations.get(actionId);

    if (!combination) {
      return;
    }

    this.heldCombinations.delete(actionId);

    const success = await getKeyboard().releaseKeyCombination(combination);

    if (success) {
      this.logger.info("Key released");
    } else {
      this.logger.warn("Failed to release key");
    }
  }

  private async sendKeyBinding(binding: KeyBindingValue, combination: KeyCombination): Promise<void> {
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
    ev: IDeckWillAppearEvent<SetupHybridSettings> | IDeckDidReceiveSettingsEvent<SetupHybridSettings>,
    settings: SetupHybridSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateSetupHybridSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateSetupHybridSvg(settings));
  }
}
