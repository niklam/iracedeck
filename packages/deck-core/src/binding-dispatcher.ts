/**
 * Binding Dispatcher Singleton
 *
 * Centralized service for resolving and executing bindings from global settings.
 * Handles keyboard shortcuts, SimHub Control Mapper roles, and future binding
 * types (e.g., vJoy) through simple if/else dispatch.
 *
 * Actions call tap/hold/release without knowing the binding type — the dispatcher
 * resolves the global setting, determines the type, and routes to the appropriate
 * service.
 *
 * Usage:
 * 1. Call initializeBindingDispatcher() once at plugin startup
 * 2. Use getBindingDispatcher() in action code
 *
 * @example
 * // In plugin.ts
 * initializeBindingDispatcher(adapter.createLogger("BindingDispatcher"));
 *
 * // In action code (via ConnectionStateAwareAction delegates)
 * await this.tapBinding("blackBoxLapTiming");
 * await this.holdBinding(ev.action.id, "lookDirectionLeft");
 * await this.releaseBinding(ev.action.id);
 */
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";

import { type BindingValue, getGlobalSettings, isSimHubBinding, type KeyBindingValue } from "./global-settings.js";
import { formatKeyBinding, parseBinding } from "./key-binding-utils.js";
import { getKeyboard } from "./keyboard-service.js";
import type { KeyboardKey, KeyboardModifier, KeyCombination } from "./keyboard-types.js";
import { getSimHub, isSimHubInitialized, isSimHubReachable } from "./simhub-service.js";

/**
 * Discriminated union for tracking held bindings across all binding types.
 * Extensible: add new variants here when new binding methods are introduced.
 */
type HeldBinding = { type: "keyboard"; combination: KeyCombination } | { type: "simhub"; role: string };

/**
 * Interface for the binding dispatcher service.
 */
export interface IBindingDispatcher {
  /** Execute a tap (press + release) binding from global settings. */
  tap(settingKey: string): Promise<void>;

  /**
   * Execute several bindings as ONE atomic key sequence (issue #818).
   *
   * Sends nothing and returns false when any binding is unset, is a SimHub role
   * (it goes over HTTP and cannot join a SendInput batch), or has no scan code
   * mapping. Callers must treat false as "skip" — a non-atomic fallback would
   * reintroduce the visible intermediate state this API exists to prevent.
   *
   * @param settingKeys - Global settings keys, in press order
   * @param holdMs - Per-chord hold in ms; 0 (default) = one atomic batch
   * @returns true if the sequence was dispatched, false if it was skipped
   */
  tapSequence(settingKeys: string[], holdMs?: number): Promise<boolean>;

  /** Press and hold a binding from global settings. */
  hold(actionId: string, settingKey: string): Promise<void>;

  /** Release a previously held binding. Safe to call if nothing is held. */
  release(actionId: string): Promise<void>;

  /** Check if a binding at the given setting key is ready to execute. */
  isReady(settingKey: string, iRacingConnected: boolean): boolean;

  /**
   * Whether a binding (keyboard or SimHub role) is configured at the given
   * setting key — independent of connection/reachability (issue #612).
   */
  isConfigured(settingKey: string): boolean;
}

/**
 * Binding dispatcher service implementation.
 */
class BindingDispatcher implements IBindingDispatcher {
  private logger: ILogger;
  private heldBindings = new Map<string, HeldBinding>();

  constructor(logger: ILogger) {
    this.logger = logger;
  }

  /**
   * Resolve and execute a tap (press + release) binding from global settings.
   *
   * @param settingKey - The global settings key (e.g., "blackBoxLapTiming")
   */
  async tap(settingKey: string): Promise<void> {
    const binding = this.resolveGlobalBinding(settingKey);

    if (!binding) return;

    if (isSimHubBinding(binding)) {
      await this.tapSimHub(binding.role);

      return;
    }

    await this.tapKeyboard(binding);
  }

