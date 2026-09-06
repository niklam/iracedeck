import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseAudioControlsSettings } from "./audio-controls-settings.js";
import { AUDIO_CONTROLS_GLOBAL_KEYS, AudioControls, generateAudioControlsSvg } from "./audio-controls.js";

const { mockTapBinding, mockHoldBinding, mockReleaseBinding, mockStepRadarVolumeBy, mockStepRaceEngineerVolumeBy } =
  vi.hoisted(() => ({
    mockTapBinding: vi.fn().mockResolvedValue(undefined),
    mockHoldBinding: vi.fn().mockResolvedValue(undefined),
    mockReleaseBinding: vi.fn().mockResolvedValue(undefined),
    mockStepRadarVolumeBy: vi.fn((_steps: number) => 50),
    mockStepRaceEngineerVolumeBy: vi.fn((_steps: number) => 50),
  }));

vi.mock("../../audio/audio-volume.js", () => ({
  stepRadarVolume: vi.fn(() => 50),
  stepRaceEngineerVolume: vi.fn(() => 50),
  stepRadarVolumeBy: mockStepRadarVolumeBy,
  stepRaceEngineerVolumeBy: mockStepRaceEngineerVolumeBy,
  readRadarVolume: vi.fn(() => 50),
  readRaceEngineerVolume: vi.fn(() => 50),
  isRadarEnabled: vi.fn(() => true),
  isRaceEngineerEnabled: vi.fn(() => true),
}));

vi.mock("../../audio/feature-gates.js", () => ({
  toggleRaceEngineerFeature: vi.fn(() => true),
  toggleRadarFeature: vi.fn(() => true),
}));

vi.mock("@iracedeck/icons/audio-controls/race-engineer-volume-up.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/audio-controls/race-engineer-volume-down.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/audio-controls/radar-volume-up.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/audio-controls/radar-volume-down.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
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
vi.mock("@iracedeck/icons/audio-controls/push-to-talk.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">push-to-talk</svg>',
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
    updateKeyImage = vi.fn().mockResolvedValue(true);
    tapBinding = mockTapBinding;
    holdBinding = mockHoldBinding;
    releaseBinding = mockReleaseBinding;
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
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseBinding: vi.fn(),
  parseKeyBinding: vi.fn(),
  isSimHubBinding: vi.fn(
    (v: unknown) => v !== null && typeof v === "object" && (v as Record<string, unknown>).type === "simhub",
  ),
  isSimHubInitialized: vi.fn(() => false),
  getSimHub: vi.fn(() => ({
    startRole: vi.fn().mockResolvedValue(true),
    stopRole: vi.fn().mockResolvedValue(true),
  })),
  getGlobalTitleSettings: vi.fn(() => ({})),
  onGlobalSettingsChange: vi.fn(() => () => {}),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
  applyBindingWarning: vi.fn((content: string) => content),
  resolveIconColors: vi.fn((_svg, _global, _overrides) => ({})),
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
    ({ graphicSvg, title }: { graphicSvg: string; colors: unknown; title: { titleText: string } }) => {
      const encoded = encodeURIComponent(`<svg>${graphicSvg}${title?.titleText ?? ""}</svg>`);

      return `data:image/svg+xml,${encoded}`;
    },
  ),
}));

/**
 * Create a minimal fake KEYPAD event with the given action ID and settings.
 * Dial behavior is covered in `audio-dial-surface.test.ts` (#782), which
 * drives the action with dial-shaped contexts and real-zod settings.
 */
function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
  return {
    action: { id: actionId, isDial: () => false, isKey: () => true, setTitle: vi.fn(), setImage: vi.fn() },
    payload: { settings },
  };
}

