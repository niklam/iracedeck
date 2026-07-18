import type { IDeckPlatformAdapter } from "@iracedeck/deck-core";
import {
  _resetAppMonitor,
  initAppMonitor,
  IRACING_EXIT_SDK_CONFIRM_MS,
  isAppMonitorInitialized,
  isIRacingActive,
  isIRacingRunning,
  onIRacingTerminated,
} from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the sdk-singleton module used internally by app-monitor
const mockSetReconnectEnabled = vi.fn();
const mockGetConnectionStatus = vi.fn();
// Captures the connection-tick callback app-monitor subscribes with (issue
// #870 SDK-disconnect fallback) so tests can drive connect/disconnect ticks.
let sdkTickCallback: ((telemetry: unknown, isConnected: boolean) => void) | null = null;
const mockSubscribe = vi.fn((_id: string, cb: (telemetry: unknown, isConnected: boolean) => void) => {
  sdkTickCallback = cb;
});
const mockGetController = vi.fn(() => ({
  setReconnectEnabled: mockSetReconnectEnabled,
  getConnectionStatus: mockGetConnectionStatus,
  subscribe: mockSubscribe,
}));

function driveSdkTick(isConnected: boolean): void {
  sdkTickCallback?.(null, isConnected);
}

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
    setGlobalSettings: vi.fn(),
    onApplicationDidLaunch: vi.fn((cb: (application: string) => void) => {
      launchCallbacks.push(cb);
    }),
    onApplicationDidTerminate: vi.fn((cb: (application: string) => void) => {
      terminateCallbacks.push(cb);
    }),
    onPropertyInspectorDidAppear: vi.fn(),
    createLogger: vi.fn(() => createMockLogger()),
    registerAction: vi.fn(),
    onKeyDown: vi.fn(),
    onDialDown: vi.fn(),
    onDialRotate: vi.fn(),
    connect: vi.fn(),
    switchToProfile: vi.fn(),
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
    subscribe: mockSubscribe,
  }));
}

