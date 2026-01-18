import streamDeck, { action, KeyDownEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { TelemetryData } from "@iracedeck/iracing-sdk";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "@iracedeck/stream-deck-shared";
import z from "zod";

import displaySpeedTemplate from "../../icons/display-speed.svg";

/**
 * Generate the speed display SVG with the given speed text.
 * Text is centered below the speedometer arc.
 */
function generateSpeedSvg(speedText: string): string {
  const svg = renderIconTemplate(displaySpeedTemplate, { speedText });

  return svgToDataUri(svg);
}

/**
 * Display Speed Action
 * Displays current speed from iRacing telemetry
 */
@action({ UUID: "com.iracedeck.sd.vehicle.display-speed" })
export class DisplaySpeed extends ConnectionStateAwareAction<SpeedSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("DisplaySpeed"), LogLevel.Info);

  private activeContexts = new Map<string, SpeedSettings>();
  private lastTitle = new Map<string, string>();

  override async onWillAppear(ev: WillAppearEvent<SpeedSettings>): Promise<void> {
    this.activeContexts.set(ev.action.id, ev.payload.settings);

    // Set initial image with "N/A" text
    await this.setKeyImage(ev, generateSpeedSvg("N/A"));

    this.sdkController.subscribe(ev.action.id, (telemetry, isConnected) => {
      // Update connection state for overlay
      this.updateConnectionState();

      const settings = this.activeContexts.get(ev.action.id);

      if (settings) {
        this.updateDisplay(ev.action.id, settings, telemetry, isConnected);
      }
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<SpeedSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastTitle.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: any): Promise<void> {
    this.activeContexts.set(ev.action.id, ev.payload.settings);
  }

  override async onKeyDown(ev: KeyDownEvent<SpeedSettings>): Promise<void> {
    const currentUnit = ev.payload.settings.unit || "mph";
    const newUnit: "mph" | "kph" = currentUnit === "mph" ? "kph" : "mph";

    const newSettings: SpeedSettings = {
      ...ev.payload.settings,
      unit: newUnit,
    };

    await ev.action.setSettings(newSettings);
    this.activeContexts.set(ev.action.id, newSettings);

    const telemetry = this.sdkController.getCurrentTelemetry();
    const isConnected = this.sdkController.getConnectionStatus();
    this.updateDisplay(ev.action.id, newSettings, telemetry, isConnected);
  }

  private async updateDisplay(
    contextId: string,
    settings: SpeedSettings,
    telemetry: TelemetryData | null,
    _isConnected: boolean,
  ): Promise<void> {
    // Default to N/A when no data available
    let speedText = "0";

    if (telemetry) {
      const speed = telemetry.Speed;

      if (speed !== null && speed !== undefined && typeof speed === "number") {
        const unit = settings.unit || "mph";
        let displaySpeed: number;

        if (unit === "kph") {
          displaySpeed = speed * 3.6;
        } else {
          displaySpeed = speed * 2.23694;
        }

        speedText = Math.round(displaySpeed).toString();
      }
    }

    const lastText = this.lastTitle.get(contextId);

    if (lastText !== speedText) {
      this.lastTitle.set(contextId, speedText);
      await this.updateKeyImage(contextId, generateSpeedSvg(speedText));
    }
  }
}

const SpeedSettings = z.object({
  unit: z.enum(["mph", "kph"]).default("mph"),
});

type SpeedSettings = z.infer<typeof SpeedSettings>;
