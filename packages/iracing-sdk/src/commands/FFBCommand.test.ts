import { beforeEach, describe, expect, it, vi } from "vitest";

import type { INativeSDK } from "../interfaces.js";
import { BroadcastMsg, FFBCommandMode } from "./constants.js";
import { FFBCommand } from "./FFBCommand.js";

function createMockNative(): INativeSDK {
  return {
    startup: vi.fn(),
    shutdown: vi.fn(),
    isConnected: vi.fn(),
    getHeader: vi.fn(),
    getData: vi.fn(),
    waitForData: vi.fn(),
    getSessionInfoStr: vi.fn(),
    getVarHeaderEntry: vi.fn(),
    varNameToIndex: vi.fn(),
    broadcastMsg: vi.fn(),
    sendChatMessage: vi.fn(),
  };
}

// Helper to convert float to low/high 16-bit values (little-endian)
function floatToLowHigh(value: number): { low: number; high: number } {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, true); // little-endian

  return {
    low: view.getUint16(0, true),
    high: view.getUint16(2, true),
  };
}

describe("FFBCommand", () => {
  let mockNative: INativeSDK;
  let ffbCommand: FFBCommand;

  beforeEach(() => {
    mockNative = createMockNative();
    ffbCommand = new FFBCommand(mockNative);
  });

  describe("setMaxForce", () => {
    it("should send FFBCommand with MaxForce mode", () => {
      ffbCommand.setMaxForce(50);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.FFBCommand,
        FFBCommandMode.MaxForce,
        expect.any(Number),
        expect.any(Number),
      );
    });

    it("should correctly encode float value to two 16-bit integers", () => {
      const forceNm = 50.5;
      const { low, high } = floatToLowHigh(forceNm);

      ffbCommand.setMaxForce(forceNm);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.FFBCommand, FFBCommandMode.MaxForce, low, high);
    });

    it("should handle zero value", () => {
      const { low, high } = floatToLowHigh(0);

      ffbCommand.setMaxForce(0);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.FFBCommand, FFBCommandMode.MaxForce, low, high);
    });

    it("should handle small float values", () => {
      const forceNm = 0.5;
      const { low, high } = floatToLowHigh(forceNm);

      ffbCommand.setMaxForce(forceNm);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.FFBCommand, FFBCommandMode.MaxForce, low, high);
    });

    it("should handle large float values", () => {
      const forceNm = 100.0;
      const { low, high } = floatToLowHigh(forceNm);

      ffbCommand.setMaxForce(forceNm);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.FFBCommand, FFBCommandMode.MaxForce, low, high);
    });

    it("should handle negative values", () => {
      const forceNm = -25.0;
      const { low, high } = floatToLowHigh(forceNm);

      ffbCommand.setMaxForce(forceNm);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.FFBCommand, FFBCommandMode.MaxForce, low, high);
    });

    it("should return true", () => {
      expect(ffbCommand.setMaxForce(50)).toBe(true);
    });
  });
});
