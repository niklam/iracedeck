/**
 * @iracedeck/iracing-native
 *
 * Native Node.js addon for iRacing SDK integration.
 * Uses the official iRacing SDK for telemetry access and broadcast messaging.
 */
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the native addon
const addon = require(join(__dirname, "..", "build", "Release", "iracing_native.node"));

// ============================================================================
// Types
// ============================================================================

/**
 * iRacing SDK header structure
 */
export interface IRSDKHeader {
  ver: number;
  status: number;
  tickRate: number;
  sessionInfoUpdate: number;
  sessionInfoLen: number;
  sessionInfoOffset: number;
  numVars: number;
  varHeaderOffset: number;
  numBuf: number;
  bufLen: number;
}

/**
 * Variable header structure
 */
export interface VarHeader {
  type: number;
  offset: number;
  count: number;
  countAsTime: boolean;
  name: string;
  desc: string;
  unit: string;
}

/**
 * Broadcast message types (matches irsdk_BroadcastMsg enum)
 */
export enum BroadcastMsg {
  CamSwitchPos = 0,
  CamSwitchNum = 1,
  CamSetState = 2,
  ReplaySetPlaySpeed = 3,
  ReplaySetPlayPosition = 4,
  ReplaySearch = 5,
  ReplaySetState = 6,
  ReloadTextures = 7,
  ChatCommand = 8,
  PitCommand = 9,
  TelemCommand = 10,
  FFBCommand = 11,
  ReplaySearchSessionTime = 12,
  VideoCapture = 13,
}

/**
 * Chat command modes
 */
export enum ChatCommandMode {
  Macro = 0,
  BeginChat = 1,
  Reply = 2,
  Cancel = 3,
}

// ============================================================================
// SDK Connection Functions
// ============================================================================

/**
 * Initialize connection to iRacing
 * @returns true if connected
 */
export function startup(): boolean {
  return addon.startup();
}

/**
 * Close connection to iRacing
 */
export function shutdown(): void {
  addon.shutdown();
}

/**
 * Check if connected to iRacing
 * @returns true if connected
 */
export function isConnected(): boolean {
  return addon.isConnected();
}

// ============================================================================
// Data Access Functions
// ============================================================================

/**
 * Get the iRacing SDK header
 * @returns Header object or null if not connected
 */
export function getHeader(): IRSDKHeader | null {
  return addon.getHeader();
}

/**
 * Get telemetry data from a specific buffer
 * @param index - Buffer index (0-3)
 * @returns Buffer with telemetry data or null
 */
export function getData(index: number): Buffer | null {
  return addon.getData(index);
}

/**
 * Wait for new data to be available
 * @param timeoutMs - Timeout in milliseconds (default 16 for ~60fps)
 * @returns Buffer with new data or null if timeout
 */
export function waitForData(timeoutMs?: number): Buffer | null {
  return addon.waitForData(timeoutMs);
}

/**
 * Get session info YAML string
 * @returns Session info string or null
 */
export function getSessionInfoStr(): string | null {
  return addon.getSessionInfoStr();
}

/**
 * Get variable header by index
 * @param index - Variable index
 * @returns Variable header object or null
 */
export function getVarHeaderEntry(index: number): VarHeader | null {
  return addon.getVarHeaderEntry(index);
}

/**
 * Get variable index by name
 * @param name - Variable name
 * @returns Index or -1 if not found
 */
export function varNameToIndex(name: string): number {
  return addon.varNameToIndex(name);
}

// ============================================================================
// Broadcast Message Functions
// ============================================================================

/**
 * Send a broadcast message to iRacing
 * @param msg - Broadcast message type
 * @param var1 - First parameter
 * @param var2 - Second parameter (optional)
 * @param var3 - Third parameter (optional)
 */
export function broadcastMsg(msg: BroadcastMsg | number, var1: number, var2?: number, var3?: number): void {
  addon.broadcastMsg(msg, var1, var2 ?? 0, var3 ?? 0);
}

// ============================================================================
// Chat Functions
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
export function sendChatMessage(message: string): boolean {
  return addon.sendChatMessage(message);
}

// ============================================================================
// Constants
// ============================================================================

/** iRacing SDK status flags */
export const StatusFlags = {
  Connected: 1,
} as const;

/** Variable types (matches irsdk_VarType enum) */
export enum VarType {
  Char = 0,
  Bool = 1,
  Int = 2,
  BitField = 3,
  Float = 4,
  Double = 5,
}
