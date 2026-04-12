import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  fuelToDisplayUnits,
  generateBorderParts,
  generateTitleText,
  getCommands,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  renderIconTemplate,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
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
import { borderColorForState, statusBarNA, statusBarOff, statusBarOn } from "../icons/status-bar.js";

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
 * Label configuration for static fuel service modes.
 * Uses inverted layout: line1 = bold/bottom (primary), line2 = subdued/top (secondary).
 * Fuel macro modes (add-fuel, reduce-fuel, set-fuel-amount) use dynamic labels computed in getFuelServiceLabels().
 * Telemetry-aware modes (toggle-fuel-fill, toggle-autofuel) use title metadata from their SVG instead.
 */
const FUEL_SERVICE_LABELS: Partial<Record<FuelServiceMode, { line1: string; line2: string }>> = {
  "add-fuel": { line1: "+1 L", line2: "ADD FUEL" },
  "reduce-fuel": { line1: "-1 L", line2: "REDUCE FUEL" },
  "set-fuel-amount": { line1: "1 L", line2: "SET FUEL" },
  "clear-fuel": { line1: "CLEAR", line2: "FUEL" },
  "lap-margin-increase": { line1: "INCREASE", line2: "LAP MARGIN" },
  "lap-margin-decrease": { line1: "DECREASE", line2: "LAP MARGIN" },
};

/**
 * Standalone SVG templates for static fuel service modes (imported from @iracedeck/icons).
 * Telemetry-aware modes (toggle-fuel-fill, toggle-autofuel) use the dynamic template instead.
 */
