import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import addFuelIcon from "@iracedeck/icons/fuel-service/add-fuel.svg";
import clearFuelIcon from "@iracedeck/icons/fuel-service/clear-fuel.svg";
import lapMarginDecreaseIcon from "@iracedeck/icons/fuel-service/lap-margin-decrease.svg";
import lapMarginIncreaseIcon from "@iracedeck/icons/fuel-service/lap-margin-increase.svg";
import reduceFuelIcon from "@iracedeck/icons/fuel-service/reduce-fuel.svg";
import setFuelAmountIcon from "@iracedeck/icons/fuel-service/set-fuel-amount.svg";
import toggleAutofuelIcon from "@iracedeck/icons/fuel-service/toggle-autofuel.svg";
import z from "zod";

import {
  CommonSettings,
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  getCommands,
  getGlobalColors,
  getGlobalSettings,
  getKeyboard,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  LogLevel,
  parseKeyBinding,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "../shared/index.js";

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
 * SVG templates for each fuel service mode (imported from @iracedeck/icons)
 */
const FUEL_SERVICE_ICONS: Record<FuelServiceMode, string> = {
  "add-fuel": addFuelIcon,
  "reduce-fuel": reduceFuelIcon,
  "set-fuel-amount": setFuelAmountIcon,
  "clear-fuel": clearFuelIcon,
  "toggle-autofuel": toggleAutofuelIcon,
  "lap-margin-increase": lapMarginIncreaseIcon,
  "lap-margin-decrease": lapMarginDecreaseIcon,
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

const FuelServiceSettings = CommonSettings.extend({
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

  const iconSvg = FUEL_SERVICE_ICONS[mode] || FUEL_SERVICE_ICONS["add-fuel"];
  const labels = getFuelServiceLabels(settings);

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.line1,
    subLabel: labels.line2,
    ...colors,
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
    await super.onWillAppear(ev);
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
    await super.onDidReceiveSettings(ev);
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
