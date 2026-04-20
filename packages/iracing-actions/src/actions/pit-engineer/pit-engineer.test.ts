import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAR_CONTROL_TOGGLE_AUDIO,
  FUEL_CRITICAL_POOL,
  FUEL_EMPTY_POOL,
  FUEL_LOW_3_POOL,
  FUEL_LOW_5_POOL,
  generatePitEngineerSvg,
  getEligibleTips,
  MID_RACE_ONLY_TIPS,
  pickFromPool,
  PIT_ENGINEER_UUID,
  PIT_SERVICE_TOGGLE_AUDIO,
  resolveQueuedServices,
  START_ONLY_TIPS,
  TIP_POOL,
  TIRE_TOGGLE_AUDIO,
} from "./pit-engineer.js";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockGetAudio } = vi.hoisted(() => ({
  mockGetAudio: vi.fn(() => ({
    setChannelVolume: vi.fn(),
    onChannelComplete: vi.fn(),
    playOnChannel: vi.fn(),
    seekChannelRandom: vi.fn(),
    stopChannel: vi.fn(),
    cancelVoiceSequence: vi.fn(),
    playVoiceSequence: vi.fn(),
    onVoiceSequenceComplete: vi.fn(),
  })),
}));

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock("../../../icons/pit-engineer.svg", () => ({
  default:
    '<svg xmlns="http://www.w3.org/2000/svg"><desc>{"colors":{"backgroundColor":"#2c3e50","textColor":"#ffffff","graphic1Color":"#ffffff"}}</desc></svg>',
}));

vi.mock("../../icons/status-bar.js", () => ({
  borderColorForState: vi.fn((state: string) => (state === "on" ? "#2ecc71" : "#e74c3c")),
  statusBarOn: vi.fn(() => '<rect class="status-bar-on"/>'),
  statusBarOff: vi.fn(() => '<rect class="status-bar-off"/>'),
}));

vi.mock("@iracedeck/iracing-sdk", () => ({
  CarLeftRight: {
    Off: 0,
    Clear: 1,
    CarLeft: 2,
    CarRight: 3,
    CarLeftRight: 4,
    TwoCarsLeft: 5,
    TwoCarsRight: 6,
  },
  Flags: {
    Green: 0x04,
    Yellow: 0x08,
    Red: 0x10,
    Blue: 0x20,
    Debris: 0x40,
    YellowWaving: 0x100,
    Caution: 0x4000,
    CautionWaving: 0x8000,
    Black: 0x10000,
    Disqualify: 0x20000,
    Repair: 0x100000,
    White: 0x02,
    Checkered: 0x01,
  },
  PitSvFlags: {
    LFTireChange: 0x0001,
    RFTireChange: 0x0002,
    LRTireChange: 0x0004,
    RRTireChange: 0x0008,
    FuelFill: 0x0010,
    WindshieldTearoff: 0x0020,
    FastRepair: 0x0040,
  },
  EngineWarnings: {
    PitSpeedLimiter: 0x10,
  },
  TrkLoc: {
    NotInWorld: -1,
    OffTrack: 0,
    InPitStall: 1,
    AproachingPits: 2,
    OnTrack: 3,
  },
  hasFlag: vi.fn((value: number, flag: number) => (value & flag) !== 0),
  calculateRacePositions: vi.fn(() => []),
}));

