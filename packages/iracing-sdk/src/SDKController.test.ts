import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IRacingSDK } from "./IRacingSDK.js";
import { SDKController, TelemetryCallback } from "./SDKController.js";
import { TelemetryData } from "./types.js";

// Create mock SDK factory
function createMockSDK(): IRacingSDK {
  return {
    connect: vi.fn().mockReturnValue(true),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    getTelemetry: vi.fn().mockReturnValue({ Speed: 100, Gear: 3 }),
    getSessionInfo: vi.fn().mockReturnValue(null),
    getVar: vi.fn(),
    getVarNames: vi.fn().mockReturnValue([]),
    getVarHeader: vi.fn().mockReturnValue(null),
    broadcast: vi.fn(),
    sendChatMessage: vi.fn().mockReturnValue(true),
  } as unknown as IRacingSDK;
}

describe("SDKController", () => {
  let mockSdk: IRacingSDK;
  let controller: SDKController;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSdk = createMockSDK();
    controller = new SDKController(mockSdk);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("subscribe", () => {
    it("should add subscriber and start updates on first subscription", () => {
      const callback = vi.fn();

      controller.subscribe("test", callback);

      // Should be called:
      // 1. From tryConnect -> notifySubscribers (connection state change)
      // 2. From subscribe() directly calling the callback
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it("should immediately notify subscriber with current telemetry", () => {
      const telemetry: TelemetryData = { Speed: 100, Gear: 3 };
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(telemetry);
      const callback = vi.fn();

      controller.subscribe("test", callback);

      expect(callback).toHaveBeenCalledWith(telemetry, expect.any(Boolean));
    });

    it("should support multiple subscribers", () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      controller.subscribe("test1", callback1);
      controller.subscribe("test2", callback2);

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });
  });

  describe("unsubscribe", () => {
    it("should remove subscriber", () => {
      const callback = vi.fn();
      controller.subscribe("test", callback);
      callback.mockClear();

      controller.unsubscribe("test");

      // Advance timers - callback should not be called
      vi.advanceTimersByTime(1000);
      expect(callback).not.toHaveBeenCalled();
    });

    it("should stop updates when last subscriber unsubscribes", () => {
      const callback = vi.fn();
      controller.subscribe("test", callback);

      controller.unsubscribe("test");

      expect(mockSdk.disconnect).toHaveBeenCalled();
    });
  });

  describe("getConnectionStatus", () => {
    it("should return false before subscribing", () => {
      expect(controller.getConnectionStatus()).toBe(false);
    });

    it("should return true after successful connection", () => {
      vi.mocked(mockSdk.connect).mockReturnValue(true);
      controller.subscribe("test", vi.fn());

      expect(controller.getConnectionStatus()).toBe(true);
    });

    it("should return false when connection fails", () => {
      vi.mocked(mockSdk.connect).mockReturnValue(false);
      controller.subscribe("test", vi.fn());

      expect(controller.getConnectionStatus()).toBe(false);
    });
  });

  describe("getCurrentTelemetry", () => {
    it("should return telemetry from SDK", () => {
      const telemetry: TelemetryData = { Speed: 50 };
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(telemetry);

      const result = controller.getCurrentTelemetry();

      expect(result).toEqual(telemetry);
    });

    it("should return cached telemetry when SDK returns null", () => {
      const telemetry: TelemetryData = { Speed: 50 };
      vi.mocked(mockSdk.getTelemetry).mockReturnValueOnce(telemetry).mockReturnValueOnce(null);

      // First call caches telemetry
      controller.getCurrentTelemetry();

      // Second call should return cached
      const result = controller.getCurrentTelemetry();
      expect(result).toEqual(telemetry);
    });
  });

  describe("sendChatMessage", () => {
    it("should delegate to SDK", () => {
      controller.sendChatMessage("Hello");

      expect(mockSdk.sendChatMessage).toHaveBeenCalledWith("Hello");
    });

    it("should return SDK result", () => {
      vi.mocked(mockSdk.sendChatMessage).mockReturnValue(false);

      expect(controller.sendChatMessage("test")).toBe(false);
    });
  });

  describe("update loop", () => {
    it("should notify subscribers on telemetry update", () => {
      const callback = vi.fn();
      const telemetry: TelemetryData = { Speed: 100 };
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(telemetry);
      vi.mocked(mockSdk.isConnected).mockReturnValue(true);

      controller.subscribe("test", callback);
      callback.mockClear();

      // Advance timer to trigger update
      vi.advanceTimersByTime(250);

      expect(callback).toHaveBeenCalledWith(telemetry, true);
    });

    it("should use cached telemetry when SDK returns null during update", () => {
      const callback = vi.fn();
      const telemetry: TelemetryData = { Speed: 100 };
      vi.mocked(mockSdk.connect).mockReturnValue(true);
      vi.mocked(mockSdk.isConnected).mockReturnValue(true);
      // First two calls return telemetry (for notifySubscribers and subscribe callback),
      // then one more for the update loop, then null
      vi.mocked(mockSdk.getTelemetry)
        .mockReturnValueOnce(telemetry)
        .mockReturnValueOnce(telemetry)
        .mockReturnValueOnce(telemetry)
        .mockReturnValue(null);

      controller.subscribe("test", callback);
      callback.mockClear();

      // First update should get telemetry normally
      vi.advanceTimersByTime(250);
      expect(callback).toHaveBeenCalledWith(telemetry, true);
      callback.mockClear();

      // Second update - getTelemetry returns null, should use cached
      vi.advanceTimersByTime(250);
      expect(callback).toHaveBeenCalledWith(telemetry, true);
    });
  });

  describe("reconnection", () => {
    it("should attempt reconnection when disconnected", () => {
      vi.mocked(mockSdk.connect).mockReturnValue(false);
      vi.mocked(mockSdk.isConnected).mockReturnValue(false);

      controller.subscribe("test", vi.fn());

      // Advance to trigger reconnect (2 second interval)
      vi.advanceTimersByTime(2000);

      expect(mockSdk.connect).toHaveBeenCalledTimes(2); // Initial + reconnect
    });

    it("should notify subscribers on disconnect", () => {
      const callback = vi.fn<TelemetryCallback>();
      vi.mocked(mockSdk.connect).mockReturnValue(true);
      vi.mocked(mockSdk.isConnected).mockReturnValue(true);

      controller.subscribe("test", callback);
      callback.mockClear();

      // Simulate disconnect - both isConnected and connect return false
      vi.mocked(mockSdk.isConnected).mockReturnValue(false);
      vi.mocked(mockSdk.connect).mockReturnValue(false);

      // The reconnect interval (2000ms) will call tryConnect
      // connect() returns false, so isConnected changes from true to false
      // This triggers notification to subscribers
      vi.advanceTimersByTime(2000);

      expect(callback).toHaveBeenCalledWith(expect.anything(), false);
    });
  });
});
