import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetAppMonitor, initAppMonitor, isAppMonitorInitialized, isIRacingRunning } from "./app-monitor.js";
import { getController } from "./sdk-singleton.js";

// Mock the sdk-singleton module
const mockSetReconnectEnabled = vi.fn();
const mockGetConnectionStatus = vi.fn();

vi.mock("./sdk-singleton.js", () => ({
  getController: vi.fn(() => ({
    setReconnectEnabled: mockSetReconnectEnabled,
    getConnectionStatus: mockGetConnectionStatus,
  })),
}));

// Helper to create mock logger
function createMockLogger(): ILogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: vi.fn(() => createMockLogger()),
    createScope: vi.fn(() => createMockLogger()),
  };
}

// Helper to create mock Stream Deck SDK
function createMockStreamDeck() {
  const launchCallbacks: ((ev: { application: string }) => void)[] = [];
  const terminateCallbacks: ((ev: { application: string }) => void)[] = [];

  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    system: {
      onApplicationDidLaunch: vi.fn((cb) => {
        launchCallbacks.push(cb);
      }),
      onApplicationDidTerminate: vi.fn((cb) => {
        terminateCallbacks.push(cb);
      }),
    },
    // Helpers for testing
    _simulateLaunch: (app: string) => {
      launchCallbacks.forEach((cb) => cb({ application: app }));
    },
    _simulateTerminate: (app: string) => {
      terminateCallbacks.forEach((cb) => cb({ application: app }));
    },
  };
}

// Helper to reset mock to default behavior
function resetGetControllerMock() {
  vi.mocked(getController).mockImplementation(
    () =>
      ({
        setReconnectEnabled: mockSetReconnectEnabled,
        getConnectionStatus: mockGetConnectionStatus,
      }) as unknown as ReturnType<typeof getController>,
  );
}

