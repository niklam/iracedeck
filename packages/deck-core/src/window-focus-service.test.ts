import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetWindowFocus,
  FOCUS_TIMEOUT_COOLDOWN_MS,
  focusIRacingBeforeInput,
  focusIRacingIfEnabled,
  focusIRacingNow,
  FocusResult,
  initWindowFocus,
  type WindowFocuser,
} from "./window-focus-service.js";

const { state } = vi.hoisted(() => ({
  state: {
    settings: { focusIRacingWindow: "never" } as Record<string, unknown>,
    storeReady: true,
    iRacingActive: false,
  },
}));

vi.mock("./global-settings.js", () => ({
  getGlobalSettings: () => state.settings,
  isSettingsStoreReady: () => state.storeReady,
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
    // The service reads the clock for the post-timeout cooldown (#977); the
    // tests below step it explicitly wherever a repeat ask must go through.
    vi.useFakeTimers();
    _resetWindowFocus();
    state.settings = { focusIRacingWindow: "always" };
    state.storeReady = true;
    state.iRacingActive = false;
  });

  afterEach(() => {
    vi.useRealTimers();
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

    it("does not focus under never", () => {
      state.settings = { focusIRacingWindow: "never" };
      const { focuser } = arrange(FocusResult.AlreadyFocused);
      focusIRacingIfEnabled();
      expect(focuser).not.toHaveBeenCalled();
    });

    it("does not focus under required — the adapter hook is the Always-only site (#977)", () => {
      state.settings = { focusIRacingWindow: "required" };
      const { focuser } = arrange(FocusResult.AlreadyFocused);
      focusIRacingIfEnabled();
      expect(focuser).not.toHaveBeenCalled();
    });

    // Until the host delivers real settings the cache is pure schema defaults,
    // which say focus is ON (#930). Acting on that would override an explicit
    // opt-out during the startup window, so the gate must fail closed.
    it("does not focus before the host's first settings payload arrives", () => {
      state.storeReady = false;
      const { focuser } = arrange(FocusResult.AlreadyFocused);
      focusIRacingIfEnabled();
      expect(focuser).not.toHaveBeenCalled();
    });

    it("does not focus a user who opted out, even while the cache still holds defaults", () => {
      state.storeReady = false;
      state.settings = { focusIRacingWindow: "always" }; // schema default, not the user's value
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

  describe("focusIRacingBeforeInput (issue #977)", () => {
    it("does nothing when the service was never initialized", () => {
      expect(() => focusIRacingBeforeInput()).not.toThrow();
    });

    it("focuses under always", () => {
      state.settings = { focusIRacingWindow: "always" };
      const { focuser } = arrange(FocusResult.Focused);
      focusIRacingBeforeInput();
      expect(focuser).toHaveBeenCalledOnce();
    });

    it("focuses under required — this is the site a keystroke reaches", () => {
      state.settings = { focusIRacingWindow: "required" };
      const { focuser } = arrange(FocusResult.Focused);
      focusIRacingBeforeInput();
      expect(focuser).toHaveBeenCalledOnce();
    });

    it("does not focus under never", () => {
      state.settings = { focusIRacingWindow: "never" };
      const { focuser } = arrange(FocusResult.Focused);
      focusIRacingBeforeInput();
      expect(focuser).not.toHaveBeenCalled();
    });

    it("waits for the settings store like the adapter hook does", () => {
      // Before the store is read the cache is schema defaults, which say
      // `always` — acting on it would override an explicit `never`.
      state.storeReady = false;
      const { focuser } = arrange(FocusResult.Focused);
      focusIRacingBeforeInput();
      expect(focuser).not.toHaveBeenCalled();
    });

    it("shares the result handling — a thrown focuser is logged, never rethrown", () => {
      const logger = createLogger();
      initWindowFocus(logger, () => {
        throw new Error("boom");
      });
      expect(() => focusIRacingBeforeInput()).not.toThrow();
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
      const { logger, focuser } = arrange(FocusResult.FocusTimedOut);
      focusIRacingIfEnabled();
      vi.advanceTimersByTime(FOCUS_TIMEOUT_COOLDOWN_MS);
      focusIRacingIfEnabled();
      vi.advanceTimersByTime(FOCUS_TIMEOUT_COOLDOWN_MS);
      focusIRacingIfEnabled();

      expect(focuser).toHaveBeenCalledTimes(3);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledTimes(2);
    });

    // Closing iRacing ends the episode: a timeout after a relaunch (e.g. now as
    // Administrator) is a new problem and must surface the remediation hint.
    it("warns again after the window disappears in between", () => {
      const logger = createLogger();
      let result: number = FocusResult.FocusTimedOut;
      initWindowFocus(logger, () => result as FocusResult);

      focusIRacingIfEnabled();
      vi.advanceTimersByTime(FOCUS_TIMEOUT_COOLDOWN_MS);
      result = FocusResult.WindowNotFound;
      focusIRacingIfEnabled();
      result = FocusResult.FocusTimedOut;
      focusIRacingIfEnabled();

      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it("warns again after a focus succeeds in between", () => {
      const logger = createLogger();
      let result: number = FocusResult.FocusTimedOut;
      initWindowFocus(logger, () => result as FocusResult);

      focusIRacingIfEnabled();
      vi.advanceTimersByTime(FOCUS_TIMEOUT_COOLDOWN_MS);
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

  // A timed-out ask blocks the JS thread for the native focuser's full wait
  // (~1000 ms), and under `always` a keybind press asks twice (adapter hook,
  // then the keystroke site) — so the elevation-mismatch case would cost two
  // seconds per press, and a held key repeating every 150 ms a second per tick.
  // After a timeout both gated entry points skip the native ask for a while.
  describe("timeout cooldown (issue #977)", () => {
    it("exports a 2000 ms cooldown", () => {
      expect(FOCUS_TIMEOUT_COOLDOWN_MS).toBe(2000);
    });

    it("skips the adapter-hook ask within the cooldown after a timeout, saying how long ago", () => {
      const { logger, focuser } = arrange(FocusResult.FocusTimedOut);
      focusIRacingIfEnabled();
      vi.advanceTimersByTime(500);
      focusIRacingIfEnabled();

      expect(focuser).toHaveBeenCalledOnce();
      expect(logger.debug).toHaveBeenCalledWith("iRacing focus skipped: a focus timed out 500 ms ago");
    });

    it("skips the keystroke-site ask within the cooldown too", () => {
      state.settings = { focusIRacingWindow: "required" };
      const { focuser } = arrange(FocusResult.FocusTimedOut);
      focusIRacingBeforeInput();
      vi.advanceTimersByTime(FOCUS_TIMEOUT_COOLDOWN_MS - 1);
      focusIRacingBeforeInput();

      expect(focuser).toHaveBeenCalledOnce();
    });

    it("asks again once the cooldown has elapsed", () => {
      const { focuser } = arrange(FocusResult.FocusTimedOut);
      focusIRacingIfEnabled();
      vi.advanceTimersByTime(FOCUS_TIMEOUT_COOLDOWN_MS);
      focusIRacingBeforeInput();

      expect(focuser).toHaveBeenCalledTimes(2);
    });

    it("re-arms on every timeout, so a persistent condition costs one ask per cooldown", () => {
      const { focuser } = arrange(FocusResult.FocusTimedOut);
      focusIRacingIfEnabled();
      vi.advanceTimersByTime(FOCUS_TIMEOUT_COOLDOWN_MS);
      focusIRacingIfEnabled();
      vi.advanceTimersByTime(FOCUS_TIMEOUT_COOLDOWN_MS - 1);
      focusIRacingIfEnabled();

      expect(focuser).toHaveBeenCalledTimes(2);
    });

    it("does not change behaviour when nothing has timed out", () => {
      const { focuser } = arrange(FocusResult.Focused);
      focusIRacingIfEnabled();
      focusIRacingBeforeInput();
      focusIRacingIfEnabled();

      expect(focuser).toHaveBeenCalledTimes(3);
    });

    it("focusIRacingNow (Mouse to Sim) is not subject to the cooldown — the press IS the focus", () => {
      const { focuser } = arrange(FocusResult.FocusTimedOut);
      focusIRacingIfEnabled();
      vi.advanceTimersByTime(100);

      expect(focusIRacingNow()).toBe(FocusResult.FocusTimedOut);
      expect(focuser).toHaveBeenCalledTimes(2);
    });

    it("a success ends the cooldown — a Mouse to Sim focus inside it lets the next gated ask through", () => {
      const logger = createLogger();
      let result: number = FocusResult.FocusTimedOut;
      const focuser = vi.fn(() => result as FocusResult);
      initWindowFocus(logger, focuser);

      focusIRacingIfEnabled();
      vi.advanceTimersByTime(100);
      result = FocusResult.Focused;
      focusIRacingNow();
      vi.advanceTimersByTime(100);
      focusIRacingIfEnabled();

      expect(focuser).toHaveBeenCalledTimes(3);
    });

    it("a vanished window ends the cooldown — a timeout after it is a new episode", () => {
      const logger = createLogger();
      let result: number = FocusResult.FocusTimedOut;
      const focuser = vi.fn(() => result as FocusResult);
      initWindowFocus(logger, focuser);

      focusIRacingIfEnabled();
      vi.advanceTimersByTime(100);
      result = FocusResult.WindowNotFound;
      focusIRacingNow();
      vi.advanceTimersByTime(100);
      focusIRacingIfEnabled();

      expect(focuser).toHaveBeenCalledTimes(3);
    });

    it("an already-focused window ends the cooldown", () => {
      const logger = createLogger();
      let result: number = FocusResult.FocusTimedOut;
      const focuser = vi.fn(() => result as FocusResult);
      initWindowFocus(logger, focuser);

      focusIRacingIfEnabled();
      vi.advanceTimersByTime(100);
      result = FocusResult.AlreadyFocused;
      focusIRacingNow();
      vi.advanceTimersByTime(100);
      focusIRacingIfEnabled();

      expect(focuser).toHaveBeenCalledTimes(3);
    });

    it("_resetWindowFocus clears the cooldown", () => {
      arrange(FocusResult.FocusTimedOut);
      focusIRacingIfEnabled();
      _resetWindowFocus();
      const { focuser } = arrange(FocusResult.Focused);
      focusIRacingIfEnabled();

      expect(focuser).toHaveBeenCalledOnce();
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

describe("focusIRacingNow (issue #926)", () => {
  beforeEach(() => {
    _resetWindowFocus();
    state.settings = { focusIRacingWindow: "always" };
    state.storeReady = true;
    state.iRacingActive = false;
  });

  it("focuses even when the setting is disabled", () => {
    // The opt-out governs the IMPLICIT before-every-action focus. This entry point
    // only ever runs from an explicit press, so it deliberately ignores it (#926).
    state.settings = { focusIRacingWindow: "never" };
    const { focuser } = arrange(FocusResult.Focused);

    expect(focusIRacingNow()).toBe(FocusResult.Focused);
    expect(focuser).toHaveBeenCalledOnce();
  });

  it("focuses before the host's first settings payload has arrived", () => {
    state.storeReady = false;
    const { focuser } = arrange(FocusResult.Focused);

    expect(focusIRacingNow()).toBe(FocusResult.Focused);
    expect(focuser).toHaveBeenCalledOnce();
  });

  it("returns the focuser's result code", () => {
    arrange(FocusResult.WindowNotFound);
    expect(focusIRacingNow()).toBe(FocusResult.WindowNotFound);
  });

  it("returns null when the service was never initialized", () => {
    expect(focusIRacingNow()).toBeNull();
  });

  it("returns null when the focuser throws", () => {
    const logger = createLogger();
    initWindowFocus(logger, () => {
      throw new Error("boom");
    });

    expect(focusIRacingNow()).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("shares the enabled path's logging", () => {
    const { logger } = arrange(FocusResult.FocusTimedOut);

    focusIRacingNow();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });
});
