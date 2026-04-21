import { beforeEach, describe, expect, it, vi } from "vitest";

// Imports appear above the `vi.mock(...)` blocks because the repo-wide
// prettier config (@elgato/prettier-config + @trivago/prettier-plugin-sort-imports)
// hoists every import to the top and won't leave them interleaved with other
// statements. Vitest transforms `vi.mock(...)` to run before any import at
// module init, so the mocks still apply to the action import below.
import {
  applyVolumes,
  driverNamePath,
  generatePitEngineerSvg,
  PIT_ENGINEER_UUID,
  PitEngineer,
  syncScenarioState,
} from "./pit-engineer.js";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────
//
// Stage 7 is a thin shell: scenario behaviour lives in @iracedeck/audio-scenarios
// (tested there). These tests verify the wiring between the Stream Deck action
// surface (PI settings, buttons, key press, lifecycle) and the audio packages.

const hoisted = vi.hoisted(() => {
  // Scenario engine
  const setEnabled = vi.fn();
  const fire = vi.fn();
  const getScenarioEngine = vi.fn(() => ({ setEnabled, fire }));

  // Audio service
  const setBusVolume = vi.fn();
  const getAudio = vi.fn(() => ({ setBusVolume }));

  // Pit-engineer catalog injectors
  const setDriverNameResolver = vi.fn();
  const setSpotterEnabled = vi.fn();
  const playSpotterTest = vi.fn();

  const FLAG_SCENARIO_IDS = ["pit-engineer.flag-yellow", "pit-engineer.flag-blue"] as const;
  const FUEL_SCENARIO_IDS = ["pit-engineer.fuel-low-5laps"] as const;
  const PIT_LIMITER_SCENARIO_IDS = ["pit-engineer.limiter-speeding"] as const;
  const TOGGLE_SCENARIO_IDS = ["pit-engineer.toggle-fuel-on"] as const;

  // Global settings
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
    setEnabled,
    fire,
    getScenarioEngine,
    setBusVolume,
    getAudio,
    setDriverNameResolver,
    setSpotterEnabled,
    playSpotterTest,
    FLAG_SCENARIO_IDS,
    FUEL_SCENARIO_IDS,
    PIT_LIMITER_SCENARIO_IDS,
    TOGGLE_SCENARIO_IDS,
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

vi.mock("../../../icons/pit-engineer.svg", () => ({
  default:
    '<svg xmlns="http://www.w3.org/2000/svg"><desc>{"colors":{"backgroundColor":"#2c3e50","textColor":"#ffffff","graphic1Color":"#ffffff"}}</desc>{{iconContent}}</svg>',
}));

vi.mock("../../icons/status-bar.js", () => ({
  borderColorForState: vi.fn((state: string) => (state === "on" ? "#2ecc71" : "#e74c3c")),
  statusBarOn: vi.fn(() => '<rect class="status-bar-on"/>'),
  statusBarOff: vi.fn(() => '<rect class="status-bar-off"/>'),
}));

vi.mock("@iracedeck/audio-scenarios", () => ({
  getScenarioEngine: hoisted.getScenarioEngine,
}));

vi.mock("@iracedeck/audio-scenarios/pit-engineer", () => ({
  FLAG_SCENARIO_IDS: hoisted.FLAG_SCENARIO_IDS,
  FUEL_SCENARIO_IDS: hoisted.FUEL_SCENARIO_IDS,
  PIT_LIMITER_SCENARIO_IDS: hoisted.PIT_LIMITER_SCENARIO_IDS,
  TOGGLE_SCENARIO_IDS: hoisted.TOGGLE_SCENARIO_IDS,
  playSpotterTest: hoisted.playSpotterTest,
  setDriverNameResolver: hoisted.setDriverNameResolver,
  setSpotterEnabled: hoisted.setSpotterEnabled,
}));

vi.mock("@iracedeck/audio-service", () => ({
  AudioBus: { Voice: 0, Background: 1, Alerts: 2 },
  getAudio: hoisted.getAudio,
}));

// Targeted deck-core mock — only the members pit-engineer.ts actually imports.
// CommonSettings is a real zod schema here so Settings.parse(...) behaves like
// production (defaults + type coercion). Icon helpers are thin fakes that
// preserve just enough shape for generatePitEngineerSvg to produce a data URI
// with the state-bar marker the snapshot tests grep for.
vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");

  const CommonSettings = z
    .object({
      colorOverrides: z.unknown().optional(),
      titleOverrides: z.unknown().optional(),
      borderOverrides: z.unknown().optional(),
      graphicOverrides: z.unknown().optional(),
    })
    .passthrough();

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
    resolveTitleSettings: vi.fn(() => ({
      showTitle: true,
      showGraphics: true,
      titleText: "PIT\nENGINEER",
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

const DEFAULT_SETTINGS = {
  spotterEnabled: true,
  pitApproachEnabled: true,
  pitServiceReminderEnabled: true,
  pitDepartureEnabled: true,
  pitExitEnabled: true,
  pitLimiterWarning: true,
  incidentAlert: true,
  toggleAudioEnabled: true,
  overtakeAndTipsEnabled: true,
  flagAlertsEnabled: true,
  fuelWarningsEnabled: true,
  fuelStintOpenEnabled: false,
  fuelSaveCoachingEnabled: false,
  fuelMidStintEnabled: false,
  spotterVolume: 100,
  volume: 45,
  driverName: "none" as string,
};

type Settings = typeof DEFAULT_SETTINGS;

type TestInputs = Partial<Settings> & {
  _testVolume?: number;
  _testSpotterVolume?: number;
};

function buildSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function buildAppearEvent(settings: TestInputs, actionId = "ctx-1"): unknown {
  return {
    action: { id: actionId },
    payload: { settings },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.setGlobalSettings({ pitEngineerEnabled: true });
  // Clear hoisted listener sets so cross-test listener counts stay
  // deterministic for tests that don't pair onWillAppear with onWillDisappear.
  hoisted.globalSettingsListeners.clear();
});

describe("PIT_ENGINEER_UUID", () => {
  it("has the correct action UUID", () => {
    expect(PIT_ENGINEER_UUID).toBe("com.iracedeck.sd.core.pit-engineer");
  });
});

describe("driverNamePath", () => {
  it("returns null when driverName is missing", () => {
    expect(driverNamePath(undefined)).toBeNull();
  });

  it('returns null when driverName is "none"', () => {
    expect(driverNamePath("none")).toBeNull();
  });

  it("returns the audio-assets path for a real name", () => {
    expect(driverNamePath("niklas")).toBe("pit-engineer/names/IRD-name-niklas.mp3");
  });

  it("rejects names with path-traversal characters", () => {
    expect(driverNamePath("../../etc/passwd")).toBeNull();
    expect(driverNamePath("foo/bar")).toBeNull();
    expect(driverNamePath("foo.mp3")).toBeNull();
    expect(driverNamePath("NIKLAS")).toBeNull();
  });
});

describe("applyVolumes", () => {
  it("drives the Voice + Background busses off the engineer slider and Alerts off the spotter slider", () => {
    applyVolumes(buildSettings({ volume: 80, spotterVolume: 50 }));

    expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0.8);
    expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 0.8);
    expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.5);
  });

  it("clamps at slider min/max normalized to 0..1", () => {
    applyVolumes(buildSettings({ volume: 5, spotterVolume: 100 }));

    expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0.05);
    expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 1);
  });
});

