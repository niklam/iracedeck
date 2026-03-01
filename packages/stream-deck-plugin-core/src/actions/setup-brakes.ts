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

import setupBrakesTemplate from "../../icons/setup-brakes.svg";
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
const YELLOW = "#f1c40f";
const RED = "#e74c3c";

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
 * Label configuration for each setting + direction combination.
 * Standard layout: line1 = primary (bold, top), line2 = secondary (subdued, bottom).
 */
const SETUP_BRAKES_LABELS: Record<
  SetupBrakesSetting,
  Record<DirectionType, { line1: string; line2: string }> | { line1: string; line2: string }
> = {
  "abs-toggle": { line1: "ABS", line2: "TOGGLE" },
  "abs-adjust": {
    increase: { line1: "ABS", line2: "INCREASE" },
    decrease: { line1: "ABS", line2: "DECREASE" },
  },
  "brake-bias": {
    increase: { line1: "BRAKE BIAS", line2: "INCREASE" },
    decrease: { line1: "BRAKE BIAS", line2: "DECREASE" },
  },
  "brake-bias-fine": {
    increase: { line1: "BIAS FINE", line2: "INCREASE" },
    decrease: { line1: "BIAS FINE", line2: "DECREASE" },
  },
  "peak-brake-bias": {
    increase: { line1: "PEAK BIAS", line2: "INCREASE" },
    decrease: { line1: "PEAK BIAS", line2: "DECREASE" },
  },
  "brake-misc": {
    increase: { line1: "BRAKE MISC", line2: "INCREASE" },
    decrease: { line1: "BRAKE MISC", line2: "DECREASE" },
  },
  "engine-braking": {
    increase: { line1: "ENG BRAKE", line2: "INCREASE" },
    decrease: { line1: "ENG BRAKE", line2: "DECREASE" },
  },
};

/**
 * SVG icon content for each setting.
 * Non-directional controls have a single icon; directional controls have per-direction variants.
 */