vi.mock("@iracedeck/audio-service", () => ({
  AudioBus: {
    Voice: 0,
    Background: 1,
    Alerts: 2,
  },
  AudioChannel: {
    Ambient: 0,
    SFX: 1,
    Voice: 2,
    Spotter: 3,
  },
  getAudio: mockGetAudio,
}));

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: () => {
      const defaults = {
        spotterEnabled: true,
        pitLaneAlertsEnabled: true,
        toggleAudioEnabled: false,
        overtakeAndTipsEnabled: true,
        flagAlertsEnabled: true,
        spotterVolume: 100,
        volume: 45,
        driverName: "none",
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
      getConnectionStatus: vi.fn(() => true),
      getCurrentTelemetry: vi.fn(() => null),
      getSessionInfo: vi.fn(() => null),
    };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
    updateKeyImage = vi.fn();
    async onWillAppear() {}
    async onDidReceiveSettings() {}
    async onWillDisappear() {}
  },
  applyGraphicTransform: vi.fn((_content: string) => _content),
  computeGraphicArea: vi.fn(() => ({ x: 8, y: 8, width: 128, height: 84 })),
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  generateTitleText: vi.fn((opts: { text: string; fill: string }) =>
    opts.text ? `<text fill="${opts.fill}">${opts.text}</text>` : "",
  ),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  getGlobalTitleSettings: vi.fn(() => ({})),
  LogLevel: { Info: 2 },
  renderIconTemplate: vi.fn((template: string, data: Record<string, string>) => {
    let result = template;

    for (const [key, val] of Object.entries(data)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), val);
    }

    if (data.iconContent) result += data.iconContent;

    return result;
  }),
  resolveBorderSettings: vi.fn((_svg: unknown, _global: unknown, _overrides?: unknown, _stateColor?: string) => ({
    enabled: false,
    borderWidth: 7,
    borderColor: "#00aaff",
    glowEnabled: true,
    glowWidth: 18,
  })),
  resolveGraphicSettings: vi.fn(() => ({ scale: 1 })),
  resolveIconColors: vi.fn((_svg: unknown, _global: unknown, _overrides: unknown) => ({
    backgroundColor: "#2c3e50",
    textColor: "#ffffff",
    graphic1Color: "#ffffff",
  })),
  resolveTitleSettings: vi.fn((_svg: unknown, _global: unknown, _overrides: unknown, defaultTitle?: string) => ({
    showTitle: true,
    showGraphics: true,
    titleText: defaultTitle ?? "",
    bold: true,
    fontSize: 18,
    position: "bottom" as const,
    customPosition: 0,
  })),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("PitEngineer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Constants ──────────────────────────────────────────────────────────────

  describe("constants", () => {
    it("should have the correct action UUID", () => {
      expect(PIT_ENGINEER_UUID).toBe("com.iracedeck.sd.core.pit-engineer");
    });
  });

  // ─── resolveQueuedServices ─────────────────────────────────────────────────

  describe("resolveQueuedServices", () => {
    it("should return empty array when no services are queued", () => {
      expect(resolveQueuedServices(0)).toEqual([]);
    });

    it("should return fuel reminder when fuel fill is set", () => {
      const result = resolveQueuedServices(0x0010); // FuelFill

      expect(result).toContain("pit-engineer/reminder/IRD-pit-reminder-fuel.mp3");
    });

    it("should return tire reminder when any tire is set", () => {
      const result = resolveQueuedServices(0x0001); // LFTireChange

      expect(result).toContain("pit-engineer/reminder/IRD-pit-reminder-tires.mp3");
    });

    it("should return tire reminder for all tires", () => {
      const result = resolveQueuedServices(0x000f); // All 4 tires

      expect(result).toContain("pit-engineer/reminder/IRD-pit-reminder-tires.mp3");
    });

    it("should return fast repair reminder when fast repair is set", () => {
      const result = resolveQueuedServices(0x0040); // FastRepair

      expect(result).toContain("pit-engineer/reminder/IRD-pit-reminder-fast-repair.mp3");
    });

    it("should return all services when everything is queued", () => {
      const result = resolveQueuedServices(0x005f); // Fuel + all tires + windshield tearoff + fast repair

      expect(result).toContain("pit-engineer/reminder/IRD-pit-reminder-fuel.mp3");
      expect(result).toContain("pit-engineer/reminder/IRD-pit-reminder-tires.mp3");
      expect(result).toContain("pit-engineer/reminder/IRD-pit-reminder-fast-repair.mp3");
    });

    it("should return compound reminder instead of tire when compound changes", () => {
      // All tires + different compound (player=0 dry, pit=1 wet)
      const result = resolveQueuedServices(0x000f, 0, 1);

      expect(result).toContain("pit-engineer/reminder/IRD-pit-reminder-compound.mp3");
      expect(result).not.toContain("pit-engineer/reminder/IRD-pit-reminder-tires.mp3");
    });

    it("should return tire reminder when compound stays the same", () => {
      // All tires + same compound (player=0, pit=0)
      const result = resolveQueuedServices(0x000f, 0, 0);

      expect(result).toContain("pit-engineer/reminder/IRD-pit-reminder-tires.mp3");
      expect(result).not.toContain("pit-engineer/reminder/IRD-pit-reminder-compound.mp3");
    });

    it("should return services in correct order: fast repair, fuel, tires/compound", () => {
      const result = resolveQueuedServices(0x005f); // Fuel + all tires + windshield + fast repair

      const repairIdx = result.indexOf("pit-engineer/reminder/IRD-pit-reminder-fast-repair.mp3");
      const fuelIdx = result.indexOf("pit-engineer/reminder/IRD-pit-reminder-fuel.mp3");
      const tiresIdx = result.indexOf("pit-engineer/reminder/IRD-pit-reminder-tires.mp3");

      expect(repairIdx).toBeLessThan(fuelIdx);
      expect(fuelIdx).toBeLessThan(tiresIdx);
    });
  });

  // ─── Toggle Audio Mappings ─────────────────────────────────────────────────

  describe("PIT_SERVICE_TOGGLE_AUDIO", () => {
    it("should have fuel toggle audio files", () => {
      expect(PIT_SERVICE_TOGGLE_AUDIO.fuel.on).toContain("fuel-on");
      expect(PIT_SERVICE_TOGGLE_AUDIO.fuel.off).toContain("fuel-off");
    });

    it("should have windshield toggle audio files", () => {
      expect(PIT_SERVICE_TOGGLE_AUDIO.windshield.on).toContain("windshield-on");
      expect(PIT_SERVICE_TOGGLE_AUDIO.windshield.off).toContain("windshield-off");
    });

    it("should have fast repair toggle audio files", () => {
      expect(PIT_SERVICE_TOGGLE_AUDIO.fastRepair.on).toContain("fast-repair-on");
      expect(PIT_SERVICE_TOGGLE_AUDIO.fastRepair.off).toContain("fast-repair-off");
    });
  });

  describe("TIRE_TOGGLE_AUDIO", () => {
    it("should have all tire pattern toggle audio files", () => {
      const expectedPatterns = [
        "all",
        "front",
        "rear",
        "left",
        "right",
        "crossLfRr",
        "crossRfLr",
        "stayDry",
        "stayWet",
        "changeToDry",
        "changeToWet",
        "lf",
        "rf",
        "lr",
        "rr",
      ];

      for (const pattern of expectedPatterns) {
        expect(TIRE_TOGGLE_AUDIO[pattern]).toBeDefined();
        expect(TIRE_TOGGLE_AUDIO[pattern].on).toBeTruthy();
        expect(TIRE_TOGGLE_AUDIO[pattern].off).toBeTruthy();
      }
    });

    it("should have correct file naming for individual tires", () => {
      expect(TIRE_TOGGLE_AUDIO.lf.on).toContain("tires-lf-on");
      expect(TIRE_TOGGLE_AUDIO.rf.on).toContain("tires-rf-on");
      expect(TIRE_TOGGLE_AUDIO.lr.on).toContain("tires-lr-on");
      expect(TIRE_TOGGLE_AUDIO.rr.on).toContain("tires-rr-on");
    });
  });

  describe("CAR_CONTROL_TOGGLE_AUDIO", () => {
    it("should have push-to-pass toggle audio files", () => {
      expect(CAR_CONTROL_TOGGLE_AUDIO.pushToPass.on).toContain("p2p-on");
      expect(CAR_CONTROL_TOGGLE_AUDIO.pushToPass.off).toContain("p2p-off");
    });

    it("should have DRS toggle audio files", () => {
      expect(CAR_CONTROL_TOGGLE_AUDIO.drs.on).toContain("drs-on");
      expect(CAR_CONTROL_TOGGLE_AUDIO.drs.off).toContain("drs-off");
    });
  });

  // ─── generatePitEngineerSvg ────────────────────────────────────────────────

  describe("generatePitEngineerSvg", () => {
    const defaultSettings = {
      spotterEnabled: true,
      pitLaneAlertsEnabled: true,
      toggleAudioEnabled: false,
      overtakeAndTipsEnabled: true,
      flagAlertsEnabled: true,
      spotterVolume: 100,
      volume: 45,
      driverName: "none",
    };

    it("should return a valid data URI", () => {
      const result = generatePitEngineerSvg(defaultSettings, "clear", true);

      expect(result).toContain("data:image/svg+xml");
    });

    it("should include status bar on when enabled", () => {
      const result = generatePitEngineerSvg(defaultSettings, "clear", true);

      expect(decodeURIComponent(result)).toContain("status-bar-on");
    });

    it("should include status bar off when disabled", () => {
      const result = generatePitEngineerSvg(defaultSettings, "clear", false);

      expect(decodeURIComponent(result)).toContain("status-bar-off");
    });

    it("should produce different SVGs for enabled and disabled", () => {
      const enabled = generatePitEngineerSvg(defaultSettings, "clear", true);
      const disabled = generatePitEngineerSvg(defaultSettings, "clear", false);

      expect(enabled).not.toBe(disabled);
    });

    it("should call resolveIconColors with settings", async () => {
      const { resolveIconColors } = await import("@iracedeck/deck-core");

      generatePitEngineerSvg(defaultSettings, "clear", true);

      expect(resolveIconColors).toHaveBeenCalled();
    });

    it("should call resolveBorderSettings with state color", async () => {
      const { resolveBorderSettings } = await import("@iracedeck/deck-core");

      generatePitEngineerSvg(defaultSettings, "clear", true);

      expect(resolveBorderSettings).toHaveBeenCalled();
    });

    it("should call resolveGraphicSettings", async () => {
      const { resolveGraphicSettings } = await import("@iracedeck/deck-core");

      generatePitEngineerSvg(defaultSettings, "clear", true);

      expect(resolveGraphicSettings).toHaveBeenCalled();
    });

    it("should call resolveTitleSettings with PIT ENGINEER default", async () => {
      const { resolveTitleSettings } = await import("@iracedeck/deck-core");

      generatePitEngineerSvg(defaultSettings, "clear", true);

      // 4th argument is the default title text
      expect(resolveTitleSettings).toHaveBeenCalledWith(
        expect.anything(), // template SVG
        expect.anything(), // global title settings
        undefined, // titleOverrides (not in test settings)
        "PIT\nENGINEER",
      );
    });
  });

  describe("getEligibleTips", () => {
    it("includes all tips except MID_RACE_ONLY during start window", () => {
      const eligible = getEligibleTips(true);

      for (const tip of MID_RACE_ONLY_TIPS) {
        expect(eligible).not.toContain(tip);
      }

      for (const tip of START_ONLY_TIPS) {
        expect(eligible).toContain(tip);
      }
    });

    it("includes all tips except START_ONLY during mid-race", () => {
      const eligible = getEligibleTips(false);

      for (const tip of START_ONLY_TIPS) {
        expect(eligible).not.toContain(tip);
      }

      for (const tip of MID_RACE_ONLY_TIPS) {
        expect(eligible).toContain(tip);
      }
    });

    it("eligible tip count matches TIP_POOL minus excluded set", () => {
      expect(getEligibleTips(true).length).toBe(TIP_POOL.length - MID_RACE_ONLY_TIPS.size);
      expect(getEligibleTips(false).length).toBe(TIP_POOL.length - START_ONLY_TIPS.size);
    });

    it("START_ONLY and MID_RACE_ONLY sets do not overlap", () => {
      for (const tip of START_ONLY_TIPS) {
        expect(MID_RACE_ONLY_TIPS.has(tip)).toBe(false);
      }
    });

    it("every tip in START_ONLY and MID_RACE_ONLY exists in TIP_POOL", () => {
      for (const tip of START_ONLY_TIPS) {
        expect(TIP_POOL).toContain(tip);
      }

      for (const tip of MID_RACE_ONLY_TIPS) {
        expect(TIP_POOL).toContain(tip);
      }
    });
  });

  // ─── Fuel Warnings ────────────────────────────────────────────────────────

  describe("pickFromPool", () => {
    it("returns the only entry for a single-entry pool", () => {
      const pool = ["only.mp3"];

      for (let i = 0; i < 5; i++) {
        expect(pickFromPool(pool)).toBe("only.mp3");
      }
    });

    it("returns empty string for an empty pool", () => {
      expect(pickFromPool([])).toBe("");
    });

    it("never picks the same entry back-to-back", () => {
      const pool = ["a.mp3", "b.mp3", "c.mp3"];
      let prev = pickFromPool(pool);

      for (let i = 0; i < 50; i++) {
        const next = pickFromPool(pool);
        expect(next).not.toBe(prev);
        prev = next;
      }
    });

    it("tracks each pool's last index independently", () => {
      const poolA = ["a1.mp3", "a2.mp3"];
      const poolB = ["b1.mp3", "b2.mp3"];
      // Even though pools are interleaved, back-to-back exclusion is per-pool
      const picksA: string[] = [];

      for (let i = 0; i < 10; i++) {
        picksA.push(pickFromPool(poolA));
        pickFromPool(poolB);
      }

      for (let i = 1; i < picksA.length; i++) {
        expect(picksA[i]).not.toBe(picksA[i - 1]);
      }
    });

    it("all fuel pools have exactly 3 entries", () => {
      for (const pool of [
        FUEL_LOW_5_POOL,
        FUEL_LOW_3_POOL,
        FUEL_CRITICAL_POOL,
        FUEL_EMPTY_POOL,
      ]) {
        expect(pool.length).toBe(3);
      }
    });
  });
});
