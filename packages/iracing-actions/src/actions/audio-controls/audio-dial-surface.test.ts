import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioControls } from "./audio-controls.js";
import { buildAudioTriggerDescription, renderAudioStripSvg } from "./audio-dial-surface.js";

const {
  mockTapBinding,
  mockHoldBinding,
  mockReleaseBinding,
  mockIsBindingMissing,
  mockStepRaceEngineerVolumeBy,
  mockStepRadarVolumeBy,
  mockReadRaceEngineerVolume,
  mockReadRadarVolume,
  mockIsRaceEngineerEnabled,
  mockIsRadarEnabled,
  mockToggleRaceEngineerFeature,
  mockToggleRadarFeature,
  capturedGlobalListener,
} = vi.hoisted(() => ({
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
  mockHoldBinding: vi.fn().mockResolvedValue(undefined),
  mockReleaseBinding: vi.fn().mockResolvedValue(undefined),
  mockIsBindingMissing: vi.fn(() => false),
  mockStepRaceEngineerVolumeBy: vi.fn((_steps: number) => 50),
  mockStepRadarVolumeBy: vi.fn((_steps: number) => 50),
  mockReadRaceEngineerVolume: vi.fn(() => 50),
  mockReadRadarVolume: vi.fn(() => 50),
  mockIsRaceEngineerEnabled: vi.fn(() => true),
  mockIsRadarEnabled: vi.fn(() => true),
  mockToggleRaceEngineerFeature: vi.fn(() => true),
  mockToggleRadarFeature: vi.fn(() => true),
  capturedGlobalListener: { value: null as (() => void) | null },
}));

vi.mock("../../audio/audio-volume.js", () => ({
  stepRaceEngineerVolume: vi.fn(() => 50),
  stepRadarVolume: vi.fn(() => 50),
  stepRaceEngineerVolumeBy: mockStepRaceEngineerVolumeBy,
  stepRadarVolumeBy: mockStepRadarVolumeBy,
  readRaceEngineerVolume: mockReadRaceEngineerVolume,
  readRadarVolume: mockReadRadarVolume,
  isRaceEngineerEnabled: mockIsRaceEngineerEnabled,
  isRadarEnabled: mockIsRadarEnabled,
}));

vi.mock("../../audio/feature-gates.js", () => ({
  toggleRaceEngineerFeature: mockToggleRaceEngineerFeature,
  toggleRadarFeature: mockToggleRadarFeature,
}));

