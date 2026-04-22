import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getGlobalSettings } from "./global-settings.js";
import {
  _resetSimHub,
  getSimHub,
  initializeSimHub,
  isSimHubInitialized,
  isSimHubReachable,
  onSimHubReachabilityChange,
} from "./simhub-service.js";

// Mock global-settings before importing
vi.mock("./global-settings.js", () => ({
  getGlobalSettings: vi.fn(() => ({
    simHubHost: "127.0.0.1",
    simHubPort: 8888,
  })),
}));

const mockGetGlobalSettings = vi.mocked(getGlobalSettings);

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withLevel: vi.fn(),
  createScope: vi.fn(),
};

describe("SimHub Service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetSimHub();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));
    mockGetGlobalSettings.mockReturnValue({
      simHubHost: "127.0.0.1",
      simHubPort: 8888,
      disableWhenDisconnected: true,
      focusIRacingWindow: false,
      enableFuelingOnChange: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("initialization", () => {
    it("should initialize successfully", () => {
      const service = initializeSimHub(mockLogger);
      expect(service).toBeDefined();
      expect(isSimHubInitialized()).toBe(true);
    });

    it("should throw if initialized twice", () => {
      initializeSimHub(mockLogger);
      expect(() => initializeSimHub(mockLogger)).toThrow("already initialized");
    });

    it("should report not initialized before init", () => {
      expect(isSimHubInitialized()).toBe(false);
    });

    it("should reset correctly", () => {
      initializeSimHub(mockLogger);
      expect(isSimHubInitialized()).toBe(true);
      _resetSimHub();
      expect(isSimHubInitialized()).toBe(false);
    });
  });

  describe("getSimHub", () => {
    it("should throw if not initialized", () => {
      expect(() => getSimHub()).toThrow("not initialized");
    });

    it("should return the service after initialization", () => {
      initializeSimHub(mockLogger);
      expect(getSimHub()).toBeDefined();
    });
  });

  describe("startRole", () => {
    it("should POST to StartRole endpoint with correct body", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);

      initializeSimHub(mockLogger);
      const result = await getSimHub().startRole("TestRole");

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8888/api/ControlMapper/StartRole/",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "ownerId=iRaceDeck&roleName=TestRole",
        }),
      );
    });

    it("should return false on non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

      initializeSimHub(mockLogger);
      const result = await getSimHub().startRole("BadRole");

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("should return false on network error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      initializeSimHub(mockLogger);
      const result = await getSimHub().startRole("TestRole");

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("should use custom host and port from global settings", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);
      mockGetGlobalSettings.mockReturnValue({
        simHubHost: "192.168.1.100",
        simHubPort: 9999,
        disableWhenDisconnected: true,
        focusIRacingWindow: false,
        enableFuelingOnChange: true,
      });

      initializeSimHub(mockLogger);
      await getSimHub().startRole("TestRole");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://192.168.1.100:9999/api/ControlMapper/StartRole/",
        expect.anything(),
      );
    });
  });

  describe("stopRole", () => {
    it("should POST to StopRole endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);

      initializeSimHub(mockLogger);
      const result = await getSimHub().stopRole("TestRole");

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8888/api/ControlMapper/StopRole/",
        expect.objectContaining({
          method: "POST",
          body: "ownerId=iRaceDeck&roleName=TestRole",
        }),
      );
    });

    it("should return false on error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

      initializeSimHub(mockLogger);
      const result = await getSimHub().stopRole("TestRole");

      expect(result).toBe(false);
    });
  });

  describe("getRoles", () => {
    it("should GET roles from SimHub", async () => {
      const roles = ["Role1", "Role2", "Role3"];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(roles),
        }),
      );

      initializeSimHub(mockLogger);
      const result = await getSimHub().getRoles();

      expect(result).toEqual(roles);
    });

    it("should return empty array on non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

      initializeSimHub(mockLogger);
      const result = await getSimHub().getRoles();

      expect(result).toEqual([]);
    });

    it("should return empty array on network error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      initializeSimHub(mockLogger);
      const result = await getSimHub().getRoles();

      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe("URL-encodes role names", () => {
    it("should handle role names with special characters", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);

      initializeSimHub(mockLogger);
      await getSimHub().startRole("My Role & More");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: "ownerId=iRaceDeck&roleName=My+Role+%26+More",
        }),
      );
    });
  });

  describe("reachability", () => {
    it("should be unreachable before initialization", () => {
      expect(isSimHubReachable()).toBe(false);
    });

    it("should become reachable after successful health check", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));

      initializeSimHub(mockLogger);
      // Let the initial health check complete
      await vi.advanceTimersByTimeAsync(0);

      expect(isSimHubReachable()).toBe(true);
    });

    it("should become unreachable when health check fails", async () => {
      // Start reachable
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));
      initializeSimHub(mockLogger);
      await vi.advanceTimersByTimeAsync(0);
      expect(isSimHubReachable()).toBe(true);

      // SimHub goes down
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      await vi.advanceTimersByTimeAsync(5000);

      expect(isSimHubReachable()).toBe(false);
    });

    it("should update reachability on successful startRole", async () => {
      // Start unreachable
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      initializeSimHub(mockLogger);
      await vi.advanceTimersByTimeAsync(0);
      expect(isSimHubReachable()).toBe(false);

      // startRole succeeds
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
      await getSimHub().startRole("TestRole");

      expect(isSimHubReachable()).toBe(true);
    });

    it("should update reachability on failed startRole", async () => {
      // Start reachable
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));
      initializeSimHub(mockLogger);
      await vi.advanceTimersByTimeAsync(0);
      expect(isSimHubReachable()).toBe(true);

      // startRole fails
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      await getSimHub().startRole("TestRole");

      expect(isSimHubReachable()).toBe(false);
    });

    it("should become unreachable after reset", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));
      initializeSimHub(mockLogger);
      await vi.advanceTimersByTimeAsync(0);
      expect(isSimHubReachable()).toBe(true);

      _resetSimHub();
      expect(isSimHubReachable()).toBe(false);
    });
  });

  describe("onSimHubReachabilityChange", () => {
    it("should call listener on reachability transition (false→true)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));

      const listener = vi.fn();
      onSimHubReachabilityChange(listener);

      initializeSimHub(mockLogger);
      // Initial health check succeeds — transitions from false to true
      await vi.advanceTimersByTimeAsync(0);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(true);
    });

    it("should call listener on reachability transition (true→false)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));

      const listener = vi.fn();
      onSimHubReachabilityChange(listener);

      initializeSimHub(mockLogger);
      await vi.advanceTimersByTimeAsync(0);
      expect(isSimHubReachable()).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);

      // SimHub goes down
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      await vi.advanceTimersByTimeAsync(5000);

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenLastCalledWith(false);
    });

    it("should NOT call listener when reachability stays the same", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));

      const listener = vi.fn();
      onSimHubReachabilityChange(listener);

      initializeSimHub(mockLogger);
      // First health check — transitions false→true
      await vi.advanceTimersByTimeAsync(0);
      expect(listener).toHaveBeenCalledTimes(1);

      // Second health check — still reachable, no transition
      await vi.advanceTimersByTimeAsync(5000);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("should not call listener after unsubscribe", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));

      const listener = vi.fn();
      const unsubscribe = onSimHubReachabilityChange(listener);

      // Unsubscribe before any transition
      unsubscribe();

      initializeSimHub(mockLogger);
      await vi.advanceTimersByTimeAsync(0);

      expect(listener).not.toHaveBeenCalled();
    });

    it("should not call old listeners after _resetSimHub clears them", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));

      const listener = vi.fn();
      onSimHubReachabilityChange(listener);

      initializeSimHub(mockLogger);
      await vi.advanceTimersByTimeAsync(0);
      expect(listener).toHaveBeenCalledTimes(1);

      // Reset clears all listeners
      _resetSimHub();
      listener.mockClear();

      // Re-initialize — old listener should NOT be called
      initializeSimHub(mockLogger);
      await vi.advanceTimersByTimeAsync(0);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("default host/port fallback", () => {
    it("should use 127.0.0.1:8888 when global settings are empty", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);
      mockGetGlobalSettings.mockReturnValue({} as ReturnType<typeof getGlobalSettings>);

      initializeSimHub(mockLogger);
      await getSimHub().startRole("test");

      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("127.0.0.1:8888"), expect.anything());
    });
  });

  describe("health check timer disposal", () => {
    it("should not make fetch calls after _resetSimHub", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));

      initializeSimHub(mockLogger);
      await vi.advanceTimersByTimeAsync(0);

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
      vi.stubGlobal("fetch", mockFetch);

      _resetSimHub();
      mockFetch.mockClear();

      // Advance well past multiple health check intervals
      await vi.advanceTimersByTimeAsync(10000);

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
