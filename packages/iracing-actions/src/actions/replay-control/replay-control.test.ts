import type { ReplayJumpPlayback } from "@iracedeck/app-constants";
import { assembleIcon, busyMarkSvg, resolveIconColors, resolveTitleSettings } from "@iracedeck/deck-core";
import type { PressShape } from "@iracedeck/deck-core";
import {
  getAllCarNumbers,
  getCarNumberFromSessionInfo,
  getCarNumberRawFromSessionInfo,
  type ReplayPosMode,
  replaySpeedToSdk,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import {
  beginReplayJump,
  getReplayGateRecord,
  getReplayGateView,
  onReplaySpeedChanged,
  pressJumpToFastestLap,
  pressReplayCommand,
  queueReplaySearch,
  rememberedSpeed,
  type ReplayGateNotice,
  runReplayJump,
  subscribeReplayGate,
} from "@iracedeck/replay-engine";
import {
  _activeLapPress,
  _getFastestLapSessionCache,
  _resetReplayCursor,
  _resetReplaySpeedState,
  cancelLapWalks,
  claimReplayCursor,
  type FakeReplay,
  fakeReplay,
  FASTEST_LAP_WALK_OWNER,
  jumpToRecordedLapStart,
  noteReplaySpeedSent,
  singleSessionBuffer as oneSessionLapBuffer,
  pendingReplayTarget,
  replayTargetGiveUpMs,
  resolveLiveSpeed,
  withSteppedReplayState,
} from "@iracedeck/replay-engine/testing";
import {
  getReplaySessionStore,
  type IncidentListing,
  isReplaySessionStoreInitialized,
  type LapStartListing,
  type LapStartLookup,
  type LapStartQuery,
  type LapStartRecord,
  type SessionStartListing,
} from "@iracedeck/replay-store";
import { getGlobalSettings } from "@iracedeck/settings";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { describePressShapeRouting } from "../../shared/press-shape.test-support.js";
import { engineOverDeck, replayControlScopeOn } from "../../shared/replay-engine-deck.test-support.js";
import { ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import type { ReplayControlDialHost } from "./replay-control-dial-surface.js";
import {
  calculateNeedleAngle,
  findAdjacentCarByNumber,
  formatSetSpeedLabel,
  formatSpeedDisplay,
  generateReplayControlSvg,
  parseSpeedSetting,
  ReplayControl,
} from "./replay-control.js";

// Mock all replay-control icon SVGs
vi.mock("@iracedeck/icons/replay-control/play-pause.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">play-pause {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/stop.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">stop {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/fast-forward.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">fast-forward {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/rewind.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">rewind {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/slow-motion.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">slow-motion {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/slow-motion-rewind.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">slow-motion-rewind {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/frame-forward.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">frame-forward {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/frame-backward.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">frame-backward {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/speed-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">speed-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/speed-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">speed-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/set-speed.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">set-speed {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/speed-display.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">speed-display {{speedText}} {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/pause.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">pause-icon {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/play-backward.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">play-backward {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/next-session.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">next-session {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/prev-session.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">prev-session {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/next-lap.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">next-lap {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/prev-lap.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">prev-lap {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/next-incident.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">next-incident {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/prev-incident.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">prev-incident {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/jump-to-beginning.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">jump-to-beginning {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/jump-to-live.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">jump-to-live {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/jump-to-my-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">jump-to-my-car {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/jump-to-fastest-lap.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">jump-to-fastest-lap {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/next-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">next-car {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/prev-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">prev-car {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/next-car-number.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">next-car-number {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/prev-car-number.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">prev-car-number {{mainLabel}} {{subLabel}}</svg>',
}));

vi.mock("@iracedeck/iracing-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/iracing-sdk")>();

  return {
    ...actual,
    getCarNumberFromSessionInfo: vi.fn(),
    getCarNumberRawFromSessionInfo: vi.fn(),
    getAllCarNumbers: vi.fn(() => []),
  };
});

// The dial surface has its own suite (`replay-control-dial-surface.test.ts`);
// here it is a recorder, so these tests see what the action routes to it and
// can call the host the action hands it.
const dialSurface = vi.hoisted(() => ({
  host: null as ReplayControlDialHost | null,
  willAppear: vi.fn(async (_action: unknown, _dial: unknown) => {}),
  willDisappear: vi.fn((_actionId: string) => {}),
  didReceiveSettings: vi.fn(async (_action: unknown, _dial: unknown) => {}),
  rotate: vi.fn((_action: unknown, _dial: unknown, _ticks: number, _pressed: boolean) => {}),
  down: vi.fn((_action: unknown, _dial: unknown) => {}),
  up: vi.fn(async (_actionId: string) => {}),
  touchTap: vi.fn((_action: unknown, _dial: unknown, _hold: boolean) => {}),
  onTick: vi.fn((_actionId: string, _tick: unknown) => {}),
  pressShape: vi.fn((_action: unknown, _dial: unknown): PressShape => ({ kind: "none" })),
  touchShape: vi.fn((_action: unknown, _dial: unknown, _hold: boolean): PressShape => ({ kind: "none" })),
}));

vi.mock("./replay-control-dial-surface.js", () => ({
  ReplayControlDialSurface: class MockReplayControlDialSurface {
    willAppear = dialSurface.willAppear;
    willDisappear = dialSurface.willDisappear;
    didReceiveSettings = dialSurface.didReceiveSettings;
    rotate = dialSurface.rotate;
    down = dialSurface.down;
    up = dialSurface.up;
    touchTap = dialSurface.touchTap;
    onTick = dialSurface.onTick;
    pressShape = dialSurface.pressShape;
    touchShape = dialSurface.touchShape;

    constructor(host: ReplayControlDialHost) {
      dialSurface.host = host;
    }
  },
}));

// The replay busy indicator (#1437) has its own suite; here it is a recorder,
// so a test sets the look a token shows and reads what registered.
const busy = vi.hoisted(() => {
  type Look = import("../../shared/replay-busy-indicator.js").ReplayBusyLook;
  type Surface = import("../../shared/replay-busy-indicator.js").ReplayBusySurface;

  const looks = new Map<string, Look>();
  const surfaces = new Map<string, { surface: Surface; unregister: ReturnType<typeof vi.fn> }>();

  return {
    looks,
    surfaces,
    register: vi.fn((surface: Surface) => {
      const unregister = vi.fn();

      surfaces.set(surface.token, { surface, unregister });

      return unregister;
    }),
    getLook: vi.fn((token: string): Look => looks.get(token) ?? { kind: "rest" }),
    reportIgnored: vi.fn((_token: string) => {}),
    setLogger: vi.fn(),
  };
});

vi.mock("../../shared/replay-busy-indicator.js", () => ({
  registerReplayBusySurface: busy.register,
  getReplayBusyLook: busy.getLook,
  reportReplayPressIgnored: busy.reportIgnored,
  setReplayBusyIndicatorLogger: busy.setLogger,
}));

// The engine as it is, with its Jump to Fastest Lap press a spy over the real
// one (#1467): a case can see what the key hands the engine, or answer for it.
vi.mock("@iracedeck/replay-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/replay-engine")>();

  return { ...actual, pressJumpToFastestLap: vi.fn(actual.pressJumpToFastestLap) };
});

vi.mock("@iracedeck/deck-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/deck-iracing")>()),
  getCommands: vi.fn(() => ({
    replay: {
      play: vi.fn(() => true),
      pause: vi.fn(() => true),
      setPlaySpeed: vi.fn(() => true),
      fastForward: vi.fn(() => true),
      rewind: vi.fn(() => true),
      slowMotion: vi.fn(() => true),
      nextFrame: vi.fn(() => true),
      prevFrame: vi.fn(() => true),
      nextSession: vi.fn(() => true),
      prevSession: vi.fn(() => true),
      nextLap: vi.fn(() => true),
      prevLap: vi.fn(() => true),
      nextIncident: vi.fn(() => true),
      prevIncident: vi.fn(() => true),
      goToStart: vi.fn(() => true),
      goToEnd: vi.fn(() => true),
      setPlayPosition: vi.fn(() => true),
      searchSessionTime: vi.fn(() => true),
    },
    camera: {
      switchNum: vi.fn(() => true),
    },
  })),
}));

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: (_fields: unknown) => {
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
    logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      // The replay command gate's own scope (#1430): its lines stay out of the action's.
      createScope: vi.fn(() => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    };
    // The controller's debounced replay state (#1324) runs the SDK's real rule,
    // stepped from whatever telemetry the test has set, at every read.
    sdkController = withSteppedReplayState({
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getCurrentTelemetry: vi.fn(() => null),
      getSessionInfo: vi.fn(() => null),
    });
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
    updateKeyImage = vi.fn();
    setActiveBinding = vi.fn();
    isBindingMissing = vi.fn(() => false);
    tapBinding = vi.fn().mockResolvedValue(undefined);
    async onWillAppear() {}
    async onDidReceiveSettings() {}
    async onWillDisappear() {}
  },
  applyGraphicTransform: vi.fn((_content: string) => _content),
  computeGraphicArea: vi.fn(() => ({ x: 8, y: 8, width: 128, height: 128 })),
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  LogLevel: { Info: 2 },
  parseSvgViewBox: vi.fn(() => undefined),
  getGlobalTitleSettings: vi.fn(() => ({})),
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
    ({
      graphicSvg,
      title,
      busy: mark,
    }: {
      graphicSvg: string;
      colors: unknown;
      title: { titleText: string };
      busy?: { kind: string; step?: number };
    }) => {
      const busyText = mark ? `[busy:${mark.kind}${mark.step === undefined ? "" : `:${mark.step}`}]` : "";
      const encoded = encodeURIComponent(`<svg>${graphicSvg}${busyText}${title?.titleText ?? ""}</svg>`);

      return `data:image/svg+xml,${encoded}`;
    },
  ),
  BUSY_MARK_FRAMES: 8,
  busyMarkSvg: vi.fn(
    (mark: { kind: string; step?: number }, _area: unknown, color: string) =>
      `<busy-mark ${mark.kind}${mark.step === undefined ? "" : `:${mark.step}`} ${color}/>`,
  ),
  extractGraphicContent: vi.fn((svg: string) =>
    svg
      .replace(/<svg[^>]*>/, "")
      .replace(/<\/svg>\s*$/, "")
      .replace(/<desc>[\s\S]*?<\/desc>/, "")
      .trim(),
  ),
  generateTitleText: vi.fn(() => ""),
  ICON_BASE_TEMPLATE: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect x="0" y="0" width="144" height="144" fill="{{backgroundColor}}"/>{{graphicContent}}{{titleContent}}</svg>`,
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

vi.mock("@iracedeck/replay-store", () => ({
  getReplaySessionStore: vi.fn(),
  isReplaySessionStoreInitialized: vi.fn(() => false),
  // The shared walk's windows (#1426), which the record steps read.
  MARKER_NEXT_MIN_AHEAD_FRAMES: 60,
  MARKER_PREVIOUS_MIN_BEHIND_FRAMES: 120,
  // The incident comparison's lag correction (#1426).
  REPLAY_FILE_FRAME_LAG: 59,
}));

vi.mock("@iracedeck/settings", () => ({
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({ fastestLapSearchDelayMs: 400 })),
}));

// The engine reads the two replay settings through its env (#1467); read them from the settings mock the cases set.
const engineSetting = (key: string): unknown =>
  (vi.mocked(getGlobalSettings)() as Record<string, unknown> | undefined)?.[key];

// Every configure and reset of the engine here carries these (engineOverDeck below): each starts from the unconfigured engine.
const engineSettings = {
  replayJumpPlayback: () => engineSetting("replayJumpPlayback"),
  fastestLapSearchDelayMs: () => engineSetting("fastestLapSearchDelayMs"),
};

// The engine over this file's deck-iracing mocks (#1467). Every reset goes through
// resetEngine, which resets each engine module and configures the engine again.
const { configureEngine, resetEngine } = engineOverDeck({ settings: engineSettings });

configureEngine();

/**
 * The engine reading `action`'s mocked controller, and logging its lap
 * presses — which moved into the engine (#1467) — on `action`'s own logger,
 * where these tests read them.
 */
function engineOverAction(action: ReplayControl) {
  return { controller: action["sdkController"], logger: replayControlScopeOn(action["logger"]) };
}

/**
 * Runs the fake clock until a press has done all it will, for a test whose
 * walk ends on a search that found nothing. Not `vi.runAllTimersAsync()`: the
 * replay command gate keeps its record of such a search, and polls the replay
 * while it stands (#1430), so no timer is ever the last one.
 */
async function runPressOut(): Promise<void> {
  await vi.advanceTimersByTimeAsync(120_000);
}

/** What a fresh telemetry read returns: a replay playing at `speed` (#1467: the keys read the speed fresh). */
function readingAt(action: ReplayControl, speed: number, slowMotion = false): void {
  vi.mocked(action["sdkController"].getCurrentTelemetry).mockReturnValue({
    IsReplayPlaying: true,
    ReplayPlaySpeed: replaySpeedToSdk(speed, slowMotion),
    ReplayPlaySlowMotion: slowMotion,
  } as TelemetryData);
}

/** The speed the keys show and step from: the engine's one record of it (#1467). */
function shownSpeed(action: ReplayControl): { speed: number; slowMotion: boolean } {
  return action["getCurrentSpeed"]();
}

/**
 * Ends the synchronous turn (#1467): the action reads telemetry once per turn
 * and shares that reading with every draw in it, so a reading a test changes
 * shows from the next turn, as a new reading does in the plugin.
 */
function laterTurn(): Promise<void> {
  return Promise.resolve();
}

/** Every speed the engine recorded as sent in the running test, in order (#1467): what the keys then show. */
const sentSpeeds: Array<{ speed: number; slowMotion: boolean }> = [];

describe("ReplayControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The replay command gate (#1430) and the target it records are module
    // state every press reaches: each test starts with nothing under way.
    resetEngine();
    busy.looks.clear();
    busy.surfaces.clear();
    sentSpeeds.length = 0;
    onReplaySpeedChanged((speed) => sentSpeeds.push(speed));
  });

  afterEach(() => {
    // And ends with nothing under way: a test on real timers that leaves the
    // gate polling would otherwise have its timer fire in a later test.
    resetEngine();
  });

  describe("parseSpeedSetting", () => {
    it("should parse normal speed values", () => {
      expect(parseSpeedSetting("1")).toEqual({ speed: 1, slowMotion: false });
      expect(parseSpeedSetting("8")).toEqual({ speed: 8, slowMotion: false });
      expect(parseSpeedSetting("16")).toEqual({ speed: 16, slowMotion: false });
    });

    it("should parse slow-motion speed values", () => {
      expect(parseSpeedSetting("s2")).toEqual({ speed: 2, slowMotion: true });
      expect(parseSpeedSetting("s8")).toEqual({ speed: 8, slowMotion: true });
      expect(parseSpeedSetting("s16")).toEqual({ speed: 16, slowMotion: true });
    });

    it("should clamp normal speeds to valid range", () => {
      expect(parseSpeedSetting("0")).toEqual({ speed: 1, slowMotion: false });
      expect(parseSpeedSetting("20")).toEqual({ speed: 16, slowMotion: false });
    });

    it("should clamp slow-motion speeds to valid range", () => {
      expect(parseSpeedSetting("s1")).toEqual({ speed: 2, slowMotion: true });
      expect(parseSpeedSetting("s20")).toEqual({ speed: 16, slowMotion: true });
    });

    it("should handle invalid input gracefully", () => {
      expect(parseSpeedSetting("abc")).toEqual({ speed: 1, slowMotion: false });
      expect(parseSpeedSetting("sabc")).toEqual({ speed: 2, slowMotion: true });
    });
  });

  describe("formatSpeedDisplay", () => {
    it("should format paused state", () => {
      expect(formatSpeedDisplay(0, false)).toBe("PAUSED");
    });

    it("should format normal forward speeds", () => {
      expect(formatSpeedDisplay(1, false)).toBe("1x");
      expect(formatSpeedDisplay(4, false)).toBe("4x");
      expect(formatSpeedDisplay(16, false)).toBe("16x");
    });

    it("should format rewind speeds", () => {
      expect(formatSpeedDisplay(-2, false)).toBe("-2x");
      expect(formatSpeedDisplay(-16, false)).toBe("-16x");
    });

    it("should format slow-motion speeds", () => {
      expect(formatSpeedDisplay(2, true)).toBe("1/2x");
      expect(formatSpeedDisplay(4, true)).toBe("1/4x");
      expect(formatSpeedDisplay(16, true)).toBe("1/16x");
    });

    it("should format reverse slow-motion speeds", () => {
      expect(formatSpeedDisplay(-2, true)).toBe("-1/2x");
      expect(formatSpeedDisplay(-4, true)).toBe("-1/4x");
      expect(formatSpeedDisplay(-16, true)).toBe("-1/16x");
    });
  });

  describe("formatSetSpeedLabel", () => {
    it("should format normal speed settings", () => {
      expect(formatSetSpeedLabel("1")).toBe("1x");
      expect(formatSetSpeedLabel("8")).toBe("8x");
    });

    it("should format slow-motion speed settings", () => {
      expect(formatSetSpeedLabel("s2")).toBe("1/2x");
      expect(formatSetSpeedLabel("s16")).toBe("1/16x");
    });
  });

  describe("calculateNeedleAngle", () => {
    it("should return -90 for slowest speed (1/16x)", () => {
      expect(calculateNeedleAngle("s16")).toBe(-90);
    });

    it("should return 0 for normal speed (1x)", () => {
      expect(calculateNeedleAngle("1")).toBe(0);
    });

    it("should return 90 for fastest speed (16x)", () => {
      expect(calculateNeedleAngle("16")).toBe(90);
    });

    it("should return -6 for 1/2x slow-mo", () => {
      expect(calculateNeedleAngle("s2")).toBe(-6);
    });

    it("should return 6 for 2x", () => {
      expect(calculateNeedleAngle("2")).toBe(6);
    });

    it("should return 48 for 9x (midpoint of fast range)", () => {
      expect(calculateNeedleAngle("9")).toBeCloseTo(48, 0);
    });
  });

  describe("generateReplayControlSvg", () => {
    const ALL_MODES = [
      "play-pause",
      "play-backward",
      "stop",
      "fast-forward",
      "rewind",
      "slow-motion",
      "slow-motion-rewind",
      "frame-forward",
      "frame-backward",
      "speed-increase",
      "speed-decrease",
      "set-speed",
      "speed-display",
      "next-session",
      "prev-session",
      "next-lap",
      "prev-lap",
      "next-incident",
      "prev-incident",
      "jump-to-beginning",
      "jump-to-live",
      "jump-to-my-car",
      "jump-to-fastest-lap",
      "jump-to-race-start",
      "next-car",
      "prev-car",
      "next-car-number",
      "prev-car-number",
    ] as const;

    it.each(ALL_MODES)("should generate a valid data URI for %s", (mode) => {
      const result = generateReplayControlSvg({ mode });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for different modes", () => {
      const results = ALL_MODES.map((mode) => generateReplayControlSvg({ mode }));

      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBe(ALL_MODES.length);
    });

    // Transport labels
    it("should include PLAY / PAUSE label for play-pause mode", () => {
      const result = generateReplayControlSvg({ mode: "play-pause" });

      expect(decodeURIComponent(result)).toContain("PLAY / PAUSE");
    });

    it("should include PLAY BACKW label for play-backward mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-backward" }));

      expect(decoded).toContain("PLAY BACKW");
    });

    it("should show PLAY BACKW label and pause icon for play-backward when isPlaying is true", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-backward" }, true));

      expect(decoded).toContain("PLAY BACKW");
      expect(decoded).toContain("pause-icon");
    });

    it("should show PLAY BACKW label for play-backward when isPlaying is false", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-backward" }, false));

      expect(decoded).toContain("PLAY BACKW");
    });

    it("should include STOP label for stop mode", () => {
      const result = generateReplayControlSvg({ mode: "stop" });

      expect(decodeURIComponent(result)).toContain("STOP");
    });

    it("should include FORWARD and FAST labels for fast-forward mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "fast-forward" }));

      expect(decoded).toContain("FORWARD");
      expect(decoded).toContain("FAST");
    });

    it("should include REWIND label for rewind mode", () => {
      const result = generateReplayControlSvg({ mode: "rewind" });

      expect(decodeURIComponent(result)).toContain("REWIND");
    });

    it("should include MOTION and SLOW labels for slow-motion mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "slow-motion" }));

      expect(decoded).toContain("MOTION");
      expect(decoded).toContain("SLOW");
    });

    it("should include REWIND and SLOW labels for slow-motion-rewind mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "slow-motion-rewind" }));

      expect(decoded).toContain("REWIND");
      expect(decoded).toContain("SLOW");
    });

    it("should include FRAME FWD label for frame-forward mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "frame-forward" }));

      expect(decoded).toContain("FRAME FWD");
    });

    it("should include FRAME BACK label for frame-backward mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "frame-backward" }));

      expect(decoded).toContain("FRAME BACK");
    });

    // Speed labels
    it("should include FASTER and REPLAY labels for speed-increase mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "speed-increase" }));

      expect(decoded).toContain("FASTER");
      expect(decoded).toContain("REPLAY");
    });

    it("should include SLOWER and REPLAY labels for speed-decrease mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "speed-decrease" }));

      expect(decoded).toContain("SLOWER");
      expect(decoded).toContain("REPLAY");
    });

    // Set speed labels
    it("should show configured speed label for set-speed mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "set-speed", speed: "4" }));

      expect(decoded).toContain("4x");
      expect(decoded).not.toContain("SET SPEED");
    });

    it("should show slow-motion speed label for set-speed mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "set-speed", speed: "s4" }));

      expect(decoded).toContain("1/4x");
      expect(decoded).not.toContain("SET SPEED");
    });

    it("should use dynamic title matching speed for set-speed mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "set-speed", speed: "1" }));

      expect(decoded).toContain("1x");
      expect(decoded).not.toContain("SET SPEED");
    });

    // Speed display labels
    it("should show current speed for speed-display mode when playing", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "speed-display" }, true, 4, false));

      expect(decoded).toContain("4x");
    });

    it("should show PAUSED for speed-display mode when not playing", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "speed-display" }, false, 0, false));

      expect(decoded).toContain("PAUSED");
    });

    it("should show slow-motion speed for speed-display mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "speed-display" }, true, 4, true));

      expect(decoded).toContain("1/4x");
    });

    // Navigation labels
    it("should include NEXT and SESSION labels for next-session mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "next-session" }));

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("SESSION");
    });

    it("should include PREVIOUS and SESSION labels for prev-session mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "prev-session" }));

      expect(decoded).toContain("PREVIOUS");
      expect(decoded).toContain("SESSION");
    });

    it("should include LAP and NEXT labels for next-lap mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "next-lap" }));

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("LAP");
    });

    it("should include LAP and PREVIOUS labels for prev-lap mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "prev-lap" }));

      expect(decoded).toContain("PREVIOUS");
      expect(decoded).toContain("LAP");
    });

    it("should include NEXT and INCIDENT labels for next-incident mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "next-incident" }));

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("INCIDENT");
    });

    it("should include PREVIOUS and INCIDENT labels for prev-incident mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "prev-incident" }));

      expect(decoded).toContain("PREVIOUS");
      expect(decoded).toContain("INCIDENT");
    });

    it("should include BEGINNING and JUMP TO labels for jump-to-beginning mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "jump-to-beginning" }));

      expect(decoded).toContain("BEGINNING");
      expect(decoded).toContain("JUMP TO");
    });

    it("should include LIVE and JUMP TO labels for jump-to-live mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "jump-to-live" }));

      expect(decoded).toContain("LIVE");
      expect(decoded).toContain("JUMP TO");
    });

    // Camera labels
    it("should include MY CAR and JUMP TO labels for jump-to-my-car mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "jump-to-my-car" }));

      expect(decoded).toContain("MY CAR");
      expect(decoded).toContain("JUMP TO");
    });

    it("should include FASTEST and LAP labels for jump-to-fastest-lap mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "jump-to-fastest-lap" }));

      expect(decoded).toContain("FASTEST");
      expect(decoded).toContain("LAP");
    });

    it("should include NEXT and CAR labels for next-car mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "next-car" }));

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("CAR");
    });

    it("should include PREVIOUS and CAR labels for prev-car mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "prev-car" }));

      expect(decoded).toContain("PREVIOUS");
      expect(decoded).toContain("CAR");
    });

    // Play/pause telemetry-aware label toggle
    it("should show PLAY / PAUSE label and play icon when not playing", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-pause" }, false));

      expect(decoded).toContain("PLAY / PAUSE");
      expect(decoded).toContain("play-pause");
    });

    it("should show PLAY / PAUSE label and pause icon when playing", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-pause" }, true));

      expect(decoded).toContain("PLAY / PAUSE");
      expect(decoded).toContain("pause-icon");
    });

    it("should show PLAY / PAUSE label when isPlaying is undefined", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-pause" }));

      expect(decoded).toContain("PLAY / PAUSE");
    });

    it("should not affect non-play-pause mode labels when isPlaying is true", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "stop" }, true));

      expect(decoded).toContain("STOP");
      expect(decoded).not.toContain("PAUSE");
    });
  });

  describe("findAdjacentCarByNumber", () => {
    beforeEach(() => {
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue(null);
      vi.mocked(getAllCarNumbers).mockReturnValue([]);
    });

    it("should return null when no cars available", () => {
      expect(findAdjacentCarByNumber(null, 0, "next")).toBeNull();
    });

    it("should return next car by number order", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "4", carNumberRaw: 4, userName: "" },
        { carIdx: 1, carNumber: "7", carNumberRaw: 7, userName: "" },
        { carIdx: 2, carNumber: "42", carNumberRaw: 42, userName: "" },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue("7");

      expect(findAdjacentCarByNumber({}, 1, "next")).toBe(42);
    });

    it("should return previous car by number order", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "4", carNumberRaw: 4, userName: "" },
        { carIdx: 1, carNumber: "7", carNumberRaw: 7, userName: "" },
        { carIdx: 2, carNumber: "42", carNumberRaw: 42, userName: "" },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue("7");

      expect(findAdjacentCarByNumber({}, 1, "prev")).toBe(4);
    });

    it("should wrap around from last to first", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "4", carNumberRaw: 4, userName: "" },
        { carIdx: 1, carNumber: "7", carNumberRaw: 7, userName: "" },
        { carIdx: 2, carNumber: "42", carNumberRaw: 42, userName: "" },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue("42");

      expect(findAdjacentCarByNumber({}, 2, "next")).toBe(4);
    });

    it("should wrap around from first to last", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "4", carNumberRaw: 4, userName: "" },
        { carIdx: 1, carNumber: "7", carNumberRaw: 7, userName: "" },
        { carIdx: 2, carNumber: "42", carNumberRaw: 42, userName: "" },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue("4");

      expect(findAdjacentCarByNumber({}, 0, "prev")).toBe(42);
    });

    it("should return first car when current car not found and direction is next", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "4", carNumberRaw: 4, userName: "" },
        { carIdx: 1, carNumber: "7", carNumberRaw: 7, userName: "" },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue(null);

      expect(findAdjacentCarByNumber({}, 99, "next")).toBe(4);
    });

    it("should return last car when current car not found and direction is prev", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "4", carNumberRaw: 4, userName: "" },
        { carIdx: 1, carNumber: "7", carNumberRaw: 7, userName: "" },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue(null);

      expect(findAdjacentCarByNumber({}, 99, "prev")).toBe(7);
    });

    it("should return carNumberRaw for cars with leading zeros", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "7", carNumberRaw: 7, userName: "" },
        { carIdx: 1, carNumber: "042", carNumberRaw: 3042, userName: "" },
        { carIdx: 2, carNumber: "99", carNumberRaw: 99, userName: "" },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue("7");

      expect(findAdjacentCarByNumber({}, 0, "next")).toBe(3042);
    });

    it("walks every competitor in session info — departed ones included, no pace car, no spectators (#1281)", async () => {
      // The REAL list helper over a post-race session: every driver stays in
      // DriverInfo after leaving, the pace car (carIdx 64) is listed with
      // CarIsPaceCar, and a spectator entry carries a number of its own.
      const actual = await vi.importActual<typeof import("@iracedeck/iracing-sdk")>("@iracedeck/iracing-sdk");
      vi.mocked(getAllCarNumbers).mockImplementation(actual.getAllCarNumbers);
      const sessionInfo = {
        DriverInfo: {
          Drivers: [
            { CarIdx: 0, CarNumber: "42", CarNumberRaw: 42, UserName: "Driver A" },
            { CarIdx: 1, CarNumber: "6", CarNumberRaw: 6, UserName: "Driver B" },
            { CarIdx: 2, CarNumber: "66", CarNumberRaw: 66, UserName: "Driver C" },
            { CarIdx: 30, CarNumber: "50", CarNumberRaw: 50, UserName: "Spectator", IsSpectator: 1 },
            { CarIdx: 64, CarNumber: "0", CarNumberRaw: 0, UserName: "Pace Car", CarIsPaceCar: 1 },
          ],
        },
      };

      // Ascending number order: #6 → #42 → #66 → (wrap) #6. Neither #0 nor #50.
      expect(findAdjacentCarByNumber(sessionInfo, 1, "next")).toBe(42);
      expect(findAdjacentCarByNumber(sessionInfo, 0, "next")).toBe(66);
      expect(findAdjacentCarByNumber(sessionInfo, 2, "next")).toBe(6);
      expect(findAdjacentCarByNumber(sessionInfo, 1, "prev")).toBe(66);
      // From the pace car (not listed), next re-enters at the lowest number.
      expect(findAdjacentCarByNumber(sessionInfo, 64, "next")).toBe(6);
    });

    it("returns null when the focused car is the only car listed", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([{ carIdx: 0, carNumber: "4", carNumberRaw: 4, userName: "" }]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue("4");

      expect(findAdjacentCarByNumber({}, 0, "next")).toBeNull();
      expect(findAdjacentCarByNumber({}, 0, "prev")).toBeNull();
    });
  });

  describe("play/pause behavior", () => {
    function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
      return {
        action: { id: actionId, isDial: () => false, setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings },
      };
    }

    const mockReplay = {
      play: vi.fn(() => true),
      pause: vi.fn(() => true),
      setPlaySpeed: vi.fn(() => true),
    };

    let action: ReplayControl;

    beforeEach(async () => {
      vi.clearAllMocks();
      // A press of a mode with a long-press repeat arms the repeat. On fake
      // timers it goes with the test, rather than firing in a later one through
      // the replay command gate every action shares (#1430).
      vi.useFakeTimers();
      const { getCommands } = await import("@iracedeck/deck-iracing");
      vi.mocked(getCommands).mockReturnValue({ replay: mockReplay, camera: { switchNum: vi.fn() } } as any);
      action = new ReplayControl();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    describe("slow-motion telemetry (#1202)", () => {
      function telemetryCallback(): (telemetry: TelemetryData | null) => void {
        const calls = vi.mocked(action["sdkController"].subscribe).mock.calls;

        return calls[calls.length - 1][1] as (telemetry: TelemetryData | null) => void;
      }

      /** A tick: the controller holds it as its current reading, then tells the subscriber. */
      function tick(telemetry: Partial<TelemetryData>): void {
        vi.mocked(action["sdkController"].getCurrentTelemetry).mockReturnValue(telemetry as TelemetryData);
        telemetryCallback()(telemetry as TelemetryData);
      }

      it("reads raw slow-motion N on appear as 1/(N+1)", async () => {
        vi.mocked(action["sdkController"].getCurrentTelemetry).mockReturnValue({
          ReplayPlaySpeed: 4,
          ReplayPlaySlowMotion: true,
        } as TelemetryData);

        await action.onWillAppear(fakeEvent("ctx-1", { mode: "speed-display" }) as any);

        expect(shownSpeed(action)).toEqual({ speed: 5, slowMotion: true });
      });

      it("reads raw slow-motion N on each tick as 1/(N+1), keeping direction", async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "speed-display" }) as any);

        tick({ ReplayPlaySpeed: -15, ReplayPlaySlowMotion: true });
        expect(shownSpeed(action).speed).toBe(-16);

        tick({ ReplayPlaySpeed: 0, ReplayPlaySlowMotion: true });
        expect(shownSpeed(action).speed).toBe(0);
      });

      it("leaves normal speeds unchanged", async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "speed-display" }) as any);

        tick({ ReplayPlaySpeed: 4, ReplayPlaySlowMotion: false });
        expect(shownSpeed(action).speed).toBe(4);
      });

      it("never decodes a tick with a slow-motion flag remembered from an earlier tick", async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "speed-display" }) as any);
        tick({ ReplayPlaySpeed: 4, ReplayPlaySlowMotion: true });

        tick({ ReplayPlaySpeed: 4 });

        expect(shownSpeed(action)).toEqual({ speed: 4, slowMotion: false });
      });

      it("steps from the real speed: 1/5x in iRacing decreases to 1/6x", async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "speed-decrease" }) as any);
        tick({ ReplayPlaySpeed: 4, ReplayPlaySlowMotion: true });

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "speed-decrease" }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(6, true);
      });

      it("Slow Motion at iRacing's 1/17x holds the speed rather than speeding up", async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "slow-motion" }) as any);
        tick({ ReplayPlaySpeed: 16, ReplayPlaySlowMotion: true });

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion", stepRate: 1 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(17, true);
      });

      it("Slow Motion Rewind at iRacing's -1/17x holds the speed rather than speeding up", async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "slow-motion-rewind" }) as any);
        tick({ ReplayPlaySpeed: -16, ReplayPlaySlowMotion: true });

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion-rewind", stepRate: 1 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-17, true);
      });
    });

    describe("play-pause toggle", () => {
      beforeEach(async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "play-pause" }) as any);
      });

      it("should pause when playing forward", async () => {
        readingAt(action, 1);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-pause" }) as any);

        expect(mockReplay.pause).toHaveBeenCalled();
        expect(shownSpeed(action).speed).toBe(0);
      });

      it("should play at 1x when paused", async () => {
        readingAt(action, 0);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-pause" }) as any);

        expect(mockReplay.play).toHaveBeenCalled();
        expect(shownSpeed(action).speed).toBe(1);
      });

      it("should pause when playing backward (not mirror)", async () => {
        readingAt(action, -4);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-pause" }) as any);

        expect(mockReplay.pause).toHaveBeenCalled();
        expect(mockReplay.play).not.toHaveBeenCalled();
        expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
        expect(shownSpeed(action).speed).toBe(0);
      });

      it("should pause when in slow-motion (not mirror)", async () => {
        readingAt(action, 2, true);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-pause" }) as any);

        expect(mockReplay.pause).toHaveBeenCalled();
        expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
        expect(shownSpeed(action).speed).toBe(0);
      });

      it("should always play at 1x, never restore previous speed", async () => {
        // Play at 8x, pause, then play again — should be 1x, not 8x
        readingAt(action, 8);
        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-pause" }) as any);
        expect(mockReplay.pause).toHaveBeenCalled();

        vi.clearAllMocks();
        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-pause" }) as any);
        expect(mockReplay.play).toHaveBeenCalled();
        expect(shownSpeed(action).speed).toBe(1);
      });
    });

    describe("play-backward toggle", () => {
      beforeEach(async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "play-backward" }) as any);
      });

      it("should pause when playing backward", async () => {
        readingAt(action, -1);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-backward" }) as any);

        expect(mockReplay.pause).toHaveBeenCalled();
        expect(shownSpeed(action).speed).toBe(0);
      });

      it("should play backward at -1x when paused", async () => {
        readingAt(action, 0);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-backward" }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-1, false);
        expect(shownSpeed(action).speed).toBe(-1);
      });

      it("should pause when playing forward (not switch to backward)", async () => {
        readingAt(action, 4);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-backward" }) as any);

        expect(mockReplay.pause).toHaveBeenCalled();
        expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
        expect(shownSpeed(action).speed).toBe(0);
      });
    });

    describe("cross-button display sync", () => {
      it("should update play-pause display when play-backward is pressed", async () => {
        // Both buttons visible on the same action instance
        await action.onWillAppear(fakeEvent("pp-ctx", { mode: "play-pause" }) as any);
        await action.onWillAppear(fakeEvent("pb-ctx", { mode: "play-backward" }) as any);

        // Playing forward — both should show pause state
        readingAt(action, 1);

        // Press play-backward → pauses
        await action.onKeyDown(fakeEvent("pb-ctx", { mode: "play-backward" }) as any);

        // Both keys read the one speed: paused
        expect(shownSpeed(action).speed).toBe(0);

        // Both displays should have been re-rendered
        expect(action["updateKeyImage"]).toHaveBeenCalled();
      });
    });

    describe("fast-forward / rewind step rate", () => {
      beforeEach(async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "fast-forward", stepRate: 2 }) as any);
      });

      it("should step fast-forward by stepRate (default 1) when starting from 1x", async () => {
        readingAt(action, 1);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "fast-forward", stepRate: 1 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(2, false);
      });

      it("should step fast-forward by stepRate=2 to 4x from 2x", async () => {
        readingAt(action, 2);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "fast-forward", stepRate: 2 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(4, false);
      });

      it("should always start fast-forward at 2x from paused, regardless of stepRate", async () => {
        readingAt(action, 0);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "fast-forward", stepRate: 3 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(2, false);
      });

      it("should clamp fast-forward to 16x when stepRate would exceed it", async () => {
        readingAt(action, 14);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "fast-forward", stepRate: 5 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(16, false);
      });

      it("should step rewind by stepRate=2 to -4x from -2x", async () => {
        readingAt(action, -2);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "rewind", stepRate: 2 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-4, false);
      });

      it("should clamp rewind to -16x when stepRate would exceed it", async () => {
        readingAt(action, -14);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "rewind", stepRate: 5 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-16, false);
      });

      it("should reset to -2x when entering rewind from forward play, regardless of stepRate", async () => {
        readingAt(action, 4);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "rewind", stepRate: 3 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-2, false);
      });
    });

    describe("slow-motion / slow-motion-rewind step rate", () => {
      beforeEach(async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "slow-motion", stepRate: 1 }) as any);
      });

      it("should jump to 1/2x on first slow-motion press from forward play", async () => {
        readingAt(action, 1);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion", stepRate: 3 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(2, true);
        expect(shownSpeed(action).speed).toBe(2);
        expect(shownSpeed(action).slowMotion).toBe(true);
      });

      it("should jump to 1/2x on first slow-motion press from paused", async () => {
        readingAt(action, 0);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion", stepRate: 5 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(2, true);
      });

      it("should jump to 1/2x on first slow-motion press from fast-forward", async () => {
        readingAt(action, 8);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion", stepRate: 2 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(2, true);
      });

      it("should step slow-motion by stepRate=1 from 1/2x to 1/3x", async () => {
        readingAt(action, 2, true);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion", stepRate: 1 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(3, true);
      });

      it("should step slow-motion by stepRate=2 from 1/2x to 1/4x", async () => {
        readingAt(action, 2, true);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion", stepRate: 2 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(4, true);
      });

      it("should clamp slow-motion to 1/16x when stepRate would exceed it", async () => {
        readingAt(action, 14, true);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion", stepRate: 5 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(16, true);
      });

      it("should reset to 1/2x when slow-motion pressed while in slow-motion-rewind", async () => {
        readingAt(action, -4, true);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion", stepRate: 3 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(2, true);
      });

      it("should jump to -1/2x on first slow-motion-rewind press from paused", async () => {
        readingAt(action, 0);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion-rewind", stepRate: 1 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-2, true);
        expect(shownSpeed(action).speed).toBe(-2);
        expect(shownSpeed(action).slowMotion).toBe(true);
      });

      it("should jump to -1/2x on first slow-motion-rewind press from rewind", async () => {
        readingAt(action, -8);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion-rewind", stepRate: 2 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-2, true);
      });

      it("should step slow-motion-rewind by stepRate=2 from -1/2x to -1/4x", async () => {
        readingAt(action, -2, true);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion-rewind", stepRate: 2 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-4, true);
      });

      it("should clamp slow-motion-rewind to -1/16x when stepRate would exceed it", async () => {
        readingAt(action, -14, true);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion-rewind", stepRate: 5 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-16, true);
      });

      it("should reset to -1/2x when slow-motion-rewind pressed while in slow-motion forward", async () => {
        readingAt(action, 4, true);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion-rewind", stepRate: 3 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-2, true);
      });
    });

    describe("disconnect handling", () => {
      it("should reset speed to 0 when telemetry becomes null", async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "play-pause" }) as any);

        readingAt(action, 4);
        expect(shownSpeed(action).speed).toBe(4);

        vi.mocked(action["sdkController"].getCurrentTelemetry).mockReturnValue(null);
        await laterTurn();

        expect(shownSpeed(action).speed).toBe(0);
        expect(shownSpeed(action).slowMotion).toBe(false);
      });

      it("should reset slow-motion flag on disconnect", async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "play-pause" }) as any);

        readingAt(action, 2, true);
        expect(shownSpeed(action).slowMotion).toBe(true);

        vi.mocked(action["sdkController"].getCurrentTelemetry).mockReturnValue(null);
        await laterTurn();

        expect(shownSpeed(action).speed).toBe(0);
        expect(shownSpeed(action).slowMotion).toBe(false);
      });
    });
  });

  describe("car cycling (keystroke dispatch)", () => {
    function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
      return {
        action: { id: actionId, isDial: () => false, setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings },
      };
    }

    let action: ReplayControl;

    beforeEach(async () => {
      vi.clearAllMocks();
      action = new ReplayControl();
    });

    it("next-car onKeyDown taps the replayControlNextCar global binding", async () => {
      await action.onWillAppear(fakeEvent("ctx-1", { mode: "next-car" }) as any);
      await action.onKeyDown(fakeEvent("ctx-1", { mode: "next-car" }) as any);

      expect(action["tapBinding"]).toHaveBeenCalledWith("replayControlNextCar");
    });

    it("prev-car onKeyDown taps the replayControlPrevCar global binding", async () => {
      await action.onWillAppear(fakeEvent("ctx-1", { mode: "prev-car" }) as any);
      await action.onKeyDown(fakeEvent("ctx-1", { mode: "prev-car" }) as any);

      expect(action["tapBinding"]).toHaveBeenCalledWith("replayControlPrevCar");
    });

    it("next-car does NOT consult telemetry for car selection", async () => {
      // Arrange: telemetry that would normally be inspected by the legacy path
      action["sdkController"].getCurrentTelemetry = vi.fn(() => ({
        CamCarIdx: 0,
        CarIdxLapDistPct: [0.1, 0.2],
        CarIdxOnPitRoad: [false, false],
        CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack],
      }));

      await action.onWillAppear(fakeEvent("ctx-1", { mode: "next-car" }) as any);
      await action.onKeyDown(fakeEvent("ctx-1", { mode: "next-car" }) as any);

      // No camera.switchNum call — keystroke is the only dispatch.
      const { getCommands } = await import("@iracedeck/deck-iracing");
      const cameraMock = vi.mocked(getCommands)().camera as unknown as { switchNum: ReturnType<typeof vi.fn> };
      expect(cameraMock.switchNum).not.toHaveBeenCalled();
    });

    it("declares the active binding so readiness tracking matches the configured key", async () => {
      await action.onWillAppear(fakeEvent("ctx-1", { mode: "next-car" }) as any);

      expect(action["setActiveBinding"]).toHaveBeenCalledWith("replayControlNextCar");
    });

    it("clears the active binding when switched to a non-keystroke mode", async () => {
      await action.onWillAppear(fakeEvent("ctx-1", { mode: "next-car" }) as any);
      vi.mocked(action["setActiveBinding"]).mockClear();

      await action.onDidReceiveSettings(fakeEvent("ctx-1", { mode: "next-session" }) as any);

      expect(action["setActiveBinding"]).toHaveBeenCalledWith(null);
    });
  });

  describe("car number cycling", () => {
    // Cars by number: #4 (carIdx 0), #7 (carIdx 1, focused), #42 (carIdx 2).
    const TELEMETRY = {
      CamCarIdx: 1,
      CarIdxLapCompleted: [-1, -1, -1],
      CarIdxLapDistPct: [0.1, 0.2, 0.3],
      CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack],
    };

    let action: ReplayControl;
    let mockCamera: { switchNum: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      vi.clearAllMocks();
      mockCamera = { switchNum: vi.fn(() => true) };

      const { getCommands } = await import("@iracedeck/deck-iracing");

      vi.mocked(getCommands).mockReturnValue({
        replay: { play: vi.fn(() => true) },
        camera: mockCamera,
      } as never);

      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "4", carNumberRaw: 4, userName: "a" },
        { carIdx: 1, carNumber: "7", carNumberRaw: 7, userName: "b" },
        { carIdx: 2, carNumber: "42", carNumberRaw: 42, userName: "c" },
      ]);

      action = new ReplayControl();
      action["sdkController"].getCurrentTelemetry = vi.fn(() => TELEMETRY);
      action["sdkController"].getSessionInfo = vi.fn(() => ({}));
      await action.onWillAppear({
        action: { id: "ctx-1", isDial: () => false, setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings: { mode: "next-car-number" } },
      } as never);
    });

    afterEach(async () => {
      // `vi.clearAllMocks()` (the suite-wide beforeEach) clears recorded calls
      // but NOT return values, so this block's pinned command surface and
      // three-car field would otherwise leak into every later describe. Reset
      // both back to their module-factory implementations.
      const { getCommands } = await import("@iracedeck/deck-iracing");

      vi.mocked(getCommands).mockReset();
      vi.mocked(getAllCarNumbers).mockReset();
    });

    it("focuses cars that left the world in the post-race snapshot shape on a key press, both directions (#1281)", async () => {
      // The 2026-09-29 capture's shape: every competitor reads -1 in lap
      // distance, surface and laps — at the live end and mid-replay alike —
      // and only the pace car (carIdx 64) is on track. Both directions still land.
      const notInWorld = new Array<number>(72).fill(-1);
      const lapDistPct = [...notInWorld];
      const trackSurface = [...notInWorld];
      lapDistPct[64] = 0.0595;
      trackSurface[64] = 2;
      action["sdkController"].getCurrentTelemetry = vi.fn(
        () =>
          ({
            CamCarIdx: 1,
            IsReplayPlaying: true,
            CarIdxLapCompleted: [...notInWorld],
            CarIdxLapDistPct: lapDistPct,
            CarIdxTrackSurface: trackSurface,
          }) as unknown as TelemetryData,
      );

      for (const mode of ["next-car-number", "prev-car-number"]) {
        await action.onKeyDown({
          action: { id: "ctx-1", setTitle: vi.fn(), setImage: vi.fn() },
          payload: { settings: { mode } },
        } as never);
      }

      expect(mockCamera.switchNum).toHaveBeenNthCalledWith(1, 42, 0, 0); // next: #7 → #42
      expect(mockCamera.switchNum).toHaveBeenNthCalledWith(2, 4, 0, 0); // previous: #7 → #4
    });

    it("reaches the neighbour on the formation lap on a key press, where no car has completed a lap (#968)", async () => {
      // The regressed path: Next / Previous Car (Number Order) once went dead
      // for the whole pace lap because a presence predicate demanded a
      // completed lap. Snapshot 20260417-081043's shape: cars on track, every
      // CarIdxLapCompleted -1.
      action["sdkController"].getCurrentTelemetry = vi.fn(
        () =>
          ({
            CamCarIdx: 1,
            CarIdxLapCompleted: [-1, -1, -1],
            CarIdxLapDistPct: [0.8174, 0.801, 0.8064],
            CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack],
          }) as unknown as TelemetryData,
      );

      await action.onKeyDown({
        action: { id: "ctx-1", setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings: { mode: "next-car-number" } },
      } as never);

      // A key dispatches `settings.mode` directly: "next" from focused #7 lands on #42.
      expect(mockCamera.switchNum).toHaveBeenCalledWith(42, 0, 0);
    });
  });

  describe("dial surface routing (#1316)", () => {
    // This suite's `CommonSettings.extend` is an identity parse, so the event
    // carries the parsed `dial` itself; `replay-control-settings.test.ts`
    // covers what the real schema makes of a stored object.
    const DIAL = ReplayControlDialSettings.parse({ pressAction: "reverse" });
    const mockReplay = { goToEnd: vi.fn(() => true) };
    /** A replay playing at 4x. */
    const REPLAY_4X = {
      IsReplayPlaying: true,
      ReplayPlaySpeed: 4,
      ReplayPlaySlowMotion: false,
      ReplayFrameNum: 4_000,
    } as TelemetryData;
    /** What telemetry reads in the post-seek blip, and from the car. */
    const NOT_PLAYING = { IsReplayPlaying: false, ReplayPlaySpeed: 8, ReplayFrameNum: 0 } as TelemetryData;

    let action: ReplayControl;

    function dialEvent(payload: Record<string, unknown> = {}, dial = DIAL) {
      return {
        action: { id: "dial-1", isDial: () => true, setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings: { mode: "play-pause", dial }, ...payload },
      };
    }

    function keyEvent(actionId: string, settings: Record<string, unknown>) {
      return {
        action: { id: actionId, isDial: () => false, setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings },
      };
    }

    function nowReading(telemetry: TelemetryData | null): void {
      action["sdkController"].getCurrentTelemetry = vi.fn(() => telemetry);
    }

    /** The telemetry callback the action subscribed for a context. */
    function tickOf(contextId: string): (telemetry: TelemetryData | null) => void {
      const call = vi.mocked(action["sdkController"].subscribe).mock.calls.find(([id]) => id === contextId);

      if (!call) throw new Error(`no telemetry subscription for ${contextId}`);

      return (telemetry) => call[1](telemetry, telemetry !== null);
    }

    /** The host the action handed its dial surface. */
    function host(): ReplayControlDialHost {
      if (!dialSurface.host) throw new Error("the action constructed no dial surface");

      return dialSurface.host;
    }

    beforeEach(async () => {
      vi.clearAllMocks();
      _resetReplayCursor();
      _resetReplaySpeedState();
      const { getCommands } = await import("@iracedeck/deck-iracing");

      vi.mocked(getCommands).mockReturnValue({ replay: mockReplay, camera: { switchNum: vi.fn() } } as never);
      action = new ReplayControl();
    });

    afterEach(async () => {
      // The pinned command surface would otherwise leak into every later describe.
      const { getCommands } = await import("@iracedeck/deck-iracing");

      vi.mocked(getCommands).mockReset();
    });

    describe("what the host hands the stepping modes (#801)", () => {
      it.each(["jump-to-fastest-lap walk", "jump-to-race-start walk"])(
        "a Track Order turn cancels the %s, whose searches ride on the camera's car",
        (owner) => {
          const claim = claimReplayCursor(owner);

          // The one place the camera-switch policy lives since #1467: the engine's waiter calls it.
          cancelLapWalks("dial-track-order");

          expect(claim.cancelledBy).toBe("dial-track-order");
        },
      );

      it.each(["dial-lap", "replay-markers next", "jump-to-fastest-lap record jump", "jump-to-race-start jump"])(
        "a Track Order turn leaves %s standing",
        (owner) => {
          const claim = claimReplayCursor(owner);

          cancelLapWalks("dial-track-order");

          expect(claim.cancelledBy).toBeNull();
        },
      );

      it.each(["jump-to-fastest-lap walk", "dial-lap"])(
        "Jump to My Car switches the camera to the player's car and takes no cursor: %s is left standing",
        async (owner) => {
          const { getCommands } = await import("@iracedeck/deck-iracing");
          const camera = { switchNum: vi.fn(() => true) };

          vi.mocked(getCommands).mockReturnValue({ replay: mockReplay, camera } as never);
          // Read once by the check and once by the switch.
          vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValueOnce(42).mockReturnValueOnce(42);
          action["sdkController"].getSessionInfo = vi.fn(() => ({ DriverInfo: { DriverCarIdx: 3 } }) as never);
          // A walk is the camera-switch waiter's to cancel (`cancelLapWalks`, #1467); a paced search's run is never.
          const claim = claimReplayCursor(owner);

          expect(host().canJumpToMyCar()).toBe(true);
          host().jumpToMyCar();

          expect(camera.switchNum).toHaveBeenCalledExactlyOnceWith(42, 0, 0);
          expect(claim.cancelledBy).toBeNull();
        },
      );

      it("Jump to My Car has nothing to switch to with no player's car, or no number for it", () => {
        action["sdkController"].getSessionInfo = vi.fn(() => ({ DriverInfo: { DriverCarIdx: -1 } }) as never);
        expect(host().canJumpToMyCar()).toBe(false);

        action["sdkController"].getSessionInfo = vi.fn(() => ({ DriverInfo: { DriverCarIdx: 3 } }) as never);
        vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValueOnce(null);
        expect(host().canJumpToMyCar()).toBe(false);

        action["sdkController"].getSessionInfo = vi.fn(() => null as never);
        expect(host().canJumpToMyCar()).toBe(false);
      });

      it("reads the record through the keypad's own source: a lap step lands a second before the line", async () => {
        const { getReplaySessionStore, isReplaySessionStoreInitialized } = await import("@iracedeck/replay-store");
        const store = { laps: {}, sessions: {} };

        vi.mocked(isReplaySessionStoreInitialized).mockReturnValueOnce(true);
        vi.mocked(getReplaySessionStore).mockReturnValueOnce(store as never);
        vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValueOnce(104);
        action["sdkController"].getSessionInfo = vi.fn(
          () =>
            ({
              WeekendInfo: { SubSessionID: 77 },
              SessionInfo: { Sessions: [{ SessionNum: 0 }, { SessionNum: 2 }] },
            }) as never,
        );

        const source = host().recordSource({ CamCarIdx: 4 } as TelemetryData);

        expect(source.store).toBe(store);
        expect(source.scope).toEqual({ subSessionId: 77 });
        expect(source.camCarIdx).toBe(4);
        expect(source.carNumberRaw(4)).toBe(104);
        expect(source.lapApproachFrames).toBe(60);
        expect(source.lastSessionNum).toBe(2);
        expect(host().recordSource(null).camCarIdx).toBeUndefined();
      });

      it("reads the binding state without setting the action's active binding", () => {
        host().isBindingMissing(["replayControlNextCar", "replayControlPrevCar"]);

        expect(action["setActiveBinding"]).not.toHaveBeenCalled();
      });
    });

    describe("lifecycle", () => {
      it("a dial appearing goes to the surface with its dial settings, never onto the key path", async () => {
        const ev = dialEvent();

        await action.onWillAppear(ev as never);

        expect(dialSurface.willAppear).toHaveBeenCalledTimes(1);
        expect(dialSurface.willAppear).toHaveBeenCalledWith(ev.action, DIAL);
        expect(action["activeContexts"].has("dial-1")).toBe(false);
        expect(action["setActiveBinding"]).not.toHaveBeenCalled();
        expect(action["setKeyImage"]).not.toHaveBeenCalled();
        expect(ev.action.setTitle).not.toHaveBeenCalled();
      });

      it("a dial joins the telemetry subscription after the surface knows it", async () => {
        await action.onWillAppear(dialEvent() as never);

        const subscribe = vi.mocked(action["sdkController"].subscribe);

        expect(subscribe).toHaveBeenCalledWith("dial-1", expect.any(Function));
        expect(dialSurface.willAppear.mock.invocationCallOrder[0]).toBeLessThan(subscribe.mock.invocationCallOrder[0]);
      });

      it("a key appearing never reaches the surface", async () => {
        await action.onWillAppear(keyEvent("key-1", { mode: "play-pause" }) as never);

        expect(dialSurface.willAppear).not.toHaveBeenCalled();
        expect(action["activeContexts"].has("key-1")).toBe(true);
        expect(action["setKeyImage"]).toHaveBeenCalledTimes(1);
      });

      it("a dial's new settings go to the surface, never onto the key path", async () => {
        await action.onWillAppear(dialEvent() as never);
        const changed = ReplayControlDialSettings.parse({ pressAction: "jump-to-live" });
        const ev = dialEvent({}, changed);

        await action.onDidReceiveSettings(ev as never);

        expect(dialSurface.didReceiveSettings).toHaveBeenCalledWith(ev.action, changed);
        expect(action["activeContexts"].has("dial-1")).toBe(false);
        expect(action["setActiveBinding"]).not.toHaveBeenCalled();
        expect(action["setKeyImage"]).not.toHaveBeenCalled();
      });

      it("a key's new settings never reach the surface", async () => {
        await action.onWillAppear(keyEvent("key-1", { mode: "play-pause" }) as never);
        await action.onDidReceiveSettings(keyEvent("key-1", { mode: "stop" }) as never);

        expect(dialSurface.didReceiveSettings).not.toHaveBeenCalled();
      });

      it("a disappearing dial leaves the surface and the subscription", async () => {
        nowReading(REPLAY_4X);
        await action.onWillAppear(dialEvent() as never);

        await action.onWillDisappear(dialEvent() as never);

        expect(dialSurface.willDisappear).toHaveBeenCalledWith("dial-1");
        expect(action["sdkController"].unsubscribe).toHaveBeenCalledWith("dial-1");
      });
    });

    describe("input", () => {
      it("a turn goes to the surface with its ticks and whether the dial was held", async () => {
        const held = dialEvent({ ticks: -3, pressed: true });
        const plain = dialEvent({ ticks: 2 });

        await action.onDialRotate(held as never);
        await action.onDialRotate(plain as never);

        expect(dialSurface.rotate).toHaveBeenNthCalledWith(1, held.action, DIAL, -3, true);
        expect(dialSurface.rotate).toHaveBeenNthCalledWith(2, plain.action, DIAL, 2, false);
      });

      it("a press and its release go to the surface", async () => {
        const ev = dialEvent();

        await action.onDialDown(ev as never);
        await action.onDialUp(ev as never);

        expect(dialSurface.down).toHaveBeenCalledWith(ev.action, DIAL);
        expect(dialSurface.up).toHaveBeenCalledWith("dial-1");
      });

      it("a touch goes to the surface with whether it was held", async () => {
        const tap = dialEvent({ hold: false });
        const longTouch = dialEvent({ hold: true });

        await action.onTouchTap(tap as never);
        await action.onTouchTap(longTouch as never);

        expect(dialSurface.touchTap).toHaveBeenNthCalledWith(1, tap.action, DIAL, false);
        expect(dialSurface.touchTap).toHaveBeenNthCalledWith(2, longTouch.action, DIAL, true);
      });

      it("no dial input sends a command of the action's own", async () => {
        await action.onWillAppear(dialEvent() as never);

        await action.onDialRotate(dialEvent({ ticks: 1 }) as never);
        await action.onDialDown(dialEvent() as never);
        await action.onDialUp(dialEvent() as never);
        await action.onTouchTap(dialEvent({ hold: false }) as never);

        expect(mockReplay.goToEnd).not.toHaveBeenCalled();
        expect(action["tapBinding"]).not.toHaveBeenCalled();
      });
    });

    describe("a dial's telemetry tick", () => {
      it("lets the surface compare its screen", async () => {
        await action.onWillAppear(dialEvent() as never);

        tickOf("dial-1")(REPLAY_4X);

        expect(dialSurface.onTick).toHaveBeenCalledWith("dial-1", expect.anything());
      });

      it("hands the surface the tick itself with its speed decoded, so the surface reads nothing for it", async () => {
        const quarterReverse = { ...REPLAY_4X, ReplayPlaySpeed: -3, ReplayPlaySlowMotion: true } as TelemetryData;
        const noSpeed = { IsReplayPlaying: true } as TelemetryData;
        await action.onWillAppear(dialEvent() as never);

        tickOf("dial-1")(quarterReverse);
        tickOf("dial-1")(noSpeed);
        tickOf("dial-1")(null);

        expect(dialSurface.onTick.mock.calls).toEqual([
          ["dial-1", { telemetry: quarterReverse, speed: { speed: -4, slowMotion: true } }],
          ["dial-1", { telemetry: noSpeed, speed: null }],
          ["dial-1", { telemetry: null, speed: null }],
        ]);
        expect(dialSurface.onTick.mock.calls[0][1]).toHaveProperty("telemetry", quarterReverse);
      });

      it("feeds the remembered speed while a replay is on screen", async () => {
        await action.onWillAppear(dialEvent() as never);
        nowReading(REPLAY_4X);

        tickOf("dial-1")(REPLAY_4X);

        expect(rememberedSpeed()).toEqual({ speed: 4, slowMotion: false });
      });

      it("feeds it in the units the user sees: a slow-motion divisor, decoded (#1202)", async () => {
        const quarterReverse = { ...REPLAY_4X, ReplayPlaySpeed: -3, ReplayPlaySlowMotion: true } as TelemetryData;
        await action.onWillAppear(dialEvent() as never);
        nowReading(quarterReverse);

        tickOf("dial-1")(quarterReverse);

        expect(rememberedSpeed()).toEqual({ speed: -4, slowMotion: true });
      });

      it("never feeds it from the car, where ReplayPlaySpeed says nothing about a replay", async () => {
        await action.onWillAppear(dialEvent() as never);
        nowReading(NOT_PLAYING);

        tickOf("dial-1")(NOT_PLAYING);

        expect(rememberedSpeed()).toEqual({ speed: 1, slowMotion: false });
      });

      it("keeps the remembered speed through a paused replay", async () => {
        const paused = { ...REPLAY_4X, ReplayPlaySpeed: 0 } as TelemetryData;
        await action.onWillAppear(dialEvent() as never);
        nowReading(REPLAY_4X);
        tickOf("dial-1")(REPLAY_4X);

        nowReading(paused);
        tickOf("dial-1")(paused);

        expect(rememberedSpeed()).toEqual({ speed: 4, slowMotion: false });
        expect(shownSpeed(action).speed).toBe(0);
      });

      it("a disconnect reads as paused and still reaches the surface, so its box can dim", async () => {
        await action.onWillAppear(dialEvent() as never);
        nowReading(REPLAY_4X);
        tickOf("dial-1")(REPLAY_4X);
        dialSurface.onTick.mockClear();

        nowReading(null);
        tickOf("dial-1")(null);

        expect(shownSpeed(action).speed).toBe(0);
        expect(dialSurface.onTick).toHaveBeenCalledWith("dial-1", { telemetry: null, speed: null });
        expect(rememberedSpeed()).toEqual({ speed: 4, slowMotion: false });
      });
    });

    describe("a key's telemetry tick feeds the remembered speed too", () => {
      const paused = { ...REPLAY_4X, ReplayPlaySpeed: 0 } as TelemetryData;

      it("remembers the speed a replay plays at while only keys are on the page", async () => {
        await action.onWillAppear(keyEvent("key-1", { mode: "next-lap" }) as never);
        nowReading(REPLAY_4X);

        tickOf("key-1")(REPLAY_4X);

        expect(rememberedSpeed()).toEqual({ speed: 4, slowMotion: false });
        expect(dialSurface.onTick).not.toHaveBeenCalled();
      });

      it("a speed set and paused with no dial on the page is there when the dial's page comes back", async () => {
        const eighthReverse = { ...REPLAY_4X, ReplayPlaySpeed: -7, ReplayPlaySlowMotion: true } as TelemetryData;
        await action.onWillAppear(keyEvent("key-1", { mode: "play-pause" }) as never);
        nowReading(eighthReverse);
        tickOf("key-1")(eighthReverse);
        nowReading(paused);
        tickOf("key-1")(paused);

        // The page changes: the key goes, the dial appears on a paused replay.
        await action.onWillDisappear(keyEvent("key-1", { mode: "play-pause" }) as never);
        await action.onWillAppear(dialEvent() as never);
        tickOf("dial-1")(paused);

        expect(rememberedSpeed()).toEqual({ speed: -8, slowMotion: true });
      });

      it("never feeds it from the car", async () => {
        await action.onWillAppear(keyEvent("key-1", { mode: "play-pause" }) as never);
        nowReading(NOT_PLAYING);

        tickOf("key-1")(NOT_PLAYING);

        expect(rememberedSpeed()).toEqual({ speed: 1, slowMotion: false });
      });

      it("leaves it alone on a disconnect", async () => {
        await action.onWillAppear(keyEvent("key-1", { mode: "play-pause" }) as never);
        nowReading(REPLAY_4X);
        tickOf("key-1")(REPLAY_4X);

        nowReading(null);
        tickOf("key-1")(null);

        expect(rememberedSpeed()).toEqual({ speed: 4, slowMotion: false });
      });
    });

    describe("the host the surface reads the action through", () => {
      it("says a replay is on screen through the post-seek blip, by the controller's debounced state", () => {
        nowReading(REPLAY_4X);
        expect(host().inReplay()).toBe(true);

        // Raw IsReplayPlaying reads false for ~300 ms after every seek.
        nowReading(NOT_PLAYING);
        expect(host().inReplay()).toBe(true);
      });

      it("says no replay is on screen from the car", () => {
        nowReading(NOT_PLAYING);

        expect(host().inReplay()).toBe(false);
      });

      it("hands over a fresh telemetry read every time, never the last tick a dial was delivered", async () => {
        expect(host().telemetry()).toBeNull();

        const paused = { ...REPLAY_4X, ReplayPlaySpeed: 0 } as TelemetryData;
        await action.onWillAppear(dialEvent() as never);
        nowReading(REPLAY_4X);
        tickOf("dial-1")(REPLAY_4X);
        expect(host().telemetry()).toBe(REPLAY_4X);

        // The replay pauses on a frame that does not advance SessionTick: no tick is delivered.
        nowReading(paused);

        expect(host().telemetry()).toBe(paused);
      });

      it("reads the controller once per ask", async () => {
        nowReading(REPLAY_4X);
        const read = vi.mocked(action["sdkController"].getCurrentTelemetry);
        read.mockClear();

        host().telemetry();
        host().telemetry();

        expect(read).toHaveBeenCalledTimes(2);
      });

      it("refreshKeys redraws the keys whose icon follows the speed, and no dial", async () => {
        await action.onWillAppear(keyEvent("key-1", { mode: "speed-display" }) as never);
        await action.onWillAppear(keyEvent("key-2", { mode: "next-lap" }) as never);
        await action.onWillAppear(dialEvent() as never);

        // A tick on a paused replay has drawn the speed key.
        nowReading({ ...REPLAY_4X, ReplayPlaySpeed: 0 });

        for (const contextId of ["key-1", "key-2", "dial-1"]) tickOf(contextId)({ ...REPLAY_4X, ReplayPlaySpeed: 0 });

        vi.mocked(action["updateKeyImage"]).mockClear();

        // The replay plays on at 4x on a frame that delivers no tick.
        nowReading(REPLAY_4X);
        await laterTurn();
        host().refreshKeys();

        expect(action["updateKeyImage"]).toHaveBeenCalledTimes(1);
        expect(action["updateKeyImage"]).toHaveBeenCalledWith("key-1", expect.stringContaining("4x"));
      });

      it("jumpToLive is the keypad's own jump: cursor take, goToEnd and the replay-state note", () => {
        const cancelledBy = vi.fn();
        claimReplayCursor("fastest-lap", cancelledBy);
        vi.spyOn(action["sdkController"], "noteReplayLeftForLive");

        host().jumpToLive("dial-1");

        expect(cancelledBy).toHaveBeenCalledWith("jump-to-live");
        expect(mockReplay.goToEnd).toHaveBeenCalledTimes(1);
        expect(action["sdkController"].noteReplayLeftForLive).toHaveBeenCalledTimes(1);
        expect(action["logger"].info).toHaveBeenCalledWith("Jump to live executed");
      });

      it("jumpToLive goes out under the dial's own token, so its box can show the busy look (#1437)", () => {
        host().jumpToLive("dial-1");

        expect(mockReplay.goToEnd).toHaveBeenCalledTimes(1);
        expect(getReplayGateRecord().search?.origin).toBe("dial-1");
      });
    });

    describe("a command a key sends supersedes the dial's pending speed", () => {
      // Every keypad mode takes the replay cursor before it sends (the replay
      // command gate's press, #1430), and a cursor take drops the pending speed.
      const keyReplay = {
        play: vi.fn(() => true),
        pause: vi.fn(() => true),
        setPlaySpeed: vi.fn(() => true),
        fastForward: vi.fn(() => true),
        nextLap: vi.fn(() => true),
        goToEnd: vi.fn(() => true),
      };
      const PAUSED = { speed: 0, slowMotion: false };
      /** What the tick still carries inside the hold: the replay at 4x. */
      const STALE_4X = { speed: 4, slowMotion: false };
      let t0: number;

      beforeEach(async () => {
        const { getCommands } = await import("@iracedeck/deck-iracing");

        vi.mocked(getCommands).mockReturnValue({ replay: keyReplay, camera: { switchNum: vi.fn() } } as never);
        t0 = Date.now();
      });

      it.each<[string, Record<string, unknown>, { speed: number; slowMotion: boolean }]>([
        ["Play/Pause", { mode: "play-pause" }, { speed: 1, slowMotion: false }],
        ["Stop", { mode: "stop" }, PAUSED],
        ["Fast Forward", { mode: "fast-forward", stepRate: 1 }, { speed: 2, slowMotion: false }],
        ["Set Speed", { mode: "set-speed", speed: "2" }, { speed: 2, slowMotion: false }],
        ["Next Lap", { mode: "next-lap" }, STALE_4X],
        ["Jump to Live", { mode: "jump-to-live" }, STALE_4X],
      ])(
        "a %s key inside the hold drops the dial's pending speed: the live speed is the key's own send, or telemetry",
        async (_name, settings, after) => {
          await action.onWillAppear(keyEvent("key-1", settings) as never);

          // A record step sends nothing outside a replay (#1426): Next Lap is pressed in one.
          if (settings.mode === "next-lap") nowReading(REPLAY_4X);

          // A Frame Jog detent paused the playing replay: the dial reads 0x for the hold.
          noteReplaySpeedSent(PAUSED, t0, { rememberSpeed: true });
          expect(resolveLiveSpeed(STALE_4X, t0 + 10)).toEqual(PAUSED);

          await action.onKeyDown(keyEvent("key-1", settings) as never);
          // Released, so Fast Forward's long-press repeat does not outlive the test.
          await action.onKeyUp(keyEvent("key-1", settings) as never);

          // The key's take dropped the dial's pause; a speed the key sent is the engine's record now (#1467).
          expect(resolveLiveSpeed(STALE_4X, t0 + 20)).toEqual(after);
        },
      );

      it("the key's speed is then remembered from telemetry again", async () => {
        await action.onWillAppear(keyEvent("key-1", { mode: "set-speed", speed: "8" }) as never);
        nowReading(REPLAY_4X);
        tickOf("key-1")(REPLAY_4X);
        noteReplaySpeedSent(PAUSED, Date.now(), { rememberSpeed: true });

        await action.onKeyDown(keyEvent("key-1", { mode: "set-speed", speed: "8" }) as never);
        const eightTimes = { ...REPLAY_4X, ReplayPlaySpeed: 8 } as TelemetryData;
        nowReading(eightTimes);
        tickOf("key-1")(eightTimes);

        expect(rememberedSpeed()).toEqual({ speed: 8, slowMotion: false });
      });

      it("a key press leaves the remembered speed alone", async () => {
        await action.onWillAppear(keyEvent("key-1", { mode: "stop" }) as never);
        noteReplaySpeedSent(STALE_4X, t0, { rememberSpeed: true });

        await action.onKeyDown(keyEvent("key-1", { mode: "stop" }) as never);

        expect(rememberedSpeed()).toEqual(STALE_4X);
      });

      it("a Speed Display key, which sends nothing, leaves the pending speed standing", async () => {
        await action.onWillAppear(keyEvent("key-1", { mode: "speed-display" }) as never);
        noteReplaySpeedSent(PAUSED, t0, { rememberSpeed: true });

        await action.onKeyDown(keyEvent("key-1", { mode: "speed-display" }) as never);

        expect(resolveLiveSpeed(STALE_4X, t0 + 10)).toEqual(PAUSED);
      });

      it("the key redraw a dial's send asks the host for leaves the pending speed standing", async () => {
        await action.onWillAppear(keyEvent("key-1", { mode: "play-pause" }) as never);
        await action.onWillAppear(dialEvent() as never);
        nowReading(REPLAY_4X);
        tickOf("dial-1")(REPLAY_4X);
        noteReplaySpeedSent(PAUSED, t0, { rememberSpeed: true });

        host().refreshKeys();

        expect(shownSpeed(action).speed).toBe(0);
        expect(resolveLiveSpeed(STALE_4X, t0 + 10)).toEqual(PAUSED);
      });
    });
  });

  describe("jump-to-fastest-lap", () => {
    // The press, its record jump and its walk are the replay engine's (#1467);
    // their tests are its `fastest-lap-press.test.ts`. Here: what the key hands
    // the engine, and what the key does around a press — its icons, the replay
    // busy indicator, another key cancelling a walk — over the engine wired to
    // this action's controller. A disconnect dropping the walk's session map is
    // the engine's own, on its `replayLeft` (`fastest-lap-press.test.ts`).
    function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
      return {
        action: { id: actionId, isDial: () => false, setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings },
      };
    }

    const mockReplay = {
      play: vi.fn(() => true),
      pause: vi.fn(() => true),
      setPlaySpeed: vi.fn<(speed: number, slowMotion?: boolean) => boolean>(() => true),
      nextFrame: vi.fn(() => true),
      prevFrame: vi.fn(() => true),
      nextLap: vi.fn(() => true),
      prevLap: vi.fn(() => true),
      nextSession: vi.fn(() => true),
      prevSession: vi.fn(() => true),
      goToStart: vi.fn(() => true),
      goToEnd: vi.fn(() => true),
      setPlayPosition: vi.fn<(mode: ReplayPosMode, frameNumber: number) => boolean>(() => true),
      searchSessionTime: vi.fn(() => true),
    };

    /**
     * Sets the **Replay jump playback** global setting (#1276) beside the
     * search delay. `undefined` leaves the key out, which reads as Remember.
     */
    function setJumpPlayback(mode: ReplayJumpPlayback | undefined, fastestLapSearchDelayMs = 400): void {
      vi.mocked(getGlobalSettings).mockReturnValue({
        fastestLapSearchDelayMs,
        ...(mode === undefined ? {} : { replayJumpPlayback: mode }),
      } as ReturnType<typeof getGlobalSettings>);
    }

    const mockCamera = {
      switchNum: vi.fn(() => true),
    };

    /**
     * The per-session replay record (#1203). `findLapStart` defaults to a
     * miss so the dispatch walks; a test that wants the lookup path returns a
     * hit from it.
     */
    const mockStore = {
      laps: {
        findLapStart: vi.fn<(query: LapStartQuery & { subSessionId?: number }) => LapStartLookup>(() => ({
          hit: false,
          reason: "no file",
        })),
        recordLapStart: vi.fn<(record: LapStartRecord & { subSessionId?: number }) => boolean>(() => true),
        recordLapTime: vi.fn(() => true),
      },
    };

    let action: ReplayControl;

    beforeEach(async () => {
      vi.clearAllMocks();
      const { getReplaySessionStore, isReplaySessionStoreInitialized } = await import("@iracedeck/replay-store");
      const { getCommands } = await import("@iracedeck/deck-iracing");
      // getCarNumberRawFromSessionInfo is mocked in the shared @iracedeck/iracing-sdk block;
      // default it to returning the carIdx as the raw number so individual tests don't have
      // to wire fake session info.
      vi.mocked(getCarNumberRawFromSessionInfo).mockImplementation((_si: unknown, idx: number) => idx);
      vi.mocked(getCommands).mockReturnValue({ replay: mockReplay, camera: mockCamera } as any);
      vi.mocked(isReplaySessionStoreInitialized).mockReturnValue(true);
      vi.mocked(getReplaySessionStore).mockReturnValue(mockStore as any);
      mockStore.laps.findLapStart.mockImplementation(() => ({ hit: false, reason: "no file" }));
      mockStore.laps.recordLapStart.mockImplementation(() => true);

      // A test may wrap or replace these; the buffer helpers re-wire only the cursor commands.
      for (const command of [mockReplay.play, mockReplay.pause, mockCamera.switchNum]) {
        command.mockReset();
        command.mockImplementation(() => true);
      }

      mockReplay.setPlaySpeed.mockReset();
      mockReplay.setPlaySpeed.mockImplementation(() => true);

      // Play, so that the end of a press is one command these tests can see on
      // the buffers' paused replay: `setPlaySpeed(1, false)`. Under the default
      // (Remember) a paused replay ends a press with no command at all.
      setJumpPlayback("play");
      action = new ReplayControl();
      // The engine reads this action's controller and logs its presses on
      // this action's logger (#1467). Every engine module was reset in the
      // outer beforeEach — the walk's session-map cache, the in-flight slot and
      // the cursor claim included. The replay command gate (#1430) reads the
      // replay the buffers simulate, so the jumps a press sends read back and
      // nothing stands after a walk.
      configureEngine({
        ...engineOverAction(action),
        readTelemetry: () => action["sdkController"].getCurrentTelemetry(),
        inReplay: () => true,
      });
    });

    afterEach(() => {
      setJumpPlayback(undefined);
    });

    it("the Jump to Fastest Lap key hands the engine its context and target", async () => {
      vi.mocked(pressJumpToFastestLap).mockReturnValueOnce({ kind: "refused", reason: "test" });

      await action.onWillAppear(
        fakeEvent("ctx-1", { mode: "jump-to-fastest-lap", fastestLapTarget: "always-my-car" }) as any,
      );
      await action.onKeyDown(
        fakeEvent("ctx-1", { mode: "jump-to-fastest-lap", fastestLapTarget: "always-my-car" }) as any,
      );

      expect(pressJumpToFastestLap).toHaveBeenCalledExactlyOnceWith({ origin: "ctx-1", target: "always-my-car" });
      expect(busy.reportIgnored).not.toHaveBeenCalled();
    });

    it("an ignored Jump to Fastest Lap press is reported to the busy indicator", async () => {
      vi.mocked(pressJumpToFastestLap).mockReturnValueOnce({ kind: "ignored" });

      await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
      await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);

      expect(busy.reportIgnored).toHaveBeenCalledExactlyOnceWith("ctx-1");
    });

    describe("dispatch", () => {
      /** A buffer over this action's controller and this describe's replay (`lap-walk-buffer.test-support.ts`). */
      function singleSessionBuffer(
        carIdx: number,
        fastestLap: number,
        opts: Parameters<typeof oneSessionLapBuffer>[4] = {},
      ): ReturnType<typeof oneSessionLapBuffer> {
        return oneSessionLapBuffer(action["sdkController"], mockReplay, carIdx, fastestLap, opts);
      }

      /** Every cursor- or speed-affecting replay command the walk and the lookup can send. */
      function countReplayCommands(): number {
        return [
          mockReplay.pause,
          mockReplay.play,
          mockReplay.setPlaySpeed,
          mockReplay.goToStart,
          mockReplay.goToEnd,
          mockReplay.nextSession,
          mockReplay.nextLap,
          mockReplay.prevLap,
          mockReplay.setPlayPosition,
        ].reduce((n, command) => n + command.mock.calls.length, 0);
      }

      /** The searches only a walk sends. */
      function walkSearches(): number {
        return [mockReplay.goToStart, mockReplay.nextSession, mockReplay.nextLap, mockReplay.prevLap].reduce(
          (n, command) => n + command.mock.calls.length,
          0,
        );
      }

      describe("walk repairs (#1203)", () => {
        it("redraws the keys at the walk's pause, with no tick (#1467)", async () => {
          vi.useFakeTimers();

          try {
            singleSessionBuffer(4, 4);
            // The replay plays at 1x when the press comes.
            const read = action["sdkController"].getCurrentTelemetry;

            action["sdkController"].getCurrentTelemetry = vi.fn(() => ({
              ...(read() as object),
              ReplayPlaySpeed: 1,
            })) as any;
            await action.onWillAppear(fakeEvent("ctx-speed", { mode: "speed-display" }) as any);
            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            expect(mockReplay.pause).not.toHaveBeenCalled();
            vi.mocked(action["updateKeyImage"]).mockClear();

            await vi.advanceTimersByTimeAsync(0);

            expect(mockReplay.pause).toHaveBeenCalledTimes(1);
            expect(action["updateKeyImage"]).toHaveBeenCalledWith("ctx-speed", expect.stringContaining("PAUSED"));

            await runPressOut();
          } finally {
            vi.useRealTimers();
          }
        });

        it("a play-pause dispatch during a walk cancels it; the walk sends nothing more", async () => {
          vi.useFakeTimers();

          try {
            singleSessionBuffer(4, 4);

            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.advanceTimersByTimeAsync(1200);

            const searchesBefore = walkSearches();

            // The cache says paused (the walk mirrored its pause), so Play/Pause sends play.
            await action.onKeyDown(fakeEvent("ctx-2", { mode: "play-pause" }) as any);

            expect(action["logger"].info).toHaveBeenCalledWith("Jump to fastest lap: walk cancelled by play-pause");

            await runPressOut();

            // The walk sent nothing more. The Play went out once: the walk's
            // last Next Session search shows nothing on a paused replay, so the
            // Play waited until that search could no longer be running and then
            // went out by the gate's takeover (#1430).
            expect(walkSearches()).toBe(searchesBefore);
            expect(mockReplay.pause).toHaveBeenCalledTimes(1);
            expect(mockReplay.play).toHaveBeenCalledTimes(1);
            expect(sentSpeeds.at(-1)).toEqual({ speed: 1, slowMotion: false });
            expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();

            // The slot is released: a new press walks.
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await runPressOut();

            expect(mockReplay.pause).toHaveBeenCalledTimes(2);
          } finally {
            vi.useRealTimers();
          }
        });
      });

      describe("the walk refuses what it cannot verify (#1203 review)", () => {
        it.each([-1, undefined])(
          "refuses a press while SessionNum is %s (the post-jump transient) before any command",
          async (sessionNum) => {
            singleSessionBuffer(4, 4);
            const settled = action["sdkController"].getCurrentTelemetry;

            action["sdkController"].getCurrentTelemetry = vi.fn(() => ({
              ...(settled() as any),
              SessionNum: sessionNum,
              // The CarIdxBestLapNum fallback still names a lap in the transient.
              CarIdxBestLapNum: new Array(64).fill(4),
            }));

            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);

            expect(action["logger"].info).toHaveBeenCalledWith(
              "Jump to fastest lap: replay session not settled yet; press ignored",
            );
            // Not a press ignored behind one in flight: out of #1437's scope.
            expect(busy.reportIgnored).not.toHaveBeenCalled();
            expect(mockCamera.switchNum).not.toHaveBeenCalled();
            expect(mockStore.laps.findLapStart).not.toHaveBeenCalled();
            expect(countReplayCommands()).toBe(0);
            expect(_getFastestLapSessionCache()).toBeNull();
          },
        );
      });

      describe("one walk at a time, without holding a cancelled one's slot (#1203 review)", () => {
        it("a second press during a walk sends no camera switch", async () => {
          vi.useFakeTimers();

          try {
            singleSessionBuffer(4, 4);

            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onWillAppear(fakeEvent("ctx-2", { mode: "jump-to-fastest-lap" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.advanceTimersByTimeAsync(1200);

            // The second key's switch is never sent: from a key with another
            // target it would re-frame the car the camera-relative lap search
            // follows mid-walk.
            await action.onKeyDown(fakeEvent("ctx-2", { mode: "jump-to-fastest-lap" }) as any);

            expect(mockCamera.switchNum).toHaveBeenCalledExactlyOnceWith(4, 0, 0);
            expect(action["logger"].info).toHaveBeenCalledWith(
              "Jump to fastest lap: previous press still in flight; press ignored",
            );
            // The ignored key shows not done (#1437); the walking one is left alone.
            expect(busy.reportIgnored).toHaveBeenCalledExactlyOnceWith("ctx-2");

            await vi.runAllTimersAsync();

            expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({ carIdx: 4, lap: 4 }),
            );
          } finally {
            vi.useRealTimers();
          }
        });

        it("a cancelled walk does not block a new one while it unwinds, and its finally leaves the new walk's slot alone", async () => {
          vi.useFakeTimers();

          try {
            singleSessionBuffer(4, 4);

            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onWillAppear(fakeEvent("ctx-2", { mode: "play-pause" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.advanceTimersByTimeAsync(1200);

            // Play/Pause takes the cursor; the walk is still inside its sleep.
            await action.onKeyDown(fakeEvent("ctx-2", { mode: "play-pause" }) as any);
            expect(action["logger"].info).toHaveBeenCalledWith("Jump to fastest lap: walk cancelled by play-pause");

            // Re-press at once: the new walk starts (its camera switch), not "press ignored".
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.advanceTimersByTimeAsync(0);

            expect(action["logger"].info).not.toHaveBeenCalledWith(
              "Jump to fastest lap: previous press still in flight; press ignored",
            );
            expect(mockCamera.switchNum).toHaveBeenCalledTimes(2);

            const newWalk = _activeLapPress();

            expect(newWalk?.claim.cancelledBy).toBeNull();

            // Let the old walk's sleep end and unwind: the slot still holds the new walk.
            await vi.advanceTimersByTimeAsync(100);
            expect(_activeLapPress()).toBe(newWalk);

            await runPressOut();

            // Exactly one walk converged and recorded; the cancelled one sent nothing more.
            expect(mockStore.laps.recordLapStart).toHaveBeenCalledTimes(1);
            expect(_activeLapPress()).toBeNull();
            expect(
              vi.mocked(action["logger"].info).mock.calls.filter((c) => String(c[0]).includes("walk cancelled")),
            ).toHaveLength(1);
          } finally {
            vi.useRealTimers();
          }
        });
      });
    });
  });

  describe("long-press repeat", () => {
    /** Create a minimal fake event with the given action ID and settings. */
    function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
      return {
        action: { id: actionId, isDial: () => false, setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings },
      };
    }

    const mockReplay = {
      play: vi.fn(() => true),
      pause: vi.fn(() => true),
      setPlaySpeed: vi.fn(() => true),
    };

    let action: ReplayControl;

    beforeEach(async () => {
      vi.clearAllMocks();
      const { getCommands } = await import("@iracedeck/deck-iracing");
      vi.mocked(getCommands).mockReturnValue({ replay: mockReplay, camera: { switchNum: vi.fn() } } as any);
      action = new ReplayControl();
      await action.onWillAppear(fakeEvent("action-1", { mode: "fast-forward" }) as any);
    });

    it("should auto-stop repeat after safety timeout", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "fast-forward" }) as any);
        expect((action as any).repeatTimers.has("action-1")).toBe(true);

        await vi.advanceTimersByTimeAsync(15_000);

        expect((action as any).repeatTimers.has("action-1")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should log a warning when safety timeout triggers", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "fast-forward" }) as any);

        await vi.advanceTimersByTimeAsync(15_000);

        expect(action["logger"].warn).toHaveBeenCalledWith(expect.stringContaining("safety timeout"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("should clear safety timeout when keyUp arrives normally", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "fast-forward" }) as any);
        expect((action as any).repeatTimers.has("action-1")).toBe(true);

        await vi.advanceTimersByTimeAsync(500);
        await action.onKeyUp(fakeEvent("action-1") as any);
        expect((action as any).repeatTimers.has("action-1")).toBe(false);

        // Advance past safety timeout — no error, nothing happens
        await vi.advanceTimersByTimeAsync(15_000);
        expect((action as any).repeatTimers.has("action-1")).toBe(false);
        expect(action["logger"].warn).not.toHaveBeenCalledWith(expect.stringContaining("safety timeout"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("should fire exactly once for a quick tap shorter than the hold threshold", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "fast-forward" }) as any);
        // Initial keyDown fires executeMode once.
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledTimes(1);

        // Release well before the 500ms initial delay.
        await vi.advanceTimersByTimeAsync(100);
        await action.onKeyUp(fakeEvent("action-1") as any);

        // No further repeats even after a long wait.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledTimes(1);
        expect((action as any).repeatTimers.has("action-1")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should repeat while held using a self-awaiting loop", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "fast-forward" }) as any);
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledTimes(1);

        // Initial hold delay must elapse before the loop starts.
        await vi.advanceTimersByTimeAsync(499);
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        // Hold threshold crossed; loop is scheduled, first tick fires
        // LONG_PRESS_REPEAT_GAP_MS (250ms) later.
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(250);
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(250);
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledTimes(3);

        await action.onKeyUp(fakeEvent("action-1") as any);

        // After release, no further fires.
        await vi.advanceTimersByTimeAsync(500);
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("startRepeat should be a no-op when the button is no longer held", () => {
      // Direct guard test: same class of race as the fuel-service stuck bug.
      // Even though replay-control's executeMode is currently sync (SDK broadcast),
      // the guard keeps us safe if executeMode ever gains an async path.
      (action as any).heldButtons.add("action-1");
      (action as any).heldButtons.delete("action-1");

      (action as any).startRepeat("action-1", {
        mode: "fast-forward",
        speed: "1",
        flagsOverlay: false,
        addedWithVersion: "0.0.0",
      });

      expect((action as any).repeatTimers.has("action-1")).toBe(false);
    });

    it("should stop the repeat loop immediately when onDidReceiveSettings fires mid-hold", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "fast-forward" }) as any);
        expect((action as any).repeatTimers.has("action-1")).toBe(true);

        // Settings update mid-hold should clear both heldButtons and timers.
        await vi.advanceTimersByTimeAsync(200);
        await action.onDidReceiveSettings(fakeEvent("action-1", { mode: "fast-forward" }) as any);

        expect((action as any).heldButtons.has("action-1")).toBe(false);
        expect((action as any).repeatTimers.has("action-1")).toBe(false);

        // No further fires after the mid-hold settings update.
        const callsBefore = mockReplay.setPlaySpeed.mock.calls.length;
        await vi.advanceTimersByTimeAsync(20_000);
        expect(mockReplay.setPlaySpeed.mock.calls.length).toBe(callsBefore);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("jump-to-live and the controller's replay grace (#1230, #1324)", () => {
    const mockReplay = { goToEnd: vi.fn(() => true) };
    /** A replay at frame 4 000; `ReplayFrameNumEnd` is the frames left. */
    const REPLAY = { IsReplayPlaying: true, ReplayFrameNum: 4_000, ReplayFrameNumEnd: 90_000 } as TelemetryData;
    /** What telemetry reads in the post-seek blip, and from the car. */
    const NOT_PLAYING = { IsReplayPlaying: false, ReplayFrameNum: 0, ReplayFrameNumEnd: 90_000 } as TelemetryData;
    let action: ReplayControl;
    let t0: number;

    function fakeEvent(settings: Record<string, unknown>) {
      return { action: { id: "ctx-live", setTitle: vi.fn(), setImage: vi.fn() }, payload: { settings } };
    }

    function inSession(simMode: string): void {
      action["sdkController"].getSessionInfo = vi.fn(() => ({ WeekendInfo: { SimMode: simMode } }) as any);
    }

    /** The replay tick before the press, then the state a blip tick reads 50 ms after it. */
    async function pressJumpToLive(): Promise<{ inReplay: boolean; frame: number | null }> {
      const sdk = action["sdkController"];

      sdk.getCurrentTelemetry = vi.fn(() => REPLAY);
      sdk.getReplayState(t0);
      await action.onKeyDown(fakeEvent({ mode: "jump-to-live" }) as any);
      sdk.getCurrentTelemetry = vi.fn(() => NOT_PLAYING);

      return sdk.getReplayState(t0 + 50);
    }

    beforeEach(async () => {
      vi.clearAllMocks();
      _resetReplayCursor();
      mockReplay.goToEnd.mockReturnValue(true);
      const { getCommands } = await import("@iracedeck/deck-iracing");
      vi.mocked(getCommands).mockReturnValue({ replay: mockReplay, camera: { switchNum: vi.fn() } } as any);
      action = new ReplayControl();
      vi.spyOn(action["sdkController"], "noteReplayLeftForLive");
      t0 = Date.now();
    });

    it("a jump to live in a live session leaves the replay for the car: no grace follows", async () => {
      inSession("full");

      expect(await pressJumpToLive()).toMatchObject({ inReplay: false, frame: 90_000 });
      expect(mockReplay.goToEnd).toHaveBeenCalledOnce();
      expect(action["sdkController"].noteReplayLeftForLive).toHaveBeenCalledOnce();
    });

    it("a jump to live that was not sent tells the controller nothing: the grace stands", async () => {
      inSession("full");
      mockReplay.goToEnd.mockReturnValue(false);

      expect(await pressJumpToLive()).toMatchObject({ inReplay: true, frame: 4_000 });
      expect(action["sdkController"].noteReplayLeftForLive).not.toHaveBeenCalled();
    });

    it("in a saved replay the jump only seeks to the end of the file: the grace stands", async () => {
      inSession("replay");

      expect(await pressJumpToLive()).toMatchObject({ inReplay: true, frame: 4_000 });
      expect(mockReplay.goToEnd).toHaveBeenCalledOnce();
      // The action tells the controller every sent goToEnd; the saved-replay rule is the SDK's.
      expect(action["sdkController"].noteReplayLeftForLive).toHaveBeenCalledOnce();
    });
  });

  // The replay command gate (#1430): every key of this action sends through it,
  // so a key pressed while a position jump is under way sends nothing but a
  // position jump into it, and a command that waits goes out on the read-back.
  // Against the gate's fake iRacing replay, which counts a command sent into a
  // jump or into a search on its way as thrown.
  describe("a key pressed while a replay jump is under way (#1430)", () => {
    /** Where every jump under way here is going: about 1.6 s of seeking from the frame the replay starts on. */
    const TARGET = 300_000;
    /** Where Jump to Fastest Lap's record says the lap starts: its jump goes one second before it. */
    const LAP_START = TARGET + 60;
    /** How far the fake's Next Lap search goes. */
    const LAP_FRAMES = 3_000;
    const MY_CAR = 9;

    let action: ReplayControl;
    let sim: FakeReplay;
    const camera = { switchNum: vi.fn<(carNum: number, group: number, cam: number) => boolean>(() => true) };

    function fakeEvent(actionId: string, settings: Record<string, unknown>) {
      return {
        action: { id: actionId, isDial: () => false, setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings },
      };
    }

    /** A tap: down and straight up, so a mode with a long-press repeat sends once. */
    async function pressKey(contextId: string, mode: string): Promise<void> {
      await action.onWillAppear(fakeEvent(contextId, { mode }) as any);
      await action.onKeyDown(fakeEvent(contextId, { mode }) as any);
      await action.onKeyUp(fakeEvent(contextId, { mode }) as any);
    }

    /** The three jumps a key can meet under way. Each sends its seek at once, from a paused replay. */
    const JUMPS_UNDER_WAY: [string, () => void][] = [
      [
        "a marker jump",
        () => {
          const jump = beginReplayJump("replay-markers next", sim.telemetry(), undefined, Date.now(), {
            origin: "ctx-marker",
            frame: TARGET,
          });

          void runReplayJump(jump, { frame: TARGET, readTelemetry: () => sim.telemetry() }).finally(() => jump.end());
        },
      ],
      [
        "a fastest-lap record jump",
        () => {
          void jumpToRecordedLapStart("ctx-fastest", {
            carIdx: 4,
            carNum: 4,
            lap: 3,
            frame: LAP_START,
            timeMs: null,
          });
        },
      ],
      [
        "a dial jump",
        () => {
          pressReplayCommand({ kind: "jump", frame: TARGET }, { by: "dial-frame-jog", origin: "ctx-dial" });
        },
      ],
    ];

    /** The frame each jump under way is going to: a record jump lands one second before its lap start. */
    function targetOf(name: string): number {
      return name === "a fastest-lap record jump" ? LAP_START - 60 : TARGET;
    }

    beforeEach(async () => {
      vi.useFakeTimers();
      sim = fakeReplay({ frame: 100_000, searches: { nextLap: (from) => from + LAP_FRAMES } });

      const { getCommands } = await import("@iracedeck/deck-iracing");

      vi.mocked(getCommands).mockReturnValue({ replay: sim.replay, camera } as any);
      vi.mocked(getCarNumberRawFromSessionInfo).mockImplementation((_si: unknown, idx: number) => idx);
      vi.mocked(getGlobalSettings).mockReturnValue({
        fastestLapSearchDelayMs: 400,
        replayJumpPlayback: "remember",
      } as ReturnType<typeof getGlobalSettings>);
      camera.switchNum.mockReset();
      camera.switchNum.mockImplementation(() => true);
      _resetReplayCursor();
      action = new ReplayControl();
      action["sdkController"].getCurrentTelemetry = vi.fn(() => sim.telemetry());
      action["sdkController"].getSessionInfo = vi.fn(() => ({ DriverInfo: { DriverCarIdx: MY_CAR } }) as any);
      // Over this action's controller and logger: the record jump is the engine's (#1467) and logs where the action did.
      configureEngine({
        ...engineOverAction(action),
        replay: () => sim.replay,
        readTelemetry: () => sim.telemetry(),
        inReplay: () => true,
      });
    });

    afterEach(() => {
      vi.mocked(getGlobalSettings).mockReturnValue({ fastestLapSearchDelayMs: 400 } as ReturnType<
        typeof getGlobalSettings
      >);
      vi.useRealTimers();
    });

    /** The commands sent from `from` on, by name. */
    const callsFrom = (from: number): string[] => sim.calls.slice(from).map((call) => call.split(" ")[0]);

    describe.each(JUMPS_UNDER_WAY)("with %s under way", (name, startJump) => {
      const target = targetOf(name);

      /** Starts the jump, lets it get going, and returns where the commands it sent end. */
      async function jumpUnderWay(): Promise<number> {
        startJump();
        await vi.advanceTimersByTimeAsync(100);

        expect(sim.busy()).toBe(true);

        return sim.calls.length;
      }

      it("Play / Pause waits for the landing, then plays from the target", async () => {
        const from = await jumpUnderWay();

        await pressKey("ctx-play", "play-pause");

        expect(callsFrom(from)).toEqual([]);

        await vi.advanceTimersByTimeAsync(5_000);

        expect(callsFrom(from)).toEqual(["play"]);
        expect(sim.thrown).toBe(0);
        expect(sim.speed()).toEqual({ speed: 1, slowMotion: false });
        expect(sim.frame()).toBeGreaterThanOrEqual(target);
      });

      it("a speed mode waits for the landing, then sets its speed there", async () => {
        const from = await jumpUnderWay();

        await pressKey("ctx-ff", "fast-forward");

        expect(callsFrom(from)).toEqual([]);

        await vi.advanceTimersByTimeAsync(5_000);

        expect(sim.calls.slice(from)).toEqual(["setPlaySpeed 2 false"]);
        expect(sim.thrown).toBe(0);
        expect(sim.speed()).toEqual({ speed: 2, slowMotion: false });
      });

      it("a frame step becomes a position jump one frame on from the target", async () => {
        const from = await jumpUnderWay();

        await pressKey("ctx-step", "frame-forward");

        expect(callsFrom(from)).toEqual(["setPlayPosition"]);

        await vi.advanceTimersByTimeAsync(5_000);

        expect(callsFrom(from)).toEqual(["setPlayPosition"]);
        expect(sim.thrown).toBe(0);
        expect(sim.frame()).toBe(target + 1);
        expect(sim.speed()).toEqual({ speed: 0, slowMotion: false });
      });

      it("the long-press repeat of a frame step sends nothing but position jumps into it", async () => {
        const from = await jumpUnderWay();

        await action.onWillAppear(fakeEvent("ctx-step", { mode: "frame-forward" }) as any);
        await action.onKeyDown(fakeEvent("ctx-step", { mode: "frame-forward" }) as any);
        // The first step, then the repeat from half a second on.
        await vi.advanceTimersByTimeAsync(1_100);
        await action.onKeyUp(fakeEvent("ctx-step", { mode: "frame-forward" }) as any);

        const steps = vi
          .mocked(action["logger"].info)
          .mock.calls.filter(([line]) => line === "Frame forward executed").length;

        expect(steps).toBeGreaterThan(1);
        // The first step met the seek under way and went out as a position
        // jump one frame on from its target. That retarget lands at once, and
        // the steps after it meet a quiet replay, where a real frame step goes.
        expect(callsFrom(from)[0]).toBe("setPlayPosition");
        expect(callsFrom(from).every((call) => call === "setPlayPosition" || call === "nextFrame")).toBe(true);

        await vi.advanceTimersByTimeAsync(5_000);

        expect(sim.thrown).toBe(0);
        expect(sim.frame()).toBe(target + steps);
      });

      it("a search waits for the landing to hold, then searches from the target", async () => {
        const from = await jumpUnderWay();

        await pressKey("ctx-lap", "next-lap");

        expect(callsFrom(from)).toEqual([]);

        await vi.advanceTimersByTimeAsync(5_000);

        expect(callsFrom(from)[0]).toBe("nextLap");
        expect(sim.thrown).toBe(0);
        expect(sim.frame()).toBe(target + LAP_FRAMES);
      });
    });

    describe("Jump to Fastest Lap's record jump and its camera switch", () => {
      it("with a Play held behind it, the camera still switches after the landing", async () => {
        const busyAtSwitch: boolean[] = [];

        camera.switchNum.mockImplementation(() => {
          busyAtSwitch.push(sim.busy());

          return true;
        });
        void jumpToRecordedLapStart("ctx-fastest", {
          carIdx: 4,
          carNum: 4,
          lap: 3,
          frame: LAP_START,
          timeMs: null,
        });
        await vi.advanceTimersByTimeAsync(100);
        await pressKey("ctx-play", "play-pause");

        expect(action["logger"].info).toHaveBeenCalledWith("Jump to fastest lap: jump cancelled by play-pause");
        expect(camera.switchNum).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(5_000);

        expect(camera.switchNum).toHaveBeenCalledExactlyOnceWith(4, 0, 0);
        expect(busyAtSwitch).toEqual([false]);
        expect(sim.calls.filter((call) => call === "play")).toHaveLength(1);
        expect(sim.thrown).toBe(0);
        expect(sim.frame()).toBeGreaterThanOrEqual(LAP_START - 60);
      });

      it("with a car key pressed during it, the jump keeps its claim and the key's switch follows its own: the driver's camera choice is the newer one", async () => {
        const busyAtSwitch: boolean[] = [];

        camera.switchNum.mockImplementation(() => {
          busyAtSwitch.push(sim.busy());

          return true;
        });
        void jumpToRecordedLapStart("ctx-fastest", {
          carIdx: 4,
          carNum: 4,
          lap: 3,
          frame: LAP_START,
          timeMs: null,
        });
        await vi.advanceTimersByTimeAsync(100);
        await pressKey("ctx-car", "jump-to-my-car");

        // A camera key cancels only a lap walk (#1467): the record jump is not one.
        expect(action["logger"].info).not.toHaveBeenCalledWith(expect.stringContaining("jump cancelled by"));
        expect(camera.switchNum).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(5_000);

        expect(camera.switchNum.mock.calls).toEqual([
          [4, 0, 0],
          [MY_CAR, 0, 0],
        ]);
        expect(busyAtSwitch).toEqual([false, false]);
        expect(sim.frame()).toBe(LAP_START - 60);
        expect(sim.thrown).toBe(0);
      });
    });

    describe("a camera key (#1467): it waits behind the jump, and interrupts only a lap walk", () => {
      /** A dial jump to {@link TARGET}, under way: the seek showing. */
      async function dialJumpUnderWay(): Promise<void> {
        pressReplayCommand({ kind: "jump", frame: TARGET }, { by: "dial-frame-jog", origin: "ctx-dial" });
        await vi.advanceTimersByTimeAsync(100);

        expect(sim.busy()).toBe(true);
      }

      /** Cars by number for the car-number keys: #4 (carIdx 0), #7 (carIdx 1), #42 (carIdx 2). */
      function carsByNumber(): void {
        vi.mocked(getAllCarNumbers).mockReturnValue([
          { carIdx: 0, carNumber: "4", carNumberRaw: 4, userName: "a" },
          { carIdx: 1, carNumber: "7", carNumberRaw: 7, userName: "b" },
          { carIdx: 2, carNumber: "42", carNumberRaw: 42, userName: "c" },
        ]);
        onTestFinished(() => {
          vi.mocked(getAllCarNumbers).mockReset();
        });
      }

      it.each<[string, () => void]>([
        ["jump-to-my-car", () => expect(camera.switchNum).toHaveBeenCalledExactlyOnceWith(MY_CAR, 0, 0)],
        ["next-car", () => expect(action["tapBinding"]).toHaveBeenCalledExactlyOnceWith("replayControlNextCar")],
        ["prev-car", () => expect(action["tapBinding"]).toHaveBeenCalledExactlyOnceWith("replayControlPrevCar")],
        // The camera is on car 2 (#42) when the switch goes out, not on car 1 (#7) as at the press: #42 to #4.
        ["next-car-number", () => expect(camera.switchNum).toHaveBeenCalledExactlyOnceWith(4, 0, 0)],
      ])("a camera key pressed during a jump is parked and sent after the jump lands: %s", async (mode, sent) => {
        carsByNumber();
        let camCarIdx = 1;

        action["sdkController"].getCurrentTelemetry = vi.fn(
          () => ({ ...sim.telemetry(), CamCarIdx: camCarIdx }) as TelemetryData,
        );
        await dialJumpUnderWay();

        await pressKey("ctx-cam", mode);
        await vi.advanceTimersByTimeAsync(200);

        expect(camera.switchNum).not.toHaveBeenCalled();
        expect(action["tapBinding"]).not.toHaveBeenCalled();

        camCarIdx = 2;
        await vi.advanceTimersByTimeAsync(5_000);

        expect(sim.busy()).toBe(false);
        expect(sim.frame()).toBe(TARGET);
        sent();
        expect(sim.thrown).toBe(0);
      });

      it("a camera key's parked switch is dropped when the jump's wait gives up", async () => {
        // A jump that seeks for longer than any jump is waited for.
        sim = fakeReplay({ frame: 100_000, minSeekMs: 200_000 });
        configureEngine({
          ...engineOverAction(action),
          replay: () => sim.replay,
          readTelemetry: () => sim.telemetry(),
          inReplay: () => true,
        });

        const { getCommands } = await import("@iracedeck/deck-iracing");

        vi.mocked(getCommands).mockReturnValue({ replay: sim.replay, camera } as never);
        await dialJumpUnderWay();

        await pressKey("ctx-cam", "jump-to-my-car");
        await vi.advanceTimersByTimeAsync(125_000);
        // The jump lands at last; the switch was dropped at the wait's ceiling.
        await vi.advanceTimersByTimeAsync(80_000);

        expect(sim.frame()).toBe(TARGET);
        expect(camera.switchNum).not.toHaveBeenCalled();
      });

      it("a parked key switch is dropped when its key leaves the screen", async () => {
        await dialJumpUnderWay();

        await pressKey("ctx-cam", "jump-to-my-car");
        await action.onWillDisappear(fakeEvent("ctx-cam", { mode: "jump-to-my-car" }) as any);
        await vi.advanceTimersByTimeAsync(5_000);

        expect(sim.frame()).toBe(TARGET);
        expect(camera.switchNum).not.toHaveBeenCalled();
        expect(action["logger"].debug).toHaveBeenCalledWith(
          "Replay control: tap dropped (my car), the key left the screen or the replay was left while it waited",
        );
      });

      it("a parked key switch is dropped when the replay is left before the landing", async () => {
        await dialJumpUnderWay();

        await pressKey("ctx-cam", "next-car");
        // The controller's debounced replay state reads the replay left (a disconnect reads the same).
        const replayState = action["sdkController"].getReplayState();

        vi.spyOn(action["sdkController"], "getReplayState").mockReturnValue({ ...replayState, inReplay: false });
        await vi.advanceTimersByTimeAsync(5_000);

        expect(sim.frame()).toBe(TARGET);
        expect(action["tapBinding"]).not.toHaveBeenCalled();
      });

      it("a camera key does not cancel a marker jump's claim", async () => {
        const claim = claimReplayCursor("replay-markers next");

        await pressKey("ctx-cam", "next-car");

        expect(claim.cancelledBy).toBeNull();
        expect(action["tapBinding"]).toHaveBeenCalledExactlyOnceWith("replayControlNextCar");
        claim.release();
      });

      it.each(["jump-to-my-car", "next-car", "prev-car", "next-car-number", "prev-car-number"])(
        "a camera key interrupts a running lap walk without taking its cursor (#1428 / #1435): %s",
        async (mode) => {
          const walk = claimReplayCursor(FASTEST_LAP_WALK_OWNER);

          await pressKey("ctx-cam", mode);

          expect(walk.interruptedBy).toBe(mode);
          expect(walk.cancelledBy).toBeNull();
        },
      );
    });
  });

  describe("Next / Previous Lap and Session step through the record (#1426)", () => {
    /** The car the camera is on at the press, and the number the session info gives it. */
    const CAM_CAR = 4;
    const SUB_SESSION = 4_242;
    /** Where the replay stands at the press. */
    const START = 100_000;
    /** The camera car's recorded lap starts: each lands 60 frames before its line. */
    const LAP_STARTS = [50_000, 103_000, 106_000, 109_000];
    /** Laps 1, 2, 3 … of the race session at `frames`, back to back in the record. */
    const lapEntries = (frames: number[]) =>
      frames.map((frame, i) => ({ frame, lap: i + 1, sessionNum: 2, sessionUniqueId: 3 }));
    /** The recorded session starts: each lands 120 frames after it. */
    const SESSION_STARTS = [0, 60_000, 150_000];
    const PAUSED = { speed: 0, slowMotion: false };
    const NORMAL = { speed: 1, slowMotion: false };

    let action: ReplayControl;
    let sim: FakeReplay;
    let camCarIdx: number;
    const camera = { switchNum: vi.fn<(carNum: number, group: number, cam: number) => boolean>(() => true) };
    const store = {
      laps: { listLapStarts: vi.fn((): LapStartListing => ({ hit: true, starts: lapEntries(LAP_STARTS) })) },
      sessions: {
        list: vi.fn((): SessionStartListing => ({
          hit: true,
          starts: SESSION_STARTS.map((frame, i) => ({ sessionNum: i, sessionUniqueId: i + 1, frame })),
        })),
      },
      incidents: { list: vi.fn((): IncidentListing => ({ hit: true, incidents: [] })) },
    };

    function keyEvent(actionId: string, settings: Record<string, unknown>) {
      return {
        action: { id: actionId, isDial: () => false, setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings },
      };
    }

    async function pressKey(contextId: string, mode: string): Promise<void> {
      await action.onWillAppear(keyEvent(contextId, { mode }) as any);
      await action.onKeyDown(keyEvent(contextId, { mode }) as any);
      await action.onKeyUp(keyEvent(contextId, { mode }) as any);
    }

    /** The sim's telemetry with the camera car, which the fake does not carry. */
    const telemetry = (): TelemetryData => ({ ...sim.telemetry(), CamCarIdx: camCarIdx });

    /** Every frame a position jump was sent to, in order. */
    const seeks = (): number[] =>
      sim.calls.filter((call) => call.startsWith("setPlayPosition")).map((call) => Number(call.split(" ")[2]));

    /** The commands sent, a seek as "seek <frame>" and a speed as "speed <value>". */
    const commands = (): string[] =>
      sim.calls.map((call) => {
        const [name, a, b] = call.split(" ");

        if (name === "setPlayPosition") return `seek ${b}`;

        if (name === "setPlaySpeed") return `speed ${a}`;

        return name;
      });

    /** A fresh fake replay, and the engine over it and over this case's action (#1467: its jumps log where the action did). */
    function setUp(options: Parameters<typeof fakeReplay>[0] = {}): void {
      sim = fakeReplay({ frame: START, ...options });
      configureEngine({
        ...engineOverAction(action),
        replay: () => sim.replay,
        readTelemetry: telemetry,
        inReplay: () => true,
      });
    }

    beforeEach(async () => {
      vi.useFakeTimers();
      camCarIdx = CAM_CAR;

      const { getCommands } = await import("@iracedeck/deck-iracing");

      vi.mocked(getCommands).mockImplementation(() => ({ replay: sim.replay, camera }) as any);
      vi.mocked(getCarNumberRawFromSessionInfo).mockImplementation((_si: unknown, idx: number) => idx + 100);
      vi.mocked(getGlobalSettings).mockReturnValue({
        fastestLapSearchDelayMs: 400,
        replayJumpPlayback: "remember",
      } as ReturnType<typeof getGlobalSettings>);
      vi.mocked(isReplaySessionStoreInitialized).mockReturnValue(true);
      vi.mocked(getReplaySessionStore).mockReturnValue(store as any);
      store.laps.listLapStarts.mockReset().mockImplementation(() => ({ hit: true, starts: lapEntries(LAP_STARTS) }));
      store.sessions.list.mockReset().mockImplementation(() => ({
        hit: true,
        starts: SESSION_STARTS.map((frame, i) => ({ sessionNum: i, sessionUniqueId: i + 1, frame })),
      }));
      store.incidents.list.mockReset().mockImplementation(() => ({ hit: true, incidents: [] }));
      camera.switchNum.mockClear();
      _resetReplayCursor();
      action = new ReplayControl();
      action["sdkController"].getCurrentTelemetry = vi.fn(() => telemetry());
      action["sdkController"].getSessionInfo = vi.fn(
        () => ({ WeekendInfo: { SubSessionID: SUB_SESSION }, DriverInfo: { DriverCarIdx: 9 } }) as any,
      );
      setUp();
    });

    afterEach(() => {
      vi.mocked(getGlobalSettings).mockReturnValue({ fastestLapSearchDelayMs: 400 } as ReturnType<
        typeof getGlobalSettings
      >);
      vi.mocked(isReplaySessionStoreInitialized).mockReturnValue(false);
      vi.useRealTimers();
    });

    /** Uses `playback` for the Replay jump playback setting. */
    function setPlayback(playback: string): void {
      vi.mocked(getGlobalSettings).mockReturnValue({
        fastestLapSearchDelayMs: 400,
        replayJumpPlayback: playback,
      } as ReturnType<typeof getGlobalSettings>);
    }

    describe("a hit is one waited jump to the landing frame, with no camera switch", () => {
      it.each<[string, number, string]>([
        ["next-lap", 103_000 - 60, "a lap start minus 60"],
        ["prev-lap", 50_000 - 60, "a lap start minus 60"],
        ["next-session", 150_000 + 120, "a session start plus 120"],
        ["prev-session", 60_000 + 120, "a session start plus 120"],
      ])("%s lands on %i, %s", async (mode, landing) => {
        await pressKey("ctx-key", mode);
        await vi.advanceTimersByTimeAsync(5_000);

        expect(seeks()).toEqual([landing]);
        expect(commands()).toEqual([`seek ${landing}`]);
        expect(sim.frame()).toBe(landing);
        expect(sim.thrown).toBe(0);
        expect(camera.switchNum).not.toHaveBeenCalled();
        expect(pendingReplayTarget()).toBeNull();
      });

      it("a lap step lists the camera car's starts, verified by its number, in this session's record", async () => {
        await pressKey("ctx-key", "next-lap");

        expect(store.laps.listLapStarts).toHaveBeenCalledExactlyOnceWith({
          carIdx: CAM_CAR,
          carNumberRaw: CAM_CAR + 100,
          subSessionId: SUB_SESSION,
        });
        expect(action["logger"].debug).toHaveBeenCalledWith(
          `Next lap: record HIT (4 lap starts of carIdx ${CAM_CAR}); from cursor frame ${START} to ${103_000 - 60}`,
        );
      });

      it("a session step lists the record's session starts", async () => {
        await pressKey("ctx-key", "prev-session");

        expect(store.sessions.list).toHaveBeenCalledExactlyOnceWith({ subSessionId: SUB_SESSION });
        expect(store.laps.listLapStarts).not.toHaveBeenCalled();
      });

      it.each<[string, string, number[] | null]>([
        ["lists sessions 0-2", "seek 150120", [0, 1, 2]],
        ["lists no sessions", "nextSession", null],
      ])(
        "a session step reads the event's last session from the session info: when it %s, R2 -> P0' sends %s",
        async (_label, expected, listed) => {
          // The race (session 2), then the restarted event's practice under a new unique id.
          store.sessions.list.mockImplementation(() => ({
            hit: true,
            starts: [
              { sessionNum: 2, sessionUniqueId: 1, frame: 60_000 },
              { sessionNum: 0, sessionUniqueId: 2, frame: 150_000 },
            ],
          }));
          action["sdkController"].getSessionInfo = vi.fn(
            () =>
              ({
                WeekendInfo: { SubSessionID: SUB_SESSION },
                ...(listed === null ? {} : { SessionInfo: { Sessions: listed.map((n) => ({ SessionNum: n })) } }),
              }) as any,
          );

          await pressKey("ctx-key", "next-session");
          await vi.advanceTimersByTimeAsync(5_000);

          expect(commands()).toEqual([expected]);
        },
      );
    });

    it("a second press during a jump steps from the standing target", async () => {
      setUp({ minSeekMs: 400 });

      await pressKey("ctx-key", "next-lap");
      await vi.advanceTimersByTimeAsync(100);

      expect(sim.busy()).toBe(true);
      expect(pendingReplayTarget()).toMatchObject({ frame: 102_940 });

      await pressKey("ctx-key", "next-lap");
      await vi.advanceTimersByTimeAsync(5_000);

      expect(seeks()).toEqual([102_940, 105_940]);
      expect(sim.frame()).toBe(105_940);
      expect(sim.thrown).toBe(0);
    });

    it("a jump that stops short drops its target, so the next press steps from the cursor", async () => {
      // The jump rests short of its frame, as one iRacing could not reach.
      setUp({ unlandable: new Set([102_940]), unlandableRest: 101_000 });

      await pressKey("ctx-key", "next-lap");
      await vi.advanceTimersByTimeAsync(10_000);

      expect(sim.frame()).toBe(101_000);
      expect(pendingReplayTarget()).toBeNull();
      expect(action["logger"].warn).toHaveBeenCalledWith("Next lap: jump did not land; nothing more sent");

      await pressKey("ctx-key", "next-lap");

      // From 101000, not from the dropped 102940: the same lap start again.
      expect(seeks()).toEqual([102_940, 102_940]);
    });

    describe("a miss sends the sim's search once, through the gate, and nothing else", () => {
      type MissCase = [string, string, string, () => void];

      const LAP_MISSES: MissCase[] = [
        ["next-lap", "nextLap", "no store", () => vi.mocked(isReplaySessionStoreInitialized).mockReturnValue(false)],
        ...(["no file", "no car", "car mismatch", "newer format"] as const).map((reason): MissCase => [
          "prev-lap",
          "prevLap",
          reason,
          () => store.laps.listLapStarts.mockImplementation(() => ({ hit: false, reason })),
        ]),
        ["next-lap", "nextLap", "no car on camera (CamCarIdx 255)", () => (camCarIdx = 255)],
        ["prev-lap", "prevLap", "no car on camera (CamCarIdx -1)", () => (camCarIdx = -1)],
        [
          "next-lap",
          "nextLap",
          "no car number for carIdx 4",
          () => vi.mocked(getCarNumberRawFromSessionInfo).mockImplementation(() => null),
        ],
        [
          "next-lap",
          "nextLap",
          "nothing that way",
          // The cursor is at the last recorded lap's landing.
          () =>
            store.laps.listLapStarts.mockImplementation(() => ({
              hit: true,
              starts: lapEntries([50_000, 100_030]),
            })),
        ],
        [
          "prev-lap",
          "prevLap",
          "nothing that way",
          // The cursor is just past the first recorded lap's start.
          () =>
            store.laps.listLapStarts.mockImplementation(() => ({
              hit: true,
              starts: lapEntries([99_950, 103_000]),
            })),
        ],
        [
          "next-lap",
          "nextLap",
          "outside the record",
          // Past the last recorded lap start: the laps after it may not be recorded.
          () =>
            store.laps.listLapStarts.mockImplementation(() => ({
              hit: true,
              starts: lapEntries([50_000, 99_000]),
            })),
        ],
        [
          "prev-lap",
          "prevLap",
          "outside the record",
          () => store.laps.listLapStarts.mockImplementation(() => ({ hit: true, starts: [] })),
        ],
        [
          "next-lap",
          "nextLap",
          "gap in the record",
          // Laps 1-2 then 9-10: the driver was in the garage between.
          () =>
            store.laps.listLapStarts.mockImplementation(() => ({
              hit: true,
              starts: [
                { frame: 90_000, lap: 1, sessionNum: 2, sessionUniqueId: 3 },
                { frame: 100_030, lap: 2, sessionNum: 2, sessionUniqueId: 3 },
                { frame: 140_000, lap: 9, sessionNum: 2, sessionUniqueId: 3 },
                { frame: 146_000, lap: 10, sessionNum: 2, sessionUniqueId: 3 },
              ],
            })),
        ],
      ];
      const SESSION_MISSES: MissCase[] = [
        [
          "prev-session",
          "prevSession",
          "no store",
          () => vi.mocked(isReplaySessionStoreInitialized).mockReturnValue(false),
        ],
        ...(["no file", "newer format"] as const).map((reason): MissCase => [
          "next-session",
          "nextSession",
          reason,
          () => store.sessions.list.mockImplementation(() => ({ hit: false, reason })),
        ]),
        [
          "next-session",
          "nextSession",
          "nothing that way",
          () =>
            store.sessions.list.mockImplementation(() => ({
              hit: true,
              starts: [{ sessionNum: 0, sessionUniqueId: 1, frame: 0 }],
            })),
        ],
        [
          "next-session",
          "nextSession",
          "outside the record",
          // Sessions 0 and 2: the plugin never saw session 1, which the cursor may be in.
          () =>
            store.sessions.list.mockImplementation(() => ({
              hit: true,
              starts: [
                { sessionNum: 0, sessionUniqueId: 1, frame: 0 },
                { sessionNum: 2, sessionUniqueId: 1, frame: 150_000 },
              ],
            })),
        ],
      ];

      it.each([...LAP_MISSES, ...SESSION_MISSES])("%s on %s: %s", async (mode, search, reason, arrange) => {
        arrange();

        await pressKey("ctx-key", mode);

        expect(sim.calls).toEqual([search]);
        expect(action["logger"].debug).toHaveBeenCalledWith(
          expect.stringMatching(
            new RegExp(`^(Next|Previous) (lap|session): record MISS \\(${reason.replace(/[()]/g, "\\$&")}\\)$`),
          ),
        );

        await vi.advanceTimersByTimeAsync(5_000);

        expect(sim.calls).toEqual([search]);
        expect(camera.switchNum).not.toHaveBeenCalled();
      });
    });

    it("a miss pressed during a record jump sends nothing into it: the gate holds it until the landing", async () => {
      setUp({ minSeekMs: 400 });
      store.sessions.list.mockImplementation(() => ({ hit: false, reason: "no file" }));

      await pressKey("ctx-lap", "next-lap");
      await vi.advanceTimersByTimeAsync(100);

      const from = sim.calls.length;

      await pressKey("ctx-session", "next-session");

      expect(sim.calls.slice(from)).toEqual([]);

      await vi.advanceTimersByTimeAsync(5_000);

      expect(sim.calls.slice(from)).toEqual(["nextSession"]);
      expect(sim.thrown).toBe(0);
    });

    it.each(["next-lap", "prev-lap", "next-session", "prev-session"])(
      "%s outside a replay sends nothing",
      async (mode) => {
        sim.leave();

        await pressKey("ctx-key", mode);
        await vi.advanceTimersByTimeAsync(5_000);

        expect(sim.calls).toEqual([]);
        expect(store.laps.listLapStarts).not.toHaveBeenCalled();
        expect(store.sessions.list).not.toHaveBeenCalled();
        expect(action["logger"].debug).toHaveBeenCalledWith(expect.stringMatching(/: not in a replay; nothing sent$/));
      },
    );

    it.each<[string, string]>([
      ["next-lap", "nextLap"],
      ["prev-lap", "prevLap"],
      ["next-session", "nextSession"],
      ["prev-session", "prevSession"],
    ])("%s with no cursor to step from sends the key's search through the gate", async (mode, search) => {
      // A saved replay whose tick still reads mid-seek once the exit grace is over, with no target standing.
      action["sdkController"].getReplayState = vi.fn(() => ({
        inReplay: true,
        frame: 0,
        tickReplayPlaying: false,
        replaySeenAt: null,
      })) as any;

      await pressKey("ctx-key", mode);

      expect(sim.calls).toEqual([search]);
      expect(store.laps.listLapStarts).not.toHaveBeenCalled();
      expect(store.sessions.list).not.toHaveBeenCalled();
      expect(action["logger"].debug).toHaveBeenCalledWith(
        expect.stringMatching(/^(Next|Previous) (lap|session): record MISS \(no cursor\)$/),
      );

      await vi.advanceTimersByTimeAsync(5_000);

      expect(sim.calls).toEqual([search]);
    });

    describe("the playback step after a hit follows the Replay jump playback setting", () => {
      it.each<[string, { speed: number; slowMotion: boolean }, string[], { speed: number; slowMotion: boolean }]>([
        ["remember", PAUSED, ["seek 102940"], PAUSED],
        ["play", PAUSED, ["seek 102940", "speed 1"], NORMAL],
        ["stopped", PAUSED, ["seek 102940"], PAUSED],
        ["remember", NORMAL, ["speed 0", "seek 102940", "speed 1"], NORMAL],
        ["play", NORMAL, ["speed 0", "seek 102940", "speed 1"], NORMAL],
        ["stopped", NORMAL, ["speed 0", "seek 102940"], PAUSED],
      ])("%s, from a replay at %o", async (playback, before, sent, after) => {
        setUp({ speed: before });
        setPlayback(playback);

        await pressKey("ctx-key", "next-lap");
        await vi.advanceTimersByTimeAsync(5_000);

        expect(commands()).toEqual(sent);
        expect(sim.speed()).toEqual(after);
        expect(shownSpeed(action).speed).toBe(after.speed);
        expect(sim.thrown).toBe(0);
      });
    });

    describe("each press carries its key's origin token", () => {
      let notices: ReplayGateNotice[];

      beforeEach(() => {
        notices = [];
        onTestFinished(subscribeReplayGate((notice) => notices.push(notice)));
      });

      it("the jump on a hit", async () => {
        setUp({ minSeekMs: 400 });

        await pressKey("ctx-lap", "next-lap");

        expect(getReplayGateView("ctx-lap").underWay).not.toBeNull();

        await vi.advanceTimersByTimeAsync(5_000);

        expect(notices.length).toBeGreaterThan(0);
        expect(new Set(notices.map((notice) => notice.origin))).toEqual(new Set(["ctx-lap"]));
        expect(getReplayGateView("ctx-lap").underWay).toBeNull();
      });

      it("the search on a miss", async () => {
        setUp({ searches: { nextSession: (from) => from + 2_000 } });
        store.sessions.list.mockImplementation(() => ({ hit: false, reason: "no file" }));

        await pressKey("ctx-session", "next-session");

        expect(getReplayGateView("ctx-session").underWay).not.toBeNull();
        expect(new Set(notices.map((notice) => notice.origin))).toEqual(new Set(["ctx-session"]));
      });
    });

    describe("the incident comparison", () => {
      const INCIDENTS = [
        {
          frame: 90_000,
          carIdx: 2,
          carNumberRaw: 102,
          sessionNum: 0,
          sessionUniqueId: 1,
          delta: 1,
          source: "telemetry",
          sessionTimeMs: 1_500_000,
        },
        {
          frame: 104_500,
          carIdx: 7,
          carNumberRaw: 107,
          sessionNum: 0,
          sessionUniqueId: 1,
          delta: 4,
          source: "sessionInfo",
          sessionTimeMs: 1_741_000,
        },
      ];

      it("logs a landing against the nearest recorded incident, sends nothing and carries no token of its own", async () => {
        const notices: ReplayGateNotice[] = [];

        onTestFinished(subscribeReplayGate((notice) => notices.push(notice)));
        // The search moves the camera to the car involved.
        setUp({
          searches: {
            nextIncident: (from) => {
              camCarIdx = 7;

              return from + 5_000;
            },
          },
        });
        store.incidents.list.mockImplementation(() => ({ hit: true, incidents: INCIDENTS }));

        await pressKey("ctx-inc", "next-incident");
        await vi.advanceTimersByTimeAsync(2_000);

        expect(action["logger"].debug).toHaveBeenCalledWith(
          `Next incident comparison: press frame=${START} camCar=${CAM_CAR}; landed frame=105000 camCar=7; ` +
            "nearest recorded incident frame=104500 carIdx=7 delta=4 source=sessionInfo; " +
            "difference=500 frames (441 after the 59-frame lag)",
        );
        expect(store.incidents.list).toHaveBeenCalledWith({ subSessionId: SUB_SESSION });
        // The key's search, and nothing from the observer.
        expect(sim.calls).toEqual(["nextIncident"]);
        expect(new Set(notices.map((notice) => notice.origin))).toEqual(new Set(["ctx-inc"]));
      });

      it("says so when nothing is recorded", async () => {
        setUp({ searches: { prevIncident: (from) => from - 3_000 } });
        store.incidents.list.mockImplementation(() => ({ hit: false, reason: "no file" }));

        await pressKey("ctx-inc", "prev-incident");
        await vi.advanceTimersByTimeAsync(2_000);

        expect(action["logger"].debug).toHaveBeenCalledWith(
          `Previous incident comparison: press frame=${START} camCar=${CAM_CAR}; landed frame=97000 camCar=${CAM_CAR}; no recorded incident (no file)`,
        );
      });

      it("logs a search that did not land, with nothing compared", async () => {
        // A search with nothing to find, on a paused replay: only the time it could run tells.
        await pressKey("ctx-inc", "next-incident");
        await vi.advanceTimersByTimeAsync(60_000);

        expect(action["logger"].debug).toHaveBeenCalledWith(
          `Next incident comparison: search not-landed; press frame=${START} camCar=${CAM_CAR}; nothing compared`,
        );
        expect(store.incidents.list).not.toHaveBeenCalled();
        expect(sim.calls).toEqual(["nextIncident"]);
      });

      it("a press the gate held compares nothing", async () => {
        setUp({ minSeekMs: 400 });

        await pressKey("ctx-lap", "next-lap");
        await vi.advanceTimersByTimeAsync(100);
        await pressKey("ctx-inc", "next-incident");

        expect(action["logger"].debug).toHaveBeenCalledWith(
          expect.stringMatching(/^Next incident comparison: search held; press frame=\d+ camCar=4; nothing compared$/),
        );

        await vi.advanceTimersByTimeAsync(5_000);

        expect(store.incidents.list).not.toHaveBeenCalled();
      });
    });
  });

  describe("the replay busy look on a key (#1437)", () => {
    function fakeEvent(actionId: string, settings: Record<string, unknown>, isDial = false) {
      return {
        action: { id: actionId, isDial: () => isDial, setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings },
      };
    }

    let action: ReplayControl;

    async function appear(contextId: string, mode: string, isDial = false): Promise<void> {
      await action.onWillAppear(fakeEvent(contextId, { mode }, isDial) as any);
    }

    /** The mocked icon functions write a busy mark as `[busy:<kind>(:<step>)]`. */
    const decoded = (uri: string): string => decodeURIComponent(uri);

    beforeEach(() => {
      action = new ReplayControl();
    });

    describe("which keys register, and how", () => {
      const DRAWS_WORKING = [
        "next-session",
        "prev-session",
        "next-lap",
        "prev-lap",
        "next-incident",
        "prev-incident",
        "jump-to-beginning",
        "jump-to-live",
        "jump-to-fastest-lap",
        "jump-to-race-start",
      ];
      const NO_WORKING = [
        "play-pause",
        "play-backward",
        "stop",
        "fast-forward",
        "rewind",
        "slow-motion",
        "slow-motion-rewind",
        "frame-forward",
        "frame-backward",
        "speed-increase",
        "speed-decrease",
        "set-speed",
      ];
      const NOT_REGISTERED = [
        "jump-to-my-car",
        "next-car",
        "prev-car",
        "next-car-number",
        "prev-car-number",
        "speed-display",
      ];

      it.each(DRAWS_WORKING)("%s registers its context, drawing working", async (mode) => {
        await appear("ctx-1", mode);

        expect(busy.register).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ token: "ctx-1", drawsWorking: true }),
        );
      });

      it.each(NO_WORKING)("%s registers its context, drawing only waiting and not done", async (mode) => {
        await appear("ctx-1", mode);

        expect(busy.register).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ token: "ctx-1", drawsWorking: false }),
        );
      });

      it.each(NOT_REGISTERED)("%s sends no replay command and does not register", async (mode) => {
        await appear("ctx-1", mode);

        expect(busy.register).not.toHaveBeenCalled();
      });

      it("a dial does not register: its box is another surface", async () => {
        await appear("ctx-dial", "next-lap", true);

        expect(busy.register).not.toHaveBeenCalled();
      });

      it("registers before the first draw, so a key coming back shows the standing look at once", async () => {
        busy.looks.set("ctx-1", { kind: "waiting" });

        await appear("ctx-1", "next-lap");

        expect(busy.register.mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(action["setKeyImage"]).mock.invocationCallOrder[0],
        );
        expect(decoded(vi.mocked(action["setKeyImage"]).mock.calls[0][1])).toContain("[busy:waiting]");
      });

      it("unregisters on disappear", async () => {
        await appear("ctx-1", "next-lap");
        const { unregister } = busy.surfaces.get("ctx-1")!;

        await action.onWillDisappear(fakeEvent("ctx-1", { mode: "next-lap" }) as any);

        expect(unregister).toHaveBeenCalledTimes(1);
        expect(action["busyRegistrations"].has("ctx-1")).toBe(false);
      });

      it("re-registers on a mode change, the new registration in before the old one is dropped", async () => {
        await appear("ctx-1", "stop");
        const first = busy.surfaces.get("ctx-1")!;

        await action.onDidReceiveSettings(fakeEvent("ctx-1", { mode: "next-incident" }) as any);
        const second = busy.surfaces.get("ctx-1")!;

        expect(busy.register).toHaveBeenCalledTimes(2);
        expect(first.surface.drawsWorking).toBe(false);
        expect(second.surface.drawsWorking).toBe(true);
        expect(first.unregister).toHaveBeenCalledTimes(1);
        expect(busy.register.mock.invocationCallOrder[1]).toBeLessThan(first.unregister.mock.invocationCallOrder[0]);
        expect(second.unregister).not.toHaveBeenCalled();
      });

      it("unregisters on a change to a mode that sends no replay command", async () => {
        await appear("ctx-1", "next-lap");
        const { unregister } = busy.surfaces.get("ctx-1")!;

        await action.onDidReceiveSettings(fakeEvent("ctx-1", { mode: "next-car" }) as any);

        expect(busy.register).toHaveBeenCalledTimes(1);
        expect(unregister).toHaveBeenCalledTimes(1);
        expect(action["busyRegistrations"].has("ctx-1")).toBe(false);
      });

      it("leaves the indicator's logger to the composition root (#1467)", () => {
        // plugin-runtime's registerActions sets it once, before any action is constructed.
        expect(busy.setLogger).not.toHaveBeenCalled();
        expect(action["logger"].createScope).not.toHaveBeenCalledWith("ReplayBusy");
      });
    });

    describe("drawing", () => {
      it("the appear and settings draws pass the look, and the regenerate reads the look of the moment", async () => {
        busy.looks.set("ctx-1", { kind: "working", tick: 11 });
        await appear("ctx-1", "next-lap");

        expect(decoded(vi.mocked(action["setKeyImage"]).mock.calls[0][1])).toContain("[busy:working:3]");

        busy.looks.delete("ctx-1");
        const regenerate = vi.mocked(action["setRegenerateCallback"]).mock.calls.at(-1)![1] as () => string;

        expect(decoded(regenerate())).not.toContain("[busy:");

        busy.looks.set("ctx-1", { kind: "not-done" });
        await action.onDidReceiveSettings(fakeEvent("ctx-1", { mode: "next-lap" }) as any);

        expect(decoded(vi.mocked(action["setKeyImage"]).mock.calls.at(-1)![1])).toContain("[busy:not-done]");
      });

      it("the telemetry draw passes the look, and its de-duplication key changes with it", async () => {
        await appear("ctx-1", "play-pause");
        const updateKeyImage = vi.mocked(action["updateKeyImage"]);
        const settings = action["activeContexts"].get("ctx-1")!;

        await action["updateDisplayFromTelemetry"]("ctx-1", settings);
        const atRest = updateKeyImage.mock.calls.length;

        expect(action["lastState"].get("ctx-1")).toMatch(/:rest$/);

        // The same state again draws nothing.
        await action["updateDisplayFromTelemetry"]("ctx-1", settings);
        expect(updateKeyImage).toHaveBeenCalledTimes(atRest);

        // A look the key has not drawn yet is drawn, step by step.
        busy.looks.set("ctx-1", { kind: "waiting" });
        await action["updateDisplayFromTelemetry"]("ctx-1", settings);

        expect(updateKeyImage).toHaveBeenCalledTimes(atRest + 1);
        expect(decoded(updateKeyImage.mock.calls.at(-1)![1])).toContain("[busy:waiting]");
        expect(action["lastState"].get("ctx-1")).toMatch(/:waiting$/);

        busy.looks.set("ctx-1", { kind: "working", tick: 1 });
        await action["updateDisplayFromTelemetry"]("ctx-1", settings);
        busy.looks.set("ctx-1", { kind: "working", tick: 2 });
        await action["updateDisplayFromTelemetry"]("ctx-1", settings);

        expect(updateKeyImage).toHaveBeenCalledTimes(atRest + 3);
        expect(action["lastState"].get("ctx-1")).toMatch(/:working:2$/);

        const regenerate = vi.mocked(action["setRegenerateCallback"]).mock.calls.at(-1)![1] as () => string;

        busy.looks.delete("ctx-1");
        expect(decoded(regenerate())).not.toContain("[busy:");
      });

      it("the indicator's redraw composes the key from its state and sends it through updateKeyImage", async () => {
        await appear("ctx-1", "next-incident");
        const { surface } = busy.surfaces.get("ctx-1")!;
        const updateKeyImage = vi.mocked(action["updateKeyImage"]);

        updateKeyImage.mockClear();
        busy.looks.set("ctx-1", { kind: "working", tick: 10 });
        surface.redraw({ kind: "working", tick: 10 });

        expect(updateKeyImage).toHaveBeenCalledExactlyOnceWith("ctx-1", expect.any(String));
        expect(decoded(updateKeyImage.mock.calls[0][1])).toContain("[busy:working:2]");
        expect(decoded(updateKeyImage.mock.calls[0][1])).toContain("NEXT");

        const regenerate = vi.mocked(action["setRegenerateCallback"]).mock.calls.at(-1)![1] as () => string;

        busy.looks.set("ctx-1", { kind: "waiting" });
        expect(decoded(regenerate())).toContain("[busy:waiting]");

        busy.looks.delete("ctx-1");
        surface.redraw({ kind: "rest" });

        expect(updateKeyImage).toHaveBeenCalledTimes(2);
        expect(decoded(updateKeyImage.mock.calls[1][1])).not.toContain("[busy:");
      });

      it("a redraw of a Play / Pause key keeps its playing state and records the look for the telemetry draw", async () => {
        vi.mocked(action["sdkController"].getCurrentTelemetry).mockReturnValue({
          ReplayPlaySpeed: 1,
          ReplayPlaySlowMotion: false,
        } as TelemetryData);
        await appear("ctx-1", "play-pause");
        const { surface } = busy.surfaces.get("ctx-1")!;
        const updateKeyImage = vi.mocked(action["updateKeyImage"]);

        updateKeyImage.mockClear();
        busy.looks.set("ctx-1", { kind: "waiting" });
        surface.redraw({ kind: "waiting" });

        expect(updateKeyImage).toHaveBeenCalledTimes(1);
        expect(decoded(updateKeyImage.mock.calls[0][1])).toContain("pause-icon");
        expect(decoded(updateKeyImage.mock.calls[0][1])).toContain("[busy:waiting]");
        expect(action["lastState"].get("ctx-1")).toMatch(/:waiting$/);

        // The telemetry draw that follows a press sees the look already drawn.
        await action["updateDisplayFromTelemetry"]("ctx-1", action["activeContexts"].get("ctx-1")!);
        expect(updateKeyImage).toHaveBeenCalledTimes(1);
      });

      it("a frame's redraws of every working key, and their regenerates, read telemetry at most once (#1467)", async () => {
        vi.mocked(action["sdkController"].getCurrentTelemetry).mockReturnValue({
          ReplayPlaySpeed: 1,
          ReplayPlaySlowMotion: false,
        } as TelemetryData);
        await appear("ctx-1", "next-lap");
        await appear("ctx-2", "next-incident");
        await appear("ctx-3", "play-pause");
        // What the indicator's interval does on each frame: every key showing working redrawn in one pass.
        const frame = (tick: number): void => {
          for (const token of ["ctx-1", "ctx-2", "ctx-3"]) {
            busy.looks.set(token, { kind: "working", tick });
            busy.surfaces.get(token)!.surface.redraw({ kind: "working", tick });
            // deck-core runs a regenerate callback as it is registered: the mocked base does not, so the frame does.
            (vi.mocked(action["setRegenerateCallback"]).mock.calls.at(-1)![1] as () => string)();
          }
        };
        const reads = vi.mocked(action["sdkController"].getCurrentTelemetry);

        // Settle what the appear draws left for the next microtask.
        await Promise.resolve();
        reads.mockClear();
        frame(10);

        expect(reads.mock.calls.length).toBeLessThanOrEqual(1);
        expect(decodeURIComponent(vi.mocked(action["updateKeyImage"]).mock.calls.at(-1)![1])).toContain("pause-icon");

        // The next frame reads afresh: a paused replay may deliver no tick.
        await Promise.resolve();
        reads.mockClear();
        frame(11);

        expect(reads).toHaveBeenCalledTimes(1);
      });

      it("a redraw for a key that has gone draws nothing", async () => {
        await appear("ctx-1", "next-lap");
        const { surface } = busy.surfaces.get("ctx-1")!;

        await action.onWillDisappear(fakeEvent("ctx-1", { mode: "next-lap" }) as any);
        vi.mocked(action["updateKeyImage"]).mockClear();
        surface.redraw({ kind: "waiting" });

        expect(action["updateKeyImage"]).not.toHaveBeenCalled();
      });
    });

    // A Jump to Fastest Lap press ignored behind one in flight: the engine's
    // press says `ignored` (`fastest-lap-press.test.ts`, #1467), and the key
    // reports it ("an ignored Jump to Fastest Lap press is reported to the
    // busy indicator", above).

    describe("generateReplayControlSvg with a busy mark", () => {
      const MARKS = [{ kind: "working", step: 5 }, { kind: "waiting" }, { kind: "not-done" }] as const;
      const markText = (mark: (typeof MARKS)[number]): string =>
        "step" in mark ? `${mark.kind}:${mark.step}` : mark.kind;

      it.each(MARKS)("a key drawn by assembleIcon takes the mark: %o", (mark) => {
        const uri = decoded(generateReplayControlSvg({ mode: "next-lap" }, false, 0, false, false, false, mark));

        expect(uri).toContain(`[busy:${markText(mark)}]`);
        expect(vi.mocked(assembleIcon).mock.calls.at(-1)![0].busy).toEqual(mark);
      });

      it.each(MARKS)("a playing Play / Pause key takes the mark: %o", (mark) => {
        const uri = decoded(generateReplayControlSvg({ mode: "play-pause" }, true, 1, false, false, false, mark));

        expect(uri).toContain("pause-icon");
        expect(uri).toContain(`[busy:${markText(mark)}]`);
      });

      it("passes no mark at rest, so the icon is unchanged", () => {
        const plain = generateReplayControlSvg({ mode: "next-lap" });

        expect(generateReplayControlSvg({ mode: "next-lap" }, false, 0, false, false, false, undefined)).toBe(plain);
        expect(vi.mocked(assembleIcon).mock.calls.at(-1)![0].busy).toBeUndefined();
      });

      it("a busy unavailable key keeps its own colours and is not dimmed", () => {
        vi.mocked(resolveIconColors).mockReturnValueOnce({ graphic1Color: "#2ecc71", textColor: "#ffffff" });

        generateReplayControlSvg({ mode: "jump-to-race-start" }, false, 0, false, false, true, { kind: "waiting" });

        const args = vi.mocked(assembleIcon).mock.calls.at(-1)![0];

        expect(args.busy).toEqual({ kind: "waiting" });
        expect(args.dimmed).toBeUndefined();
        expect(args.colors).toEqual({ graphic1Color: "#2ecc71", textColor: "#ffffff" });
      });

      it("passes bindingMissing beside the mark, for assembleIcon to set aside", () => {
        generateReplayControlSvg({ mode: "next-car" }, false, 0, false, true, false, { kind: "not-done" });

        const args = vi.mocked(assembleIcon).mock.calls.at(-1)![0];

        expect(args.bindingMissing).toBe(true);
        expect(args.busy).toEqual({ kind: "not-done" });
      });

      it("Speed Display draws its artwork and no mark, even handed one: it sends no replay command", () => {
        const uri = decoded(
          generateReplayControlSvg({ mode: "speed-display" }, false, 4, false, false, false, { kind: "waiting" }),
        );

        expect(uri).toContain("speed-display ");
        expect(busyMarkSvg).not.toHaveBeenCalled();
      });

      describe("Set Speed, assembled by hand", () => {
        const mode = "set-speed";
        const settings = { mode: "set-speed", speed: "4" } as const;

        function titleWith(showGraphics: boolean): void {
          vi.mocked(resolveTitleSettings).mockReturnValueOnce({
            showTitle: true,
            showGraphics,
            titleText: "TITLE",
            bold: true,
            fontSize: 18,
            position: "bottom",
            customPosition: 0,
          } as any);
        }

        it.each([true, false])("draws the mark in place of the artwork with showGraphics %s", (showGraphics) => {
          titleWith(showGraphics);

          const uri = decoded(generateReplayControlSvg(settings, false, 4, false, false, false, { kind: "waiting" }));

          expect(uri).toContain("<busy-mark waiting #ffffff/>");
          expect(uri).not.toContain(`${mode} `);
          expect(vi.mocked(busyMarkSvg)).toHaveBeenCalledExactlyOnceWith(
            { kind: "waiting" },
            { x: 8, y: 8, width: 128, height: 128 },
            "#ffffff",
          );
        });

        it.each(MARKS)("draws each mark: %o", (mark) => {
          const uri = decoded(generateReplayControlSvg(settings, false, 4, false, false, false, mark));

          expect(uri).toContain(`<busy-mark ${markText(mark)} #ffffff/>`);
        });

        it("colours the mark graphic1Color, then textColor", () => {
          vi.mocked(resolveIconColors).mockReturnValueOnce({ graphic1Color: "#123456", textColor: "#abcdef" });
          generateReplayControlSvg(settings, false, 4, false, false, false, { kind: "waiting" });
          expect(vi.mocked(busyMarkSvg).mock.calls.at(-1)![2]).toBe("#123456");

          vi.mocked(resolveIconColors).mockReturnValueOnce({ textColor: "#abcdef" });
          generateReplayControlSvg(settings, false, 4, false, false, false, { kind: "waiting" });
          expect(vi.mocked(busyMarkSvg).mock.calls.at(-1)![2]).toBe("#abcdef");
        });

        it("draws its artwork and no mark at rest", () => {
          const uri = decoded(generateReplayControlSvg(settings, false, 4, false));

          expect(uri).toContain(`${mode} `);
          expect(busyMarkSvg).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe("one speed model (#1467)", () => {
    let action: ReplayControl;
    let sim: FakeReplay;

    function keyEvent(actionId: string, settings: Record<string, unknown>) {
      return {
        action: { id: actionId, isDial: () => false, setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings },
      };
    }

    async function appear(contextId: string, mode: string): Promise<void> {
      await action.onWillAppear(keyEvent(contextId, { mode }) as never);
    }

    async function pressKey(contextId: string, mode: string): Promise<void> {
      await action.onKeyDown(keyEvent(contextId, { mode, stepRate: 1 }) as never);
      // Released, so Fast Forward's long-press repeat does not outlive the press.
      await action.onKeyUp(keyEvent(contextId, { mode, stepRate: 1 }) as never);
    }

    /** Every image the action pushed to `contextId` since the last clear. */
    function imagesOf(contextId: string): string[] {
      return vi
        .mocked(action["updateKeyImage"])
        .mock.calls.filter(([id]) => id === contextId)
        .map(([, uri]) => decodeURIComponent(String(uri)));
    }

    /** A marker's position jump far across the tape, through the gate as a marker sends it. */
    function markerJump(): void {
      pressReplayCommand({ kind: "jump", frame: 160_000 }, { by: "replay-markers", origin: "marker" });
    }

    function setUp(options: Parameters<typeof fakeReplay>[0] = {}): void {
      sim = fakeReplay({ frame: 2_000, ...options });
      configureEngine({
        replay: () => sim.replay,
        readTelemetry: () => sim.telemetry(),
        inReplay: () => true,
      });
    }

    beforeEach(async () => {
      vi.useFakeTimers();
      setUp();

      const { getCommands } = await import("@iracedeck/deck-iracing");

      vi.mocked(getCommands).mockImplementation(() => ({ replay: sim.replay, camera: { switchNum: vi.fn() } }) as any);
      action = new ReplayControl();
      // A fresh read is the sim's; no test here delivers a telemetry tick.
      action["sdkController"].getCurrentTelemetry = vi.fn(() => sim.telemetry());
    });

    afterEach(async () => {
      const { getCommands } = await import("@iracedeck/deck-iracing");

      vi.mocked(getCommands).mockReset();
      vi.useRealTimers();
    });

    it("a key speed press the gate holds shows only as the waiting speed, and one it drops never shows", async () => {
      setUp({ unlandable: new Set([160_000]), unlandableRest: 160_004 });
      await appear("ctx-pp", "play-pause");
      await appear("ctx-ff", "fast-forward");
      markerJump();
      vi.mocked(action["updateKeyImage"]).mockClear();

      await pressKey("ctx-ff", "fast-forward");

      // Held behind the jump: the Play/Pause key reads the waiting 2x, so it offers Pause.
      expect(sim.calls).toEqual(["setPlayPosition 0 160000"]);
      expect(shownSpeed(action)).toEqual({ speed: 2, slowMotion: false });
      expect(imagesOf("ctx-pp").at(-1)).toContain("pause-icon");

      // The jump ends off its target: the gate drops the press, and nothing is sent.
      await vi.advanceTimersByTimeAsync(replayTargetGiveUpMs(158_000) + 500);
      vi.mocked(action["updateKeyImage"]).mockClear();
      action["updateAllTelemetryDisplays"]();

      expect(sim.calls).toEqual(["setPlayPosition 0 160000"]);
      expect(sentSpeeds).toEqual([]);
      expect(shownSpeed(action)).toEqual({ speed: 0, slowMotion: false });
      expect(imagesOf("ctx-pp").at(-1)).toContain("play-pause");
      expect(imagesOf("ctx-pp").some((image) => image.includes("pause-icon"))).toBe(false);
    });

    it("a key's speed press sent at once updates the shown speed but not the dial's resume speed", async () => {
      // Telemetry shows a new speed only 300 ms after it is sent: the 2x read is the send's.
      setUp({ speed: { speed: 1, slowMotion: false }, speedLagMs: 300 });
      await appear("ctx-ff", "fast-forward");

      await pressKey("ctx-ff", "fast-forward");

      expect(sim.calls).toEqual(["setPlaySpeed 2 false"]);
      expect(shownSpeed(action)).toEqual({ speed: 2, slowMotion: false });
      expect(rememberedSpeed()).toEqual({ speed: 1, slowMotion: false });
    });

    it("a key's speed press the gate dispatches later updates the dial's resume speed too", async () => {
      await appear("ctx-ff", "fast-forward");
      markerJump();

      await pressKey("ctx-ff", "fast-forward");
      expect(sim.calls).toEqual(["setPlayPosition 0 160000"]);

      await vi.advanceTimersByTimeAsync(2_000);

      expect(sim.calls).toEqual(["setPlayPosition 0 160000", "setPlaySpeed 2 false"]);
      expect(shownSpeed(action)).toEqual({ speed: 2, slowMotion: false });
      expect(rememberedSpeed()).toEqual({ speed: 2, slowMotion: false });
    });

    describe("redraws the keys when the engine sends a speed with no tick", () => {
      it("a slot dispatch", async () => {
        setUp({ speed: { speed: 1, slowMotion: false }, searches: { nextSession: (f) => f + 60_000 } });
        await appear("ctx-speed", "speed-display");
        pressReplayCommand({ kind: "search", search: "nextSession" }, { by: "test" });
        await vi.advanceTimersByTimeAsync(120);
        // A pause behind a search on its way waits for the landing, and shows nothing until it is sent.
        expect(pressReplayCommand({ kind: "pause" }, { by: "test" })).toEqual({ kind: "held" });
        action["updateAllTelemetryDisplays"]();
        expect(imagesOf("ctx-speed").at(-1)).toContain("1x");
        vi.mocked(action["updateKeyImage"]).mockClear();

        await vi.advanceTimersByTimeAsync(1_500);

        expect(sim.calls).toEqual(["nextSession", "pause"]);
        expect(imagesOf("ctx-speed").at(-1)).toContain("PAUSED");
      });

      it("a search's pause", async () => {
        setUp({ speed: { speed: 4, slowMotion: false }, searches: { nextLap: (f) => f + 3_000 } });
        await appear("ctx-speed", "speed-display");
        action["updateAllTelemetryDisplays"]();
        expect(imagesOf("ctx-speed").at(-1)).toContain("4x");
        vi.mocked(action["updateKeyImage"]).mockClear();

        // The dial's paced search pauses a replay playing faster than 1x for its search.
        queueReplaySearch({ target: "lap", ticks: 1, origin: "dial-a", owner: "replay-control-dial lap" });
        await vi.advanceTimersByTimeAsync(0);

        expect(sim.calls[0]).toBe("setPlaySpeed 0");
        expect(imagesOf("ctx-speed").at(-1)).toContain("PAUSED");

        await vi.advanceTimersByTimeAsync(10_000);
      });
    });
  });
});

describe("ReplayControl press shape", () => {
  describePressShapeRouting(() => new ReplayControl(), { dial: { pressAction: "jump-to-live" } });
});
