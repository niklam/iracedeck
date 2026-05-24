/**
 * Interfaces for dependency injection
 *
 * These interfaces allow for testability and follow the Dependency Inversion principle.
 */
import type { BroadcastMsg, IRSDKHeader, VarHeader } from "@iracedeck/iracing-native";

/**
 * Tunable delays for the Chat > Send Message pipeline (issues #581, #589).
 *
 * All are in milliseconds and optional — when omitted, the native layer
 * falls back to its built-in default (200 ms). The action layer reads the
 * `chatOpenToPasteDelayMs` / `chatPasteToEnterDelayMs` / `chatEnterToCloseDelayMs`
 * global settings and forwards them here; the SDK and native layers stay
 * decoupled from `deck-core`.
 */
export interface ChatSendTiming {
  /** Wait after opening the chat window (BeginChat) before pasting. */
  openToPasteDelayMs?: number;
  /** Wait after pasting before pressing Enter. */
  pasteToEnterDelayMs?: number;
  /** Wait after pressing Enter before closing the chat box (Cancel) (issue #589). */
  enterToCloseDelayMs?: number;
}

/**
 * Interface for the native iRacing SDK
 * Wraps the native addon functionality for dependency injection
 */
export interface INativeSDK {
  // Connection
  startup(): boolean;
  shutdown(): void;
  isConnected(): boolean;

  // Data access
  getHeader(): IRSDKHeader | null;
  getData(index: number): Buffer | null;
  waitForData(timeoutMs?: number): Buffer | null;
  getSessionInfoStr(): string | null;
  getVarHeaderEntry(index: number): VarHeader | null;
  varNameToIndex(name: string): number;

  // Broadcast
  broadcastMsg(msg: BroadcastMsg | number, var1: number, var2?: number, var3?: number): void;

  // Chat
  sendChatMessage(
    message: string,
    openToPasteDelayMs?: number,
    pasteToEnterDelayMs?: number,
    enterToCloseDelayMs?: number,
  ): Promise<boolean>;
}
