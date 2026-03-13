/**
 * Mock implementation of IRacingNative for non-Windows platforms.
 *
 * Provides simulated telemetry data for development and testing on macOS/Linux.
 * Cycles through telemetry snapshots to simulate a car driving around the track.
 */
import type { BroadcastMsg, IRSDKHeader, VarHeader } from "./defines.js";
import { MOCK_SESSION_INFO_YAML } from "./mock-data/session-info.js";
import { MOCK_SNAPSHOTS } from "./mock-data/snapshots.js";
import { buildTelemetryBuffer, getBufferSize, MOCK_VAR_HEADERS, MOCK_VAR_INDEX_MAP } from "./mock-data/telemetry.js";

/** Default interval between snapshot rotations in milliseconds */
const DEFAULT_ROTATION_INTERVAL_MS = 5000;

export class IRacingNativeMock {
  private connected = false;
  private currentSnapshotIndex = 0;
  private lastRotationTime = 0;
  private rotationIntervalMs: number;
  private sessionInfoUpdate = 0;

  constructor(rotationIntervalMs = DEFAULT_ROTATION_INTERVAL_MS) {
    this.rotationIntervalMs = rotationIntervalMs;
  }

  startup(): boolean {
    this.connected = true;
    this.lastRotationTime = Date.now();
    this.sessionInfoUpdate = 1;

    return true;
  }

  shutdown(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getHeader(): IRSDKHeader | null {
    if (!this.connected) return null;

    return {
      ver: 2,
      status: 1,
      tickRate: 60,
      sessionInfoUpdate: this.sessionInfoUpdate,
      sessionInfoLen: MOCK_SESSION_INFO_YAML.length,
      sessionInfoOffset: 0,
      numVars: MOCK_VAR_HEADERS.length,
      varHeaderOffset: 0,
      numBuf: 4,
      bufLen: getBufferSize(),
    };
  }

  getData(_index: number): Buffer | null {
    if (!this.connected) return null;

    return buildTelemetryBuffer(MOCK_SNAPSHOTS[this.currentSnapshotIndex]);
  }

  waitForData(_timeoutMs?: number): Buffer | null {
    if (!this.connected) return null;

    this.maybeRotateSnapshot();

    return buildTelemetryBuffer(MOCK_SNAPSHOTS[this.currentSnapshotIndex]);
  }

  getSessionInfoStr(): string | null {
    if (!this.connected) return null;

    return MOCK_SESSION_INFO_YAML;
  }

  getVarHeaderEntry(index: number): VarHeader | null {
    if (index < 0 || index >= MOCK_VAR_HEADERS.length) return null;

    return MOCK_VAR_HEADERS[index];
  }

  varNameToIndex(name: string): number {
    return MOCK_VAR_INDEX_MAP.get(name) ?? -1;
  }

  broadcastMsg(msg: BroadcastMsg | number, var1: number, var2?: number, var3?: number): void {
    console.debug(`[IRacingNativeMock] broadcastMsg(${msg}, ${var1}, ${var2 ?? 0}, ${var3 ?? 0})`);
  }

  sendChatMessage(message: string): boolean {
    console.debug(`[IRacingNativeMock] sendChatMessage("${message}")`);

    return true;
  }

  focusIRacingWindow(): boolean {
    console.debug("[IRacingNativeMock] focusIRacingWindow()");

    return true;
  }

  sendScanKeys(scanCodes: number[]): void {
    console.debug(`[IRacingNativeMock] sendScanKeys([${scanCodes.join(", ")}])`);
  }

  sendScanKeyDown(scanCodes: number[]): void {
    console.debug(`[IRacingNativeMock] sendScanKeyDown([${scanCodes.join(", ")}])`);
  }

  sendScanKeyUp(scanCodes: number[]): void {
    console.debug(`[IRacingNativeMock] sendScanKeyUp([${scanCodes.join(", ")}])`);
  }

  private maybeRotateSnapshot(): void {
    const now = Date.now();

    if (now - this.lastRotationTime >= this.rotationIntervalMs) {
      this.currentSnapshotIndex = (this.currentSnapshotIndex + 1) % MOCK_SNAPSHOTS.length;
      this.lastRotationTime = now;
    }
  }
}
