import streamDeck, {
  action,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import { TelemetryData } from "@iracedeck/iracing-sdk";

import { controller } from "../../plugin.js";

/**
 * Display Speed Action
 * Displays current speed from iRacing telemetry
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.vehicle.display-speed" })
export class DisplaySpeed extends SingletonAction<SpeedSettings> {
  private sdkController = controller;
  private activeContexts = new Map<string, SpeedSettings>();
  private lastTitle = new Map<string, string>();

  override async onWillAppear(ev: WillAppearEvent<SpeedSettings>): Promise<void> {
    this.activeContexts.set(ev.action.id, ev.payload.settings);

    this.sdkController.subscribe(ev.action.id, (telemetry, isConnected) => {
      const settings = this.activeContexts.get(ev.action.id);

      if (settings) {
        this.updateDisplay(ev.action.id, settings, telemetry, isConnected);
      }
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<SpeedSettings>): Promise<void> {
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastTitle.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: any): Promise<void> {
    this.activeContexts.set(ev.action.id, ev.payload.settings);
  }

  override async onKeyDown(ev: KeyDownEvent<SpeedSettings>): Promise<void> {
    const currentUnit = ev.payload.settings.unit || "mph";
    const newUnit: "mph" | "kph" = currentUnit === "mph" ? "kph" : "mph";

    const newSettings: SpeedSettings = {
      ...ev.payload.settings,
      unit: newUnit,
    };

    await ev.action.setSettings(newSettings);
    this.activeContexts.set(ev.action.id, newSettings);

    const telemetry = this.sdkController.getCurrentTelemetry();
    const isConnected = this.sdkController.getConnectionStatus();
    this.updateDisplay(ev.action.id, newSettings, telemetry, isConnected);
  }

  private async updateDisplay(
    contextId: string,
    settings: SpeedSettings,
    telemetry: TelemetryData | null,
    isConnected: boolean,
  ): Promise<void> {
    const action = streamDeck.actions.getActionById(contextId);

    if (!action) return;

    let title = "iRacing\nnot\nconnected";

    if (isConnected && telemetry) {
      const speed = telemetry.Speed;

      if (speed !== null && speed !== undefined && typeof speed === "number") {
        const unit = settings.unit || "mph";
        let displaySpeed: number;

        if (unit === "kph") {
          displaySpeed = speed * 3.6;
        } else {
          displaySpeed = speed * 2.23694;
        }

        title = Math.round(displaySpeed).toString();
      } else {
        title = "N/A";
      }
    }

    const lastTitle = this.lastTitle.get(contextId);

    if (lastTitle !== title) {
      this.lastTitle.set(contextId, title);
      await action.setTitle(title);
      await action.setImage("imgs/actions/vehicle/display-speed/key");
    }
  }
}

type SpeedSettings = {
  unit?: "mph" | "kph";
};
