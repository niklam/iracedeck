import type { TelemetryCallback, TelemetryData } from "@iracedeck/iracing-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MockSDKController } from "./mock-sdk-controller.js";

describe("MockSDKController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("subscribe / unsubscribe", () => {
    it("immediately invokes the callback with current state on subscribe", () => {
      const controller = new MockSDKController();
      const callback = vi.fn();

      controller.subscribe("test", callback);

      expect(callback).toHaveBeenCalledTimes(1);
      // Default state is disconnected, so telemetry is null.
      expect(callback).toHaveBeenCalledWith(null, false);
    });

    it("delivers the current telemetry when already connected", () => {
      const controller = new MockSDKController();
      controller.setConnected(true);

      const callback = vi.fn();
      controller.subscribe("test", callback);

      const args = callback.mock.calls[0];
      expect(args?.[1]).toBe(true);
      expect(args?.[0]).toBeTruthy();
    });

    it("stops receiving ticks after unsubscribe", () => {
      const controller = new MockSDKController();
      const callback = vi.fn();
      controller.subscribe("test", callback);
      callback.mockClear();
      controller.unsubscribe("test");

      controller.setConnected(true);
      controller.tickOnce();

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("connection state", () => {
    it("notifies subscribers when toggling connected", () => {
      const controller = new MockSDKController();
      const callback = vi.fn();
      controller.subscribe("test", callback);
      callback.mockClear();

      controller.setConnected(true);

      expect(callback).toHaveBeenCalledTimes(1);
      const args = callback.mock.calls[0]!;
      expect(args[1]).toBe(true);
      expect(args[0]).not.toBeNull();
    });

    it("delivers null telemetry on disconnect", () => {
      const controller = new MockSDKController();
      controller.setConnected(true);
      const callback = vi.fn();
      controller.subscribe("test", callback);
      callback.mockClear();

      controller.setConnected(false);

      const args = callback.mock.calls[0];
      expect(args).toEqual([null, false]);
    });

    it("is a no-op when toggling to the current state", () => {
      const controller = new MockSDKController();
      const callback = vi.fn();
      controller.subscribe("test", callback);
      callback.mockClear();

      controller.setConnected(false);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("telemetry mutation", () => {
    it("setTelemetry replaces the snapshot", () => {
      const controller = new MockSDKController();
      controller.setConnected(true);

      const newTelemetry = { OnPitRoad: true } as unknown as TelemetryData;
      controller.setTelemetry(newTelemetry);

      controller.tickOnce();
      const callback = vi.fn();
      controller.subscribe("test", callback);

      expect(callback).toHaveBeenCalledWith(newTelemetry, true);
    });

    it("mutateTelemetry merges a partial snapshot", () => {
      const controller = new MockSDKController();
      controller.setConnected(true);

      controller.mutateTelemetry({ OnPitRoad: true } as Partial<TelemetryData>);

      const callback = vi.fn();
      controller.subscribe("test", callback);

      const tick = callback.mock.calls[0]![0] as TelemetryData;
      expect(tick.OnPitRoad).toBe(true);
      // Untouched defaults remain.
      expect(tick.IsOnTrack).toBe(false);
    });
  });

  describe("session info", () => {
    it("returns null by default", () => {
      const controller = new MockSDKController();
      expect(controller.getSessionInfo()).toBeNull();
    });

    it("returns the value set via setSessionInfo", () => {
      const controller = new MockSDKController();
      const info = { SessionInfo: { Sessions: [{ SessionType: "Race" }] } };
      controller.setSessionInfo(info as never);

      expect(controller.getSessionInfo()).toEqual(info);
    });
  });

  describe("tick loop", () => {
    it("fans out to all subscribers on tickOnce", () => {
      const controller = new MockSDKController();
      controller.setConnected(true);
      const a = vi.fn();
      const b = vi.fn();
      controller.subscribe("a", a);
      controller.subscribe("b", b);
      a.mockClear();
      b.mockClear();

      controller.tickOnce();

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it("auto-ticks at the configured interval after start", () => {
      vi.useFakeTimers();
      const controller = new MockSDKController({ tickIntervalMs: 100 });
      controller.setConnected(true);
      const callback = vi.fn();
      controller.subscribe("test", callback);
      callback.mockClear();

      controller.start();
      vi.advanceTimersByTime(350);

      expect(callback.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("stops ticking after stop()", () => {
      vi.useFakeTimers();
      const controller = new MockSDKController({ tickIntervalMs: 100 });
      controller.setConnected(true);
      const callback = vi.fn();
      controller.subscribe("test", callback);
      controller.start();
      vi.advanceTimersByTime(150);
      callback.mockClear();

      controller.stop();
      vi.advanceTimersByTime(500);

      expect(callback).not.toHaveBeenCalled();
    });

    it("setTickInterval restarts the timer with the new cadence", () => {
      vi.useFakeTimers();
      const controller = new MockSDKController({ tickIntervalMs: 1000 });
      controller.setConnected(true);
      controller.start();

      const callback = vi.fn();
      controller.subscribe("test", callback);
      callback.mockClear();

      controller.setTickInterval(50);
      vi.advanceTimersByTime(160);

      expect(callback.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("start(intervalMs) while already running updates the running cadence", () => {
      vi.useFakeTimers();
      const controller = new MockSDKController({ tickIntervalMs: 1000 });
      controller.setConnected(true);
      controller.start();
      const callback = vi.fn();
      controller.subscribe("test", callback);
      callback.mockClear();

      // Pre-fix: this only updated the recorded interval; the timer kept
      // firing at 1000 ms. Post-fix: routed through setTickInterval and
      // the timer rearms at 50 ms.
      controller.start(50);
      vi.advanceTimersByTime(160);

      expect(callback.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(controller.getState().tickIntervalMs).toBe(50);
    });
  });

  describe("state listener", () => {
    it("fires on connection / mutation / start-stop", () => {
      const controller = new MockSDKController();
      const listener = vi.fn();
      controller.onStateChange(listener);

      controller.setConnected(true);
      controller.mutateTelemetry({ OnPitRoad: true } as Partial<TelemetryData>);
      controller.start(100);
      controller.stop();

      expect(listener).toHaveBeenCalledTimes(4);
    });

    it("isolates listener errors", () => {
      const controller = new MockSDKController();
      controller.onStateChange(() => {
        throw new Error("listener boom");
      });

      expect(() => controller.setConnected(true)).not.toThrow();
    });

    it("returns an unsubscribe function", () => {
      const controller = new MockSDKController();
      const listener = vi.fn();
      const unsubscribe = controller.onStateChange(listener);
      controller.setConnected(true);
      listener.mockClear();
      unsubscribe();
      controller.setConnected(false);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("translator interop shape", () => {
    it("matches the structural surface initializeSimEventsIracing reads", () => {
      // Smoke check: cast through unknown like the existing translator tests do
      // and confirm the methods we expose are the methods the translator calls.
      const controller = new MockSDKController() as unknown as {
        subscribe: (id: string, cb: TelemetryCallback) => void;
        unsubscribe: (id: string) => void;
        getSessionInfo: () => unknown;
      };
      expect(typeof controller.subscribe).toBe("function");
      expect(typeof controller.unsubscribe).toBe("function");
      expect(typeof controller.getSessionInfo).toBe("function");
    });
  });
});
