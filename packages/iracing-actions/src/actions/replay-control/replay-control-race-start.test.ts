/**
 * Replay Control's Jump to Race Start mode (issue #1354): what the key and
 * the dial do around a press — the key's title and unavailable look, the
 * busy indicator, the dial's gesture and its hold preview. The press itself
 * — its guards, the three ways it finds the frame and the search it borrows —
 * is the replay engine's since #1467, and so are its tests
 * (`race-start-press.test.ts` in `@iracedeck/replay-engine`).
 */
import { getCarNumberRawFromSessionInfo, type ReplayPosMode, type TelemetryData } from "@iracedeck/iracing-sdk";
import { pressJumpToRaceStart } from "@iracedeck/replay-engine";
import {
  _activeLapPress,
  IN_RACE,
  type RaceWeekendOptions,
  raceWeekendReplay,
  WEEKEND,
  WEEKEND_TYPES,
  withSteppedReplayState,
} from "@iracedeck/replay-engine/testing";
import type { GreenLookup, GreenQuery, LapStartLookup, LapStartQuery, LapStartRecord } from "@iracedeck/replay-store";
import { getGlobalSettings } from "@iracedeck/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { engineOverDeck, replayControlScopeOn } from "../../shared/replay-engine-deck.test-support.js";
import { generateReplayControlSvg, ReplayControl } from "./replay-control.js";

const { mockAssembleIcon } = vi.hoisted(() => ({
  mockAssembleIcon: vi.fn(
    (args: { graphicSvg: string; title?: { titleText: string }; dimmed?: boolean }) =>
      `data:image/svg+xml,${args.dimmed ? "dimmed:" : ""}${args.title?.titleText ?? ""}`,
  ),
}));

vi.mock("@iracedeck/iracing-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/iracing-sdk")>()),
  getCarNumberRawFromSessionInfo: vi.fn(),
  getAllCarNumbers: vi.fn(() => []),
}));

// The dial surface has its own suite (`replay-control-dial-surface.test.ts`), the dial's Jump to Race Start
// gesture included; here the action only needs one to construct.
const dialHost = vi.hoisted(() => ({
  current: null as { jumpToRaceStart(origin: string): void; canJumpToRaceStart(): boolean } | null,
}));

vi.mock("./replay-control-dial-surface.js", () => ({
  ReplayControlDialSurface: class MockReplayControlDialSurface {
    constructor(host: { jumpToRaceStart(origin: string): void; canJumpToRaceStart(): boolean }) {
      dialHost.current = host;
    }

    willAppear = vi.fn(async () => {});
    willDisappear = vi.fn();
    didReceiveSettings = vi.fn(async () => {});
    rotate = vi.fn();
    down = vi.fn();
    up = vi.fn(async () => {});
    touchTap = vi.fn();
    onTick = vi.fn();
  },
}));

vi.mock("@iracedeck/deck-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/deck-iracing")>()),
  getCommands: vi.fn(),
}));

// The replay busy indicator (#1437) has its own suite; here a test sets the
// look a key shows and reads which ignored presses were reported.
const busy = vi.hoisted(() => {
  type Look = import("../../shared/replay-busy-indicator.js").ReplayBusyLook;

  const looks = new Map<string, Look>();

  return {
    looks,
    getLook: vi.fn((token: string): Look => looks.get(token) ?? { kind: "rest" }),
    reportIgnored: vi.fn((_token: string) => {}),
  };
});

vi.mock("../../shared/replay-busy-indicator.js", () => ({
  registerReplayBusySurface: vi.fn(() => () => {}),
  getReplayBusyLook: busy.getLook,
  reportReplayPressIgnored: busy.reportIgnored,
  setReplayBusyIndicatorLogger: vi.fn(),
}));