const { MOCK_SVG } = vi.hoisted(() => ({
  MOCK_SVG: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/audio-controls/race-engineer-volume-up.svg", () => ({ default: MOCK_SVG }));
vi.mock("@iracedeck/icons/audio-controls/race-engineer-volume-down.svg", () => ({ default: MOCK_SVG }));
vi.mock("@iracedeck/icons/audio-controls/radar-volume-up.svg", () => ({ default: MOCK_SVG }));
vi.mock("@iracedeck/icons/audio-controls/radar-volume-down.svg", () => ({ default: MOCK_SVG }));
vi.mock("@iracedeck/icons/audio-controls/voice-chat-volume-up.svg", () => ({ default: MOCK_SVG }));
vi.mock("@iracedeck/icons/audio-controls/voice-chat-volume-down.svg", () => ({ default: MOCK_SVG }));
vi.mock("@iracedeck/icons/audio-controls/voice-chat-mute.svg", () => ({ default: MOCK_SVG }));
vi.mock("@iracedeck/icons/audio-controls/master-volume-up.svg", () => ({ default: MOCK_SVG }));
vi.mock("@iracedeck/icons/audio-controls/master-volume-down.svg", () => ({ default: MOCK_SVG }));
vi.mock("@iracedeck/icons/audio-controls/master-mute.svg", () => ({ default: MOCK_SVG }));
vi.mock("@iracedeck/icons/audio-controls/push-to-talk.svg", () => ({ default: MOCK_SVG }));

vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");

  return {
    // REAL zod semantics for the extended settings schema (defaults + the
    // `dial` prefault) — only the CommonSettings base fields are absent.
    CommonSettings: {
      extend: (shape: never) => z.object(shape).passthrough(),
    },
    ConnectionStateAwareAction: class MockConnectionStateAwareAction {
      logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn() };
      setKeyImage = vi.fn().mockResolvedValue(undefined);
      setRegenerateCallback = vi.fn();
      updateKeyImage = vi.fn().mockResolvedValue(true);
      setActiveBinding = vi.fn();
      tapBinding = mockTapBinding;
      holdBinding = mockHoldBinding;
      releaseBinding = mockReleaseBinding;
      isBindingMissing = mockIsBindingMissing;
      async onWillAppear() {}
      async onDidReceiveSettings() {}
      async onWillDisappear() {}
    },
    onGlobalSettingsChange: vi.fn((cb: () => void) => {
      capturedGlobalListener.value = cb;

      return () => {
        capturedGlobalListener.value = null;
      };
    }),
    svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${svg}`),
    applyBindingWarning: vi.fn((content: string) => `<g opacity="0.35">${content}</g><binding-warning/>`),
    assembleIcon: vi.fn(() => "data:image/svg+xml,icon"),
    getGlobalBorderSettings: vi.fn(() => ({})),
    getGlobalColors: vi.fn(() => ({})),
    getGlobalGraphicSettings: vi.fn(() => ({})),
    getGlobalTitleSettings: vi.fn(() => ({})),
    resolveBorderSettings: vi.fn(() => ({})),
    resolveGraphicSettings: vi.fn(() => ({ scale: 1 })),
    resolveIconColors: vi.fn(() => ({})),
    resolveTitleSettings: vi.fn(() => ({})),
  };
});

/** Fake dial-surface action context. */
function dialAction(id = "dial-1") {
  return {
    id,
    isDial: () => true,
    isKey: () => false,
    setFeedback: vi.fn().mockResolvedValue(undefined),
    setFeedbackLayout: vi.fn().mockResolvedValue(undefined),
    setTriggerDescription: vi.fn().mockResolvedValue(undefined),
    setTitle: vi.fn().mockResolvedValue(undefined),
    setImage: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
  };
}

/** Fake keypad action context (regression guard for the isDial branch). */
function keypadAction(id = "key-1") {
  return { ...dialAction(id), isDial: () => false, isKey: () => true };
}

function ev(
  action: ReturnType<typeof dialAction>,
  settings: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return { action, payload: { settings, ...extra } } as never;
}

/** The raw SVG of the LAST feedback pushed to the context. */
function lastFeedbackSvg(action: ReturnType<typeof dialAction>): string {
  const calls = action.setFeedback.mock.calls;
  expect(calls.length).toBeGreaterThan(0);

  return (calls[calls.length - 1][0] as { box: string }).box;
}

describe("renderAudioStripSvg", () => {
  it("renders the category label band", () => {
    const svg = renderAudioStripSvg({ category: "voice-chat", pttHeld: false, bindingMissing: false });
    expect(svg).toContain("VOICE CHAT");
    expect(svg).toContain('viewBox="0 0 200 100"');
  });

  it("renders a level bar + numeric value for internal categories", () => {
    const svg = renderAudioStripSvg({
      category: "race-engineer",
      volume: 65,
      enabled: true,
      pttHeld: false,
      bindingMissing: false,
    });
    expect(svg).toContain("RACE ENGINEER");
    expect(svg).toContain(">65<");
    expect(svg).toContain("#2ecc71");
  });

  it("renders the OFF state (gray bar, OFF text) when the gate is disabled", () => {
    const svg = renderAudioStripSvg({
      category: "radar",
      volume: 40,
      enabled: false,
      pttHeld: false,
      bindingMissing: false,
    });
    expect(svg).toContain("OFF");
    expect(svg).toContain("#888888");
    expect(svg).not.toContain("#2ecc71");
  });

  it("renders no bar for keybind categories (no state available)", () => {
    const svg = renderAudioStripSvg({ category: "master", pttHeld: false, bindingMissing: false });
    expect(svg).toContain("MASTER");
    expect(svg).toContain("Turn to adjust");
    expect(svg).not.toContain("#2ecc71");
  });

  it("renders the spotter category identity-only (iRacing exposes no spotter volume, #809)", () => {
    const svg = renderAudioStripSvg({ category: "spotter", pttHeld: false, bindingMissing: false });
    expect(svg).toContain(">SPOTTER<");
    expect(svg).toContain("Turn to adjust");
    expect(svg).not.toContain("#2ecc71");
  });

  it("renders the ON AIR band while PTT is held", () => {
    const svg = renderAudioStripSvg({ category: "voice-chat", pttHeld: true, bindingMissing: false });
    expect(svg).toContain("ON AIR");
    expect(svg).toContain("#e74c3c");
  });

  it("applies the binding warning overlay when a required binding is missing", () => {
    const svg = renderAudioStripSvg({ category: "voice-chat", pttHeld: false, bindingMissing: true });
    expect(svg).toContain("<binding-warning/>");
  });
});

describe("buildAudioTriggerDescription", () => {
  it("describes rotation per category and press per action", () => {
    expect(buildAudioTriggerDescription({ category: "master", pressAction: "push-to-talk" })).toEqual({
      rotate: "Adjust master volume",
      push: "Push to talk (hold)",
    });
    expect(buildAudioTriggerDescription({ category: "radar", pressAction: "mute-unmute" })).toEqual({
      rotate: "Adjust radar volume",
      push: "Mute / unmute",
    });
  });

  it("omits push for none", () => {
    expect(buildAudioTriggerDescription({ category: "voice-chat", pressAction: "none" })).toEqual({
      rotate: "Adjust voice chat volume",
    });
  });

  it("describes spotter rotation (#809)", () => {
    expect(buildAudioTriggerDescription({ category: "spotter", pressAction: "mute-unmute" })).toEqual({
      rotate: "Adjust spotter volume",
      push: "Mute / unmute",
    });
  });
});

describe("AudioDialSurface (through AudioControls)", () => {
  let action: AudioControls;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockIsBindingMissing.mockReturnValue(false);
    mockIsRaceEngineerEnabled.mockReturnValue(true);
    mockIsRadarEnabled.mockReturnValue(true);
    action = new AudioControls();
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Flush the trailing render-throttle window. */
  async function flush() {
    await vi.advanceTimersByTimeAsync(200);
  }

  describe("willAppear", () => {
    it("pushes a trigger description and one feedback render, skipping the keypad path", async () => {
      const ctx = dialAction();
      await action.onWillAppear(ev(ctx, { dial: { category: "race-engineer" } }));
      await flush();

      expect(ctx.setTriggerDescription).toHaveBeenCalledWith({ rotate: "Adjust Race Engineer volume" });
      expect(ctx.setFeedback).toHaveBeenCalledTimes(1);
      expect(lastFeedbackSvg(ctx)).toContain("RACE ENGINEER");
      // Keypad path skipped: no key icon, no title write.
      expect(ctx.setTitle).not.toHaveBeenCalled();
      expect((action as unknown as { setKeyImage: ReturnType<typeof vi.fn> }).setKeyImage).not.toHaveBeenCalled();
    });
  });

  describe("willAppear (spotter, #809)", () => {
    it("shows the SPOTTER identity strip and the spotter trigger description", async () => {
      const ctx = dialAction();
      await action.onWillAppear(ev(ctx, { dial: { category: "spotter", pressAction: "mute-unmute" } }));
      await flush();

      expect(ctx.setTriggerDescription).toHaveBeenCalledWith({
        rotate: "Adjust spotter volume",
        push: "Mute / unmute",
      });
      expect(lastFeedbackSvg(ctx)).toContain(">SPOTTER<");
      expect(lastFeedbackSvg(ctx)).not.toContain("<binding-warning/>");
    });

    it("dims the strip with the binding warning when a spotter binding is unset", async () => {
      mockIsBindingMissing.mockImplementation((keys: unknown) =>
        Array.isArray(keys) ? keys.includes("spotterSilence") : keys === "spotterSilence",
      );
      const ctx = dialAction();
      await action.onWillAppear(ev(ctx, { dial: { category: "spotter", pressAction: "mute-unmute" } }));
      await flush();

      expect(mockIsBindingMissing).toHaveBeenCalledWith(["spotterLouder", "spotterQuieter", "spotterSilence"]);
      expect(lastFeedbackSvg(ctx)).toContain("<binding-warning/>");
    });
  });

  describe("rotate", () => {
    it("steps the internal volumes by the signed tick count", async () => {
      const ctx = dialAction();
      await action.onDialRotate(ev(ctx, { dial: { category: "race-engineer" } }, { ticks: 3 }));
      expect(mockStepRaceEngineerVolumeBy).toHaveBeenCalledWith(3);

      await action.onDialRotate(ev(ctx, { dial: { category: "radar" } }, { ticks: -2 }));
      expect(mockStepRadarVolumeBy).toHaveBeenCalledWith(-2);

      expect(mockTapBinding).not.toHaveBeenCalled();
      await flush();
    });

    it("taps the voice-chat volume binding once per detent", async () => {
      const ctx = dialAction();
      await action.onDialRotate(ev(ctx, { dial: { category: "voice-chat" } }, { ticks: 2 }));
      expect(mockTapBinding).toHaveBeenCalledTimes(2);
      expect(mockTapBinding).toHaveBeenCalledWith("audioVoiceChatVolumeUp");

      mockTapBinding.mockClear();
      await action.onDialRotate(ev(ctx, { dial: { category: "voice-chat" } }, { ticks: -1 }));
      expect(mockTapBinding).toHaveBeenCalledTimes(1);
      expect(mockTapBinding).toHaveBeenCalledWith("audioVoiceChatVolumeDown");
    });

    it("maps master rotation to the master volume bindings", async () => {
      const ctx = dialAction();
      await action.onDialRotate(ev(ctx, { dial: { category: "master" } }, { ticks: 1 }));
      expect(mockTapBinding).toHaveBeenCalledWith("audioMasterVolumeUp");

      await action.onDialRotate(ev(ctx, { dial: { category: "master" } }, { ticks: -3 }));
      expect(mockTapBinding).toHaveBeenCalledWith("audioMasterVolumeDown");
    });

    it("caps the taps dispatched for one event", async () => {
      const ctx = dialAction();
      await action.onDialRotate(ev(ctx, { dial: { category: "master" } }, { ticks: 9 }));
      expect(mockTapBinding).toHaveBeenCalledTimes(5);
    });

    it("taps spotter louder / quieter once per detent for the spotter category (#809)", async () => {
      const ctx = dialAction();
      await action.onDialRotate(ev(ctx, { dial: { category: "spotter" } }, { ticks: 2 }));
      expect(mockTapBinding).toHaveBeenCalledTimes(2);
      expect(mockTapBinding).toHaveBeenCalledWith("spotterLouder");

      mockTapBinding.mockClear();
      await action.onDialRotate(ev(ctx, { dial: { category: "spotter" } }, { ticks: -3 }));
      expect(mockTapBinding).toHaveBeenCalledTimes(3);
      expect(mockTapBinding).toHaveBeenCalledWith("spotterQuieter");
      expect(mockStepRaceEngineerVolumeBy).not.toHaveBeenCalled();
      expect(mockStepRadarVolumeBy).not.toHaveBeenCalled();
    });

    it("skips spotter taps when the spotter volume binding is unset (#809)", async () => {
      mockIsBindingMissing.mockReturnValue(true);
      const ctx = dialAction();
      await action.onDialRotate(ev(ctx, { dial: { category: "spotter" } }, { ticks: 1 }));
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("taps nothing when the volume binding is not configured", async () => {
      mockIsBindingMissing.mockReturnValue(true);
      const ctx = dialAction();
      await action.onDialRotate(ev(ctx, { dial: { category: "voice-chat" } }, { ticks: 1 }));
      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("press", () => {
    it("holds the PTT binding on dialDown and shows ON AIR", async () => {
      const ctx = dialAction();
      const settings = { dial: { category: "voice-chat", pressAction: "push-to-talk" } };
      await action.onDialDown(ev(ctx, settings));
      await flush();

      expect(mockHoldBinding).toHaveBeenCalledWith(ctx.id, "audioControlsPushToTalk");
      expect(lastFeedbackSvg(ctx)).toContain("ON AIR");
    });

    it("releases the PTT binding on dialUp and clears ON AIR", async () => {
      const ctx = dialAction();
      const settings = { dial: { category: "voice-chat", pressAction: "push-to-talk" } };
      await action.onDialDown(ev(ctx, settings));
      await flush();
      await action.onDialUp(ev(ctx, settings));
      await flush();

      expect(mockReleaseBinding).toHaveBeenCalledWith(ctx.id);
      expect(lastFeedbackSvg(ctx)).not.toContain("ON AIR");
    });

    it("does not hold PTT when its binding is not configured", async () => {
      mockIsBindingMissing.mockReturnValue(true);
      const ctx = dialAction();
      await action.onDialDown(ev(ctx, { dial: { category: "master", pressAction: "push-to-talk" } }));
      expect(mockHoldBinding).not.toHaveBeenCalled();
    });

    it("taps the voice-chat mute binding for Mute / Unmute", async () => {
      const ctx = dialAction();
      await action.onDialDown(ev(ctx, { dial: { category: "voice-chat", pressAction: "mute-unmute" } }));
      expect(mockTapBinding).toHaveBeenCalledWith("audioVoiceChatMute");
      await flush();
    });

    it("taps the spotter silence binding for spotter Mute / Unmute (#809)", async () => {
      const ctx = dialAction();
      await action.onDialDown(ev(ctx, { dial: { category: "spotter", pressAction: "mute-unmute" } }));
      expect(mockTapBinding).toHaveBeenCalledTimes(1);
      expect(mockTapBinding).toHaveBeenCalledWith("spotterSilence");
      expect(mockToggleRaceEngineerFeature).not.toHaveBeenCalled();
      expect(mockToggleRadarFeature).not.toHaveBeenCalled();
      await flush();
    });

    it("skips spotter Mute / Unmute when the silence binding is unset (#809)", async () => {
      mockIsBindingMissing.mockReturnValue(true);
      const ctx = dialAction();
      await action.onDialDown(ev(ctx, { dial: { category: "spotter", pressAction: "mute-unmute" } }));
      expect(mockTapBinding).not.toHaveBeenCalled();
      expect((action as unknown as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("not configured"),
      );
    });

    it("toggles the Race Engineer feature gate for Mute / Unmute", async () => {
      const ctx = dialAction();
      await action.onDialDown(ev(ctx, { dial: { category: "race-engineer", pressAction: "mute-unmute" } }));
      expect(mockToggleRaceEngineerFeature).toHaveBeenCalledTimes(1);
      expect(mockTapBinding).not.toHaveBeenCalled();
      await flush();
    });

    it("toggles the Radar feature gate for Mute / Unmute", async () => {
      const ctx = dialAction();
      await action.onDialDown(ev(ctx, { dial: { category: "radar", pressAction: "mute-unmute" } }));
      expect(mockToggleRadarFeature).toHaveBeenCalledTimes(1);
      await flush();
    });

    it("logs + no-ops a stale master Mute / Unmute value", async () => {
      const ctx = dialAction();
      await action.onDialDown(ev(ctx, { dial: { category: "master", pressAction: "mute-unmute" } }));

      expect(mockTapBinding).not.toHaveBeenCalled();
      expect(mockToggleRaceEngineerFeature).not.toHaveBeenCalled();
      expect(mockToggleRadarFeature).not.toHaveBeenCalled();
      expect((action as unknown as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn).toHaveBeenCalled();
    });

    it("does nothing for none", async () => {
      const ctx = dialAction();
      const settings = { dial: { category: "voice-chat", pressAction: "none" } };
      await action.onDialDown(ev(ctx, settings));
      await action.onDialUp(ev(ctx, settings));

      expect(mockTapBinding).not.toHaveBeenCalled();
      expect(mockHoldBinding).not.toHaveBeenCalled();
      expect(mockReleaseBinding).not.toHaveBeenCalled();
    });
  });

  describe("willDisappear", () => {
    it("releases a held PTT binding", async () => {
      const ctx = dialAction();
      const settings = { dial: { category: "voice-chat", pressAction: "push-to-talk" } };
      await action.onDialDown(ev(ctx, settings));
      mockReleaseBinding.mockClear();

      await action.onWillDisappear(ev(ctx, settings));
      expect(mockReleaseBinding).toHaveBeenCalledWith(ctx.id);
    });
  });

  describe("global-settings echo", () => {
    it("re-renders live dial contexts on a global-settings change, throttled", async () => {
      const ctx = dialAction();
      await action.onWillAppear(ev(ctx, { dial: { category: "radar" } }));
      expect(ctx.setFeedback).toHaveBeenCalledTimes(1);
      expect(capturedGlobalListener.value).not.toBeNull();

      // Three rapid echoes inside the throttle window coalesce into ONE
      // trailing render.
      capturedGlobalListener.value?.();
      capturedGlobalListener.value?.();
      capturedGlobalListener.value?.();
      await flush();

      expect(ctx.setFeedback).toHaveBeenCalledTimes(2);
    });
  });

  describe("feedback flag off (Mirabox/Ulanzi)", () => {
    it("still rotates and presses but never touches feedback or trigger descriptions", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialAction();
      await action.onWillAppear(ev(ctx, { dial: { category: "race-engineer", pressAction: "mute-unmute" } }));
      await action.onDialRotate(ev(ctx, { dial: { category: "race-engineer" } }, { ticks: 2 }));
      await action.onDialDown(ev(ctx, { dial: { category: "race-engineer", pressAction: "mute-unmute" } }));
      await flush();

      expect(mockStepRaceEngineerVolumeBy).toHaveBeenCalledWith(2);
      expect(mockToggleRaceEngineerFeature).toHaveBeenCalledTimes(1);
      expect(ctx.setFeedback).not.toHaveBeenCalled();
      expect(ctx.setTriggerDescription).not.toHaveBeenCalled();
    });
  });

  describe("keypad regression", () => {
    it("keypad key presses still route through the keypad logic", async () => {
      const ctx = keypadAction();
      await action.onKeyDown(ev(ctx, { category: "voice-chat", action: "volume-up" }));

      expect(mockTapBinding).toHaveBeenCalledWith("audioVoiceChatVolumeUp");
      expect(ctx.setFeedback).not.toHaveBeenCalled();
    });
  });
});
