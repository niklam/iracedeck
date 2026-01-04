import streamDeck, {
  action,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import { CameraCommand, CameraState, hasFlag } from "@iracedeck/iracing-sdk";

import { SDKController } from "../../sdk-controller.js";

/**
 * Do Chat Message Action
 * Sends a custom chat message to iRacing when pressed
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.comms.do-chat-message" })
export class DoChatMessage extends SingletonAction<ChatSettings> {
  private sdkController = SDKController.getInstance();
  private cameraCommand = CameraCommand.getInstance();
  private updateInterval: NodeJS.Timeout | null = null;
  private activeContexts = new Map<string, ChatSettings>();
  private lastTitle = new Map<string, string>();
  private lastIconColor = new Map<string, string>();
  private logger = streamDeck.logger.createScope("DoChatMessage");

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
    this.lastIconColor.delete(ev.action.id);

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
   * Generate chat bubble SVG with configurable color
   */
  private generateChatSvg(color: string): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <path d="M14 18
           h44
           a6 6 0 0 1 6 6
           v24
           a6 6 0 0 1-6 6
           H26
           l-4 8
           l-4 -8
           H14
           a6 6 0 0 1-6-6
           V24
           a6 6 0 0 1 6-6
           z"
        fill="none"
        stroke="${color}"
        stroke-width="2.5"
        stroke-linejoin="round"/>
</svg>`;

    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  }

  /**
   * Update the display for a specific context
   */
  private async updateDisplay(contextId: string, settings: ChatSettings): Promise<void> {
    const action = streamDeck.actions.getActionById(contextId);

    if (!action) return;

    let title = "iRacing\nnot\nconnected";

    if (this.sdkController.getConnectionStatus()) {
      // Connected - show the message preview
      const message = settings.message?.trim();

      if (message) {
        // Show first few words of the message
        title = message.length > 20 ? message.substring(0, 17) + "..." : message;
      } else {
        title = "";
      }
    }

    // Get configured color (default to #4a90d9)
    const iconColor = settings.iconColor || "#4a90d9";

    // Only update if the title or color has changed
    const lastTitle = this.lastTitle.get(contextId);
    const lastColor = this.lastIconColor.get(contextId);

    if (lastTitle !== title || lastColor !== iconColor) {
      this.lastTitle.set(contextId, title);
      this.lastIconColor.set(contextId, iconColor);
      await action.setTitle(title);

      // Generate SVG with configured color
      const svgDataUri = this.generateChatSvg(iconColor);
      await action.setImage(svgDataUri);
    }
  }

  /**
   * When settings are received or updated
   */
  override async onDidReceiveSettings(ev: any): Promise<void> {
    // Update stored settings
    this.activeContexts.set(ev.action.id, ev.payload.settings);

    // Update display when settings change
    this.updateDisplay(ev.action.id, ev.payload.settings);
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

/**
 * Settings for the chat message action
 */
type ChatSettings = {
  message?: string;
  iconColor?: string;
};
