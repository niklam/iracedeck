/**
 * Paired +/− key styles on Spotter Louder / Quieter (#1453): the fresh-key
 * seed, the render path through the shared volume module, the `.catch` on
 * `control`, and hold-to-repeat. Runs the real renderer with real zod
 * settings.
 */
import { dataUriToSvg } from "@iracedeck/deck-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AiSpotterControls,
  AiSpotterControlsSettings,
  describeSpotterVolumeKey,
  generateAiSpotterControlsSvg,
  renderAiSpotterControlsIcon,
} from "./ai-spotter-controls.js";

const { mockTapBinding, mockIsBindingMissing } = vi.hoisted(() => ({
  mockTapBinding: vi.fn(async (_key: string) => true),
  mockIsBindingMissing: vi.fn((_keys?: string | readonly string[] | null) => false),
}));

// The tick (#1455) is counted, not played: every hold-repeat step goes
// through performVolumeStep, so each one ticks.
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
      setActiveBinding = vi.fn();
      tapBinding = mockTapBinding;
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
}));

function keyAction(id = "key-1") {
  return {
    id,
    isDial: () => false,
    isKey: () => true,
    setTitle: vi.fn().mockResolvedValue(undefined),
    setImage: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
  };
}

function event(action: ReturnType<typeof keyAction>, settings: Record<string, unknown>) {
  return { action, payload: { settings } } as never;
}

const settings = (raw: Record<string, unknown>) => AiSpotterControlsSettings.parse(raw);
const svgOf = (uri: string) => dataUriToSvg(uri);

beforeEach(() => {
  vi.clearAllMocks();
  mockTapBinding.mockImplementation(async () => true);
  mockIsBindingMissing.mockImplementation(() => false);
});

describe("settings", () => {
  it("defaults to Legacy and Auto", () => {
    expect(settings({})).toMatchObject({ control: "damage-report", keyStyle: "legacy", pairPosition: "auto" });
  });

  it("an unknown stored control lands on Damage Report and keeps the key style", () => {
    expect(settings({ control: "from-the-future", keyStyle: "joined-pill", pairPosition: "top" })).toMatchObject({
      control: "damage-report",
      keyStyle: "joined-pill",
      pairPosition: "top",
    });
  });
});

describe("fresh-key seed", () => {
  it("seeds a fresh key with Split, and the addedWithVersion stamp written after it keeps it", async () => {
    const key = keyAction();
    await new AiSpotterControls().onWillAppear(event(key, {}));

    expect(key.setSettings.mock.calls).toEqual([
      [{ keyStyle: "split" }],
      [{ keyStyle: "split", addedWithVersion: STAMP }],
    ]);
  });

  it("does not seed a configured key", async () => {
    const key = keyAction();
    await new AiSpotterControls().onWillAppear(event(key, { control: "louder" }));

    expect(key.setSettings.mock.calls).toEqual([[{ control: "louder", addedWithVersion: STAMP }]]);
  });
});

describe("renderAiSpotterControlsIcon", () => {
  it("describes Louder and Quieter as the volume pair and nothing else", () => {
    expect(describeSpotterVolumeKey("louder")).toEqual({ label: "SPOTTER", direction: "increase" });
    expect(describeSpotterVolumeKey("quieter")).toEqual({ label: "SPOTTER", direction: "decrease" });

    for (const control of [
      "damage-report",
      "weather-report",
      "toggle-report-laps",
      "announce-leader",
      "silence",
    ] as const) {
      expect(describeSpotterVolumeKey(control)).toBeNull();
    }
  });

  it("draws Split on Louder as Big + with the SPOTTER label (iRacing reports no spotter volume)", () => {
    const svg = svgOf(renderAiSpotterControlsIcon(settings({ control: "louder", keyStyle: "split" })));
    expect(svg).toBe(svgOf(renderAiSpotterControlsIcon(settings({ control: "louder", keyStyle: "big-glyph" }))));
    expect(svg).toContain(">SPOTTER<");
    expect(svg).toContain(">+</text>");
  });

  it("draws Joined pill on Quieter as Pill end", () => {
    const svg = svgOf(renderAiSpotterControlsIcon(settings({ control: "quieter", keyStyle: "joined-pill" })));
    expect(svg).toBe(svgOf(renderAiSpotterControlsIcon(settings({ control: "quieter", keyStyle: "pill-end" }))));
    expect(svg).toContain(">−</text>");
  });

  it("draws a Legacy volume key, the report keys and Skip Spotter Call with their existing icons", () => {
    for (const raw of [
      { control: "louder", keyStyle: "legacy" },
      { control: "damage-report", keyStyle: "split" },
      { control: "announce-leader", keyStyle: "split" },
      { control: "silence", keyStyle: "split" },
    ]) {
      const s = settings(raw);
      expect(renderAiSpotterControlsIcon(s)).toBe(generateAiSpotterControlsSvg(s));
    }
  });

  it("shows the #612 missing-binding overlay on the key", async () => {
    mockIsBindingMissing.mockImplementation((keys) => keys === "spotterLouder");
    const action = new AiSpotterControls();
    const raw = { control: "louder", keyStyle: "split" };
    await action.onWillAppear(event(keyAction(), raw));

    const shown = vi.mocked(action["setKeyImage"]).mock.calls[0][1];
    expect(shown).toBe(renderAiSpotterControlsIcon(settings(raw), true));
    expect(shown).not.toBe(renderAiSpotterControlsIcon(settings(raw), false));
  });
});

describe("hold to repeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function press(raw: Record<string, unknown>, holdForMs: number) {
    const action = new AiSpotterControls();
    const key = keyAction();
    await action.onKeyDown(event(key, raw));
    await vi.advanceTimersByTimeAsync(holdForMs);
    await action.onKeyUp(event(key, raw));
    await vi.advanceTimersByTimeAsync(2000);
  }

  it("a quick tap steps once", async () => {
    await press({ control: "louder", keyStyle: "split" }, 100);
    expect(mockTapBinding).toHaveBeenCalledTimes(1);
  });

  it("a held Louder key taps its binding again every step until released", async () => {
    // threshold 500 ms, then a step every 150 ms: repeats at 650, 800, 950.
    await press({ control: "louder", keyStyle: "pill-end" }, 1000);
    expect(mockTapBinding).toHaveBeenCalledTimes(4);
    expect(new Set(mockTapBinding.mock.calls.map((c) => c[0]))).toEqual(new Set(["spotterLouder"]));
  });

  it("ticks once for the press and once for every repeat step (#1455)", async () => {
    await press({ control: "quieter", keyStyle: "split" }, 1000);
    expect(mockTapBinding).toHaveBeenCalledTimes(4);
    expect(mockTick.mock.calls).toEqual([["down"], ["down"], ["down"], ["down"]]);
  });

  it("a held report key never ticks (#1455)", async () => {
    await press({ control: "announce-leader", keyStyle: "split" }, 1000);
    expect(mockTick).not.toHaveBeenCalled();
  });

  it("a held Legacy key steps once", async () => {
    await press({ control: "quieter", keyStyle: "legacy" }, 1000);
    expect(mockTapBinding).toHaveBeenCalledTimes(1);
  });

  it("a held report key taps once, whatever its stored style", async () => {
    await press({ control: "damage-report", keyStyle: "split" }, 1000);
    expect(mockTapBinding).toHaveBeenCalledTimes(1);
  });
});