vi.mock("@iracedeck/deck-core", () => ({
  BUSY_MARK_FRAMES: 8,
  busyMarkSvg: vi.fn(() => "<busy-mark/>"),
  CommonSettings: {
    extend: (_fields: unknown) => ({
      parse: (data: Record<string, unknown>) => ({ ...data }),
      safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
    }),
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
    sdkController = withSteppedReplayState({
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getCurrentTelemetry: vi.fn((): TelemetryData | null => null),
      getSessionInfo: vi.fn((): unknown => null),
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
  applyGraphicTransform: vi.fn((content: string) => content),
  assembleIcon: mockAssembleIcon,
  computeGraphicArea: vi.fn(() => ({ x: 8, y: 8, width: 128, height: 128 })),
  extractGraphicContent: vi.fn((svg: string) => svg),
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  generateTitleText: vi.fn(() => ""),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  getGlobalTitleSettings: vi.fn(() => ({})),
  hexToGrayscale: vi.fn((hex: string) => `grey(${hex})`),
  ICON_BASE_TEMPLATE: "<svg>{{graphicContent}}{{titleContent}}</svg>",
  LogLevel: { Info: 2 },
  parseSvgViewBox: vi.fn(() => undefined),
  renderIconTemplate: vi.fn((template: string) => template),
  resolveBorderSettings: vi.fn(() => ({ enabled: true, borderWidth: 7, borderColor: "#00aaff" })),
  resolveGraphicSettings: vi.fn(() => ({ scale: 1 })),
  resolveIconColors: vi.fn(() => ({ backgroundColor: "#101010", textColor: "#ffffff", graphic1Color: "#2ecc71" })),
  resolveTitleSettings: vi.fn((_svg: unknown, _global: unknown, _overrides: unknown, defaultTitle?: string) => ({
    showTitle: true,
    showGraphics: true,
    titleText: defaultTitle ?? "",
  })),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${svg}`),
}));

vi.mock("@iracedeck/replay-store", () => ({
  getReplaySessionStore: vi.fn(),
  isReplaySessionStoreInitialized: vi.fn(() => false),
}));

vi.mock("@iracedeck/settings", () => ({
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
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

// The engine as it is, with its Jump to Race Start press a spy over the real
// one (#1467): a case can see what the key hands the engine, or answer for it.
vi.mock("@iracedeck/replay-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/replay-engine")>();

  return { ...actual, pressJumpToRaceStart: vi.fn(actual.pressJumpToRaceStart) };
});

configureEngine();

type KeyEvent = Parameters<ReplayControl["onKeyDown"]>[0];
type AppearEvent = Parameters<ReplayControl["onWillAppear"]>[0];

const GREEN = { mode: "jump-to-race-start" };

function fakeEvent(actionId: string, settings: Record<string, unknown> = GREEN) {
  return {
    action: { id: actionId, isDial: () => false, setTitle: vi.fn(), setImage: vi.fn() },
    payload: { settings },
  };
}

const mockReplay = {
  play: vi.fn(() => true),
  pause: vi.fn(() => true),
  setPlaySpeed: vi.fn<(speed: number, slowMotion?: boolean) => boolean>(() => true),
  setPlayPosition: vi.fn<(mode: ReplayPosMode, frameNumber: number) => boolean>(() => true),
  nextLap: vi.fn(() => true),
  prevLap: vi.fn(() => true),
  nextSession: vi.fn(() => true),
  prevSession: vi.fn(() => true),
  nextIncident: vi.fn(() => true),
  prevIncident: vi.fn(() => true),
  goToStart: vi.fn(() => true),
  goToEnd: vi.fn(() => true),
};

const mockCamera = { switchNum: vi.fn<(carNum: number, group: number, camera: number) => boolean>(() => true) };

const mockStore = {
  greens: {
    findGreen: vi.fn<(query: GreenQuery & { subSessionId?: number }) => GreenLookup>(() => ({
      hit: false,
      reason: "no green",
    })),
  },
  laps: {
    findLapStart: vi.fn<(query: LapStartQuery & { subSessionId?: number }) => LapStartLookup>(() => ({
      hit: false,
      reason: "no file",
    })),
    recordLapStart: vi.fn<(record: LapStartRecord & { subSessionId?: number }) => boolean>(() => true),
  },
};

/** The race weekend of `options` over this action's controller (`race-weekend-replay.test-support.ts` in the engine). */
function fakeReplay(action: ReplayControl, options: RaceWeekendOptions): ReturnType<typeof raceWeekendReplay> {
  return raceWeekendReplay(action["sdkController"], { replay: mockReplay, camera: mockCamera }, options);
}

function setJumpPlayback(mode: "remember" | "play" | "stopped"): void {
  vi.mocked(getGlobalSettings).mockReturnValue({
    fastestLapSearchDelayMs: 400,
    replayJumpPlayback: mode,
  } as ReturnType<typeof getGlobalSettings>);
}

describe("Replay Control: Jump to Race Start (#1354)", () => {
  let action: ReplayControl;

  async function press(contextId = "ctx-green", settings: Record<string, unknown> = GREEN): Promise<void> {
    await action.onKeyDown(fakeEvent(contextId, settings) as unknown as KeyEvent);
  }

  async function appear(contextId = "ctx-green", settings: Record<string, unknown> = GREEN): Promise<void> {
    await action.onWillAppear(fakeEvent(contextId, settings) as unknown as AppearEvent);
  }

  const greenAt = (frame: number, matchedBy: "pair" | "sessionNum" = "pair", sessionUniqueId = 3): void => {
    mockStore.greens.findGreen.mockImplementation(() => ({
      hit: true,
      frame,
      sessionTimeMs: 56_980,
      matchedBy,
      sessionUniqueId,
    }));
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    busy.looks.clear();
    // Every press polls for a landing; a real-timer poll would outlive its test.
    vi.useFakeTimers();
    // The replay command gate (#1430) and the target it records are module
    // state every press reaches: each test starts with nothing under way.
    resetEngine();

    const { getReplaySessionStore, isReplaySessionStoreInitialized } = await import("@iracedeck/replay-store");
    const { getCommands } = await import("@iracedeck/deck-iracing");

    vi.mocked(getCarNumberRawFromSessionInfo).mockImplementation((_sessionInfo: unknown, idx: number) => idx);
    vi.mocked(getCommands).mockReturnValue({ replay: mockReplay, camera: mockCamera } as unknown as ReturnType<
      typeof getCommands
    >);
    vi.mocked(isReplaySessionStoreInitialized).mockReturnValue(true);
    vi.mocked(getReplaySessionStore).mockReturnValue(mockStore as unknown as ReturnType<typeof getReplaySessionStore>);

    for (const command of Object.values(mockReplay)) {
      command.mockReset();
      command.mockImplementation(() => true);
    }

    mockCamera.switchNum.mockReset();
    mockCamera.switchNum.mockImplementation(() => true);
    mockStore.greens.findGreen.mockImplementation(() => ({ hit: false, reason: "no green" }));
    mockStore.laps.findLapStart.mockImplementation(() => ({ hit: false, reason: "no file" }));
    mockStore.laps.recordLapStart.mockImplementation(() => true);

    // Play, so the end of a press is one command these paused replays show.
    setJumpPlayback("play");
    action = new ReplayControl();
    // The replay command gate (#1430) reads the replay these tests simulate,
    // so the jumps a press sends read back and nothing stands after a walk.
    // The press is the engine's (#1467): it reads this action's controller
    // and logs on its logger.
    configureEngine({
      controller: action["sdkController"],
      logger: replayControlScopeOn(action["logger"]),
      readTelemetry: () => action["sdkController"].getCurrentTelemetry(),
      inReplay: () => true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("the key's press", () => {
    it("hands the engine its context", async () => {
      vi.mocked(pressJumpToRaceStart).mockReturnValueOnce({ kind: "refused", reason: "test" });

      await press("ctx-1");

      expect(pressJumpToRaceStart).toHaveBeenCalledExactlyOnceWith({ origin: "ctx-1" });
      expect(busy.reportIgnored).not.toHaveBeenCalled();
    });

    it("an ignored Jump to Race Start press is reported to the busy indicator", async () => {
      vi.mocked(pressJumpToRaceStart).mockReturnValueOnce({ kind: "ignored" });

      await press("ctx-1");

      expect(busy.reportIgnored).toHaveBeenCalledExactlyOnceWith("ctx-1");
    });

    it("an ignored press of the dial's gesture is reported under the dial's token", () => {
      vi.mocked(pressJumpToRaceStart).mockReturnValueOnce({ kind: "ignored" });

      dialHost.current?.jumpToRaceStart("dial-1");

      expect(pressJumpToRaceStart).toHaveBeenCalledExactlyOnceWith({ origin: "dial-1" });
      expect(busy.reportIgnored).toHaveBeenCalledExactlyOnceWith("dial-1");
    });
  });

  describe("the dial's gesture slot", () => {
    const host = () => dialHost.current as NonNullable<typeof dialHost.current>;

    it("runs the keypad's own press: the same lookup, the same single jump", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      greenAt(30_215);

      host().jumpToRaceStart("dial-1");
      await vi.runAllTimersAsync();

      expect(mockStore.greens.findGreen.mock.calls[0][0]).toMatchObject({ sessionNum: 2, sessionUniqueId: 3 });
      expect(mockReplay.setPlayPosition).toHaveBeenCalledExactlyOnceWith(expect.anything(), 29_915);
      expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
      expect(mockCamera.switchNum).not.toHaveBeenCalled();
    });

    it("shares the keypad's guards and its in-flight slot", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      mockReplay.setPlayPosition.mockImplementation(() => true);
      greenAt(30_215);

      await press("ctx-key");
      await vi.advanceTimersByTimeAsync(200);
      host().jumpToRaceStart("dial-1");

      expect(mockReplay.setPlayPosition).toHaveBeenCalledTimes(1);
      expect(action["logger"].info).toHaveBeenCalledWith(
        "Jump to race start: previous jump still in flight; press ignored",
      );
      expect(_activeLapPress()?.origin).toBe("ctx-key");
    });

    it("says whether a press has a race to aim at, which is what the hold preview shows", () => {
      expect(host().canJumpToRaceStart()).toBe(false);

      fakeReplay(action, { sessionTypes: ["Practice"], layout: [WEEKEND[0]], cursor: 5_000 });
      expect(host().canJumpToRaceStart()).toBe(false);

      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: 5_000 });
      expect(host().canJumpToRaceStart()).toBe(true);
    });
  });

  describe("the key", () => {
    const lastIcon = () => mockAssembleIcon.mock.calls.at(-1)?.[0] as Record<string, unknown>;

    it("has its own title and artwork", () => {
      const uri = generateReplayControlSvg({ mode: "jump-to-race-start" });

      expect(uri).toContain("RACE\nSTART");
      expect(String(lastIcon().graphicSvg)).toContain("<svg");
      expect(lastIcon().dimmed).toBeUndefined();
      expect(lastIcon().colors).toEqual({ backgroundColor: "#101010", textColor: "#ffffff", graphic1Color: "#2ecc71" });
    });

    it("draws the unavailable look greyed and faded, background kept", () => {
      generateReplayControlSvg({ mode: "jump-to-race-start" }, false, undefined, undefined, false, true);

      expect(lastIcon().dimmed).toBe(true);
      expect(lastIcon().colors).toEqual({
        backgroundColor: "#101010",
        textColor: "grey(#ffffff)",
        graphic1Color: "grey(#2ecc71)",
      });
      expect(lastIcon().border).toEqual({ enabled: true, borderWidth: 7, borderColor: "grey(#00aaff)" });
    });

    it("appears unavailable in a replay with no race session, and plain in one with a race", async () => {
      fakeReplay(action, { sessionTypes: ["Practice"], layout: [WEEKEND[0]], cursor: 5_000 });
      await appear("ctx-practice");

      expect(lastIcon().dimmed).toBe(true);

      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: 5_000 });
      await appear("ctx-weekend");

      expect(lastIcon().dimmed).toBeUndefined();
    });

    it("stays plain with no session info at all: grey whenever the sim is closed would read as broken", async () => {
      await appear();

      expect(lastIcon().dimmed).toBeUndefined();
    });

    it("stays plain from the car and with no green record: only a missing race session greys it", async () => {
      const replay = fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

      replay.state.inReplay = false;
      await appear();

      expect(lastIcon().dimmed).toBeUndefined();
      expect(mockStore.greens.findGreen).not.toHaveBeenCalled();
    });

    it("never greys another mode", async () => {
      fakeReplay(action, { sessionTypes: ["Practice"], layout: [WEEKEND[0]], cursor: 5_000 });
      await appear("ctx-lap", { mode: "next-lap" });

      expect(lastIcon().dimmed).toBeUndefined();
    });

    it("redraws on the tick the session list gains or loses its race, and not otherwise", async () => {
      fakeReplay(action, { sessionTypes: ["Practice"], layout: [WEEKEND[0]], cursor: 5_000 });
      await appear();

      const tick = vi.mocked(action["sdkController"].subscribe).mock.calls[0][1] as (
        telemetry: TelemetryData | null,
      ) => void;
      const telemetry = () => action["sdkController"].getCurrentTelemetry();

      tick(telemetry());
      tick(telemetry());

      expect(action["updateKeyImage"]).not.toHaveBeenCalled();

      // A replay of a race weekend is opened: new session info, with a race.
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: 5_000 });
      tick(telemetry());

      expect(action["updateKeyImage"]).toHaveBeenCalledExactlyOnceWith("ctx-green", expect.any(String));
      expect(lastIcon().dimmed).toBeUndefined();

      tick(telemetry());

      expect(action["updateKeyImage"]).toHaveBeenCalledTimes(1);

      // New session info that still lists a race changes nothing on the key.
      fakeReplay(action, { sessionTypes: ["Race"], layout: [WEEKEND[0]], cursor: 5_000 });
      tick(telemetry());

      expect(action["updateKeyImage"]).toHaveBeenCalledTimes(1);

      // Back to a practice-only replay.
      fakeReplay(action, { sessionTypes: ["Practice"], layout: [WEEKEND[0]], cursor: 5_000 });
      tick(telemetry());

      expect(action["updateKeyImage"]).toHaveBeenCalledTimes(2);
      expect(lastIcon().dimmed).toBe(true);
    });

    it("a busy key is drawn busy, in its own colours, even where it would be unavailable (#1437)", () => {
      generateReplayControlSvg({ mode: "jump-to-race-start" }, false, undefined, undefined, false, true, {
        kind: "not-done",
      });

      expect(lastIcon().busy).toEqual({ kind: "not-done" });
      expect(lastIcon().dimmed).toBeUndefined();
      expect(lastIcon().colors).toEqual({ backgroundColor: "#101010", textColor: "#ffffff", graphic1Color: "#2ecc71" });
      expect(lastIcon().border).toEqual({ enabled: true, borderWidth: 7, borderColor: "#00aaff" });
    });

    it("the availability redraw draws the busy look of the moment (#1437)", async () => {
      fakeReplay(action, { sessionTypes: ["Practice"], layout: [WEEKEND[0]], cursor: 5_000 });
      await appear();

      const tick = vi.mocked(action["sdkController"].subscribe).mock.calls[0][1] as (
        telemetry: TelemetryData | null,
      ) => void;

      busy.looks.set("ctx-green", { kind: "working", tick: 9 });
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: 5_000 });
      tick(action["sdkController"].getCurrentTelemetry());

      expect(action["updateKeyImage"]).toHaveBeenCalledExactlyOnceWith("ctx-green", expect.any(String));
      expect(lastIcon().busy).toEqual({ kind: "working", step: 1 });

      const regenerate = vi.mocked(action["setRegenerateCallback"]).mock.calls.at(-1)?.[1] as () => string;

      busy.looks.delete("ctx-green");
      regenerate();

      expect(lastIcon().busy).toBeUndefined();
    });

    it("regenerates with the look of the moment", async () => {
      fakeReplay(action, { sessionTypes: ["Practice"], layout: [WEEKEND[0]], cursor: 5_000 });
      await appear();

      const regenerate = vi.mocked(action["setRegenerateCallback"]).mock.calls.at(-1)?.[1] as () => string;

      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: 5_000 });
      regenerate();

      expect(lastIcon().dimmed).toBeUndefined();
    });
  });
});
