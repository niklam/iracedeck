import { beforeEach, describe, expect, it, vi } from "vitest";

import type { INativeSDK } from "../interfaces.js";
import { BroadcastMsg, ReloadTexturesMode } from "./constants.js";
import { TextureCommand } from "./TextureCommand.js";

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

describe("TextureCommand", () => {
  let mockNative: INativeSDK;
  let textureCommand: TextureCommand;

  beforeEach(() => {
    mockNative = createMockNative();
    textureCommand = new TextureCommand(mockNative);
  });

  describe("reloadAll", () => {
    it("should send ReloadTextures with All mode", () => {
      textureCommand.reloadAll();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReloadTextures, ReloadTexturesMode.All, 0, 0);
    });

    it("should return true", () => {
      expect(textureCommand.reloadAll()).toBe(true);
    });
  });

  describe("reloadCar", () => {
    it("should send ReloadTextures with CarIdx mode and car index", () => {
      textureCommand.reloadCar(5);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.ReloadTextures,
        ReloadTexturesMode.CarIdx,
        5,
        0,
      );
    });

    it("should handle car index 0", () => {
      textureCommand.reloadCar(0);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.ReloadTextures,
        ReloadTexturesMode.CarIdx,
        0,
        0,
      );
    });

    it("should handle high car indices", () => {
      textureCommand.reloadCar(63);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.ReloadTextures,
        ReloadTexturesMode.CarIdx,
        63,
        0,
      );
    });

    it("should return true", () => {
      expect(textureCommand.reloadCar(10)).toBe(true);
    });
  });

  describe("return values", () => {
    it("all methods should return true", () => {
      expect(textureCommand.reloadAll()).toBe(true);
      expect(textureCommand.reloadCar(0)).toBe(true);
    });
  });
});
