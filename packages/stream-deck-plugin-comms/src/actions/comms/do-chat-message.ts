import streamDeck, { action, KeyDownEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { CameraState, hasFlag } from "@iracedeck/iracing-sdk";
import { createSDLogger, LogLevel } from "@iracedeck/stream-deck-utils";
import z from "zod";

import { ConnectionStateAwareAction } from "../../base/connection-state-aware-action.js";
import { commands } from "../../sdk.js";
import { DEFAULT_ICON_COLOR, formatChatTitle, generateChatSvg } from "./chat-utils.js";

/**
 * Do Chat Message Action
 * Sends a custom chat message to iRacing when pressed
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.comms.do-chat-message" })
export class DoChatMessage extends ConnectionStateAwareAction<ChatSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("DoChatMessage"), LogLevel.Info);
  private cameraCommand = commands.camera;
  private updateInterval: NodeJS.Timeout | null = null;
  private activeContexts = new Map<string, ChatSettings>();
  private lastTitle = new Map<string, string>();
  private lastIconColor = new Map<string, string>();

  /**
   * When the action appears on the Stream Deck
   */
  override async onWillAppear(ev: WillAppearEvent<ChatSettings>): Promise<void> {
    this.activeContexts.set(ev.action.id, ev.payload.settings);

    // Set default message if not configured
    if (!ev.payload.settings.message) {
      await ev.action.setSettings({
        message: "",
      });
    }

    // Subscribe to SDK to start the connection loop
    // Connection state is tracked via updateConnectionState() in the update loop
    this.sdkController.subscribe(ev.action.id, () => {
      // Callback required but state tracking happens in updateConnectionState()
    });

    // Start updating display
    if (!this.updateInterval) {
      this.startUpdates();
    }

    // Update immediately with event (stores action ref for later updates)
    await this.updateDisplayWithEvent(ev);
  }

  /**
   * When the action disappears from the Stream Deck
   */
  override async onWillDisappear(ev: WillDisappearEvent<ChatSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.activeContexts.delete(ev.action.id);
    this.lastTitle.delete(ev.action.id);
    this.lastIconColor.delete(ev.action.id);

    // Unsubscribe from SDK
    this.sdkController.unsubscribe(ev.action.id);

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
    }, 1000); // Update every second
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
   * Update display using an event (for initial setup, stores action ref)
   */
  private async updateDisplayWithEvent(ev: WillAppearEvent<ChatSettings>): Promise<void> {
    const settings = ev.payload.settings;
    const isConnected = this.sdkController.getConnectionStatus();
    const title = formatChatTitle(settings.message, isConnected);
    const iconColor = settings.iconColor || DEFAULT_ICON_COLOR;

    this.lastTitle.set(ev.action.id, title);
    this.lastIconColor.set(ev.action.id, iconColor);

    await ev.action.setTitle(title);

    // Generate SVG and set via BaseAction (stores for overlay refresh)
    const svgDataUri = generateChatSvg(iconColor);
    await this.setKeyImage(ev, svgDataUri);
  }

  /**
   * Update the display for a specific context (periodic updates)
   */
  private async updateDisplay(contextId: string, settings: ChatSettings): Promise<void> {
    const action = streamDeck.actions.getActionById(contextId);

    if (!action) return;

    // Update active state when connection status changes
    this.updateConnectionState();

    const isConnected = this.getConnectionStatus();
    const title = formatChatTitle(settings.message, isConnected);
    const iconColor = settings.iconColor || DEFAULT_ICON_COLOR;

    // Only update if the title or color has changed
    const lastTitle = this.lastTitle.get(contextId);
    const lastColor = this.lastIconColor.get(contextId);

    if (lastTitle !== title || lastColor !== iconColor) {
      this.lastTitle.set(contextId, title);
      this.lastIconColor.set(contextId, iconColor);
      await action.setTitle(title);

      // Generate SVG and update via BaseAction (uses stored action ref)
      const svgDataUri = generateChatSvg(iconColor);
      await this.updateKeyImage(contextId, svgDataUri);
    }
  }

  /**
   * When settings are received or updated
   */
  override async onDidReceiveSettings(ev: any): Promise<void> {
    // Update stored settings
    this.activeContexts.set(ev.action.id, ev.payload.settings);

    // Update display when settings change - use event-based update
    const settings = ev.payload.settings;
    const isConnected = this.sdkController.getConnectionStatus();
    const title = formatChatTitle(settings.message, isConnected);
    const iconColor = settings.iconColor || DEFAULT_ICON_COLOR;

    this.lastTitle.set(ev.action.id, title);
    this.lastIconColor.set(ev.action.id, iconColor);

    await ev.action.setTitle(title);
    const svgDataUri = generateChatSvg(iconColor);
    await this.setKeyImage(ev, svgDataUri);
  }

  /**
   * When the key is pressed
   */
  override async onKeyDown(ev: KeyDownEvent<ChatSettings>): Promise<void> {
    this.logger.info("Key down received");

    const message = ev.payload.settings.message?.trim();

    const telemetry = this.sdkController.getCurrentTelemetry();

    if (!telemetry || !telemetry.CamCameraState) {
      this.logger.error("Couldn't get CamCameraState");

      return;
    }

    var origCamCameraState = telemetry.CamCameraState;

    // Then use hasFlag on the telemetry data
    if (hasFlag(origCamCameraState, CameraState.UIHidden)) {
      this.cameraCommand.showUI(origCamCameraState);
    }

    if (!message) {
      this.logger.info("No message to send");

      return;
    }

    // Check if connected to iRacing
    if (!this.sdkController.getConnectionStatus()) {
      this.logger.info("Not connected to iRacing");

      return;
    }

    // Send the chat message
    const success = this.sdkController.sendChatMessage(message);

    if (success) {
      this.logger.info("Message sent succesfully");
    } else {
      this.logger.warn("Sending message failed");
    }

    this.cameraCommand.setState(origCamCameraState);
  }
}

const ChatSettings = z.object({
  message: z.string().default(""),
  iconColor: z.string().default(DEFAULT_ICON_COLOR),
});

/**
 * Settings for the chat message action
 */
type ChatSettings = z.infer<typeof ChatSettings>;
