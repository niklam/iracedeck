import streamDeck, {
  action,
  DialDownEvent,
  DialUpEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  KeyUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import enterExitTowIcon from "@iracedeck/icons/car-control/enter-exit-tow.svg";
import ignitionIcon from "@iracedeck/icons/car-control/ignition.svg";
import pauseSimIcon from "@iracedeck/icons/car-control/pause-sim.svg";
import starterIcon from "@iracedeck/icons/car-control/starter.svg";
import { EngineWarnings, hasFlag, type TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import carControlTemplate from "../../icons/car-control.svg";
import {
  CommonSettings,
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  getGlobalSettings,
  getKeyboard,
  getSDK,
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
const RED = "#e74c3c";
const BLUE = "#3498db";

type CarControlType = "starter" | "ignition" | "pit-speed-limiter" | "enter-exit-tow" | "pause-sim";

/**
 * Label configuration for each car control (line1 bold, line2 subdued)
 */
const CAR_CONTROL_LABELS: Record<CarControlType, { line1: string; line2: string }> = {
  starter: { line1: "START", line2: "ENGINE" },
  ignition: { line1: "IGNITION", line2: "ON/OFF" },
  "pit-speed-limiter": { line1: "PIT", line2: "LIMITER" },
  "enter-exit-tow": { line1: "ENTER/EXIT", line2: "TOW" },
  "pause-sim": { line1: "PAUSE", line2: "SIM" },
};

const DEFAULT_PIT_SPEED = 80;

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
    <circle cx="36" cy="23" r="15" fill="${WHITE}" stroke="${BLUE}" stroke-width="4"/>
    <text x="36" y="28" text-anchor="middle" dominant-baseline="central"
          fill="#2a3a2a" font-family="Arial, sans-serif" font-size="14" font-weight="bold">${speed}</text>`;
}

/**
 * @internal Exported for testing
 *
 * Pit limiter icon content when INACTIVE (limiter off) — speed limit sign with red border.
 */
export function pitLimiterInactiveIcon(speed: number): string {
  return `
    <circle cx="36" cy="23" r="15" fill="${WHITE}" stroke="${RED}" stroke-width="4"/>
    <circle cx="36" cy="23" r="15" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <text x="36" y="28" text-anchor="middle" dominant-baseline="central"
          fill="#2a3a2a" font-family="Arial, sans-serif" font-size="14" font-weight="bold">${speed}</text>`;
}

/**
 * Standalone SVG templates for static car control modes (imported from @iracedeck/icons)
 */
const STATIC_CAR_CONTROL_ICONS: Partial<Record<CarControlType, string>> = {
  starter: starterIcon,
  ignition: ignitionIcon,
  "enter-exit-tow": enterExitTowIcon,
  "pause-sim": pauseSimIcon,
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

const CarControlSettings = CommonSettings.extend({
  control: z.enum(["starter", "ignition", "pit-speed-limiter", "enter-exit-tow", "pause-sim"]).default("starter"),
});

type CarControlSettings = z.infer<typeof CarControlSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the car control action.
 */
export function generateCarControlSvg(
  settings: CarControlSettings,
  pitLimiterActive?: boolean,
  pitSpeedLimit?: number,
): string {
  const { control } = settings;

  // Pit-speed-limiter uses the template approach (dynamic speed number)
  if (control === "pit-speed-limiter") {
    const speed = pitSpeedLimit ?? DEFAULT_PIT_SPEED;
    const iconContent =
      pitLimiterActive !== undefined && pitLimiterActive ? pitLimiterActiveIcon(speed) : pitLimiterInactiveIcon(speed);

    const labels = CAR_CONTROL_LABELS["pit-speed-limiter"];

    const svg = renderIconTemplate(carControlTemplate, {
      iconContent,
      mainLabel: labels.line1,
      subLabel: labels.line2,
    });

    return svgToDataUri(svg);
  }

  // Static modes use standalone SVGs from @iracedeck/icons
  const iconSvg = STATIC_CAR_CONTROL_ICONS[control] || starterIcon;
  const labels = CAR_CONTROL_LABELS[control] || CAR_CONTROL_LABELS["starter"];

  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.line1,
    subLabel: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Car Control Action
 * Provides core car operation controls (starter, ignition, pit limiter, enter/exit/tow, pause).
 * Starter uses long-press (hold to crank); all others use tap.
 */
@action({ UUID: "com.iracedeck.sd.core.car-control" })
export class CarControl extends ConnectionStateAwareAction<CarControlSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("CarControl"), LogLevel.Info);

  /** Currently held key combinations per action context, tracked for cleanup on release/disappear */
  private heldCombinations = new Map<string, KeyCombination>();

  /** Settings per action context for telemetry-driven updates */
  private activeContexts = new Map<string, CarControlSettings>();

  /** State hash cache to prevent re-rendering every telemetry tick */
  private lastState = new Map<string, string>();

  override async onWillAppear(ev: WillAppearEvent<CarControlSettings>): Promise<void> {
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

  override async onWillDisappear(ev: WillDisappearEvent<CarControlSettings>): Promise<void> {
    await this.releaseHeldKey(ev.action.id);
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CarControlSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(ev.action.id, settings);
  }

  override async onKeyUp(ev: KeyUpEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Key up received");
    await this.releaseHeldKey(ev.action.id);
  }

  override async onDialDown(ev: DialDownEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(ev.action.id, settings);
  }

  override async onDialUp(ev: DialUpEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Dial up received");
    await this.releaseHeldKey(ev.action.id);
  }

  private parseSettings(settings: unknown): CarControlSettings {
    const parsed = CarControlSettings.safeParse(settings);

    return parsed.success ? parsed.data : CarControlSettings.parse({});
  }

  private async executeControl(actionId: string, settings: CarControlSettings): Promise<void> {
    if (settings.control === "starter") {
      await this.pressAndHold(actionId, settings.control);
    } else {
      await this.tapControl(settings.control);
    }
  }

  private async pressAndHold(actionId: string, control: CarControlType): Promise<void> {
    const resolved = this.resolveCombination(control);

    if (!resolved) {
      return;
    }

    const { combination, binding } = resolved;

    const success = await getKeyboard().pressKeyCombination(combination);

    if (success) {
      this.heldCombinations.set(actionId, combination);
      this.logger.info("Key pressed (holding)");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to press key");
    }
  }

  private async tapControl(control: CarControlType): Promise<void> {
    const resolved = this.resolveCombination(control);

    if (!resolved) {
      return;
    }

    const { combination, binding } = resolved;

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

  private resolveCombination(
    control: CarControlType,
  ): { combination: KeyCombination; binding: KeyBindingValue } | null {
    const settingKey = CAR_CONTROL_GLOBAL_KEYS[control];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for control: ${control}`);

      return null;
    }

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return null;
    }

    return {
      combination: {
        key: binding.key as KeyboardKey,
        modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
        code: binding.code,
      },
      binding,
    };
  }

  private async updateDisplay(
    ev: WillAppearEvent<CarControlSettings> | DidReceiveSettingsEvent<CarControlSettings>,
    settings: CarControlSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const telemetry = this.sdkController.getCurrentTelemetry();
    const pitLimiterState = settings.control === "pit-speed-limiter" ? isPitLimiterActive(telemetry) : undefined;
    const pitSpeedLimit = settings.control === "pit-speed-limiter" ? getPitSpeedLimit() : undefined;

    const svgDataUri = generateCarControlSvg(settings, pitLimiterState, pitSpeedLimit);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);

    // Initialize state cache
    const stateKey = this.buildStateKey(settings, pitLimiterState ?? false, pitSpeedLimit);
    this.lastState.set(ev.action.id, stateKey);
  }

  private buildStateKey(settings: CarControlSettings, pitLimiterActive: boolean, pitSpeedLimit?: number): string {
    if (settings.control === "pit-speed-limiter") {
      return `pit-speed-limiter|${pitLimiterActive}|${pitSpeedLimit ?? DEFAULT_PIT_SPEED}`;
    }

    return settings.control;
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: CarControlSettings,
  ): Promise<void> {
    if (settings.control !== "pit-speed-limiter") return;

    const active = isPitLimiterActive(telemetry);
    const pitSpeedLimit = getPitSpeedLimit();
    const stateKey = this.buildStateKey(settings, active, pitSpeedLimit);
    const lastStateKey = this.lastState.get(contextId);

    if (lastStateKey !== stateKey) {
      this.lastState.set(contextId, stateKey);
      const svgDataUri = generateCarControlSvg(settings, active, pitSpeedLimit);
      await this.updateKeyImage(contextId, svgDataUri);
    }
  }
}
