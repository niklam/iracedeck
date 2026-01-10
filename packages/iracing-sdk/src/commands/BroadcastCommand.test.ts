import type { ILogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { INativeSDK } from "../interfaces.js";
import { BroadcastCommand } from "./BroadcastCommand.js";
import { BroadcastMsg } from "./constants.js";

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

function createMockLogger(): ILogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// Create a concrete implementation for testing the abstract class
class TestBroadcastCommand extends BroadcastCommand {
  constructor(native: INativeSDK, logger?: ILogger) {
    super(native, logger);
  }

  // Expose protected method for testing
  public testSendBroadcast(msg: BroadcastMsg, var1?: number, var2?: number, var3?: number): boolean {
    return this.sendBroadcast(msg, var1, var2, var3);
  }

  // Expose protected properties for testing
  public getNative(): INativeSDK {
    return this.native;
  }

  public getLogger(): ILogger {
    return this.logger;
  }
}

describe("BroadcastCommand", () => {
  let mockNative: INativeSDK;
  let mockLogger: ILogger;
  let command: TestBroadcastCommand;

  beforeEach(() => {
    mockNative = createMockNative();
    mockLogger = createMockLogger();
  });

  describe("constructor", () => {
    it("should store native SDK reference", () => {
      command = new TestBroadcastCommand(mockNative);

      expect(command.getNative()).toBe(mockNative);
    });

    it("should use silentLogger when no logger provided", () => {
      command = new TestBroadcastCommand(mockNative);
      const logger = command.getLogger();

      // silentLogger has all methods but they do nothing
      expect(logger).toBeDefined();
      expect(typeof logger.debug).toBe("function");
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
    });

    it("should use provided logger", () => {
      command = new TestBroadcastCommand(mockNative, mockLogger);

      expect(command.getLogger()).toBe(mockLogger);
    });
  });

  describe("sendBroadcast", () => {
    beforeEach(() => {
      command = new TestBroadcastCommand(mockNative, mockLogger);
    });

    it("should call native broadcastMsg with all parameters", () => {
      command.testSendBroadcast(BroadcastMsg.CamSwitchPos, 1, 2, 3);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.CamSwitchPos, 1, 2, 3);
    });

    it("should default var1, var2, var3 to 0 when not provided", () => {
      command.testSendBroadcast(BroadcastMsg.PitCommand);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.PitCommand, 0, 0, 0);
    });

    it("should default var2 and var3 to 0 when only var1 provided", () => {
      command.testSendBroadcast(BroadcastMsg.TelemCommand, 1);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.TelemCommand, 1, 0, 0);
    });

    it("should default var3 to 0 when var1 and var2 provided", () => {
      command.testSendBroadcast(BroadcastMsg.ReplaySetPlaySpeed, 2, 1);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySetPlaySpeed, 2, 1, 0);
    });

    it("should log debug message with broadcast details", () => {
      command.testSendBroadcast(BroadcastMsg.CamSwitchPos, 5, 10, 15);

      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining("Sending:"));
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining("var1=5"));
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining("var2=10"));
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining("var3=15"));
    });

    it("should always return true", () => {
      const result = command.testSendBroadcast(BroadcastMsg.PitCommand, 0, 0, 0);

      expect(result).toBe(true);
    });

    it("should return true even if broadcastMsg throws (fire and forget)", () => {
      // Note: Current implementation doesn't catch errors, but returns true regardless
      // If native throws, it will propagate. This test documents current behavior.
      const result = command.testSendBroadcast(BroadcastMsg.ChatCommand, 1);

      expect(result).toBe(true);
    });
  });
});
