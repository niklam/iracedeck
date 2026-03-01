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

import fuelServiceTemplate from "../../icons/fuel-service.svg";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  getCommands,
  getGlobalSettings,
  getKeyboard,
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
const GREEN = "#2ecc71";

type FuelServiceMode =
  | "add-fuel"
  | "reduce-fuel"
  | "set-fuel-amount"
  | "clear-fuel"
  | "toggle-autofuel"
  | "lap-margin-increase"
  | "lap-margin-decrease";

/**
 * Display labels for fuel unit setting values
 */
const UNIT_DISPLAY: Record<FuelUnit, string> = {
  l: "L",
  g: "GAL",
  k: "KG",
};

/**
 * Label configuration for each fuel service mode.
 * Uses inverted layout: line1 = bold/bottom (primary), line2 = subdued/top (secondary).
 * Fuel macro modes (add-fuel, reduce-fuel, set-fuel-amount) use dynamic labels computed in getFuelServiceLabels().
 */
const FUEL_SERVICE_LABELS: Record<FuelServiceMode, { line1: string; line2: string }> = {
  "add-fuel": { line1: "+1 L", line2: "ADD FUEL" },
  "reduce-fuel": { line1: "-1 L", line2: "REDUCE FUEL" },
  "set-fuel-amount": { line1: "1 L", line2: "SET FUEL" },
  "clear-fuel": { line1: "CLEAR", line2: "FUEL" },
  "toggle-autofuel": { line1: "TOGGLE", line2: "AUTOFUEL" },
  "lap-margin-increase": { line1: "INCREASE", line2: "LAP MARGIN" },
  "lap-margin-decrease": { line1: "DECREASE", line2: "LAP MARGIN" },
};

/**
 * SVG icon content for each fuel service mode
 */
