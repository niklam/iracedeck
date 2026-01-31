import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetKeyboard, getKeyboard, initializeKeyboard, isKeyboardInitialized } from "./keyboard-service.js";

// Mock the keysender module
const mockSendKey = vi.fn().mockResolvedValue(undefined);

vi.mock("keysender", () => ({
  Hardware: class MockHardware {
    keyboard = {
      sendKey: mockSendKey,
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
