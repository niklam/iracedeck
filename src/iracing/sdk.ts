/**
 * iRacing SDK - Memory-mapped file reader
 * Uses koffi FFI to access Windows APIs for reading iRacing's shared memory
 */

import koffi from 'koffi';
import streamDeck from '@elgato/streamdeck';
import {
	IRSDKHeader,
	VarHeader,
	VarBuf,
	VarType,
	StatusField,
	TelemetryData,
	SessionInfo,
	IRSDK_MAX_BUFS,
	IRSDK_MAX_STRING,
	IRSDK_MAX_DESC
} from './types';
import yaml from 'yaml';
import { ChatCommand } from './broadcast/index';
import { WindowsMessaging } from './windows-messaging';

// Windows API constants
const FILE_MAP_READ = 0x0004;
const INVALID_HANDLE_VALUE = -1;

// Load Windows kernel32.dll functions
const kernel32 = koffi.load('kernel32.dll');

const OpenFileMappingA = kernel32.func('OpenFileMappingA', 'void *', ['uint32', 'int', 'string']);
const MapViewOfFile = kernel32.func('MapViewOfFile', 'void *', ['void *', 'uint32', 'uint32', 'uint32', 'uintptr']);
const UnmapViewOfFile = kernel32.func('UnmapViewOfFile', 'int', ['void *']);
const CloseHandle = kernel32.func('CloseHandle', 'int', ['void *']);

// Load Windows user32.dll functions for sending messages
const user32 = koffi.load('user32.dll');
const RegisterWindowMessageA = user32.func('RegisterWindowMessageA', 'uint32', ['string']);
const SendMessageW = user32.func('SendMessageW', 'intptr', ['void *', 'uint32', 'uintptr', 'intptr']);
const SendNotifyMessageW = user32.func('SendNotifyMessageW', 'int', ['void *', 'uint32', 'uintptr', 'intptr']);
const FindWindowA = user32.func('FindWindowA', 'void *', ['string', 'string']);
const GetLastError = kernel32.func('GetLastError', 'uint32', []);

// INPUT structure for SendInput
// On Windows, this is: DWORD type + union (which we'll represent as a byte array)
// The union is 24 bytes on 32-bit and 40 bytes on 64-bit (MOUSEINPUT is largest)
// But we only use KEYBDINPUT which is smaller, padded to match union size
const INPUT = koffi.struct('INPUT', {
	type: 'uint32',
	// KEYBDINPUT fields (when type == INPUT_KEYBOARD)
	wVk: 'uint16',
	wScan: 'uint16',
	dwFlags: 'uint32',
	time: 'uint32',
	dwExtraInfo: 'uintptr',
	// Padding to match MOUSEINPUT size (largest union member on 64-bit)
	_padding: koffi.array('uint32', 2)
});

// Virtual key codes
const VK_RETURN = 0x0D;

// Define iRacing SDK structures using koffi
const VarBufStruct = koffi.struct('VarBuf', {
	tickCount: 'int',
	bufOffset: 'int',
	pad: koffi.array('int', 2)
});

const IRSDKHeaderStruct = koffi.struct('IRSDKHeader', {
	ver: 'int',
	status: 'int',
	tickRate: 'int',
	sessionInfoUpdate: 'int',
	sessionInfoLen: 'int',
	sessionInfoOffset: 'int',
	numVars: 'int',
	varHeaderOffset: 'int',
	numBuf: 'int',
	bufLen: 'int',
	pad1: koffi.array('int', 2),
	varBuf: koffi.array(VarBufStruct, 4)
});

const VarHeaderStruct = koffi.struct('VarHeader', {
	type: 'int',
	offset: 'int',
	count: 'int',
	countAsTime: 'bool',
	pad: koffi.array('char', 3),
	name: koffi.array('char', 32),
	desc: koffi.array('char', 64),
	unit: koffi.array('char', 32)
});

// Helper function to read bytes from a pointer with offset
function readBytes(ptr: any, offset: number, length: number): Buffer {
	try {
		// Direct byte-by-byte reading using koffi
		const bytes = new Uint8Array(length);

		// Read directly from the pointer as a byte array
		const baseArray = koffi.decode(ptr, koffi.array('uint8_t', offset + length));

		// Copy only the bytes we need
		for (let i = 0; i < length; i++) {
			bytes[i] = baseArray[offset + i];
		}

		return Buffer.from(bytes);
	} catch (error) {
		streamDeck.logger.error(`[iRacing SDK] Failed to read ${length} bytes at offset ${offset}: ${error}`);
		throw error;
	}
}

/**
 * iRacing SDK Client
 * Manages connection to iRacing's shared memory and provides telemetry data
 */
export class IRacingSDK {
	private hMapFile: any = null;
	private pSharedMem: any = null;
	private header: IRSDKHeader | null = null;
	private varHeaders: VarHeader[] = [];
	private lastSessionInfoUpdate = -1;
	private sessionInfo: SessionInfo | null = null;
	private windowsMessaging: WindowsMessaging;
	private chatCommand: ChatCommand;