describe("syncScenarioState", () => {
  it("gates every scenario true when master + per-feature toggle are both on", () => {
    syncScenarioState(buildSettings(), true);

    expect(hoisted.setEnabled).toHaveBeenCalledWith("pit-engineer.welcome", true);
    expect(hoisted.setEnabled).toHaveBeenCalledWith("pit-engineer.pit-approach", true);
    expect(hoisted.setEnabled).toHaveBeenCalledWith("pit-engineer.service-reminder", true);
    expect(hoisted.setEnabled).toHaveBeenCalledWith("pit-engineer.pit-exit", true);
    expect(hoisted.setEnabled).toHaveBeenCalledWith("pit-engineer.stall-departure", true);
    expect(hoisted.setEnabled).toHaveBeenCalledWith("pit-engineer.incident-alerts", true);
    expect(hoisted.setEnabled).toHaveBeenCalledWith("pit-engineer.overtake", true);
    expect(hoisted.setEnabled).toHaveBeenCalledWith("pit-engineer.racing-tips", true);

    for (const id of hoisted.FLAG_SCENARIO_IDS) expect(hoisted.setEnabled).toHaveBeenCalledWith(id, true);

    for (const id of hoisted.FUEL_SCENARIO_IDS) expect(hoisted.setEnabled).toHaveBeenCalledWith(id, true);

    for (const id of hoisted.TOGGLE_SCENARIO_IDS) expect(hoisted.setEnabled).toHaveBeenCalledWith(id, true);

    for (const id of hoisted.PIT_LIMITER_SCENARIO_IDS) expect(hoisted.setEnabled).toHaveBeenCalledWith(id, true);

    expect(hoisted.setSpotterEnabled).toHaveBeenCalledWith(true);
  });

  it("disables every scenario when the master gate is off, regardless of per-feature toggles", () => {
    syncScenarioState(buildSettings(), false);

    const calls = hoisted.setEnabled.mock.calls;

    for (const [, enabled] of calls) {
      expect(enabled).toBe(false);
    }

    expect(hoisted.setSpotterEnabled).toHaveBeenCalledWith(false);
  });

  it("respects individual toggles when master is on", () => {
    syncScenarioState(
      buildSettings({
        pitApproachEnabled: false,
        flagAlertsEnabled: false,
        spotterEnabled: false,
        overtakeAndTipsEnabled: true,
      }),
      true,
    );

    expect(hoisted.setEnabled).toHaveBeenCalledWith("pit-engineer.pit-approach", false);
    expect(hoisted.setEnabled).toHaveBeenCalledWith("pit-engineer.overtake", true);
    expect(hoisted.setEnabled).toHaveBeenCalledWith("pit-engineer.racing-tips", true);

    for (const id of hoisted.FLAG_SCENARIO_IDS) expect(hoisted.setEnabled).toHaveBeenCalledWith(id, false);

    expect(hoisted.setSpotterEnabled).toHaveBeenCalledWith(false);
  });

  it("welcome is always on while master is on, regardless of PI", () => {
    syncScenarioState(buildSettings({ pitApproachEnabled: false }), true);

    expect(hoisted.setEnabled).toHaveBeenCalledWith("pit-engineer.welcome", true);
  });
});

