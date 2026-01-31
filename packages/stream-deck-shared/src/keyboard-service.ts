/**
 * Keyboard Service Singleton
 *
 * Provides a lazy-initialized singleton for sending keyboard inputs.
 * Supports two sending strategies:
 * 1. Scan code path (preferred): Uses SendInput(KEYEVENTF_SCANCODE) via iracing-native
 *    for layout-independent physical key sending. Activated when a scan code sender
 *    is provided and the key binding includes an event.code value.
 * 2. keysender fallback: Uses keysender's Hardware class for string-based key sending.
 *    Used for old bindings without event.code.
 *
 * Usage:
 * 1. Call initializeKeyboard() once at plugin startup
 * 2. Use getKeyboard() in your actions to send key combinations
 *
 * @example
 * // In plugin.ts (entry point)
 * import { initializeKeyboard } from "@iracedeck/stream-deck-shared";
 * import { IRacingNative } from "@iracedeck/iracing-native";
 *
 * const native = new IRacingNative();
 * initializeKeyboard(logger, (scanCodes) => native.sendScanKeys(scanCodes));
 *
 * // In action files
 * import { getKeyboard } from "@iracedeck/stream-deck-shared";
 *
 * const keyboard = getKeyboard();
 * await keyboard.sendKeyCombination({ key: "f3", code: "F3" });
 * await keyboard.sendKeyCombination({ key: "r", code: "KeyR", modifiers: ["shift"] });
 */
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";
// Import keysender types for proper typing
import type { Keyboard, KeyboardButton } from "keysender";

import type { KeyboardKey, KeyboardModifier, KeyCombination } from "./keyboard-types.js";
import { getModifierScanCode, getScanCode } from "./scan-code-map.js";

/**
 * Function type for sending scan codes via native SendInput.
 * Takes an array of PS/2 scan codes (modifiers first, then main key).
 * The implementation presses each in order, then releases in reverse.
 */
export type ScanKeySender = (scanCodes: number[]) => void;

/**
 * Interface for the keyboard service.
 */
export interface IKeyboardService {
  /**
   * Send a single key press.
   * @param key - The key to press
   * @returns true if successful, false if an error occurred
   */
  sendKey(key: KeyboardKey): Promise<boolean>;

  /**
   * Send a key combination (key with optional modifiers).
   * @param combination - The key combination to send
   * @returns true if successful, false if an error occurred
   */
  sendKeyCombination(combination: KeyCombination): Promise<boolean>;
}

/**
 * Map from our KeyboardKey type to keysender's KeyboardButton.
 * Most keys are the same, but some need mapping.
 */
const KEY_MAP: Partial<Record<KeyboardKey, KeyboardButton>> = {
  // Special keys that need mapping (keysender uses camelCase)
  pageup: "pageUp",
  pagedown: "pageDown",
};

/**
 * Convert our KeyboardKey to keysender's KeyboardButton.
 */
function toKeysenderKey(key: KeyboardKey): KeyboardButton {
  return KEY_MAP[key] ?? (key as KeyboardButton);
}

/**
 * Convert our KeyboardModifier to keysender's KeyboardButton.
 */
function toKeysenderModifier(modifier: KeyboardModifier): KeyboardButton {
  // keysender uses the same names: ctrl, shift, alt
  return modifier as KeyboardButton;
}

/**
 * Interface for the Hardware instance from keysender.
 */
interface KeysenderHardware {
  keyboard: Keyboard;
}

/**
 * Keyboard service implementation.
 * Uses scan code sending when available, falls back to keysender.
 */
class KeyboardService implements IKeyboardService {
  private hardware: KeysenderHardware | null = null;
  private logger: ILogger;
  private initPromise: Promise<void> | null = null;
  private scanKeySender: ScanKeySender | null;

  constructor(logger: ILogger, scanKeySender: ScanKeySender | null) {
    this.logger = logger;
    this.scanKeySender = scanKeySender;
  }

  /**
   * Lazily initialize keysender Hardware instance.
   * This avoids loading the native module until actually needed.
   */
  private async ensureInitialized(): Promise<KeysenderHardware> {
    if (this.hardware) {
      return this.hardware;
    }

    if (this.initPromise) {
      await this.initPromise;

      return this.hardware!;
    }

    this.initPromise = (async () => {
      try {
        // Dynamic import to avoid loading during test environment
        const keysender = await import("keysender");
        // Create Hardware instance without arguments for desktop-wide targeting
        this.hardware = new keysender.Hardware() as KeysenderHardware;
        this.logger.debug("Keysender Hardware initialized");
      } catch (error) {
        this.logger.error(`Failed to initialize keysender: ${error}`);
        throw error;
      }
    })();

    await this.initPromise;

    return this.hardware!;
  }

