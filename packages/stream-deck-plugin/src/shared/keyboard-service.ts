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
 * import { initializeKeyboard } from "./shared/index.js";
 * import { IRacingNative } from "@iracedeck/iracing-native";
 *
 * const native = new IRacingNative();
 * initializeKeyboard(logger, (scanCodes) => native.sendScanKeys(scanCodes));
 *
 * // In action files
 * import { getKeyboard } from "./shared/index.js";
 *
 * const keyboard = getKeyboard();
 * await keyboard.sendKeyCombination({ key: "f3", code: "F3" });
 * await keyboard.sendKeyCombination({ key: "r", code: "KeyR", modifiers: ["shift"] });
 */
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";
// Import keysender types for proper typing
import type { Keyboard, KeyboardButton } from "keysender";

import { getGlobalSettings, isGlobalSettingsInitialized } from "./global-settings.js";
import type { KeyboardKey, KeyboardModifier, KeyCombination } from "./keyboard-types.js";
import { getModifierScanCode, getScanCode } from "./scan-code-map.js";

/**
 * Function type for sending scan codes via native SendInput (tap: press + release).
 * Takes an array of PS/2 scan codes (modifiers first, then main key).
 * The implementation presses each in order, then releases in reverse.
 */
export type ScanKeySender = (scanCodes: number[]) => void;

/**
 * Function type for pressing scan codes without releasing (key hold).
 * Takes an array of PS/2 scan codes (modifiers first, then main key).
 * Caller must call the corresponding releaser to release keys.
 */
export type ScanKeyPresser = (scanCodes: number[]) => void;

/**
 * Function type for releasing scan codes without pressing (key release).
 * Takes an array of PS/2 scan codes (modifiers first, then main key).
 * Releases in reverse order. Should follow a prior press call.
 */
export type ScanKeyReleaser = (scanCodes: number[]) => void;

/**
 * Function type for focusing the iRacing window before sending keys.
 * Returns true if the window was found and focused (or already focused).
 */
