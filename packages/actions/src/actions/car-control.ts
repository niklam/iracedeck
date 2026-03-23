import {
  CommonSettings,
  ConnectionStateAwareAction,
  formatKeyBinding,
  getGlobalColors,
  getGlobalSettings,
  getKeyboard,
  getSDK,
  getSimHub,
  type IDeckDialDownEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  isSimHubBinding,
  isSimHubInitialized,
  type KeyBindingValue,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  parseBinding,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "@iracedeck/deck-core";
import enterExitTowIcon from "@iracedeck/icons/car-control/enter-exit-tow.svg";
import headlightFlashIcon from "@iracedeck/icons/car-control/headlight-flash.svg";
import ignitionIcon from "@iracedeck/icons/car-control/ignition.svg";
import pauseSimIcon from "@iracedeck/icons/car-control/pause-sim.svg";
import starterIcon from "@iracedeck/icons/car-control/starter.svg";
import tearOffVisorIcon from "@iracedeck/icons/car-control/tear-off-visor.svg";
import { EngineWarnings, hasFlag, type TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import carControlTemplate from "../../icons/car-control.svg";

const WHITE = "#ffffff";
const GRAY = "#888888";
const RED = "#e74c3c";
const GREEN = "#2ecc71";
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
  | "tear-off-visor";

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
};

const DEFAULT_PIT_SPEED = 80;

/**
 * Controls that use telemetry-driven dynamic icons.
 * Keep in sync with getTelemetryState() and buildStateKey().
 */
const TELEMETRY_AWARE_CONTROLS = new Set<CarControlType>(["pit-speed-limiter", "push-to-pass", "drs"]);

/** Controls that use hold pattern (press on keyDown, release on keyUp) */
const HOLD_CONTROLS = new Set<CarControlType>(["starter", "headlight-flash"]);

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
 * Status bar showing ON state — full-width green bar with "ON" text at the bottom.
 */
export function statusBarOn(): string {
  return `
    <rect x="0" y="100" width="144" height="44" fill="${GREEN}"/>
    <text x="72" y="129" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="20" font-weight="bold">ON</text>`;
}

/**
 * @internal Exported for testing
 *
 * Status bar showing OFF state — full-width dark gray bar with "OFF" text at the bottom.
 */
export function statusBarOff(): string {
  return `
    <rect x="0" y="100" width="144" height="44" fill="${RED}"/>
    <text x="72" y="129" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="20" font-weight="bold">OFF</text>`;
}

/**
 * @internal Exported for testing
 *
 * DRS icon — large centered "DRS" text with ON/OFF status bar at the bottom.
 */
export function drsIcon(active: boolean, graphic1Color = WHITE): string {
  const statusBar = active ? statusBarOn() : statusBarOff();

  return `
    <text x="72" y="68" text-anchor="middle" dominant-baseline="central"
          fill="${graphic1Color}" font-family="Arial, sans-serif" font-size="50" font-weight="bold">DRS</text>
    ${statusBar}`;
}

/**
 * @internal Exported for testing
 *
 * Push To Pass icon — "PUSH TO" / "PASS" on two lines with ON/OFF status bar at the bottom.
 */
export function pushToPassIcon(active: boolean, graphic1Color = WHITE): string {
  const statusBar = active ? statusBarOn() : statusBarOff();

  return `
    <text x="72" y="44" text-anchor="middle" dominant-baseline="central"
          fill="${graphic1Color}" font-family="Arial, sans-serif" font-size="22" font-weight="bold">PUSH TO</text>
    <text x="72" y="74" text-anchor="middle" dominant-baseline="central"
          fill="${graphic1Color}" font-family="Arial, sans-serif" font-size="22" font-weight="bold">PASS</text>
    ${statusBar}`;
}

/**
 * Standalone SVG templates for static car control modes (imported from @iracedeck/icons)
 */
const STATIC_CAR_CONTROL_ICONS: Partial<Record<CarControlType, string>> = {
  starter: starterIcon,
  ignition: ignitionIcon,
  "enter-exit-tow": enterExitTowIcon,
  "pause-sim": pauseSimIcon,
  "headlight-flash": headlightFlashIcon,
  "tear-off-visor": tearOffVisorIcon,
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
};

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
};