const FUEL_SERVICE_ICONS: Partial<Record<FuelServiceMode, string>> = {
  "add-fuel": addFuelIcon,
  "reduce-fuel": reduceFuelIcon,
  "set-fuel-amount": setFuelAmountIcon,
  "clear-fuel": clearFuelIcon,
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
const TELEMETRY_AWARE_MODES = new Set<FuelServiceMode>(["toggle-fuel-fill", "toggle-autofuel"]);

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
  autofuelActive?: boolean;
  autofuelEnabled?: boolean;
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
 * Returns the pit service fuel amount (liters) from telemetry,
 * or undefined when no telemetry is available.
 */
export function getFuelAmount(telemetry: TelemetryData | null): number | undefined {
  if (!telemetry || telemetry.PitSvFuel === undefined) return undefined;

  return telemetry.PitSvFuel;
}

/**
 * @internal Exported for testing
 *
 * Returns whether autofuel is active for the next pit stop.
 */
export function isAutofuelActive(telemetry: TelemetryData | null): boolean {
  if (!telemetry || telemetry.dpFuelAutoFillActive === undefined) return false;

  return telemetry.dpFuelAutoFillActive !== 0;
}

/**
 * @internal Exported for testing
 *
 * Returns whether the autofuel system is enabled for this car/series.
 * When disabled, toggle-autofuel should show N/A.
 */
export function isAutofuelEnabled(telemetry: TelemetryData | null): boolean {
  if (!telemetry || telemetry.dpFuelAutoFillEnabled === undefined) return true;

  return telemetry.dpFuelAutoFillEnabled !== 0;
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
function fuelFillGraphicContent(telemetryState: FuelServiceTelemetryState, graphic1Color: string): string {
  const fuelText =
    telemetryState.fuelAmount === undefined
      ? "--"
      : formatFuelFillAmount(telemetryState.fuelAmount, telemetryState.displayUnits);

  return `
    <text x="72" y="75" text-anchor="middle" dominant-baseline="central"
          fill="${graphic1Color}" font-family="Arial, sans-serif" font-size="40" font-weight="bold">${fuelText}</text>`;
}

/**
 * @internal Exported for testing
 *
 * Builds a pit macro string for fuel operations.
 * Uses iRacing pit macro syntax: #fuel [[+|-]<amount>[l|g|k]]$
 * The $ suffix auto-executes without showing the chat window.
 */
export function buildFuelMacro(
  mode: FuelServiceMode,
  amount: number,
  unit: FuelUnit,
  preserveFueling = false,
): string | null {
  const rounded = Math.round(amount * 10) / 10;
  const prefix = preserveFueling ? "#-fuel" : "#fuel";

  switch (mode) {
    case "add-fuel":
      return `${prefix} +${rounded}${unit}$`;
    case "reduce-fuel":
      return `${prefix} -${rounded}${unit}$`;
    case "set-fuel-amount":
      return `${prefix} ${rounded}${unit}$`;
    default:
      return null;
  }
}

/** Modes that support long-press repeat (execute at interval while held) */
const REPEATABLE_MODES = new Set<FuelServiceMode>(["add-fuel", "reduce-fuel"]);
const REPEAT_INTERVAL_MS = 250;
/** Maximum duration for long-press repeat before auto-stop (safety net for missed keyUp) */
const REPEAT_MAX_DURATION_MS = 15_000;

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

  // Dynamic telemetry-driven modes: toggle-fuel-fill, toggle-autofuel
  if (TELEMETRY_AWARE_MODES.has(mode)) {
    // Use mode-specific SVG for metadata (title text, colors) but shared template for rendering
    const metadataSvg = mode === "toggle-autofuel" ? toggleAutofuelIcon : fuelServiceTemplate;
    const colors = resolveIconColors(metadataSvg, getGlobalColors(), settings.colorOverrides) as Record<string, string>;
    const graphic1 = colors.graphic1Color || WHITE;
    const state = telemetryState ?? {};

    // Status bar: green ON / red OFF / gray N/A based on the relevant toggle state
    let toggleState: "on" | "off" | "na";

    if (mode === "toggle-autofuel") {
      if (state.autofuelActive === undefined || state.autofuelEnabled === false) {
        toggleState = "na";
      } else {
        toggleState = state.autofuelActive ? "on" : "off";
      }
    } else {
      if (state.fuelFillOn === undefined) {
        toggleState = "na";
      } else {
        toggleState = state.fuelFillOn ? "on" : "off";
      }
    }

    // Show fuel amount when available; show "--" when the system is unavailable
    const graphicContent =
      toggleState === "na" ? fuelFillGraphicContent({}, graphic1) : fuelFillGraphicContent(state, graphic1);

    const statusBar = toggleState === "na" ? statusBarNA() : toggleState === "on" ? statusBarOn() : statusBarOff();

    const resolvedTitle = resolveTitleSettings(metadataSvg, getGlobalTitleSettings(), settings.titleOverrides);

    const titleContent = resolvedTitle.showTitle
      ? generateTitleText({
          text: resolvedTitle.titleText,
          fontSize: resolvedTitle.fontSize,
          bold: resolvedTitle.bold,
          position: resolvedTitle.position,
          customPosition: resolvedTitle.customPosition,
          fill: colors.textColor ?? WHITE,
        })
      : "";

    // Status bar is always visible, even when graphics are off
    const iconContent = (resolvedTitle.showGraphics ? graphicContent : "") + statusBar;

    const border = resolveBorderSettings(
      metadataSvg,
      getGlobalBorderSettings(),
      settings.borderOverrides,
      borderColorForState(toggleState),
    );
    const borderSvg = generateBorderParts(border);

    const svg = renderIconTemplate(fuelServiceTemplate, {
      iconContent,
      titleContent,
      borderDefs: borderSvg.defs,
      borderContent: borderSvg.rects,
      ...colors,
    });

    return svgToDataUri(svg);
  }

  // Static modes
  const iconSvg = FUEL_SERVICE_ICONS[mode] ?? FUEL_SERVICE_ICONS["add-fuel"]!;
  const { line1, line2 } = getFuelServiceLabels(settings);
  // Convert inverted layout (line2=subLabel/top, line1=mainLabel/bottom) to title format (top\nbottom)
  const defaultTitle = line2 ? `${line2}\n${line1}` : line1;

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
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
  private repeatIntervals = new Map<
    string,
    { interval: ReturnType<typeof setInterval>; safety: ReturnType<typeof setTimeout> }
  >();

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
    this.stopRepeat(ev.action.id);
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

    if (REPEATABLE_MODES.has(settings.mode)) {
      this.startRepeat(ev.action.id);
    }
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<FuelServiceSettings>): Promise<void> {
    this.logger.info("Key up received");
    this.stopRepeat(ev.action.id);
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

  private startRepeat(actionId: string): void {
    this.stopRepeat(actionId);

    const interval = setInterval(() => {
      const currentSettings = this.activeContexts.get(actionId);

      if (!currentSettings) {
        this.stopRepeat(actionId);

        return;
      }

      void this.executeMode(currentSettings.mode, currentSettings).catch((err) => {
        this.logger.error(`Repeat execution failed: ${err}`);
      });
    }, REPEAT_INTERVAL_MS);

    const safety = setTimeout(() => {
      this.logger.warn(
        `Repeat auto-stopped after ${REPEAT_MAX_DURATION_MS}ms (safety timeout — possible missed keyUp)`,
      );
      this.stopRepeat(actionId);
    }, REPEAT_MAX_DURATION_MS);

    this.repeatIntervals.set(actionId, { interval, safety });
  }

  private stopRepeat(actionId: string): void {
    const entry = this.repeatIntervals.get(actionId);

    if (entry) {
      clearInterval(entry.interval);
      clearTimeout(entry.safety);
      this.repeatIntervals.delete(actionId);
    }
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

        // Lap margin changes through the black box enable the fuel fill checkbox.
        // When enableFuelingOnChange is off and fuel fill was off, clear it to restore the off state.
        if (mode !== "toggle-autofuel" && this.shouldPreserveFuelingState()) {
          this.logger.debug("Clearing fuel fill to preserve off state after lap margin change");
          const cleared = getCommands().pit.clearFuel();

          if (!cleared) {
            this.logger.warn("Failed to clear fuel fill when preserving off state");
          }
        }

        break;
      }
    }
  }

  /**
   * Determines whether the fuel fill checkbox state should be preserved
   * (i.e., use #-fuel prefix instead of #fuel).
   * When enableFuelingOnChange is false AND fuel fill is currently off,
   * we preserve the off state so the user's checkbox isn't auto-enabled.
   */
  private shouldPreserveFuelingState(): boolean {
    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const raw = globalSettings.enableFuelingOnChange;
    // sdpi-checkbox stores "false" as a string — treat both boolean false and string "false" as disabled
    const enableFuelingOnChange = raw !== false && raw !== "false";

    if (enableFuelingOnChange) return false;

    const telemetry = this.sdkController.getCurrentTelemetry();

    return !isFuelFillOn(telemetry);
  }

  private executeFuelMacro(mode: FuelServiceMode, settings: FuelServiceSettings): void {
    const preserveFueling = this.shouldPreserveFuelingState();
    const macro = buildFuelMacro(mode, settings.amount, settings.unit, preserveFueling);

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
    if (!telemetry) {
      return {};
    }

    return {
      fuelFillOn: isFuelFillOn(telemetry),
      fuelAmount: getFuelAmount(telemetry),
      displayUnits: telemetry.DisplayUnits,
      autofuelActive: isAutofuelActive(telemetry),
      autofuelEnabled: isAutofuelEnabled(telemetry),
    };
  }

  private buildStateKey(settings: FuelServiceSettings, telemetryState: FuelServiceTelemetryState): string {
    const bo = settings.borderOverrides;
    const borderKey = `${bo?.enabled ?? ""}|${bo?.borderWidth ?? ""}|${bo?.borderColor ?? ""}|${bo?.glowEnabled ?? ""}|${bo?.glowWidth ?? ""}`;

    if (settings.mode === "toggle-fuel-fill") {
      return `fuel-fill|${telemetryState.fuelFillOn ?? "na"}|${telemetryState.fuelAmount ?? "none"}|${telemetryState.displayUnits ?? 0}|${borderKey}`;
    }

    if (settings.mode === "toggle-autofuel") {
      return `autofuel|${telemetryState.autofuelEnabled ?? true}|${telemetryState.autofuelActive ?? "na"}|${telemetryState.fuelAmount ?? "none"}|${telemetryState.displayUnits ?? 0}|${borderKey}`;
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
