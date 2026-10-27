import {
  _resetKeyboard,
  getKeyboard,
  initializeKeyboard,
  isKeyboardInitialized,
  type KeyCombination,
} from "@iracedeck/deck-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the keysender module
const mockSendKey = vi.fn().mockResolvedValue(undefined);
const mockToggleKey = vi.fn().mockResolvedValue(undefined);

vi.mock("keysender", () => ({
  Hardware: class MockHardware {
    keyboard = {
      sendKey: mockSendKey,
      toggleKey: mockToggleKey,
    };
  },
}));

// Mock the logger
vi.mock("@iracedeck/logger", () => ({
  silentLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// The focus call the keyboard service makes before every emitted keystroke
// (#977). The vitest alias maps `@iracedeck/deck-core` to that package's SOURCE,
// so the module the service imports as `./window-focus-service.js` is mocked
// here by its path relative to this file; the rest of the module stays real
// because the deck-core barrel re-exports it.
const { mockFocusBeforeInput } = vi.hoisted(() => ({ mockFocusBeforeInput: vi.fn() }));

vi.mock("../../../deck-core/src/window-focus-service.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  focusIRacingBeforeInput: mockFocusBeforeInput,
}));

describe("Keyboard Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetKeyboard();
  });

  describe("isKeyboardInitialized", () => {
    it("should return false before initialization", () => {
      expect(isKeyboardInitialized()).toBe(false);
    });

    it("should return true after initialization", () => {
      initializeKeyboard();

      expect(isKeyboardInitialized()).toBe(true);
    });
  });

  describe("initializeKeyboard", () => {
    it("should return the keyboard service", () => {
      const service = initializeKeyboard();

      expect(service).toHaveProperty("sendKey");
      expect(service).toHaveProperty("sendKeyCombination");
      expect(service).toHaveProperty("pressKeyCombination");
      expect(service).toHaveProperty("releaseKeyCombination");
    });

    it("should throw if called twice", () => {
      initializeKeyboard();

      expect(() => initializeKeyboard()).toThrow("Keyboard service already initialized");
    });
  });

  describe("getKeyboard", () => {
    it("should throw if not initialized", () => {
      expect(() => getKeyboard()).toThrow("Keyboard service not initialized");
    });

    it("should return the keyboard service after initialization", () => {
      initializeKeyboard();
      const service = getKeyboard();

      expect(service).toHaveProperty("sendKey");
      expect(service).toHaveProperty("sendKeyCombination");
    });
  });

  describe("sendKey", () => {
    it("should send a key press via keysender", async () => {
      initializeKeyboard();
      const keyboard = getKeyboard();

      const result = await keyboard.sendKey("f3");

      expect(result).toBe(true);
      expect(mockSendKey).toHaveBeenCalledWith("f3");
    });

    it("should map special keys correctly", async () => {
      initializeKeyboard();
      const keyboard = getKeyboard();

      await keyboard.sendKey("pageup");
      expect(mockSendKey).toHaveBeenCalledWith("pageUp");

      await keyboard.sendKey("pagedown");
      expect(mockSendKey).toHaveBeenCalledWith("pageDown");
    });

    it("should return false on error", async () => {
      mockSendKey.mockRejectedValueOnce(new Error("Test error"));
      initializeKeyboard();
      const keyboard = getKeyboard();

      const result = await keyboard.sendKey("a");

      expect(result).toBe(false);
    });
  });

  describe("sendKeyCombination - keysender fallback", () => {
    it("should send via keysender when no code is present", async () => {
      initializeKeyboard();
      const keyboard = getKeyboard();

      const result = await keyboard.sendKeyCombination({ key: "f1" });

      expect(result).toBe(true);
      expect(mockSendKey).toHaveBeenCalledWith("f1");
    });

    it("should send via keysender when no scanKeySender is configured", async () => {
      initializeKeyboard();
      const keyboard = getKeyboard();

      const result = await keyboard.sendKeyCombination({
        key: "f1",
        code: "F1",
      });

      expect(result).toBe(true);
      expect(mockSendKey).toHaveBeenCalledWith("f1");
    });

    it("should send a key combination with single modifier via keysender", async () => {
      initializeKeyboard();
      const keyboard = getKeyboard();

      const result = await keyboard.sendKeyCombination({
        key: "r",
        modifiers: ["shift"],
      });

      expect(result).toBe(true);
      expect(mockSendKey).toHaveBeenCalledWith(["shift", "r"]);
    });

    it("should send a key combination with multiple modifiers via keysender", async () => {
      initializeKeyboard();
      const keyboard = getKeyboard();

      const result = await keyboard.sendKeyCombination({
        key: "s",
        modifiers: ["ctrl", "shift"],
      });

      expect(result).toBe(true);
      expect(mockSendKey).toHaveBeenCalledWith(["ctrl", "shift", "s"]);
    });

    it("should return false on keysender error", async () => {
      mockSendKey.mockRejectedValueOnce(new Error("Test error"));
      initializeKeyboard();
      const keyboard = getKeyboard();

      const result = await keyboard.sendKeyCombination({ key: "a" });

      expect(result).toBe(false);
    });
  });

  describe("sendKeyCombination - scan code path", () => {
    it("should send via scan codes when code is present and scanKeySender is configured", async () => {
      const mockScanSender = vi.fn();
      initializeKeyboard(undefined, mockScanSender);
      const keyboard = getKeyboard();

      const result = await keyboard.sendKeyCombination({
        key: "-",
        code: "Minus",
      });

      expect(result).toBe(true);
      expect(mockScanSender).toHaveBeenCalledWith([0x0c]); // Minus scan code
      expect(mockSendKey).not.toHaveBeenCalled(); // keysender NOT used
    });

    it("should include modifier scan codes before the main key", async () => {
      const mockScanSender = vi.fn();
      initializeKeyboard(undefined, mockScanSender);
      const keyboard = getKeyboard();

      const result = await keyboard.sendKeyCombination({
        key: "-",
        code: "Minus",
        modifiers: ["shift"],
      });

      expect(result).toBe(true);
      expect(mockScanSender).toHaveBeenCalledWith([0x2a, 0x0c]); // Shift + Minus
    });

    it("should handle Ctrl+Shift+key correctly", async () => {
      const mockScanSender = vi.fn();
      initializeKeyboard(undefined, mockScanSender);
      const keyboard = getKeyboard();

      const result = await keyboard.sendKeyCombination({
        key: "'",
        code: "Quote",
        modifiers: ["ctrl", "shift"],
      });

      expect(result).toBe(true);
      expect(mockScanSender).toHaveBeenCalledWith([0x1d, 0x2a, 0x28]); // Ctrl + Shift + Quote
    });

    it("should send letter keys via scan codes when code is present", async () => {
      const mockScanSender = vi.fn();
      initializeKeyboard(undefined, mockScanSender);
      const keyboard = getKeyboard();

      const result = await keyboard.sendKeyCombination({
        key: "a",
        code: "KeyA",
      });

      expect(result).toBe(true);
      expect(mockScanSender).toHaveBeenCalledWith([0x1e]); // KeyA scan code
    });

    it("should send extended keys with 0x100 flag", async () => {
      const mockScanSender = vi.fn();
      initializeKeyboard(undefined, mockScanSender);
      const keyboard = getKeyboard();

      const result = await keyboard.sendKeyCombination({
        key: "up",
        code: "ArrowUp",
      });

      expect(result).toBe(true);
      expect(mockScanSender).toHaveBeenCalledWith([0x148]); // ArrowUp extended scan code
    });

    it("should fall back to keysender for unmapped code values", async () => {
      const mockScanSender = vi.fn();
      initializeKeyboard(undefined, mockScanSender);
      const keyboard = getKeyboard();

      const result = await keyboard.sendKeyCombination({
        key: "a",
        code: "UnknownCode",
      });

      expect(result).toBe(true);
      expect(mockScanSender).not.toHaveBeenCalled();
      // keysender fallback is called asynchronously
    });
  });

  describe("pressKeyCombination - scan code path", () => {
    it("should press via scan codes when code and presser are configured", async () => {
      const mockPresser = vi.fn();
      initializeKeyboard(undefined, undefined, mockPresser);
      const keyboard = getKeyboard();

      const result = await keyboard.pressKeyCombination({
        key: "-",
        code: "Minus",
      });

      expect(result).toBe(true);
      expect(mockPresser).toHaveBeenCalledWith([0x0c]);
      expect(mockToggleKey).not.toHaveBeenCalled();
    });

    it("should include modifier scan codes when pressing", async () => {
      const mockPresser = vi.fn();
      initializeKeyboard(undefined, undefined, mockPresser);
      const keyboard = getKeyboard();

      const result = await keyboard.pressKeyCombination({
        key: "a",
        code: "KeyA",
        modifiers: ["ctrl", "shift"],
      });

      expect(result).toBe(true);
      expect(mockPresser).toHaveBeenCalledWith([0x1d, 0x2a, 0x1e]);
    });

    it("should return false on presser error", async () => {
      const mockPresser = vi.fn(() => {
        throw new Error("Test error");
      });
      initializeKeyboard(undefined, undefined, mockPresser);
      const keyboard = getKeyboard();

      const result = await keyboard.pressKeyCombination({
        key: "a",
        code: "KeyA",
      });

      expect(result).toBe(false);
    });
  });

  describe("pressKeyCombination - keysender fallback", () => {
    it("should press via keysender toggleKey when no presser is configured", async () => {
      initializeKeyboard();
      const keyboard = getKeyboard();

      const result = await keyboard.pressKeyCombination({ key: "f1" });

      expect(result).toBe(true);
      expect(mockToggleKey).toHaveBeenCalledWith("f1", true);
    });

    it("should press combination with modifiers via keysender toggleKey", async () => {
      initializeKeyboard();
      const keyboard = getKeyboard();

      const result = await keyboard.pressKeyCombination({
        key: "r",
        modifiers: ["shift"],
      });

      expect(result).toBe(true);
      expect(mockToggleKey).toHaveBeenCalledWith(["shift", "r"], true);
    });

    it("should return false on keysender toggleKey error", async () => {
      mockToggleKey.mockRejectedValueOnce(new Error("Test error"));
      initializeKeyboard();
      const keyboard = getKeyboard();

      const result = await keyboard.pressKeyCombination({ key: "a" });

      expect(result).toBe(false);
    });
  });

  describe("releaseKeyCombination - scan code path", () => {
    it("should release via scan codes when code and releaser are configured", async () => {
      const mockReleaser = vi.fn();
      initializeKeyboard(undefined, undefined, undefined, mockReleaser);
      const keyboard = getKeyboard();

      const result = await keyboard.releaseKeyCombination({
        key: "-",
        code: "Minus",
      });

      expect(result).toBe(true);
      expect(mockReleaser).toHaveBeenCalledWith([0x0c]);
      expect(mockToggleKey).not.toHaveBeenCalled();
    });

    it("should include modifier scan codes when releasing", async () => {
      const mockReleaser = vi.fn();
      initializeKeyboard(undefined, undefined, undefined, mockReleaser);
      const keyboard = getKeyboard();

      const result = await keyboard.releaseKeyCombination({
        key: "a",
        code: "KeyA",
        modifiers: ["shift"],
      });

      expect(result).toBe(true);
      expect(mockReleaser).toHaveBeenCalledWith([0x2a, 0x1e]);
    });

    it("should return false on releaser error", async () => {
      const mockReleaser = vi.fn(() => {
        throw new Error("Test error");
      });
      initializeKeyboard(undefined, undefined, undefined, mockReleaser);
      const keyboard = getKeyboard();

      const result = await keyboard.releaseKeyCombination({
        key: "a",
        code: "KeyA",
      });

      expect(result).toBe(false);
    });
  });

  describe("releaseKeyCombination - keysender fallback", () => {
    it("should release via keysender toggleKey when no releaser is configured", async () => {
      initializeKeyboard();
      const keyboard = getKeyboard();

      const result = await keyboard.releaseKeyCombination({ key: "f1" });

      expect(result).toBe(true);
      expect(mockToggleKey).toHaveBeenCalledWith("f1", false);
    });

    it("should release combination with modifiers via keysender toggleKey", async () => {
      initializeKeyboard();
      const keyboard = getKeyboard();

      const result = await keyboard.releaseKeyCombination({
        key: "s",
        modifiers: ["ctrl", "shift"],
      });

      expect(result).toBe(true);
      expect(mockToggleKey).toHaveBeenCalledWith(["ctrl", "shift", "s"], false);
    });

    it("should return false on keysender toggleKey error", async () => {
      mockToggleKey.mockRejectedValueOnce(new Error("Test error"));
      initializeKeyboard();
      const keyboard = getKeyboard();

      const result = await keyboard.releaseKeyCombination({ key: "a" });

      expect(result).toBe(false);
    });
  });

  describe("sendKeySequence", () => {
    it("should return false when no sequence sender is configured", async () => {
      const keyboard = initializeKeyboard();

      const result = await keyboard.sendKeySequence([{ key: "f1", code: "F1" }]);

      expect(result).toBe(false);
    });

    it("should return false for an empty sequence", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      const result = await keyboard.sendKeySequence([]);

      expect(result).toBe(false);
      expect(mockSequenceSender).not.toHaveBeenCalled();
    });

    it("should send one chord per combination, modifiers first", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      const result = await keyboard.sendKeySequence([
        { key: "f1", code: "F1" },
        { key: "f4", code: "F4" },
      ]);

      expect(result).toBe(true);
      // F1 = 0x3b, F4 = 0x3e (PS/2 Set 1)
      expect(mockSequenceSender).toHaveBeenCalledWith([[0x3b], [0x3e]], 0);
    });

    it("should include modifier scan codes before the main key", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      await keyboard.sendKeySequence([{ key: "f1", code: "F1", modifiers: ["ctrl"] }]);

      // ctrl = 0x1d, F1 = 0x3b
      expect(mockSequenceSender).toHaveBeenCalledWith([[0x1d, 0x3b]], 0);
    });

    it("should forward an explicit holdMs", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      await keyboard.sendKeySequence([{ key: "f1", code: "F1" }], 16);

      expect(mockSequenceSender).toHaveBeenCalledWith([[0x3b]], 16);
    });

    it("should skip (not fall back to keysender) when a combination has no event.code", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      const result = await keyboard.sendKeySequence([{ key: "f1" }, { key: "f4", code: "F4" }]);

      expect(result).toBe(false);
      expect(mockSequenceSender).not.toHaveBeenCalled();
      expect(mockSendKey).not.toHaveBeenCalled();
    });

    it("should skip when a combination's event.code has no scan code", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      const result = await keyboard.sendKeySequence([{ key: "f1", code: "TotallyNotAKey" }]);

      expect(result).toBe(false);
      expect(mockSequenceSender).not.toHaveBeenCalled();
      expect(mockSendKey).not.toHaveBeenCalled();
    });
  });

  // --- Focus before keystrokes (#977) ---
  //
  // The keyboard service is the one layer every deck-core keystroke passes, so
  // it is where the iRacing window is focused: once per emitted keystroke,
  // immediately before the native send, never on a release, and never on a
  // path that sends nothing.

  describe("focus before keystrokes (issue #977)", () => {
    const orderOf = (fn: { mock: { invocationCallOrder: number[] } }): number => fn.mock.invocationCallOrder[0];

    it("sendKeyCombination via scan codes focuses once, before the native tap", async () => {
      const mockScanSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, mockScanSender);

      await keyboard.sendKeyCombination({ key: "a", code: "KeyA" });

      expect(mockFocusBeforeInput).toHaveBeenCalledOnce();
      expect(mockScanSender).toHaveBeenCalledOnce();
      expect(orderOf(mockFocusBeforeInput)).toBeLessThan(orderOf(mockScanSender));
    });

    it("sendKeyCombination via keysender (no event.code) focuses once, before the fallback send", async () => {
      const keyboard = initializeKeyboard();

      await keyboard.sendKeyCombination({ key: "f1" });

      expect(mockFocusBeforeInput).toHaveBeenCalledOnce();
      expect(mockSendKey).toHaveBeenCalledOnce();
      expect(orderOf(mockFocusBeforeInput)).toBeLessThan(orderOf(mockSendKey));
    });

    it("an unmapped event.code focuses exactly once — on the keysender fallback that actually sends", async () => {
      const mockScanSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, mockScanSender);

      await keyboard.sendKeyCombination({ key: "a", code: "UnknownCode" });

      // The fallback is fire-and-forget from the scan-code path.
      await vi.waitFor(() => expect(mockSendKey).toHaveBeenCalledOnce());

      expect(mockScanSender).not.toHaveBeenCalled();
      expect(mockFocusBeforeInput).toHaveBeenCalledOnce();
      expect(orderOf(mockFocusBeforeInput)).toBeLessThan(orderOf(mockSendKey));
    });

    it("sendKey focuses once, before its sender", async () => {
      const keyboard = initializeKeyboard();

      await keyboard.sendKey("f3");

      expect(mockFocusBeforeInput).toHaveBeenCalledOnce();
      expect(orderOf(mockFocusBeforeInput)).toBeLessThan(orderOf(mockSendKey));
    });

    it("pressKeyCombination via scan codes focuses once, before the press; the release never focuses", async () => {
      const mockPresser = vi.fn();
      const mockReleaser = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, mockPresser, mockReleaser);

      await keyboard.pressKeyCombination({ key: "a", code: "KeyA" });

      expect(mockFocusBeforeInput).toHaveBeenCalledOnce();
      expect(orderOf(mockFocusBeforeInput)).toBeLessThan(orderOf(mockPresser));

      await keyboard.releaseKeyCombination({ key: "a", code: "KeyA" });

      expect(mockReleaser).toHaveBeenCalledOnce();
      expect(mockFocusBeforeInput).toHaveBeenCalledOnce();
    });

    it("pressKeyCombination via keysender focuses once, before toggleKey(true); the release never focuses", async () => {
      const keyboard = initializeKeyboard();

      await keyboard.pressKeyCombination({ key: "f1" });

      expect(mockFocusBeforeInput).toHaveBeenCalledOnce();
      expect(orderOf(mockFocusBeforeInput)).toBeLessThan(orderOf(mockToggleKey));

      await keyboard.releaseKeyCombination({ key: "f1" });

      expect(mockToggleKey).toHaveBeenLastCalledWith("f1", false);
      expect(mockFocusBeforeInput).toHaveBeenCalledOnce();
    });

    it("sendKeySequence focuses once, before the batch", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      const sent = await keyboard.sendKeySequence([
        { key: "f1", code: "F1" },
        { key: "f4", code: "F4" },
      ]);

      expect(sent).toBe(true);
      expect(mockFocusBeforeInput).toHaveBeenCalledOnce();
      expect(orderOf(mockFocusBeforeInput)).toBeLessThan(orderOf(mockSequenceSender));
    });

    it("sendKeySequence does not focus when no sequence sender is configured", async () => {
      const keyboard = initializeKeyboard();

      expect(await keyboard.sendKeySequence([{ key: "f1", code: "F1" }])).toBe(false);
      expect(mockFocusBeforeInput).not.toHaveBeenCalled();
    });

    it("sendKeySequence does not focus for an empty sequence", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      expect(await keyboard.sendKeySequence([])).toBe(false);
      expect(mockFocusBeforeInput).not.toHaveBeenCalled();
    });

    it("sendKeySequence does not focus when a chord has no event.code", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      expect(await keyboard.sendKeySequence([{ key: "f1", code: "F1" }, { key: "f4" }])).toBe(false);
      expect(mockSequenceSender).not.toHaveBeenCalled();
      expect(mockFocusBeforeInput).not.toHaveBeenCalled();
    });

    it("sendKeySequence does not focus when a chord's event.code has no scan code", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      expect(await keyboard.sendKeySequence([{ key: "f1", code: "TotallyNotAKey" }])).toBe(false);
      expect(mockSequenceSender).not.toHaveBeenCalled();
      expect(mockFocusBeforeInput).not.toHaveBeenCalled();
    });
  });

  describe("Alt+F24 after a Ctrl+Alt chord (issue #1508)", () => {
    const ALT_F24 = [0x38, 0x76];
    const CTRL_ALT_L: KeyCombination = { key: "l", code: "KeyL", modifiers: ["ctrl", "alt"] };

    it("follows a scan-code tap of a Ctrl+Alt chord with an Alt+F24 tap", async () => {
      const mockScanSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, mockScanSender);

      expect(await keyboard.sendKeyCombination(CTRL_ALT_L)).toBe(true);

      expect(mockScanSender).toHaveBeenCalledTimes(2);
      expect(mockScanSender).toHaveBeenNthCalledWith(1, [0x1d, 0x38, 0x26]);
      expect(mockScanSender).toHaveBeenNthCalledWith(2, ALT_F24);
    });

    it("follows a chord with Shift as well as Ctrl and Alt", async () => {
      const mockScanSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, mockScanSender);

      await keyboard.sendKeyCombination({ key: "l", code: "KeyL", modifiers: ["ctrl", "shift", "alt"] });

      expect(mockScanSender).toHaveBeenLastCalledWith(ALT_F24);
    });

    it.each([
      ["Ctrl only", ["ctrl"]],
      ["Alt only", ["alt"]],
      ["Ctrl+Shift", ["ctrl", "shift"]],
      ["no modifier", []],
    ] as const)("does not follow a %s chord", async (_label, modifiers) => {
      const mockScanSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, mockScanSender);

      await keyboard.sendKeyCombination({ key: "l", code: "KeyL", modifiers: [...modifiers] });

      expect(mockScanSender).toHaveBeenCalledOnce();
    });

    it("does not send the follow-up when the chord itself failed", async () => {
      const mockScanSender = vi.fn(() => {
        throw new Error("send failed");
      });
      const keyboard = initializeKeyboard(undefined, mockScanSender);

      expect(await keyboard.sendKeyCombination(CTRL_ALT_L)).toBe(false);
      expect(mockScanSender).toHaveBeenCalledOnce();
    });

    it("a failing follow-up does not change the chord's result", async () => {
      const mockScanSender = vi
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          throw new Error("follow-up failed");
        });
      const keyboard = initializeKeyboard(undefined, mockScanSender);

      expect(await keyboard.sendKeyCombination(CTRL_ALT_L)).toBe(true);
      expect(mockScanSender).toHaveBeenCalledTimes(2);
    });

    it("follows a keysender tap with the scan-code Alt+F24 once the tap settles", async () => {
      const mockScanSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, mockScanSender);

      expect(await keyboard.sendKeyCombination({ key: "l", modifiers: ["ctrl", "alt"] })).toBe(true);

      expect(mockSendKey).toHaveBeenCalledWith(["ctrl", "alt", "l"]);
      expect(mockScanSender).toHaveBeenCalledWith(ALT_F24);
      expect(mockSendKey.mock.invocationCallOrder[0]).toBeLessThan(mockScanSender.mock.invocationCallOrder[0]);
    });

    it("follows a Ctrl+Alt chord the scan-code map cannot build, after its keysender fallback", async () => {
      const mockScanSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, mockScanSender);

      expect(await keyboard.sendKeyCombination({ key: "l", code: "UnknownCode", modifiers: ["ctrl", "alt"] })).toBe(
        true,
      );

      // The fallback is fire-and-forget from the scan-code path.
      await vi.waitFor(() => expect(mockScanSender).toHaveBeenCalledWith(ALT_F24));
      expect(mockSendKey).toHaveBeenCalledWith(["ctrl", "alt", "l"]);
      expect(mockSendKey.mock.invocationCallOrder[0]).toBeLessThan(mockScanSender.mock.invocationCallOrder[0]);
    });

    it("falls back to a keysender alt+f24 tap without a scan-code sender", async () => {
      const keyboard = initializeKeyboard();

      await keyboard.sendKeyCombination({ key: "l", modifiers: ["ctrl", "alt"] });

      expect(mockSendKey).toHaveBeenCalledTimes(2);
      expect(mockSendKey).toHaveBeenLastCalledWith(["alt", "f24"]);
    });

    it("follows the release of a held Ctrl+Alt chord, not its press", async () => {
      const mockScanSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, mockScanSender, vi.fn(), vi.fn());

      await keyboard.pressKeyCombination(CTRL_ALT_L);
      expect(mockScanSender).not.toHaveBeenCalled();

      await keyboard.releaseKeyCombination(CTRL_ALT_L);
      expect(mockScanSender).toHaveBeenCalledOnce();
      expect(mockScanSender).toHaveBeenCalledWith(ALT_F24);
    });

    it("follows the keysender release of a held Ctrl+Alt chord", async () => {
      const mockScanSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, mockScanSender);
      const legacy: KeyCombination = { key: "l", modifiers: ["ctrl", "alt"] };

      await keyboard.pressKeyCombination(legacy);
      expect(mockScanSender).not.toHaveBeenCalled();

      await keyboard.releaseKeyCombination(legacy);
      expect(mockToggleKey).toHaveBeenLastCalledWith(["ctrl", "alt", "l"], false);
      expect(mockScanSender).toHaveBeenCalledWith(ALT_F24);
    });

    it("follows a sequence containing a Ctrl+Alt chord with one Alt+F24 tap after the batch", async () => {
      const mockScanSender = vi.fn();
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, mockScanSender, undefined, undefined, mockSequenceSender);

      await keyboard.sendKeySequence([{ key: "f1", code: "F1" }, CTRL_ALT_L, CTRL_ALT_L]);

      expect(mockSequenceSender).toHaveBeenCalledOnce();
      expect(mockSequenceSender.mock.calls[0][0]).toHaveLength(3);
      expect(mockScanSender).toHaveBeenCalledOnce();
      expect(mockScanSender).toHaveBeenCalledWith(ALT_F24);
      expect(mockSequenceSender.mock.invocationCallOrder[0]).toBeLessThan(mockScanSender.mock.invocationCallOrder[0]);
    });

    it("does not follow a sequence without a Ctrl+Alt chord, or a skipped one", async () => {
      const mockScanSender = vi.fn();
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, mockScanSender, undefined, undefined, mockSequenceSender);

      await keyboard.sendKeySequence([
        { key: "f1", code: "F1" },
        { key: "f4", code: "F4" },
      ]);
      expect(await keyboard.sendKeySequence([CTRL_ALT_L, { key: "f1", code: "TotallyNotAKey" }])).toBe(false);

      expect(mockScanSender).not.toHaveBeenCalled();
    });

    it("does not focus again for the follow-up", async () => {
      const keyboard = initializeKeyboard(undefined, vi.fn());

      await keyboard.sendKeyCombination(CTRL_ALT_L);

      expect(mockFocusBeforeInput).toHaveBeenCalledOnce();
    });
  });

  describe("_resetKeyboard", () => {
    it("should reset the keyboard service state", () => {
      initializeKeyboard();

      expect(isKeyboardInitialized()).toBe(true);

      _resetKeyboard();

      expect(isKeyboardInitialized()).toBe(false);
    });

    it("should allow re-initialization after reset", () => {
      initializeKeyboard();
      _resetKeyboard();

      expect(() => initializeKeyboard()).not.toThrow();
    });
  });
});
