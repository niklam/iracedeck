import streamDeck, { action, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { TelemetryData } from "@iracedeck/iracing-sdk";
import { ConnectionStateAwareAction, createSDLogger, LogLevel } from "@iracedeck/stream-deck-shared";
import z from "zod";

/**
 * Display Gear Action
 * Displays current gear from iRacing telemetry
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.vehicle.display-gear" })
export class DisplayGear extends ConnectionStateAwareAction<GearSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("DisplayGear"), LogLevel.Info);

  private lastGearState = new Map<string, string>();

  /**
   * Generate SVG for the gear display
   */
  private generateSvg(gearText: string): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <g filter="url(#activity-state)">
    <!-- 6-speed + R (upper left) H-pattern gearbox -->
    <!-- Pattern fills top half (y 6 to 36), leaving bottom half for gear display -->
    <!-- Centered horizontally, 12px spacing between gates -->

    <!-- R gate (upper left, only above horizontal bar) -->
    <line x1="18" y1="6" x2="18" y2="21" stroke="#4a90d9" stroke-width="3" stroke-linecap="round"/>

    <!-- 1-2 gate (full height) -->
    <line x1="30" y1="6" x2="30" y2="36" stroke="#4a90d9" stroke-width="3" stroke-linecap="round"/>

    <!-- 3-4 gate (full height) -->
    <line x1="42" y1="6" x2="42" y2="36" stroke="#4a90d9" stroke-width="3" stroke-linecap="round"/>

    <!-- 5-6 gate (full height) -->
    <line x1="54" y1="6" x2="54" y2="36" stroke="#4a90d9" stroke-width="3" stroke-linecap="round"/>

    <!-- Horizontal connecting line -->
    <line x1="18" y1="21" x2="54" y2="21" stroke="#4a90d9" stroke-width="3" stroke-linecap="round"/>
    <text x="36" y="65" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-family="sans-serif" font-size="25" font-weight="bold">${gearText}</text>
  </g>
</svg>`;

    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  }

  /**
   * Get gear text from gear number
   */
  private getGearText(gear: number | null | undefined): string {
    if (gear === null || gear === undefined || typeof gear !== "number") {
      return "N/A";
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
