import streamDeck, {
  action,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";

import { SDKController } from "../../sdk-controller.js";

/**
 * Test Action
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.comms.test-action" })
export class TestAction extends SingletonAction<TestSettings> {
  private sdkController = SDKController.getInstance();
  private updateInterval: NodeJS.Timeout | null = null;
  private activeContexts = new Map<string, TestSettings>();
  private lastTitle = new Map<string, string>();
  private lastIconColor = new Map<string, string>();
  private logger = streamDeck.logger.createScope("TestConnection");

  /**
   * When the action appears on the Stream Deck
   */
  override async onWillAppear(ev: WillAppearEvent<TestSettings>): Promise<void> {
    this.logger.trace("onWillAppear");

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
    this.logger.trace("onWillDisappear");

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
    this.logger.trace("Start updates");

    this.updateInterval = setInterval(() => {
      for (const [contextId, settings] of this.activeContexts) {
        this.updateDisplay(contextId, settings);
      }
    }, 250);
  }

  /**
   * Stop periodic updates
   */
  private stopUpdates(): void {
    this.logger.trace("Stop updates");

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * Generate chat bubble SVG with configurable color
   */
  private generateTestSvg(color: string): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <circle cx="50" cy="50" r="40" fill="${color}"/>
</svg>`;

    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  }

  /**
   * Update the display for a specific context
   */
  private async updateDisplay(contextId: string, _settings: TestSettings): Promise<void> {
    const action = streamDeck.actions.getActionById(contextId);
    if (!action) return;

    let title = "iRacing\nnot\nconnected";
    const iconColor = this.sdkController.getConnectionStatus() ? "#00dd00" : "#dd0000";
    title = this.sdkController.getConnectionStatus() ? "Connected" : "Offline";

    // Only update if the title or color has changed
    const lastTitle = this.lastTitle.get(contextId);
    const lastColor = this.lastIconColor.get(contextId);

    if (lastTitle !== title || lastColor !== iconColor) {
      this.lastTitle.set(contextId, title);
      this.lastIconColor.set(contextId, iconColor);
      await action.setTitle(title);

      // Generate SVG with configured color
      const svgDataUri = this.generateTestSvg(iconColor);
      await action.setImage(svgDataUri);
    }
  }

  /**
   * When settings are received or updated
   */
  override async onDidReceiveSettings(ev: any): Promise<void> {
    this.logger.trace("Received Settings");
    // Update stored settings
    this.activeContexts.set(ev.action.id, ev.payload.settings);

    // Update display when settings change
    this.updateDisplay(ev.action.id, ev.payload.settings);
  }

  /**
   * When the key is pressed
   */
  override async onKeyDown(_ev: KeyDownEvent<TestSettings>): Promise<void> {
    this.logger.trace("Key down received");

    return;
  }
}

/**
 * Settings for the chat message action
 */
type TestSettings = {
  message?: string;
};
