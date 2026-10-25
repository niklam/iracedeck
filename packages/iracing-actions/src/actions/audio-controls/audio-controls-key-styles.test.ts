/**
 * Paired +/− key styles on the Audio Controls volume keys (#1453): the
 * fresh-key seed, the render path through the shared volume module, the level
 * following a global-settings change, and hold-to-repeat. Runs the real
 * renderer (deck-core's icon helpers and the real icons) with real zod
 * settings, so the drawn SVG is what a deck shows.
 */
import { dataUriToSvg } from "@iracedeck/deck-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseAudioControlsSettings } from "./audio-controls-settings.js";
import {
  AudioControls,
  describeAudioVolumeKey,
  generateAudioControlsSvg,
  renderAudioControlsIcon,
} from "./audio-controls.js";

const { mockTapBinding, mockIsBindingMissing, levels, enabled, mockStepBy } = vi.hoisted(() => {
  const levels = { "race-engineer": 50, radar: 50 };
  const enabled = { "race-engineer": true, radar: true };

  return {
    mockTapBinding: vi.fn(async (_key: string) => true),
    mockIsBindingMissing: vi.fn((_keys?: string | readonly string[] | null) => false),
    levels,
    enabled,
    // Mirrors audio-volume's clamped 5 % step: a step at a limit leaves the level as it was.
    mockStepBy: (bus: "race-engineer" | "radar") =>
      vi.fn((steps: number) => {
        levels[bus] = Math.max(0, Math.min(100, levels[bus] + steps * 5));

        return levels[bus];
      }),
  };
});

const { stepRaceEngineerVolumeBy, stepRadarVolumeBy } = vi.hoisted(() => ({
  stepRaceEngineerVolumeBy: vi.fn(),
  stepRadarVolumeBy: vi.fn(),
}));

vi.mock("../../audio/audio-volume.js", () => ({
  stepRaceEngineerVolumeBy,
  stepRadarVolumeBy,
  readRaceEngineerVolume: () => levels["race-engineer"],
  readRadarVolume: () => levels.radar,
  isRaceEngineerEnabled: () => enabled["race-engineer"],
  isRadarEnabled: () => enabled.radar,
}));

vi.mock("../../audio/feature-gates.js", () => ({
  toggleRaceEngineerFeature: vi.fn(),
  toggleRadarFeature: vi.fn(),
}));

// The tick (#1455) is counted, not played: every hold-repeat step goes
// through performVolumeStep, so each sent iRacing step ticks; an iRaceDeck
// step ticks inside the (mocked) step helper, never here.
const { mockTick } = vi.hoisted(() => ({ mockTick: vi.fn() }));

vi.mock("../../audio/volume-tick.js", () => ({ tickIRacingVolumeStep: mockTick }));

const STAMP = "9.9.9";

vi.mock("@iracedeck/deck-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/deck-core")>();
  const { z } = await import("zod");

  return {
    ...actual,
    // REAL zod semantics for the action's own fields; the CommonSettings base fields are absent.
    CommonSettings: { extend: (shape: never) => z.object(shape).passthrough() },
    ConnectionStateAwareAction: class MockConnectionStateAwareAction {
      logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      setKeyImage = vi.fn().mockResolvedValue(undefined);
      setRegenerateCallback = vi.fn();
      updateKeyImage = vi.fn().mockResolvedValue(true);
      setActiveBinding = vi.fn();
      tapBinding = mockTapBinding;
      holdBinding = vi.fn().mockResolvedValue(undefined);
      releaseBinding = vi.fn().mockResolvedValue(undefined);
      isBindingMissing = mockIsBindingMissing;
      // The base's addedWithVersion stamp: it writes `{...payload, addedWithVersion}`.
      async onWillAppear(ev: {
        action: { setSettings: (s: unknown) => Promise<void> };
        payload: { settings: Record<string, unknown> };
      }) {
        if (!ev.payload.settings.addedWithVersion) {
          await ev.action.setSettings({ ...ev.payload.settings, addedWithVersion: "9.9.9" });
        }
      }
      async onDidReceiveSettings() {}
      async onWillDisappear() {}
    },
    getDualPressThresholdMs: () => 500,
    getGlobalTitleSettings: () => ({}),
    getGlobalBorderSettings: () => ({}),
    getGlobalGraphicSettings: () => ({}),
  };
});

