import { beforeEach, describe, expect, it, vi } from "vitest";

// Imports appear above the `vi.mock(...)` blocks because the repo-wide
// prettier config (@elgato/prettier-config + @trivago/prettier-plugin-sort-imports)
// hoists every import to the top and won't leave them interleaved with other
// statements. Vitest transforms `vi.mock(...)` to run before any import at
// module init, so the mocks still apply to the action import below.
import {
  applyRadarEnabled,
  applyRadarVolume,
  generatePitCrewSvg,
  PIT_CREW_UUID,
  PitCrew,
  Settings,
} from "./pit-crew.js";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────
//
// Pit Crew is a multi-mode action (#413): Race Engineer (voice toggle),
// Radar (proximity-tick toggle), Radar Volume +/−. Race Engineer voice
// scenarios are deferred to follow-up PRs (#410) — the Race Engineer mode
// here just flips a global flag; no audio is attached yet.

const hoisted = vi.hoisted(() => {
  const setBusVolume = vi.fn();
  const getAudio = vi.fn(() => ({ setBusVolume }));

  const setRadarEnabled = vi.fn();
  const playRadarTest = vi.fn();

  let globalSettings: Record<string, unknown> = {};
  const updateGlobalSettings = vi.fn((partial: Record<string, unknown>) => {
    globalSettings = { ...globalSettings, ...partial };
  });
  const getGlobalSettings = vi.fn(() => globalSettings);
  const globalSettingsListeners = new Set<() => void>();
  const onGlobalSettingsChange = vi.fn((listener: () => void) => {
    globalSettingsListeners.add(listener);

    return () => {
      globalSettingsListeners.delete(listener);
    };
  });

  return {
    setBusVolume,
    getAudio,
    setRadarEnabled,
    playRadarTest,
    updateGlobalSettings,
    getGlobalSettings,
    globalSettingsListeners,
    onGlobalSettingsChange,
    setGlobalSettings: (next: Record<string, unknown>) => {
      globalSettings = next;
    },
  };
});

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock("../../../icons/pit-crew.svg", () => ({
  default:
    '<svg xmlns="http://www.w3.org/2000/svg"><desc>{"colors":{"backgroundColor":"#2c3e50","textColor":"#ffffff","graphic1Color":"#ffffff"}}</desc>{{iconContent}}</svg>',
}));

vi.mock("../../icons/status-bar.js", () => ({
  borderColorForState: vi.fn((state: string) => (state === "on" ? "#2ecc71" : "#e74c3c")),
  statusBarOn: vi.fn(() => '<rect class="status-bar-on"/>'),
  statusBarOff: vi.fn(() => '<rect class="status-bar-off"/>'),
}));

vi.mock("@iracedeck/audio-scenarios/pit-crew", () => ({
  playRadarTest: hoisted.playRadarTest,
  setRadarEnabled: hoisted.setRadarEnabled,
}));

vi.mock("@iracedeck/audio-service", () => ({
  AudioBus: { Voice: 0, Background: 1, Alerts: 2 },
  getAudio: hoisted.getAudio,
}));

vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");

  const CommonSettings = z.object({
    colorOverrides: z.unknown().optional(),
    titleOverrides: z.unknown().optional(),
    borderOverrides: z.unknown().optional(),
    graphicOverrides: z.unknown().optional(),
  });

  class MockConnectionStateAwareAction {
    logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getConnectionStatus: vi.fn(() => true) };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn().mockResolvedValue(undefined);
    updateKeyImage = vi.fn().mockResolvedValue(true);
    setRegenerateCallback = vi.fn();
    async onWillAppear(): Promise<void> {}
    async onWillDisappear(): Promise<void> {}
    async onDidReceiveSettings(): Promise<void> {}
  }

  return {
    CommonSettings,
    ConnectionStateAwareAction: MockConnectionStateAwareAction,
    applyGraphicTransform: vi.fn((content: string) => content),
    computeGraphicArea: vi.fn(() => ({ x: 8, y: 8, width: 128, height: 84 })),
    generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
    generateTitleText: vi.fn((opts: { text: string; fill: string }) =>
      opts.text ? `<text fill="${opts.fill}">${opts.text}</text>` : "",
    ),
    getGlobalBorderSettings: vi.fn(() => ({})),
    getGlobalColors: vi.fn(() => ({})),
    getGlobalGraphicSettings: vi.fn(() => ({})),
    getGlobalSettings: hoisted.getGlobalSettings,
    getGlobalTitleSettings: vi.fn(() => ({})),
    onGlobalSettingsChange: hoisted.onGlobalSettingsChange,
    renderIconTemplate: vi.fn((template: string, data: Record<string, string>) => {
      let result = template;

      for (const [key, val] of Object.entries(data)) {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), val);
      }

      return result;
    }),
    resolveBorderSettings: vi.fn(() => ({
      enabled: false,
      borderWidth: 7,
      borderColor: "#00aaff",
      glowEnabled: false,
      glowWidth: 18,
    })),
    resolveGraphicSettings: vi.fn(() => ({ scale: 1 })),
    resolveIconColors: vi.fn(() => ({
      backgroundColor: "#2c3e50",
      textColor: "#ffffff",
      graphic1Color: "#ffffff",
    })),
    resolveTitleSettings: vi.fn((_t: string, _g: unknown, _o: unknown, defaultText: string) => ({
      showTitle: true,
      showGraphics: true,
      titleText: defaultText,
      bold: true,
      fontSize: 18,
      position: "bottom" as const,
      customPosition: 0,
    })),
    svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
    updateGlobalSettings: hoisted.updateGlobalSettings,
  };
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

type TestInputs = {
  mode?: "race-engineer" | "radar" | "radar-volume";
  direction?: "up" | "down";
  _testRadarVolume?: number;
};

function buildAppearEvent(settings: TestInputs = {}, actionId = "ctx-1"): unknown {
  return {
    action: { id: actionId },
    payload: { settings },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.setGlobalSettings({ raceEngineerEnabled: true, radarEnabled: true, radarVolume: 100 });
  hoisted.globalSettingsListeners.clear();
});

describe("PIT_CREW_UUID", () => {
  it("has the correct action UUID", () => {
    expect(PIT_CREW_UUID).toBe("com.iracedeck.sd.core.pit-crew");
  });
});

describe("Settings (persisted legacy field stripping)", () => {
  it("defaults mode to race-engineer and direction to up", () => {
    const parsed = Settings.parse({});

    expect(parsed.mode).toBe("race-engineer");
    expect(parsed.direction).toBe("up");
  });

  it("silently drops pre-#413 action-level fields via Zod's default strip mode", () => {
    const raw = {
      mode: "radar" as const,
      direction: "down" as const,
      radarEnabled: true,
      radarVolume: 75,
      pitEngineerEnabled: true,
      spotterEnabled: true,
      spotterVolume: 50,
      volume: 45,
      driverName: "niklas",
    };

    const parsed = Settings.parse(raw) as Record<string, unknown>;

    expect(parsed.mode).toBe("radar");
    expect(parsed.direction).toBe("down");

    for (const legacy of [
      "radarEnabled",
      "radarVolume",
      "pitEngineerEnabled",
      "spotterEnabled",
      "spotterVolume",
      "volume",
      "driverName",
    ]) {
      expect(parsed).not.toHaveProperty(legacy);
    }
  });
});

describe("applyRadarVolume", () => {
  it("copies the global radarVolume onto AudioBus.Alerts", () => {
    hoisted.setGlobalSettings({ radarVolume: 50 });
    applyRadarVolume();

    expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.5);
  });

  it("defaults to 100% when the global value is missing", () => {
    hoisted.setGlobalSettings({});
    applyRadarVolume();

    expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 1);
  });

  it("clamps out-of-range persisted values", () => {
    hoisted.setGlobalSettings({ radarVolume: 250 });
    applyRadarVolume();

    expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 1);
  });
});