	constructor() {
		this.windowsMessaging = WindowsMessaging.getInstance();
		this.chatCommand = ChatCommand.getInstance();
	}

	/**
	 * Check if iRacing is running and memory-mapped file is accessible
	 */
	isConnected(): boolean {
		if (!this.pSharedMem) {
			return false;
		}

		// Check status field in header - re-read it to get current status
		if (!this.header) {
			return false;
		}

		// Re-read the status field from shared memory to detect disconnection
		try {
			const statusBuffer = readBytes(this.pSharedMem, 4, 4); // status is at offset 4, 4 bytes
			const currentStatus = statusBuffer.readInt32LE(0);
			this.header.status = currentStatus; // Update cached header

			return (currentStatus & StatusField.Connected) !== 0;
		} catch (error) {
			streamDeck.logger.error(`[iRacing SDK] Failed to read status field: ${error}`);
			return false;
		}
	}

	/**
	 * Connect to iRacing's shared memory
	 */
	connect(): boolean {
		// Try to open the memory-mapped file
		this.hMapFile = OpenFileMappingA(FILE_MAP_READ, 0, 'Local\\IRSDKMemMapFileName');

		if (!this.hMapFile || this.hMapFile === INVALID_HANDLE_VALUE) {
			return false;
		}

		// Map the file into memory
		this.pSharedMem = MapViewOfFile(this.hMapFile, FILE_MAP_READ, 0, 0, 0);

		if (!this.pSharedMem) {
			streamDeck.logger.error('[iRacing SDK] Failed to map view of file');
			this.disconnect();
			return false;
		}

		// Parse the header
		this.parseHeader();

		const connected = this.isConnected();
		if (connected) {
			streamDeck.logger.info(`[iRacing SDK] Connected - ${this.varHeaders.length} variables available`);
		}

		return connected;
	}

	/**
	 * Disconnect from iRacing's shared memory
	 */
	disconnect(): void {
		if (this.pSharedMem) {
			UnmapViewOfFile(this.pSharedMem);
			this.pSharedMem = null;
		}

		if (this.hMapFile) {
			CloseHandle(this.hMapFile);
			this.hMapFile = null;
		}

		this.header = null;
		this.varHeaders = [];
		this.sessionInfo = null;
		this.lastSessionInfoUpdate = -1;
	}

	/**
	 * Parse the main header from shared memory
	 */
	private parseHeader(): void {
		if (!this.pSharedMem) return;

		// Read header structure (144 bytes base + variable buffers)
		const headerView = readBytes(this.pSharedMem, 0, 144);

		this.header = {
			ver: headerView.readInt32LE(0),
			status: headerView.readInt32LE(4),
			tickRate: headerView.readInt32LE(8),
			sessionInfoUpdate: headerView.readInt32LE(12),
			sessionInfoLen: headerView.readInt32LE(16),
			sessionInfoOffset: headerView.readInt32LE(20),
			numVars: headerView.readInt32LE(24),
			varHeaderOffset: headerView.readInt32LE(28),
			numBuf: headerView.readInt32LE(32),
			bufLen: headerView.readInt32LE(36),
			padData: [],
			varBuf: []
		};

		// Parse variable buffers (16 bytes each)
		for (let i = 0; i < IRSDK_MAX_BUFS; i++) {
			const offset = 48 + (i * 16);
			this.header.varBuf.push({
				tickCount: headerView.readInt32LE(offset),
				bufOffset: headerView.readInt32LE(offset + 4),
				padData: []
			});
		}

		// Parse variable headers
		this.parseVarHeaders();
	}

	/**
	 * Parse variable header definitions
	 */
	private parseVarHeaders(): void {
		if (!this.pSharedMem || !this.header) return;

		this.varHeaders = [];
		const varHeaderSize = 144; // Size of each VarHeader struct

		for (let i = 0; i < this.header.numVars; i++) {
			const offset = this.header.varHeaderOffset + (i * varHeaderSize);
			const varHeaderBuf = readBytes(this.pSharedMem, offset, varHeaderSize);

			const varHeader: VarHeader = {
				type: varHeaderBuf.readInt32LE(0),
				offset: varHeaderBuf.readInt32LE(4),
				count: varHeaderBuf.readInt32LE(8),
				countAsTime: varHeaderBuf.readInt8(12) !== 0,
				name: this.readString(varHeaderBuf, 16, IRSDK_MAX_STRING),
				desc: this.readString(varHeaderBuf, 48, IRSDK_MAX_DESC),
				unit: this.readString(varHeaderBuf, 112, IRSDK_MAX_STRING)
			};

			this.varHeaders.push(varHeader);
		}
	}

