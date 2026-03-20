import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock global-settings module used internally by window-focus.ts
const mockGetGlobalSettings = vi.fn(() => ({
  focusIRacingWindow: false,
  disableWhenDisconnected: true,
}));
const mockIsGlobalSettingsInitialized = vi.fn(() => true);

vi.mock("@iracedeck/deck-core", () => ({
  getGlobalSettings: () => mockGetGlobalSettings(),
  isGlobalSettingsInitialized: () => mockIsGlobalSettingsInitialized(),
}));

// Mock FocusResult enum used by window-focus.ts
vi.mock("@iracedeck/iracing-native", () => ({
  FocusResult: {
    AlreadyFocused: 0,
    Focused: 1,
    WindowNotFound: 2,
    FocusTimedOut: 3,
  },
}));

// Mock logger
vi.mock("@iracedeck/logger", () => ({
  silentLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Since window-focus.ts has module-level state (focuser, logger), we need to
// reset it between tests. Use dynamic imports with vi.resetModules().
let initWindowFocus: (typeof import("./window-focus.js"))["initWindowFocus"];
let focusIRacingIfEnabled: (typeof import("./window-focus.js"))["focusIRacingIfEnabled"];

describe("Window Focus Service", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset module state so each test starts fresh
    vi.resetModules();

    // Re-register mocks after resetModules
    vi.doMock("@iracedeck/deck-core", () => ({
      getGlobalSettings: () => mockGetGlobalSettings(),
      isGlobalSettingsInitialized: () => mockIsGlobalSettingsInitialized(),
    }));
    vi.doMock("@iracedeck/iracing-native", () => ({
      FocusResult: {
        AlreadyFocused: 0,
        Focused: 1,
        WindowNotFound: 2,
        FocusTimedOut: 3,
      },
    }));
    vi.doMock("@iracedeck/logger", () => ({
      silentLogger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }));

    const mod = await import("./window-focus.js");
    initWindowFocus = mod.initWindowFocus;
    focusIRacingIfEnabled = mod.focusIRacingIfEnabled;

    mockGetGlobalSettings.mockReturnValue({
      focusIRacingWindow: false,
      disableWhenDisconnected: true,
    });
    mockIsGlobalSettingsInitialized.mockReturnValue(true);
  });

  it("should not call focuser when not initialized", () => {
    focusIRacingIfEnabled();
    // No error thrown, just returns early
  });

  it("should call focuser when focusIRacingWindow is enabled", () => {
    mockGetGlobalSettings.mockReturnValue({
      focusIRacingWindow: true,
      disableWhenDisconnected: true,
    });
    const mockFocuser = vi.fn(() => 0);
    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockFocuser).toHaveBeenCalledOnce();
  });

  it("should NOT call focuser when focusIRacingWindow is disabled", () => {
    mockGetGlobalSettings.mockReturnValue({
      focusIRacingWindow: false,
      disableWhenDisconnected: true,
    });
    const mockFocuser = vi.fn(() => 0);
    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockFocuser).not.toHaveBeenCalled();
  });

  it("should NOT call focuser when global settings not initialized", () => {
    mockGetGlobalSettings.mockReturnValue({
      focusIRacingWindow: true,
      disableWhenDisconnected: true,
    });
    mockIsGlobalSettingsInitialized.mockReturnValue(false);
    const mockFocuser = vi.fn(() => 0);
    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockFocuser).not.toHaveBeenCalled();
  });

  it("should log debug when window is already focused", () => {
    mockGetGlobalSettings.mockReturnValue({
      focusIRacingWindow: true,
      disableWhenDisconnected: true,
    });
    const mockFocuser = vi.fn(() => 0); // AlreadyFocused
    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockLogger.debug).toHaveBeenCalledWith("iRacing window already focused");
  });

  it("should log debug when window is focused successfully", () => {
    mockGetGlobalSettings.mockReturnValue({
      focusIRacingWindow: true,
      disableWhenDisconnected: true,
    });
    const mockFocuser = vi.fn(() => 1); // Focused
    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockLogger.debug).toHaveBeenCalledWith("iRacing window focused successfully");
  });

  it("should log warning when window is not found", () => {
    mockGetGlobalSettings.mockReturnValue({
      focusIRacingWindow: true,
      disableWhenDisconnected: true,
    });
    const mockFocuser = vi.fn(() => 2); // WindowNotFound
    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockLogger.warn).toHaveBeenCalledWith("iRacing window not found — is iRacing running?");
  });

  it("should log warning when focus times out", () => {
    mockGetGlobalSettings.mockReturnValue({
      focusIRacingWindow: true,
      disableWhenDisconnected: true,
    });
    const mockFocuser = vi.fn(() => 3); // FocusTimedOut
    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockLogger.warn).toHaveBeenCalledWith("iRacing window found but focus timed out (1000ms)");
  });
});
