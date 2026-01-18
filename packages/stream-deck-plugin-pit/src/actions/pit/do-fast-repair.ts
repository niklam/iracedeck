import streamDeck, { action, KeyDownEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { hasFlag, PitSvFlags, TelemetryData } from "@iracedeck/iracing-sdk";
import { ConnectionStateAwareAction, createSDLogger, getCommands, LogLevel } from "@iracedeck/stream-deck-shared";
import z from "zod";

/**
 * Fast Repair Action
 * Toggles fast repair selection in pit service.
 * Dynamic icon shows wrench with color based on current state.
 * Green = currently ON (will turn OFF), Red = currently OFF (will turn ON)
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.pit.do-fast-repair" })
export class DoFastRepair extends ConnectionStateAwareAction<FastRepairSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("DoFastRepair"), LogLevel.Info);

  private get pitCommand() {
    return getCommands().pit;
  }

  private activeContexts = new Set<string>();
  private lastState = new Map<string, string>();

  override async onWillAppear(ev: WillAppearEvent<FastRepairSettings>): Promise<void> {
    this.activeContexts.add(ev.action.id);

    // Update display immediately
    await this.updateDisplayWithEvent(ev, null);

    // Subscribe to telemetry updates
    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      this.updateConnectionState();
      this.updateDisplay(ev.action.id, telemetry);
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<FastRepairSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
  }

  /**
   * Get fast repair state from telemetry
   */
  private getFastRepairState(telemetry: TelemetryData | null): boolean {
    if (!telemetry || telemetry.PitSvFlags === undefined) {
      return false;
    }

    return hasFlag(telemetry.PitSvFlags, PitSvFlags.FastRepair);
  }

  /**
   * Check if fast repairs are available
   */
  private getFastRepairsAvailable(telemetry: TelemetryData | null): number {
    if (!telemetry || telemetry.FastRepairAvailable === undefined) {
      return 0;
    }

    return telemetry.FastRepairAvailable;
  }

  /**
   * Generate magic wand SVG with color based on current state
   * Icon in top half, title text in bottom
   */
  private generateSvg(iconColor: string, showRedX: boolean, titleText: string, titleColor: string): string {
    const redX = showRedX
      ? `
      <!-- Red X (same size as fuel icon X) -->
      <line x1="21" y1="6" x2="51" y2="36" stroke="#e74c3c" stroke-width="4" stroke-linecap="round"/>
      <line x1="51" y1="6" x2="21" y2="36" stroke="#e74c3c" stroke-width="4" stroke-linecap="round"/>`
      : "";

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <g filter="url(#activity-state)">
    <!-- Magic wand (diagonal) -->
    <rect x="10" y="25" width="40" height="5" rx="2" transform="rotate(-45 28 22)" fill="${iconColor}"/>
    <!-- 4-pointed stars (large) -->
    <path d="M48,8 L50,14 L52,8 L50,2 Z M44,8 L50,10 L56,8 L50,6 Z" fill="${iconColor}"/>
    <path d="M56,24 L57.5,28 L59,24 L57.5,20 Z M53.5,24 L57.5,25.5 L61.5,24 L57.5,22.5 Z" fill="${iconColor}"/>
    <!-- 4-pointed star (small) -->
    <path d="M38,18 L39,21 L40,18 L39,15 Z M36,18 L39,19 L42,18 L39,17 Z" fill="${iconColor}"/>
    <!-- Small dots -->
    <circle cx="28" cy="6" r="2" fill="${iconColor}"/>
    <circle cx="60" cy="34" r="1.5" fill="${iconColor}"/>
    <!-- Title text -->
    <text class="title" x="36" y="65" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="${titleColor}">${titleText}</text>
    ${redX}
  </g>
</svg>`;

    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  }

  /**
   * Calculate display state from telemetry
   * Note: Connection state is handled by grayscale overlay from ConnectionStateAwareAction
   */
  private getDisplayState(telemetry: TelemetryData | null): {
    titleText: string;
    titleColor: string;
    iconColor: string;
    showRedX: boolean;
  } {
    const isOn = this.getFastRepairState(telemetry);
    const fastRepairsAvailable = this.getFastRepairsAvailable(telemetry);

    if (fastRepairsAvailable === 0) {
      return {
        titleText: "N/A",
        titleColor: "#ffffff",
        iconColor: "#888888",
        showRedX: false,
      };
    } else if (isOn) {
      return {
        titleText: "Fast Repair",
        titleColor: "#FFFFFF",
        iconColor: "#44FF44",
        showRedX: false,
      };
    } else {
      return {
        titleText: "No Repair",
        titleColor: "#FF4444",
        iconColor: "#FF4444",
        showRedX: false,
      };
    }
  }

  /**
   * Update display using an event (for initial setup, stores action ref)
   */
  private async updateDisplayWithEvent(
    ev: WillAppearEvent<FastRepairSettings>,
    telemetry: TelemetryData | null,
  ): Promise<void> {
    const { titleText, titleColor, iconColor, showRedX } = this.getDisplayState(telemetry);
    const svgDataUri = this.generateSvg(iconColor, showRedX, titleText, titleColor);

    // Update connection state for initial overlay
    this.updateConnectionState();

    // Store state for caching
    const stateKey = `${titleText}|${titleColor}|${iconColor}|${showRedX}`;
    this.lastState.set(ev.action.id, stateKey);

    // Set via BaseAction (stores for overlay refresh)
    await this.setKeyImage(ev, svgDataUri);
    await ev.action.setTitle(""); // Title is in the SVG
  }

  /**
   * Update the display for a specific context (called from subscription callback)
   */
  private async updateDisplay(contextId: string, telemetry: TelemetryData | null): Promise<void> {
    const action = streamDeck.actions.getActionById(contextId);

    if (!action) return;

    const { titleText, titleColor, iconColor, showRedX } = this.getDisplayState(telemetry);
    const svgDataUri = this.generateSvg(iconColor, showRedX, titleText, titleColor);

    // Create state key for caching
    const stateKey = `${titleText}|${titleColor}|${iconColor}|${showRedX}`;
    const lastState = this.lastState.get(contextId);

    if (lastState !== stateKey) {
      this.lastState.set(contextId, stateKey);
      await this.updateKeyImage(contextId, svgDataUri);
    }
  }

  /**
   * When the key is pressed - toggle fast repair
   */
  override async onKeyDown(_ev: KeyDownEvent<FastRepairSettings>): Promise<void> {
    this.logger.info("Key down received");

    // Check if connected to iRacing
    if (!this.sdkController.getConnectionStatus()) {
      this.logger.info("Not connected to iRacing");

      return;
    }

    const telemetry = this.sdkController.getCurrentTelemetry();

    // Check if fast repairs are available
    const fastRepairsAvailable = this.getFastRepairsAvailable(telemetry);

    if (fastRepairsAvailable === 0) {
      this.logger.info("No fast repairs available");

      return;
    }

    const isCurrentlyOn = this.getFastRepairState(telemetry);

    if (isCurrentlyOn) {
      // Currently on, turn off
      this.pitCommand.clearFastRepair();
      this.logger.info("Toggling fast repair OFF");
    } else {
      // Currently off, turn on
      this.pitCommand.fastRepair();
      this.logger.info("Toggling fast repair ON");
    }
  }
}

const FastRepairSettings = z.object({});

/**
 * Settings for the fast repair action
 */
type FastRepairSettings = z.infer<typeof FastRepairSettings>;
