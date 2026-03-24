import {
  CommonSettings,
  ConnectionStateAwareAction,
  getGlobalColors,
  type IDeckDidReceiveSettingsEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "@iracedeck/deck-core";
import {
  DisplayUnits,
  type FlagInfo,
  type SessionInfo as IRacingSessionInfo,
  resolveActiveFlag,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import z from "zod";

import sessionInfoTemplate from "../../icons/session-info.svg";

const BACKGROUND_FLASH = "#e74c3c";

const FLASH_INTERVAL_MS = 250;
const FLASH_STEPS = 12; // on-off x6 (6 red flashes)

const PULSE_INTERVAL_MS = 500;

/** iRacing uses 604800s (7 days) as the sentinel for unlimited session time */
const UNLIMITED_TIME_THRESHOLD = 604800;

/** iRacing uses 32767 as the sentinel for unlimited laps */
const UNLIMITED_LAPS = 32767;

const LITERS_PER_GALLON = 3.78541;

const SessionInfoSettings = CommonSettings.extend({
  mode: z.enum(["incidents", "time-remaining", "laps", "position", "fuel", "flags"]).default("incidents"),
  positionShowTotal: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(false),
  fuelFormat: z.enum(["amount", "percentage"]).default("amount"),
});

type SessionInfoSettings = z.infer<typeof SessionInfoSettings>;

/**
 * @internal Exported for testing
 *
 * Formats a time in seconds to a human-readable string.
 * Auto-adapts: H:MM:SS / MM:SS / 0:SS
 */
export function formatSessionTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";

  const totalSeconds = Math.floor(seconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * @internal Exported for testing
 *
 * Formats a fuel amount for display. Respects the player's DisplayUnits setting.
 */
export function formatFuelAmount(fuelLevel: number, displayUnits: number | undefined): string {
  if (displayUnits === DisplayUnits.English) {
    const gallons = fuelLevel / LITERS_PER_GALLON;

    return `${gallons.toFixed(1)} gal`;
  }

  return `${fuelLevel.toFixed(1)} L`;
}

/**
 * @internal Exported for testing
 *
 * Counts the number of active drivers in the session using the DriverInfo.Drivers
 * array from session info. Filters out the pace car and spectators.
 *
 * This is more reliable than counting CarIdxPosition entries from telemetry,
 * which retains stale values for disconnected cars.
 */
export function countActiveDrivers(sessionInfo: IRacingSessionInfo | null): number {
  if (!sessionInfo) return 0;

  const driverInfo = sessionInfo.DriverInfo as { Drivers?: Array<Record<string, unknown>> } | undefined;
  const drivers = driverInfo?.Drivers;

  if (!Array.isArray(drivers)) return 0;

  return drivers.filter((d) => d.CarIsPaceCar !== 1 && d.IsSpectator !== 1).length;
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI for the session info display.
 */
export function generateSessionInfoSvg(
  settings: SessionInfoSettings,
  value: string,
  isFlashing: boolean,
  colorOverride?: { background: string; text: string },
): string {
  const titleLabels: Record<string, string> = {
    incidents: "INCIDENTS",
    "time-remaining": "TIME LEFT",
    laps: "LAPS",
    position: "POSITION",
    fuel: "FUEL",
    flags: "FLAGS",
  };
  const titleLabel = titleLabels[settings.mode] ?? "INCIDENTS";
  const valueFontSize = settings.mode === "incidents" ? "48" : value.length > 5 ? "28" : "36";
  const valueY = settings.mode === "incidents" ? "104" : "100";

  let backgroundColor: string;
  let textColor: string;

  if (colorOverride) {
    // Flag/flash override takes priority over all color settings
    backgroundColor = colorOverride.background;
    textColor = colorOverride.text;
  } else {
    const colors = resolveIconColors(sessionInfoTemplate, getGlobalColors(), settings.colorOverrides);
    backgroundColor = isFlashing ? BACKGROUND_FLASH : colors.backgroundColor;
    textColor = colors.textColor;
  }

  const svg = renderIconTemplate(sessionInfoTemplate, {
    backgroundColor,
    titleLabel,
    value,
    valueFontSize,
    valueY,
    textColor,
  });

  return svgToDataUri(svg);
}

/**
 * Session Info Action
 * Displays live telemetry data: incident points, session time remaining,
 * laps, position, fuel level, or race flags.
 * Incident count increase triggers a red flash effect.
 * Black and meatball flags trigger a continuous pulse effect.
 */
export const SESSION_INFO_UUID = "com.iracedeck.sd.core.session-info" as const;

export class SessionInfo extends ConnectionStateAwareAction<SessionInfoSettings> {
  /** Settings per action context for telemetry-driven updates */
  private activeContexts = new Map<string, SessionInfoSettings>();

  /** State hash cache to prevent re-rendering every telemetry tick */
  private lastState = new Map<string, string>();

  /** Last known incident count per context for flash detection */
  private lastIncidentCount = new Map<string, number>();

  /** Active flash timer IDs per context for cancellation */
  private flashTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Whether a context is currently in flash state */
  private flashStates = new Map<string, boolean>();

  /** Last resolved flag key per context for change detection */
  private lastFlagKey = new Map<string, string>();

  /** Active flag pulse interval IDs per context */
  private flagPulseTimers = new Map<string, ReturnType<typeof setInterval>>();

  override async onWillAppear(ev: IDeckWillAppearEvent<SessionInfoSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      const storedSettings = this.activeContexts.get(ev.action.id);

      if (storedSettings) {
        this.updateDisplayFromTelemetry(ev.action.id, telemetry, storedSettings);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SessionInfoSettings>): Promise<void> {
    this.cancelFlash(ev.action.id);
    this.cancelFlagPulse(ev.action.id);
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
    this.lastIncidentCount.delete(ev.action.id);
    this.flashStates.delete(ev.action.id);
    this.lastFlagKey.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SessionInfoSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.cancelFlash(ev.action.id);
    this.cancelFlagPulse(ev.action.id);
    this.lastIncidentCount.delete(ev.action.id);
    this.lastFlagKey.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
    await this.updateDisplay(ev, settings);
  }

  private parseSettings(settings: unknown): SessionInfoSettings {
    const parsed = SessionInfoSettings.safeParse(settings);

    return parsed.success ? parsed.data : SessionInfoSettings.parse({});
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<SessionInfoSettings> | IDeckDidReceiveSettingsEvent<SessionInfoSettings>,
    settings: SessionInfoSettings,
  ): Promise<void> {
    const telemetry = this.sdkController.getCurrentTelemetry();
    const value = this.extractDisplayValue(settings, telemetry);
    const isFlashing = this.flashStates.get(ev.action.id) ?? false;

    // Resolve flag colors for flags mode
    const colorOverride = this.resolveFlagColorOverride(settings, telemetry);

    const svgDataUri = generateSessionInfoSvg(settings, value, isFlashing, colorOverride);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);

    const stateKey = this.buildStateKey(settings, value, isFlashing, colorOverride?.background);
    this.lastState.set(ev.action.id, stateKey);

    // Initialize incident count baseline
    if (settings.mode === "incidents" && telemetry?.PlayerCarMyIncidentCount !== undefined) {
      this.lastIncidentCount.set(ev.action.id, telemetry.PlayerCarMyIncidentCount);
    }

    // Initialize flag baseline
    if (settings.mode === "flags") {
      const flagInfo = resolveActiveFlag(telemetry?.SessionFlags);
      this.lastFlagKey.set(ev.action.id, flagInfo?.label ?? "none");
    }
  }

  private extractDisplayValue(settings: SessionInfoSettings, telemetry: TelemetryData | null): string {
    if (!telemetry) {
      if (settings.mode === "incidents") return "--";

      if (settings.mode === "laps") return "-/-";

      if (settings.mode === "position") return settings.positionShowTotal ? "P-/-" : "P-";

      if (settings.mode === "fuel") return settings.fuelFormat === "percentage" ? "--%" : "-- L";

      if (settings.mode === "flags") return "--";

      return "--:--";
    }

    if (settings.mode === "incidents") {
      const count = telemetry.PlayerCarMyIncidentCount;

      return count !== undefined ? `${count}x` : "--";
    }

    if (settings.mode === "laps") {
      const lap = telemetry.Lap;
      const total = telemetry.SessionLapsTotal;

      if (lap === undefined || total === undefined) return "-/-";

      if (total >= UNLIMITED_LAPS) return `${lap}/\u221E`;

      return `${lap}/${total}`;
    }

    if (settings.mode === "position") {
      const pos = telemetry.PlayerCarPosition;

      if (pos === undefined) return settings.positionShowTotal ? "P-/-" : "P-";

      if (settings.positionShowTotal) {
        const totalCars = this.countActiveCars();

        return totalCars > 0 ? `P${pos}/${totalCars}` : `P${pos}`;
      }

      return `P${pos}`;
    }

    if (settings.mode === "fuel") {
      if (settings.fuelFormat === "percentage") {
        const pct = telemetry.FuelLevelPct;

        if (pct === undefined) return "--%";

        return `${Math.round(pct * 100)}%`;
      }

      const level = telemetry.FuelLevel;

      if (level === undefined) return "-- L";

      return formatFuelAmount(level, telemetry.DisplayUnits);
    }

    if (settings.mode === "flags") {
      const flagInfo = resolveActiveFlag(telemetry.SessionFlags);

      return flagInfo ? flagInfo.label : "--";
    }

    // time-remaining (default)
    const remain = telemetry.SessionTimeRemain;

    if (remain === undefined) return "--:--";

    if (remain >= UNLIMITED_TIME_THRESHOLD) return "UNLIM";

    return formatSessionTime(remain);
  }

  private countActiveCars(): number {
    return countActiveDrivers(this.sdkController.getSessionInfo());
  }

  private resolveFlagColorOverride(
    settings: SessionInfoSettings,
    telemetry: TelemetryData | null,
  ): { background: string; text: string } | undefined {
    if (settings.mode !== "flags") return undefined;

    const flagInfo = resolveActiveFlag(telemetry?.SessionFlags);

    if (!flagInfo) return undefined;

    return { background: flagInfo.color, text: flagInfo.textColor };
  }

  private buildStateKey(
    settings: SessionInfoSettings,
    value: string,
    isFlashing: boolean,
    bgOverride?: string,
  ): string {
    return `${settings.mode}|${value}|${isFlashing}|${bgOverride || ""}`;
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: SessionInfoSettings,
  ): Promise<void> {
    // Check for incident increase to trigger flash
    if (settings.mode === "incidents" && telemetry?.PlayerCarMyIncidentCount !== undefined) {
      const prevCount = this.lastIncidentCount.get(contextId);
      const currentCount = telemetry.PlayerCarMyIncidentCount;

      if (prevCount !== undefined && currentCount > prevCount) {
        this.logger.info("Incident count increased");
        this.logger.debug(`Incidents: ${prevCount} -> ${currentCount}`);
        this.startFlash(contextId, settings, telemetry);
      }

      this.lastIncidentCount.set(contextId, currentCount);
    }

    // Check for flag changes
    if (settings.mode === "flags") {
      const flagInfo = resolveActiveFlag(telemetry?.SessionFlags);
      const flagKey = flagInfo?.label ?? "none";
      const lastKey = this.lastFlagKey.get(contextId);

      if (flagKey !== lastKey) {
        this.logger.info("Flag changed");
        this.logger.debug(
          `Flag: ${lastKey} -> ${flagKey}, SessionFlags=0x${telemetry?.SessionFlags?.toString(16) ?? "undefined"}`,
        );
        this.lastFlagKey.set(contextId, flagKey);
        this.cancelFlagPulse(contextId);
        this.cancelFlash(contextId);

        if (flagInfo?.pulse) {
          this.startFlagPulse(contextId, settings, flagInfo);

          return;
        } else if (lastKey !== undefined && flagInfo) {
          this.startFlagColorFlash(contextId, settings, flagInfo);

          return;
        }
      }

      // If pulse or flash is active, let the timer handle rendering
      if (this.flagPulseTimers.has(contextId) || this.flashTimers.has(contextId)) return;
    }

    const value = this.extractDisplayValue(settings, telemetry);
    const isFlashing = this.flashStates.get(contextId) ?? false;
    const colorOverride = this.resolveFlagColorOverride(settings, telemetry);
    const stateKey = this.buildStateKey(settings, value, isFlashing, colorOverride?.background);
    const lastStateKey = this.lastState.get(contextId);

    if (lastStateKey !== stateKey) {
      this.lastState.set(contextId, stateKey);
      const svgDataUri = generateSessionInfoSvg(settings, value, isFlashing, colorOverride);
      await this.updateKeyImage(contextId, svgDataUri);
    }
  }

  private startFlash(contextId: string, settings: SessionInfoSettings, telemetry: TelemetryData | null): void {
    this.cancelFlash(contextId);

    let step = 0;

    const doStep = () => {
      if (!this.activeContexts.has(contextId)) return;

      const isRed = step % 2 === 0;
      this.flashStates.set(contextId, isRed);

      const value = this.extractDisplayValue(settings, telemetry);
      const stateKey = this.buildStateKey(settings, value, isRed);
      this.lastState.set(contextId, stateKey);

      const svgDataUri = generateSessionInfoSvg(settings, value, isRed);
      this.updateKeyImage(contextId, svgDataUri);

      step++;

      if (step < FLASH_STEPS) {
        this.flashTimers.set(contextId, setTimeout(doStep, FLASH_INTERVAL_MS));
      } else {
        // Flash sequence complete — reset to normal
        this.flashStates.set(contextId, false);
        this.flashTimers.delete(contextId);

        const finalValue = this.extractDisplayValue(settings, telemetry);
        const finalStateKey = this.buildStateKey(settings, finalValue, false);
        this.lastState.set(contextId, finalStateKey);

        const finalSvg = generateSessionInfoSvg(settings, finalValue, false);
        this.updateKeyImage(contextId, finalSvg);
      }
    };

    doStep();
  }

  private startFlagColorFlash(contextId: string, settings: SessionInfoSettings, flagInfo: FlagInfo): void {
    this.cancelFlash(contextId);

    let step = 0;

    const doStep = () => {
      if (!this.activeContexts.has(contextId)) return;

      const showFlagColor = step % 2 === 0;
      this.flashStates.set(contextId, showFlagColor);

      const telemetry = this.sdkController.getCurrentTelemetry();
      const value = this.extractDisplayValue(settings, telemetry);
      const colorOverride = showFlagColor ? { background: flagInfo.color, text: flagInfo.textColor } : undefined;
      const stateKey = this.buildStateKey(settings, value, showFlagColor, colorOverride?.background);
      this.lastState.set(contextId, stateKey);

      const svgDataUri = generateSessionInfoSvg(settings, value, showFlagColor, colorOverride);
      this.updateKeyImage(contextId, svgDataUri);

      step++;

      if (step < FLASH_STEPS) {
        this.flashTimers.set(contextId, setTimeout(doStep, FLASH_INTERVAL_MS));
      } else {
        // Flash complete — settle on flag color
        this.flashStates.set(contextId, false);
        this.flashTimers.delete(contextId);

        const finalTelemetry = this.sdkController.getCurrentTelemetry();
        const finalValue = this.extractDisplayValue(settings, finalTelemetry);
        const finalOverride = { background: flagInfo.color, text: flagInfo.textColor };
        const finalStateKey = this.buildStateKey(settings, finalValue, false, finalOverride.background);
        this.lastState.set(contextId, finalStateKey);

        const finalSvg = generateSessionInfoSvg(settings, finalValue, false, finalOverride);
        this.updateKeyImage(contextId, finalSvg);
      }
    };

    doStep();
  }

  private startFlagPulse(contextId: string, settings: SessionInfoSettings, flagInfo: FlagInfo): void {
    this.cancelFlagPulse(contextId);

    // Show flag color immediately
    const telemetry = this.sdkController.getCurrentTelemetry();
    const value = this.extractDisplayValue(settings, telemetry);
    const colorOverride = { background: flagInfo.color, text: flagInfo.textColor };
    const stateKey = this.buildStateKey(settings, value, true, colorOverride.background);
    this.lastState.set(contextId, stateKey);
    const svgDataUri = generateSessionInfoSvg(settings, value, false, colorOverride);
    this.updateKeyImage(contextId, svgDataUri);

    let pulseOn = true;

    const timer = setInterval(() => {
      if (!this.activeContexts.has(contextId)) {
        this.cancelFlagPulse(contextId);

        return;
      }

      pulseOn = !pulseOn;

      const currentTelemetry = this.sdkController.getCurrentTelemetry();
      const currentValue = this.extractDisplayValue(settings, currentTelemetry);
      const override = pulseOn ? { background: flagInfo.color, text: flagInfo.textColor } : undefined;
      const key = this.buildStateKey(settings, currentValue, pulseOn, override?.background);
      this.lastState.set(contextId, key);

      const svg = generateSessionInfoSvg(settings, currentValue, pulseOn, override);
      this.updateKeyImage(contextId, svg);
    }, PULSE_INTERVAL_MS);

    this.flagPulseTimers.set(contextId, timer);
  }

  private cancelFlash(contextId: string): void {
    const timer = this.flashTimers.get(contextId);

    if (timer) {
      clearTimeout(timer);
      this.flashTimers.delete(contextId);
    }

    this.flashStates.set(contextId, false);
  }

  private cancelFlagPulse(contextId: string): void {
    const timer = this.flagPulseTimers.get(contextId);

    if (timer) {
      clearInterval(timer);
      this.flagPulseTimers.delete(contextId);
    }
  }
}
