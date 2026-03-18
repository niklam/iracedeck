import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the global settings module
const mockGetGlobalSettings = vi.fn(() => ({ focusIRacingWindow: false, disableWhenDisconnected: true }));
const mockIsGlobalSettingsInitialized = vi.fn(() => true);

vi.mock("./global-settings.js", () => ({
  getGlobalSettings: () => mockGetGlobalSettings(),
  isGlobalSettingsInitialized: () => mockIsGlobalSettingsInitialized(),
}));

const FOCUS_RESULT_MOCK = {
  AlreadyFocused: 0,
  Focused: 1,
  WindowNotFound: 2,
  FocusTimedOut: 3,
};

vi.mock("@iracedeck/logger", () => ({
  silentLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@iracedeck/iracing-native", () => ({
  FocusResult: FOCUS_RESULT_MOCK,
}));

// Dynamic import to get fresh module state per test
let initWindowFocus: (typeof import("./window-focus.js"))["initWindowFocus"];
let focusIRacingIfEnabled: (typeof import("./window-focus.js"))["focusIRacingIfEnabled"];

describe("Window Focus Service", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-import to reset module state
    vi.resetModules();

    // Re-register mocks before re-importing
    vi.doMock("./global-settings.js", () => ({
      getGlobalSettings: () => mockGetGlobalSettings(),
      isGlobalSettingsInitialized: () => mockIsGlobalSettingsInitialized(),
    }));
    vi.doMock("@iracedeck/logger", () => ({
      silentLogger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }));
    vi.doMock("@iracedeck/iracing-native", () => ({
      FocusResult: FOCUS_RESULT_MOCK,
    }));

    const mod = await import("./window-focus.js");
    initWindowFocus = mod.initWindowFocus;
    focusIRacingIfEnabled = mod.focusIRacingIfEnabled;

    mockGetGlobalSettings.mockReturnValue({ focusIRacingWindow: false, disableWhenDisconnected: true });
    mockIsGlobalSettingsInitialized.mockReturnValue(true);
  });

  it("should not call focuser when not initialized", () => {
    focusIRacingIfEnabled();
    // No error thrown, just returns early
  });

  it("should call focuser when focusIRacingWindow is enabled", () => {
    mockGetGlobalSettings.mockReturnValue({ focusIRacingWindow: true, disableWhenDisconnected: true });
    const mockFocuser = vi.fn(() => 0);
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockFocuser).toHaveBeenCalledOnce();
  });

  it("should NOT call focuser when focusIRacingWindow is disabled", () => {
    mockGetGlobalSettings.mockReturnValue({ focusIRacingWindow: false, disableWhenDisconnected: true });
    const mockFocuser = vi.fn(() => 0);
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockFocuser).not.toHaveBeenCalled();
  });

  it("should NOT call focuser when global settings not initialized", () => {
    mockGetGlobalSettings.mockReturnValue({ focusIRacingWindow: true, disableWhenDisconnected: true });
    mockIsGlobalSettingsInitialized.mockReturnValue(false);
    const mockFocuser = vi.fn(() => 0);
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockFocuser).not.toHaveBeenCalled();
  });

  it("should log debug when window is already focused", () => {
    mockGetGlobalSettings.mockReturnValue({ focusIRacingWindow: true, disableWhenDisconnected: true });
    const mockFocuser = vi.fn(() => 0); // AlreadyFocused
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockLogger.debug).toHaveBeenCalledWith("iRacing window already focused");
  });

  it("should log debug when window is focused successfully", () => {
    mockGetGlobalSettings.mockReturnValue({ focusIRacingWindow: true, disableWhenDisconnected: true });
    const mockFocuser = vi.fn(() => 1); // Focused
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockLogger.debug).toHaveBeenCalledWith("iRacing window focused successfully");
  });

  it("should log warning when window is not found", () => {
    mockGetGlobalSettings.mockReturnValue({ focusIRacingWindow: true, disableWhenDisconnected: true });
    const mockFocuser = vi.fn(() => 2); // WindowNotFound
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockLogger.warn).toHaveBeenCalledWith("iRacing window not found — is iRacing running?");
  });

  it("should log warning when focus times out", () => {
    mockGetGlobalSettings.mockReturnValue({ focusIRacingWindow: true, disableWhenDisconnected: true });
    const mockFocuser = vi.fn(() => 3); // FocusTimedOut
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockLogger.warn).toHaveBeenCalledWith("iRacing window found but focus timed out (1000ms)");
  });
});
