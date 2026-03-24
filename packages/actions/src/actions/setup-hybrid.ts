import {
  CommonSettings,
  ConnectionStateAwareAction,
  getGlobalColors,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
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
  override async onWillAppear(ev: IDeckWillAppearEvent<SetupHybridSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const activeKey = this.resolveGlobalKey(settings.setting, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }

    await this.updateDisplay(ev, settings);
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SetupHybridSettings>): Promise<void> {
    await this.releaseBinding(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SetupHybridSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const activeKey = this.resolveGlobalKey(settings.setting, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<SetupHybridSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (HOLD_CONTROLS.has(settings.setting)) {
      const settingKey = this.resolveGlobalKey(settings.setting, "increase");

      if (settingKey) {
        await this.holdBinding(ev.action.id, settingKey);
      }
    } else {
      await this.executeTap(settings.setting, settings.direction);
    }
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<SetupHybridSettings>): Promise<void> {
    this.logger.info("Key up received");
    await this.releaseBinding(ev.action.id);
  }

  override async onDialDown(ev: IDeckDialDownEvent<SetupHybridSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (HOLD_CONTROLS.has(settings.setting)) {
      const settingKey = this.resolveGlobalKey(settings.setting, "increase");

      if (settingKey) {
        await this.holdBinding(ev.action.id, settingKey);
      }
    } else {
      await this.executeTap(settings.setting, settings.direction);
    }
  }

  override async onDialUp(ev: IDeckDialUpEvent<SetupHybridSettings>): Promise<void> {
    this.logger.info("Dial up received");
    await this.releaseBinding(ev.action.id);
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

  private async executeTap(setting: SetupHybridSetting, direction: DirectionType): Promise<void> {
    const settingKey = this.resolveGlobalKey(setting, direction);

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${setting} ${direction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<SetupHybridSettings> | IDeckDidReceiveSettingsEvent<SetupHybridSettings>,
    settings: SetupHybridSettings,
  ): Promise<void> {
    const svgDataUri = generateSetupHybridSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateSetupHybridSvg(settings));
  }
}