describe("App Monitor", () => {
  let mockAdapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    mockAdapter = createMockAdapter();
    mockSetReconnectEnabled.mockClear();
    mockGetConnectionStatus.mockClear();
    mockSubscribe.mockClear();
    sdkTickCallback = null;
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

  describe("isIRacingActive (issue #870)", () => {
    it("should return false when iRacing is not running and the SDK is not connected", () => {
      initAppMonitor(mockAdapter, createMockLogger());

      expect(isIRacingActive()).toBe(false);
    });

    it("should return true after iRacing launches", () => {
      initAppMonitor(mockAdapter, createMockLogger());

      mockAdapter._simulateLaunch("iRacingSim64DX11.exe");

      expect(isIRacingActive()).toBe(true);
    });

    it("should return true when the SDK reports connected even without a launch event", () => {
      initAppMonitor(mockAdapter, createMockLogger());
      // The startup race: no app-monitor event has been delivered at all, but
      // the SDK controller has attached to iRacing's shared memory since init.
      mockGetConnectionStatus.mockReturnValue(true);

      expect(isIRacingRunning()).toBe(false);
      expect(isIRacingActive()).toBe(true);
    });

    it("should return false when the SDK singleton is not initialized", () => {
      mockGetController.mockImplementation(() => {
        throw new Error("SDK not initialized");
      });

      expect(isIRacingActive()).toBe(false);

      resetGetControllerMock();
    });
  });

  describe("onIRacingTerminated (issue #870)", () => {
    it("should notify listeners when iRacing terminates", () => {
      initAppMonitor(mockAdapter, createMockLogger());
      const listener = vi.fn();
      onIRacingTerminated(listener);

      mockAdapter._simulateLaunch("iRacingSim64DX11.exe");
      mockAdapter._simulateTerminate("iRacingSim64DX11.exe");

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("should not notify listeners for other applications", () => {
      initAppMonitor(mockAdapter, createMockLogger());
      const listener = vi.fn();
      onIRacingTerminated(listener);

      mockAdapter._simulateTerminate("SomeOtherApp.exe");

      expect(listener).not.toHaveBeenCalled();
    });

    it("should notify AFTER the running flag and reconnect state are already down", () => {
      initAppMonitor(mockAdapter, createMockLogger());
      mockAdapter._simulateLaunch("iRacingSim64DX11.exe");
      // Model the real coupling: the SDK stays connected until
      // setReconnectEnabled(false) actively disconnects it. If the listener
      // loop ever moved above that call, isIRacingActive() would read the
      // still-connected SDK and this test would fail.
      mockGetConnectionStatus.mockReturnValue(true);
      mockSetReconnectEnabled.mockImplementation((enabled: boolean) => {
        if (!enabled) {
          mockGetConnectionStatus.mockReturnValue(false);
        }
      });

      const observed: boolean[] = [];
      onIRacingTerminated(() => {
        observed.push(isIRacingRunning(), isIRacingActive());
      });

      mockAdapter._simulateTerminate("iRacingSim64DX11.exe");

      expect(observed).toEqual([false, false]);
      mockSetReconnectEnabled.mockReset();
    });

    it("should stop notifying after unsubscribe", () => {
      initAppMonitor(mockAdapter, createMockLogger());
      const listener = vi.fn();
      const unsubscribe = onIRacingTerminated(listener);

      unsubscribe();
      mockAdapter._simulateTerminate("iRacingSim64DX11.exe");

      expect(listener).not.toHaveBeenCalled();
    });

    it("should keep notifying later listeners when an earlier one throws", () => {
      initAppMonitor(mockAdapter, createMockLogger());
      const second = vi.fn();
      onIRacingTerminated(() => {
        throw new Error("listener boom");
      });
      onIRacingTerminated(second);

      expect(() => mockAdapter._simulateTerminate("iRacingSim64DX11.exe")).not.toThrow();
      expect(second).toHaveBeenCalledTimes(1);
    });

    it("should fire listeners registered before initAppMonitor", () => {
      const listener = vi.fn();
      onIRacingTerminated(listener);
      initAppMonitor(mockAdapter, createMockLogger());

      mockAdapter._simulateTerminate("iRacingSim64DX11.exe");

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("should clear listeners on _resetAppMonitor", () => {
      initAppMonitor(mockAdapter, createMockLogger());
      const listener = vi.fn();
      onIRacingTerminated(listener);

      _resetAppMonitor();
      initAppMonitor(mockAdapter, createMockLogger());
      mockAdapter._simulateTerminate("iRacingSim64DX11.exe");

      expect(listener).not.toHaveBeenCalled();
    });

    it("should still notify when setReconnectEnabled throws (a throwing telemetry subscriber)", () => {
      initAppMonitor(mockAdapter, createMockLogger());
      mockAdapter._simulateLaunch("iRacingSim64DX11.exe");
      const listener = vi.fn();
      onIRacingTerminated(listener);

      mockSetReconnectEnabled.mockImplementation((enabled: boolean) => {
        if (!enabled) {
          throw new Error("subscriber boom in disconnect fan-out");
        }
      });

      expect(() => mockAdapter._simulateTerminate("iRacingSim64DX11.exe")).not.toThrow();
      expect(listener).toHaveBeenCalledTimes(1);
      mockSetReconnectEnabled.mockReset();
    });
  });

  describe("SDK-disconnect exit fallback (issue #870)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should notify listeners on a confirmed SDK disconnect when no terminate event exists", () => {
      // A host without app-monitoring events (Ulanzi): iRacing already runs at
      // plugin start, so the init path marks it running from the connection.
      mockGetConnectionStatus.mockReturnValue(true);
      initAppMonitor(mockAdapter, createMockLogger());
      const listener = vi.fn();
      onIRacingTerminated(listener);

      driveSdkTick(true);
      mockGetConnectionStatus.mockReturnValue(false);
      driveSdkTick(false);
      expect(listener).not.toHaveBeenCalled();

      vi.advanceTimersByTime(IRACING_EXIT_SDK_CONFIRM_MS);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(isIRacingRunning()).toBe(false);
      expect(isIRacingActive()).toBe(false);
    });

    it("should not notify when the connection recovers inside the confirmation window", () => {
      mockGetConnectionStatus.mockReturnValue(true);
      initAppMonitor(mockAdapter, createMockLogger());
      const listener = vi.fn();
      onIRacingTerminated(listener);

      driveSdkTick(true);
      driveSdkTick(false);
      vi.advanceTimersByTime(IRACING_EXIT_SDK_CONFIRM_MS - 1);
      driveSdkTick(true);
      vi.advanceTimersByTime(IRACING_EXIT_SDK_CONFIRM_MS);

      expect(listener).not.toHaveBeenCalled();
    });

    it("should not notify on an SDK blip while the host says iRacing is still running", () => {
      // Elgato: the launch event set the running flag; a transient SDK
      // disconnect without a terminate event must not read as a sim exit.
      initAppMonitor(mockAdapter, createMockLogger());
      mockAdapter._simulateLaunch("iRacingSim64DX11.exe");
      const listener = vi.fn();
      onIRacingTerminated(listener);

      driveSdkTick(true);
      driveSdkTick(false);
      vi.advanceTimersByTime(IRACING_EXIT_SDK_CONFIRM_MS);

      expect(listener).not.toHaveBeenCalled();
      expect(isIRacingRunning()).toBe(true);
    });

    it("should not double-notify after a terminate event already handled the exit", () => {
      initAppMonitor(mockAdapter, createMockLogger());
      mockAdapter._simulateLaunch("iRacingSim64DX11.exe");
      const listener = vi.fn();
      onIRacingTerminated(listener);

      driveSdkTick(true);
      mockAdapter._simulateTerminate("iRacingSim64DX11.exe");
      expect(listener).toHaveBeenCalledTimes(1);

      // The disconnect the terminate handler itself caused reaches the
      // fallback as a tick; its confirmation must dedupe.
      driveSdkTick(false);
      vi.advanceTimersByTime(IRACING_EXIT_SDK_CONFIRM_MS);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("should re-arm for the next session after a fallback-notified exit", () => {
      mockGetConnectionStatus.mockReturnValue(true);
      initAppMonitor(mockAdapter, createMockLogger());
      const listener = vi.fn();
      onIRacingTerminated(listener);

      driveSdkTick(true);
      driveSdkTick(false);
      vi.advanceTimersByTime(IRACING_EXIT_SDK_CONFIRM_MS);
      expect(listener).toHaveBeenCalledTimes(1);

      // iRacing comes back (SDK reconnects), then exits again.
      driveSdkTick(true);
      driveSdkTick(false);
      vi.advanceTimersByTime(IRACING_EXIT_SDK_CONFIRM_MS);

      expect(listener).toHaveBeenCalledTimes(2);
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
