import streamDeck, { action, KeyDownEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { hasFlag, PitSvFlags, TelemetryData } from "@iracedeck/iracing-sdk";
import { ConnectionStateAwareAction, createSDLogger, getCommands, LogLevel } from "@iracedeck/stream-deck-shared";

import { generateFuelDisplaySvg } from "./fuel-display-utils.js";

/**
 * Display Fuel to Add Action
 * Displays the amount of fuel to be added at next pit stop (PitSvFuel)
 * Press to toggle fuel fill on/off
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.pit.display-fuel-to-add" })
export class DisplayFuelToAdd extends ConnectionStateAwareAction {
  protected override logger = createSDLogger(streamDeck.logger.createScope("DisplayFuelToAdd"), LogLevel.Info);

  private get pitCommand() {
    return getCommands().pit;
  }

  private lastFuelAmount = new Map<string, number | null>();
  private lastFuelFillEnabled = new Map<string, boolean>();

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    // Update immediately with event (stores action ref for later updates)
    await this.updateDisplayWithEvent(ev, null, false);

    // Subscribe to telemetry updates
    this.sdkController.subscribe(ev.action.id, (telemetry, isConnected) => {
      // Update connection state (triggers grayscale overlay via BaseAction.setActive)
      this.updateConnectionState();

      this.updateDisplay(ev.action.id, telemetry, isConnected);
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.lastFuelAmount.delete(ev.action.id);
    this.lastFuelFillEnabled.delete(ev.action.id);
  }

  /**
   * When the key is pressed - toggle fuel fill
   */
  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
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

    const pitSvFlags = telemetry.PitSvFlags;

    if (pitSvFlags === null || pitSvFlags === undefined || typeof pitSvFlags !== "number") {
      this.logger.warn("PitSvFlags not available");

      return;
    }

    // Check if FuelFill is currently enabled
    if (hasFlag(pitSvFlags, PitSvFlags.FuelFill)) {
      // Fuel fill is on - clear it
      const success = this.pitCommand.clearFuel();

      if (success) {
        this.logger.info("Cleared fuel fill");
      } else {
        this.logger.warn("Failed to clear fuel fill");
      }
    } else {
      // Fuel fill is off - enable it with current PitSvFuel amount (0 = use existing)
      const success = this.pitCommand.fuel(0);

      if (success) {
        this.logger.info("Enabled fuel fill");
      } else {
        this.logger.warn("Failed to enable fuel fill");
      }
    }
  }

  /**
   * Update display using an event (for initial setup, stores action ref)
   */
  private async updateDisplayWithEvent(
    ev: WillAppearEvent,
    telemetry: TelemetryData | null,
    isConnected: boolean,
  ): Promise<void> {
    // Update connection state for initial overlay
    this.updateConnectionState();

    const { fuelAmount, isFuelFillEnabled } = this.extractFuelData(telemetry, isConnected);

    this.lastFuelAmount.set(ev.action.id, fuelAmount);
    this.lastFuelFillEnabled.set(ev.action.id, isFuelFillEnabled);

    // Generate SVG and set via BaseAction (stores for overlay refresh)
    const svgDataUri = generateFuelDisplaySvg(isFuelFillEnabled, fuelAmount);
    await this.setKeyImage(ev, svgDataUri);
  }

  /**
   * Update the display for a specific context (called from subscription callback)
   */
  private async updateDisplay(contextId: string, telemetry: TelemetryData | null, isConnected: boolean): Promise<void> {
    const { fuelAmount, isFuelFillEnabled } = this.extractFuelData(telemetry, isConnected);

    // Only update if values have changed
    const lastAmount = this.lastFuelAmount.get(contextId);
    const lastEnabled = this.lastFuelFillEnabled.get(contextId);

    if (lastAmount !== fuelAmount || lastEnabled !== isFuelFillEnabled) {
      this.lastFuelAmount.set(contextId, fuelAmount);
      this.lastFuelFillEnabled.set(contextId, isFuelFillEnabled);

      // Generate SVG and update via BaseAction (uses stored action ref)
      const svgDataUri = generateFuelDisplaySvg(isFuelFillEnabled, fuelAmount);
      await this.updateKeyImage(contextId, svgDataUri);
    }
  }

  /**
   * Extract fuel data from telemetry
   */
  private extractFuelData(
    telemetry: TelemetryData | null,
    isConnected: boolean,
  ): { fuelAmount: number | null; isFuelFillEnabled: boolean } {
    if (!isConnected || !telemetry) {
      return { fuelAmount: null, isFuelFillEnabled: false };
    }

    const pitSvFlags = telemetry.PitSvFlags;
    const isFuelFillEnabled =
      pitSvFlags !== null &&
      pitSvFlags !== undefined &&
      typeof pitSvFlags === "number" &&
      hasFlag(pitSvFlags, PitSvFlags.FuelFill);

    let fuelAmount: number | null = null;

    if (isFuelFillEnabled) {
      const fuelToAdd = telemetry.PitSvFuel;

      if (fuelToAdd !== null && fuelToAdd !== undefined && typeof fuelToAdd === "number") {
        fuelAmount = fuelToAdd;
      }
    }

    return { fuelAmount, isFuelFillEnabled };
  }
}
