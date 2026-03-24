/**
 * Connection State Aware Action
 *
 * Extends BaseAction with:
 * - Automatic iRacing connection state tracking (no manual calls needed)
 * - Binding dispatch delegates (tap, hold, release)
 * - Binding-aware readiness (active/inactive overlay based on binding type)
 *
 * Readiness is fully automatic:
 * - The base class subscribes to the SDK controller on onWillAppear and
 *   evaluates readiness on every telemetry tick.
 * - setActiveBinding(key) declares which binding the action depends on.
 *   When set, readiness is determined by the binding type. When not set,
 *   readiness falls back to iRacing connection status.
 * - Global settings changes (e.g., user switches a binding from keyboard
 *   to SimHub) trigger automatic readiness re-evaluation.
 * - Actions never need to call updateConnectionState() manually.
 */
import type { SDKController } from "@iracedeck/iracing-sdk";

import { BaseAction } from "./base-action.js";
import { getBindingDispatcher } from "./binding-dispatcher.js";
import { onGlobalSettingsChange } from "./global-settings.js";
import { getController } from "./sdk-singleton.js";
import type { IDeckWillAppearEvent, IDeckWillDisappearEvent } from "./types.js";

/** Prefix for the base class's internal SDK subscription ID */
const READINESS_SUB_PREFIX = "_readiness:";

/**
 * Abstract base class for actions that need iRacing connection state awareness
 * and/or binding dispatch.
 *
 * @template T - The settings type for this action
 */
export abstract class ConnectionStateAwareAction<T = Record<string, unknown>> extends BaseAction<T> {
  /**
   * SDKController instance for iRacing communication.
   * Lazily initialized from the SDK singleton.
   */
  protected get sdkController(): SDKController {
    return getController();
  }

  /**
   * Last known connection/readiness status for change detection
   */
  private lastReadyStatus: boolean | null = null;

  /**
   * The currently active binding setting key for readiness tracking.
   */
  private activeBindingKey: string | null = null;

  /**
   * Unsubscribe function for global settings change listener.
   */
  private globalSettingsUnsubscribe: (() => void) | null = null;

  /**
   * Tracked action IDs for automatic SDK subscription cleanup.
   */
  private readinessSubscriptions = new Set<string>();

  // --- Lifecycle ---

  /**
   * Subscribe to SDK controller for automatic readiness tracking.
   * Actions that override onWillAppear MUST call super.onWillAppear(ev).
   */
  override async onWillAppear(ev: IDeckWillAppearEvent<T>): Promise<void> {
    await super.onWillAppear(ev);

    const subId = READINESS_SUB_PREFIX + ev.action.id;
    this.readinessSubscriptions.add(subId);
    this.sdkController.subscribe(subId, () => {
      this.evaluateReadiness();
    });
  }

  /**
   * Unsubscribe from SDK controller readiness tracking.
   * Actions that override onWillDisappear MUST call super.onWillDisappear(ev).
   */
  override async onWillDisappear(ev: IDeckWillDisappearEvent<T>): Promise<void> {
    const subId = READINESS_SUB_PREFIX + ev.action.id;
    this.readinessSubscriptions.delete(subId);
    this.sdkController.unsubscribe(subId);

    // Clean up global settings listener to prevent memory leaks
    if (this.globalSettingsUnsubscribe) {
      this.globalSettingsUnsubscribe();
      this.globalSettingsUnsubscribe = null;
    }

    await super.onWillDisappear(ev);
  }

  // --- Readiness ---

  /**
   * Declare the binding setting key this action instance currently depends on.
   * Immediately evaluates readiness and subscribes to global settings changes
   * so readiness updates automatically when the binding is modified in the
   * Property Inspector.
   *
   * Call in onWillAppear and onDidReceiveSettings when the setting key changes
   * (e.g., user switches mode or direction).
   *
   * @param settingKey - The global settings key (e.g., "blackBoxLapTiming"), or null to clear
   */
  protected setActiveBinding(settingKey: string | null): void {
    this.activeBindingKey = settingKey;

    // Subscribe to global settings changes (once)
    if (settingKey && !this.globalSettingsUnsubscribe) {
      this.globalSettingsUnsubscribe = onGlobalSettingsChange(() => {
        this.evaluateReadiness();
      });
    }

    // Immediately evaluate readiness
    this.evaluateReadiness();
  }

  /**
   * @deprecated Use setActiveBinding() for binding-aware actions. For SDK-only
   * actions, readiness is tracked automatically via the base class subscription.
   * This method is kept for backward compatibility during migration.
   */
  protected updateConnectionState(): void {
    this.evaluateReadiness();
  }

  /**
   * Internal readiness evaluation — called automatically by the SDK subscription,
   * setActiveBinding, and the global settings change listener.
   */
  private evaluateReadiness(): void {
    const iRacingConnected = this.sdkController.getConnectionStatus();

    let isReady: boolean;

    if (this.activeBindingKey) {
      isReady = getBindingDispatcher().isReady(this.activeBindingKey, iRacingConnected);
    } else {
      isReady = iRacingConnected;
    }

    if (this.lastReadyStatus !== isReady) {
      this.logger.debug(`Readiness changed: ${this.lastReadyStatus} -> ${isReady}`);
      this.lastReadyStatus = isReady;
      this.setActive(isReady);
    }
  }

  /**
   * Get current iRacing connection status
   */
  protected getConnectionStatus(): boolean {
    return this.sdkController.getConnectionStatus();
  }

  // --- Binding dispatch delegates ---

  /**
   * Execute a tap (press + release) binding from global settings.
   *
   * @param settingKey - The global settings key (e.g., "blackBoxLapTiming")
   */
  protected async tapBinding(settingKey: string): Promise<void> {
    return getBindingDispatcher().tap(settingKey);
  }

  /**
   * Press and hold a binding from global settings.
   * Stays active until releaseBinding is called for the same actionId.
   *
   * @param actionId - The action context ID (ev.action.id)
   * @param settingKey - The global settings key
   */
  protected async holdBinding(actionId: string, settingKey: string): Promise<void> {
    return getBindingDispatcher().hold(actionId, settingKey);
  }

  /**
   * Release a previously held binding for the given action context.
   * Safe to call even if nothing is held (no-op).
   *
   * @param actionId - The action context ID (ev.action.id)
   */
  protected async releaseBinding(actionId: string): Promise<void> {
    return getBindingDispatcher().release(actionId);
  }
}
