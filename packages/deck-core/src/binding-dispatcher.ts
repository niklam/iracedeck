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
 * // In action code
 * await getBindingDispatcher().tap("blackBoxLapTiming");
 * await getBindingDispatcher().hold(ev.action.id, "lookDirectionLeft");
 * await getBindingDispatcher().release(ev.action.id);
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

  /** Press and hold a binding from global settings. */
  hold(actionId: string, settingKey: string): Promise<void>;

  /** Release a previously held binding. Safe to call if nothing is held. */
  release(actionId: string): Promise<void>;

  /** Check if a binding at the given setting key is ready to execute. */
  isReady(settingKey: string, iRacingConnected: boolean): boolean;
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

    // Keyboard binding (default)
    await this.tapKeyboard(binding);
  }

  /**
   * Press and hold a binding from global settings.
   * Stays active until release() is called for the same actionId.
   *
   * @param actionId - The action context ID (ev.action.id)
   * @param settingKey - The global settings key
   */
  async hold(actionId: string, settingKey: string): Promise<void> {
    const binding = this.resolveGlobalBinding(settingKey);

    if (!binding) return;

    if (isSimHubBinding(binding)) {
      this.logger.info("Triggering SimHub role (hold)");
      this.logger.debug(`SimHub role: ${binding.role}`);

      if (!isSimHubInitialized()) {
        this.logger.warn("SimHub service not initialized");

        return;
      }

      await getSimHub().startRole(binding.role);
      this.heldBindings.set(actionId, { type: "simhub", role: binding.role });

      return;
    }

    // Keyboard binding (default)
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

    this.heldBindings.delete(actionId);

    if (held.type === "simhub") {
      if (isSimHubInitialized()) {
        await getSimHub().stopRole(held.role);
        this.logger.info("SimHub role released");
      }

      return;
    }

    if (held.type === "keyboard") {
      const success = await getKeyboard().releaseKeyCombination(held.combination);

      if (success) {
        this.logger.info("Key released");
      } else {
        this.logger.warn("Failed to release key");
      }
    }

    // Future binding types: add release logic here
  }

  /**
   * Check if a binding at the given setting key is ready to execute.
   * Resolves the binding type and checks the relevant service health.
   *
   * - Keyboard binding: ready if iRacing SDK is connected
   * - SimHub binding: ready if SimHub service is initialized
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

    // Keyboard binding: depends on iRacing being connected
    return iRacingConnected;
  }

  // --- Internal helpers ---

  private resolveGlobalBinding(settingKey: string): BindingValue | undefined {
    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseBinding(globalSettings[settingKey]);

    if (!binding) {
      this.logger.debug(`No binding configured for ${settingKey}`);
    }

    return binding;
  }

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
      await simHub.stopRole(role);
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
 * Should be called once at plugin startup after initializeKeyboard and initializeSimHub.
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
