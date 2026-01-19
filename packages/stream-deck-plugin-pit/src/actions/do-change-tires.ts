import streamDeck, { action, KeyDownEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { hasFlag, PitSvFlags, TelemetryData } from "@iracedeck/iracing-sdk";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  generateIconText,
  getCommands,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "@iracedeck/stream-deck-shared";
import z from "zod";

import doChangeTiresNaTemplate from "../../icons/do-change-tires-na.svg";
import doChangeTiresTemplate from "../../icons/do-change-tires.svg";

const ChangeTiresSettings = z.object({
  lf: z.coerce.boolean().default(true),
  rf: z.coerce.boolean().default(true),
  lr: z.coerce.boolean().default(true),
  rr: z.coerce.boolean().default(true),
});

/**
 * Settings for the change tires action
 */
type ChangeTiresSettings = z.infer<typeof ChangeTiresSettings>;

/**
 * Toggle Tires Action
 * Toggles tire change selections in pit service based on configured checkboxes.
 * Dynamic icon shows car from above with tire outlines based on CURRENT iRacing state.
 * White outline = will be changed, Gray outline = will NOT be changed.
 * On press: toggles the configured tires (if currently on, turns off; if off, turns on).
 */
@action({ UUID: "com.iracedeck.sd.pit.do-change-tires" })
export class DoChangeTires extends ConnectionStateAwareAction<ChangeTiresSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("DoChangeTires"), LogLevel.Info);

  private get pitCommand() {
    return getCommands().pit;
  }
  private activeContexts = new Map<string, ChangeTiresSettings>();
  private lastState = new Map<string, string>();

  override async onWillAppear(ev: WillAppearEvent<ChangeTiresSettings>): Promise<void> {
    this.activeContexts.set(ev.action.id, ev.payload.settings);

    // Update immediately with event (stores action ref for later updates)
    await this.updateDisplayWithEvent(ev);

    // Subscribe to telemetry updates - callback handles connection state changes
    this.sdkController.subscribe(ev.action.id, (telemetry, isConnected) => {
      // Update connection state (triggers grayscale overlay via BaseAction.setActive)
      this.updateConnectionState();

      const settings = this.activeContexts.get(ev.action.id);

      if (settings) {
        this.updateDisplay(ev.action.id, telemetry, isConnected);
      }
    });
  }

  /**
   * Update display using an event (for initial setup, stores action ref)
   */
  private async updateDisplayWithEvent(ev: WillAppearEvent<ChangeTiresSettings>): Promise<void> {
    const settings = ChangeTiresSettings.parse(ev.payload.settings);
    const isConnected = this.sdkController.getConnectionStatus();
    const telemetry = this.sdkController.getCurrentTelemetry();
    const tireState = this.getTireState(telemetry);

    // Update connection state for initial overlay
    this.updateConnectionState();

    // Generate SVG - show N/A when not connected
    const svgDataUri = isConnected ? this.generateCarSvg(settings, tireState) : this.generateNaSvg();
    await ev.action.setTitle(""); // Title is in the SVG
    await this.setKeyImage(ev, svgDataUri);

    // Store state for change detection
    const stateKey = `${isConnected}|${settings.lf}|${settings.rf}|${settings.lr}|${settings.rr}|${tireState.lf}|${tireState.rf}|${tireState.lr}|${tireState.rr}`;
    this.lastState.set(ev.action.id, stateKey);
  }

  override async onWillDisappear(ev: WillDisappearEvent<ChangeTiresSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
  }

  /**
   * Get tire fill color based on settings and current state
   * Light gray: not configured (nothing happens)
   * Red: configured and currently OFF (will turn ON)
   * Green: configured and currently ON (will turn OFF)
   */
  private getTireColor(isConfigured: boolean, isCurrentlyOn: boolean): string {
    if (!isConfigured) return "#000000ff"; // Light gray - nothing happens

    if (isCurrentlyOn) return "#44FF44"; // Green - currently ON, will turn OFF

    return "#FF4444"; // Red - currently OFF, will turn ON
  }

  /**
   * Generate SVG for the N/A state (disconnected)
   */
  private generateNaSvg(): string {
    return svgToDataUri(doChangeTiresNaTemplate);
  }

  /**
   * Generate car SVG with tires colored based on settings and current state
   * Icon in top half, title text in bottom
   */
  private generateCarSvg(
    settings: ChangeTiresSettings,
    currentState: { lf: boolean; rf: boolean; lr: boolean; rr: boolean },
  ): string {
    const lfColor = this.getTireColor(settings.lf ?? false, currentState.lf);
    const rfColor = this.getTireColor(settings.rf ?? false, currentState.rf);
    const lrColor = this.getTireColor(settings.lr ?? false, currentState.lr);
    const rrColor = this.getTireColor(settings.rr ?? false, currentState.rr);

    // Check if any configured tire is currently ON (will be changed)
    const anyTireOn =
      (settings.lf && currentState.lf) ||
      (settings.rf && currentState.rf) ||
      (settings.lr && currentState.lr) ||
      (settings.rr && currentState.rr);

    // Title text and color
    let titleText: string;
    let titleColor: string;

    if (anyTireOn) {
      titleText = "Change";
      titleColor = "#FFFFFF";
    } else {
      titleText = "No Change";
      titleColor = "#FF4444";
    }

    const textElement = generateIconText({ text: titleText, fontSize: 12, fill: titleColor });
    const svg = renderIconTemplate(doChangeTiresTemplate, {
      lfColor,
      rfColor,
      lrColor,
      rrColor,
      textElement,
    });

    return svgToDataUri(svg);
  }

  /**
   * Get current tire change state from telemetry
   */
  private getTireState(telemetry: TelemetryData | null): {
    lf: boolean;
    rf: boolean;
    lr: boolean;
    rr: boolean;
  } {
    if (!telemetry || telemetry.PitSvFlags === undefined) {
      return { lf: false, rf: false, lr: false, rr: false };
    }

    const flags = telemetry.PitSvFlags;

    return {
      lf: hasFlag(flags, PitSvFlags.LFTireChange),
      rf: hasFlag(flags, PitSvFlags.RFTireChange),
      lr: hasFlag(flags, PitSvFlags.LRTireChange),
      rr: hasFlag(flags, PitSvFlags.RRTireChange),
    };
  }

  /**
   * Update the display for a specific context (called from subscription callback)
   */
  private async updateDisplay(contextId: string, telemetry: TelemetryData | null, isConnected: boolean): Promise<void> {
    const settings = ChangeTiresSettings.parse(this.activeContexts.get(contextId) || {});

    // Get current tire state from telemetry (for icon display)
    const tireState = this.getTireState(telemetry);

    // Create state key for caching (include settings)
    const stateKey = `${isConnected}|${settings.lf}|${settings.rf}|${settings.lr}|${settings.rr}|${tireState.lf}|${tireState.rf}|${tireState.lr}|${tireState.rr}`;
    const lastState = this.lastState.get(contextId);

    // Only update if the state has changed
    if (lastState !== stateKey) {
      this.lastState.set(contextId, stateKey);

      // Generate SVG - show N/A when not connected
      const svgDataUri = isConnected ? this.generateCarSvg(settings, tireState) : this.generateNaSvg();
      await this.updateKeyImage(contextId, svgDataUri);
    }
  }

  /**
   * When settings are received or updated from Property Inspector
   */
  override async onDidReceiveSettings(ev: any): Promise<void> {
    // Update stored settings
    this.activeContexts.set(ev.action.id, ev.payload.settings);

    // Update display when settings change
    const settings = ChangeTiresSettings.parse(ev.payload.settings);
    const isConnected = this.sdkController.getConnectionStatus();
    const telemetry = this.sdkController.getCurrentTelemetry();
    const tireState = this.getTireState(telemetry);

    // Update connection state for overlay
    this.updateConnectionState();

    // Generate SVG - show N/A when not connected
    const svgDataUri = isConnected ? this.generateCarSvg(settings, tireState) : this.generateNaSvg();
    await this.setKeyImage(ev, svgDataUri);

    // Update state cache
    const stateKey = `${isConnected}|${settings.lf}|${settings.rf}|${settings.lr}|${settings.rr}|${tireState.lf}|${tireState.rf}|${tireState.lr}|${tireState.rr}`;
    this.lastState.set(ev.action.id, stateKey);
  }

  /**
   * When the key is pressed - toggle tire change selections
   */
  override async onKeyDown(ev: KeyDownEvent<ChangeTiresSettings>): Promise<void> {
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

    // Get current state and settings
    const currentState = this.getTireState(telemetry);
    const settings = ChangeTiresSettings.parse(ev.payload.settings);

    this.logger.info(
      `Current: LF=${currentState.lf} RF=${currentState.rf} LR=${currentState.lr} RR=${currentState.rr}`,
    );
    this.logger.info(`Settings: LF=${settings.lf} RF=${settings.rf} LR=${settings.lr} RR=${settings.rr}`);

    // Check if any of the configured tires is currently active
    const anyConfiguredTireActive =
      (settings.lf && currentState.lf) ||
      (settings.rf && currentState.rf) ||
      (settings.lr && currentState.lr) ||
      (settings.rr && currentState.rr);

    if (anyConfiguredTireActive) {
      // At least one configured tire is active -> deactivate all configured tires
      // Must clear all and re-enable only the non-configured tires that were active
      this.pitCommand.clearTires();
      this.logger.info("Deactivating configured tires - cleared all");

      // Re-enable tires that were active but are NOT configured (should stay on)
      if (currentState.lf && !settings.lf) {
        this.pitCommand.leftFront(0);
        this.logger.info("Re-enabled LF (not configured)");
      }

      if (currentState.rf && !settings.rf) {
        this.pitCommand.rightFront(0);
        this.logger.info("Re-enabled RF (not configured)");
      }

      if (currentState.lr && !settings.lr) {
        this.pitCommand.leftRear(0);
        this.logger.info("Re-enabled LR (not configured)");
      }

      if (currentState.rr && !settings.rr) {
        this.pitCommand.rightRear(0);
        this.logger.info("Re-enabled RR (not configured)");
      }
    } else {
      // No configured tire is active -> activate all configured tires
      if (settings.lf) {
        this.pitCommand.leftFront(0);
        this.logger.info("Activated LF");
      }

      if (settings.rf) {
        this.pitCommand.rightFront(0);
        this.logger.info("Activated RF");
      }

      if (settings.lr) {
        this.pitCommand.leftRear(0);
        this.logger.info("Activated LR");
      }

      if (settings.rr) {
        this.pitCommand.rightRear(0);
        this.logger.info("Activated RR");
      }
    }

    this.logger.info("Tire toggle complete");
  }
}