describe("applyRadarEnabled", () => {
  it("pushes the current global radarEnabled into the engine", () => {
    hoisted.setGlobalSettings({ radarEnabled: false });
    applyRadarEnabled();
    expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(false);

    vi.clearAllMocks();
    hoisted.setGlobalSettings({ radarEnabled: true });
    applyRadarEnabled();
    expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(true);
  });
});

describe("PitCrew action", () => {
  describe("onWillAppear", () => {
    it("subscribes to global-settings changes so icons re-render on any feature flip", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);

      expect(hoisted.onGlobalSettingsChange).toHaveBeenCalledTimes(1);
    });

    it("asserts current global radar state into the engine + audio bus on mount", async () => {
      hoisted.setGlobalSettings({ raceEngineerEnabled: true, radarEnabled: true, radarVolume: 40 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.4);
      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(true);
    });
  });

  describe("onDidReceiveSettings", () => {
    it("invokes playRadarTest when the hidden _testRadarVolume timestamp changes", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ _testRadarVolume: 0 }) as never);

      await action.onDidReceiveSettings(buildAppearEvent({ _testRadarVolume: 7 }) as never);

      expect(hoisted.playRadarTest).toHaveBeenCalledTimes(1);
    });

    it("does not re-fire on unrelated settings echoes", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ _testRadarVolume: 100 }) as never);

      await action.onDidReceiveSettings(buildAppearEvent({ _testRadarVolume: 100 }) as never);

      expect(hoisted.playRadarTest).not.toHaveBeenCalled();
    });

    it("tracks the test baseline per context so two instances don't interfere", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ _testRadarVolume: 100 }, "ctx-A") as never);
      await action.onWillAppear(buildAppearEvent({ _testRadarVolume: 200 }, "ctx-B") as never);
      vi.clearAllMocks();

      await action.onDidReceiveSettings(buildAppearEvent({ _testRadarVolume: 100 }, "ctx-A") as never);
      expect(hoisted.playRadarTest).not.toHaveBeenCalled();

      await action.onDidReceiveSettings(buildAppearEvent({ _testRadarVolume: 999 }, "ctx-A") as never);
      expect(hoisted.playRadarTest).toHaveBeenCalledTimes(1);
    });
  });

  describe("onKeyDown — race-engineer mode", () => {
    it("toggles raceEngineerEnabled without touching radar state", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "race-engineer" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "race-engineer" }) as never);

      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ raceEngineerEnabled: false });
      expect(hoisted.setRadarEnabled).not.toHaveBeenCalled();
    });

    it("flips back on when already off", async () => {
      hoisted.setGlobalSettings({ raceEngineerEnabled: false, radarEnabled: true, radarVolume: 100 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "race-engineer" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "race-engineer" }) as never);

      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ raceEngineerEnabled: true });
    });
  });

  describe("onKeyDown — radar mode", () => {
    it("flips radarEnabled synchronously via setRadarEnabled and updates the global", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "radar" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "radar" }) as never);

      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(false);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ radarEnabled: false });
    });

    it("does not touch raceEngineerEnabled when toggling radar (independent feature gates)", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "radar" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "radar" }) as never);

      const updates = hoisted.updateGlobalSettings.mock.calls.flatMap(([partial]) => Object.keys(partial));
      expect(updates).not.toContain("raceEngineerEnabled");
    });
  });

  describe("onKeyDown — radar-volume mode", () => {
    it("steps radarVolume up by 5 on direction=up", async () => {
      hoisted.setGlobalSettings({ raceEngineerEnabled: true, radarEnabled: true, radarVolume: 70 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "radar-volume", direction: "up" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "radar-volume", direction: "up" }) as never);

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.75);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ radarVolume: 75 });
    });

    it("steps down by 5 on direction=down", async () => {
      hoisted.setGlobalSettings({ raceEngineerEnabled: true, radarEnabled: true, radarVolume: 70 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "radar-volume", direction: "down" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "radar-volume", direction: "down" }) as never);

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.65);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ radarVolume: 65 });
    });

    it("clamps at 100 (no-op when already at max)", async () => {
      hoisted.setGlobalSettings({ raceEngineerEnabled: true, radarEnabled: true, radarVolume: 100 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "radar-volume", direction: "up" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "radar-volume", direction: "up" }) as never);

      expect(hoisted.updateGlobalSettings).not.toHaveBeenCalled();
    });

    it("clamps at 5 (no-op when already at min)", async () => {
      hoisted.setGlobalSettings({ raceEngineerEnabled: true, radarEnabled: true, radarVolume: 5 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "radar-volume", direction: "down" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "radar-volume", direction: "down" }) as never);

      expect(hoisted.updateGlobalSettings).not.toHaveBeenCalled();
    });
  });

  describe("independent feature gates (#413 core requirement)", () => {
    it("race-engineer off + radar on: radar tick loop still runs", async () => {
      hoisted.setGlobalSettings({ raceEngineerEnabled: false, radarEnabled: true, radarVolume: 100 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);

      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(true);
    });

    it("race-engineer on + radar off: radar tick loop is silenced", async () => {
      hoisted.setGlobalSettings({ raceEngineerEnabled: true, radarEnabled: false, radarVolume: 100 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);

      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(false);
    });
  });

  describe("onWillDisappear", () => {
    it("unsubscribes the global-settings listener", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);
      const before = hoisted.globalSettingsListeners.size;
      expect(before).toBeGreaterThan(0);

      await action.onWillDisappear(buildAppearEvent() as never);

      expect(hoisted.globalSettingsListeners.size).toBe(before - 1);
    });
  });
});

