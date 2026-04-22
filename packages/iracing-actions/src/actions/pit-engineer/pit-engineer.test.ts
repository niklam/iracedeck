import { beforeEach, describe, expect, it, vi } from "vitest";

// Imports appear above the `vi.mock(...)` blocks because the repo-wide
// prettier config (@elgato/prettier-config + @trivago/prettier-plugin-sort-imports)
// hoists every import to the top and won't leave them interleaved with other
// statements. Vitest transforms `vi.mock(...)` to run before any import at
// module init, so the mocks still apply to the action import below.
import {
  applyVolumes,
  generatePitEngineerSvg,
  PIT_ENGINEER_UUID,
  PitEngineer,
  Settings,
  syncScenarioState,
} from "./pit-engineer.js";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────
//
// Initial GA ships spotter-only (#410). These tests verify the wiring between
// the Stream Deck action surface (PI settings, spotter test button, key press,
// lifecycle) and the audio packages.

const hoisted = vi.hoisted(() => {
  // Audio service
  const setBusVolume = vi.fn();
  const getAudio = vi.fn(() => ({ setBusVolume }));

  // Pit-engineer catalog injectors
  const setSpotterEnabled = vi.fn();
  const playSpotterTest = vi.fn();

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
    setBusVolume,
    getAudio,
    setSpotterEnabled,
    playSpotterTest,
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

vi.mock("@iracedeck/audio-scenarios/pit-engineer", () => ({
  playSpotterTest: hoisted.playSpotterTest,
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

  // Matches production's `z.object(...)` with Zod's default strip mode —
  // unknown keys are silently dropped on parse.
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
  spotterVolume: 100,
};

type DefaultSettings = typeof DEFAULT_SETTINGS;

type TestInputs = Partial<DefaultSettings> & {
  _testSpotterVolume?: number;
};

function buildSettings(overrides: Partial<DefaultSettings> = {}): DefaultSettings {
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

describe("applyVolumes", () => {
  it("drives the Alerts bus off the spotter slider", () => {
    applyVolumes(buildSettings({ spotterVolume: 50 }));

    expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.5);
  });

  it("normalizes the slider min to 0.05", () => {
    applyVolumes(buildSettings({ spotterVolume: 5 }));
    expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.05);
  });

  it("normalizes the slider max to 1", () => {
    applyVolumes(buildSettings({ spotterVolume: 100 }));
    expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 1);
  });

  it("does not touch the Voice or Background busses", () => {
    applyVolumes(buildSettings({ spotterVolume: 80 }));

    const callTargets = hoisted.setBusVolume.mock.calls.map(([bus]) => bus);
    expect(callTargets).not.toContain(0); // Voice
    expect(callTargets).not.toContain(1); // Background
  });
});

describe("syncScenarioState", () => {
  it("enables the spotter when master + PI toggle are both on", () => {
    syncScenarioState(buildSettings(), true);

    expect(hoisted.setSpotterEnabled).toHaveBeenCalledWith(true);
  });

  it("disables the spotter when the master gate is off regardless of PI", () => {
    syncScenarioState(buildSettings({ spotterEnabled: true }), false);

    expect(hoisted.setSpotterEnabled).toHaveBeenCalledWith(false);
  });

  it("disables the spotter when the PI toggle is off even if master is on", () => {
    syncScenarioState(buildSettings({ spotterEnabled: false }), true);

    expect(hoisted.setSpotterEnabled).toHaveBeenCalledWith(false);
  });
});

describe("PitEngineer action", () => {
  describe("onWillAppear", () => {
    it("subscribes to global-settings changes so icons re-render when the master flag changes", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({}) as never);

      expect(hoisted.onGlobalSettingsChange).toHaveBeenCalledTimes(1);
    });

    it("applies volumes and syncs the spotter on appear", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({ spotterVolume: 30 }) as never);

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.3);
      expect(hoisted.setSpotterEnabled).toHaveBeenCalledWith(true);
    });

    it("gates the spotter off when master is already off at appear time", async () => {
      hoisted.setGlobalSettings({ pitEngineerEnabled: false });
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({}) as never);

      expect(hoisted.setSpotterEnabled).toHaveBeenCalledWith(false);
    });
  });

  describe("onDidReceiveSettings", () => {
    it("invokes playSpotterTest when the spotter test timestamp changes", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({ _testSpotterVolume: 0 }) as never);

      await action.onDidReceiveSettings(buildAppearEvent({ _testSpotterVolume: 7 }) as never);

      expect(hoisted.playSpotterTest).toHaveBeenCalledTimes(1);
    });

    it("does not re-fire the spotter test on unrelated settings updates", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({ _testSpotterVolume: 100 }) as never);

      await action.onDidReceiveSettings(buildAppearEvent({ _testSpotterVolume: 100 }) as never);

      expect(hoisted.playSpotterTest).not.toHaveBeenCalled();
    });

    it("re-applies volumes and re-syncs the spotter", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({ spotterVolume: 45, spotterEnabled: true }) as never);
      vi.clearAllMocks();

      await action.onDidReceiveSettings(buildAppearEvent({ spotterVolume: 90, spotterEnabled: false }) as never);

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.9);
      expect(hoisted.setSpotterEnabled).toHaveBeenCalledWith(false);
    });

    it("tracks the spotter-test baseline per context so two instances don't interfere", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({ _testSpotterVolume: 100 }, "ctx-A") as never);
      await action.onWillAppear(buildAppearEvent({ _testSpotterVolume: 200 }, "ctx-B") as never);
      vi.clearAllMocks();

      // Settings echo on ctx-A with its own baseline timestamp must NOT replay
      // the preview just because ctx-B last seeded a different baseline.
      await action.onDidReceiveSettings(buildAppearEvent({ _testSpotterVolume: 100 }, "ctx-A") as never);
      expect(hoisted.playSpotterTest).not.toHaveBeenCalled();

      // A real Test press on ctx-A still plays.
      await action.onDidReceiveSettings(buildAppearEvent({ _testSpotterVolume: 999 }, "ctx-A") as never);
      expect(hoisted.playSpotterTest).toHaveBeenCalledTimes(1);
    });
  });

  describe("onKeyDown", () => {
    it("toggles the master flag in global settings", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({}) as never);

      await action.onKeyDown(buildAppearEvent({}) as never);

      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitEngineerEnabled: false });
    });

    it("synchronously gates the spotter off with the new master value", async () => {
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({}) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({}) as never);

      expect(hoisted.setSpotterEnabled).toHaveBeenCalledWith(false);
    });

    it("turns the master back on when already disabled", async () => {
      hoisted.setGlobalSettings({ pitEngineerEnabled: false });
      const action = new PitEngineer();
      await action.onWillAppear(buildAppearEvent({}) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({}) as never);

      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitEngineerEnabled: true });
      expect(hoisted.setSpotterEnabled).toHaveBeenCalledWith(true);
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

