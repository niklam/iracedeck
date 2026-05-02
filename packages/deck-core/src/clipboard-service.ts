/**
 * Clipboard Service Singleton
 *
 * Provides a lazy-initialized singleton for writing text to the OS clipboard.
 * The platform write is supplied at init time by the plugin entry point
 * (typically `(text) => native.setClipboardText(text)` from
 * `@iracedeck/iracing-native`), keeping deck-core platform-agnostic.
 *
 * Usage:
 * 1. Call initializeClipboard() once at plugin startup
 * 2. Use getClipboard() in your actions to write text to the clipboard
 *
 * @example
 * // In plugin.ts (entry point)
 * import { initializeClipboard } from "@iracedeck/deck-core";
 * import { IRacingNative } from "@iracedeck/iracing-native";
 *
 * const native = new IRacingNative();
 * initializeClipboard(logger, (text) => native.setClipboardText(text));
 *
 * // In action files
 * import { getClipboard } from "@iracedeck/deck-core";
 *
 * if (getClipboard().setClipboardText("!clear ")) {
 *   // ...send Ctrl+V via getKeyboard() to paste
 * }
 */
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";

/**
 * Function type for writing text to the OS clipboard.
 * Returns true on success, false on failure.
 */
export type ClipboardWriter = (text: string) => boolean;

/**
 * Interface for the clipboard service.
 */
export interface IClipboardService {
  /**
   * Write text to the OS clipboard.
   * @param text - The text to place on the clipboard
   * @returns true if successful, false otherwise
   */
  setClipboardText(text: string): boolean;
}

class ClipboardService implements IClipboardService {
  private readonly logger: ILogger;
  private readonly writer: ClipboardWriter | null;

  constructor(logger: ILogger, writer: ClipboardWriter | null) {
    this.logger = logger;
    this.writer = writer;
  }

  setClipboardText(text: string): boolean {
    if (!this.writer) {
      this.logger.warn("Clipboard service has no writer configured");

      return false;
    }

    try {
      const ok = this.writer(text);

      if (!ok) {
        this.logger.warn(`Clipboard writer returned false for ${text.length}-char payload`);
      } else {
        this.logger.debug(`Clipboard write succeeded (${text.length} chars)`);
      }

      return ok;
    } catch (error) {
      this.logger.error(`Clipboard write threw: ${error instanceof Error ? error.message : error}`);

      return false;
    }
  }
}

let clipboardService: ClipboardService | null = null;

/**
 * Initialize the clipboard service singleton.
 * Should be called once at plugin startup.
 *
 * @param logger - Optional logger for clipboard service logging
 * @param writer - Optional function for writing text to the clipboard.
 *   When omitted, every `setClipboardText` call returns false and logs a warning.
 * @returns The initialized clipboard service
 * @throws Error if called more than once
 */
export function initializeClipboard(logger: ILogger = silentLogger, writer?: ClipboardWriter): IClipboardService {
  if (clipboardService) {
    throw new Error("Clipboard service already initialized. initializeClipboard() should only be called once.");
  }

  clipboardService = new ClipboardService(logger, writer ?? null);

  return clipboardService;
}

/**
 * Get the clipboard service for writing to the OS clipboard.
 *
 * @returns The clipboard service instance
 * @throws Error if clipboard service hasn't been initialized
 */
export function getClipboard(): IClipboardService {
  if (!clipboardService) {
    throw new Error("Clipboard service not initialized. Call initializeClipboard() first in your plugin entry point.");
  }

  return clipboardService;
}

/**
 * Check if the clipboard service has been initialized.
 */
export function isClipboardInitialized(): boolean {
  return clipboardService !== null;
}

/**
 * Reset the clipboard service singleton (for testing purposes only).
 * @internal
 */
export function _resetClipboard(): void {
  clipboardService = null;
}