  async sendKey(key: KeyboardKey): Promise<boolean> {
    try {
      const hw = await this.ensureInitialized();
      const mappedKey = toKeysenderKey(key);
      this.logger.debug(`Sending key: ${mappedKey}`);
      await hw.keyboard.sendKey(mappedKey);

      return true;
    } catch (error) {
      this.logger.error(`Failed to send key: ${key}: ${error}`);

      return false;
    }
  }

  async sendKeyCombination(combination: KeyCombination): Promise<boolean> {
    // Try scan code path first (layout-independent, preferred)
    if (combination.code && this.scanKeySender) {
      return this.sendViaScanCodes(combination);
    }

    // Fall back to keysender (for old bindings without event.code)
    return this.sendViaKeysender(combination);
  }

  /**
   * Send a key combination using PS/2 scan codes via native SendInput.
   * Layout-independent: the same scan code always sends the same physical key.
   */
  private sendViaScanCodes(combination: KeyCombination): boolean {
    try {
      const scanCodes: number[] = [];

      // Add modifier scan codes
      if (combination.modifiers) {
        for (const modifier of combination.modifiers) {
          const sc = getModifierScanCode(modifier);

          if (sc === undefined) {
            this.logger.warn(`Unknown modifier "${modifier}", falling back to keysender`);

            return false;
          }

          scanCodes.push(sc);
        }
      }

      // Add main key scan code
      const mainSc = getScanCode(combination.code!);

      if (mainSc === undefined) {
        this.logger.debug(`No scan code for event.code="${combination.code}", falling back to keysender`);

        // Fall back to keysender for unmapped codes
        // (this is async but we return sync - call it directly)
        void this.sendViaKeysender(combination);

        return true;
      }

      scanCodes.push(mainSc);

      this.logger.debug(
        `Sending scan codes: [${scanCodes.map((sc) => `0x${sc.toString(16)}`).join(", ")}] (code="${combination.code}", key="${combination.key}")`,
      );

      this.scanKeySender!(scanCodes);

      return true;
    } catch (error) {
      this.logger.error(`Failed to send scan codes: ${JSON.stringify(combination)}: ${error}`);

      return false;
    }
  }

  /**
   * Send a key combination via keysender (fallback for old bindings).
   */
  private async sendViaKeysender(combination: KeyCombination): Promise<boolean> {
    try {
      const hw = await this.ensureInitialized();
      const keys: KeyboardButton[] = [];

      // Add modifiers first
      if (combination.modifiers) {
        for (const modifier of combination.modifiers) {
          keys.push(toKeysenderModifier(modifier));
        }
      }

      // Add the main key
      const mainKey = toKeysenderKey(combination.key);
      keys.push(mainKey);

      this.logger.debug(`Sending via keysender: ${keys.join("+")} (key="${combination.key}", no event.code available)`);

      if (keys.length === 1) {
        await hw.keyboard.sendKey(keys[0]);
      } else {
        await hw.keyboard.sendKey(keys);
      }

      return true;
    } catch (error) {
      this.logger.error(`Failed to send key combination: ${JSON.stringify(combination)}: ${error}`);

      return false;
    }
  }
}

// Singleton instance
let keyboardService: KeyboardService | null = null;

/**
 * Initialize the keyboard service singleton.
 * Should be called once at plugin startup.
 *
 * @param logger - Optional logger instance for keyboard service logging
 * @param scanKeySender - Optional function for sending PS/2 scan codes via native SendInput.
 *   When provided, key combinations with event.code will use this path for layout-independent sending.
 *   When omitted, all keys are sent via keysender (may have issues on non-US layouts).
 * @returns The initialized keyboard service
 * @throws Error if called more than once
 */
export function initializeKeyboard(logger: ILogger = silentLogger, scanKeySender?: ScanKeySender): IKeyboardService {
  if (keyboardService) {
    throw new Error("Keyboard service already initialized. initializeKeyboard() should only be called once.");
  }

  keyboardService = new KeyboardService(logger, scanKeySender ?? null);

  return keyboardService;
}

/**
 * Get the keyboard service for sending key combinations.
 *
 * @returns The keyboard service instance
 * @throws Error if keyboard service hasn't been initialized
 */
export function getKeyboard(): IKeyboardService {
  if (!keyboardService) {
    throw new Error("Keyboard service not initialized. Call initializeKeyboard() first in your plugin entry point.");
  }

  return keyboardService;
}

/**
 * Check if the keyboard service has been initialized.
 *
 * @returns true if keyboard service is initialized, false otherwise
 */
export function isKeyboardInitialized(): boolean {
  return keyboardService !== null;
}

/**
 * Reset the keyboard service singleton (for testing purposes only).
 * @internal
 */
export function _resetKeyboard(): void {
  keyboardService = null;
}
