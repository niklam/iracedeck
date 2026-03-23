import { beforeEach, describe, expect, it, vi } from "vitest";

import { AUDIO_CONTROLS_GLOBAL_KEYS, AudioControls, generateAudioControlsSvg } from "./audio-controls.js";

const { mockSendKeyCombination, mockParseKeyBinding, mockGetGlobalSettings } = vi.hoisted(() => ({
  mockSendKeyCombination: vi.fn().mockResolvedValue(true),
  mockParseKeyBinding: vi.fn(),
  mockGetGlobalSettings: vi.fn(() => ({})),
}));

vi.mock("@iracedeck/icons/audio-controls/voice-chat-volume-up.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/audio-controls/voice-chat-volume-down.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/audio-controls/voice-chat-mute.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/audio-controls/master-volume-up.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/audio-controls/master-volume-down.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/audio-controls/master-mute.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: (_fields: unknown) => {
      // Return a mock Zod-like schema
      const schema = {
        parse: (data: Record<string, unknown>) => ({ ...data }),
        safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
      };

      return schema;
    },
    parse: (data: Record<string, unknown>) => ({ ...data }),
    safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
  },
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
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
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: mockGetGlobalSettings,
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: mockSendKeyCombination,
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
  resolveIconColors: vi.fn((_svg, _global, _overrides) => ({})),
  renderIconTemplate: vi.fn((template: string, data: Record<string, string>) => {
    let result = template;

    for (const [key, value] of Object.entries(data)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    return result;
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

/** Create a minimal fake dial rotate event. */
function fakeDialRotateEvent(actionId: string, settings: Record<string, unknown>, ticks: number) {
  return {
    action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn() },
    payload: { settings, ticks },
  };
}

describe("AudioControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("AUDIO_CONTROLS_GLOBAL_KEYS", () => {
    it("should have correct mapping for voice-chat-volume-up", () => {
      expect(AUDIO_CONTROLS_GLOBAL_KEYS["voice-chat-volume-up"]).toBe("audioVoiceChatVolumeUp");
    });

    it("should have correct mapping for voice-chat-volume-down", () => {
      expect(AUDIO_CONTROLS_GLOBAL_KEYS["voice-chat-volume-down"]).toBe("audioVoiceChatVolumeDown");
    });

    it("should have correct mapping for voice-chat-mute", () => {
      expect(AUDIO_CONTROLS_GLOBAL_KEYS["voice-chat-mute"]).toBe("audioVoiceChatMute");
    });

    it("should have correct mapping for master-volume-up", () => {
      expect(AUDIO_CONTROLS_GLOBAL_KEYS["master-volume-up"]).toBe("audioMasterVolumeUp");
    });

    it("should have correct mapping for master-volume-down", () => {
      expect(AUDIO_CONTROLS_GLOBAL_KEYS["master-volume-down"]).toBe("audioMasterVolumeDown");
    });

    it("should have exactly 5 entries", () => {
      expect(Object.keys(AUDIO_CONTROLS_GLOBAL_KEYS)).toHaveLength(5);
    });

    it("should not have a mapping for master-mute", () => {
      expect(AUDIO_CONTROLS_GLOBAL_KEYS["master-mute"]).toBeUndefined();
    });
  });

  describe("generateAudioControlsSvg", () => {
    it("should generate a valid data URI for voice-chat mute", () => {
      const result = generateAudioControlsSvg({ category: "voice-chat", action: "mute" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for master volume-down", () => {
      const result = generateAudioControlsSvg({ category: "master", action: "volume-down" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all category + action combinations", () => {
      const categories = ["voice-chat", "master"] as const;
      const actions = ["volume-up", "volume-down", "mute"] as const;

      for (const category of categories) {
        for (const action of actions) {
          const result = generateAudioControlsSvg({ category, action });
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different categories", () => {
      const voiceChat = generateAudioControlsSvg({ category: "voice-chat", action: "volume-up" });
      const master = generateAudioControlsSvg({ category: "master", action: "volume-up" });

      expect(voiceChat).not.toBe(master);
    });

    it("should produce different icons for different actions within same category", () => {
      const volumeUp = generateAudioControlsSvg({ category: "voice-chat", action: "volume-up" });
      const volumeDown = generateAudioControlsSvg({ category: "voice-chat", action: "volume-down" });
      const mute = generateAudioControlsSvg({ category: "voice-chat", action: "mute" });

      expect(volumeUp).not.toBe(volumeDown);
      expect(volumeUp).not.toBe(mute);
      expect(volumeDown).not.toBe(mute);
    });

    it("should fall back to volume-up display for master with mute action", () => {
      const masterMute = generateAudioControlsSvg({ category: "master", action: "mute" });
      const masterVolumeUp = generateAudioControlsSvg({ category: "master", action: "volume-up" });

      expect(masterMute).toBe(masterVolumeUp);
    });

    it("should include correct labels for voice-chat volume-up", () => {
      const result = generateAudioControlsSvg({ category: "voice-chat", action: "volume-up" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("VOICE");
      expect(decoded).toContain("VOL UP");
    });

    it("should include correct labels for voice-chat mute", () => {
      const result = generateAudioControlsSvg({ category: "voice-chat", action: "mute" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("VOICE");
      expect(decoded).toContain("MUTE");
    });

    it("should include correct labels for master volume-down", () => {
      const result = generateAudioControlsSvg({ category: "master", action: "volume-down" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("MASTER");
      expect(decoded).toContain("VOL DOWN");
    });

    it("should include correct labels for all combinations", () => {
      const expectedLabels: Record<string, Record<string, { mainLabel: string; subLabel: string }>> = {
        "voice-chat": {
          "volume-up": { mainLabel: "VOICE", subLabel: "VOL UP" },
          "volume-down": { mainLabel: "VOICE", subLabel: "VOL DOWN" },
          mute: { mainLabel: "VOICE", subLabel: "MUTE" },
        },
        master: {
          "volume-up": { mainLabel: "MASTER", subLabel: "VOL UP" },
          "volume-down": { mainLabel: "MASTER", subLabel: "VOL DOWN" },
          // master-mute falls back to volume-up
          mute: { mainLabel: "MASTER", subLabel: "VOL UP" },
        },
      };

      for (const [category, actions] of Object.entries(expectedLabels)) {
        for (const [action, labels] of Object.entries(actions)) {
          const result = generateAudioControlsSvg({
            category: category as any,
            action: action as any,
          });
          const decoded = decodeURIComponent(result);

          expect(decoded).toContain(labels.mainLabel);
          expect(decoded).toContain(labels.subLabel);
        }
      }
    });
  });

  describe("tap behavior", () => {
    let action: AudioControls;

    beforeEach(() => {
      action = new AudioControls();
    });

    it("should call sendKeyCombination on keyDown for voice-chat mute", async () => {
      mockGetGlobalSettings.mockReturnValue({ audioVoiceChatMute: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "m", modifiers: ["shift", "ctrl", "alt"], code: "KeyM" });

      await action.onKeyDown(fakeEvent("action-1", { category: "voice-chat", action: "mute" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "m",
        modifiers: ["shift", "ctrl", "alt"],
        code: "KeyM",
      });
    });

    it("should call sendKeyCombination on keyDown for master volume-down", async () => {
      mockGetGlobalSettings.mockReturnValue({ audioMasterVolumeDown: "bound" });
      mockParseKeyBinding.mockReturnValue({
        key: "numpad_subtract",
        modifiers: ["shift", "alt"],
        code: "NumpadSubtract",
      });

      await action.onKeyDown(fakeEvent("action-1", { category: "master", action: "volume-down" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "numpad_subtract",
        modifiers: ["shift", "alt"],
        code: "NumpadSubtract",
      });
    });

    it("should call sendKeyCombination on dialDown", async () => {
      mockGetGlobalSettings.mockReturnValue({ audioVoiceChatVolumeUp: "bound" });
      mockParseKeyBinding.mockReturnValue({
        key: "numpad_add",
        modifiers: ["shift", "ctrl", "alt"],
        code: "NumpadAdd",
      });

      await action.onDialDown(fakeEvent("action-1", { category: "voice-chat", action: "volume-up" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should handle missing key binding gracefully", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { category: "voice-chat", action: "volume-up" }) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should handle missing global key mapping gracefully (master mute)", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { category: "master", action: "mute" }) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should send key with empty modifiers as undefined", async () => {
      mockGetGlobalSettings.mockReturnValue({ audioVoiceChatMute: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "m", modifiers: [], code: "KeyM" });

      await action.onKeyDown(fakeEvent("action-1", { category: "voice-chat", action: "mute" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "m",
        modifiers: undefined,
        code: "KeyM",
      });
    });
  });

  describe("encoder behavior", () => {
    let action: AudioControls;

    beforeEach(() => {
      action = new AudioControls();
    });

    it("should send volume-up key on clockwise rotation", async () => {
      mockGetGlobalSettings.mockReturnValue({ audioVoiceChatVolumeUp: "bound" });
      mockParseKeyBinding.mockReturnValue({
        key: "numpad_add",
        modifiers: ["shift", "ctrl", "alt"],
        code: "NumpadAdd",
      });

      await action.onDialRotate(fakeDialRotateEvent("action-1", { category: "voice-chat", action: "mute" }, 1) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "numpad_add",
        modifiers: ["shift", "ctrl", "alt"],
        code: "NumpadAdd",
      });
    });

    it("should send volume-down key on counter-clockwise rotation", async () => {
      mockGetGlobalSettings.mockReturnValue({ audioVoiceChatVolumeDown: "bound" });
      mockParseKeyBinding.mockReturnValue({
        key: "numpad_subtract",
        modifiers: ["shift", "ctrl", "alt"],
        code: "NumpadSubtract",
      });

      await action.onDialRotate(fakeDialRotateEvent("action-1", { category: "voice-chat", action: "mute" }, -1) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "numpad_subtract",
        modifiers: ["shift", "ctrl", "alt"],
        code: "NumpadSubtract",
      });
    });

    it("should send volume-up for master on clockwise rotation", async () => {
      mockGetGlobalSettings.mockReturnValue({ audioMasterVolumeUp: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "numpad_add", modifiers: ["shift", "alt"], code: "NumpadAdd" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { category: "master", action: "volume-down" }, 2) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should send mute on dial press for voice-chat", async () => {
      mockGetGlobalSettings.mockReturnValue({ audioVoiceChatMute: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "m", modifiers: ["shift", "ctrl", "alt"], code: "KeyM" });

      await action.onDialDown(fakeEvent("action-1", { category: "voice-chat", action: "volume-down" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should send configured action on dial press for master (no mute)", async () => {
      mockGetGlobalSettings.mockReturnValue({ audioMasterVolumeDown: "bound" });
      mockParseKeyBinding.mockReturnValue({
        key: "numpad_subtract",
        modifiers: ["shift", "alt"],
        code: "NumpadSubtract",
      });

      await action.onDialDown(fakeEvent("action-1", { category: "master", action: "volume-down" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "numpad_subtract",
        modifiers: ["shift", "alt"],
        code: "NumpadSubtract",
      });
    });

    it("should always control volume on rotation regardless of action setting", async () => {
      mockGetGlobalSettings.mockReturnValue({ audioVoiceChatVolumeUp: "bound" });
      mockParseKeyBinding.mockReturnValue({
        key: "numpad_add",
        modifiers: ["shift", "ctrl", "alt"],
        code: "NumpadAdd",
      });

      // Even when action is set to "mute", rotation should send volume-up
      await action.onDialRotate(fakeDialRotateEvent("action-1", { category: "voice-chat", action: "mute" }, 1) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });
  });
});
