/**
 * @iracedeck/iracing-native
 *
 * Native Node.js addon for iRacing SDK integration.
 * Provides Win32 memory-mapped file access and window messaging.
 */
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the native addon
const addon = require(join(__dirname, "..", "build", "Release", "iracing_native.node"));

// Re-export with TypeScript types

/**
 * Open a memory-mapped file by name
 * @param name - Name of the memory-mapped file (e.g., "Local\\IRSDKMemMapFileName")
 * @returns Handle as number, or 0 on failure
 */
export function openMemoryMap(name: string): number {
  return addon.openMemoryMap(name);
}

/**
 * Close a memory-mapped file
 * @param handle - Handle returned from openMemoryMap
 */
export function closeMemoryMap(handle: number): void {
  addon.closeMemoryMap(handle);
}

/**
 * Read bytes from a memory-mapped file
 * @param handle - Handle returned from openMemoryMap
 * @param offset - Byte offset to start reading from
 * @param length - Number of bytes to read
 * @returns Buffer containing the bytes
 */
export function readMemory(handle: number, offset: number, length: number): Buffer {
  return addon.readMemory(handle, offset, length);
}

/**
 * Find a window by class name and/or window title
 * @param className - Window class name (or null)
 * @param windowName - Window title (or null)
 * @returns Window handle as number, or 0 if not found
 */
export function findWindow(className: string | null, windowName: string | null): number {
  return addon.findWindow(className, windowName);
}

/**
 * Register a window message by name
 * @param messageName - Name of the message to register
 * @returns Message ID
 */
export function registerWindowMessage(messageName: string): number {
  return addon.registerWindowMessage(messageName);
}

/**
 * Send a message to a window (blocking)
 * @param hwnd - Window handle
 * @param msg - Message ID
 * @param wParam - First parameter
 * @param lParam - Second parameter
 * @returns Result of SendMessage
 */
export function sendMessage(hwnd: number, msg: number, wParam: number, lParam: number): number {
  return addon.sendMessage(hwnd, msg, wParam, lParam);
}

/**
 * Post a message to a window (non-blocking)
 * @param hwnd - Window handle
 * @param msg - Message ID
 * @param wParam - First parameter
 * @param lParam - Second parameter
 * @returns Success boolean
 */
export function postMessage(hwnd: number, msg: number, wParam: number, lParam: number): boolean {
  return addon.postMessage(hwnd, msg, wParam, lParam);
}

/**
 * Send a notify message (non-blocking broadcast)
 * @param hwnd - Window handle (use HWND_BROADCAST for all windows)
 * @param msg - Message ID
 * @param wParam - First parameter
 * @param lParam - Second parameter
 * @returns Success boolean
 */
export function sendNotifyMessage(hwnd: number, msg: number, wParam: number, lParam: number): boolean {
  return addon.sendNotifyMessage(hwnd, msg, wParam, lParam);
}

/**
 * Send a string to a window using WM_CHAR messages (optimized C++ loop)
 * This is more efficient than calling sendMessage for each character from JS
 * @param hwnd - Window handle
 * @param text - String to send
 * @returns Success boolean
 */
export function sendChatString(hwnd: number, text: string): boolean {
  return addon.sendChatString(hwnd, text);
}

/**
 * Send a key press to a window (WM_KEYDOWN + WM_KEYUP)
 * @param hwnd - Window handle
 * @param vkCode - Virtual key code
 */
export function sendKeyPress(hwnd: number, vkCode: number): void {
  addon.sendKeyPress(hwnd, vkCode);
}

/**
 * Get the last Win32 error code
 * @returns Error code
 */
export function getLastError(): number {
  return addon.getLastError();
}

// Constants for convenience
export const HWND_BROADCAST = 0xffff;
export const WM_KEYDOWN = 0x0100;
export const WM_KEYUP = 0x0101;
export const WM_CHAR = 0x0102;
export const VK_RETURN = 0x0d;
