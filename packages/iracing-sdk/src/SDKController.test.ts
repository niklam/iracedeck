import type { ILogger } from "@iracedeck/logger";
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

interface LogLine {
  level: "trace" | "debug" | "info" | "warn" | "error";
  message: string;
}

/** A logger that records every line, so a test can assert what the reporter wrote. */
function createRecordingLogger(): { logger: ILogger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const record =
    (level: LogLine["level"]) =>
    (message: string): void => {
      lines.push({ level, message });
    };
  const logger: ILogger = {
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    withLevel: () => logger,
    createScope: () => logger,
  };

  return { logger, lines };
}

/** The reporter's lines: everything the controller's own `[SDKController]` status lines are not. */
function reporterLines(lines: LogLine[]): LogLine[] {
  return lines.filter((line) => !line.message.startsWith("[SDKController]"));
}

describe("SDKController subscriber isolation (#1558)", () => {
  let mockSdk: IRacingSDK;
  let lines: LogLine[];
  let controller: SDKController;
  /** The order subscribers were called in since the last clear. */
  let calls: string[];

  /** A subscriber that records its name, and throws while `throws()` says so. */
  function subscriber(name: string, throws: () => boolean = () => false) {
    return vi.fn<TelemetryCallback>(() => {
      calls.push(name);

      if (throws()) throw new Error(`${name} failed`);
    });
  }

  /** Subscribes `a`, `b` (always throwing) and `c`, then clears the record. */
  function subscribeThree(): { a: ReturnType<typeof subscriber>; c: ReturnType<typeof subscriber> } {
    const a = subscriber("a");
    const c = subscriber("c");
    controller.subscribe("a", a);
    controller.subscribe(
      "b",
      subscriber("b", () => true),
    );
    controller.subscribe("c", c);
    calls.length = 0;

    return { a, c };
  }

  /** Asserts `b`'s throw was reported once, under `b`, and never under a `controller:` id. */
  function expectReportedOnlyUnderB(): void {
    const reported = reporterLines(lines);

    expect(reported.filter((line) => line.level === "error")).toHaveLength(1);
    expect(reported[0]).toMatchObject({ level: "error" });
    expect(reported[0].message).toMatch(/^b threw: Error: b failed\n\s+at /);
    expect(reported.some((line) => line.message.startsWith("controller:"))).toBe(false);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mockSdk = createMockSDK();
    const recording = createRecordingLogger();
    lines = recording.lines;
    controller = new SDKController(mockSdk, recording.logger);
    calls = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("a throwing middle subscriber does not stop the others, on every entry point", () => {
    it("subscribe's immediate first notification: subscribing a throwing callback throws nothing, and later subscribers still subscribe", () => {
      const a = subscriber("a");
      const c = subscriber("c");
      controller.subscribe("a", a);

      expect(() =>
        controller.subscribe(
          "b",
          subscriber("b", () => true),
        ),
      ).not.toThrow();
      controller.subscribe("c", c);

      // b's own first notification ran (and threw), then c subscribed and got its own.
      expect(calls).toEqual(["a", "a", "b", "c"]);
      expect(c).toHaveBeenCalledTimes(1);
      expectReportedOnlyUnderB();
    });

    it("the connect from the reconnect interval", () => {
      vi.mocked(mockSdk.connect).mockReturnValue(false);
      vi.mocked(mockSdk.isConnected).mockReturnValue(false);
      const { a, c } = subscribeThree();

      vi.mocked(mockSdk.connect).mockReturnValue(true);
      expect(() => vi.advanceTimersByTime(2000)).not.toThrow();

      expect(calls).toEqual(["a", "b", "c"]);
      expect(a).toHaveBeenLastCalledWith(expect.anything(), true);
      expect(c).toHaveBeenLastCalledWith(expect.anything(), true);
      expectReportedOnlyUnderB();
    });

    it("the connect from setReconnectEnabled(true)", () => {
      vi.mocked(mockSdk.connect).mockReturnValue(false);
      vi.mocked(mockSdk.isConnected).mockReturnValue(false);
      const { c } = subscribeThree();
      controller.setReconnectEnabled(false);

      vi.mocked(mockSdk.connect).mockReturnValue(true);
      expect(() => controller.setReconnectEnabled(true)).not.toThrow();

      expect(calls).toEqual(["a", "b", "c"]);
      expect(c).toHaveBeenLastCalledWith(expect.anything(), true);
      expectReportedOnlyUnderB();
    });

    it("update()'s disconnect fan-out", () => {
      const { a, c } = subscribeThree();

      // The loop's guard reads connected once more; update()'s own check then reads the drop.
      vi.mocked(mockSdk.isConnected).mockReturnValueOnce(true).mockReturnValue(false);
      expect(() => vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS)).not.toThrow();

      expect(calls).toEqual(["a", "b", "c"]);
      expect(a).toHaveBeenLastCalledWith(null, false);
      expect(c).toHaveBeenLastCalledWith(null, false);
      expectReportedOnlyUnderB();
    });

    it("the re-delivery of lastValidTelemetry", () => {
      const valid = { Speed: 100, SessionTick: 1 } as TelemetryData;
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(valid);
      const { a, c } = subscribeThree();
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);
      calls.length = 0;

      vi.mocked(mockSdk.getTelemetry).mockReturnValue(null);
      expect(() => vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS)).not.toThrow();

      expect(calls).toEqual(["a", "b", "c"]);
      expect(a).toHaveBeenLastCalledWith(valid, true);
      expect(c).toHaveBeenLastCalledWith(valid, true);
      expectReportedOnlyUnderB();
    });

    it("the normal tick", () => {
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ SessionTick: 1 } as TelemetryData);
      const { c } = subscribeThree();

      const tick = { Speed: 120, SessionTick: 2 } as TelemetryData;
      vi.mocked(mockSdk.getTelemetry).mockReturnValue(tick);
      expect(() => vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS)).not.toThrow();

      expect(calls).toEqual(["a", "b", "c"]);
      expect(c).toHaveBeenLastCalledWith(tick, true);
      expectReportedOnlyUnderB();
    });

    it("setReconnectEnabled(false)'s disconnect fan-out", () => {
      const { a, c } = subscribeThree();

      expect(() => controller.setReconnectEnabled(false)).not.toThrow();

      expect(calls).toEqual(["a", "b", "c"]);
      expect(a).toHaveBeenLastCalledWith(null, false);
      expect(c).toHaveBeenLastCalledWith(null, false);
      expect(controller.getConnectionStatus()).toBe(false);
      expectReportedOnlyUnderB();
    });

    it("keeps calling the failing subscriber on later ticks: it stays subscribed", () => {
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 100 } as TelemetryData);
      subscribeThree();

      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS * 3);

      expect(calls).toEqual(["a", "b", "c", "a", "b", "c", "a", "b", "c"]);
      // Repeats are counted, not logged: still the one error line.
      expectReportedOnlyUnderB();
    });
  });

  describe("start()", () => {
    it("creates both intervals even when the first subscriber throws on the connect-time delivery, and the next poll runs", () => {
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ SessionTick: 1 } as TelemetryData);
      let first = true;
      const callback = vi.fn<TelemetryCallback>(() => {
        if (first) {
          first = false;
          throw new Error("connect-time delivery failed");
        }
      });

      expect(() => controller.subscribe("first", callback)).not.toThrow();

      // The connect-time delivery (threw) and subscribe's own first notification.
      expect(callback).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(2);

      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ SessionTick: 2 } as TelemetryData);
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

      expect(callback).toHaveBeenCalledTimes(3);
      expect(reporterLines(lines)[0].message).toMatch(/^first threw: Error: connect-time delivery failed\n/);
    });

    it("leaves no interval running when the only subscriber unsubscribes during the connect-time delivery", () => {
      let left = false;
      controller.subscribe("leaver", () => {
        if (left) return;

        left = true;
        controller.unsubscribe("leaver");
      });

      // The intervals existed before the delivery, so the unsubscribe's stop()
      // cleared them. Created after it, they would poll with no subscriber.
      expect(vi.getTimerCount()).toBe(0);
      expect(mockSdk.disconnect).toHaveBeenCalledOnce();
    });

    it("reports a throwing first connect as controller:reconnect and lets the reconnect poll retry it", () => {
      vi.mocked(mockSdk.connect).mockImplementationOnce(() => {
        throw new Error("connect failed");
      });
      vi.mocked(mockSdk.isConnected).mockReturnValue(false);
      const callback = vi.fn<TelemetryCallback>();

      expect(() => controller.subscribe("test", callback)).not.toThrow();

      expect(vi.getTimerCount()).toBe(2);
      expect(callback).toHaveBeenCalledWith(expect.anything(), false);
      expect(reporterLines(lines)[0].message).toMatch(/^controller:reconnect threw: Error: connect failed\n/);

      vi.advanceTimersByTime(2000);

      expect(mockSdk.connect).toHaveBeenCalledTimes(2);
      expect(controller.getConnectionStatus()).toBe(true);
      expect(callback).toHaveBeenLastCalledWith(expect.anything(), true);
    });
  });

  describe("the controller's own failures", () => {
    it("reports a throw from update() as controller:update, and the next interval still runs", () => {
      const callback = vi.fn<TelemetryCallback>();
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ SessionTick: 1 } as TelemetryData);
      controller.subscribe("test", callback);
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);
      callback.mockClear();

      vi.mocked(mockSdk.getTelemetry).mockImplementationOnce(() => {
        throw new Error("read failed");
      });
      expect(() => vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS)).not.toThrow();

      const reported = reporterLines(lines);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatchObject({ level: "error" });
      expect(reported[0].message).toMatch(/^controller:update threw: Error: read failed\n\s+at /);
      expect(callback).not.toHaveBeenCalled();

      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ SessionTick: 2 } as TelemetryData);
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("reports a throwing connect on setReconnectEnabled(true) as controller:reconnect, throwing nothing", () => {
      vi.mocked(mockSdk.connect).mockReturnValue(false);
      vi.mocked(mockSdk.isConnected).mockReturnValue(false);
      controller.subscribe("test", vi.fn());
      controller.setReconnectEnabled(false);

      vi.mocked(mockSdk.connect).mockImplementationOnce(() => {
        throw new Error("connect failed");
      });

      expect(() => controller.setReconnectEnabled(true)).not.toThrow();
      expect(reporterLines(lines)[0].message).toMatch(/^controller:reconnect threw: Error: connect failed\n/);
    });

    it("reports a throwing disconnect on setReconnectEnabled(false) as controller:disconnect, throwing nothing", () => {
      controller.subscribe("test", vi.fn());
      vi.mocked(mockSdk.disconnect).mockImplementationOnce(() => {
        throw new Error("disconnect failed");
      });

      expect(() => controller.setReconnectEnabled(false)).not.toThrow();
      expect(reporterLines(lines)[0].message).toMatch(/^controller:disconnect threw: Error: disconnect failed\n/);
    });
  });

  describe("unsubscribe", () => {
    it("flushes a failing id's unreported count as one warn line and drops its keys", () => {
      // No SessionTick: every poll delivers.
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 100 } as TelemetryData);
      controller.subscribe("keep", vi.fn());
      controller.subscribe(
        "bad",
        subscriber("bad", () => true),
      );
      vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS * 5);

      controller.unsubscribe("bad");

      // The first throw (subscribe's notification) logged; the five polls' were counted.
      expect(reporterLines(lines)).toEqual([
        { level: "error", message: expect.stringMatching(/^bad threw: Error: bad failed\n/) },
        { level: "warn", message: "bad forgotten with 5 times not yet reported (6 times in all)" },
      ]);

      // Dropped: the same id failing again is a first occurrence, logged in full.
      controller.subscribe(
        "bad",
        subscriber("bad", () => true),
      );

      expect(reporterLines(lines).filter((line) => line.level === "error")).toHaveLength(2);
    });
  });

  describe("the error policy", () => {
    it('under "rethrow", calls every subscriber on a tick and then throws the first error', () => {
      const rethrowing = new SDKController(mockSdk, createRecordingLogger().logger, { onSubscriberError: "rethrow" });
      let failing = false;
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 100 } as TelemetryData);
      rethrowing.subscribe("a", subscriber("a"));
      rethrowing.subscribe(
        "b",
        subscriber("b", () => failing),
      );
      rethrowing.subscribe("c", subscriber("c"));
      rethrowing.subscribe(
        "d",
        subscriber("d", () => failing),
      );
      calls.length = 0;
      failing = true;

      expect(() => vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS)).toThrow("b failed");
      expect(calls).toEqual(["a", "b", "c", "d"]);
    });

    it('under "rethrow", throws a subscriber\'s error out of setReconnectEnabled(false) after every subscriber, and reports nothing', () => {
      const recording = createRecordingLogger();
      const rethrowing = new SDKController(mockSdk, recording.logger, { onSubscriberError: "rethrow" });
      let failing = false;
      rethrowing.subscribe("a", subscriber("a"));
      rethrowing.subscribe(
        "b",
        subscriber("b", () => failing),
      );
      rethrowing.subscribe("c", subscriber("c"));
      calls.length = 0;
      failing = true;

      expect(() => rethrowing.setReconnectEnabled(false)).toThrow("b failed");
      expect(calls).toEqual(["a", "b", "c"]);
      // Thrown, not reported, and never reported a second time as controller work.
      expect(reporterLines(recording.lines)).toEqual([]);
    });

    it('under "rethrow", throws out of subscribe after the new subscriber is in, and it stays subscribed', () => {
      const rethrowing = new SDKController(mockSdk, createRecordingLogger().logger, { onSubscriberError: "rethrow" });
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 100 } as TelemetryData);
      const failing = subscriber("failing", () => true);

      expect(() => rethrowing.subscribe("failing", failing)).toThrow("failing failed");
      // The connect-time delivery and subscribe's own notification both ran.
      expect(failing).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(2);

      expect(() => vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS)).toThrow("failing failed");
      expect(failing).toHaveBeenCalledTimes(3);
    });

    it('under "rethrow", throws the controller\'s own error out of the poll rather than reporting it', () => {
      const recording = createRecordingLogger();
      const rethrowing = new SDKController(mockSdk, recording.logger, { onSubscriberError: "rethrow" });
      rethrowing.subscribe("test", vi.fn());
      vi.mocked(mockSdk.getTelemetry).mockImplementationOnce(() => {
        throw new Error("read failed");
      });

      expect(() => vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS)).toThrow("read failed");
      expect(reporterLines(recording.lines)).toEqual([]);
    });

    it("by default, throws nothing from any entry point", () => {
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 100 } as TelemetryData);
      const failing = subscriber("failing", () => true);

      expect(() => controller.subscribe("failing", failing)).not.toThrow();
      expect(() => vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS * 10)).not.toThrow();
      expect(() => controller.setReconnectEnabled(false)).not.toThrow();
      vi.mocked(mockSdk.isConnected).mockReturnValue(false);
      expect(() => controller.setReconnectEnabled(true)).not.toThrow();
      expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
      expect(() => controller.unsubscribe("failing")).not.toThrow();
    });
  });

  describe("the log lines a throwing subscriber writes", () => {
    it("writes one error line, one warn summary a minute, and one info line on recovery", () => {
      // No SessionTick, so every 10 ms poll delivers: 100 deliveries a second.
      vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 100 } as TelemetryData);
      let failing = true;
      controller.subscribe("broken-action", () => {
        if (failing) throw new RangeError(`index ${Math.floor(Date.now() % 64)} out of range`);
      });

      // Ninety seconds of failing on every poll, then seventy of clean ticks.
      // The first throw is the connect-time delivery at t=0, then subscribe's
      // own notification, then one per poll from t=10 ms.
      vi.advanceTimersByTime(90_000);
      failing = false;
      vi.advanceTimersByTime(70_000);

      const reported = reporterLines(lines);
      expect(reported.map((line) => line.level)).toEqual(["error", "warn", "info"]);
      expect(reported[0].message).toMatch(/^broken-action threw: RangeError: index \d+ out of range\n\s+at /);
      // At t=60 s: subscribe's notification plus 6000 polls since the error line.
      expect(reported[1].message).toMatch(
        /^broken-action threw 6001 more times in the last 60s, latest at (?!at )\S.*: RangeError: index \d+ out of range$/,
      );
      // At t=150 s, 60 s after the last throw: 2 + 9000 polls in all.
      expect(reported[2].message).toBe("broken-action recovered: no errors for 60s, after 9002 times in all");
    });
  });
});
