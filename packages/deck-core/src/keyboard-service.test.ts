import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetKeyboard, getKeyboard, initializeKeyboard, isKeyboardInitialized } from "./keyboard-service.js";
import type { KeyCombination } from "./keyboard-types.js";

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
// (#977), mocked by the same relative path the service imports it from; the
// rest of the module stays real.
const { mockFocusBeforeInput } = vi.hoisted(() => ({ mockFocusBeforeInput: vi.fn() }));

vi.mock("./window-focus-service.js", async (importOriginal) => ({
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

      expect(service).toHaveProperty("sendKeyCombination");
      expect(service).toHaveProperty("pressKeyCombination");
      expect(service).toHaveProperty("releaseKeyCombination");
      expect(service).toHaveProperty("sendKeySequence");
      expect(service).not.toHaveProperty("sendKey");
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

      expect(service).toHaveProperty("sendKeyCombination");
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

    it("should return false on sender error", async () => {
      const mockScanSender = vi.fn(() => {
        throw new Error("Test error");
      });
      initializeKeyboard(undefined, mockScanSender);
      const keyboard = getKeyboard();

      const result = await keyboard.sendKeyCombination({ key: "a", code: "KeyA" });

      expect(result).toBe(false);
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

    it("should skip when a combination has no event.code", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      const result = await keyboard.sendKeySequence([{ key: "f1" }, { key: "f4", code: "F4" }]);

      expect(result).toBe(false);
      expect(mockSequenceSender).not.toHaveBeenCalled();
    });

    it("should skip when a combination's event.code has no scan code", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      const result = await keyboard.sendKeySequence([{ key: "f1", code: "TotallyNotAKey" }]);

      expect(result).toBe(false);
      expect(mockSequenceSender).not.toHaveBeenCalled();
    });

    it("should skip when a combination's event.code is empty", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      const result = await keyboard.sendKeySequence([{ key: "f1", code: "" }]);

      expect(result).toBe(false);
      expect(mockSequenceSender).not.toHaveBeenCalled();
    });
  });

  // --- Scan codes are the only sending path (#1495) ---
  //
  // A tap, press or release whose sender was not injected, or whose
  // combination has no event.code the scan-code map can build, sends nothing,
  // focuses nothing and returns false — the contract sendKeySequence has.

  describe("sends nothing without a scan code (issue #1495)", () => {
    type Method = "sendKeyCombination" | "pressKeyCombination" | "releaseKeyCombination";

    const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    /** Initialize with all three single-combination senders and return them. */
    const withSenders = () => {
      const senders = { tap: vi.fn(), press: vi.fn(), release: vi.fn() };
      const keyboard = initializeKeyboard(
        logger as unknown as Parameters<typeof initializeKeyboard>[0],
        senders.tap,
        senders.press,
        senders.release,
      );

      return { keyboard, senders };
    };

    const expectNothingSent = (senders: ReturnType<typeof withSenders>["senders"]) => {
      expect(senders.tap).not.toHaveBeenCalled();
      expect(senders.press).not.toHaveBeenCalled();
      expect(senders.release).not.toHaveBeenCalled();
      expect(mockFocusBeforeInput).not.toHaveBeenCalled();
    };

    const methods: Method[] = ["sendKeyCombination", "pressKeyCombination", "releaseKeyCombination"];

    describe.each(methods)("%s", (method) => {
      it("returns false and sends nothing for a combination with no event.code", async () => {
        const { keyboard, senders } = withSenders();

        expect(await keyboard[method]({ key: "f1" })).toBe(false);
        expectNothingSent(senders);
        expect(logger.warn).toHaveBeenCalledWith(
          "Key combination has no scan code, nothing sent; re-record the binding",
        );
      });

      it("returns false and sends nothing for a combination with an empty event.code", async () => {
        const { keyboard, senders } = withSenders();

        expect(await keyboard[method]({ key: "f1", code: "", modifiers: ["shift"] })).toBe(false);
        expectNothingSent(senders);
        expect(logger.warn).toHaveBeenCalledOnce();
      });

      it("returns false and sends nothing for an event.code with no scan code", async () => {
        const { keyboard, senders } = withSenders();

        expect(await keyboard[method]({ key: "a", code: "UnknownCode" })).toBe(false);
        expectNothingSent(senders);
        expect(logger.warn).toHaveBeenCalledWith("No scan code for the key combination, nothing sent");
      });

      it("returns false and sends nothing when its scan-code sender was not injected", async () => {
        const keyboard = initializeKeyboard(logger as unknown as Parameters<typeof initializeKeyboard>[0]);

        expect(await keyboard[method]({ key: "a", code: "KeyA" })).toBe(false);
        expect(mockFocusBeforeInput).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledOnce();
      });
    });

    it("uses only the sender matching the method: a tap without a tap sender sends nothing", async () => {
      const press = vi.fn();
      const release = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, press, release);

      expect(await keyboard.sendKeyCombination({ key: "a", code: "KeyA" })).toBe(false);
      expect(press).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(mockFocusBeforeInput).not.toHaveBeenCalled();
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

    // A tap, press or release that sends nothing (no sender, no event.code, an
    // unmapped one) never focuses either: see "sends nothing without a scan
    // code" above.

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

    it.each([
      ["has no event.code", { key: "l", modifiers: ["ctrl", "alt"] }],
      ["has an empty event.code", { key: "l", code: "", modifiers: ["ctrl", "alt"] }],
      ["has an unmapped event.code", { key: "l", code: "UnknownCode", modifiers: ["ctrl", "alt"] }],
      ["has an unknown modifier", { key: "l", code: "KeyL", modifiers: ["ctrl", "alt", "meta"] }],
    ] as const)("sends nothing, and no Alt+F24, for a Ctrl+Alt chord that %s", async (_label, chord) => {
      const mockScanSender = vi.fn();
      const mockPresser = vi.fn();
      const mockReleaser = vi.fn();
      const keyboard = initializeKeyboard(undefined, mockScanSender, mockPresser, mockReleaser);
      // "meta" is outside KeyboardModifier: only a hand-edited settings file holds one.
      const combination = { ...chord, modifiers: [...chord.modifiers] } as KeyCombination;

      expect(await keyboard.sendKeyCombination(combination)).toBe(false);
      expect(await keyboard.pressKeyCombination(combination)).toBe(false);
      expect(await keyboard.releaseKeyCombination(combination)).toBe(false);

      expect(mockScanSender).not.toHaveBeenCalled();
      expect(mockPresser).not.toHaveBeenCalled();
      expect(mockReleaser).not.toHaveBeenCalled();
    });

    it("attempts no Alt+F24 after a released Ctrl+Alt chord without a scan-code sender", async () => {
      const mockPresser = vi.fn();
      const mockReleaser = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, mockPresser, mockReleaser);

      await keyboard.pressKeyCombination(CTRL_ALT_L);
      expect(await keyboard.releaseKeyCombination(CTRL_ALT_L)).toBe(true);

      expect(mockPresser).toHaveBeenCalledOnce();
      expect(mockReleaser).toHaveBeenCalledOnce();
      expect(mockReleaser).toHaveBeenCalledWith([0x1d, 0x38, 0x26]);
    });

    it("attempts no Alt+F24 after a Ctrl+Alt sequence without a scan-code sender", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      expect(await keyboard.sendKeySequence([CTRL_ALT_L])).toBe(true);

      expect(mockSequenceSender).toHaveBeenCalledOnce();
      expect(mockSequenceSender).toHaveBeenCalledWith([[0x1d, 0x38, 0x26]], 0);
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
