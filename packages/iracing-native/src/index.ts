/**
 * @iracedeck/iracing-native
 *
 * Native Node.js addon for iRacing SDK integration.
 * Uses the official iRacing SDK for telemetry access and broadcast messaging.
 *
 * On non-Windows platforms, a mock implementation is used automatically
 * to enable development and testing on macOS/Linux.
 */
import { existsSync } from "fs";
import { createRequire } from "module";
import { platform } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import type { BroadcastMsg, ElevationStatus, IRSDKHeader, VarHeader } from "./defines.js";
import { IRacingNativeMock } from "./mock-impl.js";

// Re-export all types and enums from defines
export * from "./defines.js";
export { IRacingNativeMock } from "./mock-impl.js";

/**
 * Result codes from focusIRacingWindow().
 */
export enum FocusResult {
  /** Window was already in the foreground */
  AlreadyFocused = 0,
  /** Window was found and successfully focused */
  Focused = 1,
  /** No window with the expected title exists */
  WindowNotFound = 2,
  /** Window was found but focus did not transfer within timeout */
  FocusTimedOut = 3,
}

/**
 * Result codes from moveMouseToIRacingWindow().
 */
export enum PointerMoveResult {
  /** The cursor was placed inside the sim's client area */
  Moved = 0,
  /** No window with the expected title exists */
  WindowNotFound = 1,
  /** The window was found but the move failed (including a minimized window) */
  Failed = 2,
}

// Try to load native addon (only on Windows, with safety catch).
// Force mock mode by creating a `.mock` file in the sdPlugin folder,
// or by setting IRACEDECK_MOCK=1 in the environment.
let addon: any = null;
const forceMock = !!process.env.IRACEDECK_MOCK || existsSync(join(process.cwd(), ".mock"));

if (platform() === "win32" && !forceMock) {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const require = createRequire(import.meta.url);
    addon = require(join(__dirname, "..", "build", "Release", "iracing_native.node"));
  } catch {
    /* Native addon not available — mock will be used */
  }
}

/**
 * iRacing Native SDK
 *
 * Provides direct access to the iRacing SDK via native addon.
 * On non-Windows platforms (or when the native addon is unavailable),
 * delegates to IRacingNativeMock for simulated data.
 *
 * This is the low-level interface - for most use cases, use @iracedeck/iracing-sdk instead.
 */
export class IRacingNative {
  private mock: IRacingNativeMock | null = null;

  private getMock(): IRacingNativeMock {
    if (!this.mock) this.mock = new IRacingNativeMock();

    return this.mock;
  }

  // ============================================================================
  // SDK Connection
  // ============================================================================

  /**
   * Initialize connection to iRacing
   * @returns true if connected
   */
  startup(): boolean {
    return addon ? addon.startup() : this.getMock().startup();
  }

  /**
   * Close connection to iRacing
   */
  shutdown(): void {
    if (addon) {
      addon.shutdown();
    } else {
      this.getMock().shutdown();
    }
  }

  /**
   * Check if connected to iRacing
   * @returns true if connected
   */
  isConnected(): boolean {
    return addon ? addon.isConnected() : this.getMock().isConnected();
  }

  // ============================================================================
  // Data Access
  // ============================================================================

  /**
   * Get the iRacing SDK header
   * @returns Header object or null if not connected
   */
  getHeader(): IRSDKHeader | null {
    return addon ? addon.getHeader() : this.getMock().getHeader();
  }

  /**
   * Get telemetry data from a specific buffer
   * @param index - Buffer index (0-3)
   * @returns Buffer with telemetry data or null
   */
  getData(index: number): Buffer | null {
    return addon ? addon.getData(index) : this.getMock().getData(index);
  }

  /**
   * Wait for new data to be available
   * @param timeoutMs - Timeout in milliseconds (default 16 for ~60fps)
   * @returns Buffer with new data or null if timeout
   */
  waitForData(timeoutMs?: number): Buffer | null {
    return addon ? addon.waitForData(timeoutMs) : this.getMock().waitForData(timeoutMs);
  }

  /**
   * Get session info YAML string
   * @returns Session info string or null
   */
  getSessionInfoStr(): string | null {
    return addon ? addon.getSessionInfoStr() : this.getMock().getSessionInfoStr();
  }

  /**
   * Get variable header by index
   * @param index - Variable index
   * @returns Variable header object or null
   */
  getVarHeaderEntry(index: number): VarHeader | null {
    return addon ? addon.getVarHeaderEntry(index) : this.getMock().getVarHeaderEntry(index);
  }

  /**
   * Get variable index by name
   * @param name - Variable name
   * @returns Index or -1 if not found
   */
  varNameToIndex(name: string): number {
    return addon ? addon.varNameToIndex(name) : this.getMock().varNameToIndex(name);
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
    if (addon) {
      addon.broadcastMsg(msg, var1, var2 ?? 0, var3 ?? 0);
    } else {
      this.getMock().broadcastMsg(msg, var1, var2, var3);
    }
  }

  // ============================================================================
  // Chat
  // ============================================================================