describe("Settings.parse (persisted legacy fields)", () => {
  it("silently drops pre-GA toggle fields via Zod's default strip mode", () => {
    const raw = {
      spotterEnabled: true,
      spotterVolume: 75,
      // Every field removed in #410.
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
      fuelStintOpenEnabled: true,
      fuelMidStintEnabled: true,
      fuelSaveCoachingEnabled: true,
      volume: 45,
      driverName: "niklas",
    };

    const parsed = Settings.parse(raw) as Record<string, unknown>;

    expect(parsed.spotterEnabled).toBe(true);
    expect(parsed.spotterVolume).toBe(75);

    for (const legacy of [
      "pitApproachEnabled",
      "pitServiceReminderEnabled",
      "pitDepartureEnabled",
      "pitExitEnabled",
      "pitLimiterWarning",
      "incidentAlert",
      "toggleAudioEnabled",
      "overtakeAndTipsEnabled",
      "flagAlertsEnabled",
      "fuelWarningsEnabled",
      "fuelStintOpenEnabled",
      "fuelMidStintEnabled",
      "fuelSaveCoachingEnabled",
      "volume",
      "driverName",
    ]) {
      expect(parsed).not.toHaveProperty(legacy);
    }
  });

  it("drives the action lifecycle without errors when raw payload carries legacy fields", async () => {
    const action = new PitEngineer();
    const legacyPayload = {
      spotterEnabled: true,
      spotterVolume: 60,
      pitApproachEnabled: true,
      driverName: "niklas",
      volume: 45,
    };

    await expect(action.onWillAppear(buildAppearEvent(legacyPayload) as never)).resolves.not.toThrow();
    expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.6);
    expect(hoisted.setSpotterEnabled).toHaveBeenCalledWith(true);
  });
});
