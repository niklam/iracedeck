/**
 * Windows Messaging Helper
 * Encapsulates Windows API calls for keyboard simulation and window management
 */

import koffi from 'koffi';
import streamDeck from '@elgato/streamdeck';

// Windows message constants
export const WM_KEYDOWN = 0x0100;
export const WM_KEYUP = 0x0101;
export const WM_CHAR = 0x0102;
export const WM_SYSKEYDOWN = 0x0104;
export const WM_SYSKEYUP = 0x0105;
export const WM_PASTE = 0x0302;
export const WM_SETTEXT = 0x000C;
export const EM_REPLACESEL = 0x00C2;

// Keyboard event flags
export const KEYEVENTF_KEYUP = 0x0002;
export const KEYEVENTF_UNICODE = 0x0004;

// Virtual key codes
export const VK_RETURN = 0x0D;
export const VK_SHIFT = 0x10;
export const VK_CONTROL = 0x11;
export const VK_ALT = 0x12;
export const VK_V = 0x56;

// Clipboard formats
export const CF_UNICODETEXT = 13;

// Memory allocation flags
export const GMEM_MOVEABLE = 0x0002;

// iRacing window title
const IRACING_WINDOW_TITLE = 'iRacing.com Simulator';

// Load Windows DLLs
const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

// user32.dll functions
const FindWindowA = user32.func('FindWindowA', 'void *', ['string', 'string']);
const GetForegroundWindow = user32.func('GetForegroundWindow', 'void *', []);
const SetForegroundWindow = user32.func('SetForegroundWindow', 'int', ['void *']);
const SendMessageW = user32.func('SendMessageW', 'intptr', ['void *', 'uint32', 'uintptr', 'void *']);
const PostMessageW = user32.func('PostMessageW', 'int', ['void *', 'uint32', 'uintptr', 'intptr']);
const SendNotifyMessageW = user32.func('SendNotifyMessageW', 'int', ['void *', 'uint32', 'uintptr', 'intptr']);
const RegisterWindowMessageA = user32.func('RegisterWindowMessageA', 'uint32', ['string']);
const VkKeyScanW = user32.func('VkKeyScanW', 'int16', ['uint16']);
const keybd_event = user32.func('keybd_event', 'void', ['uint8', 'uint16', 'uint32', 'uintptr']);

// Clipboard functions
const OpenClipboard = user32.func('OpenClipboard', 'int', ['void *']);
const EmptyClipboard = user32.func('EmptyClipboard', 'int', []);
const SetClipboardData = user32.func('SetClipboardData', 'void *', ['uint32', 'void *']);
const CloseClipboard = user32.func('CloseClipboard', 'int', []);

// kernel32.dll functions
const GlobalAlloc = kernel32.func('GlobalAlloc', 'void *', ['uint32', 'uintptr']);
const GlobalLock = kernel32.func('GlobalLock', 'void *', ['void *']);
const GlobalUnlock = kernel32.func('GlobalUnlock', 'int', ['void *']);
const GetLastError = kernel32.func('GetLastError', 'uint32', []);

/**
 * Windows Messaging class for handling Windows API calls
 */
export class WindowsMessaging {
	private static instance: WindowsMessaging;

	private constructor() {}

	/**
	 * Get singleton instance
	 */
	static getInstance(): WindowsMessaging {
		if (!WindowsMessaging.instance) {
			WindowsMessaging.instance = new WindowsMessaging();
		}
		return WindowsMessaging.instance;
	}

	/**
	 * Find the iRacing simulator window
	 * @returns Window handle or null if not found
	 */
	getIRacingWindow(): any {
		streamDeck.logger.info('[WindowsMessaging] Finding iRacing window');

		const hwnd = FindWindowA(null, IRACING_WINDOW_TITLE);
		if (!hwnd) {
			streamDeck.logger.warn('[WindowsMessaging] iRacing window not found');
			return null;
		}

		streamDeck.logger.info('[WindowsMessaging] iRacing window found');

		return hwnd;
	}