  /**
   * Resolve several bindings and send them as one atomic key sequence.
   *
   * @param settingKeys - Global settings keys, in press order
   * @param holdMs - Per-chord hold in ms; 0 (default) = one atomic batch
   */
  async tapSequence(settingKeys: string[], holdMs = 0): Promise<boolean> {
    if (settingKeys.length === 0) return false;

    const combinations: KeyCombination[] = [];

    for (const settingKey of settingKeys) {
      const binding = this.resolveGlobalBinding(settingKey);

      if (!binding) return false;

      if (isSimHubBinding(binding)) {
        this.logger.debug(`Binding for ${settingKey} is a SimHub role, cannot batch — skipping sequence`);

        return false;
      }

      combinations.push(this.toKeyCombination(binding));
    }

    const sent = await getKeyboard().sendKeySequence(combinations, holdMs);

    if (sent) {
      this.logger.info("Key sequence sent successfully");
      this.logger.debug(`Key sequence: ${settingKeys.join(" -> ")}`);
    } else {
      this.logger.debug(`Key sequence skipped: ${settingKeys.join(" -> ")}`);
    }

    return sent;
  }

  /**
   * Press and hold a binding from global settings.
   * Stays active until release() is called for the same actionId.
   *
   * @param actionId - The action context ID (ev.action.id)
   * @param settingKey - The global settings key
   */
  async hold(actionId: string, settingKey: string): Promise<void> {
    // Release before resolve — even if the new binding turns out to be invalid,
    // the old one must not stay held (would cause a stuck key/role).
    await this.release(actionId);

    const binding = this.resolveGlobalBinding(settingKey);

    if (!binding) return;

    if (isSimHubBinding(binding)) {
      this.logger.info("Triggering SimHub role (hold)");
      this.logger.debug(`SimHub role: ${binding.role}`);

      if (!isSimHubInitialized()) {
        this.logger.warn("SimHub service not initialized");

        return;
      }

      const started = await getSimHub().startRole(binding.role);

      if (started) {
        this.heldBindings.set(actionId, { type: "simhub", role: binding.role });
      } else {
        this.logger.warn("Failed to start SimHub role");
      }

      return;
    }

    const combination = this.toKeyCombination(binding);
    const success = await getKeyboard().pressKeyCombination(combination);

    if (success) {
      this.heldBindings.set(actionId, { type: "keyboard", combination });
      this.logger.info("Key pressed (holding)");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to press key");
    }
  }

