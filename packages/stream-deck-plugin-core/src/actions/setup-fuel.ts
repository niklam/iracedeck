import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
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
} from "@iracedeck/stream-deck-shared";
import z from "zod";

import setupFuelTemplate from "../../icons/setup-fuel.svg";

const WHITE = "#ffffff";
const GRAY = "#888888";
const YELLOW = "#f1c40f";
const GREEN = "#2ecc71";
const RED = "#e74c3c";

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
 * Label configuration for each setting + direction combination.
 * Standard layout: line1 = primary (bold, top), line2 = secondary (subdued, bottom).
 */
const SETUP_FUEL_LABELS: Record<
  SetupFuelSetting,
  Record<DirectionType, { line1: string; line2: string }> | { line1: string; line2: string }
> = {
  "fuel-mixture": {
    increase: { line1: "FUEL MIX", line2: "INCREASE" },
    decrease: { line1: "FUEL MIX", line2: "DECREASE" },
  },
  "fuel-cut-position": {
    increase: { line1: "FUEL CUT", line2: "INCREASE" },
    decrease: { line1: "FUEL CUT", line2: "DECREASE" },
  },
  "disable-fuel-cut": { line1: "FUEL CUT", line2: "DISABLE" },
  "low-fuel-accept": { line1: "LOW FUEL", line2: "ACCEPT" },
  "fcy-mode-toggle": { line1: "FCY MODE", line2: "TOGGLE" },
};

/**
 * SVG icon content for each setting.
 * Non-directional controls have a single icon; directional controls have per-direction variants.
 */
const SETUP_FUEL_ICONS: Record<SetupFuelSetting, Record<DirectionType, string> | string> = {
  // Fuel Mixture: Fuel droplet with fill level indicator + directional arrow
  "fuel-mixture": {
    increase: `
    <path d="M30 10 C30 10 20 22 20 28 C20 34 24 38 30 38 C36 38 40 34 40 28 C40 22 30 10 30 10Z"
          fill="none" stroke="${WHITE}" stroke-width="2"/>
    <path d="M23 30 Q30 26 37 30" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <path d="M30 10 C30 10 20 22 20 28 C20 34 24 38 30 38 C36 38 40 34 40 28 C40 22 30 10 30 10Z"
          fill="none" stroke="${WHITE}" stroke-width="2"/>
    <path d="M23 30 Q30 26 37 30" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="19,16 14,22 19,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Fuel Cut Position: Fuel droplet with horizontal dashed cut line + directional arrow
  "fuel-cut-position": {
    increase: `
    <path d="M30 10 C30 10 20 22 20 28 C20 34 24 38 30 38 C36 38 40 34 40 28 C40 22 30 10 30 10Z"
          fill="none" stroke="${WHITE}" stroke-width="2"/>
    <line x1="18" y1="26" x2="42" y2="26" stroke="${RED}" stroke-width="1.5" stroke-dasharray="3,2" stroke-linecap="round"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <path d="M30 10 C30 10 20 22 20 28 C20 34 24 38 30 38 C36 38 40 34 40 28 C40 22 30 10 30 10Z"
          fill="none" stroke="${WHITE}" stroke-width="2"/>
    <line x1="18" y1="26" x2="42" y2="26" stroke="${RED}" stroke-width="1.5" stroke-dasharray="3,2" stroke-linecap="round"/>
    <polyline points="19,16 14,22 19,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Disable Fuel Cut: Fuel droplet with X overlay in red
  "disable-fuel-cut": `
    <path d="M36 10 C36 10 26 22 26 28 C26 34 30 38 36 38 C42 38 46 34 46 28 C46 22 36 10 36 10Z"
          fill="none" stroke="${WHITE}" stroke-width="2"/>
    <line x1="29" y1="20" x2="43" y2="36" stroke="${RED}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="43" y1="20" x2="29" y2="36" stroke="${RED}" stroke-width="2.5" stroke-linecap="round"/>`,

  // Low Fuel Accept: Small fuel droplet with checkmark in green
  "low-fuel-accept": `
    <path d="M32 12 C32 12 24 22 24 27 C24 32 27 35 32 35 C37 35 40 32 40 27 C40 22 32 12 32 12Z"
          fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <path d="M23 30 Q32 27 39 30" fill="none" stroke="${GRAY}" stroke-width="1" stroke-linecap="round"/>
    <polyline points="40,20 45,28 55,14" fill="none" stroke="${GREEN}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,

  // FCY Mode Toggle: Caution triangle with exclamation mark in yellow
  "fcy-mode-toggle": `
    <path d="M36 10 L52 38 L20 38 Z" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linejoin="round"/>
    <line x1="36" y1="18" x2="36" y2="30" stroke="${YELLOW}" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="36" cy="34" r="1.5" fill="${YELLOW}"/>`,
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

const SetupFuelSettings = z.object({
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

  const iconEntry = SETUP_FUEL_ICONS[setting];
  const iconContent =
    typeof iconEntry === "string" ? iconEntry : (iconEntry?.[direction] ?? SETUP_FUEL_ICONS["disable-fuel-cut"]);

  const labelEntry = SETUP_FUEL_LABELS[setting];
  const labels: { line1: string; line2: string } =
    "line1" in labelEntry ? labelEntry : (labelEntry[direction] ?? { line1: "FUEL", line2: "SETUP" });

  const svg = renderIconTemplate(setupFuelTemplate, {
    iconContent: iconContent as string,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Setup Fuel Action
 * Provides fuel-related in-car adjustments (fuel mixture, fuel cut position,
 * disable fuel cut, low fuel accept, FCY mode) via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.setup-fuel" })
export class SetupFuel extends ConnectionStateAwareAction<SetupFuelSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("SetupFuel"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<SetupFuelSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<SetupFuelSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SetupFuelSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<SetupFuelSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialDown(ev: DialDownEvent<SetupFuelSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeSetting(settings.setting, settings.direction);
  }

  override async onDialRotate(ev: DialRotateEvent<SetupFuelSettings>): Promise<void> {
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
    ev: WillAppearEvent<SetupFuelSettings> | DidReceiveSettingsEvent<SetupFuelSettings>,
    settings: SetupFuelSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateSetupFuelSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