vi.mock("@iracedeck/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/settings")>()),
  getGlobalColors: () => ({}),
  onGlobalSettingsChange: vi.fn(() => () => {}),
}));

function keyAction(id = "key-1") {
  return {
    id,
    isDial: () => false,
    isKey: () => true,
    dialCanvas: () => null,
    setTitle: vi.fn().mockResolvedValue(undefined),
    setImage: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
  };
}

function dialAction(id = "dial-1") {
  return {
    ...keyAction(id),
    isDial: () => true,
    isKey: () => false,
    setDialCanvas: vi.fn().mockResolvedValue(undefined),
    setFeedback: vi.fn().mockResolvedValue(undefined),
    setFeedbackLayout: vi.fn().mockResolvedValue(undefined),
    setTriggerDescription: vi.fn().mockResolvedValue(undefined),
  };
}

function event(action: ReturnType<typeof keyAction>, settings: Record<string, unknown>) {
  return { action, payload: { settings } } as never;
}

const settings = (raw: Record<string, unknown>) => parseAudioControlsSettings(raw);
const svgOf = (uri: string) => dataUriToSvg(uri);

const VOLUME_PAIRS = [
  ["master", "volume-up", "MASTER", "+"],
  ["master", "volume-down", "MASTER", "−"],
  ["voice-chat", "volume-up", "VOICE", "+"],
  ["voice-chat", "volume-down", "VOICE", "−"],
  ["race-engineer", "volume-up", "ENGINEER", "+"],
  ["race-engineer", "volume-down", "ENGINEER", "−"],
  ["radar", "volume-up", "RADAR", "+"],
  ["radar", "volume-down", "RADAR", "−"],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  levels["race-engineer"] = 50;
  levels.radar = 50;
  enabled["race-engineer"] = true;
  enabled.radar = true;
  stepRaceEngineerVolumeBy.mockImplementation(mockStepBy("race-engineer"));
  stepRadarVolumeBy.mockImplementation(mockStepBy("radar"));
  mockTapBinding.mockImplementation(async () => true);
  mockIsBindingMissing.mockImplementation(() => false);
});

describe("settings", () => {
  it("defaults a keypad key to Legacy and Auto, and degrades unknown values", () => {
    expect(settings({})).toMatchObject({ keyStyle: "legacy", pairPosition: "auto" });
    expect(settings({ keyStyle: "from-the-future", pairPosition: "diagonal", category: "master" })).toMatchObject({
      keyStyle: "legacy",
      pairPosition: "auto",
      category: "master",
    });
  });
});

describe("fresh-key seed", () => {
  it("seeds a fresh keypad key with Split, and the addedWithVersion stamp written after it keeps it", async () => {
    const action = new AudioControls();
    const key = keyAction();
    await action.onWillAppear(event(key, {}));

    expect(key.setSettings.mock.calls).toEqual([
      [{ keyStyle: "split" }],
      [{ keyStyle: "split", addedWithVersion: STAMP }],
    ]);
  });

  it("does not seed a configured key", async () => {
    const action = new AudioControls();
    const key = keyAction();
    await action.onWillAppear(event(key, { category: "master", action: "volume-up" }));

    expect(key.setSettings.mock.calls).toEqual([
      [{ category: "master", action: "volume-up", addedWithVersion: STAMP }],
    ]);
  });

  it("does not seed a dial", async () => {
    const action = new AudioControls();
    const dial = dialAction();
    await action.onWillAppear(event(dial, {}));

    expect(dial.setSettings.mock.calls).toEqual([[{ addedWithVersion: STAMP }]]);
  });

  it("still runs the #1015 migration before the stamp", async () => {
    const action = new AudioControls();
    const dial = dialAction();
    await action.onWillAppear(event(dial, { dial: { category: "spotter", pressAction: "mute-unmute" } }));

    expect(dial.setSettings.mock.calls).toEqual([
      [{ dial: { category: "spotter", pressAction: "skip-call" } }],
      [{ dial: { category: "spotter", pressAction: "skip-call" }, addedWithVersion: STAMP }],
    ]);
  });
});

