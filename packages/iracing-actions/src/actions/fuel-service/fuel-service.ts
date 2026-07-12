import {
  applyBindingWarning,
  assembleIcon,
  ConnectionStateAwareAction,
  fuelToDisplayUnits,
  gallonsToLiters,
  generateBorderParts,
  generateTitleText,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
  type IDeckTouchTapEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  isAutofuelActive,
  isAutofuelEnabled,
  isFuelFillOn,
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
import { DisplayUnits, type SessionInfo, type TelemetryData } from "@iracedeck/iracing-sdk";

import fuelServiceTemplate from "../../../icons/fuel-service.svg";
import { borderColorForState, statusBarNA, statusBarOff, statusBarOn } from "../../icons/status-bar.js";
import { showBlackBox } from "../../shared/black-box.js";
import { RepeatController } from "../../shared/repeat-controller.js";
import { FuelDialSurface, readPitSvFuel } from "./fuel-dial-surface.js";
import { FuelPipeline } from "./fuel-pipeline.js";
import {
  FUEL_SERVICE_GLOBAL_KEYS,
  type FuelServiceMode,
  type FuelServiceSettings,
  type FuelUnit,
  parseFuelServiceSettings,
} from "./fuel-service-settings.js";

export { FUEL_SERVICE_GLOBAL_KEYS } from "./fuel-service-settings.js";

/**
 * Display labels for the resolved fuel unit
 */
const UNIT_DISPLAY: Record<"l" | "g" | "k", string> = {
  l: "L",
  g: "GAL",
  k: "KG",
};

/**
 * Label configuration for static fuel service modes.
 * Uses inverted layout: line1 = bold/bottom (primary), line2 = subdued/top (secondary).
 * Fuel amount modes (add-fuel, reduce-fuel, set-fuel-amount) use dynamic labels computed in getFuelServiceLabels().
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
 * Modes that use telemetry-driven dynamic icons.
 * Keep in sync with getTelemetryState() and buildStateKey().
 */
const TELEMETRY_AWARE_MODES = new Set<FuelServiceMode>(["toggle-fuel-fill", "toggle-autofuel"]);

/**
 * The fuel amount modes (SDK `pit.fuel` against the live `PitSvFuel` baseline,
 * #759). Their key labels depend on the resolved unit, so with `unit: "auto"` a
 * DisplayUnits change re-renders them (see buildStateKey / updateDisplayFromTelemetry).
 */
const AMOUNT_MODES = new Set<FuelServiceMode>(["add-fuel", "reduce-fuel", "set-fuel-amount"]);

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
    <text x="72" y="75" text-anchor="middle"
          fill="${graphic1Color}" font-family="Arial, sans-serif" font-size="40" font-weight="bold">${fuelText}</text>`;
}

/**
 * @internal Exported for testing
 *
 * Resolves the shared `unit` setting to a concrete keypad unit. `auto` follows
 * iRacing's live DisplayUnits (gallons when english, liters when metric or
 * unknown); explicit units pass through.
 */
export function resolveKeypadUnit(unit: FuelUnit, displayUnits: number | undefined): "l" | "g" | "k" {
  if (unit !== "auto") return unit;

  return displayUnits === DisplayUnits.English ? "g" : "l";
}

/**
 * @internal Exported for testing
 *
 * Reads `DriverInfo.DriverCarFuelKgPerLtr` (fuel weight, kg per liter) from
 * session info, or undefined when unavailable/invalid.
 */
export function readFuelKgPerLtr(sessionInfo: SessionInfo | null): number | undefined {
  const driverInfo = (sessionInfo as Record<string, unknown> | null)?.DriverInfo as Record<string, unknown> | undefined;

  if (!driverInfo) return undefined;

  const kgPerLtr = driverInfo.DriverCarFuelKgPerLtr;

  return typeof kgPerLtr === "number" && Number.isFinite(kgPerLtr) && kgPerLtr > 0 ? kgPerLtr : undefined;
}

/**
 * @internal Exported for testing
 *
 * Converts a user-configured amount in the resolved unit to liters for the
 * `pit.fuel` broadcast. Gallons use the shared conversion factor; kilograms
 * divide by the car's fuel weight (`DriverCarFuelKgPerLtr`, #759) — `null`
 * when that weight is unavailable so callers can warn-and-skip instead of
 * sending a garbage amount.
 */
export function amountToLiters(amount: number, unit: "l" | "g" | "k", kgPerLtr: number | undefined): number | null {
  switch (unit) {
    case "l":
      return amount;
    case "g":
      return gallonsToLiters(amount);
    case "k":
      return kgPerLtr === undefined ? null : amount / kgPerLtr;
  }
}

/**
 * The black box every Fuel Service keypad mode is readable in (#818): the fuel
 * to add, the fuel-fill checkbox, the autofuel toggle, and the lap margin all
 * live in iRacing's Fuel black box.
 */
const FUEL_BLACK_BOX_ID = "fuel" as const;

/** Modes that support long-press repeat (execute at interval while held) */
const REPEATABLE_MODES = new Set<FuelServiceMode>(["add-fuel", "reduce-fuel"]);
/** Hold duration required before a keyDown transitions into the repeat loop */
const REPEAT_HOLD_THRESHOLD_MS = 400;
/**
 * Gap between the completion of one repeat send and the start of the next.
 * The `pit.fuel` broadcast is effectively instant (unlike the former ~440 ms
 * chat pipeline), so this interval alone sets the repeat cadence — a deliberate
 * ~4 adjustments/sec keeps a held button controllable (#759). Telemetry updates
 * at 60 Hz, so the `PitSvFuel` baseline is fresh again well before each repeat.
 */
const REPEAT_GAP_MS = 250;
/** Maximum duration for long-press repeat before auto-stop (safety net for missed keyUp) */
const REPEAT_MAX_DURATION_MS = 15_000;

/**
 * @internal Exported for testing
 *
 * Returns display labels for a fuel service mode. Fuel amount modes compute
 * dynamic labels from the amount setting and the RESOLVED unit (`auto` follows
 * the live DisplayUnits passed by the caller).
 */
export function getFuelServiceLabels(
  settings: FuelServiceSettings,
  displayUnits?: number,
): { line1: string; line2: string } {
  const { mode, amount } = settings;
  const rounded = Math.round(amount * 10) / 10;
  const unitLabel = UNIT_DISPLAY[resolveKeypadUnit(settings.unit, displayUnits)];

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
  bindingMissing = false,
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

    // toggle-fuel-fill shows the fuel amount; toggle-autofuel shows only the status bar
    const graphicContent =
      mode === "toggle-autofuel"
        ? ""
        : toggleState === "na"
          ? fuelFillGraphicContent({}, graphic1)
          : fuelFillGraphicContent(state, graphic1);

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

    // Status bar is always visible, even when graphics are off. When a required
    // binding is missing (toggle-autofuel with neither keyboard nor SimHub set),
    // dim the content and draw the centered warning over it (#612).
    const baseContent = (resolvedTitle.showGraphics ? graphicContent : "") + statusBar;
    const iconContent = bindingMissing ? applyBindingWarning(baseContent) : baseContent;

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
  const { line1, line2 } = getFuelServiceLabels(settings, telemetryState?.displayUnits);
  // Convert inverted layout (line2=subLabel/top, line1=mainLabel/bottom) to title format (top\nbottom)
  const defaultTitle = line2 ? `${line2}\n${line1}` : line1;

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * Fuel Service Action
 *
 * One fuel action for both surfaces (#759). On a KEYPAD button it provides
 * fuel management for pit stops (add/reduce fuel, set amount, clear, autofuel
 * toggle, lap margin adjustments, fuel fill toggle). On a DIAL it is the full
 * fuel dial: rotate to set the add amount / target, gestures to toggle, clear
 * or fill fueling, with the self-drawn touch-strip display (see
 * {@link FuelDialSurface}).
 *
 * All fuel values go through the iRacing SDK (`pit.fuel` via the shared
 * {@link FuelPipeline}); keyboard-based modes use global key bindings.
 */
export const FUEL_SERVICE_UUID = "com.iracedeck.sd.core.fuel-service" as const;

export class FuelService extends ConnectionStateAwareAction<FuelServiceSettings> {
  private activeContexts = new Map<string, FuelServiceSettings>();
  private lastState = new Map<string, string>();
  private readonly repeat = new RepeatController(this.logger);
  /** Shared iRacing fuel-request pipeline — one per action, used by BOTH surfaces. */
  private readonly pipeline = new FuelPipeline(this.logger);
  /** The dial half of the action; all IDeck dial events route here. */
  private readonly dialSurface = new FuelDialSurface(
    {
      logger: this.logger,
      getTelemetry: () => this.sdkController.getCurrentTelemetry(),
      getSessionInfo: () => this.sdkController.getSessionInfo(),
      tapBinding: (settingKey) => this.tapBinding(settingKey),
      isBindingMissing: (keys) => this.isBindingMissing(keys),
    },
    this.pipeline,
  );

  /** @internal Compat accessor — tests read repeat state via this field. */
  private get repeatIntervals() {
    return this.repeat.timers;
  }

  /** @internal Compat accessor — tests read held state via this field. */
  private get heldButtons() {
    return this.repeat.heldButtons;
  }

  /**
   * @internal Compat shim — preserves the pre-refactor `startRepeat` guard test.
   * Tests install/remove heldButtons entries manually and then call this method to
   * verify timers are not armed when the button is no longer held.
   */
  private startRepeat(actionId: string): void {
    if (!this.repeat.isHeld(actionId)) return;

    this.repeat.onKeyDown(actionId, {
      holdMs: REPEAT_HOLD_THRESHOLD_MS,
      intervalMs: REPEAT_GAP_MS,
      safetyMs: REPEAT_MAX_DURATION_MS,
      execute: async () => {
        const current = this.activeContexts.get(actionId);

        if (!current) return false;

        await this.executeMode(current.mode, current);

        return true;
      },
    });
  }

  override async onWillAppear(ev: IDeckWillAppearEvent<FuelServiceSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      await this.dialSurface.willAppear(ev.action, settings);
      this.sdkController.subscribe(ev.action.id, (telemetry) => {
        this.dialSurface.onTelemetry(ev.action.id, telemetry);
      });

      return;
    }

    // Persist the effective unit the first time a keypad instance appears
    // without one (#759, one-shot): a pre-#759 instance (a persisted `mode`
    // exists) keeps liters — the old default its amounts used — while a fresh
    // instance persists the new `auto` default. Persisting BOTH closes the
    // ambiguous "mode set, unit absent" shape: the PI only persists a control's
    // value once touched, so a post-#759 instance whose user picks a mode but
    // never opens the Unit dropdown would otherwise be indistinguishable from a
    // legacy instance on a later parse and wrongly coerced to liters. Because
    // willAppear runs before the PI can be opened, a fresh instance always has
    // `unit: "auto"` banked before `mode` can ever be persisted alone. Only the
    // unit key is written so untouched fields keep tracking future schema
    // defaults; the next appear sees `unit` set and writes nothing.
    const raw = ev.payload.settings as Record<string, unknown> | undefined;

    if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.unit === undefined) {
      await ev.action.setSettings({ ...raw, unit: raw.mode !== undefined ? "l" : "auto" });
    }

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
    this.repeat.clear(ev.action.id);
    this.dialSurface.willDisappear(ev.action.id);
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<FuelServiceSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      await this.dialSurface.didReceiveSettings(ev.action, settings);

      return;
    }

    // Defensive: settings changes can arrive mid-hold; drop any pending/active repeat.
    this.repeat.clear(ev.action.id);
    this.activeContexts.set(ev.action.id, settings);
    this.lastState.delete(ev.action.id);
    const activeKey = FUEL_SERVICE_GLOBAL_KEYS[settings.mode];
    this.setActiveBinding(activeKey ?? null);

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<FuelServiceSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    // Raw vs parsed distinguishes "the PI never persisted the checkbox"
    // (raw === undefined) from "it persisted a value that parsed to false".
    const rawShowBlackBox = (ev.payload.settings as Record<string, unknown> | undefined)?.showBlackBox;
    this.logger.debug(
      `Key down settings: mode=${settings.mode}, showBlackBox=${settings.showBlackBox} (raw=${JSON.stringify(rawShowBlackBox)})`,
    );

    // Arm the repeat timers synchronously before awaiting the first execute. If we
    // awaited first, onKeyUp could run during the yield and leave heldButtons cleared —
    // then a late repeat.onKeyDown would install orphan timers nothing ever cancels.
    // Starting the repeat immediately guarantees any keyUp during the in-flight send
    // finds the timers and clears them.
    if (REPEATABLE_MODES.has(settings.mode)) {
      this.repeat.onKeyDown(ev.action.id, {
        holdMs: REPEAT_HOLD_THRESHOLD_MS,
        intervalMs: REPEAT_GAP_MS,
        safetyMs: REPEAT_MAX_DURATION_MS,
        execute: async () => {
          const current = this.activeContexts.get(ev.action.id);

          if (!current) return false;

          await this.executeMode(current.mode, current);

          return true;
        },
      });
    }

    // Show the Fuel black box BEFORE the value changes, so the driver watches it
    // tick. Two constraints pin this exact position:
    //   - AFTER repeat.onKeyDown, whose timers must be armed before the first
    //     await (see the comment above).
    //   - In onKeyDown rather than executeMode, because the repeat loop calls
    //     executeMode directly. That gives "show once per press, never on a
    //     repeat iteration" for free — nothing can change the shown box between
    //     iterations. (#818)
    if (settings.showBlackBox) {
      await showBlackBox(FUEL_BLACK_BOX_ID, {
        isConfigured: (key) => !this.isBindingMissing(key),
        tapSequence: (keys, holdMs) => this.tapBindingSequence(keys, holdMs),
        logger: this.logger,
      });
    }

    await this.executeMode(settings.mode, settings);
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<FuelServiceSettings>): Promise<void> {
    this.logger.info("Key up received");
    this.repeat.onKeyUp(ev.action.id);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<FuelServiceSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.rotate(ev.action, settings, ev.payload.ticks, ev.payload.pressed === true);
  }

  override async onDialDown(ev: IDeckDialDownEvent<FuelServiceSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.down(ev.action, settings);
  }

  override async onDialUp(ev: IDeckDialUpEvent<FuelServiceSettings>): Promise<void> {
    await this.dialSurface.up(ev.action.id);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<FuelServiceSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.touchTap(ev.action, settings, ev.payload.hold === true);
  }

  private parseSettings(settings: unknown): FuelServiceSettings {
    return parseFuelServiceSettings(settings);
  }

  private async executeMode(mode: FuelServiceMode, settings: FuelServiceSettings): Promise<void> {
    switch (mode) {
      // SDK amount modes (pit.fuel against the live PitSvFuel baseline, #759)
      case "add-fuel":
      case "reduce-fuel":
      case "set-fuel-amount":
        this.executeSdkFuelAdjust(mode, settings);
        break;

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
        // When enableFuelingOnChange is off and fuel fill was off, clear it to
        // restore the off state. Forced: the arming happened in the black box,
        // outside the pipeline, so the no-double-clear guard must not skip it.
        if (mode !== "toggle-autofuel" && this.shouldPreserveFuelingState()) {
          this.logger.debug("Clearing fuel fill to preserve off state after lap margin change");
          const cleared = this.pipeline.forceClearFuel();

          if (!cleared) {
            this.logger.warn("Failed to clear fuel fill when preserving off state");
          }
        }

        break;
      }
    }
  }

  /**
   * Determines whether the fuel fill checkbox state should be preserved after a
   * fuel or lap-margin adjustment: when enableFuelingOnChange is false AND fuel
   * fill is currently off, a follow-up `pit.clearFuel` restores the off state so
   * the user's checkbox isn't auto-enabled. KEYPAD-ONLY (#759): the dial always
   * auto-arms on rotate — its state machine (clear-guard, continuous fill-to
   * monitor, live checkbox display) depends on it, and a fuel+clear pair per
   * rotation window would spam iRacing.
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

  /**
   * Adjusts the pit fuel request via the SDK (#759). `pit.fuel` sets an
   * ABSOLUTE add amount, so add/reduce compute against the live `PitSvFuel`
   * baseline (fresh on every press — telemetry is 60 Hz vs the ~250 ms repeat
   * cadence). iRacing banks whole liters, so the target is rounded; a target at
   * or below zero empties the request instead (`pit.fuel(0)` would mean "keep
   * the existing amount"). With preserve-off active, a follow-up clear restores
   * the user's unchecked fuel box (the former `#-fuel` chat behavior).
   */
  private executeSdkFuelAdjust(
    mode: "add-fuel" | "reduce-fuel" | "set-fuel-amount",
    settings: FuelServiceSettings,
  ): void {
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("No telemetry available for fuel adjustment");

      return;
    }

    const telemetryUnits = telemetry.DisplayUnits;
    const resolvedUnit = resolveKeypadUnit(
      settings.unit,
      typeof telemetryUnits === "number" ? telemetryUnits : undefined,
    );
    const deltaLtr = amountToLiters(
      settings.amount,
      resolvedUnit,
      readFuelKgPerLtr(this.sdkController.getSessionInfo()),
    );

    if (deltaLtr === null) {
      this.logger.warn("Fuel weight (kg per liter) unavailable — cannot convert kg amount, skipping");

      return;
    }

    // Read the preserve decision BEFORE sending — pit.fuel arms the checkbox.
    const preserve = this.shouldPreserveFuelingState();
    const currentLtr = readPitSvFuel(telemetry) ?? 0;

    let targetLtr: number;

    switch (mode) {
      case "add-fuel":
        targetLtr = currentLtr + deltaLtr;
        break;
      case "reduce-fuel":
        targetLtr = currentLtr - deltaLtr;
        break;
      case "set-fuel-amount":
        targetLtr = deltaLtr;
        break;
    }

    const roundedLtr = Math.round(targetLtr);

    if (roundedLtr <= 0) {
      // Empty the banked amount and leave fueling off — already the preserved state.
      this.pipeline.sendNoFuel();
      this.logger.info("Fuel request emptied");
      this.logger.debug(`${mode}: target ${targetLtr.toFixed(2)}L ≤ 0 — sent no-fuel`);

      return;
    }

    this.pipeline.fuel(roundedLtr);

    if (preserve) {
      this.pipeline.clearFuel();
    }

    this.logger.info("Fuel request sent");
    this.logger.debug(
      `${mode}: ${settings.amount} ${resolvedUnit} → pit.fuel(${roundedLtr}) (baseline ${currentLtr.toFixed(2)}L)${preserve ? ", cleared to preserve off state" : ""}`,
    );
  }

  private executeSdkClearFuel(): void {
    // Forced: an explicit Clear Fuel press must always send, even right after
    // another clear (the arming may have happened outside this pipeline).
    const success = this.pipeline.forceClearFuel();
    this.logger.info("Clear fuel checkbox executed");
    this.logger.debug(`Result: ${success}`);
  }

  private executeSdkToggleFuelFill(): void {
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("No telemetry available for fuel fill toggle");

      return;
    }

    const isSet = isFuelFillOn(telemetry);
    // Toggle ON arms keeping the banked amount (pit.fuel(0)); toggle OFF is a
    // deliberate user clear, forced past the dedup guard.
    const success = isSet ? this.pipeline.forceClearFuel() : this.pipeline.arm();
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
    // Include the binding-missing flag so a telemetry tick re-renders the key
    // when the user sets/clears the toggle-autofuel binding (#612).
    const warn = this.isBindingMissing(FUEL_SERVICE_GLOBAL_KEYS[settings.mode]) ? "warn" : "";

    if (settings.mode === "toggle-fuel-fill") {
      return `fuel-fill|${telemetryState.fuelFillOn ?? "na"}|${telemetryState.fuelAmount ?? "none"}|${telemetryState.displayUnits ?? 0}|${borderKey}`;
    }

    if (settings.mode === "toggle-autofuel") {
      return `autofuel|${telemetryState.autofuelEnabled ?? true}|${telemetryState.autofuelActive ?? "na"}|${borderKey}|${warn}`;
    }

    if (AMOUNT_MODES.has(settings.mode)) {
      // The resolved unit is part of the label; with unit "auto" a DisplayUnits
      // change must re-render the key (#759).
      const unitLabel = UNIT_DISPLAY[resolveKeypadUnit(settings.unit, telemetryState.displayUnits)];

      return `${settings.mode}|${unitLabel}|${warn}`;
    }

    return `${settings.mode}|${warn}`;
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<FuelServiceSettings> | IDeckDidReceiveSettingsEvent<FuelServiceSettings>,
    settings: FuelServiceSettings,
  ): Promise<void> {
    const telemetry = this.sdkController.getCurrentTelemetry();
    const telemetryState = this.getTelemetryState(telemetry);
    const svgDataUri = generateFuelServiceSvg(
      settings,
      telemetryState,
      this.isBindingMissing(FUEL_SERVICE_GLOBAL_KEYS[settings.mode]),
    );
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => {
      const currentTelemetry = this.sdkController.getCurrentTelemetry();
      const currentState = this.getTelemetryState(currentTelemetry);

      return generateFuelServiceSvg(
        settings,
        currentState,
        this.isBindingMissing(FUEL_SERVICE_GLOBAL_KEYS[settings.mode]),
      );
    });
    const stateKey = this.buildStateKey(settings, telemetryState);
    this.lastState.set(ev.action.id, stateKey);
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: FuelServiceSettings,
  ): Promise<void> {
    // Amount modes re-render too: their label's resolved unit follows live
    // DisplayUnits when unit is "auto" (#759). The state-key comparison keeps
    // unchanged ticks free.
    if (!TELEMETRY_AWARE_MODES.has(settings.mode) && !AMOUNT_MODES.has(settings.mode)) return;

    const telemetryState = this.getTelemetryState(telemetry);
    const stateKey = this.buildStateKey(settings, telemetryState);
    const lastStateKey = this.lastState.get(contextId);

    if (lastStateKey !== stateKey) {
      this.lastState.set(contextId, stateKey);
      const svgDataUri = generateFuelServiceSvg(
        settings,
        telemetryState,
        this.isBindingMissing(FUEL_SERVICE_GLOBAL_KEYS[settings.mode]),
      );
      await this.updateKeyImage(contextId, svgDataUri);
      this.setRegenerateCallback(contextId, () => {
        const currentTelemetry = this.sdkController.getCurrentTelemetry();
        const currentState = this.getTelemetryState(currentTelemetry);

        return generateFuelServiceSvg(
          settings,
          currentState,
          this.isBindingMissing(FUEL_SERVICE_GLOBAL_KEYS[settings.mode]),
        );
      });
    }
  }
}
