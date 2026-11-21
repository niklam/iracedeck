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
 * // At startup (the shared bootstrap: plugin-runtime's phases/start-services.ts)
 * initializeBindingDispatcher(adapter.createLogger("BindingDispatcher"));
 *
 * // In action code (via ConnectionStateAwareAction delegates)
 * await this.tapBinding("blackBoxLapTiming");
 * await this.holdBinding(ev.action.id, "lookDirectionLeft");
 * await this.releaseBinding(ev.action.id);
 */
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";
import { type BindingValue, getGlobalSettings, isSimHubBinding, type KeyBindingValue } from "@iracedeck/settings";

import { formatKeyBinding, parseBinding } from "./key-binding-utils.js";
import { getKeyboard } from "./keyboard-service.js";
import type { KeyboardKey, KeyboardModifier, KeyCombination } from "./keyboard-types.js";
import { canSendByScanCode } from "./scan-code-map.js";
import { getSimHub, isSimHubInitialized, isSimHubReachable } from "./simhub-service.js";

/**
 * Discriminated union for tracking held bindings across all binding types.
 * Extensible: add new variants here when new binding methods are introduced.
 */
type HeldBinding = { type: "keyboard"; combination: KeyCombination } | { type: "simhub"; role: string };

/**
 * A SimHub hold whose start has not returned yet (#1693). A release that
 * arrives meanwhile finds nothing held, so it sets `released` and the hold
 * releases the role once its start has gone through; `done` settles when the
 * hold, that release included, has finished.
 */
type PendingSimHubHold = { released: boolean; done: Promise<void> };

/**
 * Interface for the binding dispatcher service.
 */
export interface IBindingDispatcher {
  /**
   * Execute a tap (press + release) binding from global settings.
   *
   * @returns true when the press was dispatched (keyboard: the key combination
   *   was sent; SimHub: the role started, even if stopping it then failed);
   *   false when nothing is bound, SimHub is not initialized, or the send failed.
   */
  tap(settingKey: string): Promise<boolean>;

  /**
   * Execute several bindings as ONE atomic key sequence (issue #818).
   *
   * Sends nothing and returns false when any binding is unset, is a SimHub role
   * (it goes over HTTP and cannot join a SendInput batch), or has no scan code
   * mapping. It never degrades to separate taps on its own: a non-atomic
   * fallback would reintroduce the visible intermediate state this API exists
   * to prevent. Whether a caller may instead run its own serialized path is
   * that caller's policy, decided from the bindings up front rather than from
   * this method's false (see `shared/black-box.ts` in `@iracedeck/iracing-actions`,
   * #962).
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
   * setting key — independent of connection/reachability (issue #612). A
   * keyboard binding the keyboard service cannot send by scan code is not
   * configured (#1495).
   */
  isConfigured(settingKey: string): boolean;

  /**
   * Whether the binding at the given setting key is a keyboard binding — true
   * only for a parsed keyboard binding the keyboard service can send by scan
   * code; false for a SimHub role, an unset or a corrupt value (#962), and a
   * keyboard binding with no scan code to send (#1495). A keyboard binding is
   * the only kind that can join an atomic {@link IBindingDispatcher.tapSequence}.
   */
  isKeyboardBound(settingKey: string): boolean;
}

/**
 * Whether a binding is a keyboard binding the keyboard service cannot send by
 * scan code (#1495): no `code` or an empty one, a `code` the scan-code map does
 * not hold (`"F13"`, `"CapsLock"`, a typo), or a modifier other than `ctrl`,
 * `shift` or `alt` (`"Ctrl"`, `"meta"`). Bindings were saved by key name only
 * before scan-code input (`e1c35ef01`), and the recorder writes only codes and
 * modifiers the map holds, so only a settings file from before then, or one
 * edited by hand, holds such a binding. The keyboard service sends by scan code
 * only and would send nothing for it, so it is treated as unbound — the user
 * gets the #612 missing-binding warning and re-records it. The schema still
 * accepts it (`code` is optional and `modifiers` any strings there, a published
 * settings contract); this is where it stops counting as bound. The check is
 * {@link canSendByScanCode}, built on the same lookups as the service's own, so
 * the two cannot disagree. `code` is never filled in from the key name.
 */
