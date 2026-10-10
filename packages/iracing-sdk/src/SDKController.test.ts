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
      expect(ctx!.display("telemetry.Speed")).toBe("100");
    });

    it("should include raw values in the returned context", () => {
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 156.789, Gear: 3 });
      vi.mocked(mockSdk.getSessionInfo).mockReturnValue(null);

      const ctx = controller.getCurrentTemplateContext();

      expect(ctx).not.toBeNull();
      expect(ctx!.raw("telemetry.Speed").value).toBe(156.789);
      expect(typeof ctx!.raw("telemetry.Speed").value).toBe("number");
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
      expect(ctx2!.display("telemetry.Speed")).toBe("200");
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
      expect(ctxBefore!.display("telemetry.Speed")).toBe("100");

      // After new telemetry, context should be rebuilt (not the same object)
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 300 });
      vi.advanceTimersByTime(250);

      const ctxAfter = controller.getCurrentTemplateContext();
      expect(ctxAfter).not.toBe(ctxBefore);
      expect(ctxAfter!.display("telemetry.Speed")).toBe("300");
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
        CarIdxPosition: [5, 6], // stale official standings — must be overridden
      } as unknown as TelemetryData);
      vi.mocked(mockSdk.getSessionInfo).mockReturnValue(sessionInfo as never);

      // Injected canonical order says the player is P1, the other car P2 —
      // overriding the stale official CarIdxPosition.
      controller.setLivePositionsProvider(() => [1, 2]);

      const ctx = controller.getCurrentTemplateContext();

      expect(ctx!.display("self.position")).toBe("1");
      expect(ctx!.display("race_behind.name")).toBe("Other");
    });

    it("asks the provider only when a driver variable is read, once per context (#1339)", () => {
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 100, SessionNum: 0 } as unknown as TelemetryData);
      vi.mocked(mockSdk.getSessionInfo).mockReturnValue(null);
      const provider = vi.fn(() => [1]);
      controller.setLivePositionsProvider(provider);

      const ctx = controller.getCurrentTemplateContext();

      expect(ctx!.display("telemetry.Speed")).toBe("100");
      expect(provider).not.toHaveBeenCalled();

      ctx!.display("self.position");
      ctx!.display("race_ahead.name");

      expect(provider).toHaveBeenCalledTimes(1);
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

  describe("replay state (#1324)", () => {
    const replayTick = (tick: number, frame: number): TelemetryData =>
      ({ SessionTick: tick, IsReplayPlaying: true, ReplayFrameNum: frame, ReplayFrameNumEnd: 100 }) as TelemetryData;
    const liveTick = (tick: number, end: number): TelemetryData =>
      ({ SessionTick: tick, IsReplayPlaying: false, ReplayFrameNum: 0, ReplayFrameNumEnd: end }) as TelemetryData;

    /** Subscribes on a live tick and runs the first poll, so each test starts live with the bookkeeping notifications behind it. */
    function subscribeLive(callback?: TelemetryCallback): void {
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(liveTick(1, 900));
      controller.subscribe("test", callback ?? vi.fn());
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);
    }

    it("starts live before any tick", () => {
      expect(controller.getReplayState()).toMatchObject({ inReplay: false, frame: null });
    });

    it("is updated before subscribers are notified, so a callback reads its own tick", () => {
      const seen: { inReplay: boolean; frame: number | null }[] = [];
      subscribeLive(() => {
        const { inReplay, frame } = controller.getReplayState();
        seen.push({ inReplay, frame });
      });
      seen.length = 0;

      vi.mocked(mockSdk.getTelemetry).mockReturnValue(replayTick(2, 500));
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

      expect(seen).toEqual([{ inReplay: true, frame: 500 }]);
    });

    it("steps on a poll the SessionTick dedupe drops, so the flag's return on a repeated tick keeps a paused replay open", () => {
      const callback = vi.fn();
      subscribeLive(callback);
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(replayTick(2, 500));
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

      // The blip after a seek, then the flag back on the SAME SessionTick: a
      // paused replay does not advance the tick, so the dedupe drops the poll.
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(liveTick(3, 900));
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);
      callback.mockClear();
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(replayTick(3, 500));
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS * 110);

      // Dropped by the dedupe: no subscriber heard it — yet the state read it.
      expect(callback).not.toHaveBeenCalled();
      expect(controller.getReplayState()).toMatchObject({ inReplay: true, frame: 500 });
    });

    it("does not step on the re-delivery of the last valid telemetry, so a null read cannot stretch the grace", () => {
      subscribeLive();
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(replayTick(2, 500));
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

      // The SDK reads null for longer than the grace; each poll re-delivers
      // the replay tick above. Stepping those would re-stamp its sighting.
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(null);
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS * 150);

      vi.mocked(mockSdk.getTelemetry).mockReturnValue(liveTick(3, 900));
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

      expect(controller.getReplayState()).toMatchObject({ inReplay: false, frame: 900 });
    });

    it("holds the replay through the blip after a seek and lets a read between ticks see the grace expire", () => {
      subscribeLive();
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(replayTick(2, 500));
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);
      const seenAt = Date.now();

      vi.mocked(mockSdk.getTelemetry).mockReturnValue(liveTick(3, 900));
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

      expect(controller.getReplayState()).toMatchObject({ inReplay: true, frame: 500 });
      expect(controller.getReplayState(seenAt + 999)).toMatchObject({ inReplay: true, frame: 500 });
      expect(controller.getReplayState(seenAt + 1_000)).toMatchObject({ inReplay: false, frame: 900 });
    });

    it("reads the saved-replay discriminator from the SDK's session info", () => {
      vi.mocked(mockSdk.getSessionInfo).mockReturnValue({ WeekendInfo: { SimMode: "replay" } });
      subscribeLive();

      expect(controller.getReplayState().inReplay).toBe(true);
    });

    it("noteReplayLeftForLive drops the grace outside a saved replay", () => {
      subscribeLive();
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(replayTick(2, 500));
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

      controller.noteReplayLeftForLive();

      vi.mocked(mockSdk.getTelemetry).mockReturnValue(liveTick(3, 900));
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

      expect(controller.getReplayState()).toMatchObject({ inReplay: false, frame: 900 });
    });

    it("noteReplayLeftForLive does nothing in a saved replay", () => {
      vi.mocked(mockSdk.getSessionInfo).mockReturnValue({ WeekendInfo: { SimMode: "replay" } });
      subscribeLive();
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(replayTick(2, 500));
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

      controller.noteReplayLeftForLive();

      vi.mocked(mockSdk.getTelemetry).mockReturnValue(liveTick(3, 900));
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

      expect(controller.getReplayState()).toMatchObject({ inReplay: true, frame: 500 });
    });

    it("resets on a disconnect noticed by the reconnect poll, so no grace outlives the connection", () => {
      subscribeLive();
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(replayTick(2, 500));
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);
      expect(controller.getReplayState().inReplay).toBe(true);

      // The update loop skips update() while the SDK reads disconnected; the
      // 2 s reconnect poll's tryConnect is what flips the controller.
      vi.mocked(mockSdk.isConnected).mockReturnValue(false);
      vi.mocked(mockSdk.connect).mockReturnValue(false);
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(null);
      vi.advanceTimersByTime(2000);

      // Without the reset the last tick, a replay one, would still answer.
      expect(controller.getConnectionStatus()).toBe(false);
      expect(controller.getReplayState()).toMatchObject({ inReplay: false, frame: null });
    });

    it("resets on a disconnect seen inside update()", () => {
      subscribeLive();
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(replayTick(2, 500));
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

      // The loop's guard reads connected once more; update()'s own check then reads the drop.
      vi.mocked(mockSdk.isConnected).mockReturnValueOnce(true).mockReturnValue(false);
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(null);
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

      // Read at once: without the reset the sighting 10 ms ago would hold it.
      expect(controller.getConnectionStatus()).toBe(false);
      expect(controller.getReplayState()).toMatchObject({ inReplay: false, frame: null });
    });

    it("resets when reconnection is disabled (iRacing terminated)", () => {
      subscribeLive();
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(replayTick(2, 500));
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

      vi.mocked(mockSdk.getTelemetry).mockReturnValue(null);
      controller.setReconnectEnabled(false);

      expect(controller.getReplayState()).toMatchObject({ inReplay: false, frame: null });
    });

    it("resets when the last subscriber leaves and the loops stop", () => {
      subscribeLive();
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(replayTick(2, 500));
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

      controller.unsubscribe("test");

      expect(controller.getReplayState()).toMatchObject({ inReplay: false, frame: null });
    });

    it("starts live again after a reconnect", () => {
      subscribeLive();
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(replayTick(2, 500));
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

      vi.mocked(mockSdk.isConnected).mockReturnValueOnce(true).mockReturnValue(false);
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(null);
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);
      expect(controller.getConnectionStatus()).toBe(false);

      vi.mocked(mockSdk.isConnected).mockReturnValue(true);
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(liveTick(3, 950));
      vi.advanceTimersByTime(2000);

      expect(controller.getConnectionStatus()).toBe(true);
      expect(controller.getReplayState()).toMatchObject({ inReplay: false, frame: 950 });
    });
  });
});
