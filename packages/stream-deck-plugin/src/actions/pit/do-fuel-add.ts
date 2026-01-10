import streamDeck, {
  action,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import z from "zod";

import { commands, controller } from "../../plugin.js";

/**
 * Do Fuel Add Action
 * Adds fuel to the pit service fuel amount when pressed
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.pit.do-fuel-add" })
export class DoFuelAdd extends SingletonAction<FuelSettings> {
  private sdkController = controller;
  private pitCommand = commands.pit;
  private activeContexts = new Map<string, FuelSettings>();
  private lastTitle = new Map<string, string>();
  private logger = streamDeck.logger.createScope("DoFuelAdd");

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

    // Subscribe to telemetry updates
    this.sdkController.subscribe(ev.action.id, (_telemetry, isConnected) => {
      const settings = this.activeContexts.get(ev.action.id);

      if (settings) {
        this.updateDisplay(ev.action.id, settings, isConnected);
      }
    });
  }

  /**
   * When the action disappears from the Stream Deck
   */
  override async onWillDisappear(ev: WillDisappearEvent): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastTitle.delete(ev.action.id);
  }

  /**
   * Update the display for a specific context
   */
  private async updateDisplay(contextId: string, settings: FuelSettings, isConnected: boolean): Promise<void> {
    const action = streamDeck.actions.getActionById(contextId);

    if (!action) return;

    let title = "iRacing\nnot\nconnected";

    if (isConnected) {
      const amount = settings.amount || 2;
      title = `+${amount} L`;
    }

    const lastTitle = this.lastTitle.get(contextId);

    if (lastTitle !== title) {
      this.lastTitle.set(contextId, title);
      await action.setTitle(title);
      await action.setImage("imgs/actions/pit/do-fuel-add/key");
    }
  }

  /**
   * When settings are received or updated
   */
  override async onDidReceiveSettings(ev: any): Promise<void> {
    this.activeContexts.set(ev.action.id, ev.payload.settings);
    const isConnected = this.sdkController.getConnectionStatus();
    this.updateDisplay(ev.action.id, ev.payload.settings, isConnected);
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
  amount: z.coerce.number().default(2),
});

/**
 * Settings for the fuel add action
 */
type FuelSettings = z.infer<typeof FuelSettings>;
