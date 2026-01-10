import streamDeck, { action, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { TelemetryData } from "@iracedeck/iracing-sdk";

import { controller } from "../../plugin.js";

/**
 * Display Gear Action
 * Displays current gear from iRacing telemetry
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.vehicle.display-gear" })
export class DisplayGear extends SingletonAction {
  private sdkController = controller;
  private lastTitle = new Map<string, string>();

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    this.sdkController.subscribe(ev.action.id, (telemetry, isConnected) => {
      this.updateDisplay(ev.action.id, telemetry, isConnected);
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.lastTitle.delete(ev.action.id);
  }

  private async updateDisplay(contextId: string, telemetry: TelemetryData | null, isConnected: boolean): Promise<void> {
    const action = streamDeck.actions.getActionById(contextId);

    if (!action) return;

    let title = "iRacing\nnot\nconnected";

    if (isConnected && telemetry) {
      const gear = telemetry.Gear;

      if (gear !== null && gear !== undefined && typeof gear === "number") {
        if (gear === -1) {
          title = "R";
        } else if (gear === 0) {
          title = "N";
        } else {
          title = gear.toString();
        }
      } else {
        title = "N/A";
      }
    }

    const lastTitle = this.lastTitle.get(contextId);

    if (lastTitle !== title) {
      this.lastTitle.set(contextId, title);
      await action.setTitle(title);
      await action.setImage("imgs/actions/vehicle/display-gear/key");
    }
  }
}
