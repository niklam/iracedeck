import streamDeck, { action, KeyDownEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  getCommands,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "@iracedeck/stream-deck-shared";
import z from "zod";

import doFuelAddTemplate from "../../icons/do-fuel-add.svg";

/**
 * Do Fuel Add Action
 * Adds fuel to the pit service fuel amount when pressed
 */
@action({ UUID: "com.iracedeck.sd.pit.do-fuel-add" })
export class DoFuelAdd extends ConnectionStateAwareAction<FuelSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("DoFuelAdd"), LogLevel.Info);

  private get pitCommand() {
    return getCommands().pit;
  }

  private activeContexts = new Map<string, FuelSettings>();
  private lastSvgState = new Map<string, string>();

  /**
   * Generate SVG for the fuel add button
   */
  private generateSvg(amount: number): string {
    const svg = renderIconTemplate(doFuelAddTemplate, { amount: `+${amount} L` });

    return svgToDataUri(svg);
  }

  /**
   * When the action appears on the Stream Deck
   */
  override async onWillAppear(ev: WillAppearEvent<FuelSettings>): Promise<void> {
    this.activeContexts.set(ev.action.id, ev.payload.settings);

    // Set default amount if not configured
    if (!ev.payload.settings.amount) {
      await ev.action.setSettings({
        amount: 1,
      });
    }

    // Update connection state for initial overlay
    this.updateConnectionState();

    // Set initial display
    const amount = ev.payload.settings.amount || 1;
    const svgDataUri = this.generateSvg(amount);
    await this.setKeyImage(ev, svgDataUri);

    // Subscribe to telemetry updates
    this.sdkController.subscribe(ev.action.id, (_telemetry, isConnected) => {
      this.updateConnectionState();

      const settings = this.activeContexts.get(ev.action.id);

      if (settings) {
        this.updateDisplay(ev.action.id, settings, isConnected);
      }
    });
  }

  /**
   * When the action disappears from the Stream Deck
   */
  override async onWillDisappear(ev: WillDisappearEvent<FuelSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastSvgState.delete(ev.action.id);
  }

  /**
   * Update the display for a specific context
   */
  private async updateDisplay(contextId: string, settings: FuelSettings, _isConnected: boolean): Promise<void> {
    const amount = settings.amount || 1;
    const stateKey = `${amount}`;

    const lastState = this.lastSvgState.get(contextId);

    if (lastState !== stateKey) {
      this.lastSvgState.set(contextId, stateKey);
      const svgDataUri = this.generateSvg(amount);
      await this.updateKeyImage(contextId, svgDataUri);
    }
  }

  /**
   * When settings are received or updated
   */
  override async onDidReceiveSettings(ev: any): Promise<void> {
    this.activeContexts.set(ev.action.id, ev.payload.settings);
    this.updateConnectionState();

    const amount = ev.payload.settings.amount || 1;
    const stateKey = `${amount}`;

    this.lastSvgState.set(ev.action.id, stateKey);
    const svgDataUri = this.generateSvg(amount);
    await this.setKeyImage(ev, svgDataUri);
  }

  /**
   * When the key is pressed
   */
  override async onKeyDown(ev: KeyDownEvent<FuelSettings>): Promise<void> {
    this.logger.info("Key down received");

    // Check if connected to iRacing
    if (!this.sdkController.getConnectionStatus()) {
      this.logger.info("Not connected to iRacing");

      return;
    }

    // Get current fuel to add from telemetry
    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry) {
      this.logger.warn("No telemetry data available");

      return;
    }

    const currentFuel = telemetry.PitSvFuel;

    if (currentFuel === null || currentFuel === undefined || typeof currentFuel !== "number") {
      this.logger.warn("PitSvFuel not available");

      return;
    }

    const { amount } = FuelSettings.parse(ev.payload.settings);
    const newFuelAmount = currentFuel + amount;

    // Send the pit command with the new total fuel amount
    const success = this.pitCommand.fuel(newFuelAmount);

    if (success) {
      this.logger.info(`Set fuel to ${newFuelAmount}L (was ${currentFuel}L, added ${amount}L)`);
    } else {
      this.logger.warn("Failed to set fuel");
    }
  }
}

const FuelSettings = z.object({
  amount: z.coerce.number().default(1),
});

/**
 * Settings for the fuel add action
 */
type FuelSettings = z.infer<typeof FuelSettings>;
