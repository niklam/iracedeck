import {
  applyGraphicTransform,
  assembleIcon,
  CommonSettings,
  computeGraphicArea,
  ConnectionStateAwareAction,
  generateBorderParts,
  generateTitleText,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  getKeyboard,
  getSDK,
  type IDeckDialDownEvent,
  type IDeckDialUpEvent,
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
import enterCarIcon from "@iracedeck/icons/car-control/enter-car.svg";
import escapeIcon from "@iracedeck/icons/car-control/escape.svg";
import exitCarIcon from "@iracedeck/icons/car-control/exit-car.svg";
import headlightFlashIcon from "@iracedeck/icons/car-control/headlight-flash.svg";
import ignitionIcon from "@iracedeck/icons/car-control/ignition.svg";
import pauseSimIcon from "@iracedeck/icons/car-control/pause-sim.svg";
import resetToPitsIcon from "@iracedeck/icons/car-control/reset-to-pits.svg";
import starterIcon from "@iracedeck/icons/car-control/starter.svg";
import tearOffVisorIcon from "@iracedeck/icons/car-control/tear-off-visor.svg";
import towIcon from "@iracedeck/icons/car-control/tow.svg";
import { EngineWarnings, hasFlag, type TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import drsTemplate from "../../icons/car-control-drs.svg";
import pushToPassTemplate from "../../icons/car-control-push-to-pass.svg";
import carControlTemplate from "../../icons/car-control.svg";
import { borderColorForState, statusBarNA, statusBarOff, statusBarOn } from "../icons/status-bar.js";

const WHITE = "#ffffff";
const GRAY = "#888888";
const RED = "#e74c3c";
const BLUE = "#3498db";

type CarControlType =
  | "starter"
  | "ignition"
  | "pit-speed-limiter"
  | "enter-exit-tow"
  | "pause-sim"
  | "headlight-flash"
  | "push-to-pass"
  | "drs"
  | "tear-off-visor"
  | "escape";

/**
 * Label configuration for each car control (line1 bold, line2 subdued)
 */
const CAR_CONTROL_LABELS: Record<CarControlType, { line1: string; line2: string }> = {
  starter: { line1: "START", line2: "ENGINE" },
  ignition: { line1: "IGNITION", line2: "ON/OFF" },
  "pit-speed-limiter": { line1: "PIT", line2: "LIMITER" },
  "enter-exit-tow": { line1: "ENTER/EXIT", line2: "TOW" },
  "pause-sim": { line1: "PAUSE", line2: "SIM" },
  "headlight-flash": { line1: "HEADLIGHT", line2: "FLASH" },
  "push-to-pass": { line1: "PUSH TO", line2: "PASS" },
  drs: { line1: "DRS", line2: "TOGGLE" },
  "tear-off-visor": { line1: "TEAR OFF", line2: "VISOR" },
  escape: { line1: "ESCAPE", line2: "" },
};

/** @internal Exported for testing */
export type EnterExitTowState = "enter-car" | "exit-car" | "reset-to-pits" | "tow";

const ENTER_EXIT_TOW_ICONS: Record<EnterExitTowState, string> = {
  "enter-car": enterCarIcon,
  "exit-car": exitCarIcon,
  "reset-to-pits": resetToPitsIcon,
  tow: towIcon,
};

const ENTER_EXIT_TOW_TITLES: Record<EnterExitTowState, string> = {
  "enter-car": "DRIVE",
  "exit-car": "EXIT",
  "reset-to-pits": "RESET",
  tow: "TOW",
};

const CAR_CONTROL_STATIC_TITLES: Partial<Record<CarControlType, string>> = {
  starter: "ENGINE\nSTART",
  ignition: "ON/OFF\nIGNITION",
  "pause-sim": "SIM\nPAUSE",
  "headlight-flash": "FLASH\nHEADLIGHT",
  "tear-off-visor": "VISOR\nTEAR OFF",
  escape: "ESCAPE",
};

const DEFAULT_PIT_SPEED = 80;

/**
 * Controls that use telemetry-driven dynamic icons.
 * Keep in sync with getTelemetryState() and buildStateKey().
 */
const TELEMETRY_AWARE_CONTROLS = new Set<CarControlType>([
  "pit-speed-limiter",
  "push-to-pass",
  "drs",
  "enter-exit-tow",
]);

/** Controls that use hold pattern (press on keyDown, release on keyUp) */
const HOLD_CONTROLS = new Set<CarControlType>(["starter", "headlight-flash", "enter-exit-tow"]);

/** Hardcoded ESC key combination (not configurable — ESC is always ESC in iRacing) */
const ESC_KEY = { key: "escape", code: "Escape" } as const;

/** Auto-hold duration in milliseconds */
const AUTO_HOLD_DURATION = 1500;

/**
 * @internal Exported for testing
 *
 * Parse the pit speed limit from session info string (e.g. "80.00 kph") to an integer.
 */
export function parsePitSpeedLimit(value: string | undefined): number {
  if (!value) return DEFAULT_PIT_SPEED;

  const match = value.match(/^(\d+)/);

  return match ? parseInt(match[1], 10) : DEFAULT_PIT_SPEED;
}

/**
 * @internal Exported for testing
 *
 * Get pit speed limit from session info.
 */
export function getPitSpeedLimit(): number {
  const sessionInfo = getSDK().sdk.getSessionInfo();
  const weekendInfo = sessionInfo?.WeekendInfo as Record<string, unknown> | undefined;

  return parsePitSpeedLimit(weekendInfo?.TrackPitSpeedLimit as string | undefined);
}

/**
 * @internal Exported for testing
 *
 * Pit limiter icon content when ACTIVE (limiter engaged) — speed limit sign with blue highlight.
 */
export function pitLimiterActiveIcon(speed: number): string {
  return `
    <circle cx="72" cy="46" r="30" fill="${WHITE}" stroke="${BLUE}" stroke-width="8"/>
    <text x="72" y="56" text-anchor="middle" dominant-baseline="central"
          fill="#2a3a2a" font-family="Arial, sans-serif" font-size="28" font-weight="bold">${speed}</text>`;
}

/**
 * @internal Exported for testing
 *
 * Pit limiter icon content when INACTIVE (limiter off) — speed limit sign with red border.
 */
export function pitLimiterInactiveIcon(speed: number): string {
  return `
    <circle cx="72" cy="46" r="30" fill="${WHITE}" stroke="${RED}" stroke-width="8"/>
    <circle cx="72" cy="46" r="30" fill="none" stroke="${GRAY}" stroke-width="2"/>
    <text x="72" y="56" text-anchor="middle" dominant-baseline="central"
          fill="#2a3a2a" font-family="Arial, sans-serif" font-size="28" font-weight="bold">${speed}</text>`;
}

/**
 * @internal Exported for testing
 *
 * DRS icon — status bar only (title text handled by title settings system).
 * Undefined `active` means no telemetry available → gray N/A.
 */
export function drsIcon(active: boolean | undefined): string {
  if (active === undefined) return statusBarNA();

  return active ? statusBarOn() : statusBarOff();
}

/**
 * @internal Exported for testing
 *
 * Push To Pass icon — status bar only (title text handled by title settings system).
 * Undefined `active` means no telemetry available → gray N/A.
 */
export function pushToPassIcon(active: boolean | undefined): string {
  if (active === undefined) return statusBarNA();

  return active ? statusBarOn() : statusBarOff();
}

/**
 * Standalone SVG templates for static car control modes (imported from @iracedeck/icons)
 */
const STATIC_CAR_CONTROL_ICONS: Partial<Record<CarControlType, string>> = {
  starter: starterIcon,
  ignition: ignitionIcon,
  "pause-sim": pauseSimIcon,
  "headlight-flash": headlightFlashIcon,
  "tear-off-visor": tearOffVisorIcon,
  escape: escapeIcon,
};

/**
 * @internal Exported for testing
 *
 * Mapping from car control setting values (kebab-case) to global settings keys.
 */
export const CAR_CONTROL_GLOBAL_KEYS: Record<CarControlType, string> = {
  starter: "carControlStarter",
  ignition: "carControlIgnition",
  "pit-speed-limiter": "carControlPitSpeedLimiter",
  "enter-exit-tow": "carControlEnterExitTow",
  "pause-sim": "carControlPauseSim",
  "headlight-flash": "carControlHeadlightFlash",
  "push-to-pass": "carControlPushToPass",
  drs: "carControlDrs",
  "tear-off-visor": "carControlTearOffVisor",
  escape: "",
};

/**
 * @internal Exported for testing
 *
 * Determines the Enter/Exit/Tow state based on telemetry and session info.
 * Priority order: enter-car → exit-car → reset-to-pits/tow (based on session type).
 */
export function getEnterExitTowState(
  telemetry: TelemetryData | null,
  sessionInfo: Record<string, unknown> | null,
): EnterExitTowState {
  if (!telemetry || !telemetry.IsOnTrack) {
    return "enter-car";
  }

  if (telemetry.PlayerCarInPitStall) {
    return "exit-car";
  }

  // On track, not in pit stall — check session type
  const sessionNum = telemetry.SessionNum ?? 0;
  const sessions = (sessionInfo?.SessionInfo as Record<string, unknown> | undefined)?.Sessions as
    | Array<Record<string, unknown>>
    | undefined;
  const currentSession = sessions?.find((s) => s.SessionNum === sessionNum);
  const sessionType = currentSession?.SessionType as string | undefined;

  if (sessionType === "Race") {
    return "tow";
  }

  return "reset-to-pits";
}

/**
 * @internal Exported for testing
 *
 * Check if pit speed limiter is active from telemetry.
 */
export function isPitLimiterActive(telemetry: TelemetryData | null): boolean {
  if (!telemetry || telemetry.EngineWarnings === undefined) return false;

  return hasFlag(telemetry.EngineWarnings, EngineWarnings.PitSpeedLimiter);
}

/**
 * @internal Exported for testing
 *
 * Check if Push To Pass is active from telemetry.
 */
export function isPushToPassActive(telemetry: TelemetryData | null): boolean {
  if (!telemetry || telemetry.P2P_Status === undefined) return false;

  return telemetry.P2P_Status === true;
}

/**
 * @internal Exported for testing
 *
 * Check if DRS is active from telemetry.
 */
export function isDrsActive(telemetry: TelemetryData | null): boolean {
  if (!telemetry || telemetry.DRS_Status === undefined) return false;

  return telemetry.DRS_Status > 0;
}

/**
 * @internal Exported for testing
 *
 * Telemetry state for dynamic car control icons.
 */
export type CarControlTelemetryState = {
  pitLimiterActive?: boolean;
  pitSpeedLimit?: number;
  pushToPassActive?: boolean;
  drsActive?: boolean;
  enterExitTowState?: EnterExitTowState;
};

const CarControlSettings = CommonSettings.extend({
  control: z
    .enum([
      "pit-speed-limiter",
      "push-to-pass",
      "drs",
      "headlight-flash",
      "tear-off-visor",
      "ignition",
      "starter",
      "enter-exit-tow",
      "escape",
      "pause-sim",
    ])
    .default("pit-speed-limiter"),
  autoHold: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(false),
});

type CarControlSettings = z.infer<typeof CarControlSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the car control action.
 */
export function generateCarControlSvg(settings: CarControlSettings, telemetryState?: CarControlTelemetryState): string {
  const { control } = settings;

  // Pit-speed-limiter uses the template approach (dynamic speed number)
  if (control === "pit-speed-limiter") {
    const speed = telemetryState?.pitSpeedLimit ?? DEFAULT_PIT_SPEED;
    const isActive = telemetryState?.pitLimiterActive ?? false;
    const iconContent = isActive ? pitLimiterActiveIcon(speed) : pitLimiterInactiveIcon(speed);
    const border = resolveBorderSettings(
      carControlTemplate,
      getGlobalBorderSettings(),
      settings.borderOverrides,
      borderColorForState(isActive ? "on" : "off"),
    );
    const borderSvg = generateBorderParts(border);

    return renderDynamicIcon(settings, iconContent, borderSvg);
  }

  // Push To Pass and DRS use dedicated templates with their own <desc> defaults
  if (control === "push-to-pass" || control === "drs") {
    const template = control === "push-to-pass" ? pushToPassTemplate : drsTemplate;
    const colors = resolveIconColors(template, getGlobalColors(), settings.colorOverrides) as Record<string, string>;
    const activeValue = control === "push-to-pass" ? telemetryState?.pushToPassActive : telemetryState?.drsActive;
    const iconContent = control === "push-to-pass" ? pushToPassIcon(activeValue) : drsIcon(activeValue);
    const toggleState: "on" | "off" | "na" = activeValue === undefined ? "na" : activeValue ? "on" : "off";

    const resolvedTitle = resolveTitleSettings(template, getGlobalTitleSettings(), settings.titleOverrides);

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

    const border = resolveBorderSettings(
      template,
      getGlobalBorderSettings(),
      settings.borderOverrides,
      borderColorForState(toggleState),
    );
    const borderSvg = generateBorderParts(border);

    // Status bar is always visible, even when Show Graphics is off
    const svg = renderIconTemplate(template, {
      iconContent,
      titleContent,
      borderDefs: borderSvg.defs,
      borderContent: borderSvg.rects,
      ...colors,
    });

    return svgToDataUri(svg);
  }

  // Enter/Exit/Tow uses state-specific standalone SVGs
  if (control === "enter-exit-tow") {
    const towState = telemetryState?.enterExitTowState ?? "enter-car";
    const iconSvg = ENTER_EXIT_TOW_ICONS[towState];
    const defaultTitle = ENTER_EXIT_TOW_TITLES[towState];

    const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
    const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);
    const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

    const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

    return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
  }

  // Static modes use standalone SVGs from @iracedeck/icons
  const iconSvg = STATIC_CAR_CONTROL_ICONS[control] || starterIcon;
  const defaultTitle = CAR_CONTROL_STATIC_TITLES[control] ?? CAR_CONTROL_STATIC_TITLES["starter"]!;

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
}

/** Bounding box for pit-limiter dynamic content (derived from circle r=38 centered at 72,46) */
const DYNAMIC_ICON_BOUNDS = { x: 34, y: 8, width: 76, height: 76 };

function renderDynamicIcon(
  settings: CarControlSettings,
  iconContent: string,
  border: { defs: string; rects: string },
): string {
  const labels = CAR_CONTROL_LABELS[settings.control] || CAR_CONTROL_LABELS["starter"];
  const defaultTitle = `${labels.line2}\n${labels.line1}`;

  const colors = resolveIconColors(carControlTemplate, getGlobalColors(), settings.colorOverrides);
  const resolvedTitle = resolveTitleSettings(
    carControlTemplate,
    getGlobalTitleSettings(),
    settings.titleOverrides,
    defaultTitle,
  );

  let scaledContent = resolvedTitle.showGraphics ? iconContent : "";

  if (scaledContent) {
    const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);
    scaledContent = applyGraphicTransform(
      scaledContent,
      DYNAMIC_ICON_BOUNDS,
      computeGraphicArea(resolvedTitle),
      graphic.scale,
    );
  }

  const titleContent = resolvedTitle.showTitle
    ? generateTitleText({
        text: resolvedTitle.titleText,
        fontSize: resolvedTitle.fontSize,
        bold: resolvedTitle.bold,
        position: resolvedTitle.position,
        customPosition: resolvedTitle.customPosition,
        fill: colors.textColor ?? "#ffffff",
      })
    : "";

  const svg = renderIconTemplate(carControlTemplate, {
    iconContent: scaledContent,
    titleContent,
    borderDefs: border.defs,
    borderContent: border.rects,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Car Control Action
 * Provides core car operation controls (starter, ignition, pit limiter, enter/exit/tow, pause,
 * headlight flash, push to pass, DRS, tear off visor, escape).
 * Starter, headlight flash, and enter/exit/tow use long-press (hold while pressed); all others use tap.
 * Escape uses direct keyboard (hardcoded ESC key) with optional auto-hold.
 */
export const CAR_CONTROL_UUID = "com.iracedeck.sd.core.car-control" as const;

export class CarControl extends ConnectionStateAwareAction<CarControlSettings> {
  /** Settings per action context for telemetry-driven updates */
  private activeContexts = new Map<string, CarControlSettings>();

  /** State hash cache to prevent re-rendering every telemetry tick */
  private lastState = new Map<string, string>();

  /** Auto-hold release timers per action context (escape auto-hold mode) */
  private autoHoldTimers = new Map<string, ReturnType<typeof setTimeout>>();

  override async onWillAppear(ev: IDeckWillAppearEvent<CarControlSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    const globalKey = CAR_CONTROL_GLOBAL_KEYS[settings.control];

    if (globalKey) {
      this.setActiveBinding(globalKey);
    }

    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      const storedSettings = this.activeContexts.get(ev.action.id);

      if (storedSettings) {
        this.updateDisplayFromTelemetry(ev.action.id, telemetry, storedSettings);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<CarControlSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.control === "escape") {
      this.clearAutoHoldTimer(ev.action.id);
      await getKeyboard().releaseKeyCombination(ESC_KEY);
    } else {
      await this.releaseBinding(ev.action.id);
    }

    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<CarControlSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    const globalKey = CAR_CONTROL_GLOBAL_KEYS[settings.control];

    if (globalKey) {
      this.setActiveBinding(globalKey);
    }

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(ev.action.id, settings);
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Key up received");
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.control === "escape") {
      if (!settings.autoHold) {
        await getKeyboard().releaseKeyCombination(ESC_KEY);
      }

      return;
    }

    await this.releaseBinding(ev.action.id);
  }

  override async onDialDown(ev: IDeckDialDownEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(ev.action.id, settings);
  }

  override async onDialUp(ev: IDeckDialUpEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Dial up received");
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.control === "escape") {
      if (!settings.autoHold) {
        await getKeyboard().releaseKeyCombination(ESC_KEY);
      }

      return;
    }

    await this.releaseBinding(ev.action.id);
  }

  private parseSettings(settings: unknown): CarControlSettings {
    const parsed = CarControlSettings.safeParse(settings);

    return parsed.success ? parsed.data : CarControlSettings.parse({});
  }

  private async executeControl(actionId: string, settings: CarControlSettings): Promise<void> {
    if (settings.control === "escape") {
      await this.executeEscape(actionId, settings);

      return;
    }

    const settingKey = CAR_CONTROL_GLOBAL_KEYS[settings.control];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for control: ${settings.control}`);

      return;
    }

    if (HOLD_CONTROLS.has(settings.control)) {
      await this.holdBinding(actionId, settingKey);
    } else {
      await this.tapBinding(settingKey);
    }
  }

  private async executeEscape(actionId: string, settings: CarControlSettings): Promise<void> {
    const keyboard = getKeyboard();

    if (settings.autoHold) {
      // Second press while timer running: cancel and release immediately
      if (this.autoHoldTimers.has(actionId)) {
        this.logger.info("Escape auto-hold cancelled");
        this.clearAutoHoldTimer(actionId);
        await keyboard.releaseKeyCombination(ESC_KEY);

        return;
      }

      // First press: hold ESC, auto-release after timeout
      this.logger.info("Escape auto-hold started");
      await keyboard.pressKeyCombination(ESC_KEY);
      this.autoHoldTimers.set(
        actionId,
        setTimeout(() => {
          this.logger.info("Escape auto-hold released");
          void keyboard
            .releaseKeyCombination(ESC_KEY)
            .catch((err) => this.logger.error(`Escape auto-hold release failed: ${err}`))
            .finally(() => this.autoHoldTimers.delete(actionId));
        }, AUTO_HOLD_DURATION),
      );
    } else {
      // Manual hold: press on keyDown, release on keyUp
      this.logger.info("Escape pressed");
      await keyboard.pressKeyCombination(ESC_KEY);
    }
  }

  private clearAutoHoldTimer(actionId: string): void {
    const timer = this.autoHoldTimers.get(actionId);

    if (timer) {
      clearTimeout(timer);
      this.autoHoldTimers.delete(actionId);
    }
  }

  private getTelemetryState(telemetry: TelemetryData | null, control: CarControlType): CarControlTelemetryState {
    const state: CarControlTelemetryState = {};

    if (control === "pit-speed-limiter") {
      state.pitLimiterActive = isPitLimiterActive(telemetry);
      state.pitSpeedLimit = getPitSpeedLimit();
    } else if (control === "push-to-pass") {
      if (telemetry) state.pushToPassActive = isPushToPassActive(telemetry);
    } else if (control === "drs") {
      if (telemetry) state.drsActive = isDrsActive(telemetry);
    } else if (control === "enter-exit-tow") {
      const sessionInfo = this.sdkController.getSessionInfo();
      state.enterExitTowState = getEnterExitTowState(telemetry, sessionInfo);
    }

    return state;
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<CarControlSettings> | IDeckDidReceiveSettingsEvent<CarControlSettings>,
    settings: CarControlSettings,
  ): Promise<void> {
    const telemetry = this.sdkController.getCurrentTelemetry();
    const telemetryState = this.getTelemetryState(telemetry, settings.control);

    const svgDataUri = generateCarControlSvg(settings, telemetryState);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => {
      const currentTelemetry = this.sdkController.getCurrentTelemetry();
      const currentState = this.getTelemetryState(currentTelemetry, settings.control);

      return generateCarControlSvg(settings, currentState);
    });

    // Initialize state cache
    const stateKey = this.buildStateKey(settings, telemetryState);
    this.lastState.set(ev.action.id, stateKey);
  }

  private buildStateKey(settings: CarControlSettings, telemetryState: CarControlTelemetryState): string {
    const bo = settings.borderOverrides;
    const borderKey = `${bo?.enabled ?? ""}|${bo?.borderWidth ?? ""}|${bo?.borderColor ?? ""}|${bo?.glowEnabled ?? ""}|${bo?.glowWidth ?? ""}`;

    if (settings.control === "pit-speed-limiter") {
      return `pit-speed-limiter|${telemetryState.pitLimiterActive ?? false}|${telemetryState.pitSpeedLimit ?? DEFAULT_PIT_SPEED}|${borderKey}`;
    }

    if (settings.control === "push-to-pass") {
      return `push-to-pass|${telemetryState.pushToPassActive ?? "na"}|${borderKey}`;
    }

    if (settings.control === "drs") {
      return `drs|${telemetryState.drsActive ?? "na"}|${borderKey}`;
    }

    if (settings.control === "enter-exit-tow") {
      return `enter-exit-tow|${telemetryState.enterExitTowState ?? "enter-car"}|${borderKey}`;
    }

    return settings.control;
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: CarControlSettings,
  ): Promise<void> {
    if (!TELEMETRY_AWARE_CONTROLS.has(settings.control)) return;

    const telemetryState = this.getTelemetryState(telemetry, settings.control);
    const stateKey = this.buildStateKey(settings, telemetryState);
    const lastStateKey = this.lastState.get(contextId);

    if (lastStateKey !== stateKey) {
      this.lastState.set(contextId, stateKey);
      const svgDataUri = generateCarControlSvg(settings, telemetryState);
      await this.updateKeyImage(contextId, svgDataUri);
      this.setRegenerateCallback(contextId, () => {
        const currentTelemetry = this.sdkController.getCurrentTelemetry();
        const currentState = this.getTelemetryState(currentTelemetry, settings.control);

        return generateCarControlSvg(settings, currentState);
      });
    }
  }
}