  /**
   * Send a complete chat message to iRacing.
   *
   * The native addon runs the entire chat-send pipeline on a libuv worker
   * thread and returns a Promise, so the JS event loop remains responsive
   * during the ~400ms native work. Concurrent sends are serialized natively.
   *
   * The open→paste, paste→enter, and enter→close waits are caller-supplied
   * (issues #581, #589); each defaults to 200 ms when omitted. The Enter
   * keypress is held a fixed 100 ms natively (not configurable).
   *
   * @param message - The message to send
   * @param openToPasteDelayMs - (optional) ms to wait after opening chat before pasting
   * @param pasteToEnterDelayMs - (optional) ms to wait after pasting before pressing Enter
   * @param enterToCloseDelayMs - (optional) ms to wait after pressing Enter before closing the chat box
   * @returns Promise resolving to true on success, false on failure
   */
  sendChatMessage(
    message: string,
    openToPasteDelayMs?: number,
    pasteToEnterDelayMs?: number,
    enterToCloseDelayMs?: number,
  ): Promise<boolean> {
    return addon
      ? addon.sendChatMessage(
          message,
          openToPasteDelayMs ?? 200,
          pasteToEnterDelayMs ?? 200,
          enterToCloseDelayMs ?? 200,
        )
      : this.getMock().sendChatMessage(message, openToPasteDelayMs, pasteToEnterDelayMs, enterToCloseDelayMs);
  }

  // ============================================================================
  // Window Management
  // ============================================================================

  /**
   * Attempt to bring the iRacing simulator window to the foreground.
   * Uses AttachThreadInput pattern for reliable window focusing on Windows.
   *
   * @returns FocusResult status code (0=already focused, 1=focused, 2=not found, 3=timed out)
   */
  focusIRacingWindow(): number {
    return addon ? addon.focusIRacingWindow() : this.getMock().focusIRacingWindow();
  }

  /**
   * Move the OS mouse pointer into the iRacing window's client area.
   *
   * The target is given as fractions of the client area (0..1, clamped natively),
   * so the placement policy stays in TypeScript rather than in the addon.
   *
   * @param xFraction - horizontal position, 0 = left edge, 1 = right edge
   * @param yFraction - vertical position, 0 = top edge, 1 = bottom edge
   * @returns PointerMoveResult status code (0=moved, 1=not found, 2=failed)
   */
  moveMouseToIRacingWindow(xFraction: number, yFraction: number): number {
    return addon
      ? addon.moveMouseToIRacingWindow(xFraction, yFraction)
      : this.getMock().moveMouseToIRacingWindow(xFraction, yFraction);
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
    if (addon) {
      addon.sendScanKeys(scanCodes);
    } else {
      this.getMock().sendScanKeys(scanCodes);
    }
  }

  /**
   * Press scan codes without releasing (for key hold/long-press).
   * Presses each scan code in order (modifiers first, then main key).
   * Caller must call {@link sendScanKeyUp} to release the keys.
   *
   * @param scanCodes - Array of PS/2 scan codes
   */
  sendScanKeyDown(scanCodes: number[]): void {
    if (addon) {
      addon.sendScanKeyDown(scanCodes);
    } else {
      this.getMock().sendScanKeyDown(scanCodes);
    }
  }

  /**
   * Release scan codes without pressing (for key hold/long-press).
   * Releases each scan code in reverse order (main key first, then modifiers).
   * Should be called after {@link sendScanKeyDown} to release held keys.
   *
   * @param scanCodes - Array of PS/2 scan codes
   */
  sendScanKeyUp(scanCodes: number[]): void {
    if (addon) {
      addon.sendScanKeyUp(scanCodes);
    } else {
      this.getMock().sendScanKeyUp(scanCodes);
    }
  }

  /**
   * Send a sequence of distinct key chords in one native call (issue #818).
   *
   * Chords fire in order; each is an array of PS/2 scan codes (modifiers first,
   * then main key). With `holdMs === 0` the whole sequence goes out as a single
   * atomic SendInput batch with no sleep, so the target consumes every event in
   * the same frame — no intermediate state is ever rendered.
   *
   * @param chords - Array of scan code arrays
   * @param holdMs - Per-chord hold in ms (default 0 = atomic batch, no sleep)
   */
  sendScanKeySequence(chords: number[][], holdMs = 0): void {
    if (addon) {
      addon.sendScanKeySequence(chords, holdMs);
    } else {
      this.getMock().sendScanKeySequence(chords, holdMs);
    }
  }

  // ============================================================================
  // Clipboard
  // ============================================================================

  /**
   * Write text to the OS clipboard as Unicode text.
   *
   * Used by paste-based action flows (e.g. race-admin's "Type in Chat" mode).
   * Pasting (Ctrl+V) is the caller's responsibility — use the keyboard service.
   *
   * @param text - The text to place on the clipboard
   * @returns true on success
   */
  setClipboardText(text: string): boolean {
    return addon ? addon.setClipboardText(text) : this.getMock().setClipboardText(text);
  }

  /**
   * Compare this process's elevation/integrity with iRacing's (issue #610).
   * Windows-only; returns a safe "no mismatch" result on other platforms and
   * when the native addon is unavailable.
   *
   * @returns Elevation status, including a `mismatch` flag.
   */
  getElevationStatus(): ElevationStatus {
    return addon ? addon.getElevationStatus() : this.getMock().getElevationStatus();
  }
}
