import streamDeck, {
  action,
  DialDownEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import clearTiresIconSvg from "@iracedeck/icons/tire-service/clear-tires.svg";
import { hasFlag, PitSvFlags, TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import tireServiceTemplate from "../../icons/tire-service.svg";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  generateIconText,
  getCommands,
  getSDK,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";

const GRAY = "#888888";
const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const YELLOW = "#f1c40f";
const RED = "#e74c3c";
const BLUE = "#3498db";

/** F1-style compound color mapping */
const COMPOUND_COLORS: Record<string, string> = {
  hard: WHITE,
  medium: YELLOW,
  soft: RED,
  intermediate: GREEN,
  wet: BLUE,
};

const DEFAULT_TIRES: DriverTire[] = [{ TireIndex: 0, TireCompoundType: "Dry" }];

type DriverTire = { TireIndex: number; TireCompoundType: string };

const TireServiceSettings = z.object({
  action: z.enum(["toggle-tires", "change-compound", "clear-tires"]).default("toggle-tires"),
  lf: z.coerce.boolean().default(true),
  rf: z.coerce.boolean().default(true),
  lr: z.coerce.boolean().default(true),
  rr: z.coerce.boolean().default(true),
});

type TireServiceSettings = z.infer<typeof TireServiceSettings>;

/**
 * @internal Exported for testing
 *
 * Get available tire compounds from session info.
 * Returns the DriverTires array from the first driver, or a single "Hard" fallback.
 */
export function getDriverTires(): DriverTire[] {
  try {
    const sessionInfo = getSDK().sdk.getSessionInfo();
    const driverInfo = sessionInfo?.DriverInfo as Record<string, unknown> | undefined;
    const drivers = driverInfo?.Drivers as Array<Record<string, unknown>> | undefined;
    const tires = drivers?.[0]?.DriverTires as DriverTire[] | undefined;

    return tires && tires.length > 0 ? tires : DEFAULT_TIRES;
  } catch {
    return DEFAULT_TIRES;
  }
}

/**
 * @internal Exported for testing
 *
 * Get F1-style color for a compound type. Case-insensitive. Falls back to gray.
 */
export function getCompoundColor(compoundType: string): string {
  return COMPOUND_COLORS[compoundType.toLowerCase()] ?? GRAY;
}

/**
 * @internal Exported for testing
 *
 * Get display name for a compound index.
 * - 1 compound: use its actual name, uppercased
 * - 2 compounds with one "Wet": the non-wet compound is "DRY", the wet is "WET"
 * - 3+ compounds: use the actual compound type name
 */
export function getCompoundName(compound: number): string {
  const tires = getDriverTires();
  const tire = tires.find((t) => t.TireIndex === compound);
  const typeName = tire?.TireCompoundType ?? "Dry";

  if (tires.length === 1) {
    return typeName.toUpperCase();
  }

  if (tires.length === 2 && tires.some((t) => t.TireCompoundType.toLowerCase() === "wet")) {
    return typeName.toLowerCase() === "wet" ? "WET" : "DRY";
  }

  return typeName;
}

/**
 * @internal Exported for testing
 *
 * Generate a simple colored tire icon for a compound type.
 */
export function generateTireIcon(compoundType: string): string {
  const color = getCompoundColor(compoundType);

  return `
    <circle cx="36" cy="22" r="12" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="2"/>
    <circle cx="36" cy="22" r="5" fill="${GRAY}" stroke="${GRAY}" stroke-width="1"/>`;
}

/**
 * Get tire fill color based on settings and current state.
 * Black: not configured (nothing happens on press).
 * Red: configured and currently OFF (will turn ON on press).
 * Green: configured and currently ON (will turn OFF on press).
 */
function getTireColor(isConfigured: boolean, isCurrentlyOn: boolean): string {
  if (!isConfigured) return "#000000ff";

  if (isCurrentlyOn) return "#44FF44";

  return "#FF4444";
}

/**
 * Get current tire change state from telemetry flags.
 */
function getTireState(telemetry: TelemetryData | null): {
  lf: boolean;
  rf: boolean;
  lr: boolean;
  rr: boolean;
} {
  if (!telemetry || telemetry.PitSvFlags === undefined) {
    return { lf: false, rf: false, lr: false, rr: false };
  }

  const flags = telemetry.PitSvFlags;

  return {
    lf: hasFlag(flags, PitSvFlags.LFTireChange),
    rf: hasFlag(flags, PitSvFlags.RFTireChange),
    lr: hasFlag(flags, PitSvFlags.LRTireChange),
    rr: hasFlag(flags, PitSvFlags.RRTireChange),
  };
}

/**
 * Get tire compound info from telemetry.
 * playerCompound: tires currently on the car.
 * pitSvCompound: compound selected for the next pit stop.
 */
function getCompoundState(telemetry: TelemetryData | null): { player: number; pitSv: number } {
  return {
    player: telemetry?.PlayerTireCompound ?? 0,
    pitSv: telemetry?.PitSvTireCompound ?? 0,
  };
}

/**
 * @internal Exported for testing
 *
 * Builds a pit macro string to toggle the configured tires.
 * Returns null if no tires are configured.
 */
export function buildTireToggleMacro(settings: TireServiceSettings): string | null {
  const parts: string[] = [];

  if (settings.lf) parts.push("!lf");

  if (settings.rf) parts.push("!rf");

  if (settings.lr) parts.push("!lr");

  if (settings.rr) parts.push("!rr");

  return parts.length > 0 ? `#${parts.join(" ")}` : null;
}

/**
 * @internal Exported for testing
 *
 * Generates the car body SVG content with colored tires for the toggle-tires action.
 */
function generateToggleTiresIconContent(
  settings: TireServiceSettings,
  currentState: { lf: boolean; rf: boolean; lr: boolean; rr: boolean },
): string {
  const lfColor = getTireColor(settings.lf ?? false, currentState.lf);
  const rfColor = getTireColor(settings.rf ?? false, currentState.rf);
  const lrColor = getTireColor(settings.lr ?? false, currentState.lr);
  const rrColor = getTireColor(settings.rr ?? false, currentState.rr);

  return `
    <rect x="26" y="6" width="20" height="32" rx="3" fill="none" stroke="${GRAY}" stroke-width="2"/>
    <rect x="14" y="8" width="8" height="10" rx="1.5" fill="${lfColor}" stroke="${GRAY}" stroke-width="1"/>
    <rect x="50" y="8" width="8" height="10" rx="1.5" fill="${rfColor}" stroke="${GRAY}" stroke-width="1"/>
    <rect x="14" y="26" width="8" height="10" rx="1.5" fill="${lrColor}" stroke="${GRAY}" stroke-width="1"/>
    <rect x="50" y="26" width="8" height="10" rx="1.5" fill="${rrColor}" stroke="${GRAY}" stroke-width="1"/>`;
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the tire service based on settings and current tire state.
 */
export function generateTireServiceSvg(
  settings: TireServiceSettings,
  currentState: { lf: boolean; rf: boolean; lr: boolean; rr: boolean },
  compoundState: { player: number; pitSv: number } = { player: 0, pitSv: 0 },
): string {
  let iconContent: string;
  let textElement: string;

  switch (settings.action) {
    case "change-compound": {
      const compoundType = getCompoundName(compoundState.pitSv);
      const isChanging = compoundState.player !== compoundState.pitSv;

      iconContent = generateTireIcon(compoundType);

      if (isChanging) {
        textElement = [
          generateIconText({ text: `Change to`, fontSize: 9, fill: YELLOW, baseY: 50 }),
          generateIconText({ text: compoundType, fontSize: 12, fill: YELLOW, baseY: 63 }),
        ].join("\n");
      } else {
        textElement = [
          generateIconText({ text: `Stay on`, fontSize: 9, fill: "#ffffff", baseY: 50 }),
          generateIconText({ text: compoundType, fontSize: 12, fill: "#ffffff", baseY: 63 }),
        ].join("\n");
      }

      break;
    }
    case "clear-tires": {
      const svg = renderIconTemplate(clearTiresIconSvg, {
        mainLabel: "CLEAR",
        subLabel: "TIRES",
      });

      return svgToDataUri(svg);
    }
    default: {
      iconContent = generateToggleTiresIconContent(settings, currentState);

      const anyTireOn =
        (settings.lf && currentState.lf) ||
        (settings.rf && currentState.rf) ||
        (settings.lr && currentState.lr) ||
        (settings.rr && currentState.rr);

      const titleText = anyTireOn ? "Change" : "No Change";
      const titleColor = anyTireOn ? "#FFFFFF" : "#FF4444";

      textElement = generateIconText({ text: titleText, fontSize: 12, fill: titleColor });
      break;
    }
  }

  const svg = renderIconTemplate(tireServiceTemplate, {
    iconContent,
    textElement,
  });

  return svgToDataUri(svg);
}

/**
 * Tire Service
 * Manages tire pit service: toggle tire changes, change compound, or clear tire selections.
 * Toggle mode: dynamic icon shows car with tire colors based on current iRacing state.
 * Green = will be changed, Red = configured but not active, Black = not configured.
 */
@action({ UUID: "com.iracedeck.sd.core.tire-service" })
export class TireService extends ConnectionStateAwareAction<TireServiceSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("TireService"), LogLevel.Info);

  private activeContexts = new Map<string, TireServiceSettings>();
  private lastState = new Map<string, string>();

  override async onWillAppear(ev: WillAppearEvent<TireServiceSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);

    await this.updateDisplayWithEvent(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      this.updateConnectionState();

      const storedSettings = this.activeContexts.get(ev.action.id);

      if (storedSettings) {
        this.updateDisplayFromTelemetry(ev.action.id, telemetry, storedSettings);
      }
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<TireServiceSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<TireServiceSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);

    const telemetry = this.sdkController.getCurrentTelemetry();
    const tireState = getTireState(telemetry);
    const compound = getCompoundState(telemetry);

    this.updateConnectionState();

    const svgDataUri = generateTireServiceSvg(settings, tireState, compound);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);

    const stateKey = this.buildStateKey(settings, tireState, compound);
    this.lastState.set(ev.action.id, stateKey);
  }

  override async onKeyDown(ev: KeyDownEvent<TireServiceSettings>): Promise<void> {
    this.logger.info("Key down received");
    this.executeAction(ev.payload.settings);
  }

  override async onDialDown(ev: DialDownEvent<TireServiceSettings>): Promise<void> {
    this.logger.info("Dial down received");
    this.executeAction(ev.payload.settings);
  }

  private parseSettings(settings: unknown): TireServiceSettings {
    const parsed = TireServiceSettings.safeParse(settings);

    return parsed.success ? parsed.data : TireServiceSettings.parse({});
  }

  private async updateDisplayWithEvent(
    ev: WillAppearEvent<TireServiceSettings>,
    settings: TireServiceSettings,
  ): Promise<void> {
    const telemetry = this.sdkController.getCurrentTelemetry();
    const tireState = getTireState(telemetry);
    const compound = getCompoundState(telemetry);

    this.updateConnectionState();

    const svgDataUri = generateTireServiceSvg(settings, tireState, compound);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);

    const stateKey = this.buildStateKey(settings, tireState, compound);
    this.lastState.set(ev.action.id, stateKey);
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: TireServiceSettings,
  ): Promise<void> {
    const tireState = getTireState(telemetry);
    const compound = getCompoundState(telemetry);
    const stateKey = this.buildStateKey(settings, tireState, compound);
    const lastStateKey = this.lastState.get(contextId);

    if (lastStateKey !== stateKey) {
      this.lastState.set(contextId, stateKey);
      const svgDataUri = generateTireServiceSvg(settings, tireState, compound);
      await this.updateKeyImage(contextId, svgDataUri);
    }
  }

  private buildStateKey(
    settings: TireServiceSettings,
    tireState: { lf: boolean; rf: boolean; lr: boolean; rr: boolean },
    compound: { player: number; pitSv: number },
  ): string {
    const tires = getDriverTires();
    const compoundType = getCompoundName(compound.pitSv);

    return `${settings.action}|${settings.lf}|${settings.rf}|${settings.lr}|${settings.rr}|${tireState.lf}|${tireState.rf}|${tireState.lr}|${tireState.rr}|${compound.player}|${compound.pitSv}|${tires.length}|${compoundType}`;
  }

  private executeAction(rawSettings: unknown): void {
    if (!this.sdkController.getConnectionStatus()) {
      this.logger.info("Not connected to iRacing");

      return;
    }

    const settings = this.parseSettings(rawSettings);

    switch (settings.action) {
      case "change-compound": {
        const telemetry = this.sdkController.getCurrentTelemetry();
        const { pitSv } = getCompoundState(telemetry);
        const compounds = getDriverTires();
        const nextIndex = (pitSv + 1) % compounds.length;

        this.logger.debug(`Changing compound from ${getCompoundName(pitSv)} to ${getCompoundName(nextIndex)}`);
        const success = getCommands().pit.tireCompound(nextIndex);

        if (success) {
          this.logger.info("Tire compound change sent");
        } else {
          this.logger.warn("Failed to send tire compound change");
        }

        break;
      }
      case "clear-tires": {
        this.logger.debug("Sending clear tires");
        const success = getCommands().pit.clearTires();

        if (success) {
          this.logger.info("Clear tires sent");
        } else {
          this.logger.warn("Failed to send clear tires");
        }

        break;
      }
      default: {
        const macro = buildTireToggleMacro(settings);

        if (!macro) {
          this.logger.warn("No tires configured");

          return;
        }

        this.logger.debug(`Sending pit macro: ${macro}`);
        const success = getCommands().chat.sendMessage(macro);

        if (success) {
          this.logger.info("Tire toggle sent");
        } else {
          this.logger.warn("Failed to send tire toggle");
        }

        break;
      }
    }
  }
}