const SETUP_BRAKES_ICONS: Record<SetupBrakesSetting, Record<DirectionType, string> | string> = {
  // ABS Toggle: Brake disc circle with "ABS" text badge inside
  "abs-toggle": `
    <circle cx="36" cy="24" r="14" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <circle cx="36" cy="24" r="7" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <text x="36" y="25" text-anchor="middle" dominant-baseline="central"
          fill="${RED}" font-family="Arial, sans-serif" font-size="8" font-weight="bold">ABS</text>`,

  // ABS Adjust: Brake disc with "ABS" + small up/down arrow indicator
  "abs-adjust": {
    increase: `
    <circle cx="34" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="34" cy="24" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <text x="34" y="25" text-anchor="middle" dominant-baseline="central"
          fill="${RED}" font-family="Arial, sans-serif" font-size="7" font-weight="bold">ABS</text>
    <polyline points="54,22 58,16 62,22" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="34" cy="24" r="12" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="34" cy="24" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <text x="34" y="25" text-anchor="middle" dominant-baseline="central"
          fill="${RED}" font-family="Arial, sans-serif" font-size="7" font-weight="bold">ABS</text>
    <polyline points="54,16 58,22 62,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Brake Bias: Horizontal bar showing front/rear balance split + arrow
  "brake-bias": {
    increase: `
    <rect x="14" y="20" width="44" height="10" rx="3" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <rect x="14" y="20" width="26" height="10" rx="3" fill="${RED}" opacity="0.6"/>
    <line x1="40" y1="18" x2="40" y2="32" stroke="${WHITE}" stroke-width="1.5"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="14" y="20" width="44" height="10" rx="3" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <rect x="14" y="20" width="26" height="10" rx="3" fill="${RED}" opacity="0.6"/>
    <line x1="40" y1="18" x2="40" y2="32" stroke="${WHITE}" stroke-width="1.5"/>
    <polyline points="19,16 14,22 19,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Brake Bias Fine: Similar to brake-bias but with finer graduated marks + arrow
  "brake-bias-fine": {
    increase: `
    <rect x="14" y="20" width="44" height="10" rx="3" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <rect x="14" y="20" width="26" height="10" rx="3" fill="${RED}" opacity="0.4"/>
    <line x1="40" y1="18" x2="40" y2="32" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="22" y1="20" x2="22" y2="30" stroke="${GRAY}" stroke-width="0.5"/>
    <line x1="30" y1="20" x2="30" y2="30" stroke="${GRAY}" stroke-width="0.5"/>
    <line x1="48" y1="20" x2="48" y2="30" stroke="${GRAY}" stroke-width="0.5"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="14" y="20" width="44" height="10" rx="3" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <rect x="14" y="20" width="26" height="10" rx="3" fill="${RED}" opacity="0.4"/>
    <line x1="40" y1="18" x2="40" y2="32" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="22" y1="20" x2="22" y2="30" stroke="${GRAY}" stroke-width="0.5"/>
    <line x1="30" y1="20" x2="30" y2="30" stroke="${GRAY}" stroke-width="0.5"/>
    <line x1="48" y1="20" x2="48" y2="30" stroke="${GRAY}" stroke-width="0.5"/>
    <polyline points="19,16 14,22 19,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Peak Brake Bias: Brake disc with peak marker line + arrow
  "peak-brake-bias": {
    increase: `
    <circle cx="32" cy="24" r="12" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <circle cx="32" cy="24" r="5" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="32" y1="12" x2="32" y2="18" stroke="${RED}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="32" cy="24" r="12" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <circle cx="32" cy="24" r="5" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="32" y1="12" x2="32" y2="18" stroke="${RED}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="19,16 14,22 19,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Brake Misc: Brake disc outline with wrench overlay + arrow
  "brake-misc": {
    increase: `
    <circle cx="30" cy="24" r="12" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <circle cx="30" cy="24" r="5" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="38" y1="16" x2="46" y2="32" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="42" y1="16" x2="50" y2="32" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="55,28 60,22 55,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <circle cx="30" cy="24" r="12" fill="none" stroke="${GRAY}" stroke-width="1.5"/>
    <circle cx="30" cy="24" r="5" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="38" y1="16" x2="46" y2="32" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="42" y1="16" x2="50" y2="32" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // Engine Braking: Engine block outline with brake symbol + arrow
  "engine-braking": {
    increase: `
    <rect x="18" y="14" width="24" height="20" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="22" y1="14" x2="22" y2="10" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="30" y1="14" x2="30" y2="10" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="38" y1="14" x2="38" y2="10" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="30" cy="24" r="4" fill="none" stroke="${RED}" stroke-width="1.5"/>
    <polyline points="53,28 58,22 53,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    decrease: `
    <rect x="18" y="14" width="24" height="20" rx="3" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="22" y1="14" x2="22" y2="10" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="30" y1="14" x2="30" y2="10" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="38" y1="14" x2="38" y2="10" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="30" cy="24" r="4" fill="none" stroke="${RED}" stroke-width="1.5"/>
    <polyline points="17,16 12,22 17,28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
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

const SetupBrakesSettings = z.object({
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
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the setup brakes action.
 */
export function generateSetupBrakesSvg(settings: SetupBrakesSettings): string {
  const { setting, direction } = settings;

  const iconEntry = SETUP_BRAKES_ICONS[setting];
  const iconContent =
    typeof iconEntry === "string" ? iconEntry : (iconEntry?.[direction] ?? SETUP_BRAKES_ICONS["abs-toggle"]);

  const labelEntry = SETUP_BRAKES_LABELS[setting];
  const labels: { line1: string; line2: string } =
    "line1" in labelEntry ? labelEntry : (labelEntry[direction] ?? { line1: "BRAKE", line2: "SETUP" });

  const svg = renderIconTemplate(setupBrakesTemplate, {
    iconContent: iconContent as string,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
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