export type WindowFocuser = () => boolean;

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
   * Send a key combination (key with optional modifiers). Tap behavior: press then release.
   * @param combination - The key combination to send
   * @returns true if successful, false if an error occurred
   */
  sendKeyCombination(combination: KeyCombination): Promise<boolean>;

  /**
   * Press a key combination and hold it down (no release).
   * Caller must call {@link releaseKeyCombination} to release the keys.
   * @param combination - The key combination to press
   * @returns true if successful, false if an error occurred
   */
  pressKeyCombination(combination: KeyCombination): Promise<boolean>;

  /**
   * Release a previously held key combination.
   * Should be called after {@link pressKeyCombination} to release held keys.
   * @param combination - The key combination to release
   * @returns true if successful, false if an error occurred
   */
  releaseKeyCombination(combination: KeyCombination): Promise<boolean>;
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
  private scanKeyPresser: ScanKeyPresser | null;
  private scanKeyReleaser: ScanKeyReleaser | null;
  private windowFocuser: WindowFocuser | null;

  constructor(
    logger: ILogger,
    scanKeySender: ScanKeySender | null,
    scanKeyPresser: ScanKeyPresser | null,
    scanKeyReleaser: ScanKeyReleaser | null,
    windowFocuser: WindowFocuser | null,
  ) {
    this.logger = logger;
    this.scanKeySender = scanKeySender;
    this.scanKeyPresser = scanKeyPresser;
    this.scanKeyReleaser = scanKeyReleaser;
    this.windowFocuser = windowFocuser;
  }

  /**
   * Focus the iRacing window if the global setting is enabled and a focuser is configured.
   * Best-effort: logs a warning on failure but does not block key sending.
   */
  private focusIfEnabled(): void {
    if (!this.windowFocuser) return;

    if (!isGlobalSettingsInitialized()) return;

    const settings = getGlobalSettings();

    if (!settings.focusIRacingWindow) return;

    const success = this.windowFocuser();

    if (!success) {
      this.logger.warn("Failed to focus iRacing window (window not found)");
    } else {
      this.logger.debug("Focused iRacing window before sending key");
    }
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
    this.focusIfEnabled();

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
    this.focusIfEnabled();

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
      const scanCodes = this.buildScanCodes(combination);

      if (!scanCodes) {
        void this.sendViaKeysender(combination);

        return true;
      }

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

  async pressKeyCombination(combination: KeyCombination): Promise<boolean> {
    this.focusIfEnabled();

    // Try scan code path first (layout-independent, preferred)
    if (combination.code && this.scanKeyPresser) {
      return this.pressViaScanCodes(combination);
    }

    // Fall back to keysender toggleKey
    return this.toggleViaKeysender(combination, true);
  }

  async releaseKeyCombination(combination: KeyCombination): Promise<boolean> {
    // Try scan code path first (layout-independent, preferred)
    if (combination.code && this.scanKeyReleaser) {
      return this.releaseViaScanCodes(combination);
    }

    // Fall back to keysender toggleKey
    return this.toggleViaKeysender(combination, false);
  }

  /**
   * Press scan codes without releasing (for key hold).
   */
  private pressViaScanCodes(combination: KeyCombination): boolean {
    try {
      const scanCodes = this.buildScanCodes(combination);

      if (!scanCodes) {
        void this.toggleViaKeysender(combination, true);

        return true;
      }

      this.logger.debug(
        `Pressing scan codes: [${scanCodes.map((sc) => `0x${sc.toString(16)}`).join(", ")}] (code="${combination.code}", key="${combination.key}")`,
      );

      this.scanKeyPresser!(scanCodes);

      return true;
    } catch (error) {
      this.logger.error(`Failed to press scan codes: ${JSON.stringify(combination)}: ${error}`);

      return false;
    }
  }

  /**
   * Release scan codes without pressing (for key release).
   */
  private releaseViaScanCodes(combination: KeyCombination): boolean {
    try {
      const scanCodes = this.buildScanCodes(combination);

      if (!scanCodes) {
        void this.toggleViaKeysender(combination, false);

        return true;
      }

      this.logger.debug(
        `Releasing scan codes: [${scanCodes.map((sc) => `0x${sc.toString(16)}`).join(", ")}] (code="${combination.code}", key="${combination.key}")`,
      );

      this.scanKeyReleaser!(scanCodes);

      return true;
    } catch (error) {
      this.logger.error(`Failed to release scan codes: ${JSON.stringify(combination)}: ${error}`);

      return false;
    }
  }

  /**
   * Build scan code array from a key combination.
   * Returns null if any key cannot be mapped (caller should fall back to keysender).
   */
  private buildScanCodes(combination: KeyCombination): number[] | null {
    const scanCodes: number[] = [];

    if (combination.modifiers) {
      for (const modifier of combination.modifiers) {
        const sc = getModifierScanCode(modifier);

        if (sc === undefined) {
          this.logger.warn(`Unknown modifier "${modifier}", falling back to keysender`);

          return null;
        }

        scanCodes.push(sc);
      }
    }

    const mainSc = getScanCode(combination.code!);

    if (mainSc === undefined) {
      this.logger.debug(`No scan code for event.code="${combination.code}", falling back to keysender`);

      return null;
    }

    scanCodes.push(mainSc);

    return scanCodes;
  }

  /**
   * Toggle key state via keysender (fallback for press/release without scan codes).
   * @param combination - The key combination
   * @param state - true to press, false to release
   */
  private async toggleViaKeysender(combination: KeyCombination, state: boolean): Promise<boolean> {
    try {
      const hw = await this.ensureInitialized();
      const keys: KeyboardButton[] = [];

      if (combination.modifiers) {
        for (const modifier of combination.modifiers) {
          keys.push(toKeysenderModifier(modifier));
        }
      }

      const mainKey = toKeysenderKey(combination.key);
      keys.push(mainKey);

      const action = state ? "Pressing" : "Releasing";
      this.logger.debug(`${action} via keysender toggleKey: ${keys.join("+")} (key="${combination.key}")`);

      if (keys.length === 1) {
        await hw.keyboard.toggleKey(keys[0], state);
      } else {
        await hw.keyboard.toggleKey(keys, state);
      }

      return true;
    } catch (error) {
      const action = state ? "press" : "release";
      this.logger.error(`Failed to ${action} key combination: ${JSON.stringify(combination)}: ${error}`);

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
 * @param scanKeySender - Optional function for tap-sending PS/2 scan codes (press + release).
 * @param scanKeyPresser - Optional function for pressing PS/2 scan codes without releasing (for key hold).
 * @param scanKeyReleaser - Optional function for releasing PS/2 scan codes without pressing (for key release).
 *   When scan code functions are provided, key combinations with event.code will use them for layout-independent sending.
 *   When omitted, all keys are sent via keysender (may have issues on non-US layouts).
 * @param windowFocuser - Optional function for focusing the iRacing window before sending keys.
 *   When provided and the `focusIRacingWindow` global setting is enabled, the focuser is called
 *   before each key send operation (except release).
 * @returns The initialized keyboard service
 * @throws Error if called more than once
 */
export function initializeKeyboard(
  logger: ILogger = silentLogger,
  scanKeySender?: ScanKeySender,
  scanKeyPresser?: ScanKeyPresser,
  scanKeyReleaser?: ScanKeyReleaser,
  windowFocuser?: WindowFocuser,
): IKeyboardService {
  if (keyboardService) {
    throw new Error("Keyboard service already initialized. initializeKeyboard() should only be called once.");
  }

  keyboardService = new KeyboardService(
    logger,
    scanKeySender ?? null,
    scanKeyPresser ?? null,
    scanKeyReleaser ?? null,
    windowFocuser ?? null,
  );

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
