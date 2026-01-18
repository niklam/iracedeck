import streamDeck, { action, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { TelemetryData } from "@iracedeck/iracing-sdk";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "@iracedeck/stream-deck-shared";
import z from "zod";

import displayGearTemplate from "../../icons/display-gear.svg";

/**
 * Display Gear Action
 * Displays current gear from iRacing telemetry
 */
@action({ UUID: "com.iracedeck.sd.vehicle.display-gear" })
export class DisplayGear extends ConnectionStateAwareAction<GearSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("DisplayGear"), LogLevel.Info);

  private lastGearState = new Map<string, string>();

  /**
   * Generate SVG for the gear display
   */
  private generateSvg(gearText: string): string {
    const svg = renderIconTemplate(displayGearTemplate, { gearText });

    return svgToDataUri(svg);
  }

  /**
   * Get gear text from gear number
   */
  private getGearText(gear: number | null | undefined): string {
    if (gear === null || gear === undefined || typeof gear !== "number") {
      return "N";
    }

    if (gear === -1) {
      return "R";
    } else if (gear === 0) {
      return "N";
    } else {
      return gear.toString();
    }
  }

  override async onWillAppear(ev: WillAppearEvent<GearSettings>): Promise<void> {
    // Update connection state for initial overlay
    this.updateConnectionState();

    // Set initial display (show N/A until we get telemetry)
    const svgDataUri = this.generateSvg("N/A");
    await this.setKeyImage(ev, svgDataUri);

    // Subscribe to telemetry updates
    this.sdkController.subscribe(ev.action.id, (telemetry, isConnected) => {
      this.updateConnectionState();
      this.updateDisplay(ev.action.id, telemetry, isConnected);
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<GearSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.lastGearState.delete(ev.action.id);
  }

  private async updateDisplay(contextId: string, telemetry: TelemetryData | null, isConnected: boolean): Promise<void> {
    let gearText = "N/A";

    if (isConnected && telemetry) {
      gearText = this.getGearText(telemetry.Gear);
    }

    const lastState = this.lastGearState.get(contextId);

    if (lastState !== gearText) {
      this.lastGearState.set(contextId, gearText);
      const svgDataUri = this.generateSvg(gearText);
      await this.updateKeyImage(contextId, svgDataUri);
    }
  }
}

const GearSettings = z.object({});

/**
 * Settings for the gear display action
 */
type GearSettings = z.infer<typeof GearSettings>;
