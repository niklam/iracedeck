import streamDeck, {
  action,
  DialDownEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import { hasFlag, PitSvFlags, TelemetryData } from "@iracedeck/iracing-sdk";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  generateIconText,
  getCommands,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "@iracedeck/stream-deck-shared";
import z from "zod";

import tireServiceTemplate from "../../icons/tire-service.svg";

const GRAY = "#888888";
const WHITE = "#ffffff";
const YELLOW = "#f1c40f";
const RED = "#e74c3c";

const TireServiceSettings = z.object({
  action: z.enum(["toggle-tires", "change-compound", "clear-tires"]).default("toggle-tires"),
  lf: z.coerce.boolean().default(true),
  rf: z.coerce.boolean().default(true),
  lr: z.coerce.boolean().default(true),
  rr: z.coerce.boolean().default(true),
});

type TireServiceSettings = z.infer<typeof TireServiceSettings>;

/**
 * SVG icon content for change-compound and clear-tires actions.
 */
const COMPOUND_ICON_CONTENT = `
    <circle cx="36" cy="24" r="10" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="24" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <path d="M28 36 L24 40 L28 44" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="24" y1="40" x2="48" y2="40" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round"/>
    <path d="M44 36 L48 32 L44 28" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="48" y1="32" x2="24" y2="32" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round"/>`;

const CLEAR_TIRES_ICON_CONTENT = `
    <circle cx="36" cy="26" r="10" fill="none" stroke="${WHITE}" stroke-width="1.5"/>
    <circle cx="36" cy="26" r="4" fill="none" stroke="${GRAY}" stroke-width="1"/>
    <line x1="29" y1="19" x2="43" y2="33" stroke="${RED}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="43" y1="19" x2="29" y2="33" stroke="${RED}" stroke-width="2.5" stroke-linecap="round"/>`;

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
): string {
  let iconContent: string;
  let textElement: string;

  switch (settings.action) {
    case "change-compound": {
      iconContent = COMPOUND_ICON_CONTENT;
      textElement = [
        generateIconText({ text: "TIRE", fontSize: 10, fill: "#ffffff", baseY: 52 }),
        generateIconText({ text: "COMPOUND", fontSize: 8, fill: "#aaaaaa", baseY: 63 }),
      ].join("\n");
      break;
    }
    case "clear-tires": {
      iconContent = CLEAR_TIRES_ICON_CONTENT;
      textElement = [
        generateIconText({ text: "CLEAR", fontSize: 10, fill: "#ffffff", baseY: 52 }),
        generateIconText({ text: "TIRES", fontSize: 8, fill: "#aaaaaa", baseY: 63 }),
      ].join("\n");
      break;
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

    this.updateConnectionState();

    const svgDataUri = generateTireServiceSvg(settings, tireState);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);

    const stateKey = this.buildStateKey(settings, tireState);
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

    this.updateConnectionState();

    const svgDataUri = generateTireServiceSvg(settings, tireState);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);

    const stateKey = this.buildStateKey(settings, tireState);
    this.lastState.set(ev.action.id, stateKey);
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: TireServiceSettings,
  ): Promise<void> {
    const tireState = getTireState(telemetry);
    const stateKey = this.buildStateKey(settings, tireState);
    const lastStateKey = this.lastState.get(contextId);

    if (lastStateKey !== stateKey) {
      this.lastState.set(contextId, stateKey);
      const svgDataUri = generateTireServiceSvg(settings, tireState);
      await this.updateKeyImage(contextId, svgDataUri);
    }
  }

  private buildStateKey(
    settings: TireServiceSettings,
    tireState: { lf: boolean; rf: boolean; lr: boolean; rr: boolean },
  ): string {
    return `${settings.action}|${settings.lf}|${settings.rf}|${settings.lr}|${settings.rr}|${tireState.lf}|${tireState.rf}|${tireState.lr}|${tireState.rr}`;
  }

  private executeAction(rawSettings: unknown): void {
    if (!this.sdkController.getConnectionStatus()) {
      this.logger.info("Not connected to iRacing");

      return;
    }

    const settings = this.parseSettings(rawSettings);

    switch (settings.action) {
      case "change-compound": {
        this.logger.debug("Sending tire compound change");
        const success = getCommands().pit.tireCompound(0);

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
