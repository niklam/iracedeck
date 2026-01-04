import streamDeck, {
  action,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import { hasFlag, PitCommand, PitSvFlags, TelemetryData } from "@iracedeck/iracing-sdk";

import { SDKController } from "../../sdk-controller.js";

/**
 * Display Fuel to Add Action
 * Displays the amount of fuel to be added at next pit stop (PitSvFuel)
 * Press to toggle fuel fill on/off
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.pit.display-fuel-to-add" })
export class DisplayFuelToAdd extends SingletonAction {
  private sdkController = SDKController.getInstance();
  private pitCommand = PitCommand.getInstance();
  private lastState = new Map<string, string>();
  private logger = streamDeck.logger.createScope("DisplayFuelToAdd");

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    this.sdkController.subscribe(ev.action.id, (telemetry, isConnected) => {
      this.updateDisplay(ev.action.id, telemetry, isConnected);
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.lastState.delete(ev.action.id);
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

  private async updateDisplay(contextId: string, telemetry: TelemetryData | null, isConnected: boolean): Promise<void> {
    const action = streamDeck.actions.getActionById(contextId);

    if (!action) return;

    let title = "iRacing\nnot\nconnected";
    let image = "imgs/actions/pit/display-fuel-to-add/key";

    if (isConnected && telemetry) {
      const fuelToAdd = telemetry.PitSvFuel;
      const pitSvFlags = telemetry.PitSvFlags;

      // Check if fuel fill is enabled
      const isFuelFillEnabled =
        pitSvFlags !== null &&
        pitSvFlags !== undefined &&
        typeof pitSvFlags === "number" &&
        hasFlag(pitSvFlags, PitSvFlags.FuelFill);

      // Use active image when fuel fill is enabled
      image = isFuelFillEnabled
        ? "imgs/actions/pit/display-fuel-to-add/key-active"
        : "imgs/actions/pit/display-fuel-to-add/key";

      if (isFuelFillEnabled) {
        if (fuelToAdd !== null && fuelToAdd !== undefined && typeof fuelToAdd === "number") {
          title = Math.round(fuelToAdd) + " L";
        } else {
          title = "-";
        }
      } else {
        title = "No\nRefuel";
      }
    }

    const stateKey = `${title}|${image}`;
    const lastState = this.lastState.get(contextId);

    if (lastState !== stateKey) {
      this.lastState.set(contextId, stateKey);
      await action.setTitle(title);
      await action.setImage(image);
    }
  }
}
