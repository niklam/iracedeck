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
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
} from "@iracedeck/deck-core";
import clearFuelIcon from "@iracedeck/icons/fuel-service/clear-fuel.svg";
import lapMarginDecreaseIcon from "@iracedeck/icons/fuel-service/lap-margin-decrease.svg";
import lapMarginIncreaseIcon from "@iracedeck/icons/fuel-service/lap-margin-increase.svg";
import toggleAutofuelIcon from "@iracedeck/icons/fuel-service/toggle-autofuel.svg";
import { hasFlag, PitSvFlags, type TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import fuelAddTemplate from "../../icons/fuel-add.svg";
import fuelReduceTemplate from "../../icons/fuel-reduce.svg";
import fuelServiceTemplate from "../../icons/fuel-service.svg";
import fuelSetTemplate from "../../icons/fuel-set.svg";
import { borderColorForState, statusBarOff, statusBarOn } from "../icons/status-bar.js";

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
  "clear-fuel": clearFuelIcon,
  "toggle-autofuel": toggleAutofuelIcon,
  "lap-margin-increase": lapMarginIncreaseIcon,
  "lap-margin-decrease": lapMarginDecreaseIcon,
};

/**
 * Per-mode template and accent color for fixed-layout fuel modes.
 * Bars, labels, and colors are baked into each SVG template — only {{iconContent}} is dynamic.
 */
const FUEL_STATIC_TEMPLATES: Record<
  "add-fuel" | "reduce-fuel" | "set-fuel-amount",
  { template: string; color: string }
> = {
  "add-fuel": { template: fuelAddTemplate, color: "#3fb23f" },
  "reduce-fuel": { template: fuelReduceTemplate, color: "#e74c3c" },
  "set-fuel-amount": { template: fuelSetTemplate, color: "#d3c518" },
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
 * Returns the pit service fuel amount (liters) from telemetry,
 * or undefined when no telemetry is available.
 */
export function getFuelAmount(telemetry: TelemetryData | null): number | undefined {
  if (!telemetry || telemetry.PitSvFuel === undefined) return undefined;

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
function fuelFillGraphicContent(telemetryState: FuelServiceTelemetryState, graphic1Color: string): string {
  const fuelText =
    telemetryState.fuelAmount === undefined
      ? "--"
      : formatFuelFillAmount(telemetryState.fuelAmount, telemetryState.displayUnits);

  return `
    <text x="72" y="75" text-anchor="middle" dominant-baseline="central"
          fill="${graphic1Color}" font-family="Arial" font-size="40" font-weight="700">${fuelText}</text>`;
}

function fuelFillStatusBar(telemetryState: FuelServiceTelemetryState): string {
  return telemetryState.fuelFillOn ? statusBarOn() : statusBarOff();
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

/** Modes that support long-press repeat (execute at interval while held) */
const REPEATABLE_MODES = new Set<FuelServiceMode>(["add-fuel", "reduce-fuel"]);
const REPEAT_INTERVAL_MS = 250;

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
      return FUEL_SERVICE_LABELS[mode] ?? { line1: "", line2: "FUEL" };
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
    const state = telemetryState ?? {};
    const graphicContent = fuelFillGraphicContent(state, graphic1);
    // Status bar is always visible, even when graphics are off
    const statusBar = fuelFillStatusBar(state);

    const resolvedTitle = resolveTitleSettings(fuelServiceTemplate, getGlobalTitleSettings(), settings.titleOverrides);

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

    const iconContent = (resolvedTitle.showGraphics ? graphicContent : "") + statusBar;

    const fuelFillEnabled = state.fuelFillOn ?? false;
    const border = resolveBorderSettings(
      fuelServiceTemplate,
      getGlobalBorderSettings(),
      settings.borderOverrides,
      borderColorForState(fuelFillEnabled ? "on" : "off"),
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

  // Fixed-layout modes: bars and labels baked into per-mode SVG, only the value text is dynamic
  const staticEntry = FUEL_STATIC_TEMPLATES[mode as keyof typeof FUEL_STATIC_TEMPLATES];

  if (staticEntry) {
    const { template, color } = staticEntry;
    const { line1 } = getFuelServiceLabels(settings);
    const colors = resolveIconColors(template, getGlobalColors(), settings.colorOverrides) as Record<string, string>;
    const border = resolveBorderSettings(template, getGlobalBorderSettings(), settings.borderOverrides);
    const borderSvg = generateBorderParts(border);

    const valueText = line1.replace(/^[+-]/, "");
    const lastSpace = valueText.lastIndexOf(" ");
    const numPart = lastSpace >= 0 ? valueText.slice(0, lastSpace) : valueText;
    const unitPart = lastSpace >= 0 ? valueText.slice(lastSpace + 1) : "";

    // 48.1px matches the design tool export baseline; scales to 36px for 3+ digits to stay within decorative bars
    const numFontSize = numPart.length >= 3 ? 36 : 48.1;
    const unitFontSize = Math.round(numFontSize * 0.55);

    // Estimate widths to center the number+unit group (charWidth ≈ 0.6 × fontSize for bold numbers)
    const numWidth = numPart.length * numFontSize * 0.6;
    const unitWidth = unitPart.length * unitFontSize * 0.6;
    const gap = 7;
    const totalWidth = numWidth + gap + unitWidth;
    const startX = 72 - totalWidth / 2;

    const iconContent =
      `<text font-family="Arial" font-size="${numFontSize}" font-weight="900" letter-spacing="-6" fill="${color}" text-anchor="start" x="${startX}" y="79.39">${numPart}</text>` +
      `<text font-family="Arial" font-size="${unitFontSize}" font-weight="700" fill="${color}" text-anchor="start" x="${startX + numWidth + gap}" y="79.39">${unitPart}</text>`;

    const svg = renderIconTemplate(template, {
      iconContent,
      borderDefs: borderSvg.defs,
      borderContent: borderSvg.rects,
      ...colors,
    });

    return svgToDataUri(svg);
  }

  // Legacy static modes (using assembleIcon with icon snippets)
  const iconSvg = FUEL_SERVICE_ICONS[mode] ?? FUEL_SERVICE_ICONS["clear-fuel"]!;
  const { line1, line2 } = getFuelServiceLabels(settings);
  // Convert inverted layout (line2=subLabel/top, line1=mainLabel/bottom) to title format (top\nbottom)
  const defaultTitle = line2 ? `${line2}\n${line1}` : line1;

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border });
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
  private repeatIntervals = new Map<string, ReturnType<typeof setInterval>>();

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

    const timer = setInterval(() => {
      const currentSettings = this.activeContexts.get(actionId);

      if (!currentSettings) {
        this.stopRepeat(actionId);

        return;
      }

      void this.executeMode(currentSettings.mode, currentSettings).catch((err) => {
        this.logger.error(`Repeat execution failed: ${err}`);
      });
    }, REPEAT_INTERVAL_MS);

    this.repeatIntervals.set(actionId, timer);
  }

  private stopRepeat(actionId: string): void {
    const timer = this.repeatIntervals.get(actionId);

    if (timer) {
      clearInterval(timer);
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
      const bo = settings.borderOverrides;
      const borderKey = `${bo?.enabled ?? ""}|${bo?.borderWidth ?? ""}|${bo?.borderColor ?? ""}|${bo?.glowEnabled ?? ""}|${bo?.glowWidth ?? ""}`;

      return `fuel-fill|${telemetryState.fuelFillOn ?? false}|${telemetryState.fuelAmount ?? "none"}|${telemetryState.displayUnits ?? 0}|${borderKey}`;
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