  /**
   * Release a previously held binding for the given action context.
   * Safe to call even if nothing is held (no-op).
   *
   * @param actionId - The action context ID (ev.action.id)
   */
  async release(actionId: string): Promise<void> {
    const held = this.heldBindings.get(actionId);

    if (!held) return;

    // Entry is only removed on successful release. On failure the key/role is
    // still physically held, so we keep the entry so onWillDisappear can retry.
    switch (held.type) {
      case "simhub": {
        if (isSimHubInitialized()) {
          const stopped = await getSimHub().stopRole(held.role);

          if (stopped) {
            this.heldBindings.delete(actionId);
            this.logger.info("SimHub role released");
          } else {
            this.logger.warn("Failed to release SimHub role");
          }
        } else {
          // Service gone — drop the entry since we can't release it
          this.heldBindings.delete(actionId);
          this.logger.warn("SimHub service not initialized, cannot release role");
        }

        break;
      }

      case "keyboard": {
        const success = await getKeyboard().releaseKeyCombination(held.combination);

        if (success) {
          this.heldBindings.delete(actionId);
          this.logger.info("Key released");
        } else {
          this.logger.warn("Failed to release key");
        }

        break;
      }

      default: {
        const _exhaustive: never = held;
        this.heldBindings.delete(actionId);
        this.logger.warn(`Unknown held binding type: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /**
   * Check if a binding at the given setting key is ready to execute.
   * Resolves the binding type and checks the relevant service health.
   *
   * - Keyboard binding: ready when the caller's iRacingConnected parameter is true
   * - SimHub binding: ready when SimHub is reachable
   * - No binding configured: not ready
   *
   * @param settingKey - The global settings key
   * @param iRacingConnected - Current iRacing connection status (caller provides this)
   */
  isReady(settingKey: string, iRacingConnected: boolean): boolean {
    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseBinding(globalSettings[settingKey]);

    if (!binding) return false;

    if (isSimHubBinding(binding)) {
      return isSimHubReachable();
    }

    return iRacingConnected;
  }

  /**
   * Whether a binding (keyboard OR SimHub role) is configured at the given
   * setting key — independent of iRacing connection or SimHub reachability.
   *
   * This is the source of truth for the binding-missing icon warning (#612):
   * a keybind mode warns only when NEITHER a keyboard binding nor a SimHub
   * role is set. SimHub-not-running is a separate (reachability) concern and
   * does not count as "not configured".
   *
   * @param settingKey - The global settings key
   */
  isConfigured(settingKey: string): boolean {
    const globalSettings = getGlobalSettings() as Record<string, unknown>;

    return parseBinding(globalSettings[settingKey]) !== undefined;
  }

  // --- Internal helpers ---

  private resolveGlobalBinding(settingKey: string): BindingValue | undefined {
    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const rawValue = globalSettings[settingKey];
    const binding = parseBinding(rawValue);

    if (!binding) {
      if (rawValue != null && rawValue !== "") {
        this.logger.warn(`Corrupt binding value for ${settingKey}`);
        this.logger.debug(`Raw value: ${JSON.stringify(rawValue)}`);
      } else {
        this.logger.debug(`No binding configured for ${settingKey}`);
      }
    }

    return binding;
  }

  // SimHub tap = activate then immediately deactivate (momentary press).
  // SimHub Control Mapper handles the duration internally.
  private async tapSimHub(role: string): Promise<void> {
    this.logger.info("Triggering SimHub role");
    this.logger.debug(`SimHub role: ${role}`);

    if (!isSimHubInitialized()) {
      this.logger.warn("SimHub service not initialized");

      return;
    }

    const simHub = getSimHub();
    const started = await simHub.startRole(role);

    if (started) {
      const stopped = await simHub.stopRole(role);

      if (!stopped) {
        this.logger.warn("SimHub role started but failed to stop — role may remain active");
      }
    }
  }

  private async tapKeyboard(binding: KeyBindingValue): Promise<void> {
    const combination = this.toKeyCombination(binding);

    const success = await getKeyboard().sendKeyCombination(combination);

    if (success) {
      this.logger.info("Key sent successfully");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to send key");
      this.logger.debug(`Failed key combination: ${formatKeyBinding(binding)}`);
    }
  }

  private toKeyCombination(binding: KeyBindingValue): KeyCombination {
    return {
      key: binding.key as KeyboardKey,
      modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
      code: binding.code,
    };
  }
}

// Singleton instance
let dispatcher: BindingDispatcher | null = null;

/**
 * Initialize the binding dispatcher singleton.
 * Should be called once at plugin startup after initGlobalSettings(),
 * initializeKeyboard(), and initializeSimHub().
 *
 * @param logger - Logger instance
 * @returns The initialized dispatcher
 * @throws Error if called more than once
 */
export function initializeBindingDispatcher(logger: ILogger = silentLogger): IBindingDispatcher {
  if (dispatcher) {
    throw new Error(
      "Binding dispatcher already initialized. initializeBindingDispatcher() should only be called once.",
    );
  }

  dispatcher = new BindingDispatcher(logger);
  logger.info("Initialized");

  return dispatcher;
}

/**
 * Get the binding dispatcher for executing bindings.
 *
 * @returns The dispatcher instance
 * @throws Error if not initialized
 */
export function getBindingDispatcher(): IBindingDispatcher {
  if (!dispatcher) {
    throw new Error(
      "Binding dispatcher not initialized. Call initializeBindingDispatcher() first in your plugin entry point.",
    );
  }

  return dispatcher;
}

/**
 * Check if the binding dispatcher has been initialized.
 */
export function isBindingDispatcherInitialized(): boolean {
  return dispatcher !== null;
}

/**
 * Reset the binding dispatcher singleton (for testing purposes only).
 * @internal
 */
export function _resetBindingDispatcher(): void {
  dispatcher = null;
}