	/**
	 * Get the current foreground window
	 * @returns Window handle
	 */
	getForegroundWindow(): any {
		return GetForegroundWindow();
	}

	/**
	 * Bring a window to the foreground
	 * @param hwnd Window handle
	 * @returns Success
	 */
	setForegroundWindow(hwnd: any): boolean {
		return SetForegroundWindow(hwnd) !== 0;
	}

	/**
	 * Send a message to a window
	 * @param hwnd Window handle
	 * @param msg Message type
	 * @param wParam First parameter
	 * @param lParam Second parameter
	 * @returns Result
	 */
	sendMessage(hwnd: any, msg: number, wParam: number, lParam: any): number {
		return SendMessageW(hwnd, msg, wParam, lParam);
	}

	/**
	 * Post a message to a window (non-blocking)
	 * @param hwnd Window handle
	 * @param msg Message type
	 * @param wParam First parameter
	 * @param lParam Second parameter
	 * @returns Success
	 */
	postMessage(hwnd: any, msg: number, wParam: number, lParam: number): boolean {
		return PostMessageW(hwnd, msg, wParam, lParam) !== 0;
	}

	/**
	 * Send a key down event to a window
	 * @param hwnd Window handle
	 * @param vkCode Virtual key code
	 */
	sendKeyDown(hwnd: any, vkCode: number): void {
		SendMessageW(hwnd, WM_KEYDOWN, vkCode, 0);
	}

	/**
	 * Send a key up event to a window
	 * @param hwnd Window handle
	 * @param vkCode Virtual key code
	 */
	sendKeyUp(hwnd: any, vkCode: number): void {
		SendMessageW(hwnd, WM_KEYUP, vkCode, 0);
	}

	/**
	 * Send a key press (down + up) to a window
	 * @param hwnd Window handle
	 * @param vkCode Virtual key code
	 */
	sendKeyPress(hwnd: any, vkCode: number): void {
		this.sendKeyDown(hwnd, vkCode);
		this.sendKeyUp(hwnd, vkCode);
	}

	/**
	 * Send a character to a window using WM_CHAR
	 * @param hwnd Window handle
	 * @param char Character to send
	 */
	sendChar(hwnd: any, char: string): void {
		SendMessageW(hwnd, WM_CHAR, char.charCodeAt(0), 0);
	}

	/**
	 * Send a string to a window character by character
	 * @param hwnd Window handle
	 * @param text Text to send
	 */
	sendString(hwnd: any, text: string): void {
		for (const char of text) {
			this.sendChar(hwnd, char);
		}
	}

	/**
	 * Simulate a key press using keybd_event (hardware simulation)
	 * @param vkCode Virtual key code
	 * @param keyUp Whether this is a key up event
	 */
	simulateKey(vkCode: number, keyUp: boolean = false): void {
		const flags = keyUp ? KEYEVENTF_KEYUP : 0;
		keybd_event(vkCode, 0, flags, 0);
	}

	/**
	 * Simulate a key press (down + up) using keybd_event
	 * @param vkCode Virtual key code
	 */
	simulateKeyPress(vkCode: number): void {
		this.simulateKey(vkCode, false);
		this.simulateKey(vkCode, true);
	}

	/**
	 * Type a character using keybd_event with proper modifiers
	 * @param char Character to type
	 */
	typeCharacter(char: string): void {
		const charCode = char.charCodeAt(0);
		const vkResult = VkKeyScanW(charCode);

		if (vkResult === -1) {
			streamDeck.logger.warn(`[WindowsMessaging] Character '${char}' not available in keyboard layout`);
			return;
		}

		const vkCode = vkResult & 0xFF;
		const shiftState = (vkResult >> 8) & 0xFF;

		const needsShift = (shiftState & 1) !== 0;
		const needsCtrl = (shiftState & 2) !== 0;
		const needsAlt = (shiftState & 4) !== 0;

		// Press modifiers
		if (needsShift) this.simulateKey(VK_SHIFT, false);
		if (needsCtrl) this.simulateKey(VK_CONTROL, false);
		if (needsAlt) this.simulateKey(VK_ALT, false);

		// Press key
		this.simulateKeyPress(vkCode);

		// Release modifiers (reverse order)
		if (needsAlt) this.simulateKey(VK_ALT, true);
		if (needsCtrl) this.simulateKey(VK_CONTROL, true);
		if (needsShift) this.simulateKey(VK_SHIFT, true);
	}

