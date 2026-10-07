import { buildTemplateContext, type TemplateContext, templateContextFromMaps } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Chat,
  CHAT_GLOBAL_KEYS,
  ChatSettings,
  generateChatSvg,
  generateMacroSvg,
  generateSendMessageSvg,
  hasTemplateVars,
} from "./chat.js";

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
  mockTapBinding,
  mockFocusBeforeInput,
} = vi.hoisted(() => ({
  mockBeginChat: vi.fn(() => true),
  mockReply: vi.fn(() => true),
  mockCancel: vi.fn(() => true),
  mockSendMessage: vi.fn(async () => true),
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
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
  mockFocusBeforeInput: vi.fn(),
}));

vi.mock("@iracedeck/icons/chat/open-chat.svg", () => ({
  default: "<svg>open-chat-icon</svg>",
}));
vi.mock("@iracedeck/icons/chat/reply.svg", () => ({
  default: "<svg>reply-icon</svg>",
}));
vi.mock("@iracedeck/icons/chat/whisper.svg", () => ({
  default: "<svg>whisper-icon</svg>",
}));
vi.mock("@iracedeck/icons/chat/cancel.svg", () => ({
  default: "<svg>cancel-icon</svg>",
}));
vi.mock("@iracedeck/icons/chat/toggle.svg", () => ({
  default: "<svg>toggle-icon</svg>",
}));

// The real iracing-sdk, with buildTemplateContext wrapped in a spy so the tests
// can assert the display path never builds its own context (#1337).
vi.mock("@iracedeck/iracing-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/iracing-sdk")>();

  return { ...actual, buildTemplateContext: vi.fn(actual.buildTemplateContext) };
});

vi.mock("@iracedeck/deck-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/deck-iracing")>()),
  getCommands: mockGetCommands,
}));

