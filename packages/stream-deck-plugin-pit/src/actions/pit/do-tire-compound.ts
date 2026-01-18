import streamDeck, { action, KeyDownEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { ConnectionStateAwareAction, createSDLogger, getCommands, LogLevel } from "@iracedeck/stream-deck-shared";
import z from "zod";

/**
 * Tire Compound Action
 * Displays the tire compound to be used at next pit stop (PitSvTireCompound)
 * Press to toggle between dry and wet compounds
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.pit.do-tire-compound" })
export class DoTireCompound extends ConnectionStateAwareAction<TireCompoundSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("DoTireCompound"), LogLevel.Info);

  private get pitCommand() {
    return getCommands().pit;
  }

  private activeContexts = new Map<string, TireCompoundSettings>();
  private lastSvgState = new Map<string, string>();

  /**
   * Generate SVG for the tire compound button
   * @param compound - 0 = Dry, 1 = Wet, null = N/A, -1 = not connected
   */
  private generateSvg(compound: number | null): string {
    let tireColor: string;
    let label: string;

    if (compound === -1) {
      // Not connected
      tireColor = "#666666";
      label = "N/A";
    } else if (compound === null) {
      // N/A
      tireColor = "#666666";
      label = "N/A";
    } else if (compound === 0) {
      // Dry
      tireColor = "#333333";
      label = "Dry";
    } else if (compound === 1) {
      // Wet
      tireColor = "#2980b9";
      label = "Wet";
    } else {
      // Unknown compound
      tireColor = "#666666";
      label = `TC:${compound}`;
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <g filter="url(#activity-state)">
    <!-- Tire outer -->
    <circle cx="36" cy="28" r="20" fill="${tireColor}" stroke="#ffffff" stroke-width="2"/>
    <!-- Tire inner (rim) -->
    <circle cx="36" cy="28" r="10" fill="#888888" stroke="#aaaaaa" stroke-width="1.5"/>
    <!-- Rim center -->
    <circle cx="36" cy="28" r="4" fill="#666666"/>
    <!-- Compound label -->
    <text class="title" x="36" y="65" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-family="sans-serif" font-size="16" font-weight="bold">${label}</text>
  </g>
</svg>`;

    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  }

  /**
   * When the action appears on the Stream Deck
   */
  override async onWillAppear(ev: WillAppearEvent<TireCompoundSettings>): Promise<void> {
    this.activeContexts.set(ev.action.id, ev.payload.settings);

    // Update connection state for initial overlay
    this.updateConnectionState();

    // Set initial display (not connected state)
    const svgDataUri = this.generateSvg(-1);
    await this.setKeyImage(ev, svgDataUri);

    // Subscribe to telemetry updates
    this.sdkController.subscribe(ev.action.id, (telemetry, isConnected) => {
      this.updateConnectionState();

      const settings = this.activeContexts.get(ev.action.id);

      if (settings) {
        this.updateDisplay(ev.action.id, isConnected, telemetry?.PitSvTireCompound);
      }
    });
  }

  /**
   * When the action disappears from the Stream Deck
   */
  override async onWillDisappear(ev: WillDisappearEvent<TireCompoundSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastSvgState.delete(ev.action.id);
  }

  /**
   * Update the display for a specific context
   */
  private async updateDisplay(
    contextId: string,
    isConnected: boolean,
    compound: number | undefined | null,
  ): Promise<void> {
    let displayCompound: number | null;

    if (!isConnected) {
      displayCompound = -1; // Not connected
    } else if (compound === null || compound === undefined || typeof compound !== "number") {
      displayCompound = null; // N/A
    } else {
      displayCompound = compound;
    }

    const stateKey = `${displayCompound}`;
    const lastState = this.lastSvgState.get(contextId);

    if (lastState !== stateKey) {
      this.lastSvgState.set(contextId, stateKey);
      const svgDataUri = this.generateSvg(displayCompound);
      await this.updateKeyImage(contextId, svgDataUri);
    }
  }

  /**
   * When settings are received or updated
   */
  override async onDidReceiveSettings(ev: any): Promise<void> {
    this.activeContexts.set(ev.action.id, ev.payload.settings);
    this.updateConnectionState();

    // Re-render with current state
    const isConnected = this.sdkController.getConnectionStatus();
    const telemetry = this.sdkController.getCurrentTelemetry();
    const compound = isConnected ? telemetry?.PitSvTireCompound : -1;

    let displayCompound: number | null;

    if (!isConnected) {
      displayCompound = -1;
    } else if (compound === null || compound === undefined || typeof compound !== "number") {
      displayCompound = null;
    } else {
      displayCompound = compound;
    }

    const stateKey = `${displayCompound}`;
    this.lastSvgState.set(ev.action.id, stateKey);
    const svgDataUri = this.generateSvg(displayCompound);
    await this.setKeyImage(ev, svgDataUri);
  }

  /**
   * When the key is pressed - toggle tire compound
   */
  override async onKeyDown(_ev: KeyDownEvent<TireCompoundSettings>): Promise<void> {
    this.logger.info("Key down received");

    // Check if connected to iRacing
    if (!this.sdkController.getConnectionStatus()) {
      this.logger.info("Not connected to iRacing");

      return;
    }

    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("No telemetry data available");

      return;
    }

    const currentCompound = telemetry.PitSvTireCompound;

    if (currentCompound === null || currentCompound === undefined || typeof currentCompound !== "number") {
      this.logger.warn("PitSvTireCompound not available");

      return;
    }

    // Toggle between compounds: 0 = Dry, 1 = Wet
    const newCompound = currentCompound === 0 ? 1 : 0;
    this.logger.info(`Switching from ${currentCompound === 0 ? "Dry" : "Wet"} to ${newCompound === 0 ? "Dry" : "Wet"}`);

    const success = this.pitCommand.tireCompound(newCompound);

    if (success) {
      this.logger.info(`Set tire compound to ${newCompound === 0 ? "Dry" : "Wet"}`);
    } else {
      this.logger.warn("Failed to set tire compound");
    }
  }
}

const TireCompoundSettings = z.object({});

/**
 * Settings for the tire compound action
 */
type TireCompoundSettings = z.infer<typeof TireCompoundSettings>;