describe("App Monitor", () => {
  let mockSD: ReturnType<typeof createMockStreamDeck>;

  beforeEach(() => {
    mockSD = createMockStreamDeck();
    mockSetReconnectEnabled.mockClear();
    mockGetConnectionStatus.mockClear();
    // Default to not connected
    mockGetConnectionStatus.mockReturnValue(false);
    // Reset getController to default behavior
    resetGetControllerMock();
  });

  afterEach(() => {
    _resetAppMonitor();
    vi.clearAllMocks();
  });

  describe("isAppMonitorInitialized", () => {
    it("should return false before initialization", () => {
      expect(isAppMonitorInitialized()).toBe(false);
    });

    it("should return true after initialization", () => {
      initAppMonitor(mockSD as never, createMockLogger());

      expect(isAppMonitorInitialized()).toBe(true);
    });
  });

  describe("isIRacingRunning", () => {
    it("should return false initially", () => {
      expect(isIRacingRunning()).toBe(false);
    });

    it("should return true after iRacing launches", () => {
      initAppMonitor(mockSD as never, createMockLogger());

      mockSD._simulateLaunch("iRacingSim64DX11.exe");

      expect(isIRacingRunning()).toBe(true);
    });

    it("should return false after iRacing terminates", () => {
      initAppMonitor(mockSD as never, createMockLogger());

      mockSD._simulateLaunch("iRacingSim64DX11.exe");
      mockSD._simulateTerminate("iRacingSim64DX11.exe");

      expect(isIRacingRunning()).toBe(false);
    });
  });

  describe("initAppMonitor", () => {
    it("should register event handlers", () => {
      initAppMonitor(mockSD as never, createMockLogger());

      expect(mockSD.system.onApplicationDidLaunch).toHaveBeenCalledOnce();
      expect(mockSD.system.onApplicationDidTerminate).toHaveBeenCalledOnce();
    });

    it("should disable reconnect initially when not connected", () => {
      mockGetConnectionStatus.mockReturnValue(false);

      initAppMonitor(mockSD as never, createMockLogger());

      expect(mockSetReconnectEnabled).toHaveBeenCalledWith(false);
    });

    it("should keep reconnect enabled when already connected (race condition fix)", () => {
      mockGetConnectionStatus.mockReturnValue(true);

      initAppMonitor(mockSD as never, createMockLogger());

      // Should NOT call setReconnectEnabled(false) when already connected
      expect(mockSetReconnectEnabled).not.toHaveBeenCalledWith(false);
      // iRacingRunning should be set to true
      expect(isIRacingRunning()).toBe(true);
    });

    it("should return early if called twice", () => {
      initAppMonitor(mockSD as never, createMockLogger());
      const secondLogger = createMockLogger();
      initAppMonitor(mockSD as never, secondLogger);

      // Second call should log at debug level and return early
      expect(secondLogger.debug).toHaveBeenCalledWith("Already initialized");
      // Event handlers should only be registered once
      expect(mockSD.system.onApplicationDidLaunch).toHaveBeenCalledOnce();
    });

    it("should throw if SDK is not initialized", () => {
      // Override mock to throw
      vi.mocked(getController).mockImplementation(() => {
        throw new Error("SDK not initialized");
      });

      expect(() => initAppMonitor(mockSD as never, createMockLogger())).toThrow(
        "initAppMonitor requires SDK to be initialized first",
      );

      // Reset mock for subsequent tests (also done in beforeEach, but be explicit)
      resetGetControllerMock();
    });
  });

  describe("event handling", () => {
    it("should enable reconnect when iRacing launches", () => {
      initAppMonitor(mockSD as never, createMockLogger());
      mockSetReconnectEnabled.mockClear();

      mockSD._simulateLaunch("iRacingSim64DX11.exe");

      expect(mockSetReconnectEnabled).toHaveBeenCalledWith(true);
      expect(isIRacingRunning()).toBe(true);
    });

    it("should disable reconnect when iRacing terminates", () => {
      initAppMonitor(mockSD as never, createMockLogger());
      mockSD._simulateLaunch("iRacingSim64DX11.exe");
      mockSetReconnectEnabled.mockClear();

      mockSD._simulateTerminate("iRacingSim64DX11.exe");

      expect(mockSetReconnectEnabled).toHaveBeenCalledWith(false);
      expect(isIRacingRunning()).toBe(false);
    });

    it("should handle case-insensitive executable name matching", () => {
      initAppMonitor(mockSD as never, createMockLogger());
      mockSetReconnectEnabled.mockClear();

      // Test with different cases
      mockSD._simulateLaunch("IRACINGSIM64DX11.EXE");

      expect(mockSetReconnectEnabled).toHaveBeenCalledWith(true);
      expect(isIRacingRunning()).toBe(true);
    });

    it("should ignore other applications", () => {
      initAppMonitor(mockSD as never, createMockLogger());
      mockSetReconnectEnabled.mockClear();

      mockSD._simulateLaunch("SomeOtherApp.exe");

      expect(mockSetReconnectEnabled).not.toHaveBeenCalled();
      expect(isIRacingRunning()).toBe(false);
    });
  });

  describe("_resetAppMonitor", () => {
    it("should reset all state", () => {
      initAppMonitor(mockSD as never, createMockLogger());
      mockSD._simulateLaunch("iRacingSim64DX11.exe");

      expect(isAppMonitorInitialized()).toBe(true);
      expect(isIRacingRunning()).toBe(true);

      _resetAppMonitor();

      expect(isAppMonitorInitialized()).toBe(false);
      expect(isIRacingRunning()).toBe(false);
    });

    it("should allow re-initialization after reset", () => {
      initAppMonitor(mockSD as never, createMockLogger());
      _resetAppMonitor();

      expect(() => initAppMonitor(mockSD as never, createMockLogger())).not.toThrow();
      expect(isAppMonitorInitialized()).toBe(true);
    });
  });
});