vi.mock("@iracedeck/deck-core", async () => ({
  // The real throttle from deck-core's source: the refresh tests drive its
  // leading/trailing window with fake timers.
  IconUpdateThrottle: (
    await vi.importActual<typeof import("../../../../deck-core/src/icon-update-throttle.js")>(
      "../../../../deck-core/src/icon-update-throttle.js",
    )
  ).IconUpdateThrottle,
  CommonSettings: {
    extend: () => {
      const defaults = {
        mode: "send-message",
        message: "",
        macroNumber: 1,
        iconColor: "#4a90d9",
        keyText: "",
        fontSize: 11,
      };
      const schema = {
        parse: (data: Record<string, unknown>) => ({ ...defaults, ...data }),
        safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...defaults, ...data } }),
      };

      return schema;
    },
    parse: (data: Record<string, unknown>) => ({ ...data }),
    safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
  },
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sdkController = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getCurrentTelemetry: vi.fn(),
      getCurrentTemplateContext: vi.fn((): TemplateContext | null => null),
    };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
    updateKeyImage = vi.fn().mockResolvedValue(true);
    tapBinding = mockTapBinding;
    holdBinding = vi.fn().mockResolvedValue(undefined);
    releaseBinding = vi.fn().mockResolvedValue(undefined);
    setActiveBinding = vi.fn();
    isBindingMissing = vi.fn(() => false);
    async onWillAppear() {}
    async onDidReceiveSettings() {}
    async onWillDisappear() {}
  },
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) => {
    if (b.modifiers?.length) {
      return `${b.modifiers.join("+")}+${b.key}`;
    }

    return b.key;
  }),
  generateIconText: vi.fn(
    ({ text, fontSize }: { text: string; fontSize: number }) => `<text font-size="${fontSize}">${text}</text>`,
  ),
  focusIRacingBeforeInput: mockFocusBeforeInput,
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  getGlobalSettings: mockGetGlobalSettings,
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: mockSendKeyCombination,
    pressKeyCombination: vi.fn().mockResolvedValue(true),
    releaseKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseBinding: mockParseKeyBinding,
  parseKeyBinding: mockParseKeyBinding,
  isSimHubBinding: vi.fn(
    (v: unknown) => v !== null && typeof v === "object" && (v as Record<string, unknown>).type === "simhub",
  ),
  isSimHubInitialized: vi.fn(() => false),
  getSimHub: vi.fn(() => ({
    startRole: vi.fn().mockResolvedValue(true),
    stopRole: vi.fn().mockResolvedValue(true),
  })),
  getGlobalTitleSettings: vi.fn(() => ({})),
  resolveBorderSettings: vi.fn((_svg: unknown, _global: unknown, _overrides?: unknown, _stateColor?: string) => ({
    enabled: false,
    borderWidth: 7,
    borderColor: "#00aaff",
    glowEnabled: true,
    glowWidth: 18,
  })),
  resolveGraphicSettings: vi.fn(() => ({ scale: 1 })),
  resolveTitleSettings: vi.fn((_svg: unknown, _global: unknown, _overrides: unknown, defaultTitle?: string) => ({
    showTitle: true,
    showGraphics: true,
    titleText: defaultTitle ?? "",
    bold: true,
    fontSize: 18,
    position: "bottom" as const,
    customPosition: 0,
  })),
  assembleIcon: vi.fn(
    ({
      graphicSvg,
      colors,
      title,
    }: {
      graphicSvg: string;
      colors: Record<string, string>;
      title: { titleText: string };
    }) => {
      const colorStr = Object.values(colors ?? {}).join(" ");
      const encoded = encodeURIComponent(`<svg>${graphicSvg}${colorStr}${title?.titleText ?? ""}</svg>`);

      return `data:image/svg+xml,${encoded}`;
    },
  ),
  resolveIconColors: vi.fn((_svg, _global, _overrides) => ({})),
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.iconContent || ""}${data.color || ""}${data.textElement || ""}${data.mainLabel || data.labelLine1 || ""}${data.subLabel || data.labelLine2 || ""}</svg>`;
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

type ChatMode = "send-message" | "macro" | "reply" | "whisper" | "toggle" | "open-chat" | "cancel";

/** Helper to build chat settings for test functions */
function chatSettings(
  overrides: Partial<{
    mode: ChatMode;
    message: string;
    macroNumber: number;
    iconColor: string;
    keyText: string;
    fontSize: number;
  }> = {},
): ChatSettings {
  return ChatSettings.parse({
    mode: overrides.mode ?? "send-message",
    message: overrides.message ?? "",
    macroNumber: overrides.macroNumber ?? 1,
    iconColor: overrides.iconColor ?? "#4a90d9",
    keyText: overrides.keyText ?? "",
    fontSize: overrides.fontSize ?? 11,
  });
}

describe("Chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constants", () => {
    it("should map keyboard modes to correct global settings keys", () => {
      expect(CHAT_GLOBAL_KEYS["whisper"]).toBe("chatWhisper");
      expect(CHAT_GLOBAL_KEYS["toggle"]).toBe("chatToggle");
    });

    it("should not contain SDK-based modes", () => {
      expect(CHAT_GLOBAL_KEYS["open-chat"]).toBeUndefined();
      expect(CHAT_GLOBAL_KEYS["reply"]).toBeUndefined();
      expect(CHAT_GLOBAL_KEYS["cancel"]).toBeUndefined();
      expect(CHAT_GLOBAL_KEYS["send-message"]).toBeUndefined();
      expect(CHAT_GLOBAL_KEYS["macro"]).toBeUndefined();
    });
  });

  describe("hasTemplateVars", () => {
    it("should return true when keyText contains template variables", () => {
      expect(hasTemplateVars({ keyText: "Speed: {{speed}}", message: "" })).toBe(true);
    });

    it("should return true when message contains template variables", () => {
      expect(hasTemplateVars({ keyText: "", message: "Going {{speed}} mph" })).toBe(true);
    });

    it("should return true when both contain template variables", () => {
      expect(hasTemplateVars({ keyText: "{{gear}}", message: "{{speed}}" })).toBe(true);
    });

    it("should return false when neither contains template variables", () => {
      expect(hasTemplateVars({ keyText: "Static", message: "Hello" })).toBe(false);
    });

    it("should return false for empty strings", () => {
      expect(hasTemplateVars({ keyText: "", message: "" })).toBe(false);
    });

    it("should detect partial mustache syntax", () => {
      expect(hasTemplateVars({ keyText: "", message: "Use {{ for templates" })).toBe(true);
    });
  });

  describe("issue #114 regression", () => {
    it("should display resolved message in send-message icon when keyText is empty", () => {
      // When resolveSettingsTemplates resolves message, generateChatSvg should
      // show the resolved value (not raw {{...}}) in the chat bubble
      const result = generateChatSvg(
        ChatSettings.parse({
          mode: "send-message",
          message: "Going 95 mph",
          keyText: "",
          macroNumber: 1,
          iconColor: "#4a90d9",
          fontSize: 11,
        }),
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("Going 95 mph");
      expect(decoded).not.toContain("{{");
    });
  });

  describe("generateChatSvg", () => {
    const allModes = ["open-chat", "reply", "whisper", "toggle", "cancel", "send-message", "macro"] as const;

    it.each(allModes)("should generate a valid data URI for %s", (mode) => {
      const result = generateChatSvg(chatSettings({ mode }));

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for different modes", () => {
      const icons = allModes.map((mode) => generateChatSvg(chatSettings({ mode })));

      for (let i = 0; i < icons.length; i++) {
        for (let j = i + 1; j < icons.length; j++) {
          expect(icons[i]).not.toBe(icons[j]);
        }
      }
    });

    it("should include correct labels for icon-based modes", () => {
      // Note: send-message and macro modes use text inside bubble, not labels
      const expectedLabels: Record<string, { line1: string; line2: string }> = {
        "open-chat": { line1: "OPEN", line2: "CHAT" },
        reply: { line1: "REPLY", line2: "CHAT" },
        whisper: { line1: "WHISPER", line2: "CHAT" },
        toggle: { line1: "ON/OFF", line2: "CHAT" },
        cancel: { line1: "CANCEL", line2: "CHAT" },
      };

      for (const [mode, labels] of Object.entries(expectedLabels)) {
        const result = generateChatSvg(chatSettings({ mode: mode as ChatMode }));
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.line1);
        expect(decoded).toContain(labels.line2);
      }
    });

    it("should render send-message mode with message text inside bubble", () => {
      const result = generateChatSvg(
        ChatSettings.parse({
          mode: "send-message",
          message: "Thank you!",
          macroNumber: 1,
          iconColor: "#4a90d9",
          keyText: "",
          fontSize: 11,
        }),
      );
      const decoded = decodeURIComponent(result);

      // Should contain the message text
      expect(decoded).toContain("Thank you!");
      // Should NOT contain "SEND" or "MESSAGE" labels
      expect(decoded).not.toContain("SEND");
      expect(decoded).not.toContain("MESSAGE");
    });

    it("should prefer keyText over message for send-message mode", () => {
      const result = generateChatSvg(
        ChatSettings.parse({
          mode: "send-message",
          message: "Original message",
          macroNumber: 1,
          iconColor: "#4a90d9",
          keyText: "Custom label",
          fontSize: 11,
        }),
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("Custom label");
      expect(decoded).not.toContain("Original message");
    });

    it("should fall back to open-chat defaults for unspecified settings", () => {
      const result = generateChatSvg({} as any);
      const decoded = decodeURIComponent(result);

      expect(result).toContain("data:image/svg+xml");
      expect(decoded).toContain("OPEN");
    });

    it("should use custom icon color", () => {
      const customColor = "#ff5500";
      const result = generateChatSvg(chatSettings({ mode: "open-chat", iconColor: customColor }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain(customColor);
    });

    it("should use custom key text when provided", () => {
      const customText = "CUSTOM";
      const result = generateChatSvg(chatSettings({ mode: "open-chat", keyText: customText }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("CUSTOM");
      // Should NOT contain default labels
      expect(decoded).not.toContain("OPEN");
      expect(decoded).not.toContain("CHAT");
    });

    it("should use default labels when keyText is empty", () => {
      const result = generateChatSvg(chatSettings({ mode: "reply", keyText: "" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("REPLY");
      expect(decoded).toContain("CHAT");
    });

    it("should support two-line custom key text", () => {
      const twoLineText = "LINE1\nLINE2";
      const result = generateChatSvg(chatSettings({ mode: "open-chat", keyText: twoLineText }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("LINE1");
      expect(decoded).toContain("LINE2");
    });

    it("should trim whitespace from custom key text", () => {
      const textWithWhitespace = "  TRIMMED  ";
      const result = generateChatSvg(chatSettings({ mode: "open-chat", keyText: textWithWhitespace }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("TRIMMED");
    });
  });

  describe("generateSendMessageSvg", () => {
    it("should generate a valid data URI", () => {
      const result = generateSendMessageSvg(chatSettings({ message: "Hello!" }));
      expect(result).toContain("data:image/svg+xml");
    });

    it("should include message text in the bubble", () => {
      const result = generateSendMessageSvg(chatSettings({ message: "Thank you!" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("Thank you!");
    });

    it("should prefer keyText over message", () => {
      const result = generateSendMessageSvg(chatSettings({ keyText: "Custom", message: "Message" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("Custom");
      expect(decoded).not.toContain("Message");
    });

    it("should use message when keyText is empty", () => {
      const result = generateSendMessageSvg(chatSettings({ message: "Fallback" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("Fallback");
    });

    it("should handle empty text gracefully", () => {
      const result = generateSendMessageSvg(chatSettings());
      expect(result).toContain("data:image/svg+xml");
    });

    it("should use doubled font size in 144x144 output", () => {
      const result = generateSendMessageSvg(chatSettings({ message: "Hello" }));
      const decoded = decodeURIComponent(result);

      // Default fontSize=11, doubled to 22 for 144x144
      expect(decoded).toContain('font-size="22"');
    });

    it("should use custom font size doubled for 144x144", () => {
      const result = generateSendMessageSvg(chatSettings({ message: "Hello", fontSize: 20 }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain('font-size="40"');
    });
  });

  describe("generateMacroSvg", () => {
    it("should generate a valid data URI", () => {
      const result = generateMacroSvg(chatSettings({ mode: "macro" }));
      expect(result).toContain("data:image/svg+xml");
    });

    it("should include 'Macro' text when no keyText provided", () => {
      const result = generateMacroSvg(chatSettings({ mode: "macro", macroNumber: 5 }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("Macro");
      expect(decoded).toContain("5");
    });

    it("should show macro number in output", () => {
      const result = generateMacroSvg(chatSettings({ mode: "macro", macroNumber: 12 }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("12");
    });

    it("should use custom keyText instead of default", () => {
      const result = generateMacroSvg(chatSettings({ mode: "macro", keyText: "Custom Text", macroNumber: 3 }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("Custom Text");
      expect(decoded).not.toContain("Macro");
    });

    it("should handle multi-line keyText", () => {
      const result = generateMacroSvg(chatSettings({ mode: "macro", keyText: "Line1\nLine2" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("Line1");
      expect(decoded).toContain("Line2");
    });

    it("should use doubled font sizes for 144x144 when no keyText", () => {
      const result = generateMacroSvg(chatSettings({ mode: "macro", macroNumber: 5 }));
      const decoded = decodeURIComponent(result);

      // Default layout: "Macro" at fontSize 20 (10*2), number at fontSize 50 (25*2)
      expect(decoded).toContain('font-size="20"');
      expect(decoded).toContain('font-size="50"');
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

    it("should migrate legacy respond-pm to reply on keyDown", async () => {
      // Backward compatibility: existing user settings with mode="respond-pm"
      // are migrated to mode="reply" by parseSettings before executeMode runs,
      // so the action still triggers chat.reply() exactly as before.
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
      // Mirror the schema-parsed global settings the action sees in production
      // (getGlobalSettings() always returns the 200 ms defaults, never undefined).
      mockGetGlobalSettings.mockReturnValueOnce({
        chatOpenToPasteDelayMs: 200,
        chatPasteToEnterDelayMs: 200,
        chatEnterToCloseDelayMs: 200,
      });

      await action.onKeyDown(fakeEvent("action-1", { mode: "send-message", message: "Hello!" }) as any);

      expect(mockSendMessage).toHaveBeenCalledWith("Hello!", {
        openToPasteDelayMs: 200,
        pasteToEnterDelayMs: 200,
        enterToCloseDelayMs: 200,
      });
    });

    it("should forward configured chat timing delays to chat.sendMessage()", async () => {
      mockGetGlobalSettings.mockReturnValueOnce({
        chatOpenToPasteDelayMs: 350,
        chatPasteToEnterDelayMs: 500,
        chatEnterToCloseDelayMs: 600,
      });

      await action.onKeyDown(fakeEvent("action-1", { mode: "send-message", message: "Hello!" }) as any);

      expect(mockSendMessage).toHaveBeenCalledWith("Hello!", {
        openToPasteDelayMs: 350,
        pasteToEnterDelayMs: 500,
        enterToCloseDelayMs: 600,
      });
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

    it("should default to send-message when no mode is specified", async () => {
      await action.onKeyDown(fakeEvent("action-1", {}) as any);

      // Default mode is send-message with empty message, which warns and skips
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockBeginChat).not.toHaveBeenCalled();
      expect(mockReply).not.toHaveBeenCalled();
      expect(mockCancel).not.toHaveBeenCalled();
    });
  });

  // Open Chat and Reply open iRacing's text prompt for the DRIVER to type
  // into. The broadcast that opens it needs no focus; the typing about to
  // happen does — under `required`, an unfocused prompt opens behind whatever
  // is in front and every character goes to that app instead (#977).
  describe("focus before the driver types (issue #977)", () => {
    let action: Chat;

    beforeEach(() => {
      action = new Chat();
    });

    it("Open Chat focuses once, before the beginChat broadcast", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "open-chat" }) as any);

      expect(mockFocusBeforeInput).toHaveBeenCalledOnce();
      expect(mockFocusBeforeInput.mock.invocationCallOrder[0]).toBeLessThan(mockBeginChat.mock.invocationCallOrder[0]);
    });

    it("Reply focuses once, before the reply broadcast", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "reply" }) as any);

      expect(mockFocusBeforeInput).toHaveBeenCalledOnce();
      expect(mockFocusBeforeInput.mock.invocationCallOrder[0]).toBeLessThan(mockReply.mock.invocationCallOrder[0]);
    });

    it("Cancel does not focus — nothing is typed", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "cancel" }) as any);

      expect(mockCancel).toHaveBeenCalledOnce();
      expect(mockFocusBeforeInput).not.toHaveBeenCalled();
    });

    it("a macro does not focus — it is a broadcast", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "macro", macroNumber: 5 }) as any);

      expect(mockMacro).toHaveBeenCalledWith(5);
      expect(mockFocusBeforeInput).not.toHaveBeenCalled();
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

    it("should call tapGlobalBinding for whisper", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "whisper" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("chatWhisper");
    });

    it("should call tapGlobalBinding even when no key binding is configured for whisper", async () => {
      mockParseKeyBinding.mockReturnValue(null);

      await action.onKeyDown(fakeEvent("action-1", { mode: "whisper" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("chatWhisper");
    });

    it("should call tapGlobalBinding for toggle", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "toggle" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("chatToggle");
    });

    it("should call tapGlobalBinding even when no key binding is configured for toggle", async () => {
      mockParseKeyBinding.mockReturnValue(null);

      await action.onKeyDown(fakeEvent("action-1", { mode: "toggle" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("chatToggle");
    });

    it("should not call SDK commands for keyboard modes", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "whisper" }) as any);
      await action.onKeyDown(fakeEvent("action-1", { mode: "toggle" }) as any);

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

  describe("telemetry-driven icon refresh (issue #1337)", () => {
    let action: Chat;

    /** One SDK frame: the controller notifies every subscriber once. */
    function tick(): void {
      for (const [, callback] of vi.mocked(action["sdkController"].subscribe).mock.calls) {
        callback({} as never, false);
      }
    }

    function setPosition(position: string | null): void {
      vi.mocked(action["sdkController"].getCurrentTemplateContext).mockReturnValue(
        position === null
          ? null
          : templateContextFromMaps({ "self.position": position }, { "self.position": Number(position) }),
      );
    }

    async function appear(id: string, settings: Record<string, unknown>): Promise<void> {
      await action.onWillAppear(fakeEvent(id, { mode: "send-message", ...settings }) as any);
    }

    /** Decoded image of every telemetry-driven push, in order. */
    function pushedImages(): string[] {
      return vi.mocked(action["updateKeyImage"]).mock.calls.map(([, uri]) => decodeURIComponent(uri as string));
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      action = new Chat();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("reads the shared per-frame context for every templated key and never builds its own", async () => {
      setPosition("3");
      await appear("key-1", { keyText: "P{{self.position}}" });
      await appear("key-2", { keyText: "P{{self.position}}" });
      await appear("key-3", { message: "I am P{{self.position}}" });
      vi.mocked(action["sdkController"].getCurrentTemplateContext).mockClear();
      vi.mocked(buildTemplateContext).mockClear();
      vi.mocked(action["setRegenerateCallback"]).mockClear();

      setPosition("4");
      tick();
      // Let each render's awaited image push settle before checking the callback.
      await vi.advanceTimersByTimeAsync(0);

      expect(buildTemplateContext).not.toHaveBeenCalled();
      expect(action["sdkController"].getCurrentTemplateContext).toHaveBeenCalledTimes(3);
      expect(pushedImages()).toHaveLength(3);
      expect(pushedImages().every((img) => img.includes("P4"))).toBe(true);
      expect(action["setRegenerateCallback"]).toHaveBeenCalledTimes(3);
    });

    it("never builds a context on the display path when the key first appears", async () => {
      setPosition("3");
      await appear("key-1", { keyText: "P{{self.position}}" });

      expect(buildTemplateContext).not.toHaveBeenCalled();
      expect(action["sdkController"].getCurrentTemplateContext).toHaveBeenCalledTimes(1);
    });

    it("coalesces a burst of ticks inside one window into a leading and a trailing refresh", async () => {
      setPosition("1");
      await appear("key-1", { keyText: "P{{self.position}}" });

      for (let position = 2; position <= 7; position++) {
        setPosition(String(position));
        tick();
        vi.advanceTimersByTime(10);
      }

      // Leading edge only: the five ticks after it fell inside the 100 ms window.
      expect(pushedImages()).toHaveLength(1);
      expect(pushedImages()[0]).toContain("P2");

      vi.advanceTimersByTime(100);

      // One trailing flush, rendered from the latest state.
      expect(pushedImages()).toHaveLength(2);
      expect(pushedImages()[1]).toContain("P7");
    });

    it("skips the push when the resolved icon has not changed", async () => {
      setPosition("5");
      await appear("key-1", { keyText: "P{{self.position}}" });

      tick();

      expect(action["sdkController"].getCurrentTemplateContext).toHaveBeenCalledTimes(2);
      expect(action["updateKeyImage"]).not.toHaveBeenCalled();
    });

    it("never requests a context for a key without templates", async () => {
      setPosition("5");
      await appear("key-1", { keyText: "Good race", message: "gg" });

      for (let i = 0; i < 5; i++) {
        tick();
        vi.advanceTimersByTime(50);
      }

      expect(action["sdkController"].getCurrentTemplateContext).not.toHaveBeenCalled();
      expect(buildTemplateContext).not.toHaveBeenCalled();
      expect(action["updateKeyImage"]).not.toHaveBeenCalled();
    });

    it("drops a pending refresh when the key disappears", async () => {
      setPosition("1");
      await appear("key-1", { keyText: "P{{self.position}}" });

      setPosition("2");
      tick(); // leading edge renders P2
      setPosition("3");
      vi.advanceTimersByTime(10);
      tick(); // inside the window: a trailing flush is pending

      await action.onWillDisappear(fakeEvent("key-1") as any);
      vi.advanceTimersByTime(500);

      expect(pushedImages()).toHaveLength(1);
      expect(pushedImages()[0]).toContain("P2");
    });

    it("resolves against the empty context when the controller has no context", async () => {
      setPosition(null);
      await appear("key-1", { keyText: "P{{self.position}} {{= self.position + }}" });

      const [, uri] = vi.mocked(action["setKeyImage"]).mock.calls[0];
      const image = decodeURIComponent(uri as string);

      // Variables render empty; expression parse errors stay verbatim.
      expect(image).toContain("P {{= self.position + }}");
      expect(buildTemplateContext).not.toHaveBeenCalled();
    });
  });
});