const CarControlSettings = CommonSettings.extend({
  control: z
    .enum([
      "starter",
      "ignition",
      "pit-speed-limiter",
      "enter-exit-tow",
      "pause-sim",
      "headlight-flash",
      "push-to-pass",
      "drs",
      "tear-off-visor",
    ])
    .default("starter"),
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
    const iconContent =
      telemetryState?.pitLimiterActive !== undefined && telemetryState.pitLimiterActive
        ? pitLimiterActiveIcon(speed)
        : pitLimiterInactiveIcon(speed);

    return renderDynamicIcon(settings, iconContent);
  }

  // Push To Pass and DRS use dedicated full-icon layouts (no mainLabel/subLabel)
  if (control === "push-to-pass" || control === "drs") {
    const colors = resolveIconColors(carControlTemplate, getGlobalColors(), settings.colorOverrides) as Record<
      string,
      string
    >;
    const graphic1 = colors.graphic1Color || settings.colorOverrides?.graphic1Color || WHITE;
    const iconContent =
      control === "push-to-pass"
        ? pushToPassIcon(telemetryState?.pushToPassActive ?? false, graphic1)
        : drsIcon(telemetryState?.drsActive ?? false, graphic1);

    return renderDynamicIcon(settings, iconContent, false);
  }

  // Static modes use standalone SVGs from @iracedeck/icons
  const iconSvg = STATIC_CAR_CONTROL_ICONS[control] || starterIcon;
  const labels = CAR_CONTROL_LABELS[control] || CAR_CONTROL_LABELS["starter"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.line1,
    subLabel: labels.line2,
    ...colors,
  });

  return svgToDataUri(svg);
}

