import streamDeck, { action, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { TelemetryData } from "@iracedeck/iracing-sdk";
import { ConnectionStateAwareAction, createSDLogger, LogLevel } from "@iracedeck/stream-deck-shared";
import z from "zod";
import { generateDefaultSkyIcon, generateSkyIcon, getSkyText } from "./sky-display-utils";

/**
 * Display Sky Action
 * Displays current sky conditions from iRacing telemetry
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.environment.display-sky" })
export class DisplaySky extends ConnectionStateAwareAction<SkySettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("DisplaySky"), LogLevel.Info);

  private lastSkyState = new Map<string, string>();

  override async onWillAppear(ev: WillAppearEvent<SkySettings>): Promise<void> {
    // Update connection state for initial overlay
    this.updateConnectionState();

    // Set initial display with default icon
    await this.setKeyImage(ev, generateDefaultSkyIcon());

    // Subscribe to telemetry updates
    this.sdkController.subscribe(ev.action.id, (telemetry, isConnected) => {
      this.updateConnectionState();
      this.updateDisplay(ev.action.id, telemetry, isConnected);
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<SkySettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.lastSkyState.delete(ev.action.id);
  }

  private async updateDisplay(contextId: string, telemetry: TelemetryData | null, isConnected: boolean): Promise<void> {
    let skies: number | undefined;
    let skyText = "N/A";

    if (isConnected && telemetry) {
      skies = telemetry.Skies;
      skyText = getSkyText(skies);
    }

    const stateKey = `${skies ?? "null"}|${skyText}`;
    const lastState = this.lastSkyState.get(contextId);

    if (lastState !== stateKey) {
      this.lastSkyState.set(contextId, stateKey);
      const svgDataUri = generateSkyIcon(skies, skyText);
      await this.updateKeyImage(contextId, svgDataUri);
    }
  }
}

const SkySettings = z.object({});

/**
 * Settings for the sky display action
 */
type SkySettings = z.infer<typeof SkySettings>;