	/**
	 * Type a string using keybd_event
	 * @param text Text to type
	 */
	typeString(text: string): void {
		for (const char of text) {
			this.typeCharacter(char);
		}
	}

	/**
	 * Set text to clipboard
	 * @param text Text to copy to clipboard
	 * @returns Success
	 */
	setClipboardText(text: string): boolean {
		try {
			const buffer = Buffer.from(text + '\0', 'utf16le');
			const hMem = GlobalAlloc(GMEM_MOVEABLE, buffer.length);

			if (!hMem || koffi.decode(hMem, 'uintptr') === 0) {
				streamDeck.logger.error('[WindowsMessaging] Failed to allocate memory for clipboard');
				return false;
			}

			const pMem = GlobalLock(hMem);
			if (!pMem || koffi.decode(pMem, 'uintptr') === 0) {
				streamDeck.logger.error('[WindowsMessaging] Failed to lock memory for clipboard');
				return false;
			}

			// Copy buffer to allocated memory
			const destPtr = koffi.decode(pMem, 'uintptr');
			for (let i = 0; i < buffer.length; i++) {
				const bytePtr = koffi.as(destPtr + i, 'uint8 *');
				koffi.encode(bytePtr, 'uint8', buffer[i]);
			}

			GlobalUnlock(hMem);

			if (OpenClipboard(null) === 0) {
				streamDeck.logger.error('[WindowsMessaging] Failed to open clipboard');
				return false;
			}

			EmptyClipboard();
			SetClipboardData(CF_UNICODETEXT, hMem);
			CloseClipboard();

			return true;
		} catch (error) {
			streamDeck.logger.error(`[WindowsMessaging] Error setting clipboard: ${error}`);
			return false;
		}
	}

	/**
	 * Paste from clipboard using Ctrl+V
	 */
	paste(): void {
		this.simulateKey(VK_CONTROL, false);
		this.simulateKeyPress(VK_V);
		this.simulateKey(VK_CONTROL, true);
	}

	/**
	 * Send WM_PASTE to a window
	 * @param hwnd Window handle
	 */
	sendPaste(hwnd: any): void {
		SendMessageW(hwnd, WM_PASTE, 0, 0);
	}

	/**
	 * Get the last Windows error code
	 * @returns Error code
	 */
	getLastError(): number {
		return GetLastError();
	}

	/**
	 * Get virtual key code for a character
	 * @param char Character
	 * @returns Virtual key code and shift state, or -1 if not found
	 */
	getVirtualKeyCode(char: string): { vkCode: number; shiftState: number } | null {
		const vkResult = VkKeyScanW(char.charCodeAt(0));
		if (vkResult === -1) {
			return null;
		}
		return {
			vkCode: vkResult & 0xFF,
			shiftState: (vkResult >> 8) & 0xFF
		};
	}

	/**
	 * Register a custom Windows message
	 * @param messageName Message name to register
	 * @returns Message ID
	 */
	registerWindowMessage(messageName: string): number {
		return RegisterWindowMessageA(messageName);
	}

	/**
	 * Send a notify message (non-blocking broadcast)
	 * @param hwnd Window handle (use HWND_BROADCAST for all windows)
	 * @param msg Message ID
	 * @param wParam First parameter
	 * @param lParam Second parameter
	 * @returns Success
	 */
	sendNotifyMessage(hwnd: number, msg: number, wParam: number, lParam: number): boolean {
		return SendNotifyMessageW(hwnd, msg, wParam, lParam) !== 0;
	}
}