/** Create a minimal fake key up event. */
function fakeKeyUpEvent(actionId: string, settings: Record<string, unknown> = {}) {
  return fakeEvent(actionId, settings);
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

    it("should have correct mapping for push-to-talk", () => {
      expect(AUDIO_CONTROLS_GLOBAL_KEYS["push-to-talk"]).toBe("audioControlsPushToTalk");
    });

    it("should have exactly 6 entries", () => {
      expect(Object.keys(AUDIO_CONTROLS_GLOBAL_KEYS)).toHaveLength(6);
    });

    it("should not have a mapping for master-mute", () => {
      expect(AUDIO_CONTROLS_GLOBAL_KEYS["master-mute"]).toBeUndefined();
    });
  });

  describe("generateAudioControlsSvg", () => {
    it("should generate a valid data URI for voice-chat mute", () => {
      const result = generateAudioControlsSvg(parseAudioControlsSettings({ category: "voice-chat", action: "mute" }));

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for master volume-down", () => {
      const result = generateAudioControlsSvg(
        parseAudioControlsSettings({ category: "master", action: "volume-down" }),
      );

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all category + action combinations", () => {
      const categories = ["voice-chat", "master"] as const;
      const actions = ["volume-up", "volume-down", "mute"] as const;

      for (const category of categories) {
        for (const action of actions) {
          const result = generateAudioControlsSvg(parseAudioControlsSettings({ category, action }));
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different categories", () => {
      const voiceChat = generateAudioControlsSvg(
        parseAudioControlsSettings({ category: "voice-chat", action: "volume-up" }),
      );
      const master = generateAudioControlsSvg(parseAudioControlsSettings({ category: "master", action: "volume-up" }));

      expect(voiceChat).not.toBe(master);
    });

    it("should produce different icons for different actions within same category", () => {
      const volumeUp = generateAudioControlsSvg(
        parseAudioControlsSettings({ category: "voice-chat", action: "volume-up" }),
      );
      const volumeDown = generateAudioControlsSvg(
        parseAudioControlsSettings({ category: "voice-chat", action: "volume-down" }),
      );
      const mute = generateAudioControlsSvg(parseAudioControlsSettings({ category: "voice-chat", action: "mute" }));

      expect(volumeUp).not.toBe(volumeDown);
      expect(volumeUp).not.toBe(mute);
      expect(volumeDown).not.toBe(mute);
    });

    it("should fall back to volume-up icon for master with mute action", () => {
      const masterMute = generateAudioControlsSvg(parseAudioControlsSettings({ category: "master", action: "mute" }));
      // The mute action uses the volume-up icon (falls back to master-volume-up SVG)
      // but has its own title "VOLUME\nMASTER"
      expect(masterMute).toContain("data:image/svg+xml");
      expect(decodeURIComponent(masterMute)).toContain("MASTER");
    });

    it("should include correct labels for voice-chat volume-up", () => {
      const result = generateAudioControlsSvg(
        parseAudioControlsSettings({ category: "voice-chat", action: "volume-up" }),
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("VOICE");
      expect(decoded).toContain("VOL UP");
    });

    it("should include correct labels for voice-chat mute", () => {
      const result = generateAudioControlsSvg(parseAudioControlsSettings({ category: "voice-chat", action: "mute" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("VOICE");
      expect(decoded).toContain("MUTE");
    });

    it("should include correct labels for master volume-down", () => {
      const result = generateAudioControlsSvg(
        parseAudioControlsSettings({ category: "master", action: "volume-down" }),
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("MASTER");
      expect(decoded).toContain("VOL DOWN");
    });

    it("should generate a valid data URI for push-to-talk", () => {
      const result = generateAudioControlsSvg(
        parseAudioControlsSettings({ category: "push-to-talk", action: "volume-up" }),
      );

      expect(result).toContain("data:image/svg+xml");
    });

    it("should include correct labels for push-to-talk", () => {
      const result = generateAudioControlsSvg(
        parseAudioControlsSettings({ category: "push-to-talk", action: "volume-up" }),
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("TALK");
    });

    it("should produce a different icon for push-to-talk vs voice-chat", () => {
      const ptt = generateAudioControlsSvg(
        parseAudioControlsSettings({ category: "push-to-talk", action: "volume-up" }),
      );
      const voiceChat = generateAudioControlsSvg(
        parseAudioControlsSettings({ category: "voice-chat", action: "volume-up" }),
      );

      expect(ptt).not.toBe(voiceChat);
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
          mute: { mainLabel: "MASTER", subLabel: "MUTE" },
        },
      };

      for (const [category, actions] of Object.entries(expectedLabels)) {
        for (const [action, labels] of Object.entries(actions)) {
          const result = generateAudioControlsSvg(
            parseAudioControlsSettings({
              category: category,
              action: action,
            }),
          );
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

    it("should call tapGlobalBinding on keyDown for voice-chat mute", async () => {
      await action.onKeyDown(fakeEvent("action-1", { category: "voice-chat", action: "mute" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("audioVoiceChatMute");
    });

    it("should call tapGlobalBinding on keyDown for master volume-down", async () => {
      await action.onKeyDown(fakeEvent("action-1", { category: "master", action: "volume-down" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("audioMasterVolumeDown");
    });

    it("should call tapGlobalBinding even when no key binding is configured", async () => {
      await action.onKeyDown(fakeEvent("action-1", { category: "voice-chat", action: "volume-up" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("audioVoiceChatVolumeUp");
    });

    it("should not call tapGlobalBinding for master mute (no global key mapping)", async () => {
      await action.onKeyDown(fakeEvent("action-1", { category: "master", action: "mute" }) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("should call tapGlobalBinding for voice-chat mute", async () => {
      await action.onKeyDown(fakeEvent("action-1", { category: "voice-chat", action: "mute" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("audioVoiceChatMute");
    });
  });

  describe("push-to-talk hold behavior", () => {
    let action: AudioControls;

    beforeEach(() => {
      action = new AudioControls();
    });

    it("should call holdBinding on keyDown for push-to-talk", async () => {
      await action.onKeyDown(fakeEvent("action-1", { category: "push-to-talk" }) as any);

      expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "audioControlsPushToTalk");
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("should call releaseBinding on keyUp for push-to-talk", async () => {
      await action.onKeyUp(fakeKeyUpEvent("action-1", { category: "push-to-talk" }) as any);

      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should not call holdBinding on keyDown for non-PTT modes", async () => {
      await action.onKeyDown(fakeEvent("action-1", { category: "voice-chat", action: "volume-up" }) as any);

      expect(mockHoldBinding).not.toHaveBeenCalled();
      expect(mockTapBinding).toHaveBeenCalledWith("audioVoiceChatVolumeUp");
    });

    it("should release binding on willDisappear", async () => {
      await action.onWillDisappear(fakeEvent("action-1", { category: "push-to-talk" }) as any);

      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
    });
  });

  describe("internal volume categories (#590)", () => {
    let action: AudioControls;

    beforeEach(() => {
      action = new AudioControls();
    });

    it("has no global key mapping for race-engineer or radar", () => {
      expect(AUDIO_CONTROLS_GLOBAL_KEYS["race-engineer-volume-up"]).toBeUndefined();
      expect(AUDIO_CONTROLS_GLOBAL_KEYS["radar-volume-up"]).toBeUndefined();
      // Still exactly the six keyboard-backed entries.
      expect(Object.keys(AUDIO_CONTROLS_GLOBAL_KEYS)).toHaveLength(6);
    });

    it("generates labelled icons for race-engineer volume", () => {
      const up = decodeURIComponent(
        generateAudioControlsSvg(parseAudioControlsSettings({ category: "race-engineer", action: "volume-up" })),
      );
      const down = decodeURIComponent(
        generateAudioControlsSvg(parseAudioControlsSettings({ category: "race-engineer", action: "volume-down" })),
      );

      expect(up).toContain("ENGINEER");
      expect(up).toContain("VOL UP");
      expect(down).toContain("ENGINEER");
      expect(down).toContain("VOL DOWN");
      expect(up).not.toBe(down);
    });

    it("generates labelled icons for radar volume", () => {
      const up = decodeURIComponent(
        generateAudioControlsSvg(parseAudioControlsSettings({ category: "radar", action: "volume-up" })),
      );
      const down = decodeURIComponent(
        generateAudioControlsSvg(parseAudioControlsSettings({ category: "radar", action: "volume-down" })),
      );

      expect(up).toContain("RADAR");
      expect(up).toContain("VOL UP");
      expect(down).toContain("RADAR");
      expect(down).toContain("VOL DOWN");
    });

    it("steps the Race Engineer volume up on keyDown", async () => {
      await action.onKeyDown(fakeEvent("action-1", { category: "race-engineer", action: "volume-up" }) as any);

      // One detent up through the shared bus table (the dial rotates the same
      // wiring), and no key binding is involved for an internal bus.
      expect(mockStepRaceEngineerVolumeBy).toHaveBeenCalledWith(1);
      expect(mockTapBinding).not.toHaveBeenCalled();
      expect(mockHoldBinding).not.toHaveBeenCalled();
    });

    it("steps the Race Engineer volume down on keyDown", async () => {
      await action.onKeyDown(fakeEvent("action-1", { category: "race-engineer", action: "volume-down" }) as any);

      expect(mockStepRaceEngineerVolumeBy).toHaveBeenCalledWith(-1);
    });

    it("steps the Radar volume up on keyDown", async () => {
      await action.onKeyDown(fakeEvent("action-1", { category: "radar", action: "volume-up" }) as any);

      expect(mockStepRadarVolumeBy).toHaveBeenCalledWith(1);
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("steps the Radar volume down on keyDown", async () => {
      await action.onKeyDown(fakeEvent("action-1", { category: "radar", action: "volume-down" }) as any);

      expect(mockStepRadarVolumeBy).toHaveBeenCalledWith(-1);
    });

    it("leaves the internal buses alone when the mute action is persisted (PI never offers it)", async () => {
      await action.onKeyDown(fakeEvent("action-1", { category: "radar", action: "mute" }) as any);

      // `mute` can only arrive from a stale/hand-edited profile; treat it as a
      // step up rather than dropping the press.
      expect(mockStepRadarVolumeBy).toHaveBeenCalledWith(1);
      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });
});
