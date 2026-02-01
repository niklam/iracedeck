import { beforeEach, describe, expect, it, vi } from "vitest";

import { Chat, CHAT_GLOBAL_KEYS, generateChatSvg } from "./chat.js";

const {
  mockBeginChat,
  mockReply,
  mockCancel,
  mockSendMessage,
  mockMacro,
  mockGetCommands,
  mockSendKeyCombination,
  mockParseKeyBinding,
  mockGetGlobalSettings,
} = vi.hoisted(() => ({
  mockBeginChat: vi.fn(() => true),
  mockReply: vi.fn(() => true),
  mockCancel: vi.fn(() => true),
  mockSendMessage: vi.fn(() => true),
  mockMacro: vi.fn(() => true),
  mockGetCommands: vi.fn(() => ({
    chat: {
      beginChat: mockBeginChat,
      reply: mockReply,
      cancel: mockCancel,
      sendMessage: mockSendMessage,
      macro: mockMacro,
    },
  })),
  mockSendKeyCombination: vi.fn().mockResolvedValue(true),
  mockParseKeyBinding: vi.fn(),
  mockGetGlobalSettings: vi.fn(() => ({})),
}));

vi.mock("@elgato/streamdeck", () => ({
  default: {
    logger: {
      createScope: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
      })),
    },
  },
  action: () => (target: unknown) => target,
}));

