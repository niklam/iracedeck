import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DialUpEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  KeyUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import z from "zod";

import setupHybridTemplate from "../../icons/setup-hybrid.svg";
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

const WHITE = "#ffffff";
const GRAY = "#888888";
const GREEN = "#2ecc71";

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
 * Label configuration for each setting + direction combination.
 * Standard layout: line1 = primary (bold, top), line2 = secondary (subdued, bottom).
 */
const SETUP_HYBRID_LABELS: Record<
  SetupHybridSetting,
  Record<DirectionType, { line1: string; line2: string }> | { line1: string; line2: string }
> = {
  "mguk-regen-gain": {
    increase: { line1: "REGEN GAIN", line2: "INCREASE" },
    decrease: { line1: "REGEN GAIN", line2: "DECREASE" },
  },
  "mguk-deploy-mode": {
    increase: { line1: "DEPLOY MODE", line2: "INCREASE" },
    decrease: { line1: "DEPLOY MODE", line2: "DECREASE" },
  },
  "mguk-fixed-deploy": {
    increase: { line1: "FIXED DEPLOY", line2: "INCREASE" },
    decrease: { line1: "FIXED DEPLOY", line2: "DECREASE" },
  },
  "hys-boost": { line1: "HYS", line2: "BOOST" },
  "hys-regen": { line1: "HYS", line2: "REGEN" },
  "hys-no-boost": { line1: "HYS", line2: "NO BOOST" },
};

/**
 * SVG icon content for each setting.
 * Non-directional controls have a single icon; directional controls have per-direction variants.
 */
const SETUP_HYBRID_ICONS: Record<SetupHybridSetting, Record<DirectionType, string> | string> = {
  // MGU-K Re-Gen Gain: Battery with regen lightning bolt + directional arrow
  "mguk-regen-gain": {
    increase: `
    <rect x="16" y="14" width="26" height="16" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="42" y="19" width="3" height="6" rx="1" fill="${WHITE}"/>
    <polyline points="27,17 30,22 27,22 30,27" fill="none" stroke="${GREEN}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="16" y="14" width="26" height="16" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="42" y="19" width="3" height="6" rx="1" fill="${WHITE}"/>
    <polyline points="27,17 30,22 27,22 30,27" fill="none" stroke="${GREEN}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // MGU-K Deploy Mode: Battery with outgoing deploy arrows + directional arrow
  "mguk-deploy-mode": {
    increase: `
    <rect x="16" y="14" width="26" height="16" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="42" y="19" width="3" height="6" rx="1" fill="${WHITE}"/>
    <line x1="24" y1="22" x2="35" y2="22" stroke="${GREEN}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="32,19 35,22 32,25" fill="none" stroke="${GREEN}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="16" y="14" width="26" height="16" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="42" y="19" width="3" height="6" rx="1" fill="${WHITE}"/>
    <line x1="24" y1="22" x2="35" y2="22" stroke="${GREEN}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="32,19 35,22 32,25" fill="none" stroke="${GREEN}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // MGU-K Fixed Deploy: Battery with horizontal bar gauge + directional arrow
  "mguk-fixed-deploy": {
    increase: `
    <rect x="16" y="14" width="26" height="16" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="42" y="19" width="3" height="6" rx="1" fill="${WHITE}"/>
    <rect x="20" y="20" width="14" height="4" rx="1" fill="${GREEN}" opacity="0.6"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="16" y="14" width="26" height="16" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="42" y="19" width="3" height="6" rx="1" fill="${WHITE}"/>
    <rect x="20" y="20" width="14" height="4" rx="1" fill="${GREEN}" opacity="0.6"/>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // HYS Boost: Battery with upward power burst
  "hys-boost": `
    <rect x="20" y="14" width="26" height="16" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="46" y="19" width="3" height="6" rx="1" fill="${WHITE}"/>
    <polyline points="31,27 33,21 31,21 33,14" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="29,12 33,9 37,12" fill="none" stroke="${GREEN}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,

  // HYS Regen: Battery with downward arrow into battery
  "hys-regen": `
    <rect x="20" y="14" width="26" height="16" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="46" y="19" width="3" height="6" rx="1" fill="${WHITE}"/>
    <line x1="33" y1="10" x2="33" y2="26" stroke="${GREEN}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="30,23 33,26 36,23" fill="none" stroke="${GREEN}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,

  // HYS No Boost: Battery with X/slash
  "hys-no-boost": `
    <rect x="20" y="14" width="26" height="16" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="46" y="19" width="3" height="6" rx="1" fill="${WHITE}"/>
    <line x1="27" y1="18" x2="39" y2="26" stroke="${GRAY}" stroke-width="2" stroke-linecap="round"/>
    <line x1="39" y1="18" x2="27" y2="26" stroke="${GRAY}" stroke-width="2" stroke-linecap="round"/>`,
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

const SetupHybridSettings = z.object({
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
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup hybrid action.
 */
export function generateSetupHybridSvg(settings: SetupHybridSettings): string {
  const { setting, direction } = settings;

  const iconEntry = SETUP_HYBRID_ICONS[setting];
  const iconContent =
    typeof iconEntry === "string" ? iconEntry : (iconEntry?.[direction] ?? SETUP_HYBRID_ICONS["hys-boost"]);

  const labelEntry = SETUP_HYBRID_LABELS[setting];
  const labels: { line1: string; line2: string } =
    "line1" in labelEntry ? labelEntry : (labelEntry[direction] ?? { line1: "HYBRID", line2: "SETUP" });

  const svg = renderIconTemplate(setupHybridTemplate, {
    iconContent: iconContent as string,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Setup Hybrid Action
 * Provides hybrid/ERS system adjustments (MGU-K regen gain, deploy modes,
 * HYS boost/regen) via keyboard shortcuts.
 * Supports three behavior types: directional tap, long-press hold, and toggle.
 */
@action({ UUID: "com.iracedeck.sd.core.setup-hybrid" })
export class SetupHybrid extends ConnectionStateAwareAction<SetupHybridSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("SetupHybrid"), LogLevel.Info);

  /** Currently held key combinations per action context, tracked for cleanup on release/disappear */
  private heldCombinations = new Map<string, KeyCombination>();

  override async onWillAppear(ev: WillAppearEvent<SetupHybridSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<SetupHybridSettings>): Promise<void> {
    await this.releaseHeldKey(ev.action.id);
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SetupHybridSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<SetupHybridSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (HOLD_CONTROLS.has(settings.setting)) {
      await this.pressHold(ev.action.id, settings.setting);
    } else {
      await this.executeTap(settings.setting, settings.direction);
    }
  }

  override async onKeyUp(ev: KeyUpEvent<SetupHybridSettings>): Promise<void> {
    this.logger.info("Key up received");
    await this.releaseHeldKey(ev.action.id);
  }

  override async onDialDown(ev: DialDownEvent<SetupHybridSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (HOLD_CONTROLS.has(settings.setting)) {
      await this.pressHold(ev.action.id, settings.setting);
    } else {
      await this.executeTap(settings.setting, settings.direction);
    }
  }

  override async onDialUp(ev: DialUpEvent<SetupHybridSettings>): Promise<void> {
    this.logger.info("Dial up received");
    await this.releaseHeldKey(ev.action.id);
  }

  override async onDialRotate(ev: DialRotateEvent<SetupHybridSettings>): Promise<void> {
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
    ev: WillAppearEvent<SetupHybridSettings> | DidReceiveSettingsEvent<SetupHybridSettings>,
    settings: SetupHybridSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateSetupHybridSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
