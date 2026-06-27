import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IRacingSDK } from "./IRacingSDK.js";
import { SDKController, TELEMETRY_INTERVAL_MS, TelemetryCallback } from "./SDKController.js";
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
    sendChatMessage: vi.fn().mockResolvedValue(true),
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

  describe("TELEMETRY_INTERVAL_MS", () => {
    it("polls at 100 Hz with enough headroom to absorb setInterval drift", () => {
      // Pinned literally so any future drift surfaces visibly. We poll at
      // 100 Hz (10 ms) — see the module-level docstring on
      // TELEMETRY_INTERVAL_MS for the rationale (issue #493 follow-up).
      expect(TELEMETRY_INTERVAL_MS).toBe(10);
      // Sanity: must be strictly faster than iRacing's 60 Hz write rate
      // (16.67 ms) for the dedupe approach to never miss a frame, with
      // enough headroom to absorb Windows scheduler jitter under load.
      expect(TELEMETRY_INTERVAL_MS).toBeLessThan(1000 / 60);
    });
  });

  describe("SessionTick dedupe", () => {
    it("notifies subscribers only when SessionTick advances", () => {
      const callback = vi.fn();
      const telemetry: TelemetryData = { Speed: 100, SessionTick: 1000 } as TelemetryData;
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(telemetry);

      controller.subscribe("test", callback);
      // Prime: let the first poll establish lastSessionTick = 1000, then
      // ignore the bookkeeping notifications from subscribe()/first poll.
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);
      callback.mockClear();

      // Three more polls reading the SAME tick — dedupe should suppress all.
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS * 3);
      expect(callback).not.toHaveBeenCalled();

      // Tick advances — next poll fires the callback exactly once.
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 100, SessionTick: 1001 } as TelemetryData);
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("notifies on every poll when SessionTick is undefined (legacy SDK builds)", () => {
      const callback = vi.fn();
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 100 } as TelemetryData);

      controller.subscribe("test", callback);
      callback.mockClear();

      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS * 3);
      expect(callback).toHaveBeenCalledTimes(3);
    });
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
    it("should delegate to SDK", async () => {
      await controller.sendChatMessage("Hello");

      expect(mockSdk.sendChatMessage).toHaveBeenCalledWith("Hello", undefined);
    });

    it("should forward timing delays to SDK", async () => {
      const timing = { openToPasteDelayMs: 300, pasteToEnterDelayMs: 450, enterToCloseDelayMs: 600 };

      await controller.sendChatMessage("Hello", timing);

      expect(mockSdk.sendChatMessage).toHaveBeenCalledWith("Hello", timing);
    });

    it("should return SDK result", async () => {
      vi.mocked(mockSdk.sendChatMessage).mockResolvedValue(false);

      await expect(controller.sendChatMessage("test")).resolves.toBe(false);
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

  describe("getCurrentTemplateContext", () => {
    it("should return null when no telemetry available", () => {
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(null);

      expect(controller.getCurrentTemplateContext()).toBeNull();
    });

    it("should return a template context when telemetry is available", () => {
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 100, Gear: 3 });
      vi.mocked(mockSdk.getSessionInfo).mockReturnValue(null);

      const ctx = controller.getCurrentTemplateContext();

      expect(ctx).not.toBeNull();
      expect(ctx!.display["telemetry.Speed"]).toBe("100");
    });

    it("should include raw values in the returned context", () => {
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 156.789, Gear: 3 });
      vi.mocked(mockSdk.getSessionInfo).mockReturnValue(null);

      const ctx = controller.getCurrentTemplateContext();

      expect(ctx).not.toBeNull();
      expect(ctx!.raw["telemetry.Speed"]).toBe(156.789);
      expect(typeof ctx!.raw["telemetry.Speed"]).toBe("number");
    });

    it("should cache context within the same tick", () => {
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 100, Gear: 3 });
      vi.mocked(mockSdk.getSessionInfo).mockReturnValue(null);

      const ctx1 = controller.getCurrentTemplateContext();
      const ctx2 = controller.getCurrentTemplateContext();

      expect(ctx1).toBe(ctx2); // Same object reference
    });

    it("should rebuild context after telemetry update", () => {
      vi.mocked(mockSdk.connect).mockReturnValue(true);
      vi.mocked(mockSdk.isConnected).mockReturnValue(true);
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 100, Gear: 3 });
      vi.mocked(mockSdk.getSessionInfo).mockReturnValue(null);

      controller.subscribe("test", vi.fn());

      const ctx1 = controller.getCurrentTemplateContext();

      // Simulate new telemetry tick
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 200, Gear: 4 });
      vi.advanceTimersByTime(250);

      const ctx2 = controller.getCurrentTemplateContext();

      expect(ctx2).not.toBe(ctx1);
      expect(ctx2!.display["telemetry.Speed"]).toBe("200");
    });

    it("should return null when no telemetry has ever been received", () => {
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(null);
      vi.mocked(mockSdk.getSessionInfo).mockReturnValue(null);

      expect(controller.getCurrentTemplateContext()).toBeNull();
    });

    it("should invalidate cached context on disconnect and rebuild on reconnect", () => {
      vi.mocked(mockSdk.connect).mockReturnValue(true);
      vi.mocked(mockSdk.isConnected).mockReturnValue(true);
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 100 });
      vi.mocked(mockSdk.getSessionInfo).mockReturnValue(null);

      controller.subscribe("test", vi.fn());

      const ctxBefore = controller.getCurrentTemplateContext();
      expect(ctxBefore).not.toBeNull();
      expect(ctxBefore!.display["telemetry.Speed"]).toBe("100");

      // After new telemetry, context should be rebuilt (not the same object)
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 300 });
      vi.advanceTimersByTime(250);

      const ctxAfter = controller.getCurrentTemplateContext();
      expect(ctxAfter).not.toBe(ctxBefore);
      expect(ctxAfter!.display["telemetry.Speed"]).toBe("300");
    });
  });

  describe("live race positions provider", () => {
    it("returns null when no provider is set", () => {
      expect(controller.getLiveRacePositions()).toBeNull();
    });

    it("delegates to the injected provider", () => {
      controller.setLivePositionsProvider(() => [1, 2, 3]);

      expect(controller.getLiveRacePositions()).toEqual([1, 2, 3]);
    });

    it("returns null again after the provider is cleared", () => {
      controller.setLivePositionsProvider(() => [1]);
      controller.setLivePositionsProvider(null);

      expect(controller.getLiveRacePositions()).toBeNull();
    });

    it("feeds the injected live order into the template context", () => {
      const sessionInfo = {
        DriverInfo: {
          DriverCarIdx: 0,
          Drivers: [
            {
              CarIdx: 0,
              UserName: "Player",
              AbbrevName: "P",
              CarNumber: "1",
              IRating: 3000,
              LicString: "A 4.99",
              IsSpectator: 0,
              CarIsPaceCar: 0,
            },
            {
              CarIdx: 1,
              UserName: "Other",
              AbbrevName: "O",
              CarNumber: "2",
              IRating: 3000,
              LicString: "A 4.99",
              IsSpectator: 0,
              CarIsPaceCar: 0,
            },
          ],
        },
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
      };
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({
        SessionNum: 0,
        CarIdxPosition: [5, 6], // stale official standings
        CarIdxLapCompleted: [4, 5],
        CarIdxLapDistPct: [0.5, 0.7],
        CarIdxOnPitRoad: [false, false],
      } as unknown as TelemetryData);
      vi.mocked(mockSdk.getSessionInfo).mockReturnValue(sessionInfo as never);

      // Injected order says the player is P1, the other car P2 — overriding both
      // the lap-calculated order and the stale official CarIdxPosition.
      controller.setLivePositionsProvider(() => [1, 2]);

      const ctx = controller.getCurrentTemplateContext();

      expect(ctx!.display["self.position"]).toBe("1");
      expect(ctx!.display["race_behind.name"]).toBe("Other");
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