const FUEL_SERVICE_ICONS: Record<FuelServiceMode, string> = {
  // Add Fuel: Gas pump with + indicator (green)
  "add-fuel": `
    <rect x="24" y="10" width="16" height="24" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="28" y="6" width="8" height="6" rx="1" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <path d="M40 14 L44 14 L44 28 L40 28" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="52" y1="18" x2="52" y2="30" stroke="${GREEN}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="46" y1="24" x2="58" y2="24" stroke="${GREEN}" stroke-width="2.5" stroke-linecap="round"/>`,

  // Reduce Fuel: Gas pump with - indicator (red)
  "reduce-fuel": `
    <rect x="24" y="10" width="16" height="24" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="28" y="6" width="8" height="6" rx="1" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <path d="M40 14 L44 14 L44 28 L40 28" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="46" y1="24" x2="58" y2="24" stroke="#e74c3c" stroke-width="2.5" stroke-linecap="round"/>`,

  // Set Fuel Amount: Gas pump with = indicator (yellow)
  "set-fuel-amount": `
    <rect x="24" y="10" width="16" height="24" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="28" y="6" width="8" height="6" rx="1" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <path d="M40 14 L44 14 L44 28 L40 28" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="48" y1="20" x2="56" y2="20" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round"/>
    <line x1="48" y1="26" x2="56" y2="26" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round"/>`,

  // Clear Fuel: Gas pump with X overlay (red)
  "clear-fuel": `
    <rect x="24" y="10" width="16" height="24" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="28" y="6" width="8" height="6" rx="1" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <path d="M40 14 L44 14 L44 28 L40 28" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="48" y1="18" x2="58" y2="30" stroke="#e74c3c" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="58" y1="18" x2="48" y2="30" stroke="#e74c3c" stroke-width="2.5" stroke-linecap="round"/>`,

  // Toggle Autofuel: Gas pump with circular auto/recycle arrow
  "toggle-autofuel": `
    <rect x="20" y="10" width="16" height="24" rx="2" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <rect x="24" y="6" width="8" height="6" rx="1" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <path d="M36 14 L40 14 L40 28 L36 28" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M50 14 A8 8 0 1 1 50 30" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="50,10 50,14 54,14" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,

  // Lap Margin Increase: Checkered flag with up arrow (green)
  "lap-margin-increase": `
    <path d="M18 14 L36 14 L36 34 L18 34 Z" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="18" y1="14" x2="18" y2="38" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <rect x="22" y="18" width="5" height="4" fill="${GRAY}"/>
    <rect x="27" y="18" width="5" height="4" fill="${WHITE}"/>
    <rect x="22" y="26" width="5" height="4" fill="${WHITE}"/>
    <rect x="27" y="26" width="5" height="4" fill="${GRAY}"/>
    <polyline points="48,28 54,20 60,28" fill="none" stroke="${GREEN}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,

  // Lap Margin Decrease: Checkered flag with down arrow (green)
  "lap-margin-decrease": `
    <path d="M18 14 L36 14 L36 34 L18 34 Z" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <line x1="18" y1="14" x2="18" y2="38" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <rect x="22" y="18" width="5" height="4" fill="${GRAY}"/>
    <rect x="27" y="18" width="5" height="4" fill="${WHITE}"/>
    <rect x="22" y="26" width="5" height="4" fill="${WHITE}"/>
    <rect x="27" y="26" width="5" height="4" fill="${GRAY}"/>
    <polyline points="48,20 54,28 60,20" fill="none" stroke="${GREEN}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
};

/**
 * @internal Exported for testing
 *
 * Mapping from keyboard-based fuel service modes to global settings keys.
 * Chat macro modes (add-fuel, reduce-fuel, set-fuel-amount) and SDK mode (clear-fuel) are NOT included.
 */
export const FUEL_SERVICE_GLOBAL_KEYS: Record<string, string> = {
  "toggle-autofuel": "fuelServiceToggleAutofuel",
  "lap-margin-increase": "fuelServiceLapMarginIncrease",
  "lap-margin-decrease": "fuelServiceLapMarginDecrease",
};

const FuelUnit = z.enum(["l", "g", "k"]);
type FuelUnit = z.infer<typeof FuelUnit>;

const FuelServiceSettings = z.object({
  mode: z
    .enum([
      "add-fuel",
      "reduce-fuel",
      "set-fuel-amount",
      "clear-fuel",
      "toggle-autofuel",
      "lap-margin-increase",
      "lap-margin-decrease",
    ])
    .default("add-fuel"),
  amount: z.preprocess(
    (val) => (typeof val === "string" ? val.replace(",", ".") : val),
    z.coerce.number().min(0).default(1),
  ),
  unit: FuelUnit.default("l"),
});

type FuelServiceSettings = z.infer<typeof FuelServiceSettings>;

/**
 * @internal Exported for testing
 *
 * Builds a pit macro string for fuel operations.
 * Uses iRacing pit macro syntax: #fuel [[+|-]<amount>[l|g|k]]$
 * The $ suffix auto-executes without showing the chat window.
 */
export function buildFuelMacro(mode: FuelServiceMode, amount: number, unit: FuelUnit): string | null {
  const rounded = Math.round(amount * 10) / 10;

  switch (mode) {
    case "add-fuel":
      return `#fuel +${rounded}${unit}$`;
    case "reduce-fuel":
      return `#fuel -${rounded}${unit}$`;
    case "set-fuel-amount":
      return `#fuel ${rounded}${unit}$`;
    default:
      return null;
  }
}

/** Modes that support encoder rotation for +/- adjustments */
const ROTATABLE_MACRO_MODES = new Set<FuelServiceMode>(["add-fuel", "reduce-fuel"]);
const ROTATABLE_KEYBOARD_MODES = new Set<FuelServiceMode>(["lap-margin-increase", "lap-margin-decrease"]);

/** Determine the opposite mode for encoder rotation */
const ROTATION_PAIRS: Partial<Record<FuelServiceMode, FuelServiceMode>> = {
  "add-fuel": "reduce-fuel",
  "reduce-fuel": "add-fuel",
  "lap-margin-increase": "lap-margin-decrease",
  "lap-margin-decrease": "lap-margin-increase",
};

/**
 * @internal Exported for testing
 *
 * Returns display labels for a fuel service mode.
 * Fuel macro modes compute dynamic labels from amount/unit settings.
 */
