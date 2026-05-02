import { beforeEach, describe, expect, it, vi } from "vitest";

import { _resetClipboard, getClipboard, initializeClipboard, isClipboardInitialized } from "./clipboard-service.js";

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withLevel: vi.fn(),
  createScope: vi.fn(),
};

describe("Clipboard Service", () => {
  beforeEach(() => {
    _resetClipboard();
    vi.clearAllMocks();
  });

  describe("initialization", () => {
    it("starts uninitialized", () => {
      expect(isClipboardInitialized()).toBe(false);
    });

    it("becomes initialized after initializeClipboard", () => {
      initializeClipboard(mockLogger, () => true);
      expect(isClipboardInitialized()).toBe(true);
    });

    it("throws if initialized twice", () => {
      initializeClipboard(mockLogger, () => true);
      expect(() => initializeClipboard(mockLogger, () => true)).toThrow(/already initialized/);
    });

    it("throws when getClipboard called before init", () => {
      expect(() => getClipboard()).toThrow(/not initialized/);
    });
  });

  describe("setClipboardText", () => {
    it("returns true when writer succeeds", () => {
      const writer = vi.fn().mockReturnValue(true);
      initializeClipboard(mockLogger, writer);

      const ok = getClipboard().setClipboardText("!clear ");

      expect(ok).toBe(true);
      expect(writer).toHaveBeenCalledTimes(1);
      expect(writer).toHaveBeenCalledWith("!clear ");
    });

    it("returns false when writer returns false", () => {
      const writer = vi.fn().mockReturnValue(false);
      initializeClipboard(mockLogger, writer);

      const ok = getClipboard().setClipboardText("test");

      expect(ok).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("returns false when no writer is configured", () => {
      initializeClipboard(mockLogger);

      const ok = getClipboard().setClipboardText("test");

      expect(ok).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringMatching(/no writer/i));
    });

    it("returns false when writer throws", () => {
      const writer = vi.fn().mockImplementation(() => {
        throw new Error("clipboard locked");
      });
      initializeClipboard(mockLogger, writer);

      const ok = getClipboard().setClipboardText("test");

      expect(ok).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("clipboard locked"));
    });

    it("preserves trailing whitespace in payload", () => {
      const writer = vi.fn().mockReturnValue(true);
      initializeClipboard(mockLogger, writer);

      getClipboard().setClipboardText("!dq ");

      expect(writer).toHaveBeenCalledWith("!dq ");
    });
  });
});
