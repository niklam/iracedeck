/**
 * SDK Controller - Manages the iRacing SDK connection
 * and notifies subscribers of telemetry updates
 */
import { ILogger, silentLogger } from "@iracedeck/logger";

import { IRacingSDK } from "./IRacingSDK.js";
import { TelemetryData } from "./types.js";

export type TelemetryCallback = (telemetry: TelemetryData | null, isConnected: boolean) => void;

export class SDKController {
  private static _instance: SDKController;

  private sdk: IRacingSDK;
  private logger: ILogger = silentLogger;
  private subscribers = new Map<string, TelemetryCallback>();
  private updateInterval: NodeJS.Timeout | null = null;
  private reconnectInterval: NodeJS.Timeout | null = null;
  private isConnected = false;
  private lastValidTelemetry: TelemetryData | null = null;

  private constructor() {
    this.sdk = IRacingSDK.getInstance();
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): SDKController {
    if (!SDKController._instance) {
      SDKController._instance = new SDKController();
    }

    return SDKController._instance;
  }

  /**
   * Set the logger for this instance
   */
  setLogger(logger: ILogger): void {
    this.logger = logger;
  }

  /**
   * Subscribe to telemetry updates
   */
  subscribe(id: string, callback: TelemetryCallback): void {
    this.subscribers.set(id, callback);

    // Start updates if this is the first subscriber
    if (this.subscribers.size === 1) {
      this.start();
    }

    // Immediately notify the new subscriber of current state
    const telemetry = this.sdk.getTelemetry();
    callback(telemetry, this.isConnected);
  }

  /**
   * Unsubscribe from telemetry updates
   */
  unsubscribe(id: string): void {
    this.subscribers.delete(id);

    // Stop updates if no more subscribers
    if (this.subscribers.size === 0) {
      this.stop();
    }
  }

  /**
   * Start the update and reconnect loops
   */
  private start(): void {
    // Try initial connection
    this.tryConnect();

    // Start reconnect polling (slower - every 1 second)
    this.reconnectInterval = setInterval(() => {
      if (!this.sdk.isConnected()) {
        this.tryConnect();
      }
    }, 1000);

    // Start telemetry update loop (faster - 4Hz when connected)
    this.updateInterval = setInterval(() => {
      if (this.sdk.isConnected()) {
        this.update();
      }
    }, 250);
  }

  /**
   * Stop the update and reconnect loops
   */
  private stop(): void {
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    this.sdk.disconnect();
    this.isConnected = false;
  }

  /**
   * Try to connect to iRacing
   */
  private tryConnect(): void {
    const wasConnected = this.isConnected;
    const connected = this.sdk.connect();

    // Update connection state
    this.isConnected = connected;

    // Notify subscribers if connection state changed
    if (connected !== wasConnected) {
      if (connected) {
        this.logger.info("[SDKController] Connected to iRacing");
      }

      // Notify all subscribers of connection state change
      this.notifySubscribers();
    }
  }

  /**
   * Update telemetry and notify subscribers
   */
  private update(): void {
    // Only update if SDK thinks it's connected
    if (!this.sdk.isConnected()) {
      // SDK not connected, but we might have thought we were
      if (this.isConnected) {
        this.logger.info("[SDKController] Disconnected from iRacing");
        this.sdk.disconnect();
        this.isConnected = false;
        this.lastValidTelemetry = null;
        this.notifySubscribers(null);
      }

      return;
    }

    // SDK is connected, get telemetry
    const telemetry = this.sdk.getTelemetry();

    // Check if telemetry is null (could happen during buffer update)
    if (!telemetry) {
      // Use last valid telemetry if available to avoid blinking
      if (this.lastValidTelemetry) {
        this.notifySubscribers(this.lastValidTelemetry);
      }

      return;
    }

    // Cache the valid telemetry
    this.lastValidTelemetry = telemetry;
    this.notifySubscribers(telemetry);
  }

  /**
   * Notify all subscribers of telemetry update
   */
  private notifySubscribers(telemetry?: TelemetryData | null): void {
    const data = telemetry !== undefined ? telemetry : this.sdk.getTelemetry();

    for (const callback of this.subscribers.values()) {
      callback(data, this.isConnected);
    }
  }

  /**
   * Get current connection status
   */
  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  /**
   * Get current telemetry (for synchronous access)
   * Returns cached telemetry if fresh read fails
   */
  getCurrentTelemetry(): TelemetryData | null {
    const telemetry = this.sdk.getTelemetry();

    if (telemetry) {
      this.lastValidTelemetry = telemetry;

      return telemetry;
    }

    // Return cached telemetry if available
    return this.lastValidTelemetry;
  }

  /**
   * Send a custom chat message to iRacing
   * @param message The message to send
   */
  sendChatMessage(message: string): boolean {
    return this.sdk.sendChatMessage(message);
  }
}