describe("PitEngineer action", () => {
  describe("onWillAppear", () => {
    it("installs the driver-name resolver with the current PI settings", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({ driverName: "niklas" }) as never);

      expect(hoisted.setDriverNameResolver).toHaveBeenCalledTimes(1);
      const resolver = hoisted.setDriverNameResolver.mock.calls[0][0] as () => string | null;
      expect(resolver()).toBe("pit-engineer/names/IRD-name-niklas.mp3");
    });

    it("subscribes to global-settings changes so icons re-render when the master flag changes", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({}) as never);

      expect(hoisted.onGlobalSettingsChange).toHaveBeenCalledTimes(1);
    });

    it("applies volumes and syncs scenarios on appear", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({ volume: 60, spotterVolume: 30 }) as never);

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0.6);
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.3);
      expect(hoisted.setEnabled).toHaveBeenCalledWith("pit-engineer.welcome", true);
    });

    it("gates scenarios off when master is already off at appear time", async () => {
      hoisted.setGlobalSettings({ pitEngineerEnabled: false });
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({}) as never);

      for (const [, enabled] of hoisted.setEnabled.mock.calls) expect(enabled).toBe(false);

      expect(hoisted.setSpotterEnabled).toHaveBeenCalledWith(false);
    });
  });

  describe("onDidReceiveSettings", () => {
    it("fires the welcome scenario when the engineer test timestamp changes", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({ _testVolume: 0 }) as never);

      await action.onDidReceiveSettings(buildAppearEvent({ _testVolume: 42 }) as never);

      expect(hoisted.fire).toHaveBeenCalledWith("pit-engineer.welcome");
    });

    it("does not re-fire welcome on unrelated settings updates", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({ _testVolume: 100 }) as never);

      await action.onDidReceiveSettings(buildAppearEvent({ _testVolume: 100 }) as never);

      expect(hoisted.fire).not.toHaveBeenCalled();
    });

    it("invokes playSpotterTest when the spotter test timestamp changes", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({ _testSpotterVolume: 0 }) as never);

      await action.onDidReceiveSettings(buildAppearEvent({ _testSpotterVolume: 7 }) as never);

      expect(hoisted.playSpotterTest).toHaveBeenCalledTimes(1);
    });

    it("re-applies volumes and re-syncs scenarios", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({ volume: 45, spotterEnabled: true }) as never);
      vi.clearAllMocks();

      await action.onDidReceiveSettings(buildAppearEvent({ volume: 90, spotterEnabled: false }) as never);

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0.9);
      expect(hoisted.setSpotterEnabled).toHaveBeenCalledWith(false);
    });
  });

  describe("onKeyDown", () => {
    it("toggles the master flag in global settings", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({}) as never);

      await action.onKeyDown(buildAppearEvent({}) as never);

      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitEngineerEnabled: false });
    });

    it("synchronously gates all scenarios off with the new master value", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({}) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({}) as never);

      // Every setEnabled call in onKeyDown uses master=false regardless of PI toggles.
      const calls = hoisted.setEnabled.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      for (const [, enabled] of calls) expect(enabled).toBe(false);

      expect(hoisted.setSpotterEnabled).toHaveBeenCalledWith(false);
    });

    it("turns the master back on when already disabled", async () => {
      hoisted.setGlobalSettings({ pitEngineerEnabled: false });
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({}) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({}) as never);

      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitEngineerEnabled: true });
      expect(hoisted.setEnabled).toHaveBeenCalledWith("pit-engineer.welcome", true);
    });
  });

  describe("onWillDisappear", () => {
    it("unsubscribes the global-settings listener", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({}) as never);
      const globalBefore = hoisted.globalSettingsListeners.size;
      expect(globalBefore).toBeGreaterThan(0);

      await action.onWillDisappear(buildAppearEvent({}) as never);

      expect(hoisted.globalSettingsListeners.size).toBe(globalBefore - 1);
    });
  });
});

describe("generatePitEngineerSvg", () => {
  it("returns a data URI", () => {
    const result = generatePitEngineerSvg(DEFAULT_SETTINGS, true);
    expect(result).toContain("data:image/svg+xml");
  });

  it("marks the status bar on when enabled", () => {
    const result = decodeURIComponent(generatePitEngineerSvg(DEFAULT_SETTINGS, true));
    expect(result).toContain("status-bar-on");
  });

  it("marks the status bar off when disabled", () => {
    const result = decodeURIComponent(generatePitEngineerSvg(DEFAULT_SETTINGS, false));
    expect(result).toContain("status-bar-off");
  });

  it("produces different output when enabled flips", () => {
    const on = generatePitEngineerSvg(DEFAULT_SETTINGS, true);
    const off = generatePitEngineerSvg(DEFAULT_SETTINGS, false);
    expect(on).not.toBe(off);
  });
});
