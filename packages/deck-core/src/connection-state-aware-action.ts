/**
 * Connection State Aware Action
 *
 * Extends BaseAction with:
 * - The disconnected look, decided per key (#1599): a key shows it while the
 *   setting is on, the sim is absent ({@link isSimAbsent}) and the key's own
 *   mode needs the sim ({@link ConnectionStateAwareAction.needsSim}).
 * - Binding dispatch delegates (tap, hold, release) and the stateless
 *   per-key binding checks.
 *
 * The action listens to the sim's presence while it has at least one live
 * context, and on a change pushes every live key's image again through
 * BaseAction's one image funnel, which draws the look. Nothing is evaluated
 * per tick. Spec: docs/superpowers/specs/2026-11-02-issue-1599-disconnected-key-look.md
 */
import { getGlobalSettings } from "@iracedeck/settings";

import { BaseAction } from "./base-action.js";
import { getBindingDispatcher } from "./binding-dispatcher.js";
import { getSimConnection, isSimAbsent, onSimPresenceChange } from "./sim-connection.js";
import type { IDeckWillAppearEvent, IDeckWillDisappearEvent } from "./types.js";

/**
 * Abstract base class for actions that need sim connection state awareness
 * and/or binding dispatch.
 *
 * @template T - The settings type for this action
 */
export abstract class ConnectionStateAwareAction<T = Record<string, unknown>> extends BaseAction<T> {
  /** Contexts that have appeared and not yet disappeared. */
  private readonly liveContexts = new Set<string>();

  /** Removes the sim-presence listener; set while {@link liveContexts} is not empty. */
  private presenceUnsubscribe: (() => void) | null = null;

  // --- Lifecycle ---

  /**
   * Starts listening to the sim's presence when the action's first context
   * appears. Actions that override onWillAppear MUST call super.onWillAppear(ev).
   * A key that appears before the sim connection exists loses nothing: the
   * presence signal's subscription is queued and replayed at initialisation.
   */
  override async onWillAppear(ev: IDeckWillAppearEvent<T>): Promise<void> {
    await super.onWillAppear(ev);

    this.liveContexts.add(ev.action.id);

    if (!this.presenceUnsubscribe) {
      this.presenceUnsubscribe = onSimPresenceChange(() => this.refreshAllImages());
    }
  }

  /**
   * Stops listening to the sim's presence when the action's last context
   * disappears, so one key leaving never stops another's updates.
   * Actions that override onWillDisappear MUST call super.onWillDisappear(ev).
   */
  override async onWillDisappear(ev: IDeckWillDisappearEvent<T>): Promise<void> {
    this.liveContexts.delete(ev.action.id);

    if (this.liveContexts.size === 0 && this.presenceUnsubscribe) {
      this.presenceUnsubscribe();
      this.presenceUnsubscribe = null;
    }

    await super.onWillDisappear(ev);
  }

  // --- The disconnected look (#1599) ---

  /**
   * Whether a key with these settings needs the sim to do anything: `true`
   * unless the action says otherwise for the key's current mode. Handed the
   * raw settings of the context being drawn (possibly `undefined` before the
   * context has appeared); an override parses them with the action's own
   * schema. The binding type does not change the answer: a SimHub-bound mode
   * needs the sim as much as a keyboard-bound one.
   *
   * @param settings - The context's raw settings
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected needsSim(settings: unknown): boolean {
    return true;
  }

  /**
   * A key shows the disconnected look while the setting is on, the sim is
   * absent and the key's own mode needs the sim.
   */
  protected override showsDisconnected(contextId: string): boolean {
    return (
      getGlobalSettings().showDisconnectedState === true &&
      isSimAbsent() &&
      this.needsSim(this.getContextSettings(contextId))
    );
  }

  // --- Connection and bindings ---

  /**
   * Get the current sim connection status
   */
  protected getConnectionStatus(): boolean {
    return getSimConnection().isConnected();
  }

  /**
   * Whether the given binding key(s) require a binding but ANY is
   * unconfigured (neither keyboard nor SimHub) — the #612 binding-missing
   * warning on the key icon. Pass `null`/empty for api/chat/fixed modes
   * (returns false). Derives solely from its arguments and the global
   * settings, so it is safe per key: one action-class instance serves every
   * key it is placed on.
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

  /**
   * Whether the binding at `key` is a keyboard binding — false for a SimHub
   * role, an unset or a corrupt value (#962). Only keyboard bindings can join
   * an atomic {@link tapBindingSequence}.
   *
   * @param key - The global settings key
   */
  protected isBindingKeyboardBound(key: string): boolean {
    return getBindingDispatcher().isKeyboardBound(key);
  }

  // --- Binding dispatch delegates ---

  /**
   * Execute a tap (press + release) binding from global settings.
   *
   * @param settingKey - The global settings key (e.g., "blackBoxLapTiming")
   * @returns true when the press was dispatched; false when nothing is bound,
   *   SimHub is not initialized, or the send failed (#962)
   */
  protected async tapBinding(settingKey: string): Promise<boolean> {
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