describe("describeAudioVolumeKey", () => {
  it("describes the eight volume keys and nothing else", () => {
    for (const [category, act, label] of VOLUME_PAIRS) {
      expect(describeAudioVolumeKey({ category, action: act })).toMatchObject({ label });
    }

    expect(describeAudioVolumeKey({ category: "push-to-talk", action: "volume-up" })).toBeNull();
    expect(describeAudioVolumeKey({ category: "voice-chat", action: "mute" })).toBeNull();
    expect(describeAudioVolumeKey({ category: "voice-chat", action: "mute-driver" })).toBeNull();
    expect(describeAudioVolumeKey({ category: "radar", action: "mute" })).toBeNull();
  });

  it("gives a level reader to iRaceDeck's own volumes only", () => {
    expect(describeAudioVolumeKey({ category: "master", action: "volume-up" })?.readLevel).toBeUndefined();
    expect(describeAudioVolumeKey({ category: "voice-chat", action: "volume-up" })?.readLevel).toBeUndefined();
    expect(describeAudioVolumeKey({ category: "radar", action: "volume-up" })?.readLevel?.()).toEqual({
      level: 50,
      enabled: true,
    });
  });
});

describe("renderAudioControlsIcon", () => {
  it.each(VOLUME_PAIRS)("draws %s %s through the shared volume module", (category, act, label, glyph) => {
    const svg = svgOf(renderAudioControlsIcon(settings({ category, action: act, keyStyle: "split" })));
    expect(svg).toContain(`>${label}<`);
    expect(svg).toContain(`>${glyph}</text>`);
    expect(svg).not.toContain("VOL UP");
    expect(svg).not.toContain("VOL DOWN");
  });

  it("draws a Legacy volume key with its existing icon", () => {
    const s = settings({ category: "master", action: "volume-up", keyStyle: "legacy" });
    expect(renderAudioControlsIcon(s)).toBe(generateAudioControlsSvg(s));
  });

  it("draws every other pair with its existing icon, whatever its stored style", () => {
    for (const raw of [
      { category: "push-to-talk" },
      { category: "voice-chat", action: "mute" },
      { category: "voice-chat", action: "mute-driver" },
    ]) {
      const s = settings({ ...raw, keyStyle: "split" });
      expect(renderAudioControlsIcon(s)).toBe(generateAudioControlsSvg(s));
    }
  });

  it("keeps the #1196 warning icon on an unavailable pair", () => {
    const s = settings({ category: "radar", action: "mute", keyStyle: "split" });
    expect(renderAudioControlsIcon(s)).toBe(generateAudioControlsSvg(s));
    expect(svgOf(renderAudioControlsIcon(s))).toBe(svgOf(generateAudioControlsSvg(s, true)));
  });

  it("draws Split on Master as Big +/− with its label (no value)", () => {
    const svg = svgOf(
      renderAudioControlsIcon(settings({ category: "master", action: "volume-up", keyStyle: "split" })),
    );
    const bigGlyph = svgOf(
      renderAudioControlsIcon(settings({ category: "master", action: "volume-up", keyStyle: "big-glyph" })),
    );
    expect(svg).toBe(bigGlyph);
    expect(svg).toContain(">MASTER<");
  });

  it("shows the Race Engineer level, and OFF while the Race Engineer is off", () => {
    const s = settings({ category: "race-engineer", action: "volume-up", keyStyle: "split" });
    levels["race-engineer"] = 55;
    expect(svgOf(renderAudioControlsIcon(s))).toContain(">55</text>");

    enabled["race-engineer"] = false;
    expect(svgOf(renderAudioControlsIcon(s))).toContain(">OFF</text>");
  });
});

describe("the key on the deck", () => {
  it("re-renders a Race Engineer key's level on a global-settings change (the base runs the regenerate callback)", async () => {
    const action = new AudioControls();
    const key = keyAction();
    await action.onWillAppear(event(key, { category: "race-engineer", action: "volume-down", keyStyle: "split" }));

    const regenerate = vi.mocked(action["setRegenerateCallback"]).mock.calls[0][1] as () => string;
    expect(svgOf(regenerate())).toContain(">50</text>");

    levels["race-engineer"] = 65;
    expect(svgOf(regenerate())).toContain(">65</text>");

    enabled["race-engineer"] = false;
    expect(svgOf(regenerate())).toContain(">OFF</text>");
  });

  it("shows the #612 missing-binding overlay on a Master key in a paired style", async () => {
    mockIsBindingMissing.mockImplementation((keys) => keys === "audioMasterVolumeUp");
    const action = new AudioControls();
    const key = keyAction();
    const raw = { category: "master", action: "volume-up", keyStyle: "joined-pill" };
    await action.onWillAppear(event(key, raw));

    const shown = vi.mocked(action["setKeyImage"]).mock.calls[0][1];
    expect(shown).toBe(renderAudioControlsIcon(settings(raw), true));
    expect(shown).not.toBe(renderAudioControlsIcon(settings(raw), false));
  });
});

