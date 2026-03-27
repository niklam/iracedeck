import {
  CommonSettings,
  ConnectionStateAwareAction,
  fuelToDisplayUnits,
  getCommands,
  getGlobalColors,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "@iracedeck/deck-core";
import addFuelIcon from "@iracedeck/icons/fuel-service/add-fuel.svg";
import clearFuelIcon from "@iracedeck/icons/fuel-service/clear-fuel.svg";
import lapMarginDecreaseIcon from "@iracedeck/icons/fuel-service/lap-margin-decrease.svg";
import lapMarginIncreaseIcon from "@iracedeck/icons/fuel-service/lap-margin-increase.svg";
import reduceFuelIcon from "@iracedeck/icons/fuel-service/reduce-fuel.svg";
import setFuelAmountIcon from "@iracedeck/icons/fuel-service/set-fuel-amount.svg";
import toggleAutofuelIcon from "@iracedeck/icons/fuel-service/toggle-autofuel.svg";
import { hasFlag, PitSvFlags, type TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import fuelServiceTemplate from "../../icons/fuel-service.svg";
import { statusBarOff, statusBarOn } from "../icons/status-bar.js";

type FuelServiceMode =
  | "toggle-fuel-fill"
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
const FUEL_SERVICE_LABELS: Partial<Record<FuelServiceMode, { line1: string; line2: string }>> = {
  "add-fuel": { line1: "+1 L", line2: "ADD FUEL" },
  "reduce-fuel": { line1: "-1 L", line2: "REDUCE FUEL" },
  "set-fuel-amount": { line1: "1 L", line2: "SET FUEL" },
  "clear-fuel": { line1: "CLEAR", line2: "FUEL" },
  "toggle-autofuel": { line1: "TOGGLE", line2: "AUTOFUEL" },
  "lap-margin-increase": { line1: "INCREASE", line2: "LAP MARGIN" },
  "lap-margin-decrease": { line1: "DECREASE", line2: "LAP MARGIN" },
};

/**
 * Standalone SVG templates for static fuel service modes (imported from @iracedeck/icons).
 * Telemetry-aware modes (toggle-fuel-fill) use the dynamic template instead.
 */
const FUEL_SERVICE_ICONS: Partial<Record<FuelServiceMode, string>> = {
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
 * Chat macro modes (add-fuel, reduce-fuel, set-fuel-amount) and SDK modes (clear-fuel, toggle-fuel-fill) are NOT included.
 */
export const FUEL_SERVICE_GLOBAL_KEYS: Record<string, string> = {
  "toggle-autofuel": "fuelServiceToggleAutofuel",
  "lap-margin-increase": "fuelServiceLapMarginIncrease",
  "lap-margin-decrease": "fuelServiceLapMarginDecrease",
};

/**
 * Modes that use telemetry-driven dynamic icons.
 * Keep in sync with getTelemetryState() and buildStateKey().
 */
const TELEMETRY_AWARE_MODES = new Set<FuelServiceMode>(["toggle-fuel-fill"]);

const FuelUnit = z.enum(["l", "g", "k"]);
type FuelUnit = z.infer<typeof FuelUnit>;

const FuelServiceSettings = CommonSettings.extend({
  mode: z
    .enum([
      "toggle-fuel-fill",
      "add-fuel",
      "reduce-fuel",
      "set-fuel-amount",
      "clear-fuel",
      "toggle-autofuel",
      "lap-margin-increase",
      "lap-margin-decrease",
    ])
    .default("toggle-fuel-fill"),
  amount: z.preprocess(
    (val) => (typeof val === "string" ? val.replace(",", ".") : val),
    z.coerce.number().min(0).default(1),
  ),
  unit: FuelUnit.default("l"),
});

type FuelServiceSettings = z.infer<typeof FuelServiceSettings>;

/**
 * @internal Exported for testing
 */
export type FuelServiceTelemetryState = {
  fuelFillOn?: boolean;
  fuelAmount?: number;
  displayUnits?: number;
};

/**
 * @internal Exported for testing
 */
export function isFuelFillOn(telemetry: TelemetryData | null): boolean {
  if (!telemetry || telemetry.PitSvFlags === undefined) return false;

  return hasFlag(telemetry.PitSvFlags, PitSvFlags.FuelFill);
}

/**
 * @internal Exported for testing
 *
 * Returns the pit service fuel amount (liters) from telemetry.
 */
export function getFuelAmount(telemetry: TelemetryData | null): number {
  if (!telemetry || telemetry.PitSvFuel === undefined) return 0;

  return telemetry.PitSvFuel;
}

const WHITE = "#ffffff";

/**
 * @internal Exported for testing
 *
 * Formats a fuel amount for the toggle-fuel-fill icon display.
 * Converts liters to display units and adds "+" prefix.
 */
export function formatFuelFillAmount(liters: number, displayUnits: number | undefined): string {
  const displayValue = fuelToDisplayUnits(liters, displayUnits);
  const rounded = Math.round(displayValue * 10) / 10;
  // Short suffixes for compact icon display ("L" / "g" for gallons)
  const suffix = displayUnits === 1 ? "L" : "g";

  return `+${rounded} ${suffix}`;
}

/**
 * Generates dynamic icon content (fuel amount + status bar) for toggle-fuel-fill mode.
 */
function fuelFillDynamicIcon(telemetryState: FuelServiceTelemetryState, graphic1Color: string): string {
  const statusBar = telemetryState.fuelFillOn ? statusBarOn() : statusBarOff();
  const fuelText = formatFuelFillAmount(telemetryState.fuelAmount ?? 0, telemetryState.displayUnits);

  return `
    <text x="72" y="24" text-anchor="middle" dominant-baseline="central"
          fill="${graphic1Color}" font-family="Arial, sans-serif" font-size="22" font-weight="bold">REFUEL</text>
    <text x="72" y="75" text-anchor="middle" dominant-baseline="central"
          fill="${graphic1Color}" font-family="Arial, sans-serif" font-size="40" font-weight="bold">${fuelText}</text>
    ${statusBar}`;
}

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
      return FUEL_SERVICE_LABELS[mode] ?? FUEL_SERVICE_LABELS["add-fuel"]!;
  }
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the fuel service action.
 */
export function generateFuelServiceSvg(
  settings: FuelServiceSettings,
  telemetryState?: FuelServiceTelemetryState,
): string {
  const { mode } = settings;

  // Dynamic telemetry-driven mode: toggle-fuel-fill
  if (TELEMETRY_AWARE_MODES.has(mode)) {
    const colors = resolveIconColors(fuelServiceTemplate, getGlobalColors(), settings.colorOverrides) as Record<
      string,
      string
    >;
    const graphic1 = colors.graphic1Color || WHITE;
    const iconContent = fuelFillDynamicIcon(telemetryState ?? {}, graphic1);

    const svg = renderIconTemplate(fuelServiceTemplate, {
      iconContent,
      ...colors,
    });

    return svgToDataUri(svg);
  }

  // Static modes
  const iconSvg = FUEL_SERVICE_ICONS[mode] ?? FUEL_SERVICE_ICONS["add-fuel"]!;
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
 * autofuel toggle, lap margin adjustments, fuel fill toggle).
 * Fuel modes use pit macro chat commands; clear-fuel and toggle-fuel-fill use SDK;
 * keyboard-based modes use global key bindings.
 */
export const FUEL_SERVICE_UUID = "com.iracedeck.sd.core.fuel-service" as const;

export class FuelService extends ConnectionStateAwareAction<FuelServiceSettings> {
  private activeContexts = new Map<string, FuelServiceSettings>();
  private lastState = new Map<string, string>();

  override async onWillAppear(ev: IDeckWillAppearEvent<FuelServiceSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    const activeKey = FUEL_SERVICE_GLOBAL_KEYS[settings.mode];
    this.setActiveBinding(activeKey ?? null);

    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      const storedSettings = this.activeContexts.get(ev.action.id);

      if (storedSettings) {
        this.updateDisplayFromTelemetry(ev.action.id, telemetry, storedSettings);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<FuelServiceSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<FuelServiceSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.lastState.delete(ev.action.id);
    const activeKey = FUEL_SERVICE_GLOBAL_KEYS[settings.mode];
    this.setActiveBinding(activeKey ?? null);

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<FuelServiceSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeMode(settings.mode, settings);
  }

  override async onDialDown(ev: IDeckDialDownEvent<FuelServiceSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeMode(settings.mode, settings);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<FuelServiceSettings>): Promise<void> {
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

      // SDK-based modes
      case "clear-fuel":
        this.executeSdkClearFuel();
        break;

      case "toggle-fuel-fill":
        this.executeSdkToggleFuelFill();
        break;

      // Keyboard-based modes
      case "toggle-autofuel":
      case "lap-margin-increase":
      case "lap-margin-decrease": {
        const settingKey = FUEL_SERVICE_GLOBAL_KEYS[mode];

        if (!settingKey) {
          this.logger.warn(`No global key mapping for mode: ${mode}`);

          return;
        }

        await this.tapBinding(settingKey);
        break;
      }
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

  private executeSdkToggleFuelFill(): void {
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("No telemetry available for fuel fill toggle");

      return;
    }

    const pit = getCommands().pit;
    const isSet = isFuelFillOn(telemetry);
    const success = isSet ? pit.clearFuel() : pit.fuel(0);
    this.logger.info("Fuel fill toggled");
    this.logger.debug(`Action: ${isSet ? "cleared" : "requested"}, result: ${success}`);
  }

  private getTelemetryState(telemetry: TelemetryData | null): FuelServiceTelemetryState {
    return {
      fuelFillOn: isFuelFillOn(telemetry),
      fuelAmount: getFuelAmount(telemetry),
      displayUnits: telemetry?.DisplayUnits,
    };
  }

  private buildStateKey(settings: FuelServiceSettings, telemetryState: FuelServiceTelemetryState): string {
    if (settings.mode === "toggle-fuel-fill") {
      return `fuel-fill|${telemetryState.fuelFillOn ?? false}|${telemetryState.fuelAmount ?? 0}|${telemetryState.displayUnits ?? 0}`;
    }

    return settings.mode;
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<FuelServiceSettings> | IDeckDidReceiveSettingsEvent<FuelServiceSettings>,
    settings: FuelServiceSettings,
  ): Promise<void> {
    const telemetry = this.sdkController.getCurrentTelemetry();
    const telemetryState = this.getTelemetryState(telemetry);
    const svgDataUri = generateFuelServiceSvg(settings, telemetryState);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => {
      const currentTelemetry = this.sdkController.getCurrentTelemetry();
      const currentState = this.getTelemetryState(currentTelemetry);

      return generateFuelServiceSvg(settings, currentState);
    });
    const stateKey = this.buildStateKey(settings, telemetryState);
    this.lastState.set(ev.action.id, stateKey);
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: FuelServiceSettings,
  ): Promise<void> {
    if (!TELEMETRY_AWARE_MODES.has(settings.mode)) return;

    const telemetryState = this.getTelemetryState(telemetry);
    const stateKey = this.buildStateKey(settings, telemetryState);
    const lastStateKey = this.lastState.get(contextId);

    if (lastStateKey !== stateKey) {
      this.lastState.set(contextId, stateKey);
      const svgDataUri = generateFuelServiceSvg(settings, telemetryState);
      await this.updateKeyImage(contextId, svgDataUri);
      this.setRegenerateCallback(contextId, () => {
        const currentTelemetry = this.sdkController.getCurrentTelemetry();
        const currentState = this.getTelemetryState(currentTelemetry);

        return generateFuelServiceSvg(settings, currentState);
      });
    }
  }
}
