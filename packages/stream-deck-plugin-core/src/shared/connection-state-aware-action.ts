/**
 * Connection State Aware Action
 *
 * Extends BaseAction with automatic iRacing connection state tracking.
 * Automatically updates active/inactive overlay when connection status changes.
 */
import type { JsonObject } from "@elgato/utils";
import type { SDKController } from "@iracedeck/iracing-sdk";

import { BaseAction } from "./base-action.js";
import { getController } from "./sdk-singleton.js";

/**
 * Abstract base class for actions that need iRacing connection state awareness.
 *
 * Features:
 * - Inherits all BaseAction features (SVG image management, inactive overlay)
 * - Automatically tracks connection status and updates active state
 * - Provides access to SDKController via `this.sdkController`
 *
 * Note: Requires initializeSDK() to be called before any actions are instantiated.
 *
 * @template T - The settings type for this action
 *
 * @example
 * ```typescript
 * @action({ UUID: "com.example.my-action" })
 * export class MyAction extends ConnectionStateAwareAction<MySettings> {
 *   override async onWillAppear(ev: WillAppearEvent<MySettings>): Promise<void> {
 *     await super.onWillAppear(ev);
 *     await this.setKeyImage(ev, generateMySvg());
 *   }
 *
 *   private async updateDisplay(contextId: string): Promise<void> {
 *     this.updateConnectionState(); // Call this in periodic updates
 *     // ... rest of update logic
 *   }
 * }
 * ```
 */
export abstract class ConnectionStateAwareAction<T extends JsonObject = JsonObject> extends BaseAction<T> {
  /**
   * SDKController instance for iRacing communication.
   * Lazily initialized from the SDK singleton.
   */
  protected get sdkController(): SDKController {
    return getController();
  }

  /**
   * Last known connection status for change detection
   */
  private lastConnectionStatus: boolean | null = null;

  /**
   * Check connection status and update active state if changed.
   * Call this in periodic update loops to keep overlay state in sync.
   */
  protected updateConnectionState(): void {
    const isConnected = this.sdkController.getConnectionStatus();

    if (this.lastConnectionStatus !== isConnected) {
      this.logger.info(`updateConnectionState: ${this.lastConnectionStatus} -> ${isConnected}`);
      this.lastConnectionStatus = isConnected;
      this.setActive(isConnected);
    }
  }

  /**
   * Get current iRacing connection status
   */
  protected getConnectionStatus(): boolean {
    return this.sdkController.getConnectionStatus();
  }
}