function cannotSendByScanCode(binding: BindingValue): boolean {
  return !isSimHubBinding(binding) && !canSendByScanCode(binding);
}

/**
 * Binding dispatcher service implementation.
 */
class BindingDispatcher implements IBindingDispatcher {
  private logger: ILogger;
  private heldBindings = new Map<string, HeldBinding>();
  /**
   * The tail of each SimHub role's request queue (#1693): every start and stop
   * of a role waits for the one before it, so two presses of one role never
   * interleave. Removed once the role's last request has settled.
   */
  private simHubRoleQueues = new Map<string, Promise<void>>();
  /** SimHub holds whose start is still in flight, by action context (#1693). */
  private pendingSimHubHolds = new Map<string, PendingSimHubHold>();

  constructor(logger: ILogger) {
    this.logger = logger;
  }

  /**
   * Resolve and execute a tap (press + release) binding from global settings.
   *
   * @param settingKey - The global settings key (e.g., "blackBoxLapTiming")
   * @returns true when the press was dispatched, false otherwise
   */
  async tap(settingKey: string): Promise<boolean> {
    const binding = this.resolveGlobalBinding(settingKey);

    if (!binding) return false;

    if (isSimHubBinding(binding)) {
      return this.tapSimHub(binding.role);
    }

    return this.tapKeyboard(binding);
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
    // A SimHub hold of this context whose start is still in flight finishes
    // first, the release it may owe included, so its stop is never queued
    // behind this hold's start (#1693).
    await this.pendingSimHubHolds.get(actionId)?.done;

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

      const role = binding.role;
      let finish!: () => void;
      const pending: PendingSimHubHold = { released: false, done: new Promise<void>((resolve) => (finish = resolve)) };
      this.pendingSimHubHolds.set(actionId, pending);

      try {
        // The start may wait behind earlier requests of the role, then on SimHub
        // itself; a key released meanwhile has its release carried out here.
        const started = await this.inRoleOrder(role, () => getSimHub().startRole(role));

        if (started) {
          this.heldBindings.set(actionId, { type: "simhub", role });

          if (pending.released) {
            this.logger.debug("SimHub role was released while it was starting; releasing it now");
            await this.release(actionId);
          }
        } else {
          this.logger.warn("Failed to start SimHub role");
        }
      } finally {
        if (this.pendingSimHubHolds.get(actionId) === pending) this.pendingSimHubHolds.delete(actionId);

        finish();
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
    // A SimHub hold still starting is released by the hold once its start has
    // gone through (#1693).
    const pending = this.pendingSimHubHolds.get(actionId);

    if (pending) pending.released = true;

    const held = this.heldBindings.get(actionId);

    if (!held) return;

    // Entry is only removed on successful release. On failure the key/role is
    // still physically held, so we keep the entry so onWillDisappear can retry.
    switch (held.type) {
      case "simhub": {
        if (isSimHubInitialized()) {
          const role = held.role;
          const stopped = await this.inRoleOrder(role, () => getSimHub().stopRole(role));

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
    const binding = this.peekBinding(settingKey);

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
   * does not count as "not configured". A keyboard binding the keyboard
   * service cannot send by scan code (only a settings file from before scan
   * codes, or one edited by hand, holds one) does count, so the user is told to
   * re-record it (#1495).
   *
   * @param settingKey - The global settings key
   */
  isConfigured(settingKey: string): boolean {
    return this.peekBinding(settingKey) !== undefined;
  }

  /**
   * Whether the binding at the given setting key is a parsed keyboard binding
   * (#962). A SimHub role, an unset and a corrupt value all return false, and
   * so does a keyboard binding with no scan code to send (#1495).
   *
   * @param settingKey - The global settings key
   */
  isKeyboardBound(settingKey: string): boolean {
    const binding = this.peekBinding(settingKey);

    return binding !== undefined && !isSimHubBinding(binding);
  }

  // --- Internal helpers ---

  /**
   * The usable binding at a setting key, read silently — the state queries
   * (`isReady`, `isConfigured`, `isKeyboardBound`) run on every render, so unlike
   * {@link resolveGlobalBinding} this never logs a missing, corrupt or
   * unsendable value. A keyboard binding the keyboard service cannot send by
   * scan code reads as unset.
   */
  private peekBinding(settingKey: string): BindingValue | undefined {
    const globalSettings = getGlobalSettings();
    const binding = parseBinding(globalSettings[settingKey]);

    return binding && !cannotSendByScanCode(binding) ? binding : undefined;
  }

  /**
   * The usable binding at a setting key, for the methods that send it (`tap`,
   * `tapSequence`, `hold`). Reads as {@link peekBinding} does, and logs why
   * nothing is returned.
   */
  private resolveGlobalBinding(settingKey: string): BindingValue | undefined {
    const globalSettings = getGlobalSettings();
    const rawValue = globalSettings[settingKey];
    const binding = parseBinding(rawValue);

    if (binding && cannotSendByScanCode(binding)) {
      this.logger.warn(`Keyboard binding for ${settingKey} has no scan code to send; re-record it`);
      this.logger.debug(`Raw value: ${JSON.stringify(rawValue)}`);

      return undefined;
    }

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

  /**
   * Run one SimHub request, or a tap's start-and-stop pair, for a role once
   * every earlier one for that role has settled (#1693). A tap is two HTTP
   * requests, each with a 2 s timeout, and Control Mapper merges a second start
   * that lands before the first stop into the first press: a held key's first
   * repeat, a second key bound to the same role, or a quick second press of a
   * stalled SimHub would otherwise be lost. With nothing queued for the role,
   * `request` starts at once, synchronously.
   */
  private inRoleOrder<T>(role: string, request: () => Promise<T>): Promise<T> {
    const previous = this.simHubRoleQueues.get(role);
    // An async wrapper, so a request that throws synchronously still settles
    // the queue's tail rather than escaping before the tail is set.
    const run = async (): Promise<T> => request();
    const result = previous ? previous.then(run) : run();
    const tail = result.then(
      () => undefined,
      () => undefined,
    );

    this.simHubRoleQueues.set(role, tail);
    void tail.then(() => {
      if (this.simHubRoleQueues.get(role) === tail) this.simHubRoleQueues.delete(role);
    });

    return result;
  }

  // SimHub tap = activate then immediately deactivate (momentary press).
  // SimHub Control Mapper handles the duration internally. The pair is one unit
  // of its role's request queue, so no other start or stop of the role lands
  // between them (#1693).
  // Returns true once the role has started: the press went out even when the
  // stop then fails (that failure is logged, and the role may stay active).
  private async tapSimHub(role: string): Promise<boolean> {
    this.logger.info("Triggering SimHub role");
    this.logger.debug(`SimHub role: ${role}`);

    if (!isSimHubInitialized()) {
      this.logger.warn("SimHub service not initialized");

      return false;
    }

    return this.inRoleOrder(role, () => this.startAndStopRole(role));
  }

  private async startAndStopRole(role: string): Promise<boolean> {
    const simHub = getSimHub();
    const started = await simHub.startRole(role);

    if (!started) {
      this.logger.warn("Failed to start SimHub role");

      return false;
    }

    const stopped = await simHub.stopRole(role);

    if (!stopped) {
      this.logger.warn("SimHub role started but failed to stop — role may remain active");
    }

    return true;
  }

  private async tapKeyboard(binding: KeyBindingValue): Promise<boolean> {
    const combination = this.toKeyCombination(binding);

    const success = await getKeyboard().sendKeyCombination(combination);

    if (success) {
      this.logger.info("Key sent successfully");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to send key");
      this.logger.debug(`Failed key combination: ${formatKeyBinding(binding)}`);
    }

    return success;
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