vi.mock("@iracedeck/stream-deck-shared", () => ({
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    async onWillDisappear() {}
  },
  createSDLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) => {
    if (b.modifiers?.length) {
      return `${b.modifiers.join("+")}+${b.key}`;
    }

    return b.key;
  }),
  getCommands: mockGetCommands,
  getGlobalSettings: mockGetGlobalSettings,
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: mockSendKeyCombination,
    pressKeyCombination: vi.fn().mockResolvedValue(true),
    releaseKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseKeyBinding: mockParseKeyBinding,
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.iconContent || ""}${data.labelLine1 || ""}${data.labelLine2 || ""}</svg>`;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

/** Create a minimal fake event with the given action ID and settings. */
function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
  return {
    action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn() },
    payload: { settings },
  };
}

describe("Chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constants", () => {
    it("should map keyboard modes to correct global settings keys", () => {
      expect(CHAT_GLOBAL_KEYS["whisper"]).toBe("chatWhisper");
    });

    it("should not contain SDK-based modes", () => {
      expect(CHAT_GLOBAL_KEYS["open-chat"]).toBeUndefined();
      expect(CHAT_GLOBAL_KEYS["reply"]).toBeUndefined();
      expect(CHAT_GLOBAL_KEYS["respond-pm"]).toBeUndefined();
      expect(CHAT_GLOBAL_KEYS["cancel"]).toBeUndefined();
      expect(CHAT_GLOBAL_KEYS["send-message"]).toBeUndefined();
      expect(CHAT_GLOBAL_KEYS["macro"]).toBeUndefined();
    });
  });

  describe("generateChatSvg", () => {
    const allModes = [
      "open-chat",
      "reply",
      "whisper",
      "respond-pm",
      "cancel",
      "send-message",
      "macro",
    ] as const;

    it.each(allModes)("should generate a valid data URI for %s", (mode) => {
      const result = generateChatSvg({ mode, message: "", macroNumber: 1 });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for different modes", () => {
      const icons = allModes.map((mode) => generateChatSvg({ mode, message: "", macroNumber: 1 }));

      for (let i = 0; i < icons.length; i++) {
        for (let j = i + 1; j < icons.length; j++) {
          expect(icons[i]).not.toBe(icons[j]);
        }
      }
    });

    it("should include correct labels for all modes", () => {
      const expectedLabels: Record<string, { line1: string; line2: string }> = {
        "open-chat": { line1: "OPEN", line2: "CHAT" },
        reply: { line1: "REPLY", line2: "CHAT" },
        whisper: { line1: "WHISPER", line2: "CHAT" },
        "respond-pm": { line1: "RESPOND", line2: "LAST PM" },
        cancel: { line1: "CANCEL", line2: "CHAT" },
        "send-message": { line1: "SEND", line2: "MESSAGE" },
        macro: { line1: "CHAT", line2: "MACRO" },
      };

      for (const [mode, labels] of Object.entries(expectedLabels)) {
        const result = generateChatSvg({ mode: mode as any, message: "", macroNumber: 1 });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.line1);
        expect(decoded).toContain(labels.line2);
      }
    });

    it("should fall back to open-chat defaults for unspecified settings", () => {
      const result = generateChatSvg({} as any);
      const decoded = decodeURIComponent(result);

      expect(result).toContain("data:image/svg+xml");
      expect(decoded).toContain("OPEN");
    });
  });

  describe("key press behavior (SDK modes)", () => {
    let action: Chat;

    beforeEach(() => {
      action = new Chat();
    });

    it("should call chat.beginChat() on keyDown for open-chat", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "open-chat" }) as any);

      expect(mockBeginChat).toHaveBeenCalledOnce();
      expect(mockReply).not.toHaveBeenCalled();
      expect(mockCancel).not.toHaveBeenCalled();
    });

    it("should call chat.reply() on keyDown for reply", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "reply" }) as any);

      expect(mockReply).toHaveBeenCalledOnce();
      expect(mockBeginChat).not.toHaveBeenCalled();
    });

    it("should call chat.reply() on keyDown for respond-pm", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "respond-pm" }) as any);

      expect(mockReply).toHaveBeenCalledOnce();
      expect(mockBeginChat).not.toHaveBeenCalled();
    });

    it("should call chat.cancel() on keyDown for cancel", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "cancel" }) as any);

      expect(mockCancel).toHaveBeenCalledOnce();
      expect(mockBeginChat).not.toHaveBeenCalled();
    });

    it("should call chat.sendMessage() on keyDown for send-message", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "send-message", message: "Hello!" }) as any);

      expect(mockSendMessage).toHaveBeenCalledWith("Hello!");
    });

    it("should not call chat.sendMessage() when message is empty", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "send-message", message: "" }) as any);

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("should not call chat.sendMessage() when message is whitespace only", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "send-message", message: "   " }) as any);

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("should call chat.macro() on keyDown for macro", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "macro", macroNumber: 5 }) as any);

      expect(mockMacro).toHaveBeenCalledWith(5);
    });

    it("should default to open-chat when no mode is specified", async () => {
      await action.onKeyDown(fakeEvent("action-1", {}) as any);

      expect(mockBeginChat).toHaveBeenCalledOnce();
    });
  });

  describe("key press behavior (keyboard modes)", () => {
    let action: Chat;

    beforeEach(() => {
      action = new Chat();
      mockParseKeyBinding.mockReturnValue({ key: "slash", modifiers: [], code: 53 });
      mockGetGlobalSettings.mockReturnValue({
        chatWhisper: '{"key":"slash","modifiers":[],"code":53}',
      });
    });

    it("should call sendKeyCombination for whisper", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "whisper" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should warn when no key binding configured for whisper", async () => {
      mockParseKeyBinding.mockReturnValue(null);

      await action.onKeyDown(fakeEvent("action-1", { mode: "whisper" }) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should not call SDK commands for keyboard modes", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "whisper" }) as any);

      expect(mockBeginChat).not.toHaveBeenCalled();
      expect(mockReply).not.toHaveBeenCalled();
      expect(mockCancel).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockMacro).not.toHaveBeenCalled();
    });
  });

  describe("encoder behavior", () => {
    let action: Chat;

    beforeEach(() => {
      action = new Chat();
    });

    it("should trigger same action as keyDown on dialDown", async () => {
      await action.onDialDown(fakeEvent("action-1", { mode: "open-chat" }) as any);

      expect(mockBeginChat).toHaveBeenCalledOnce();
    });

    it("should trigger macro on dialDown for macro mode", async () => {
      await action.onDialDown(fakeEvent("action-1", { mode: "macro", macroNumber: 3 }) as any);

      expect(mockMacro).toHaveBeenCalledWith(3);
    });

    it("should not trigger any action on dialRotate", async () => {
      await action.onDialRotate({
        action: { id: "action-1", setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings: { mode: "open-chat" }, ticks: 1 },
      } as any);

      expect(mockBeginChat).not.toHaveBeenCalled();
      expect(mockReply).not.toHaveBeenCalled();
      expect(mockCancel).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockMacro).not.toHaveBeenCalled();
      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });
  });
});
