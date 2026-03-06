import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import z from "zod";

import setupTractionTemplate from "../../icons/setup-traction.svg";
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
 * Label configuration for each setting + direction combination.
 * Standard layout: line1 = primary (bold, top), line2 = secondary (subdued, bottom).
 */
const SETUP_TRACTION_LABELS: Record<
  SetupTractionSetting,
  Record<DirectionType, { line1: string; line2: string }> | { line1: string; line2: string }
> = {
  "tc-toggle": { line1: "TC", line2: "TOGGLE" },
  "tc-slot-1": {
    increase: { line1: "TC SLOT 1", line2: "INCREASE" },
    decrease: { line1: "TC SLOT 1", line2: "DECREASE" },
  },
  "tc-slot-2": {
    increase: { line1: "TC SLOT 2", line2: "INCREASE" },
    decrease: { line1: "TC SLOT 2", line2: "DECREASE" },
  },
  "tc-slot-3": {
    increase: { line1: "TC SLOT 3", line2: "INCREASE" },
    decrease: { line1: "TC SLOT 3", line2: "DECREASE" },
  },
  "tc-slot-4": {
    increase: { line1: "TC SLOT 4", line2: "INCREASE" },
    decrease: { line1: "TC SLOT 4", line2: "DECREASE" },
  },
};

/**
 * SVG icon content for each setting.
 * Non-directional controls have a single icon; directional controls have per-direction variants.
 */
const SETUP_TRACTION_ICONS: Record<SetupTractionSetting, Record<DirectionType, string> | string> = {
  // TC Toggle: tire circle with "TC" text badge (no arrow)
  "tc-toggle": `
    <circle cx="36" cy="24" r="14" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="36" cy="24" r="7" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <text x="36" y="25" text-anchor="middle" dominant-baseline="central"
          fill="${GREEN}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">TC</text>`,

  // TC Slot 1: tire circle with "1" label + directional arrow
  "tc-slot-1": {
    increase: `
    <circle cx="30" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="30" cy="24" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <text x="30" y="25" text-anchor="middle" dominant-baseline="central"
          fill="${GREEN}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">1</text>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="30" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="30" cy="24" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <text x="30" y="25" text-anchor="middle" dominant-baseline="central"
          fill="${GREEN}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">1</text>
    <polyline points="19,16 14,22 19,28" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // TC Slot 2: tire circle with "2" label + directional arrow
  "tc-slot-2": {
    increase: `
    <circle cx="30" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="30" cy="24" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <text x="30" y="25" text-anchor="middle" dominant-baseline="central"
          fill="${GREEN}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">2</text>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="30" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="30" cy="24" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <text x="30" y="25" text-anchor="middle" dominant-baseline="central"
          fill="${GREEN}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">2</text>
    <polyline points="19,16 14,22 19,28" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // TC Slot 3: tire circle with "3" label + directional arrow
  "tc-slot-3": {
    increase: `
    <circle cx="30" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="30" cy="24" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <text x="30" y="25" text-anchor="middle" dominant-baseline="central"
          fill="${GREEN}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">3</text>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="30" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="30" cy="24" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <text x="30" y="25" text-anchor="middle" dominant-baseline="central"
          fill="${GREEN}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">3</text>
    <polyline points="19,16 14,22 19,28" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // TC Slot 4: tire circle with "4" label + directional arrow
  "tc-slot-4": {
    increase: `
    <circle cx="30" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="30" cy="24" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <text x="30" y="25" text-anchor="middle" dominant-baseline="central"
          fill="${GREEN}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">4</text>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="30" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="30" cy="24" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <text x="30" y="25" text-anchor="middle" dominant-baseline="central"
          fill="${GREEN}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">4</text>
    <polyline points="19,16 14,22 19,28" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
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

const SetupTractionSettings = z.object({
  setting: z.enum(["tc-toggle", "tc-slot-1", "tc-slot-2", "tc-slot-3", "tc-slot-4"]).default("tc-toggle"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});

type SetupTractionSettings = z.infer<typeof SetupTractionSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup traction action.
 */
export function generateSetupTractionSvg(settings: SetupTractionSettings): string {
  const { setting, direction } = settings;

  const iconEntry = SETUP_TRACTION_ICONS[setting];
  const iconContent =
    typeof iconEntry === "string" ? iconEntry : (iconEntry?.[direction] ?? SETUP_TRACTION_ICONS["tc-toggle"]);

  const labelEntry = SETUP_TRACTION_LABELS[setting];
  const labels: { line1: string; line2: string } =
    "line1" in labelEntry ? labelEntry : (labelEntry[direction] ?? { line1: "TC", line2: "SETUP" });

  const svg = renderIconTemplate(setupTractionTemplate, {
    iconContent: iconContent as string,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
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