function renderDynamicIcon(settings: CarControlSettings, iconContent: string, showLabels = true): string {
  const labels = showLabels
    ? CAR_CONTROL_LABELS[settings.control] || CAR_CONTROL_LABELS["starter"]
    : { line1: "", line2: "" };

  const colors = resolveIconColors(carControlTemplate, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(carControlTemplate, {
    iconContent,
    mainLabel: labels.line1,
    subLabel: labels.line2,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Car Control Action
 * Provides core car operation controls (starter, ignition, pit limiter, enter/exit/tow, pause,
 * headlight flash, push to pass, DRS, tear off visor).
 * Starter and headlight flash use long-press (hold while pressed); all others use tap.
 */
export const CAR_CONTROL_UUID = "com.iracedeck.sd.core.car-control" as const;

export class CarControl extends ConnectionStateAwareAction<CarControlSettings> {
  /** Currently held key combinations per action context, tracked for cleanup on release/disappear */
  private heldCombinations = new Map<string, KeyCombination>();

  /** Settings per action context for telemetry-driven updates */
  private activeContexts = new Map<string, CarControlSettings>();

  /** State hash cache to prevent re-rendering every telemetry tick */
  private lastState = new Map<string, string>();

  override async onWillAppear(ev: IDeckWillAppearEvent<CarControlSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      this.updateConnectionState();

      const storedSettings = this.activeContexts.get(ev.action.id);

      if (storedSettings) {
        this.updateDisplayFromTelemetry(ev.action.id, telemetry, storedSettings);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<CarControlSettings>): Promise<void> {
    await this.releaseHeldKey(ev.action.id);
    this.heldSimHubRoles.delete(ev.action.id);
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<CarControlSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(ev.action.id, settings);
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Key up received");
    await this.releaseHeldKey(ev.action.id);
  }

  override async onDialDown(ev: IDeckDialDownEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(ev.action.id, settings);
  }

  override async onDialUp(ev: IDeckDialUpEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Dial up received");
    await this.releaseHeldKey(ev.action.id);
  }

  private parseSettings(settings: unknown): CarControlSettings {
    const parsed = CarControlSettings.safeParse(settings);

    return parsed.success ? parsed.data : CarControlSettings.parse({});
  }

  /** Currently held SimHub roles per action context */
  private heldSimHubRoles = new Map<string, string>();

  private async executeControl(actionId: string, settings: CarControlSettings): Promise<void> {
    const settingKey = CAR_CONTROL_GLOBAL_KEYS[settings.control];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for control: ${settings.control}`);

      return;
    }

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseBinding(globalSettings[settingKey]);

    if (!binding) {
      this.logger.warn(`No binding configured for ${settingKey}`);

      return;
    }

    // SimHub path
    if (isSimHubBinding(binding)) {
      this.logger.info("Triggering SimHub role");
      this.logger.debug(`SimHub role: ${binding.role}`);

      if (!isSimHubInitialized()) {
        this.logger.warn("SimHub service not initialized");

        return;
      }

      const simHub = getSimHub();

      if (HOLD_CONTROLS.has(settings.control)) {
        // Hold: start on key-down, stop on key-up
        await simHub.startRole(binding.role);
        this.heldSimHubRoles.set(actionId, binding.role);
      } else {
        // Tap: start + stop immediately
        await simHub.startRole(binding.role);
        await simHub.stopRole(binding.role);
      }

      return;
    }

    // Keyboard path
    if (HOLD_CONTROLS.has(settings.control)) {
      await this.pressAndHold(actionId, binding);
    } else {
      await this.tapControl(binding);
    }
  }

  private async pressAndHold(actionId: string, binding: KeyBindingValue): Promise<void> {
    const combination = this.buildCombination(binding);
    const success = await getKeyboard().pressKeyCombination(combination);

    if (success) {
      this.heldCombinations.set(actionId, combination);
      this.logger.info("Key pressed (holding)");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to press key");
    }
  }

  private async tapControl(binding: KeyBindingValue): Promise<void> {
    const combination = this.buildCombination(binding);
    const success = await getKeyboard().sendKeyCombination(combination);

    if (success) {
      this.logger.info("Key sent successfully");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to send key");
      this.logger.debug(`Failed key combination: ${formatKeyBinding(binding)}`);
    }
  }

  private async releaseHeldKey(actionId: string): Promise<void> {
    // Release SimHub role if held
    const heldRole = this.heldSimHubRoles.get(actionId);

    if (heldRole) {
      this.heldSimHubRoles.delete(actionId);

      if (isSimHubInitialized()) {
        await getSimHub().stopRole(heldRole);
        this.logger.info("SimHub role released");
      }

      return;
    }

    // Release keyboard key if held
    const combination = this.heldCombinations.get(actionId);

    if (!combination) {
      return;
    }

    this.heldCombinations.delete(actionId);

    const success = await getKeyboard().releaseKeyCombination(combination);

    if (success) {
      this.logger.info("Key released");
    } else {
      this.logger.warn("Failed to release key");
    }
  }

  private buildCombination(binding: KeyBindingValue): KeyCombination {
    return {
      key: binding.key as KeyboardKey,
      modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
      code: binding.code,
    };
  }

  private getTelemetryState(telemetry: TelemetryData | null, control: CarControlType): CarControlTelemetryState {
    const state: CarControlTelemetryState = {};

    if (control === "pit-speed-limiter") {
      state.pitLimiterActive = isPitLimiterActive(telemetry);
      state.pitSpeedLimit = getPitSpeedLimit();
    } else if (control === "push-to-pass") {
      state.pushToPassActive = isPushToPassActive(telemetry);
    } else if (control === "drs") {
      state.drsActive = isDrsActive(telemetry);
    }

    return state;
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<CarControlSettings> | IDeckDidReceiveSettingsEvent<CarControlSettings>,
    settings: CarControlSettings,
  ): Promise<void> {
    this.updateConnectionState();

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
    if (settings.control === "pit-speed-limiter") {
      return `pit-speed-limiter|${telemetryState.pitLimiterActive ?? false}|${telemetryState.pitSpeedLimit ?? DEFAULT_PIT_SPEED}`;
    }

    if (settings.control === "push-to-pass") {
      return `push-to-pass|${telemetryState.pushToPassActive ?? false}`;
    }

    if (settings.control === "drs") {
      return `drs|${telemetryState.drsActive ?? false}`;
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