describe("generatePitCrewSvg", () => {
  it("returns a data URI", () => {
    const result = generatePitCrewSvg(Settings.parse({ mode: "race-engineer" }));
    expect(result).toContain("data:image/svg+xml");
  });

  it("paints the status bar ON for race-engineer mode when raceEngineerEnabled is true", () => {
    hoisted.setGlobalSettings({ raceEngineerEnabled: true });
    const result = decodeURIComponent(generatePitCrewSvg(Settings.parse({ mode: "race-engineer" })));
    expect(result).toContain("status-bar-on");
  });

  it("paints the status bar OFF for race-engineer mode when raceEngineerEnabled is false", () => {
    hoisted.setGlobalSettings({ raceEngineerEnabled: false });
    const result = decodeURIComponent(generatePitCrewSvg(Settings.parse({ mode: "race-engineer" })));
    expect(result).toContain("status-bar-off");
  });

  it("paints the status bar ON for radar mode when radarEnabled is true", () => {
    hoisted.setGlobalSettings({ radarEnabled: true });
    const result = decodeURIComponent(generatePitCrewSvg(Settings.parse({ mode: "radar" })));
    expect(result).toContain("status-bar-on");
  });

  it("paints the status bar OFF for radar mode when radarEnabled is false", () => {
    hoisted.setGlobalSettings({ radarEnabled: false });
    const result = decodeURIComponent(generatePitCrewSvg(Settings.parse({ mode: "radar" })));
    expect(result).toContain("status-bar-off");
  });

  it("omits the status bar entirely for radar-volume mode (no on/off state)", () => {
    const result = decodeURIComponent(generatePitCrewSvg(Settings.parse({ mode: "radar-volume", direction: "up" })));
    expect(result).not.toContain("status-bar-on");
    expect(result).not.toContain("status-bar-off");
  });

  it("includes the current radarVolume in the title for radar-volume mode", () => {
    hoisted.setGlobalSettings({ radarVolume: 65 });
    const result = decodeURIComponent(generatePitCrewSvg(Settings.parse({ mode: "radar-volume", direction: "up" })));
    expect(result).toContain("65%");
  });
});