describe("hold to repeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function press(action: AudioControls, raw: Record<string, unknown>, holdForMs: number) {
    const key = keyAction();
    await action.onKeyDown(event(key, raw));
    await vi.advanceTimersByTimeAsync(holdForMs);
    await action.onKeyUp(event(key, raw));
    await vi.advanceTimersByTimeAsync(2000);
  }

  it("a quick tap on a Master key steps once", async () => {
    await press(new AudioControls(), { category: "master", action: "volume-up", keyStyle: "split" }, 100);
    expect(mockTapBinding).toHaveBeenCalledTimes(1);
  });

  it("a held Master key taps its binding again every step until released", async () => {
    // threshold 500 ms, then a step every 150 ms: repeats at 650, 800, 950.
    await press(new AudioControls(), { category: "master", action: "volume-down", keyStyle: "split" }, 1000);
    expect(mockTapBinding).toHaveBeenCalledTimes(4);
    expect(new Set(mockTapBinding.mock.calls.map((c) => c[0]))).toEqual(new Set(["audioMasterVolumeDown"]));
  });

  it("a held Voice Chat key ticks the press and every repeat step (#1455)", async () => {
    await press(new AudioControls(), { category: "voice-chat", action: "volume-up", keyStyle: "split" }, 1000);
    expect(mockTapBinding).toHaveBeenCalledTimes(4);
    expect(mockTick.mock.calls).toEqual([["up"], ["up"], ["up"], ["up"]]);
  });

  it("a held Master key whose tap is not sent neither repeats nor ticks (#1455)", async () => {
    mockTapBinding.mockImplementation(async () => false);
    await press(new AudioControls(), { category: "master", action: "volume-up", keyStyle: "split" }, 1000);
    expect(mockTick).not.toHaveBeenCalled();
  });

  it("a held Radar key leaves its ticks to the step helper (#1455)", async () => {
    await press(new AudioControls(), { category: "radar", action: "volume-down", keyStyle: "split" }, 1000);
    expect(stepRadarVolumeBy).toHaveBeenCalledTimes(4);
    expect(mockTick).not.toHaveBeenCalled();
  });

  it("a held Legacy key steps once", async () => {
    await press(new AudioControls(), { category: "master", action: "volume-up", keyStyle: "legacy" }, 1000);
    expect(mockTapBinding).toHaveBeenCalledTimes(1);
  });

  it("a held Radar key steps the level 5 % at a time", async () => {
    await press(new AudioControls(), { category: "radar", action: "volume-up", keyStyle: "edge-chevrons" }, 1000);
    expect(stepRadarVolumeBy).toHaveBeenCalledTimes(4);
    expect(stepRadarVolumeBy.mock.calls.every((c) => c[0] === 1)).toBe(true);
    expect(levels.radar).toBe(70);
  });

  it("stops repeating once the level reaches its limit", async () => {
    levels.radar = 90;
    await press(new AudioControls(), { category: "radar", action: "volume-up", keyStyle: "split" }, 3000);
    // 90 → 95 (press), → 100 (repeat), then a step that leaves it at 100 ends the repeat.
    expect(stepRadarVolumeBy).toHaveBeenCalledTimes(3);
    expect(levels.radar).toBe(100);
  });

  it("stops repeating when a settings change arrives mid-hold", async () => {
    const action = new AudioControls();
    const key = keyAction();
    const raw = { category: "master", action: "volume-up", keyStyle: "split" };
    await action.onKeyDown(event(key, raw));
    await vi.advanceTimersByTimeAsync(700);
    await action.onDidReceiveSettings(event(key, raw));
    const calls = mockTapBinding.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockTapBinding).toHaveBeenCalledTimes(calls);
  });
});