export function getFuelServiceLabels(settings: FuelServiceSettings): { line1: string; line2: string } {
  const { mode, amount, unit } = settings;
  const rounded = Math.round(amount * 10) / 10;
  const unitLabel = UNIT_DISPLAY[unit];

  switch (mode) {
    case "add-fuel":
      return { line1: `+${rounded} ${unitLabel}`, line2: "ADD FUEL" };
    case "reduce-fuel":
      return { line1: `-${rounded} ${unitLabel}`, line2: "REDUCE FUEL" };
    case "set-fuel-amount":
      return { line1: `${rounded} ${unitLabel}`, line2: "SET FUEL" };
    default:
      return FUEL_SERVICE_LABELS[mode] || FUEL_SERVICE_LABELS["add-fuel"];
  }
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the fuel service action.
 */
export function generateFuelServiceSvg(settings: FuelServiceSettings): string {
  const { mode } = settings;

  const iconContent = FUEL_SERVICE_ICONS[mode] || FUEL_SERVICE_ICONS["add-fuel"];
  const labels = getFuelServiceLabels(settings);

  const svg = renderIconTemplate(fuelServiceTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Fuel Service Action
 * Provides fuel management for pit stops (add/reduce fuel, set amount, clear,
 * autofuel toggle, lap margin adjustments).
 * Fuel modes use pit macro chat commands; clear-fuel uses SDK; keyboard-based modes use global key bindings.
 */
@action({ UUID: "com.iracedeck.sd.core.fuel-service" })
export class FuelService extends ConnectionStateAwareAction<FuelServiceSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("FuelService"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<FuelServiceSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<FuelServiceSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<FuelServiceSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<FuelServiceSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeMode(settings.mode, settings);
  }

  override async onDialDown(ev: DialDownEvent<FuelServiceSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeMode(settings.mode, settings);
  }

  override async onDialRotate(ev: DialRotateEvent<FuelServiceSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);

    if (!ROTATABLE_MACRO_MODES.has(settings.mode) && !ROTATABLE_KEYBOARD_MODES.has(settings.mode)) {
      this.logger.debug(`Rotation ignored for ${settings.mode}`);

      return;
    }

    // Clockwise (ticks > 0) = current mode, counter-clockwise = opposite mode
    const effectiveMode = ev.payload.ticks > 0 ? settings.mode : (ROTATION_PAIRS[settings.mode] ?? settings.mode);

    await this.executeMode(effectiveMode, settings);
  }

  private parseSettings(settings: unknown): FuelServiceSettings {
    const parsed = FuelServiceSettings.safeParse(settings);

    return parsed.success ? parsed.data : FuelServiceSettings.parse({});
  }

  private async executeMode(mode: FuelServiceMode, settings: FuelServiceSettings): Promise<void> {
    switch (mode) {
      // Chat macro-based modes
      case "add-fuel":
      case "reduce-fuel":
      case "set-fuel-amount":
        this.executeFuelMacro(mode, settings);
        break;

      // SDK-based mode
      case "clear-fuel":
        this.executeSdkClearFuel();
        break;

      // Keyboard-based modes
      case "toggle-autofuel":
      case "lap-margin-increase":
      case "lap-margin-decrease":
        await this.executeKeyboardMode(mode);
        break;
    }
  }

  private executeFuelMacro(mode: FuelServiceMode, settings: FuelServiceSettings): void {
    const macro = buildFuelMacro(mode, settings.amount, settings.unit);

    if (!macro) {
      this.logger.warn(`No macro for mode: ${mode}`);

      return;
    }

    this.logger.debug(`Sending fuel macro: ${macro}`);
    const success = getCommands().chat.sendMessage(macro);

    if (success) {
      this.logger.info("Fuel macro sent");
      this.logger.debug(`Macro: ${macro}`);
    } else {
      this.logger.warn("Failed to send fuel macro");
      this.logger.debug(`Failed macro: ${macro}`);
    }
  }

  private executeSdkClearFuel(): void {
    const pit = getCommands().pit;
    const success = pit.clearFuel();
    this.logger.info("Clear fuel checkbox executed");
    this.logger.debug(`Result: ${success}`);
  }

  private async executeKeyboardMode(mode: FuelServiceMode): Promise<void> {
    const settingKey = FUEL_SERVICE_GLOBAL_KEYS[mode];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for mode: ${mode}`);

      return;
    }

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return;
    }

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
    ev: WillAppearEvent<FuelServiceSettings> | DidReceiveSettingsEvent<FuelServiceSettings>,
    settings: FuelServiceSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateFuelServiceSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
