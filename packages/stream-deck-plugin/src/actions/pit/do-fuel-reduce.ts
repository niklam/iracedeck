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
 * Do Fuel Reduce Action
 * Reduces fuel from the pit service fuel amount when pressed
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.pit.do-fuel-reduce" })
export class DoFuelReduce extends SingletonAction<FuelSettings> {
  private sdkController = controller;
  private pitCommand = commands.pit;
  private updateInterval: NodeJS.Timeout | null = null;
  private activeContexts = new Map<string, FuelSettings>();
  private lastTitle = new Map<string, string>();
  private logger = streamDeck.logger.createScope("DoFuelReduce");

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

    // Start updating display
    if (!this.updateInterval) {
      this.startUpdates();
    }

    // Update immediately
    this.updateDisplay(ev.action.id, ev.payload.settings);
  }

  /**
   * When the action disappears from the Stream Deck
   */
  override async onWillDisappear(ev: WillDisappearEvent): Promise<void> {
    this.activeContexts.delete(ev.action.id);
    this.lastTitle.delete(ev.action.id);

    // Stop updates if no more instances
    if (this.activeContexts.size === 0) {
      this.stopUpdates();
    }
  }

  /**
   * Start periodic updates
   */
  private startUpdates(): void {
    this.updateInterval = setInterval(() => {
      for (const [contextId, settings] of this.activeContexts) {
        this.updateDisplay(contextId, settings);
      }
    }, 1000);
  }

  /**
   * Stop periodic updates
   */
  private stopUpdates(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * Update the display for a specific context
   */
  private async updateDisplay(contextId: string, settings: FuelSettings): Promise<void> {
    const action = streamDeck.actions.getActionById(contextId);

    if (!action) return;

    let title = "iRacing\nnot\nconnected";

    if (this.sdkController.getConnectionStatus()) {
      const amount = settings.amount || 1;
      title = `-${amount} L`;
    }

    const lastTitle = this.lastTitle.get(contextId);

    if (lastTitle !== title) {
      this.lastTitle.set(contextId, title);
      await action.setTitle(title);
      await action.setImage("imgs/actions/pit/do-fuel-reduce/key");
    }
  }

  /**
   * When settings are received or updated
   */
  override async onDidReceiveSettings(ev: any): Promise<void> {
    this.activeContexts.set(ev.action.id, ev.payload.settings);
    this.updateDisplay(ev.action.id, ev.payload.settings);
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
    const newFuelAmount = Math.max(0, currentFuel - amount);

    let success: boolean;

    if (newFuelAmount === 0) {
      // Can't send 0 to fuel() as it means "use existing amount"
      // Use clearFuel() to set fuel to 0
      success = this.pitCommand.clearFuel();

      if (success) {
        this.logger.info(`Cleared fuel (was ${currentFuel}L)`);
      }
    } else {
      // Send the pit command with the new total fuel amount
      success = this.pitCommand.fuel(newFuelAmount);

      if (success) {
        this.logger.info(`Set fuel to ${newFuelAmount}L (was ${currentFuel}L, reduced ${amount}L)`);
      }
    }

    if (!success) {
      this.logger.warn("Failed to set fuel");
    }
  }
}

const FuelSettings = z.object({
  amount: z.coerce.number().default(1),
});

/**
 * Settings for the fuel reduce action
 */
type FuelSettings = z.infer<typeof FuelSettings>;
