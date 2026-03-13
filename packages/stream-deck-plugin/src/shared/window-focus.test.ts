import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the global settings module
const mockGetGlobalSettings = vi.fn(() => ({ focusIRacingWindow: false, disableWhenDisconnected: true }));
const mockIsGlobalSettingsInitialized = vi.fn(() => true);

vi.mock("./global-settings.js", () => ({
  getGlobalSettings: () => mockGetGlobalSettings(),
  isGlobalSettingsInitialized: () => mockIsGlobalSettingsInitialized(),
}));

vi.mock("@iracedeck/logger", () => ({
  silentLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
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
    const mockFocuser = vi.fn(() => true);
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockFocuser).toHaveBeenCalledOnce();
  });

  it("should NOT call focuser when focusIRacingWindow is disabled", () => {
    mockGetGlobalSettings.mockReturnValue({ focusIRacingWindow: false, disableWhenDisconnected: true });
    const mockFocuser = vi.fn(() => true);
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockFocuser).not.toHaveBeenCalled();
  });

  it("should NOT call focuser when global settings not initialized", () => {
    mockGetGlobalSettings.mockReturnValue({ focusIRacingWindow: true, disableWhenDisconnected: true });
    mockIsGlobalSettingsInitialized.mockReturnValue(false);
    const mockFocuser = vi.fn(() => true);
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockFocuser).not.toHaveBeenCalled();
  });

  it("should log warning when focuser returns false", () => {
    mockGetGlobalSettings.mockReturnValue({ focusIRacingWindow: true, disableWhenDisconnected: true });
    const mockFocuser = vi.fn(() => false);
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockLogger.warn).toHaveBeenCalledWith("Failed to focus iRacing window (window not found or timed out)");
  });

  it("should log debug when focuser succeeds", () => {
    mockGetGlobalSettings.mockReturnValue({ focusIRacingWindow: true, disableWhenDisconnected: true });
    const mockFocuser = vi.fn(() => true);
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    initWindowFocus(mockLogger as any, mockFocuser);

    focusIRacingIfEnabled();

    expect(mockLogger.debug).toHaveBeenCalledWith("Focused iRacing window before sending key");
  });
});
