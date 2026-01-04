/**
 * iRacing SDK - Telemetry and Session Data Client
 * Uses native addon to access the official iRacing SDK
 */
import {
  broadcastMsg,
  getHeader,
  getSessionInfoStr,
  getVarHeaderEntry,
  isConnected,
  sendChatMessage as nativeSendChatMessage,
  shutdown,
  startup,
  waitForData,
} from "@iracedeck/iracing-native";
import yaml from "yaml";

import { getLogger } from "./logger.js";
import { SessionInfo, TelemetryData, VarHeader, VarType } from "./types.js";

/**
 * iRacing SDK Client
 * Manages connection to iRacing's shared memory and provides telemetry data
 */
export class IRacingSDK {
  private varHeaders: VarHeader[] = [];
  private lastSessionInfoUpdate = -1;
  private sessionInfo: SessionInfo | null = null;
  private connected = false;

  /**
   * Check if iRacing is running and SDK is connected
   */
  isConnected(): boolean {
    if (!this.connected) {
      return false;
    }

    return isConnected();
  }

  /**
   * Connect to iRacing's shared memory
   */
  connect(): boolean {
    if (!startup()) {
      return false;
    }

    // Get header to verify connection
    const header = getHeader();

    if (!header) {
      shutdown();

      return false;
    }

    this.connected = true;

    // Parse variable headers
    this.parseVarHeaders(header.numVars);

    if (this.isConnected()) {
      getLogger().info(`[iRacing SDK] Connected - ${this.varHeaders.length} variables available`);
    }

    return this.isConnected();
  }

  /**
   * Disconnect from iRacing's shared memory
   */
  disconnect(): void {
    if (this.connected) {
      shutdown();
      this.connected = false;
    }

    this.varHeaders = [];
    this.sessionInfo = null;
    this.lastSessionInfoUpdate = -1;
  }

  /**
   * Parse variable header definitions from the SDK
   */
  private parseVarHeaders(numVars: number): void {
    this.varHeaders = [];

    for (let i = 0; i < numVars; i++) {
      const nativeHeader = getVarHeaderEntry(i);

      if (!nativeHeader) continue;

      const varHeader: VarHeader = {
        type: nativeHeader.type as VarType,
        offset: nativeHeader.offset,
        count: nativeHeader.count,
        countAsTime: nativeHeader.countAsTime,
        name: nativeHeader.name,
        desc: nativeHeader.desc,
        unit: nativeHeader.unit,
      };

      this.varHeaders.push(varHeader);
    }
  }

  /**
   * Get the latest telemetry data
   * Uses the SDK's waitForData to get consistent reads
   */
  getTelemetry(): TelemetryData | null {
    if (!this.isConnected()) {
      return null;
    }

    // Wait for new data (with short timeout for polling)
    const data = waitForData(0);

    if (!data) {
      return null;
    }

    // Parse telemetry from the buffer
    const telemetry: TelemetryData = {};

    for (const varHeader of this.varHeaders) {
      const value = this.parseVariable(data, varHeader);
      telemetry[varHeader.name] = value as TelemetryData[string];
    }

    return telemetry;
  }

  /**
   * Parse a variable value from a data buffer
   */
  private parseVariable(buffer: Buffer, varHeader: VarHeader): unknown {
    const { type, count, offset } = varHeader;

    // Handle arrays
    if (count > 1) {
      const values: unknown[] = [];
      let elementSize = 4; // Default to 4 bytes

      if (type === VarType.Char) elementSize = 1;
      else if (type === VarType.Double) elementSize = 8;

      for (let i = 0; i < count; i++) {
        const elemOffset = offset + i * elementSize;
        values.push(this.parseSingleValue(buffer, elemOffset, type));
      }

      return values;
    }

    // Handle single values
    return this.parseSingleValue(buffer, offset, type);
  }

  /**
   * Parse a single value of a specific type from a buffer
   */
  private parseSingleValue(buffer: Buffer, offset: number, type: VarType): unknown {
    // Bounds check
    if (offset < 0 || offset >= buffer.length) {
      return null;
    }

    switch (type) {
      case VarType.Char:
        return buffer.readInt8(offset);
      case VarType.Bool:
        return buffer.readInt8(offset) !== 0;
      case VarType.Int:
      case VarType.BitField:
        return buffer.readInt32LE(offset);
      case VarType.Float:
        return buffer.readFloatLE(offset);
      case VarType.Double:
        return buffer.readDoubleLE(offset);
      default:
        return null;
    }
  }

  /**
   * Get session info (YAML data)
   */
  getSessionInfo(): SessionInfo | null {
    if (!this.isConnected()) {
      return null;
    }

    const header = getHeader();

    if (!header) {
      return null;
    }

    // Check if session info has been updated
    if (header.sessionInfoUpdate === this.lastSessionInfoUpdate && this.sessionInfo) {
      return this.sessionInfo;
    }

    // Get session info YAML string from native SDK
    const yamlString = getSessionInfoStr();

    if (!yamlString) {
      return null;
    }

    // Parse YAML to object
    try {
      this.sessionInfo = yaml.parse(yamlString);
      this.lastSessionInfoUpdate = header.sessionInfoUpdate;
    } catch (error) {
      getLogger().error(`[iRacing SDK] Failed to parse session info YAML: ${error}`);

      return null;
    }

    return this.sessionInfo;
  }

  /**
   * Get a specific telemetry variable by name
   */
  getVar(name: string): unknown {
    const telemetry = this.getTelemetry();

    if (!telemetry) return null;

    return telemetry[name];
  }

  /**
   * Get list of all available variable names
   */
  getVarNames(): string[] {
    return this.varHeaders.map((v) => v.name);
  }

  /**
   * Get variable header info by name
   */
  getVarHeader(name: string): VarHeader | null {
    return this.varHeaders.find((v) => v.name === name) || null;
  }

  /**
   * Send a broadcast message to iRacing
   * @param msg Message type
   * @param var1 First parameter
   * @param var2 Second parameter
   * @param var3 Third parameter
   */
  broadcast(msg: number, var1: number, var2: number = 0, var3: number = 0): void {
    broadcastMsg(msg, var1, var2, var3);
  }

  /**
   * Send a custom chat message to iRacing
   * @param message The message to send
   */
  sendChatMessage(message: string): boolean {
    if (!this.isConnected()) {
      getLogger().warn("[iRacing SDK] Cannot send chat message - not connected");

      return false;
    }

    return nativeSendChatMessage(message);
  }
}
