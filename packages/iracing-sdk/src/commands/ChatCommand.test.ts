import { beforeEach, describe, expect, it, vi } from "vitest";

import type { INativeSDK } from "../interfaces.js";
import { ChatCommand } from "./ChatCommand.js";
import { BroadcastMsg, ChatCommandMode } from "./constants.js";

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

describe("ChatCommand", () => {
  let mockNative: INativeSDK;
  let chatCommand: ChatCommand;

  beforeEach(() => {
    mockNative = createMockNative();
    chatCommand = new ChatCommand(mockNative);
  });

  describe("macro", () => {
    it("should send macro command with 0-based index", () => {
      chatCommand.macro(1);

      // app.ini uses 1-based, API uses 0-based
      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ChatCommand, ChatCommandMode.Macro, 0, 0);
    });

    it("should convert macro number 15 to index 14", () => {
      chatCommand.macro(15);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ChatCommand, ChatCommandMode.Macro, 14, 0);
    });

    it("should return false for macro number less than 1", () => {
      const result = chatCommand.macro(0);

      expect(result).toBe(false);
      expect(mockNative.broadcastMsg).not.toHaveBeenCalled();
    });

    it("should return false for macro number greater than 15", () => {
      const result = chatCommand.macro(16);

      expect(result).toBe(false);
      expect(mockNative.broadcastMsg).not.toHaveBeenCalled();
    });

    it("should return false for negative macro number", () => {
      const result = chatCommand.macro(-1);

      expect(result).toBe(false);
      expect(mockNative.broadcastMsg).not.toHaveBeenCalled();
    });

    it("should return true for valid macro numbers", () => {
      expect(chatCommand.macro(1)).toBe(true);
      expect(chatCommand.macro(8)).toBe(true);
      expect(chatCommand.macro(15)).toBe(true);
    });
  });

  describe("beginChat", () => {
    it("should send BeginChat command", () => {
      chatCommand.beginChat();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ChatCommand, ChatCommandMode.BeginChat, 0, 0);
    });

    it("should return true", () => {
      expect(chatCommand.beginChat()).toBe(true);
    });
  });

  describe("reply", () => {
    it("should send Reply command", () => {
      chatCommand.reply();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ChatCommand, ChatCommandMode.Reply, 0, 0);
    });

    it("should return true", () => {
      expect(chatCommand.reply()).toBe(true);
    });
  });

  describe("cancel", () => {
    it("should send Cancel command", () => {
      chatCommand.cancel();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ChatCommand, ChatCommandMode.Cancel, 0, 0);
    });

    it("should return true", () => {
      expect(chatCommand.cancel()).toBe(true);
    });
  });

  describe("sendMessage", () => {
    it("should call native sendChatMessage with message", async () => {
      vi.mocked(mockNative.sendChatMessage).mockResolvedValue(true);

      await chatCommand.sendMessage("Hello world");

      expect(mockNative.sendChatMessage).toHaveBeenCalledWith("Hello world", undefined, undefined, undefined);
    });

    it("should forward timing delays to native sendChatMessage", async () => {
      vi.mocked(mockNative.sendChatMessage).mockResolvedValue(true);

      await chatCommand.sendMessage("Hello world", {
        openToPasteDelayMs: 350,
        pasteToEnterDelayMs: 500,
        enterToCloseDelayMs: 600,
      });

      expect(mockNative.sendChatMessage).toHaveBeenCalledWith("Hello world", 350, 500, 600);
    });

    it("should return true when sendChatMessage succeeds", async () => {
      vi.mocked(mockNative.sendChatMessage).mockResolvedValue(true);

      const result = await chatCommand.sendMessage("Test message");

      expect(result).toBe(true);
    });

    it("should return false when sendChatMessage fails", async () => {
      vi.mocked(mockNative.sendChatMessage).mockResolvedValue(false);

      const result = await chatCommand.sendMessage("Test message");

      expect(result).toBe(false);
    });

    it("should return false for empty message", async () => {
      const result = await chatCommand.sendMessage("");

      expect(result).toBe(false);
      expect(mockNative.sendChatMessage).not.toHaveBeenCalled();
    });

    it("should return false for whitespace-only message", async () => {
      const result = await chatCommand.sendMessage("   ");

      expect(result).toBe(false);
      expect(mockNative.sendChatMessage).not.toHaveBeenCalled();
    });

    it("should return false for null-ish message", async () => {
      // Testing edge case where message might be coerced
      const result = await chatCommand.sendMessage(null as unknown as string);

      expect(result).toBe(false);
      expect(mockNative.sendChatMessage).not.toHaveBeenCalled();
    });

    it("should return false when sendChatMessage rejects", async () => {
      vi.mocked(mockNative.sendChatMessage).mockRejectedValue(new Error("Native error"));

      const result = await chatCommand.sendMessage("Test message");

      expect(result).toBe(false);
    });

    it("should handle messages with special characters", async () => {
      vi.mocked(mockNative.sendChatMessage).mockResolvedValue(true);

      const result = await chatCommand.sendMessage("Hello! @driver #1 - good race!");

      expect(result).toBe(true);
      expect(mockNative.sendChatMessage).toHaveBeenCalledWith(
        "Hello! @driver #1 - good race!",
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe("return values", () => {
    it("beginChat, reply, cancel should always return true", () => {
      expect(chatCommand.beginChat()).toBe(true);
      expect(chatCommand.reply()).toBe(true);
      expect(chatCommand.cancel()).toBe(true);
    });
  });
});
