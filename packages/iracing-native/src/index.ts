/**
 * @iracedeck/iracing-native
 *
 * Native Node.js addon for iRacing SDK integration.
 * Uses the official iRacing SDK for telemetry access and broadcast messaging.
 */
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import type { BroadcastMsg, IRSDKHeader, VarHeader } from "./defines.js";

// Re-export all types and enums from defines
export * from "./defines.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the native addon
const addon = require(join(__dirname, "..", "build", "Release", "iracing_native.node"));

/**
 * iRacing Native SDK
 *
 * Provides direct access to the iRacing SDK via native addon.
 * This is the low-level interface - for most use cases, use @iracedeck/iracing-sdk instead.
 */
export class IRacingNative {
  // ============================================================================
  // SDK Connection
  // ============================================================================

  /**
   * Initialize connection to iRacing
   * @returns true if connected
   */
  startup(): boolean {
    return addon.startup();
  }

  /**
   * Close connection to iRacing
   */
  shutdown(): void {
    addon.shutdown();
  }

  /**
   * Check if connected to iRacing
   * @returns true if connected
   */
  isConnected(): boolean {
    return addon.isConnected();
  }

  // ============================================================================
  // Data Access
  // ============================================================================

  /**
   * Get the iRacing SDK header
   * @returns Header object or null if not connected
   */
  getHeader(): IRSDKHeader | null {
    return addon.getHeader();
  }

  /**
   * Get telemetry data from a specific buffer
   * @param index - Buffer index (0-3)
   * @returns Buffer with telemetry data or null
   */
  getData(index: number): Buffer | null {
    return addon.getData(index);
  }

  /**
   * Wait for new data to be available
   * @param timeoutMs - Timeout in milliseconds (default 16 for ~60fps)
   * @returns Buffer with new data or null if timeout
   */
  waitForData(timeoutMs?: number): Buffer | null {
    return addon.waitForData(timeoutMs);
  }

  /**
   * Get session info YAML string
   * @returns Session info string or null
   */
  getSessionInfoStr(): string | null {
    return addon.getSessionInfoStr();
  }

  /**
   * Get variable header by index
   * @param index - Variable index
   * @returns Variable header object or null
   */
  getVarHeaderEntry(index: number): VarHeader | null {
    return addon.getVarHeaderEntry(index);
  }

  /**
   * Get variable index by name
   * @param name - Variable name
   * @returns Index or -1 if not found
   */
  varNameToIndex(name: string): number {
    return addon.varNameToIndex(name);
  }

  // ============================================================================
  // Broadcast Messages
  // ============================================================================

  /**
   * Send a broadcast message to iRacing
   * @param msg - Broadcast message type
   * @param var1 - First parameter
   * @param var2 - Second parameter (optional)
   * @param var3 - Third parameter (optional)
   */
  broadcastMsg(msg: BroadcastMsg | number, var1: number, var2?: number, var3?: number): void {
    addon.broadcastMsg(msg, var1, var2 ?? 0, var3 ?? 0);
  }

  // ============================================================================
  // Chat
  // ============================================================================

  /**
   * Send a complete chat message to iRacing
   * This function handles the entire chat flow:
   * 1. Opens chat window via broadcast message
   * 2. Waits for chat window to open
   * 3. Types the message using WM_CHAR
   * 4. Presses Enter to send
   * 5. Closes the chat window
   *
   * @param message - The message to send
   * @returns Success boolean
   */
  sendChatMessage(message: string): boolean {
    return addon.sendChatMessage(message);
  }

  // ============================================================================
  // Keyboard Input
  // ============================================================================

  /**
   * Send a key combination using PS/2 scan codes.
   * Presses each scan code in order (modifiers first, then main key),
   * then releases all in reverse order.
   *
   * Uses SendInput with KEYEVENTF_SCANCODE for layout-independent key sending.
   * Extended keys (arrows, delete, etc.) use bit 0x100 to signal KEYEVENTF_EXTENDEDKEY.
   *
   * @param scanCodes - Array of PS/2 scan codes
   */
  sendScanKeys(scanCodes: number[]): void {
    addon.sendScanKeys(scanCodes);
  }

  /**
   * Press scan codes without releasing (for key hold/long-press).
   * Presses each scan code in order (modifiers first, then main key).
   * Caller must call {@link sendScanKeyUp} to release the keys.
   *
   * @param scanCodes - Array of PS/2 scan codes
   */
  sendScanKeyDown(scanCodes: number[]): void {
    addon.sendScanKeyDown(scanCodes);
  }

  /**
   * Release scan codes without pressing (for key hold/long-press).
   * Releases each scan code in reverse order (main key first, then modifiers).
   * Should be called after {@link sendScanKeyDown} to release held keys.
   *
   * @param scanCodes - Array of PS/2 scan codes
   */
  sendScanKeyUp(scanCodes: number[]): void {
    addon.sendScanKeyUp(scanCodes);
  }
}
