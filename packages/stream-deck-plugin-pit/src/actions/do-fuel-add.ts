import streamDeck, { action, KeyDownEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { DisplayUnits } from "@iracedeck/iracing-sdk";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  formatFuelSettingWithUnit,
  fuelFromDisplayUnits,
  getCommands,
  getFuelUnitSuffix,
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
  private lastDisplayUnits: DisplayUnits | number | undefined = undefined;

  /**
   * Generate SVG for the fuel add button
   * @param amount - The amount in display units (no conversion needed)
   * @param displayUnits - The display units to determine the suffix
   */
  private generateSvg(amount: number, displayUnits?: DisplayUnits | number): string {
    // Amount is already in display units, just add the suffix
    const amountText = formatFuelSettingWithUnit(amount, displayUnits, "+");
    const svg = renderIconTemplate(doFuelAddTemplate, { amount: amountText });

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

    // Get current display units from telemetry
    const telemetry = this.sdkController.getCurrentTelemetry();
    this.lastDisplayUnits = telemetry?.DisplayUnits;

    // Set initial display - parse settings to ensure amount is a number
    const { amount } = FuelSettings.parse(ev.payload.settings);
    const svgDataUri = this.generateSvg(amount, this.lastDisplayUnits);
    await this.setKeyImage(ev, svgDataUri);

    // Subscribe to telemetry updates
    this.sdkController.subscribe(ev.action.id, (newTelemetry, isConnected) => {
      this.updateConnectionState();

      // Track display units changes
      const newDisplayUnits = newTelemetry?.DisplayUnits;

      if (newDisplayUnits !== this.lastDisplayUnits) {
        this.lastDisplayUnits = newDisplayUnits;
        // Clear cached state to force redraw with new units
        this.lastSvgState.delete(ev.action.id);
      }

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
  private async updateDisplay(contextId: string, rawSettings: FuelSettings, _isConnected: boolean): Promise<void> {
    // Parse to ensure amount is a number
    const { amount } = FuelSettings.parse(rawSettings);
    const stateKey = `${amount}-${this.lastDisplayUnits}`;

    const lastState = this.lastSvgState.get(contextId);

    if (lastState !== stateKey) {
      this.lastSvgState.set(contextId, stateKey);
      const svgDataUri = this.generateSvg(amount, this.lastDisplayUnits);
      await this.updateKeyImage(contextId, svgDataUri);
    }
  }

  /**
   * When settings are received or updated
   */
  override async onDidReceiveSettings(ev: any): Promise<void> {
    this.activeContexts.set(ev.action.id, ev.payload.settings);
    this.updateConnectionState();

    // Parse to ensure amount is a number
    const { amount } = FuelSettings.parse(ev.payload.settings);
    const stateKey = `${amount}-${this.lastDisplayUnits}`;

    this.lastSvgState.set(ev.action.id, stateKey);
    const svgDataUri = this.generateSvg(amount, this.lastDisplayUnits);
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
    const displayUnits = telemetry.DisplayUnits;

    // Convert the amount from display units to liters (internal unit)
    // The amount setting is in the user's display units (L or gal)
    const amountInLiters = fuelFromDisplayUnits(amount, displayUnits);
    const unit = getFuelUnitSuffix(displayUnits);

    // Round to 1 decimal place to avoid floating point precision issues
    const roundedCurrentFuel = Math.round(currentFuel * 10) / 10;
    const newFuelAmount = Math.round((roundedCurrentFuel + amountInLiters) * 10) / 10;

    // Send the pit command with the new total fuel amount (always in liters)
    const success = this.pitCommand.fuel(newFuelAmount);

    if (success) {
      this.logger.info(`Set fuel to ${newFuelAmount}L (was ${roundedCurrentFuel}L, added ${amount} ${unit})`);
    } else {
      this.logger.warn("Failed to set fuel");
    }
  }
}

const FuelSettings = z.object({
  amount: z.preprocess((val) => {
    if (typeof val === "string") {
      return val.replace(",", ".");
    }

    return val;
  }, z.coerce.number().default(1)),
});

/**
 * Settings for the fuel add action
 */
type FuelSettings = z.infer<typeof FuelSettings>;
