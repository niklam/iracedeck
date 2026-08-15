import { beforeEach, describe, expect, it, vi } from "vitest";

import { getGlobalSettings, isGlobalSettingsInitialized } from "./global-settings.js";
import {
  _resetWindowService,
  DEFAULT_POINTER_X_FRACTION,
  DEFAULT_POINTER_Y_FRACTION,
  focusIRacingIfEnabled,
  getWindowService,
  initializeWindowService,
  isWindowServiceInitialized,
  PointerMoveResult,
  WindowFocusResult,
} from "./window-service.js";

vi.mock("./global-settings.js", () => ({
  getGlobalSettings: vi.fn(() => ({ focusIRacingWindow: true })),
  isGlobalSettingsInitialized: vi.fn(() => true),
}));

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withLevel: vi.fn(),
  createScope: vi.fn(),
};

describe("Window Service", () => {
  beforeEach(() => {
    _resetWindowService();
    vi.clearAllMocks();
    vi.mocked(isGlobalSettingsInitialized).mockReturnValue(true);
    vi.mocked(getGlobalSettings).mockReturnValue({ focusIRacingWindow: true } as never);
  });

  describe("initialization", () => {
    it("starts uninitialized", () => {
      expect(isWindowServiceInitialized()).toBe(false);
    });

    it("becomes initialized after initializeWindowService", () => {
      initializeWindowService(mockLogger, {});
      expect(isWindowServiceInitialized()).toBe(true);
    });

    it("throws if initialized twice", () => {
      initializeWindowService(mockLogger, {});
      expect(() => initializeWindowService(mockLogger, {})).toThrow(/already initialized/);
    });

    it("throws when getWindowService is called before init", () => {
      expect(() => getWindowService()).toThrow(/not initialized/);
    });

    it("focusIRacingIfEnabled is a silent no-op before init", () => {
      expect(() => focusIRacingIfEnabled()).not.toThrow();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe("focus", () => {
    it("returns the focuser's result code", () => {
      initializeWindowService(mockLogger, { focuser: () => WindowFocusResult.Focused });
      expect(getWindowService().focus()).toBe(WindowFocusResult.Focused);
    });

    it("does not warn when the window was already focused", () => {
      initializeWindowService(mockLogger, { focuser: () => WindowFocusResult.AlreadyFocused });
      expect(getWindowService().focus()).toBe(WindowFocusResult.AlreadyFocused);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("warns when the window is not found", () => {
      initializeWindowService(mockLogger, { focuser: () => WindowFocusResult.WindowNotFound });
      expect(getWindowService().focus()).toBe(WindowFocusResult.WindowNotFound);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("not found"));
    });

    it("warns when focus times out", () => {
      initializeWindowService(mockLogger, { focuser: () => WindowFocusResult.FocusTimedOut });
      expect(getWindowService().focus()).toBe(WindowFocusResult.FocusTimedOut);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    });

    it("warns on an unexpected result code", () => {
      initializeWindowService(mockLogger, { focuser: () => 99 });
      getWindowService().focus();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Unexpected"));
    });

    it("reports Unavailable, not WindowNotFound, when no focuser is configured", () => {
      initializeWindowService(mockLogger, {});
      // Distinct from WindowNotFound: we never looked, so callers must not treat
      // this as evidence that iRacing is absent.
      expect(getWindowService().focus()).toBe(WindowFocusResult.Unavailable);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("warns only once about a missing focuser, however many calls", () => {
      initializeWindowService(mockLogger, {});
      const service = getWindowService();

      service.focus();
      service.focus();
      service.focus();

      // focusIfEnabled() runs before EVERY key press — a per-call warning would flood the log.
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    });

    it("reports Unavailable when the focuser throws", () => {
      initializeWindowService(mockLogger, {
        focuser: () => {
          throw new Error("boom");
        },
      });
      expect(getWindowService().focus()).toBe(WindowFocusResult.Unavailable);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    });
  });

  describe("focusIfEnabled", () => {
    it("focuses when the global setting is on", () => {
      const focuser = vi.fn(() => WindowFocusResult.Focused);
      initializeWindowService(mockLogger, { focuser });
      getWindowService().focusIfEnabled();
      expect(focuser).toHaveBeenCalledTimes(1);
    });

    it("does nothing when the global setting is off", () => {
      vi.mocked(getGlobalSettings).mockReturnValue({ focusIRacingWindow: false } as never);
      const focuser = vi.fn(() => WindowFocusResult.Focused);
      initializeWindowService(mockLogger, { focuser });
      getWindowService().focusIfEnabled();
      expect(focuser).not.toHaveBeenCalled();
    });

    it("does nothing when global settings are not initialized", () => {
      vi.mocked(isGlobalSettingsInitialized).mockReturnValue(false);
      const focuser = vi.fn(() => WindowFocusResult.Focused);
      initializeWindowService(mockLogger, { focuser });
      getWindowService().focusIfEnabled();
      expect(focuser).not.toHaveBeenCalled();
    });

    it("is reachable through the free focusIRacingIfEnabled helper", () => {
      const focuser = vi.fn(() => WindowFocusResult.Focused);
      initializeWindowService(mockLogger, { focuser });
      focusIRacingIfEnabled();
      expect(focuser).toHaveBeenCalledTimes(1);
    });
  });

  describe("movePointerToSim", () => {
    it("uses the default fractions when none are given", () => {
      const pointerMover = vi.fn(() => PointerMoveResult.Moved);
      initializeWindowService(mockLogger, { pointerMover });
      expect(getWindowService().movePointerToSim()).toBe(PointerMoveResult.Moved);
      expect(pointerMover).toHaveBeenCalledWith(DEFAULT_POINTER_X_FRACTION, DEFAULT_POINTER_Y_FRACTION);
    });

    it("parks the pointer horizontally centered, one eighth down", () => {
      expect(DEFAULT_POINTER_X_FRACTION).toBe(0.5);
      expect(DEFAULT_POINTER_Y_FRACTION).toBe(0.125);
    });

    it("passes explicit fractions through verbatim", () => {
      const pointerMover = vi.fn(() => PointerMoveResult.Moved);
      initializeWindowService(mockLogger, { pointerMover });
      getWindowService().movePointerToSim(0.25, 0.75);
      expect(pointerMover).toHaveBeenCalledWith(0.25, 0.75);
    });

    it("ignores the focusIRacingWindow setting", () => {
      vi.mocked(getGlobalSettings).mockReturnValue({ focusIRacingWindow: false } as never);
      const pointerMover = vi.fn(() => PointerMoveResult.Moved);
      initializeWindowService(mockLogger, { pointerMover });
      getWindowService().movePointerToSim();
      expect(pointerMover).toHaveBeenCalledTimes(1);
    });

    it("warns when the window is not found", () => {
      initializeWindowService(mockLogger, { pointerMover: () => PointerMoveResult.WindowNotFound });
      expect(getWindowService().movePointerToSim()).toBe(PointerMoveResult.WindowNotFound);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("not found"));
    });

    it("warns when the move fails", () => {
      initializeWindowService(mockLogger, { pointerMover: () => PointerMoveResult.Failed });
      expect(getWindowService().movePointerToSim()).toBe(PointerMoveResult.Failed);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("minimized"));
    });

    it("reports Unavailable when the pointer mover throws", () => {
      initializeWindowService(mockLogger, {
        pointerMover: () => {
          throw new Error("boom");
        },
      });
      expect(getWindowService().movePointerToSim()).toBe(PointerMoveResult.Unavailable);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    });

    it("reports Unavailable, not Failed, when no mover is configured", () => {
      initializeWindowService(mockLogger, {});
      expect(getWindowService().movePointerToSim()).toBe(PointerMoveResult.Unavailable);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("warns only once about a missing pointer mover", () => {
      initializeWindowService(mockLogger, {});
      const service = getWindowService();

      service.movePointerToSim();
      service.movePointerToSim();

      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe("result code contract", () => {
    it("matches the native FocusResult numbering", () => {
      expect(WindowFocusResult.AlreadyFocused).toBe(0);
      expect(WindowFocusResult.Focused).toBe(1);
      expect(WindowFocusResult.WindowNotFound).toBe(2);
      expect(WindowFocusResult.FocusTimedOut).toBe(3);
    });

    it("matches the native PointerMoveResult numbering", () => {
      expect(PointerMoveResult.Moved).toBe(0);
      expect(PointerMoveResult.WindowNotFound).toBe(1);
      expect(PointerMoveResult.Failed).toBe(2);
    });

    it("keeps the Unavailable sentinels outside the native contract range", () => {
      // The native layer only ever returns 0..3 / 0..2, so a negative sentinel can
      // never collide with a real result code.
      expect(WindowFocusResult.Unavailable).toBe(-1);
      expect(PointerMoveResult.Unavailable).toBe(-1);
    });
  });
});
