import { beforeEach, describe, expect, it, vi } from "vitest";

import type { INativeSDK } from "../interfaces.js";
import { BroadcastMsg, TelemCommandMode } from "./constants.js";
import { TelemCommand } from "./TelemCommand.js";

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

describe("TelemCommand", () => {
  let mockNative: INativeSDK;
  let telemCommand: TelemCommand;

  beforeEach(() => {
    mockNative = createMockNative();
    telemCommand = new TelemCommand(mockNative);
  });

  describe("stop", () => {
    it("should send TelemCommand with Stop mode", () => {
      telemCommand.stop();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.TelemCommand, TelemCommandMode.Stop, 0, 0);
    });

    it("should return true", () => {
      expect(telemCommand.stop()).toBe(true);
    });
  });

  describe("start", () => {
    it("should send TelemCommand with Start mode", () => {
      telemCommand.start();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.TelemCommand, TelemCommandMode.Start, 0, 0);
    });

    it("should return true", () => {
      expect(telemCommand.start()).toBe(true);
    });
  });

  describe("restart", () => {
    it("should send TelemCommand with Restart mode", () => {
      telemCommand.restart();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.TelemCommand, TelemCommandMode.Restart, 0, 0);
    });

    it("should return true", () => {
      expect(telemCommand.restart()).toBe(true);
    });
  });

  describe("return values", () => {
    it("all methods should return true", () => {
      expect(telemCommand.stop()).toBe(true);
      expect(telemCommand.start()).toBe(true);
      expect(telemCommand.restart()).toBe(true);
    });
  });
});
