import streamDeck, {
  action,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import { hasFlag, PitCommand, PitSvFlags, SDKController, TelemetryData } from "@iracedeck/iracing-sdk";

/**
 * Fast Repair Action
 * Toggles fast repair selection in pit service.
 * Dynamic icon shows wrench with color based on current state.
 * Green = currently ON (will turn OFF), Red = currently OFF (will turn ON)
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.pit.do-fast-repair" })
export class DoFastRepair extends SingletonAction {
  private sdkController = SDKController.getInstance();
  private pitCommand = PitCommand.getInstance();
  private activeContexts = new Set<string>();
  private lastState = new Map<string, string>();
  private logger = streamDeck.logger.createScope("DoFastRepair");

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    this.activeContexts.add(ev.action.id);

    // Subscribe to telemetry updates
    this.sdkController.subscribe(ev.action.id, (telemetry, isConnected) => {
      this.updateDisplay(ev.action.id, telemetry, isConnected);
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent): Promise<void> {
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
   */
  private generateSvg(iconColor: string, showRedX: boolean): string {
    const redX = showRedX
      ? `
  <!-- Red X (same size as fuel icon X) -->
  <line x1="21" y1="6" x2="51" y2="36" stroke="#e74c3c" stroke-width="4" stroke-linecap="round"/>
  <line x1="51" y1="6" x2="21" y2="36" stroke="#e74c3c" stroke-width="4" stroke-linecap="round"/>`
      : "";

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <!-- Magic wand (diagonal) -->
  <rect x="10" y="25" width="40" height="5" rx="2" transform="rotate(-45 28 22)" fill="${iconColor}"/>
  <!-- 4-pointed stars (large) -->
  <path d="M48,8 L50,14 L52,8 L50,2 Z M44,8 L50,10 L56,8 L50,6 Z" fill="${iconColor}"/>
  <path d="M56,24 L57.5,28 L59,24 L57.5,20 Z M53.5,24 L57.5,25.5 L61.5,24 L57.5,22.5 Z" fill="${iconColor}"/>
  <!-- 4-pointed star (small) -->
  <path d="M38,18 L39,21 L40,18 L39,15 Z M36,18 L39,19 L42,18 L39,17 Z" fill="${iconColor}"/>
  <!-- Small dots -->
  <circle cx="28" cy="6" r="2" fill="${iconColor}"/>
  <circle cx="60" cy="34" r="1.5" fill="${iconColor}"/>${redX}
</svg>`;

    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  }

  /**
   * Update the display for a specific context
   */
  private async updateDisplay(contextId: string, telemetry: TelemetryData | null, isConnected: boolean): Promise<void> {
    const action = streamDeck.actions.getActionById(contextId);

    if (!action) return;

    let title: string;
    let iconColor: string;
    let showRedX = false;

    if (!isConnected) {
      title = "iRacing\nnot\nconnected";
      iconColor = "#888888";
    } else {
      const isOn = this.getFastRepairState(telemetry);
      const fastRepairsAvailable = this.getFastRepairsAvailable(telemetry);

      if (fastRepairsAvailable === 0) {
        title = "Not Avail";
        iconColor = "#888888";
        showRedX = true;
      } else if (isOn) {
        title = "Fast Repair";
        iconColor = "#44FF44";
      } else {
        title = "No fast\nRepair";
        iconColor = "#FF4444";
      }
    }

    const svgDataUri = this.generateSvg(iconColor, showRedX);

    // Create state key for caching
    const stateKey = `${title}|${iconColor}|${showRedX}`;
    const lastState = this.lastState.get(contextId);

    if (lastState !== stateKey) {
      this.lastState.set(contextId, stateKey);
      await action.setTitle(title);
      await action.setImage(svgDataUri);
    }
  }

  /**
   * When the key is pressed - toggle fast repair
   */
  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
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
