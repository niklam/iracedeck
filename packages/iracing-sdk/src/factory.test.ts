import { describe, expect, it, vi } from "vitest";

import { createCommands } from "./factory.js";
import type { INativeSDK } from "./interfaces.js";

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
    sendChatMessage: vi.fn().mockResolvedValue(true),
  };
}

describe("createCommands (issue #977)", () => {
  it("hands the beforeKeystrokes hook to the chat command", async () => {
    const beforeKeystrokes = vi.fn();
    const native = createMockNative();

    const commands = createCommands(native, undefined, { beforeKeystrokes });
    await commands.chat.sendMessage("hello");

    expect(beforeKeystrokes).toHaveBeenCalledOnce();
  });

  it("builds every command without options", () => {
    const commands = createCommands(createMockNative());

    expect(Object.keys(commands).sort()).toEqual([
      "camera",
      "chat",
      "ffb",
      "pit",
      "replay",
      "telem",
      "texture",
      "videoCapture",
    ]);
  });
});
