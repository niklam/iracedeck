import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetMousePointer,
  DEFAULT_POINTER_X_FRACTION,
  DEFAULT_POINTER_Y_FRACTION,
  initMousePointer,
  movePointerToSim,
  PointerMoveResult,
} from "./mouse-pointer-service.js";

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withLevel: vi.fn(),
  createScope: vi.fn(),
};

describe("Mouse Pointer Service", () => {
  beforeEach(() => {
    _resetMousePointer();
    vi.clearAllMocks();
  });

  describe("initialization", () => {
    it("throws if initialized twice", () => {
      initMousePointer(mockLogger, () => PointerMoveResult.Moved);
      expect(() => initMousePointer(mockLogger, () => PointerMoveResult.Moved)).toThrow(/already initialized/);
    });

    it("returns null when no mover is configured", () => {
      // Silent by design: before init there is no injected logger to warn through.
      expect(movePointerToSim()).toBeNull();
    });

    it("does not throw when called before init", () => {
      expect(() => movePointerToSim()).not.toThrow();
    });
  });

  describe("target", () => {
    it("parks the pointer horizontally centered, one eighth down", () => {
      expect(DEFAULT_POINTER_X_FRACTION).toBe(0.5);
      expect(DEFAULT_POINTER_Y_FRACTION).toBe(0.125);
    });

    it("uses the default fractions when none are given", () => {
      const mover = vi.fn(() => PointerMoveResult.Moved);
      initMousePointer(mockLogger, mover);

      expect(movePointerToSim()).toBe(PointerMoveResult.Moved);
      expect(mover).toHaveBeenCalledWith(DEFAULT_POINTER_X_FRACTION, DEFAULT_POINTER_Y_FRACTION);
    });

    it("passes explicit fractions through verbatim", () => {
      const mover = vi.fn(() => PointerMoveResult.Moved);
      initMousePointer(mockLogger, mover);

      movePointerToSim(0.25, 0.75);

      expect(mover).toHaveBeenCalledWith(0.25, 0.75);
    });
  });

  describe("result handling", () => {
    it("logs a successful move at debug, not warn", () => {
      initMousePointer(mockLogger, () => PointerMoveResult.Moved);

      movePointerToSim();

      expect(mockLogger.debug).toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("warns when the window is not found", () => {
      initMousePointer(mockLogger, () => PointerMoveResult.WindowNotFound);

      expect(movePointerToSim()).toBe(PointerMoveResult.WindowNotFound);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("not found"));
    });

    it("warns when the move fails", () => {
      initMousePointer(mockLogger, () => PointerMoveResult.Failed);

      expect(movePointerToSim()).toBe(PointerMoveResult.Failed);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("minimized"));
    });

    it("warns on an unexpected result code", () => {
      initMousePointer(mockLogger, () => 99 as never);

      movePointerToSim();

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Unexpected"));
    });

    it("returns null and warns when the mover throws", () => {
      initMousePointer(mockLogger, () => {
        throw new Error("boom");
      });

      expect(movePointerToSim()).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    });
  });

  describe("result code contract", () => {
    it("matches the native PointerMoveResult numbering", () => {
      expect(PointerMoveResult.Moved).toBe(0);
      expect(PointerMoveResult.WindowNotFound).toBe(1);
      expect(PointerMoveResult.Failed).toBe(2);
    });
  });
});
