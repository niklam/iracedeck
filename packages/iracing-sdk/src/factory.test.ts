import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCommands, createSDK } from "./factory.js";
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

describe("createSDK (issue #1558)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const throwing = (): void => {
    throw new Error("subscriber failed");
  };

  it("passes onSubscriberError to the controller", () => {
    const { controller } = createSDK(undefined, { onSubscriberError: "rethrow" });

    try {
      expect(() => controller.subscribe("throwing", throwing)).toThrow("subscriber failed");
    } finally {
      controller.unsubscribe("throwing");
    }
  });

  it('defaults the controller to "report"', () => {
    const { controller } = createSDK();

    try {
      expect(() => controller.subscribe("throwing", throwing)).not.toThrow();
    } finally {
      controller.unsubscribe("throwing");
    }
  });
});
