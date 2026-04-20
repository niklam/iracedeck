import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAR_CONTROL_TOGGLE_AUDIO,
  computeConservativeAvg,
  computeDualWindowAvgs,
  FUEL_CRITICAL_POOL,
  FUEL_EMPTY_POOL,
  FUEL_LOW_3_POOL,
  FUEL_LOW_5_POOL,
  FUEL_THRESHOLDS,
  type FuelFiredFlags,
  generatePitEngineerSvg,
  getEligibleTips,
  getFuelConfidence,
  getMakeEndMarginLaps,
  isLapUsableForAvg,
  MID_RACE_ONLY_TIPS,
  pickFromPool,
  PIT_ENGINEER_UUID,
  PIT_SERVICE_TOGGLE_AUDIO,
  raceMathAllowed,
  resetFuelPickers,
  resolveCarControlToggleAudio,
  resolveFuelWarning,
  resolvePitServiceToggleAudio,
  resolveQueuedServices,
  resolveSpotterAudioFile,
  resolveSpotterState,
  shouldFireSaveFuel,
  type SpotterVisualState,
  START_ONLY_TIPS,
  TIP_POOL,
  TIRE_SHORT,
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

  // ─── resolveSpotterState ───────────────────────────────────────────────────

  describe("resolveSpotterState", () => {
    it("should return 'clear' for Off", () => {
      expect(resolveSpotterState(0)).toBe("clear");
    });

    it("should return 'clear' for Clear", () => {
      expect(resolveSpotterState(1)).toBe("clear");
    });

    it("should return 'left' for CarLeft", () => {
      expect(resolveSpotterState(2)).toBe("left");
    });

    it("should return 'right' for CarRight", () => {
      expect(resolveSpotterState(3)).toBe("right");
    });

    it("should return 'both' for CarLeftRight", () => {
      expect(resolveSpotterState(4)).toBe("both");
    });

    it("should return 'two-left' for TwoCarsLeft", () => {
      expect(resolveSpotterState(5)).toBe("two-left");
    });

    it("should return 'two-right' for TwoCarsRight", () => {
      expect(resolveSpotterState(6)).toBe("two-right");
    });

    it("should return 'clear' for unknown values", () => {
      expect(resolveSpotterState(99)).toBe("clear");
    });
  });

  // ─── resolveSpotterAudioFile ───────────────────────────────────────────────

  describe("resolveSpotterAudioFile", () => {
    it("should return left audio for 'left' state", () => {
      expect(resolveSpotterAudioFile("left")).toBe("spotter/IRD-spotter-left.mp3");
    });

    it("should return right audio for 'right' state", () => {
      expect(resolveSpotterAudioFile("right")).toBe("spotter/IRD-spotter-right.mp3");
    });

    it("should return both audio for 'both' state", () => {
      expect(resolveSpotterAudioFile("both")).toBe("spotter/IRD-spotter-both.mp3");
    });

    it("should return left audio for 'two-left' state", () => {
      expect(resolveSpotterAudioFile("two-left")).toBe("spotter/IRD-spotter-left.mp3");
    });

    it("should return right audio for 'two-right' state", () => {
      expect(resolveSpotterAudioFile("two-right")).toBe("spotter/IRD-spotter-right.mp3");
    });

    it("should return null for 'clear' state", () => {
      expect(resolveSpotterAudioFile("clear")).toBeNull();
    });

    it("should return null for unknown state", () => {
      expect(resolveSpotterAudioFile("unknown" as SpotterVisualState)).toBeNull();
    });
  });

  // ─── resolveQueuedServices ─────────────────────────────────────────────────

  describe("resolveQueuedServices", () => {
    it("should return empty array when no services are queued", () => {
      expect(resolveQueuedServices(0)).toEqual([]);
    });

    it("should return fuel reminder when fuel fill is set", () => {
      const result = resolveQueuedServices(0x0010); // FuelFill

      expect(result).toContain("reminder/IRD-pit-reminder-fuel.mp3");
    });

    it("should return tire reminder when any tire is set", () => {
      const result = resolveQueuedServices(0x0001); // LFTireChange

      expect(result).toContain("reminder/IRD-pit-reminder-tires.mp3");
    });

    it("should return tire reminder for all tires", () => {
      const result = resolveQueuedServices(0x000f); // All 4 tires

      expect(result).toContain("reminder/IRD-pit-reminder-tires.mp3");
    });

    it("should return fast repair reminder when fast repair is set", () => {
      const result = resolveQueuedServices(0x0040); // FastRepair

      expect(result).toContain("reminder/IRD-pit-reminder-fast-repair.mp3");
    });

    it("should return all services when everything is queued", () => {
      const result = resolveQueuedServices(0x005f); // Fuel + all tires + windshield tearoff + fast repair

      expect(result).toContain("reminder/IRD-pit-reminder-fuel.mp3");
      expect(result).toContain("reminder/IRD-pit-reminder-tires.mp3");
      expect(result).toContain("reminder/IRD-pit-reminder-fast-repair.mp3");
    });

    it("should return compound reminder instead of tire when compound changes", () => {
      // All tires + different compound (player=0 dry, pit=1 wet)
      const result = resolveQueuedServices(0x000f, 0, 1);

      expect(result).toContain("reminder/IRD-pit-reminder-compound.mp3");
      expect(result).not.toContain("reminder/IRD-pit-reminder-tires.mp3");
    });

    it("should return tire reminder when compound stays the same", () => {
      // All tires + same compound (player=0, pit=0)
      const result = resolveQueuedServices(0x000f, 0, 0);

      expect(result).toContain("reminder/IRD-pit-reminder-tires.mp3");
      expect(result).not.toContain("reminder/IRD-pit-reminder-compound.mp3");
    });

    it("should return services in correct order: fast repair, fuel, tires/compound", () => {
      const result = resolveQueuedServices(0x005f); // Fuel + all tires + windshield + fast repair

      const repairIdx = result.indexOf("reminder/IRD-pit-reminder-fast-repair.mp3");
      const fuelIdx = result.indexOf("reminder/IRD-pit-reminder-fuel.mp3");
      const tiresIdx = result.indexOf("reminder/IRD-pit-reminder-tires.mp3");

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

  // ─── resolvePitServiceToggleAudio ──────────────────────────────────────────

  describe("resolvePitServiceToggleAudio", () => {
    it("should return empty array when nothing changed", () => {
      expect(resolvePitServiceToggleAudio(0, 0)).toEqual([]);
    });

    it("should detect fuel toggle on", () => {
      const result = resolvePitServiceToggleAudio(0, 0x0010);

      expect(result).toContain(PIT_SERVICE_TOGGLE_AUDIO.fuel.on);
    });

    it("should detect fuel toggle off", () => {
      const result = resolvePitServiceToggleAudio(0x0010, 0);

      expect(result).toContain(PIT_SERVICE_TOGGLE_AUDIO.fuel.off);
    });

    it("should detect windshield toggle on", () => {
      const result = resolvePitServiceToggleAudio(0, 0x0020);

      expect(result).toContain(PIT_SERVICE_TOGGLE_AUDIO.windshield.on);
    });

    it("should detect windshield toggle off", () => {
      const result = resolvePitServiceToggleAudio(0x0020, 0);

      expect(result).toContain(PIT_SERVICE_TOGGLE_AUDIO.windshield.off);
    });

    it("should detect fast repair toggle on", () => {
      const result = resolvePitServiceToggleAudio(0, 0x0040);

      expect(result).toContain(PIT_SERVICE_TOGGLE_AUDIO.fastRepair.on);
    });

    it("should detect fast repair toggle off", () => {
      const result = resolvePitServiceToggleAudio(0x0040, 0);

      expect(result).toContain(PIT_SERVICE_TOGGLE_AUDIO.fastRepair.off);
    });

    // ── Tire patterns ──

    it("should detect all tires on", () => {
      const result = resolvePitServiceToggleAudio(0, 0x000f);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.all.on);
    });

    it("should detect all tires off", () => {
      const result = resolvePitServiceToggleAudio(0x000f, 0);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.all.off);
    });

    it("should detect front tires on", () => {
      const result = resolvePitServiceToggleAudio(0, 0x0003); // LF + RF

      expect(result).toContain(TIRE_TOGGLE_AUDIO.front.on);
    });

    it("should detect rear tires on", () => {
      const result = resolvePitServiceToggleAudio(0, 0x000c); // LR + RR

      expect(result).toContain(TIRE_TOGGLE_AUDIO.rear.on);
    });

    it("should detect left tires on", () => {
      const result = resolvePitServiceToggleAudio(0, 0x0005); // LF + LR

      expect(result).toContain(TIRE_TOGGLE_AUDIO.left.on);
    });

    it("should detect right tires on", () => {
      const result = resolvePitServiceToggleAudio(0, 0x000a); // RF + RR

      expect(result).toContain(TIRE_TOGGLE_AUDIO.right.on);
    });

    it("should detect cross LF+RR on", () => {
      const result = resolvePitServiceToggleAudio(0, 0x0009); // LF + RR

      expect(result).toContain(TIRE_TOGGLE_AUDIO.crossLfRr.on);
    });

    it("should detect cross RF+LR on", () => {
      const result = resolvePitServiceToggleAudio(0, 0x0006); // RF + LR

      expect(result).toContain(TIRE_TOGGLE_AUDIO.crossRfLr.on);
    });

    it("should detect single tire LF on", () => {
      const result = resolvePitServiceToggleAudio(0, 0x0001);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.lf.on);
    });

    it("should detect single tire RF on", () => {
      const result = resolvePitServiceToggleAudio(0, 0x0002);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.rf.on);
    });

    it("should detect single tire LR on", () => {
      const result = resolvePitServiceToggleAudio(0, 0x0004);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.lr.on);
    });

    it("should detect single tire RR on", () => {
      const result = resolvePitServiceToggleAudio(0, 0x0008);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.rr.on);
    });

    // ── 3-tire combos ──

    it("should detect 3 tires: left side + RF (LF + RF + LR)", () => {
      // Side pairs are preferred over axle pairs; LF + LR = left pair, RF is the odd.
      const result = resolvePitServiceToggleAudio(0, 0x0007); // LF + RF + LR

      expect(result).toContain(TIRE_TOGGLE_AUDIO.left.on);
      expect(result.length).toBe(2); // left + short rf
    });

    it("should detect 3 tires: right side + LF (LF + RF + RR)", () => {
      // Side pairs are preferred over axle pairs; RF + RR = right pair, LF is the odd.
      const result = resolvePitServiceToggleAudio(0, 0x000b); // LF + RF + RR

      expect(result).toContain(TIRE_TOGGLE_AUDIO.right.on);
      expect(result.length).toBe(2); // right + short lf
    });

    it("should detect 3 tires: left side + RR (LF + LR + RR)", () => {
      // LF + LR = left pair, RR is the odd.
      const result = resolvePitServiceToggleAudio(0, 0x000d); // LF + LR + RR

      expect(result).toContain(TIRE_TOGGLE_AUDIO.left.on);
      expect(result.length).toBe(2); // left + short rr
    });

    it("should detect 3 tires: right side + LR (RF + LR + RR)", () => {
      // RF + RR = right pair, LR is the odd.
      const result = resolvePitServiceToggleAudio(0, 0x000e); // RF + LR + RR

      expect(result).toContain(TIRE_TOGGLE_AUDIO.right.on);
      expect(result.length).toBe(2); // right + short lr
    });

    // ── 3-tire combos with order-dependent pair preference ──
    // When a pair (front/rear/left/right) was established in the previous state,
    // adding a third tire should keep that pair's announcement.

    it("should keep rear pair when prev=rear pair (LR+RR) and adding RF", () => {
      // prev = LR + RR (rear pair established), curr = LR + RR + RF
      const result = resolvePitServiceToggleAudio(0x000c, 0x000e);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.rear.on);
      expect(result).toContain(TIRE_SHORT.rf);
      expect(result.length).toBe(2);
    });

    it("should keep rear pair when prev=rear pair (LR+RR) and adding LF", () => {
      // prev = LR + RR, curr = LR + RR + LF
      const result = resolvePitServiceToggleAudio(0x000c, 0x000d);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.rear.on);
      expect(result).toContain(TIRE_SHORT.lf);
      expect(result.length).toBe(2);
    });

    it("should keep front pair when prev=front pair (LF+RF) and adding RR", () => {
      // prev = LF + RF, curr = LF + RF + RR
      const result = resolvePitServiceToggleAudio(0x0003, 0x000b);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.front.on);
      expect(result).toContain(TIRE_SHORT.rr);
      expect(result.length).toBe(2);
    });

    it("should keep front pair when prev=front pair (LF+RF) and adding LR", () => {
      // prev = LF + RF, curr = LF + RF + LR
      const result = resolvePitServiceToggleAudio(0x0003, 0x0007);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.front.on);
      expect(result).toContain(TIRE_SHORT.lr);
      expect(result.length).toBe(2);
    });

    it("should keep left pair when prev=left pair (LF+LR) and adding RF", () => {
      // prev = LF + LR, curr = LF + LR + RF
      const result = resolvePitServiceToggleAudio(0x0005, 0x0007);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.left.on);
      expect(result).toContain(TIRE_SHORT.rf);
      expect(result.length).toBe(2);
    });

    it("should keep left pair when prev=left pair (LF+LR) and adding RR", () => {
      // prev = LF + LR, curr = LF + LR + RR
      const result = resolvePitServiceToggleAudio(0x0005, 0x000d);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.left.on);
      expect(result).toContain(TIRE_SHORT.rr);
      expect(result.length).toBe(2);
    });

    it("should keep right pair when prev=right pair (RF+RR) and adding LF", () => {
      // prev = RF + RR, curr = RF + RR + LF
      const result = resolvePitServiceToggleAudio(0x000a, 0x000b);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.right.on);
      expect(result).toContain(TIRE_SHORT.lf);
      expect(result.length).toBe(2);
    });

    it("should keep right pair when prev=right pair (RF+RR) and adding LR", () => {
      // prev = RF + RR, curr = RF + RR + LR
      const result = resolvePitServiceToggleAudio(0x000a, 0x000e);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.right.on);
      expect(result).toContain(TIRE_SHORT.lr);
      expect(result.length).toBe(2);
    });

    it("should fall back to side preference when prev was not a complete pair (diagonal)", () => {
      // prev = LF + RR (diagonal, not a pair), curr = LF + RR + RF
      // No established pair → fallback: right pair preferred (RF+RR), odd = lf
      const result = resolvePitServiceToggleAudio(0x0009, 0x000b);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.right.on);
      expect(result).toContain(TIRE_SHORT.lf);
      expect(result.length).toBe(2);
    });

    it("should fall back to side preference when prev was a single tire", () => {
      // prev = LF only, curr = LF + RF + RR
      // prev wasn't a 2-tire pair → fallback: right pair (RF+RR), odd = lf
      const result = resolvePitServiceToggleAudio(0x0001, 0x000b);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.right.on);
      expect(result).toContain(TIRE_SHORT.lf);
      expect(result.length).toBe(2);
    });

    // ── Compound changes ──

    it("should detect compound change to wet", () => {
      // All tires on, compound changes from dry (0) to wet (1)
      const result = resolvePitServiceToggleAudio(0x000f, 0x000f, 0, 0, 1);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.changeToWet.on);
    });

    it("should detect compound change to dry when player is on wet", () => {
      // Player is on wet (1), compound changes from wet (1) to dry (0)
      const result = resolvePitServiceToggleAudio(0x000f, 0x000f, 1, 1, 0);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.changeToDry.on);
    });

    it("should detect staying on dry compound", () => {
      // Player compound 0 (dry), pit compound changes from wet (1) to dry (0) = same as player → stay dry
      const result = resolvePitServiceToggleAudio(0x000f, 0x000f, 0, 1, 0);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.stayDry.on);
    });

    it("should detect staying on wet compound", () => {
      const result = resolvePitServiceToggleAudio(0x000f, 0x000f, 1, 0, 1);

      // Player compound 1 (wet), pit compound 1 → staying wet
      expect(result).toContain(TIRE_TOGGLE_AUDIO.stayWet.on);
    });

    it("should suppress 'all tires on' when compound just changed", () => {
      // Tires go from 0 to all-on AND compound changes — compound announcement is sufficient
      const result = resolvePitServiceToggleAudio(0, 0x000f, 0, 0, 1);

      expect(result).toContain(TIRE_TOGGLE_AUDIO.changeToWet.on);
      expect(result).not.toContain(TIRE_TOGGLE_AUDIO.all.on);
    });

    // ── Multiple services at once ──

    it("should detect multiple services changing at once", () => {
      const result = resolvePitServiceToggleAudio(0, 0x0050); // Fuel + fast repair

      expect(result).toContain(PIT_SERVICE_TOGGLE_AUDIO.fuel.on);
      expect(result).toContain(PIT_SERVICE_TOGGLE_AUDIO.fastRepair.on);
    });

    it("should return no audio when same flags are repeated", () => {
      const result = resolvePitServiceToggleAudio(0x0010, 0x0010);

      expect(result).toEqual([]);
    });
  });

  // ─── resolveCarControlToggleAudio ──────────────────────────────────────────

  describe("resolveCarControlToggleAudio", () => {
    const base = { limiter: false, p2p: false, drs: false };

    it("should return empty array when nothing changed", () => {
      expect(resolveCarControlToggleAudio(base, base)).toEqual([]);
    });

    it("should detect push-to-pass on", () => {
      const result = resolveCarControlToggleAudio(base, { ...base, p2p: true });

      expect(result).toContain(CAR_CONTROL_TOGGLE_AUDIO.pushToPass.on);
    });

    it("should detect push-to-pass off", () => {
      const result = resolveCarControlToggleAudio({ ...base, p2p: true }, base);

      expect(result).toContain(CAR_CONTROL_TOGGLE_AUDIO.pushToPass.off);
    });

    it("should detect DRS on", () => {
      const result = resolveCarControlToggleAudio(base, { ...base, drs: true });

      expect(result).toContain(CAR_CONTROL_TOGGLE_AUDIO.drs.on);
    });

    it("should detect DRS off", () => {
      const result = resolveCarControlToggleAudio({ ...base, drs: true }, base);

      expect(result).toContain(CAR_CONTROL_TOGGLE_AUDIO.drs.off);
    });

    it("should warn when pit limiter activates on track", () => {
      const result = resolveCarControlToggleAudio(base, { ...base, limiter: true }, false);

      expect(result.length).toBe(1);
      expect(result[0]).toContain("limiter-on-warning");
    });

    it("should NOT warn about pit limiter on pit road", () => {
      const result = resolveCarControlToggleAudio(base, { ...base, limiter: true }, true);

      expect(result).toEqual([]);
    });

    it("should NOT warn when pit limiter deactivates", () => {
      const result = resolveCarControlToggleAudio({ ...base, limiter: true }, base, false);

      expect(result).toEqual([]);
    });

    it("should detect multiple toggles at once", () => {
      const result = resolveCarControlToggleAudio(base, { limiter: true, p2p: true, drs: true }, false);

      // Limiter warning + P2P on + DRS on
      expect(result.length).toBe(3);
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
    beforeEach(() => {
      resetFuelPickers();
    });

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

  describe("isLapUsableForAvg", () => {
    const baseParams = {
      lapTouchedPit: false,
      underCaution: false,
      lap: 5,
      towTime: 0,
      fuelUsed: 2.5,
    };

    it("accepts a clean green lap", () => {
      expect(isLapUsableForAvg(baseParams)).toBe(true);
    });

    it("rejects laps that touched the pit lane", () => {
      expect(isLapUsableForAvg({ ...baseParams, lapTouchedPit: true })).toBe(false);
    });

    it("rejects laps under caution", () => {
      expect(isLapUsableForAvg({ ...baseParams, underCaution: true })).toBe(false);
    });

    it("rejects lap 1 (standing start burns more)", () => {
      expect(isLapUsableForAvg({ ...baseParams, lap: 1 })).toBe(false);
    });

    it("rejects lap 0", () => {
      expect(isLapUsableForAvg({ ...baseParams, lap: 0 })).toBe(false);
    });

    it("accepts lap 2", () => {
      expect(isLapUsableForAvg({ ...baseParams, lap: 2 })).toBe(true);
    });

    it("rejects tow laps", () => {
      expect(isLapUsableForAvg({ ...baseParams, towTime: 0.1 })).toBe(false);
    });

    it("rejects zero or negative fuel usage (refuel / bad sample)", () => {
      expect(isLapUsableForAvg({ ...baseParams, fuelUsed: 0 })).toBe(false);
      expect(isLapUsableForAvg({ ...baseParams, fuelUsed: -1 })).toBe(false);
    });
  });

  describe("computeConservativeAvg", () => {
    it("returns undefined when history is too short", () => {
      expect(computeConservativeAvg([])).toBeUndefined();
      expect(computeConservativeAvg([2.5])).toBeUndefined();
    });

    it("respects FUEL_THRESHOLDS.minHistoryForAvg", () => {
      const size = FUEL_THRESHOLDS.minHistoryForAvg;
      const short = Array(size - 1).fill(2.5);
      const ok = Array(size).fill(2.5);
      expect(computeConservativeAvg(short)).toBeUndefined();
      expect(computeConservativeAvg(ok)).toBe(2.5);
    });

    it("FUEL_THRESHOLDS.minHistoryForCallouts silences fuel audio until real data exists", () => {
      // With minHistoryForCallouts=2 and lap 1 always skipped by isLapUsableForAvg,
      // no fuel callouts (including priority) should play until lap 4.
      expect(FUEL_THRESHOLDS.minHistoryForCallouts).toBe(2);
      expect(FUEL_THRESHOLDS.minHistoryForCallouts).toBeGreaterThanOrEqual(FUEL_THRESHOLDS.minHistoryForAvg);
    });

    it("returns the value itself when all laps are identical", () => {
      expect(computeConservativeAvg([2, 2, 2, 2, 2])).toBe(2);
    });

    it("returns max of mean and p90 (conservative bias)", () => {
      // Mean = 2.6, p90 = 4 → returns 4
      const result = computeConservativeAvg([2, 2, 2, 3, 4]);
      expect(result).toBe(4);
    });

    it("returns mean when mean exceeds p90 (impossible with non-negative but safety)", () => {
      // All equal: mean == p90
      expect(computeConservativeAvg([3, 3])).toBe(3);
    });

    it("handles two-lap history", () => {
      // sorted=[2,3], ceil(2*0.9)-1=1, p90=3, mean=2.5 → 3
      expect(computeConservativeAvg([2, 3])).toBe(3);
    });
  });

  describe("computeDualWindowAvgs", () => {
    it("returns undefined when history is too short for the long window", () => {
      expect(computeDualWindowAvgs([])).toBeUndefined();
      expect(computeDualWindowAvgs([2.5])).toBeUndefined();
    });

    it("falls back to long-window avg for both fields when <3 laps of history", () => {
      // 2 laps = long avg usable, but not enough for the 3-lap short window
      const result = computeDualWindowAvgs([2, 3]);
      expect(result?.warning).toBe(3);
      expect(result?.raceMath).toBe(3);
    });

    it("picks the higher window for warnings when the recent trend is thirstier", () => {
      // 5-lap history: [2, 2, 2, 3, 4]. Last 3 = [2, 3, 4].
      // Long avg = max(mean=2.6, p90=4) = 4. Short avg = max(mean=3, p90=4) = 4.
      // Both equal → warning/raceMath both 4.
      const result = computeDualWindowAvgs([2, 2, 2, 3, 4]);
      expect(result?.warning).toBe(4);
      expect(result?.raceMath).toBe(4);
    });

    it("picks the lower window for race-math when the recent trend improves (lighter car)", () => {
      // 5-lap history: [4, 4, 4, 2, 2]. Last 3 = [4, 2, 2].
      // Long sorted=[2,2,4,4,4], p90=4, mean=3.2 → long = 4
      // Short sorted=[2,2,4], p90=4, mean≈2.67 → short = 4
      // Both 4 → warning=raceMath=4. Bad example — make it clearer:
      //
      // 5-lap: [3, 3, 3, 2, 2]. Last 3 = [3, 2, 2].
      // Long sorted=[2,2,3,3,3], p90=3, mean=2.6 → long = 3
      // Short sorted=[2,2,3], p90=3, mean≈2.33 → short = 3
      // Still both 3. The p90 bias dominates small samples.
      //
      // Use a case where short-window mean clearly dominates: [3, 3, 3, 3, 3, 2, 2, 2]
      // slicing isn't meaningful — slice takes last 3. Let's use strictly increasing
      // AND strictly decreasing patterns:
      //
      // Improving: [4, 4, 3, 2, 2]. Last 3 = [3, 2, 2].
      // Long sorted=[2,2,3,4,4], p90=4, mean=3 → long=4
      // Short sorted=[2,2,3], p90=3, mean≈2.33 → short=3
      // raceMath = min(4, 3) = 3. warning = max = 4.
      const result = computeDualWindowAvgs([4, 4, 3, 2, 2]);
      expect(result?.warning).toBe(4);
      expect(result?.raceMath).toBe(3);
    });

    it("warning is max of windows, raceMath is min", () => {
      // Thirsty trend: [2, 2, 3, 4, 4]. Last 3 = [3, 4, 4].
      // Long sorted=[2,2,3,4,4], p90=4, mean=3 → long=4
      // Short sorted=[3,4,4], p90=4, mean≈3.67 → short=4
      // Both 4 → no differentiation. p90 wins at this scale.
      //
      // Better: [2, 2, 4, 5, 5]. Last 3 = [4, 5, 5].
      // Long sorted=[2,2,4,5,5], p90=5, mean=3.6 → long=5
      // Short sorted=[4,5,5], p90=5, mean≈4.67 → short=5
      // Still both 5. Need distinct p90s.
      //
      // [2, 2, 2, 2, 5] vs last 3 [2, 2, 5]:
      // Long sorted=[2,2,2,2,5], p90=5, mean=2.6 → long=5
      // Short sorted=[2,2,5], p90=5, mean=3 → short=5
      // Both 5. The max dominance of the outlier survives.
      //
      // Use history where the LAST 3 excludes the outlier:
      // [5, 5, 5, 2, 2]. Last 3 = [5, 2, 2].
      // Long sorted=[2,2,5,5,5], p90=5, mean=3.8 → long=5
      // Short sorted=[2,2,5], p90=5, mean=3 → short=5
      // Same. Need the outlier OUTSIDE the short slice:
      //
      // [5, 1, 1, 1, 1] last 3 = [1, 1, 1]
      // Long sorted=[1,1,1,1,5], p90=5, mean=1.8 → long=5
      // Short sorted=[1,1,1], p90=1, mean=1 → short=1
      // warning=5, raceMath=1. Good.
      const result = computeDualWindowAvgs([5, 1, 1, 1, 1]);
      expect(result?.warning).toBe(5);
      expect(result?.raceMath).toBe(1);
    });

    it("operates on the last N laps for the short window (ignores older history)", () => {
      // Short window = last 3 regardless of history size
      const improving = [10, 10, 10, 10, 2, 2, 2];
      const result = computeDualWindowAvgs(improving);
      // Short sorted=[2,2,2] → 2
      expect(result?.raceMath).toBe(2);
      // Long window is the whole array, dominated by the 10s
      expect(result?.warning).toBeGreaterThanOrEqual(10);
    });
  });

  describe("resolveFuelWarning", () => {
    const unfired: FuelFiredFlags = { empty: false, critical: false, low3: false, low5: false };

    it("returns null when lapsRemaining is plenty", () => {
      expect(resolveFuelWarning(20, unfired)).toBeNull();
    });

    it("fires low5 as non-priority when below the low5 threshold", () => {
      expect(resolveFuelWarning(FUEL_THRESHOLDS.low5 - 0.5, unfired)).toEqual({
        level: "low5",
        priority: false,
      });
    });

    it("fires low3 as priority when below the low3 threshold", () => {
      expect(resolveFuelWarning(FUEL_THRESHOLDS.low3 - 0.5, unfired)).toEqual({
        level: "low3",
        priority: true,
      });
    });

    it("fires critical as priority when below the critical threshold", () => {
      expect(resolveFuelWarning(FUEL_THRESHOLDS.critical - 0.5, unfired)).toEqual({
        level: "critical",
        priority: true,
      });
    });

    it("fires empty as priority when below the empty threshold", () => {
      expect(resolveFuelWarning(FUEL_THRESHOLDS.empty - 0.1, unfired)).toEqual({
        level: "empty",
        priority: true,
      });
    });

    it("priority ordering: empty beats critical beats low3 beats low5", () => {
      // lapsRemaining below all thresholds → empty wins
      const result = resolveFuelWarning(0, unfired);
      expect(result?.level).toBe("empty");
    });

    it("skips already-fired higher levels and falls through to next", () => {
      // Below empty threshold, but empty already fired → critical
      expect(resolveFuelWarning(0, { ...unfired, empty: true })?.level).toBe("critical");
      // Both empty + critical fired → low3
      expect(resolveFuelWarning(0, { ...unfired, empty: true, critical: true })?.level).toBe("low3");
      // All higher fired → low5
      expect(resolveFuelWarning(0, { ...unfired, empty: true, critical: true, low3: true })?.level).toBe("low5");
    });

    it("returns null when all applicable levels already fired", () => {
      expect(resolveFuelWarning(0, { empty: true, critical: true, low3: true, low5: true })).toBeNull();
    });

    it("does not fire low5 when lapsRemaining equals the threshold", () => {
      expect(resolveFuelWarning(FUEL_THRESHOLDS.low5, unfired)).toBeNull();
    });
  });

  describe("shouldFireSaveFuel", () => {
    it("returns false when session is already over", () => {
      expect(shouldFireSaveFuel({ lapsRemaining: 5, sessionLapsLeft: 0, currentLap: 10, lastSaveLap: -1 })).toBe(false);
    });

    it("returns false when we can make the end on current fuel", () => {
      expect(shouldFireSaveFuel({ lapsRemaining: 15, sessionLapsLeft: 10, currentLap: 20, lastSaveLap: -1 })).toBe(
        false,
      );
    });

    it("returns false when we're short but within the margin (still technically making it)", () => {
      // lapsRemaining >= sessionLapsLeft → canMakeEnd=true → false
      expect(shouldFireSaveFuel({ lapsRemaining: 10, sessionLapsLeft: 10, currentLap: 5, lastSaveLap: -1 })).toBe(
        false,
      );
    });

    it("fires when short and never-before fired", () => {
      expect(shouldFireSaveFuel({ lapsRemaining: 8, sessionLapsLeft: 10, currentLap: 5, lastSaveLap: -1 })).toBe(true);
    });

    it("suppresses when short but within the re-arm window", () => {
      expect(
        shouldFireSaveFuel({
          lapsRemaining: 8,
          sessionLapsLeft: 10,
          currentLap: 7,
          lastSaveLap: 5,
        }),
      ).toBe(false);
    });

    it("re-arms after saveRearmLaps laps", () => {
      expect(
        shouldFireSaveFuel({
          lapsRemaining: 8,
          sessionLapsLeft: 10,
          currentLap: 5 + FUEL_THRESHOLDS.saveRearmLaps,
          lastSaveLap: 5,
        }),
      ).toBe(true);
    });

    it("does not fire when lapsRemaining is outside the margin (not short at all)", () => {
      // Short requires lapsRemaining < sessionLapsLeft + margin. With margin=1.5:
      // sessionLapsLeft=10, lapsRemaining=11.5 → not short, canMakeEnd=true anyway
      expect(
        shouldFireSaveFuel({
          lapsRemaining: 11.5,
          sessionLapsLeft: 10,
          currentLap: 20,
          lastSaveLap: -1,
        }),
      ).toBe(false);
    });
  });

  describe("getFuelConfidence", () => {
    it("returns veryLow for 0 and 1 valid laps", () => {
      expect(getFuelConfidence(0)).toBe("veryLow");
      expect(getFuelConfidence(1)).toBe("veryLow");
    });

    it("returns low for 2–3 valid laps", () => {
      expect(getFuelConfidence(2)).toBe("low");
      expect(getFuelConfidence(3)).toBe("low");
    });

    it("returns medium for 4–7 valid laps", () => {
      expect(getFuelConfidence(4)).toBe("medium");
      expect(getFuelConfidence(7)).toBe("medium");
    });

    it("returns high for 8+ valid laps", () => {
      expect(getFuelConfidence(8)).toBe("high");
      expect(getFuelConfidence(20)).toBe("high");
    });
  });

  describe("getMakeEndMarginLaps", () => {
    it("returns effectively-infinite margin for veryLow so make-end never fires", () => {
      // We never call make-end when raceMathAllowed is false, but the margin
      // contract says it must be so wide that even if we did, it wouldn't fire.
      expect(getMakeEndMarginLaps("veryLow")).toBeGreaterThanOrEqual(50);
    });

    it("returns a wide margin for low confidence (prevents flip-flop)", () => {
      expect(getMakeEndMarginLaps("low")).toBe(1.5);
    });

    it("tightens the margin as confidence grows", () => {
      expect(getMakeEndMarginLaps("medium")).toBe(0.5);
      expect(getMakeEndMarginLaps("high")).toBe(0.25);
    });

    it("monotonically tightens margins as confidence increases", () => {
      expect(getMakeEndMarginLaps("low")).toBeGreaterThan(getMakeEndMarginLaps("medium"));
      expect(getMakeEndMarginLaps("medium")).toBeGreaterThan(getMakeEndMarginLaps("high"));
    });
  });

  describe("raceMathAllowed", () => {
    it("is false only for veryLow — race-math callouts stay silent until we have 2+ laps", () => {
      expect(raceMathAllowed("veryLow")).toBe(false);
    });

    it("is true for every other tier", () => {
      expect(raceMathAllowed("low")).toBe(true);
      expect(raceMathAllowed("medium")).toBe(true);
      expect(raceMathAllowed("high")).toBe(true);
    });
  });
});
