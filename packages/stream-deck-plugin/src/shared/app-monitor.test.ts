import type { IDeckPlatformAdapter } from "@iracedeck/deck-core";
import { _resetAppMonitor, initAppMonitor, isAppMonitorInitialized, isIRacingRunning } from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the sdk-singleton module used internally by app-monitor
const mockSetReconnectEnabled = vi.fn();
const mockGetConnectionStatus = vi.fn();
const mockGetController = vi.fn(() => ({
  setReconnectEnabled: mockSetReconnectEnabled,
  getConnectionStatus: mockGetConnectionStatus,
}));

// Mock sdk-singleton that app-monitor.ts imports internally.
// The path is relative from this test file to the deck-core source module.
// vitest resolves relative paths from the test file location.
vi.mock("../../../deck-core/src/sdk-singleton.js", () => ({
  getController: () => mockGetController(),
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

// Helper to create a mock adapter matching IDeckPlatformAdapter
function createMockAdapter() {
  const launchCallbacks: ((application: string) => void)[] = [];
  const terminateCallbacks: ((application: string) => void)[] = [];

  return {
    onDidReceiveGlobalSettings: vi.fn(),
    getGlobalSettings: vi.fn(),
    onApplicationDidLaunch: vi.fn((cb: (application: string) => void) => {
      launchCallbacks.push(cb);
    }),
    onApplicationDidTerminate: vi.fn((cb: (application: string) => void) => {
      terminateCallbacks.push(cb);
    }),
    createLogger: vi.fn(() => createMockLogger()),
    registerAction: vi.fn(),
    onKeyDown: vi.fn(),
    onDialDown: vi.fn(),
    onDialRotate: vi.fn(),
    connect: vi.fn(),
    // Helpers for testing
    _simulateLaunch: (app: string) => {
      launchCallbacks.forEach((cb) => cb(app));
    },
    _simulateTerminate: (app: string) => {
      terminateCallbacks.forEach((cb) => cb(app));
    },
  } satisfies IDeckPlatformAdapter & {
    _simulateLaunch: (app: string) => void;
    _simulateTerminate: (app: string) => void;
  };
}

// Helper to reset mock to default behavior
function resetGetControllerMock() {
  mockGetController.mockImplementation(() => ({
    setReconnectEnabled: mockSetReconnectEnabled,
    getConnectionStatus: mockGetConnectionStatus,
  }));
}

describe("App Monitor", () => {
  let mockAdapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    mockAdapter = createMockAdapter();
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
      initAppMonitor(mockAdapter, createMockLogger());

      expect(isAppMonitorInitialized()).toBe(true);
    });
  });

  describe("isIRacingRunning", () => {
    it("should return false initially", () => {
      expect(isIRacingRunning()).toBe(false);
    });

    it("should return true after iRacing launches", () => {
      initAppMonitor(mockAdapter, createMockLogger());

      mockAdapter._simulateLaunch("iRacingSim64DX11.exe");

      expect(isIRacingRunning()).toBe(true);
    });

    it("should return false after iRacing terminates", () => {
      initAppMonitor(mockAdapter, createMockLogger());

      mockAdapter._simulateLaunch("iRacingSim64DX11.exe");
      mockAdapter._simulateTerminate("iRacingSim64DX11.exe");

      expect(isIRacingRunning()).toBe(false);
    });
  });

  describe("initAppMonitor", () => {
    it("should register event handlers", () => {
      initAppMonitor(mockAdapter, createMockLogger());

      expect(mockAdapter.onApplicationDidLaunch).toHaveBeenCalledOnce();
      expect(mockAdapter.onApplicationDidTerminate).toHaveBeenCalledOnce();
    });

    it("should disable reconnect initially when not connected", () => {
      mockGetConnectionStatus.mockReturnValue(false);

      initAppMonitor(mockAdapter, createMockLogger());

      expect(mockSetReconnectEnabled).toHaveBeenCalledWith(false);
    });

    it("should keep reconnect enabled when already connected (race condition fix)", () => {
      mockGetConnectionStatus.mockReturnValue(true);

      initAppMonitor(mockAdapter, createMockLogger());

      // Should NOT call setReconnectEnabled(false) when already connected
      expect(mockSetReconnectEnabled).not.toHaveBeenCalledWith(false);
      // iRacingRunning should be set to true
      expect(isIRacingRunning()).toBe(true);
    });

    it("should return early if called twice", () => {
      initAppMonitor(mockAdapter, createMockLogger());
      const secondLogger = createMockLogger();
      initAppMonitor(mockAdapter, secondLogger);

      // Second call should log at debug level and return early
      expect(secondLogger.debug).toHaveBeenCalledWith("Already initialized");
      // Event handlers should only be registered once
      expect(mockAdapter.onApplicationDidLaunch).toHaveBeenCalledOnce();
    });

    it("should throw if SDK is not initialized", () => {
      // Override mock to throw
      mockGetController.mockImplementation(() => {
        throw new Error("SDK not initialized");
      });

      expect(() => initAppMonitor(mockAdapter, createMockLogger())).toThrow(
        "initAppMonitor requires SDK to be initialized first",
      );

      // Reset mock for subsequent tests (also done in beforeEach, but be explicit)
      resetGetControllerMock();
    });
  });

  describe("event handling", () => {
    it("should enable reconnect when iRacing launches", () => {
      initAppMonitor(mockAdapter, createMockLogger());
      mockSetReconnectEnabled.mockClear();

      mockAdapter._simulateLaunch("iRacingSim64DX11.exe");

      expect(mockSetReconnectEnabled).toHaveBeenCalledWith(true);
      expect(isIRacingRunning()).toBe(true);
    });

    it("should disable reconnect when iRacing terminates", () => {
      initAppMonitor(mockAdapter, createMockLogger());
      mockAdapter._simulateLaunch("iRacingSim64DX11.exe");
      mockSetReconnectEnabled.mockClear();

      mockAdapter._simulateTerminate("iRacingSim64DX11.exe");

      expect(mockSetReconnectEnabled).toHaveBeenCalledWith(false);
      expect(isIRacingRunning()).toBe(false);
    });

    it("should handle case-insensitive executable name matching", () => {
      initAppMonitor(mockAdapter, createMockLogger());
      mockSetReconnectEnabled.mockClear();

      // Test with different cases
      mockAdapter._simulateLaunch("IRACINGSIM64DX11.EXE");

      expect(mockSetReconnectEnabled).toHaveBeenCalledWith(true);
      expect(isIRacingRunning()).toBe(true);
    });

    it("should ignore other applications", () => {
      initAppMonitor(mockAdapter, createMockLogger());
      mockSetReconnectEnabled.mockClear();

      mockAdapter._simulateLaunch("SomeOtherApp.exe");

      expect(mockSetReconnectEnabled).not.toHaveBeenCalled();
      expect(isIRacingRunning()).toBe(false);
    });
  });

  describe("_resetAppMonitor", () => {
    it("should reset all state", () => {
      initAppMonitor(mockAdapter, createMockLogger());
      mockAdapter._simulateLaunch("iRacingSim64DX11.exe");

      expect(isAppMonitorInitialized()).toBe(true);
      expect(isIRacingRunning()).toBe(true);

      _resetAppMonitor();

      expect(isAppMonitorInitialized()).toBe(false);
      expect(isIRacingRunning()).toBe(false);
    });

    it("should allow re-initialization after reset", () => {
      initAppMonitor(mockAdapter, createMockLogger());
      _resetAppMonitor();

      expect(() => initAppMonitor(mockAdapter, createMockLogger())).not.toThrow();
      expect(isAppMonitorInitialized()).toBe(true);
    });
  });
});
