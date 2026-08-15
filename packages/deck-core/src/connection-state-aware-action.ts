/**
 * Connection State Aware Action
 *
 * Extends BaseAction with:
 * - Automatic iRacing connection state tracking (no manual calls needed)
 * - Binding dispatch delegates (tap, hold, release)
 * - Binding-aware readiness (active/inactive overlay based on binding type)
 *
 * The deprecated updateConnectionState() method is still available for backward
 * compatibility but delegates to the new evaluateReadiness() internally.
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
import { onSimHubReachabilityChange } from "./simhub-service.js";
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
   * The currently active binding setting key(s) for readiness tracking.
   * Most modes track a single key; some (e.g. setup view-* dual-press modes)
   * track several, all of which must be configured/ready (issue #612).
   */
  private activeBindingKeys: string[] = [];

  /**
   * Unsubscribe function for global settings change listener.
   */
  private globalSettingsUnsubscribe: (() => void) | null = null;

  /**
   * Unsubscribe function for SimHub reachability change listener.
   */
  private simHubReachabilityUnsubscribe: (() => void) | null = null;

  // --- Lifecycle ---

  /**
   * Subscribe to SDK controller for automatic readiness tracking.
   * Actions that override onWillAppear MUST call super.onWillAppear(ev).
   */
  override async onWillAppear(ev: IDeckWillAppearEvent<T>): Promise<void> {
    await super.onWillAppear(ev);

    const subId = READINESS_SUB_PREFIX + ev.action.id;
    this.sdkController.subscribe(subId, () => {
      this.evaluateReadiness();
    });
  }

  /**
   * Unsubscribe from SDK controller readiness tracking.
   * Actions that override onWillDisappear MUST call super.onWillDisappear(ev).
   */
  override async onWillDisappear(ev: IDeckWillDisappearEvent<T>): Promise<void> {
    this.sdkController.unsubscribe(READINESS_SUB_PREFIX + ev.action.id);

    // Clean up listeners to prevent memory leaks
    if (this.globalSettingsUnsubscribe) {
      this.globalSettingsUnsubscribe();
      this.globalSettingsUnsubscribe = null;
    }

    if (this.simHubReachabilityUnsubscribe) {
      this.simHubReachabilityUnsubscribe();
      this.simHubReachabilityUnsubscribe = null;
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
   * (e.g., user switches mode or direction). Cleanup is automatic —
   * onWillDisappear unsubscribes all listeners.
   *
   * @param settingKey - The global settings key (e.g., "blackBoxLapTiming"), an
   *   array of keys (all required), or null/empty to clear. Empty strings are
   *   ignored, so a fixed-key mode can pass "" to track nothing.
   */
  protected setActiveBinding(settingKey: string | string[] | null): void {
    const keys = (Array.isArray(settingKey) ? settingKey : settingKey ? [settingKey] : []).filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );
    this.activeBindingKeys = keys;

    if (keys.length > 0) {
      // Subscribe to global settings changes (once)
      if (!this.globalSettingsUnsubscribe) {
        this.globalSettingsUnsubscribe = onGlobalSettingsChange(() => {
          this.evaluateReadiness();
        });
      }

      // Subscribe to SimHub reachability changes (once)
      if (!this.simHubReachabilityUnsubscribe) {
        this.simHubReachabilityUnsubscribe = onSimHubReachabilityChange(() => {
          this.evaluateReadiness();
        });
      }
    } else {
      // Clear binding — unsubscribe from change listeners
      if (this.globalSettingsUnsubscribe) {
        this.globalSettingsUnsubscribe();
        this.globalSettingsUnsubscribe = null;
      }

      if (this.simHubReachabilityUnsubscribe) {
        this.simHubReachabilityUnsubscribe();
        this.simHubReachabilityUnsubscribe = null;
      }
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
   * Wrapped in try-catch to prevent exceptions from breaking telemetry for all actions.
   */
  private evaluateReadiness(): void {
    try {
      const iRacingConnected = this.sdkController.getConnectionStatus();

      let isReady: boolean;

      if (this.activeBindingKeys.length > 0) {
        // All tracked keys must be ready (multi-key modes warn if any is missing).
        isReady = this.activeBindingKeys.every((key) => getBindingDispatcher().isReady(key, iRacingConnected));
      } else {
        isReady = iRacingConnected;
      }

      if (this.lastReadyStatus !== isReady) {
        this.logger.debug(`Readiness changed: ${this.lastReadyStatus} -> ${isReady}`);
        this.lastReadyStatus = isReady;
        this.setActive(isReady);
      }
    } catch (error) {
      this.logger.warn(`Readiness evaluation failed: ${error}`);
    }
  }

  /**
   * Get current iRacing connection status
   */
  protected getConnectionStatus(): boolean {
    return this.sdkController.getConnectionStatus();
  }

  /**
   * Whether the action's currently active binding requires a binding but has
   * neither a keyboard binding nor a SimHub role configured (issue #612).
   *
   * Drives the centered binding-missing warning overlay on the key icon.
   * Returns false when no binding is active (api/chat modes) or when a binding
   * of either type is set — including a SimHub role whose SimHub server is not
   * currently running (that is a reachability concern, not a missing binding).
   *
   * Derived from the same dispatcher source of truth as readiness, so the
   * icon overlay and readiness overlay never disagree about "configured".
   */
  protected isActiveBindingMissing(): boolean {
    return this.isBindingMissing(this.activeBindingKeys);
  }

  /**
   * Stateless per-context variant of {@link isActiveBindingMissing}: returns
   * true when the given binding key(s) require a binding but ANY is
   * unconfigured (neither keyboard nor SimHub). Pass `null`/empty for
   * api/chat/fixed modes (returns false).
   *
   * Use THIS — not {@link isActiveBindingMissing} — to drive a per-button icon
   * warning. One action-class instance serves every button context, so the
   * `activeBindingKeys` field that backs `isActiveBindingMissing` is shared and
   * would bleed one button's missing-binding state onto all the others. This
   * variant derives solely from its arguments + global settings (#612).
   *
   * Accepts a readonly array so callers can pass a shared `as const` /
   * `readonly string[]` key list straight in — the check only reads.
   *
   * @param keys - The binding setting key(s) for a specific button's mode.
   */
  protected isBindingMissing(keys: string | readonly string[] | null | undefined): boolean {
    const list = (Array.isArray(keys) ? keys : keys ? [keys] : []).filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );

    if (list.length === 0) return false;

    return list.some((key) => !getBindingDispatcher().isConfigured(key));
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
   * Execute several bindings as one atomic key sequence (issue #818).
   * Returns false when the sequence was skipped (unset / SimHub / unmappable key).
   *
   * @param settingKeys - Global settings keys, in press order
   * @param holdMs - Per-chord hold in ms; 0 (default) = one atomic batch
   */
  protected async tapBindingSequence(settingKeys: string[], holdMs?: number): Promise<boolean> {
    return getBindingDispatcher().tapSequence(settingKeys, holdMs);
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