	/**
	 * Read null-terminated string from buffer
	 */
	private readString(buffer: Buffer, offset: number, maxLen: number): string {
		const bytes: number[] = [];
		for (let i = 0; i < maxLen; i++) {
			const byte = buffer.readUInt8(offset + i);
			if (byte === 0) break;
			bytes.push(byte);
		}
		return Buffer.from(bytes).toString('ascii');
	}

	/**
	 * Get the latest telemetry data
	 */
	getTelemetry(): TelemetryData | null {
		if (!this.isConnected() || !this.header || !this.pSharedMem) {
			return null;
		}

		// Find the latest buffer
		let latestBuf: VarBuf | null = null;
		for (const buf of this.header.varBuf) {
			if (!latestBuf || buf.tickCount > latestBuf.tickCount) {
				latestBuf = buf;
			}
		}

		if (!latestBuf || latestBuf.bufOffset === 0) {
			return null;
		}

		// Read telemetry data from the buffer
		const telemetry: TelemetryData = {};

		for (const varHeader of this.varHeaders) {
			const dataOffset = latestBuf.bufOffset + varHeader.offset;
			const value = this.readVariable(dataOffset, varHeader);
			telemetry[varHeader.name] = value;
		}

		return telemetry;
	}

	/**
	 * Read a variable value from memory based on its type
	 */
	private readVariable(offset: number, varHeader: VarHeader): any {
		if (!this.pSharedMem) return null;

		const { type, count } = varHeader;

		// Handle arrays
		if (count > 1) {
			const values: any[] = [];
			let elementSize = 4; // Default to 4 bytes

			if (type === VarType.Char) elementSize = 1;
			else if (type === VarType.Double) elementSize = 8;

			for (let i = 0; i < count; i++) {
				const elemOffset = offset + (i * elementSize);
				values.push(this.readSingleValue(elemOffset, type));
			}

			return values;
		}

		// Handle single values
		return this.readSingleValue(offset, type);
	}

	/**
	 * Read a single value of a specific type
	 */
	private readSingleValue(offset: number, type: VarType): any {
		if (!this.pSharedMem) return null;

		const buffer = readBytes(this.pSharedMem, offset, 8);

		switch (type) {
			case VarType.Char:
				return buffer.readInt8(0);
			case VarType.Bool:
				return buffer.readInt8(0) !== 0;
			case VarType.Int:
			case VarType.BitField:
				return buffer.readInt32LE(0);
			case VarType.Float:
				return buffer.readFloatLE(0);
			case VarType.Double:
				return buffer.readDoubleLE(0);
			default:
				return null;
		}
	}

	/**
	 * Get session info (YAML data)
	 */
	getSessionInfo(): SessionInfo | null {
		if (!this.isConnected() || !this.header || !this.pSharedMem) {
			return null;
		}

		// Check if session info has been updated
		if (this.header.sessionInfoUpdate === this.lastSessionInfoUpdate && this.sessionInfo) {
			return this.sessionInfo;
		}

		// Read session info YAML string
		const sessionInfoBuf = readBytes(this.pSharedMem, this.header.sessionInfoOffset, this.header.sessionInfoLen);
		const yamlString = this.readString(sessionInfoBuf, 0, this.header.sessionInfoLen);

		// Parse YAML to object
		try {
			this.sessionInfo = yaml.parse(yamlString);
			this.lastSessionInfoUpdate = this.header.sessionInfoUpdate;
		} catch (error) {
			console.error('Failed to parse session info YAML:', error);
			return null;
		}

		return this.sessionInfo;
	}

	/**
	 * Get a specific telemetry variable by name
	 */
	getVar(name: string): any {
		const telemetry = this.getTelemetry();
		if (!telemetry) return null;
		return telemetry[name];
	}

	/**
	 * Get list of all available variable names
	 */
	getVarNames(): string[] {
		return this.varHeaders.map(v => v.name);
	}

	/**
	 * Get variable header info by name
	 */
	getVarHeader(name: string): VarHeader | null {
		return this.varHeaders.find(v => v.name === name) || null;
	}

	/**
	 * Send a custom chat message to iRacing
	 * @param message The message to send
	 */
	sendChatMessage(message: string): boolean {
		streamDeck.logger.info('[iRacing SDK] About to send a chat message');

		if (!this.isConnected()) {
			streamDeck.logger.warn('[iRacing SDK] Cannot send chat message - not connected');
			return false;
		}

		try {
			const hwnd = this.windowsMessaging.getIRacingWindow();

			if (!hwnd) {
				streamDeck.logger.error('[iRacing SDK] Could not find iRacing window');
				return false;
			}

			streamDeck.logger.debug('[iRacing SDK] iRacing window found');

			return this.chatCommand.sendMessage(hwnd, message);
		} catch (error) {
			streamDeck.logger.error(`[iRacing SDK] Error sending chat message: ${error}`);
			return false;
		}
	}
}
