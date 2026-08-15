import type { ILogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetWindowFocus,
  focusIRacingIfEnabled,
  FocusResult,
  initWindowFocus,
  type WindowFocuser,
} from "./window-focus-service.js";

const { state } = vi.hoisted(() => ({
  state: {
    settings: { focusIRacingWindow: false } as Record<string, unknown>,
    hostSettingsReceived: true,
    iRacingActive: false,
  },
}));

vi.mock("./global-settings.js", () => ({
  getGlobalSettings: () => state.settings,
  hasReceivedHostSettings: () => state.hostSettingsReceived,
}));

vi.mock("./app-monitor.js", () => ({
  isIRacingActive: () => state.iRacingActive,
}));

function createLogger(): ILogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ILogger;
}

/**
 * Initialize the service with a focuser returning `result`.
 *
 * Takes `number` rather than `FocusResult` so the unexpected-code case can pass
 * a value outside the union; the cast is the test deliberately stepping outside
 * the contract the production boundary enforces.
 */
function arrange(result: number): { logger: ILogger; focuser: WindowFocuser } {
  const logger = createLogger();
  const focuser = vi.fn(() => result as FocusResult);
  initWindowFocus(logger, focuser);

  return { logger, focuser };
}

describe("window focus service", () => {
  beforeEach(() => {
    _resetWindowFocus();
    state.settings = { focusIRacingWindow: true };
    state.hostSettingsReceived = true;
    state.iRacingActive = false;
  });

  describe("gating", () => {
    it("does nothing when the service was never initialized", () => {
      expect(() => focusIRacingIfEnabled()).not.toThrow();
    });

    it("focuses when the setting is enabled", () => {
      const { focuser } = arrange(FocusResult.AlreadyFocused);
      focusIRacingIfEnabled();
      expect(focuser).toHaveBeenCalledOnce();
    });

    it("does not focus when the setting is disabled", () => {
      state.settings = { focusIRacingWindow: false };
      const { focuser } = arrange(FocusResult.AlreadyFocused);
      focusIRacingIfEnabled();
      expect(focuser).not.toHaveBeenCalled();
    });

    // Until the host delivers real settings the cache is pure schema defaults,
    // which say focus is ON (#930). Acting on that would override an explicit
    // opt-out during the startup window, so the gate must fail closed.
    it("does not focus before the host's first settings payload arrives", () => {
      state.hostSettingsReceived = false;
      const { focuser } = arrange(FocusResult.AlreadyFocused);
      focusIRacingIfEnabled();
      expect(focuser).not.toHaveBeenCalled();
    });

    it("does not focus a user who opted out, even while the cache still holds defaults", () => {
      state.hostSettingsReceived = false;
      state.settings = { focusIRacingWindow: true }; // schema default, not the user's value
      const { focuser } = arrange(FocusResult.AlreadyFocused);
      focusIRacingIfEnabled();
      expect(focuser).not.toHaveBeenCalled();
    });

    // Matches the sibling DI singletons (initializeKeyboard / initializeClipboard):
    // a second call is a wiring bug, not a silent swap of focuser and logger.
    it("throws when initialized twice", () => {
      arrange(FocusResult.AlreadyFocused);
      expect(() => initWindowFocus(createLogger(), () => FocusResult.AlreadyFocused)).toThrow(/already initialized/i);
    });

    it("logs a warning and does not throw when the focuser throws", () => {
      const logger = createLogger();
      initWindowFocus(logger, () => {
        throw new Error("boom");
      });

      expect(() => focusIRacingIfEnabled()).not.toThrow();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to focus iRacing window"));
    });
  });

  describe("result logging", () => {
    it("logs at debug when the window was already focused", () => {
      const { logger } = arrange(FocusResult.AlreadyFocused);
      focusIRacingIfEnabled();
      expect(logger.debug).toHaveBeenCalledWith("iRacing window already focused");
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("logs at debug when the window was focused", () => {
      const { logger } = arrange(FocusResult.Focused);
      focusIRacingIfEnabled();
      expect(logger.debug).toHaveBeenCalledWith("iRacing window focused successfully");
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("logs at warn the first time focusing times out", () => {
      const { logger } = arrange(FocusResult.FocusTimedOut);
      focusIRacingIfEnabled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("focus timed out (1000ms)"));
    });

    // The usual cause (an elevation mismatch) makes every single press time out,
    // so an unthrottled warn would bury the rest of the log.
    it("drops to debug on repeat timeouts instead of warning every press", () => {
      const { logger } = arrange(FocusResult.FocusTimedOut);
      focusIRacingIfEnabled();
      focusIRacingIfEnabled();
      focusIRacingIfEnabled();

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledTimes(2);
    });

    it("warns again after a focus succeeds in between", () => {
      const logger = createLogger();
      let result: number = FocusResult.FocusTimedOut;
      initWindowFocus(logger, () => result as FocusResult);

      focusIRacingIfEnabled();
      result = FocusResult.Focused;
      focusIRacingIfEnabled();
      result = FocusResult.FocusTimedOut;
      focusIRacingIfEnabled();

      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it("logs at warn on an unexpected result code", () => {
      const { logger } = arrange(99);
      focusIRacingIfEnabled();
      expect(logger.warn).toHaveBeenCalledWith("Unexpected focus result: 99");
    });
  });

  // Issue #930: the setting is on by default, so this path runs before every
  // key/dial press. A missing window while iRacing is closed is the expected
  // outcome, not a fault — it must not spam the log at warn level.
  describe("window not found", () => {
    it("logs at debug when iRacing is not running", () => {
      state.iRacingActive = false;
      const { logger } = arrange(FocusResult.WindowNotFound);
      focusIRacingIfEnabled();

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith("iRacing window not found (iRacing is not running)");
    });

    it("logs at warn when iRacing is running", () => {
      state.iRacingActive = true;
      const { logger } = arrange(FocusResult.WindowNotFound);
      focusIRacingIfEnabled();

      expect(logger.warn).toHaveBeenCalledWith("iRacing window not found — is iRacing running?");
    });
  });
});
