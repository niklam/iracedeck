/**
 * Replay Control's Jump to Race Start mode (issue #1354): the press path, its
 * guards, the three ways it finds the frame, and the key's unavailable look.
 * What the press aims at is `green-flag-target.test.ts`'s; the replay search
 * it borrows is covered, as Jump to Fastest Lap's, in `replay-control.test.ts`,
 * except for the camera switches a search makes for itself (#1430), which are
 * pinned here for both presses on this file's replay of laps and cars.
 */
import { getCarNumberRawFromSessionInfo, type ReplayPosMode, type TelemetryData } from "@iracedeck/iracing-sdk";
import {
  _configureReplayEngine,
  _resetReplayCursor,
  _resetReplayPositionState,
  cancelReplayCursorOwner,
  GREEN_APPROACH_FRAMES,
} from "@iracedeck/replay-engine";
import { withSteppedReplayState } from "@iracedeck/replay-engine/testing";
import type { GreenLookup, GreenQuery, LapStartLookup, LapStartQuery, LapStartRecord } from "@iracedeck/replay-store";
import { getGlobalSettings } from "@iracedeck/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _configureReplayCommandGate,
  _resetReplayCommandGate,
  pressReplayCommand,
  type ReplayGateFactEnd,
  subscribeReplayGate,
} from "../../shared/replay-command-gate.js";
import { _resetFastestLapSessionCache, generateReplayControlSvg, ReplayControl } from "./replay-control.js";

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

_configureReplayEngine({
  settings: {
    replayJumpPlayback: () => engineSetting("replayJumpPlayback"),
    fastestLapSearchDelayMs: () => engineSetting("fastestLapSearchDelayMs"),
  },
});

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
    // Next / Previous Lap step through the record first (#1426); a miss sends the search.
    listLapStarts: vi.fn(() => ({ hit: false, reason: "no file" })),
  },
};

/** The car the tests watch at the press, and the one that started from pole. */
const VIEWED_CAR = 4;
const POLE_CAR = 7;

type SessionLayout = {
  sessionNum: number;
  sessionUniqueId: number;
  startFrame: number;
  endFrame: number;
};

/** Every lap is this long, so a frame short of the line is a known fraction of a lap. */
const FRAMES_PER_LAP = 5000;

/** Where a car on its grid slot reads: a few metres behind the line, inside what the search takes for the end of a lap. */
const GRID_SLOT_DIST = 0.9995;

/**
 * A synthetic replay the action's commands move a cursor through. A session
 * instance occupies `[startFrame, endFrame]`; within it lap N spans
 * `[startFrame + N * FRAMES_PER_LAP, startFrame + (N + 1) * FRAMES_PER_LAP)`,
 * for every car alike. `nextLap` / `prevLap` land `lapSearchShort` frames
 * before the next / previous line, which is how iRacing's lap search behaves:
 * one frame short by default, so the search can verify its landing.
 * `switchNum` moves the camera (car numbers equal car indexes here).
 *
 * With `gridWaitFrames` a session opens with the cars standing on the grid for
 * that long, reading lap 0 at `GRID_SLOT_DIST`, and takes the line into lap 1
 * the moment the wait ends. `layout` is read at every use, so a test can add a
 * session to a recording that is still growing.
 *
 * `onTrack` takes a car out of the world on the frames it answers false for:
 * its lap and distance read -1 there, as for a car that has not joined, has
 * retired or sits in the garage. `seekStalls` names the absolute jumps the sim
 * is still working on when the search stops waiting: the telemetry reads the
 * seek transient (frame 0, `SessionNum` -1) until the next jump is sent.
 */
function fakeReplay(
  action: ReplayControl,
  options: {
    /** `SessionInfo.Sessions`, in `SessionNum` order. */
    sessionTypes: string[];
    /** The session instances on the tape, in frame order. */
    layout: SessionLayout[];
    cursor: number;
    /** False for a session with no qualifying grid. */
    grid?: boolean;
    viewedCarIdx?: number;
    lapSearchShort?: number;
    subSessionId?: number;
    gridWaitFrames?: number;
    /** `ResultsPositions` of every race session: the cars that took part. Omitted, the sessions list none. */
    raceResultsCarIdxs?: number[];
    onTrack?: (carIdx: number, frame: number) => boolean;
    seekStalls?: (frame: number) => boolean;
    /** How long an absolute jump of that many frames is under way before it lands. Omitted, it lands at once. */
    seekTakesMs?: (distanceFrames: number) => number;
    /**
     * How long a Next Session search across that many frames runs before it
     * lands. Until then the telemetry reads the frame it left from, as on a
     * paused replay: nothing shows that a search is under way.
     */
    sessionSearchTakesMs?: (distanceFrames: number) => number;
    /**
     * How long a jump that takes time reads as the frame it left from before
     * the telemetry shows the seek, as iRacing's does until its next update.
     * Omitted, it shows at once.
     */
    seekShowsAfterMs?: number;
    /**
     * Frames by which a car crosses each line later than the layout says
     * (#1430). iRacing's lap search stops where the car on screen crosses a
     * line, so with the camera on another car it lands on that car's lines.
     * Omitted, every car crosses together.
     */
    lineOffsets?: Partial<Record<number, number>>;
  },
) {
  const { layout } = options;
  const short = options.lapSearchShort ?? 1;
  const gridWait = options.gridWaitFrames ?? 0;
  const state = {
    frame: options.cursor,
    camCarIdx: options.viewedCarIdx ?? VIEWED_CAR,
    /** False once the test takes the sim out of the replay. */
    inReplay: true,
    /** True while a jump the sim has not finished is under way. */
    seeking: false,
    /** When the telemetry starts to show the seek under way. */
    seekShowsAt: 0,
  };
  const bufferEnd = (): number => layout[layout.length - 1].endFrame;
  /**
   * The frame of a car's first line crossing in a session: into lap 1 after a
   * grid wait, else into lap 1 after a full lap 0, and later by its offset.
   */
  const firstLine = (session: SessionLayout, carIdx: number): number =>
    session.startFrame + (gridWait > 0 ? gridWait : FRAMES_PER_LAP) + (options.lineOffsets?.[carIdx] ?? 0);
  const findSession = (frame: number): SessionLayout | null =>
    layout.find((s) => frame >= s.startFrame && frame <= s.endFrame) ?? null;

  /** The frames a lap search can land on in `session`: `short` before each line the car on screen crosses. */
  const landings = (session: SessionLayout): number[] => {
    const frames: number[] = [];

    for (let line = firstLine(session, state.camCarIdx); line <= session.endFrame; line += FRAMES_PER_LAP) {
      frames.push(line - short);
    }

    return frames;
  };

  mockReplay.goToStart.mockImplementation(() => {
    state.frame = layout[0].startFrame;

    return true;
  });
  /** Bumped by every command that moves the cursor, so a search a later command replaced lands nowhere. */
  let searchSerial = 0;

  mockReplay.nextSession.mockImplementation(() => {
    const current = findSession(state.frame);
    const next = current ? layout[layout.indexOf(current) + 1] : undefined;
    const serial = ++searchSerial;

    if (!next) return true;

    const takesMs = options.sessionSearchTakesMs?.(next.startFrame - state.frame) ?? 0;

    if (takesMs === 0) {
      state.frame = next.startFrame;

      return true;
    }

    setTimeout(() => {
      if (serial === searchSerial) state.frame = next.startFrame;
    }, takesMs);

    return true;
  });
  /** Bumped by every absolute jump, so a landing that a later jump replaced does nothing. */
  let seekSerial = 0;

  mockReplay.setPlayPosition.mockImplementation((_mode, frame) => {
    const serial = ++seekSerial;

    searchSerial++;

    const target = Math.max(0, Math.min(bufferEnd(), frame));
    const takesMs = options.seekTakesMs?.(Math.abs(target - state.frame)) ?? 0;

    state.seeking = options.seekStalls?.(frame) === true || takesMs > 0;
    state.seekShowsAt = Date.now() + (options.seekShowsAfterMs ?? 0);

    if (options.seekStalls?.(frame) === true) return true;

    if (takesMs === 0) {
      state.frame = target;

      return true;
    }

    setTimeout(() => {
      if (serial !== seekSerial) return;

      state.frame = target;
      state.seeking = false;
    }, takesMs);

    return true;
  });
  mockReplay.nextLap.mockImplementation(() => {
    const session = findSession(state.frame);
    const target = session ? landings(session).find((frame) => frame > state.frame) : undefined;

    if (target !== undefined) state.frame = target;

    return true;
  });
  mockReplay.prevLap.mockImplementation(() => {
    const session = findSession(state.frame);
    const target = session
      ? landings(session)
          .reverse()
          .find((frame) => frame < state.frame)
      : undefined;

    if (target !== undefined) state.frame = target;

    return true;
  });
  mockCamera.switchNum.mockImplementation((carNum) => {
    state.camCarIdx = carNum;

    return true;
  });

  action["sdkController"].getCurrentTelemetry = vi.fn((): TelemetryData | null => {
    const session = findSession(state.frame);
    const laps: number[] = [];
    const dists: number[] = [];

    if (session) {
      for (const carIdx of [VIEWED_CAR, POLE_CAR]) {
        const sinceLine = state.frame - firstLine(session, carIdx);
        // Before the first line: standing on the grid, or running lap 0.
        const lap = sinceLine < 0 ? 0 : 1 + Math.floor(sinceLine / FRAMES_PER_LAP);
        const dist =
          sinceLine >= 0
            ? (sinceLine % FRAMES_PER_LAP) / FRAMES_PER_LAP
            : gridWait > 0
              ? GRID_SLOT_DIST
              : Math.max(0, (sinceLine + FRAMES_PER_LAP) / FRAMES_PER_LAP);
        const present = options.onTrack?.(carIdx, state.frame) ?? true;

        laps[carIdx] = present ? lap : -1;
        dists[carIdx] = present ? dist : -1;
      }
    }

    if (state.seeking && Date.now() >= state.seekShowsAt) {
      return {
        CamCarIdx: state.camCarIdx,
        IsReplayPlaying: false,
        ReplayPlaySpeed: 0,
        ReplayFrameNum: 0,
        ReplayFrameNumEnd: bufferEnd(),
        SessionNum: -1,
        SessionUniqueID: 0,
        CarIdxLap: [],
        CarIdxLapDistPct: [],
      } as unknown as TelemetryData;
    }

    return {
      CamCarIdx: state.camCarIdx,
      IsReplayPlaying: state.inReplay,
      ReplayPlaySpeed: 0,
      ReplayFrameNum: state.frame,
      ReplayFrameNumEnd: bufferEnd() - state.frame,
      SessionNum: session?.sessionNum ?? -1,
      SessionUniqueID: session?.sessionUniqueId ?? 0,
      CarIdxLap: laps,
      CarIdxLapDistPct: dists,
    } as TelemetryData;
  });

  const sessionInfo = {
    ...(options.subSessionId === undefined ? {} : { WeekendInfo: { SubSessionID: options.subSessionId } }),
    DriverInfo: {
      DriverCarIdx: VIEWED_CAR,
      Drivers: [
        { CarIdx: VIEWED_CAR, UserID: 400 },
        { CarIdx: POLE_CAR, UserID: 700 },
      ],
    },
    SessionInfo: {
      Sessions: options.sessionTypes.map((SessionType, SessionNum) => ({
        SessionNum,
        SessionType,
        ...(SessionType === "Race" && options.raceResultsCarIdxs
          ? { ResultsPositions: options.raceResultsCarIdxs.map((CarIdx) => ({ CarIdx })) }
          : {}),
      })),
    },
    ...(options.grid === false
      ? {}
      : {
          QualifyResultsInfo: {
            Results: [
              { CarIdx: POLE_CAR, Position: 0 },
              { CarIdx: VIEWED_CAR, Position: 1 },
            ],
          },
        }),
  };

  action["sdkController"].getSessionInfo = vi.fn(() => sessionInfo);

  return { state, sessionInfo };
}

/** Practice, qualifying and one race, 50 000 frames each of the last two; the race is `SessionNum` 2 / unique id 3. */
const WEEKEND: SessionLayout[] = [
  { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 9_999 },
  { sessionNum: 1, sessionUniqueId: 2, startFrame: 10_000, endFrame: 19_999 },
  { sessionNum: 2, sessionUniqueId: 3, startFrame: 20_000, endFrame: 69_999 },
];
const WEEKEND_TYPES = ["Practice", "Lone Qualify", "Race"];
const RACE_START = 20_000;
/** The last frame of the race's lap 0: where a verified lap search leaves the pole car. */
const RACE_LAP_1_LINE = RACE_START + FRAMES_PER_LAP;

/** A cursor well into the race, a few laps after the start. */
const IN_RACE = RACE_START + 3 * FRAMES_PER_LAP + 1_234;

function setJumpPlayback(mode: "remember" | "play" | "stopped"): void {
  vi.mocked(getGlobalSettings).mockReturnValue({
    fastestLapSearchDelayMs: 400,
    replayJumpPlayback: mode,
  } as ReturnType<typeof getGlobalSettings>);
}

/** Every command that moves the replay cursor or changes its speed. */
function countReplayCommands(): number {
  return [
    mockReplay.play,
    mockReplay.pause,
    mockReplay.setPlaySpeed,
    mockReplay.setPlayPosition,
    mockReplay.nextLap,
    mockReplay.prevLap,
    mockReplay.nextSession,
    mockReplay.goToStart,
    mockReplay.goToEnd,
  ].reduce((n, command) => n + command.mock.calls.length, 0);
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

function seekFrames(): number[] {
  return mockReplay.setPlayPosition.mock.calls.map((call) => call[1]);
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

  const lapOneAt = (frame: number): void => {
    mockStore.laps.findLapStart.mockImplementation(() => ({ hit: true, frame, timeMs: null, matchedBy: "pair" }));
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    busy.looks.clear();
    // Every press polls for a landing; a real-timer poll would outlive its test.
    vi.useFakeTimers();
    _resetFastestLapSessionCache();
    _resetReplayCursor();
    // The replay command gate (#1430) and the target it records are module
    // state every press reaches: each test starts with nothing under way.
    _resetReplayCommandGate();
    _resetReplayPositionState();

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
    _configureReplayCommandGate({
      readTelemetry: () => action["sdkController"].getCurrentTelemetry(),
      inReplay: () => true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("a recorded green", () => {
    it("is one waited jump to five seconds before it, with no camera switch and no search", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE, subSessionId: 89_265_205 });
      greenAt(30_215);

      await press();
      await vi.runAllTimersAsync();

      expect(mockStore.greens.findGreen).toHaveBeenCalledExactlyOnceWith({
        subSessionId: 89_265_205,
        sessionNum: 2,
        sessionUniqueId: 3,
        kind: "start",
      });
      expect(mockReplay.setPlayPosition).toHaveBeenCalledExactlyOnceWith(expect.anything(), 30_215 - 300);
      expect(GREEN_APPROACH_FRAMES).toBe(300);
      // The seek, then the setting's speed: nothing else.
      expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
      expect(mockReplay.setPlayPosition.mock.invocationCallOrder[0]).toBeLessThan(
        mockReplay.setPlaySpeed.mock.invocationCallOrder[0],
      );
      expect(countReplayCommands()).toBe(2);
      expect(mockCamera.switchNum).not.toHaveBeenCalled();
      expect(mockStore.laps.findLapStart).not.toHaveBeenCalled();
      expect(action["logger"].info).toHaveBeenCalledWith("Jump to race start: record HIT (matchedBy pair)");
      expect(action["activeFastestLapPress"]).toBeNull();
    });

    it("never sends play() itself: the Replay jump playback setting decides what follows", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      greenAt(30_215);

      // Remember, on a replay that was paused at the press: the seek and nothing else.
      setJumpPlayback("remember");
      await press();
      await vi.runAllTimersAsync();

      expect(mockReplay.setPlayPosition).toHaveBeenCalledTimes(1);
      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
      expect(mockReplay.play).not.toHaveBeenCalled();
      expect(countReplayCommands()).toBe(1);
    });

    it("clamps the landing at the start of the recording", async () => {
      fakeReplay(action, {
        sessionTypes: ["Race"],
        layout: [WEEKEND[2]].map((s) => ({ ...s, sessionNum: 0, startFrame: 0, endFrame: 49_999 })),
        cursor: 30_000,
      });
      greenAt(120);

      await press();
      await vi.runAllTimersAsync();

      expect(mockReplay.setPlayPosition).toHaveBeenCalledExactlyOnceWith(expect.anything(), 0);
    });

    it("looks the last race session up by SessionNum alone when the cursor is in practice", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: 5_000 });
      greenAt(30_215, "sessionNum");

      await press();
      await vi.runAllTimersAsync();

      expect(mockStore.greens.findGreen).toHaveBeenCalledExactlyOnceWith({
        subSessionId: undefined,
        sessionNum: 2,
        sessionUniqueId: null,
        kind: "start",
      });
      expect(mockReplay.setPlayPosition).toHaveBeenCalledExactlyOnceWith(expect.anything(), 29_915);
      expect(action["logger"].info).toHaveBeenCalledWith("Jump to race start: record HIT (matchedBy sessionNum)");
    });

    it("targets the feature, the last race session, from outside a heat event's races", async () => {
      fakeReplay(action, {
        sessionTypes: ["Practice", "Race", "Race"],
        layout: WEEKEND,
        cursor: 5_000,
      });
      greenAt(30_215, "sessionNum");

      await press();
      await vi.runAllTimersAsync();

      expect(mockStore.greens.findGreen.mock.calls[0][0]).toMatchObject({ sessionNum: 2, sessionUniqueId: null });
    });

    it("targets the heat the cursor is in, with its unique id", async () => {
      fakeReplay(action, {
        sessionTypes: ["Practice", "Race", "Race"],
        layout: WEEKEND,
        cursor: 15_000,
      });
      greenAt(11_000, "pair", 2);

      await press();
      await vi.runAllTimersAsync();

      expect(mockStore.greens.findGreen.mock.calls[0][0]).toMatchObject({ sessionNum: 1, sessionUniqueId: 2 });
    });

    it("warns and sends nothing more when the jump does not land", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      // The seek is taken but the cursor stays put.
      mockReplay.setPlayPosition.mockImplementation(() => true);
      greenAt(30_215);

      await press();
      await vi.runAllTimersAsync();

      expect(mockReplay.setPlayPosition).toHaveBeenCalledTimes(1);
      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
      expect(action["logger"].warn).toHaveBeenCalledWith("Jump to race start: jump did not land; nothing more sent");
      expect(action["activeFastestLapPress"]).toBeNull();
    });

    it("warns and sends nothing more when iRacing refuses the seek", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      mockReplay.setPlayPosition.mockImplementation(() => false);
      greenAt(30_215);

      await press();
      await vi.runAllTimersAsync();

      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
      expect(action["logger"].warn).toHaveBeenCalledWith("Jump to race start: jump not sent");
    });

    it("pauses a moving replay before the seek, and restores its speed under Remember", async () => {
      const replay = fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      const readPaused = action["sdkController"].getCurrentTelemetry;

      // Playing at 2x until the sequence's pause has been sent.
      action["sdkController"].getCurrentTelemetry = vi.fn(
        () =>
          ({
            ...readPaused(),
            ReplayPlaySpeed: mockReplay.setPlaySpeed.mock.calls.length === 1 ? 0 : 2,
          }) as TelemetryData,
      );
      setJumpPlayback("remember");
      greenAt(30_215);

      await press();
      await vi.runAllTimersAsync();

      expect(mockReplay.setPlaySpeed.mock.calls).toEqual([[0], [2, false]]);
      expect(mockReplay.setPlaySpeed.mock.invocationCallOrder[0]).toBeLessThan(
        mockReplay.setPlayPosition.mock.invocationCallOrder[0],
      );
      expect(replay.state.frame).toBe(29_915);
    });
  });

  describe("guards: a press that is ignored sends nothing", () => {
    it("ignores a press in a replay with no race session", async () => {
      fakeReplay(action, { sessionTypes: ["Practice"], layout: [WEEKEND[0]], cursor: 5_000 });

      await press();
      await vi.runAllTimersAsync();

      expect(countReplayCommands()).toBe(0);
      expect(mockCamera.switchNum).not.toHaveBeenCalled();
      expect(mockStore.greens.findGreen).not.toHaveBeenCalled();
      expect(action["logger"].info).toHaveBeenCalledWith(
        "Jump to race start: no race session in this replay; press ignored",
      );
      // Not a press ignored behind one in flight: the busy look leaves it alone (#1437).
      expect(busy.reportIgnored).not.toHaveBeenCalled();
    });

    it("ignores a press on the SessionNum -1 tick after a seek", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      const settled = action["sdkController"].getCurrentTelemetry;

      action["sdkController"].getCurrentTelemetry = vi.fn(() => ({ ...settled(), SessionNum: -1 }) as TelemetryData);
      greenAt(30_215);

      await press();
      await vi.runAllTimersAsync();

      expect(countReplayCommands()).toBe(0);
      expect(mockStore.greens.findGreen).not.toHaveBeenCalled();
      expect(action["logger"].info).toHaveBeenCalledWith(
        "Jump to race start: replay session not settled yet; press ignored",
      );
    });

    it("sends nothing from the car, where iRacing ignores replay commands", async () => {
      const replay = fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

      replay.state.inReplay = false;
      greenAt(30_215);

      await press();
      await vi.runAllTimersAsync();

      expect(countReplayCommands()).toBe(0);
      expect(mockCamera.switchNum).not.toHaveBeenCalled();
      expect(mockStore.greens.findGreen).not.toHaveBeenCalled();
      expect(action["logger"].info).toHaveBeenCalledWith(
        "Jump to race start: replay not open; iRacing ignores replay commands from the car",
      );
    });

    it("ignores a second press while the first is in flight, and leaves the first to finish", async () => {
      const replay = fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

      // The seek is taken but the cursor stays put until the test moves it.
      mockReplay.setPlayPosition.mockImplementation(() => true);
      greenAt(30_215);

      await press("ctx-a");
      await vi.advanceTimersByTimeAsync(200);
      await press("ctx-b");
      await vi.advanceTimersByTimeAsync(200);

      expect(mockReplay.setPlayPosition).toHaveBeenCalledTimes(1);
      expect(action["logger"].info).toHaveBeenCalledWith(
        "Jump to race start: previous jump still in flight; press ignored",
      );
      // The ignored key shows not done (#1437); the first is left alone.
      expect(busy.reportIgnored).toHaveBeenCalledExactlyOnceWith("ctx-b");
      expect(action["activeFastestLapPress"]?.contextId).toBe("ctx-a");

      // iRacing reaches the frame: the first press, not cancelled by the second, applies the setting.
      replay.state.frame = 29_915;
      await vi.runAllTimersAsync();

      expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
      expect(action["activeFastestLapPress"]).toBeNull();
    });

    it("shares the in-flight slot with Jump to Fastest Lap, in both directions", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      mockReplay.setPlayPosition.mockImplementation(() => true);
      greenAt(30_215);

      await press("ctx-green");
      await vi.advanceTimersByTimeAsync(200);

      const fastestLap = { mode: "jump-to-fastest-lap", fastestLapTarget: "viewed-car" };
      const telemetry = action["sdkController"].getCurrentTelemetry;

      // A fastest lap to jump to, so the press gets as far as the in-flight check.
      action["sdkController"].getCurrentTelemetry = vi.fn(() => {
        const best: number[] = [];

        best[VIEWED_CAR] = 2;

        return { ...telemetry(), CarIdxBestLapNum: best } as TelemetryData;
      });
      await press("ctx-fastest", fastestLap);

      expect(action["logger"].info).toHaveBeenCalledWith(
        "Jump to fastest lap: previous press still in flight; press ignored",
      );
      expect(busy.reportIgnored).toHaveBeenCalledExactlyOnceWith("ctx-fastest");
      expect(mockReplay.setPlayPosition).toHaveBeenCalledTimes(1);
      expect(mockCamera.switchNum).not.toHaveBeenCalled();
    });

    it("is cancelled by any other replay command, and then sends nothing more", async () => {
      const replay = fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

      mockReplay.setPlayPosition.mockImplementation(() => true);
      greenAt(30_215);

      await press("ctx-green");
      await vi.advanceTimersByTimeAsync(200);
      await press("ctx-lap", { mode: "next-lap" });

      expect(action["logger"].info).toHaveBeenCalledWith("Jump to race start: jump cancelled by next-lap");
      // The search waits for the jump under way to land: sent into it, it
      // would throw the jump (#1430).
      expect(mockReplay.nextLap).not.toHaveBeenCalled();

      // The cursor reaches the frame after all: the cancelled press logs no
      // landing of its own, and the search goes out on the read-back.
      replay.state.frame = 29_915;
      await runPressOut();

      expect(mockReplay.nextLap).toHaveBeenCalledTimes(1);
      expect(mockReplay.nextLap.mock.invocationCallOrder[0]).toBeGreaterThan(
        mockReplay.setPlayPosition.mock.invocationCallOrder[0],
      );
      expect(action["logger"].debug).not.toHaveBeenCalledWith(expect.stringContaining("landed on"));
      expect(action["activeFastestLapPress"]).toBeNull();
    });
  });

  describe("no recorded green: the pole car's lap 1 from the lap record", () => {
    it("is one waited jump to five seconds before that lap start, with no camera switch", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE, subSessionId: 89_265_205 });
      lapOneAt(25_090);

      await press();
      await vi.runAllTimersAsync();

      expect(action["logger"].info).toHaveBeenCalledWith(
        "Jump to race start: record MISS (no green); falling back to lap 1 of the pole car",
      );
      expect(mockStore.laps.findLapStart).toHaveBeenCalledExactlyOnceWith({
        subSessionId: 89_265_205,
        sessionNum: 2,
        sessionUniqueId: 3,
        carIdx: POLE_CAR,
        carNumberRaw: POLE_CAR,
        lap: 1,
      });
      expect(mockReplay.setPlayPosition).toHaveBeenCalledExactlyOnceWith(expect.anything(), 25_090 - 300);
      expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
      expect(countReplayCommands()).toBe(2);
      expect(mockCamera.switchNum).not.toHaveBeenCalled();
      expect(action["logger"].info).toHaveBeenCalledWith("Jump to race start: lap record HIT (matchedBy pair)");
    });

    it("names the store's reason in the MISS line", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      mockStore.greens.findGreen.mockImplementation(() => ({ hit: false, reason: "no file" }));
      lapOneAt(25_090);

      await press();
      await vi.runAllTimersAsync();

      expect(action["logger"].info).toHaveBeenCalledWith(
        "Jump to race start: record MISS (no file); falling back to lap 1 of the pole car",
      );
    });

    it("takes the viewed car's lap 1 when the session has no qualifying grid", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE, grid: false });
      lapOneAt(25_400);

      await press();
      await vi.runAllTimersAsync();

      expect(mockStore.laps.findLapStart.mock.calls[0][0]).toMatchObject({ carIdx: VIEWED_CAR, lap: 1 });
      expect(mockReplay.setPlayPosition).toHaveBeenCalledExactlyOnceWith(expect.anything(), 25_100);
    });

    it("takes the viewed car's lap 1 when the pole sitter took no part in the target race", async () => {
      // A heat whose results list the viewed car and not the qualifying pole sitter.
      fakeReplay(action, {
        sessionTypes: WEEKEND_TYPES,
        layout: WEEKEND,
        cursor: IN_RACE,
        raceResultsCarIdxs: [VIEWED_CAR, 12],
      });
      lapOneAt(25_400);

      await press();
      await vi.runAllTimersAsync();

      expect(mockStore.laps.findLapStart.mock.calls[0][0]).toMatchObject({ carIdx: VIEWED_CAR, lap: 1 });
      expect(mockCamera.switchNum).not.toHaveBeenCalled();
    });

    it("keeps the pole sitter when the target race's results list it", async () => {
      fakeReplay(action, {
        sessionTypes: WEEKEND_TYPES,
        layout: WEEKEND,
        cursor: IN_RACE,
        raceResultsCarIdxs: [VIEWED_CAR, POLE_CAR],
      });
      lapOneAt(25_090);

      await press();
      await vi.runAllTimersAsync();

      expect(mockStore.laps.findLapStart.mock.calls[0][0]).toMatchObject({ carIdx: POLE_CAR, lap: 1 });
    });

    it("ignores the press with no grid and no car on screen", async () => {
      fakeReplay(action, {
        sessionTypes: WEEKEND_TYPES,
        layout: WEEKEND,
        cursor: IN_RACE,
        grid: false,
        viewedCarIdx: 255,
      });

      await press();
      await vi.runAllTimersAsync();

      expect(countReplayCommands()).toBe(0);
      expect(mockStore.laps.findLapStart).not.toHaveBeenCalled();
      expect(action["logger"].warn).toHaveBeenCalledWith(
        "Jump to race start: no pole car and no viewed car to take lap 1 from; press ignored",
      );
    });
  });

  describe("no recorded green and no lap record: a search of the replay", () => {
    it("borrows the camera for the pole car, lands five seconds before its lap 1, and hands the camera back before playback", async () => {
      const replay = fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

      await press();
      await vi.runAllTimersAsync();

      expect(action["logger"].info).toHaveBeenCalledWith(
        "Jump to race start: lap record MISS (no file); searching the replay",
      );
      // The search verified the last frame of lap 0, and that is what it recorded as lap 1's start.
      expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith({
        subSessionId: undefined,
        sessionNum: 2,
        sessionUniqueId: 3,
        carIdx: POLE_CAR,
        carNumberRaw: POLE_CAR,
        userId: 700,
        lap: 1,
        frame: RACE_LAP_1_LINE - 1,
      });
      expect(replay.state.frame).toBe(RACE_LAP_1_LINE - 1 - 300);
      expect(seekFrames().at(-1)).toBe(RACE_LAP_1_LINE - 1 - 300);
      // Onto the pole car before anything moves the cursor, back once the last seek has landed.
      expect(mockCamera.switchNum.mock.calls).toEqual([
        [POLE_CAR, 0, 0],
        [VIEWED_CAR, 0, 0],
      ]);
      expect(replay.state.camCarIdx).toBe(VIEWED_CAR);

      const [borrowedAt, restoredAt] = mockCamera.switchNum.mock.invocationCallOrder;
      const lastSeekAt = mockReplay.setPlayPosition.mock.invocationCallOrder.at(-1) as number;
      const speedAt = mockReplay.setPlaySpeed.mock.invocationCallOrder.at(-1) as number;

      expect(borrowedAt).toBeLessThan(mockReplay.pause.mock.invocationCallOrder[0]);
      expect(lastSeekAt).toBeLessThan(restoredAt);
      expect(restoredAt).toBeLessThan(speedAt);
      expect(mockReplay.setPlaySpeed).toHaveBeenLastCalledWith(1, false);
      expect(mockReplay.play).not.toHaveBeenCalled();
      expect(action["activeFastestLapPress"]).toBeNull();
    });

    describe("the end the search reports to the gate (#1437)", () => {
      /** The under-way ends the gate notes for the press's token while `run` runs. */
      async function walkEnds(run: () => Promise<void>): Promise<ReplayGateFactEnd[]> {
        const ends: ReplayGateFactEnd[] = [];
        const stop = subscribeReplayGate((notice) => {
          if (notice.origin === "ctx-green") ends.push(...notice.ended.filter((end) => end.fact === "underWay"));
        });

        try {
          await run();
        } finally {
          stop();
        }

        // The walk's own end: its probes and its way back end facts of their own.
        return ends.filter((end) => end.reason === "jump-landed" || end.reason === "walk-gave-up");
      }

      it("ends completed when it lands before lap 1", async () => {
        fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

        const ends = await walkEnds(async () => {
          await press();
          await vi.runAllTimersAsync();
        });

        expect(ends.at(-1)).toEqual({ fact: "underWay", class: "completed", reason: "jump-landed" });
        expect(ends.some((end) => end.reason === "walk-gave-up")).toBe(false);
      });

      it("ends given up when it puts the replay back", async () => {
        fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE, lapSearchShort: 600 });

        const ends = await walkEnds(async () => {
          await press();
          await vi.runAllTimersAsync();
        });

        expect(ends).toEqual([{ fact: "underWay", class: "gave-up", reason: "walk-gave-up" }]);
      });
    });

    it("logs the search as its own, not as Jump to Fastest Lap's", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

      await press();
      await vi.runAllTimersAsync();

      const lines = [
        ...vi.mocked(action["logger"].info).mock.calls,
        ...vi.mocked(action["logger"].debug).mock.calls,
        ...vi.mocked(action["logger"].warn).mock.calls,
      ].map((call) => String(call[0]));

      expect(lines).toContain("Jump to race start: walk converged (lap start recorded)");
      expect(lines.filter((line) => line.startsWith("Jump to fastest lap"))).toEqual([]);
    });

    it("does not touch the camera when the pole car is already on screen", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE, viewedCarIdx: POLE_CAR });

      await press();
      await vi.runAllTimersAsync();

      expect(mockCamera.switchNum).not.toHaveBeenCalled();
      expect(seekFrames().at(-1)).toBe(RACE_LAP_1_LINE - 1 - 300);
    });

    it("searches the latest instance of the race from practice, when an AI event was restarted", async () => {
      // Practice, qualifying, the race, then the race again after a restart: same SessionNum, new unique id.
      const restarted: SessionLayout[] = [
        ...WEEKEND,
        { sessionNum: 2, sessionUniqueId: 4, startFrame: 70_000, endFrame: 119_999 },
      ];

      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: restarted, cursor: 5_000 });

      await press();
      await vi.runAllTimersAsync();

      expect(mockStore.greens.findGreen.mock.calls[0][0]).toMatchObject({ sessionNum: 2, sessionUniqueId: null });
      expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionNum: 2, sessionUniqueId: 4, lap: 1, frame: 70_000 + FRAMES_PER_LAP - 1 }),
      );

      // Every probe stayed inside the second race: the first one was never bisected.
      const frames = seekFrames();

      expect(frames.length).toBeGreaterThan(1);

      for (const frame of frames) expect(frame).toBeGreaterThanOrEqual(70_000);

      expect(frames.at(-1)).toBe(70_000 + FRAMES_PER_LAP - 1 - 300);
    });

    it("searches the race the cursor is in, not a later restart of it", async () => {
      const restarted: SessionLayout[] = [
        ...WEEKEND,
        { sessionNum: 2, sessionUniqueId: 4, startFrame: 70_000, endFrame: 119_999 },
      ];

      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: restarted, cursor: IN_RACE });

      await press();
      await vi.runAllTimersAsync();

      expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionUniqueId: 3, frame: RACE_LAP_1_LINE - 1 }),
      );
      expect(seekFrames().at(-1)).toBe(RACE_LAP_1_LINE - 1 - 300);
    });

    it("still lands when iRacing's lap search stops a few frames short of what the search can verify (#1432)", async () => {
      // Eleven frames before the line on a 5000-frame lap: dist 0.9978, under the record's 0.999.
      const replay = fakeReplay(action, {
        sessionTypes: WEEKEND_TYPES,
        layout: WEEKEND,
        cursor: IN_RACE,
        lapSearchShort: 11,
      });

      await press();
      await vi.runAllTimersAsync();

      expect(action["logger"].warn).toHaveBeenCalledWith(
        expect.stringContaining("Jump to race start: walk did not converge"),
      );
      // Nothing unverified goes into the lap record...
      expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
      // ...but the landing is near enough to anchor a five-second run-up.
      expect(replay.state.frame).toBe(RACE_LAP_1_LINE - 11 - 300);
      expect(mockReplay.setPlaySpeed).toHaveBeenLastCalledWith(1, false);
      expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
    });

    it("lands on the lead-in iRacing's lap search leaves before the line of a rolling start", async () => {
      // A hundred frames before the line, the pole car at 98 % of the lap: what
      // Previous Lap from lap 1 did on a rolling start (measured 2026-10-13).
      const replay = fakeReplay(action, {
        sessionTypes: WEEKEND_TYPES,
        layout: WEEKEND,
        cursor: IN_RACE,
        lapSearchShort: 100,
      });

      await press();
      await vi.runAllTimersAsync();

      expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
      // A run-up of five seconds to that landing, which is a second and a half more to the line.
      expect(replay.state.frame).toBe(RACE_LAP_1_LINE - 100 - 300);
      expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
    });

    it("puts the replay back when the landing is too far from the line", async () => {
      // 600 frames short: dist 0.88, outside the last tenth of the lap.
      const replay = fakeReplay(action, {
        sessionTypes: WEEKEND_TYPES,
        layout: WEEKEND,
        cursor: IN_RACE,
        lapSearchShort: 600,
      });

      await press();
      await vi.runAllTimersAsync();

      expect(action["logger"].warn).toHaveBeenCalledWith(
        "Jump to race start: the search did not reach the start of the pole car's lap 1",
      );
      // No run-up jump: the search's back-step, then the way back to where the press was made.
      expect(seekFrames().slice(-2)).toEqual([RACE_LAP_1_LINE - 600 - 2, IN_RACE]);
      expect(replay.state.frame).toBe(IN_RACE);
      expect(action["logger"].info).toHaveBeenCalledWith(
        "Jump to race start: replay put back where the press found it",
      );
      // Paused at the press, so no speed command.
      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
      // The camera goes back too, once the way back has landed.
      expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
      expect(mockCamera.switchNum.mock.invocationCallOrder.at(-1) as number).toBeGreaterThan(
        mockReplay.setPlayPosition.mock.invocationCallOrder.at(-1) as number,
      );
    });

    it("does not take a car standing on the grid for one at the line: only a lap search places the cursor", async () => {
      // A standing start: twelve thousand frames on the grid, then the line. The race is short enough that the
      // search's first probe lands in the grid wait, where the pole car reads lap 0 a few metres from the line.
      const gridWaitFrames = 12_000;
      const race: SessionLayout = { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 21_999 };
      const replay = fakeReplay(action, { sessionTypes: ["Race"], layout: [race], cursor: 20_000, gridWaitFrames });
      const line = gridWaitFrames;

      await press();
      await vi.runAllTimersAsync();

      // The probe that found lap 0 sat a thousand frames into the wait...
      expect(seekFrames()[0]).toBe(10_999);
      // ...and was not taken for the lap start: iRacing's own Next Lap found the line.
      expect(mockReplay.nextLap).toHaveBeenCalled();
      expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ lap: 1, frame: line - 1 }),
      );
      expect(replay.state.frame).toBe(line - 1 - 300);
    });

    it("refuses a landing on the grid that no lap search produced", async () => {
      const gridWaitFrames = 12_000;
      const race: SessionLayout = { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 21_999 };
      const replay = fakeReplay(action, { sessionTypes: ["Race"], layout: [race], cursor: 20_000, gridWaitFrames });

      // iRacing's lap search does nothing: the probe in the grid wait is all the search has.
      mockReplay.nextLap.mockImplementation(() => true);

      await press();
      await vi.runAllTimersAsync();

      // The pole car reads lap 0 at 0.9995 there, inside both bounds, and it is still not the line.
      expect(action["logger"].warn).toHaveBeenCalledWith(
        "Jump to race start: the search did not reach the start of the pole car's lap 1",
      );
      expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
      expect(seekFrames().slice(-2)).toEqual([10_999 - 2, 20_000]);
      expect(replay.state.frame).toBe(20_000);
      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
    });

    describe("a pole car that is not on track for the whole race", () => {
      /** The pole car's lap 2 starts 10 000 frames into the race; lap 1 at `RACE_LAP_1_LINE`. */
      const RETIRES_AT = RACE_START + 12_000;

      it("finds lap 1 of a pole car that retired before the end of the tape", async () => {
        // The shape measured on a real tape (2026-10-13): the pole sitter retired
        // on lap 6 of 22, and every probe past that read the car out of the world.
        const replay = fakeReplay(action, {
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          onTrack: (carIdx, frame) => carIdx !== POLE_CAR || frame < RETIRES_AT,
        });

        await press();
        await vi.runAllTimersAsync();

        // The midpoint and the first quarter found the car gone and moved no
        // bound; the search went on toward the start, and the first eighth
        // showed the car on lap 1.
        expect(seekFrames().slice(0, 3)).toEqual([44_999, 32_499, 26_249]);
        expect(action["logger"].warn).not.toHaveBeenCalled();
        expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ carIdx: POLE_CAR, lap: 1, frame: RACE_LAP_1_LINE - 1 }),
        );
        expect(replay.state.frame).toBe(RACE_LAP_1_LINE - 1 - 300);
        expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
      });

      it("finds lap 1 of a pole car that had not joined yet where the search first looked", async () => {
        // A long wait before the start, and the cars appear late in it.
        const gridWaitFrames = 30_000;
        const line = RACE_START + gridWaitFrames;
        const replay = fakeReplay(action, {
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: line + 12_000,
          gridWaitFrames,
          onTrack: (carIdx, frame) => carIdx !== POLE_CAR || frame >= RACE_START + 26_000,
        });

        await press();
        await vi.runAllTimersAsync();

        // Gone at the midpoint and all the way toward the start; on lap 2 at the third quarter.
        expect(seekFrames().slice(0, 6)).toEqual([44_999, 32_499, 26_249, 23_124, 21_562, 57_499]);
        expect(action["logger"].warn).not.toHaveBeenCalled();
        expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ lap: 1, frame: line - 1 }),
        );
        expect(replay.state.frame).toBe(line - 1 - 300);
      });

      it("reads a car gone after a frame that showed it as no information: it may be back", async () => {
        // On track for laps 0 to 5, in the garage for 14 000 frames, out again from lap 8.
        const replay = fakeReplay(action, {
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          viewedCarIdx: POLE_CAR,
          onTrack: (carIdx, frame) => carIdx !== POLE_CAR || frame < 46_000 || frame >= 60_000,
        });
        const lapNine = RACE_START + 9 * FRAMES_PER_LAP;

        void action.walkToFastestLap("ctx-green", POLE_CAR, 9, 2, {
          carNumberRaw: POLE_CAR,
          userId: 700,
          subSessionId: undefined,
        });
        await vi.runAllTimersAsync();

        // 44 999 shows lap 4, so the lap is later. 57 499, 51 249 and 48 124 find
        // the car gone, each later than a frame that showed it, and still the lap
        // is not earlier: the search goes on until a frame past the garage shows
        // lap 8.
        expect(seekFrames().slice(0, 4)).toEqual([44_999, 57_499, 51_249, 48_124]);
        expect(Math.max(...seekFrames())).toBeGreaterThan(60_000);
        expect(action["logger"].warn).not.toHaveBeenCalled();
        expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ carIdx: POLE_CAR, lap: 9, frame: lapNine - 1 }),
        );
        expect(replay.state.frame).toBe(lapNine - 1 - 2);
      });

      it("steps from the nearest frame that showed the car when the probes run out on one that did not", async () => {
        // The pole car is on track only late in the race, from what the tape counts as lap 6.
        const replay = fakeReplay(action, {
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          onTrack: (carIdx, frame) => carIdx !== POLE_CAR || frame >= 50_000,
        });

        await press();
        await vi.runAllTimersAsync();

        // Lap 6 at frame 52 811 was the nearest the probes came to lap 0. The last
        // probe found the car gone, so the cursor goes back to that frame first...
        expect(seekFrames().at(-2)).toBe(52_811);
        // ...and one Previous Lap from there leaves the car's time on track.
        expect(mockReplay.prevLap).toHaveBeenCalledTimes(1);
        expect(action["logger"].warn).toHaveBeenCalledExactlyOnceWith(
          "Jump to race start: CarIdxLap unavailable during lap-step 1 (lap=-1); aborting",
        );
        expect(replay.state.frame).toBe(IN_RACE);
        expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
      });

      it("gives up on a pole car that was never on track, and puts the replay back", async () => {
        const replay = fakeReplay(action, {
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          onTrack: (carIdx) => carIdx !== POLE_CAR,
        });

        await press();
        await vi.runAllTimersAsync();

        expect(action["logger"].warn).toHaveBeenCalledExactlyOnceWith(
          "Jump to race start: carIdx 7 was not found on track in session 2/3; aborting",
        );
        // Five rounds of halving, none of which moved a bound, then the way back.
        expect(seekFrames()).toHaveLength(31 + 1);
        expect(seekFrames().at(-1)).toBe(IN_RACE);
        expect(replay.state.frame).toBe(IN_RACE);
        expect(action["logger"].info).toHaveBeenCalledWith(
          "Jump to race start: replay put back where the press found it",
        );
        expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
        expect(mockReplay.nextLap).not.toHaveBeenCalled();
        expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
        // The camera goes back once the way back has landed, never into the seek.
        expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
        expect(mockCamera.switchNum.mock.invocationCallOrder.at(-1) as number).toBeGreaterThan(
          mockReplay.setPlayPosition.mock.invocationCallOrder.at(-1) as number,
        );
        expect(action["activeFastestLapPress"]).toBeNull();
      });

      it("gives a playing replay its speed back after a search that found no car, whatever the setting", async () => {
        const replay = fakeReplay(action, {
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          onTrack: (carIdx) => carIdx !== POLE_CAR,
        });
        const readPaused = action["sdkController"].getCurrentTelemetry;

        // Playing at 2x until the search's opening pause, and again once a speed is sent.
        action["sdkController"].getCurrentTelemetry = vi.fn(() => {
          const paused = mockReplay.pause.mock.calls.length > 0 && mockReplay.setPlaySpeed.mock.calls.length === 0;

          return { ...readPaused(), ReplayPlaySpeed: paused ? 0 : 2 } as TelemetryData;
        });
        setJumpPlayback("stopped");

        await press();
        await vi.runAllTimersAsync();

        expect(replay.state.frame).toBe(IN_RACE);
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(2, false);
        expect(mockReplay.setPlayPosition.mock.invocationCallOrder.at(-1) as number).toBeLessThan(
          mockReplay.setPlaySpeed.mock.invocationCallOrder[0],
        );
      });
    });

    it("says the speed was not restored when the sim refuses it on the way back", async () => {
      const replay = fakeReplay(action, {
        sessionTypes: WEEKEND_TYPES,
        layout: WEEKEND,
        cursor: IN_RACE,
        onTrack: (carIdx) => carIdx !== POLE_CAR,
      });
      const readPaused = action["sdkController"].getCurrentTelemetry;

      // Playing at 2x until the search's opening pause.
      action["sdkController"].getCurrentTelemetry = vi.fn(() => {
        const paused = mockReplay.pause.mock.calls.length > 0;

        return { ...readPaused(), ReplayPlaySpeed: paused ? 0 : 2 } as TelemetryData;
      });
      mockReplay.setPlaySpeed.mockImplementation(() => false);

      await appear();
      await press();
      await vi.runAllTimersAsync();

      expect(replay.state.frame).toBe(IN_RACE);
      expect(action["logger"].warn).toHaveBeenCalledWith(
        "Jump to race start: speed command failed; replay left paused on the frame the press found it on",
      );
      expect(action["logger"].info).not.toHaveBeenCalledWith(
        "Jump to race start: replay put back where the press found it",
      );
      // The cache says paused, so the Play key plays.
      expect(action["replaySpeed"].get("ctx-green")).toBe(0);
    });

    describe("the session map of a long recording", () => {
      /** iRacing's measured rate for a session search: 8 ms for every 1000 frames, the same as a jump. */
      const sessionSearchTakesMs = (distanceFrames: number): number => distanceFrames * 0.008;
      /** Six hours at 60 frames a second: the long session the search is built for. */
      const SIX_HOURS = 1_296_000;
      /** Six hours of practice, then the race. */
      const LONG_PRACTICE: SessionLayout[] = [
        { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: SIX_HOURS - 1 },
        { sessionNum: 1, sessionUniqueId: 2, startFrame: SIX_HOURS, endFrame: SIX_HOURS + 49_999 },
      ];

      it("waits out a Next Session search across a six-hour session that another follows", async () => {
        const raceStart = SIX_HOURS;
        const replay = fakeReplay(action, {
          sessionTypes: ["Practice", "Race"],
          layout: LONG_PRACTICE,
          cursor: raceStart + 3 * FRAMES_PER_LAP,
          subSessionId: 123,
          sessionSearchTakesMs,
        });

        await press();
        await vi.runAllTimersAsync();

        // The search landed after 10.4 s, six times the settle timeout, and was
        // not taken for "already in the last session": the race is in the map.
        expect(action["logger"].info).toHaveBeenCalledWith(
          "Jump to race start: session map built — subSession=123, S0/1[0-1295999], S1/2[1296000-end]",
        );
        expect(action["logger"].warn).not.toHaveBeenCalled();
        expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ sessionNum: 1, lap: 1, frame: raceStart + FRAMES_PER_LAP - 1 }),
        );
        expect(replay.state.frame).toBe(raceStart + FRAMES_PER_LAP - 1 - 300);
      });

      it("sends no search from the last session a real event lists", async () => {
        fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE, subSessionId: 123 });

        await press();
        await vi.runAllTimersAsync();

        // Practice to qualifying, qualifying to the race, and nothing from the race.
        expect(mockReplay.nextSession).toHaveBeenCalledTimes(2);
        expect(action["logger"].debug).toHaveBeenCalledWith(
          "Jump to race start: session 2 is the last this event lists; nextSession #3 not sent",
        );
        expect(mockStore.laps.recordLapStart).toHaveBeenCalledTimes(1);
      });

      it("still searches from the last listed session of an offline event, which may have been restarted", async () => {
        // Two passes of one race in an offline event, the first six hours long:
        // the session list names the race once.
        const passes: SessionLayout[] = [
          { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: SIX_HOURS - 1 },
          { sessionNum: 0, sessionUniqueId: 2, startFrame: SIX_HOURS, endFrame: SIX_HOURS + 49_999 },
        ];
        const replay = fakeReplay(action, {
          sessionTypes: ["Race"],
          layout: passes,
          cursor: SIX_HOURS + 3 * FRAMES_PER_LAP,
          sessionSearchTakesMs,
        });

        await press();
        await vi.runAllTimersAsync();

        // The search from the first pass ran for 10.4 s and found the second; the one from the second moved nothing,
        // and was given only the time a search to the end of the tape from there could take.
        expect(mockReplay.nextSession).toHaveBeenCalledTimes(2);
        expect(action["logger"].debug).toHaveBeenCalledWith(
          "Jump to race start: nextSession #2 did not move the cursor from frame 1296000 in 1600 ms",
        );
        expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ sessionUniqueId: 2, lap: 1, frame: SIX_HOURS + FRAMES_PER_LAP - 1 }),
        );
        expect(replay.state.frame).toBe(SIX_HOURS + FRAMES_PER_LAP - 1 - 300);
      });

      it("finds the green of a 24-hour race that follows a six-hour practice, pressed near its end", async () => {
        // Not what the search is tuned for; it has to work all the same.
        const day = 24 * 216_000;
        const layout: SessionLayout[] = [
          { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: SIX_HOURS - 1 },
          { sessionNum: 1, sessionUniqueId: 2, startFrame: SIX_HOURS, endFrame: SIX_HOURS + day },
        ];
        const replay = fakeReplay(action, {
          sessionTypes: ["Practice", "Race"],
          layout,
          cursor: SIX_HOURS + day - 10_000,
          subSessionId: 123,
          sessionSearchTakesMs,
          seekTakesMs: sessionSearchTakesMs,
        });

        await press();
        await vi.runAllTimersAsync();

        expect(action["logger"].warn).not.toHaveBeenCalled();
        expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ sessionNum: 1, lap: 1, frame: SIX_HOURS + FRAMES_PER_LAP - 1 }),
        );
        expect(replay.state.frame).toBe(SIX_HOURS + FRAMES_PER_LAP - 1 - 300);
      });
    });

    describe("a jump across a long recording", () => {
      /** iRacing's measured rate: 8 ms for every 1000 frames of a jump. */
      const seekTakesMs = (distanceFrames: number): number => distanceFrames * 0.008;
      /** A six-hour race; the first probe is 646 000 frames from the cursor. */
      const LONG_RACE: SessionLayout = { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 1_296_000 };

      it("waits out a probe half a six-hour race away, which lands after 5.2 seconds", async () => {
        const replay = fakeReplay(action, {
          sessionTypes: ["Race"],
          layout: [LONG_RACE],
          cursor: 2_000,
          seekTakesMs,
        });

        await press();
        await vi.runAllTimersAsync();

        // Three times the settle timeout of 1.6 s had passed before that probe landed.
        expect(seekFrames()[0]).toBe(648_000);
        expect(action["logger"].warn).not.toHaveBeenCalled();
        expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ lap: 1, frame: FRAMES_PER_LAP - 1 }),
        );
        expect(replay.state.frame).toBe(FRAMES_PER_LAP - 1 - 300);
      });

      it("still gives up on a long jump that never lands, and puts the replay back", async () => {
        const replay = fakeReplay(action, {
          sessionTypes: ["Race"],
          layout: [LONG_RACE],
          cursor: 2_000,
          seekTakesMs,
          seekStalls: (frame) => frame === 648_000,
        });

        await press();
        await vi.runAllTimersAsync();

        expect(action["logger"].warn).toHaveBeenCalledExactlyOnceWith(
          "Jump to race start: jump did not settle; aborting walk",
        );
        expect(seekFrames()).toEqual([648_000, 2_000]);
        expect(replay.state.frame).toBe(2_000);
        expect(action["logger"].info).toHaveBeenCalledWith(
          "Jump to race start: replay put back where the press found it",
        );
      });
    });

    describe("a jump the search stops waiting for", () => {
      it("puts the replay back, and the camera only once that has landed", async () => {
        // The first probe is still being sought when the search gives up on it:
        // the way back goes into that seek, and replaces it.
        const replay = fakeReplay(action, {
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          seekStalls: (frame) => frame === 44_999,
        });

        await press();
        await vi.runAllTimersAsync();

        expect(action["logger"].warn).toHaveBeenCalledExactlyOnceWith(
          "Jump to race start: jump did not settle; aborting walk",
        );
        expect(seekFrames()).toEqual([44_999, IN_RACE]);
        expect(replay.state.frame).toBe(IN_RACE);
        expect(replay.state.seeking).toBe(false);
        expect(action["logger"].info).toHaveBeenCalledWith(
          "Jump to race start: replay put back where the press found it",
        );
        expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
        // Borrowed for the pole car, and returned after the way back landed.
        expect(mockCamera.switchNum.mock.calls.map((call) => call[0])).toEqual([POLE_CAR, VIEWED_CAR]);
        expect(mockCamera.switchNum.mock.invocationCallOrder[1]).toBeGreaterThan(
          mockReplay.setPlayPosition.mock.invocationCallOrder[1],
        );
        expect(action["activeFastestLapPress"]).toBeNull();
      });

      it("says so when the way back does not land either, and leaves the replay paused", async () => {
        const replay = fakeReplay(action, {
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          seekStalls: () => true,
        });

        await press();
        await runPressOut();

        expect(action["logger"].warn).toHaveBeenCalledWith("Jump to race start: jump did not settle; aborting walk");
        expect(action["logger"].warn).toHaveBeenCalledWith(
          "Jump to race start: could not put the replay back; it is left paused where the search stopped",
        );
        expect(seekFrames()).toEqual([44_999, IN_RACE]);
        expect(action["logger"].info).not.toHaveBeenCalledWith(
          "Jump to race start: replay put back where the press found it",
        );
        expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
        expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
        expect(action["activeFastestLapPress"]).toBeNull();
      });

      it("sends nothing more when another replay command arrives during the way back", async () => {
        const replay = fakeReplay(action, {
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          seekStalls: (frame) => frame === 44_999,
        });
        const seek = mockReplay.setPlayPosition.getMockImplementation() as (
          mode: ReplayPosMode,
          frame: number,
        ) => boolean;

        // Next Lap is pressed as the way back goes out.
        mockReplay.setPlayPosition.mockImplementation((mode, frame) => {
          const sent = seek(mode, frame);

          if (frame === IN_RACE) cancelReplayCursorOwner("next-lap");

          return sent;
        });

        await press();
        await vi.runAllTimersAsync();

        expect(action["logger"].info).toHaveBeenCalledWith("Jump to race start: walk cancelled by next-lap");
        expect(action["logger"].info).not.toHaveBeenCalledWith(
          "Jump to race start: replay put back where the press found it",
        );
        // That command's effect stands: no speed command, and the camera is left on the pole car.
        expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
        expect(replay.state.camCarIdx).toBe(POLE_CAR);
        expect(action["activeFastestLapPress"]).toBeNull();
      });
    });

    describe("Jump to Fastest Lap takes the same way back", () => {
      it("returns the camera to the car that was on screen when its search finds no car", async () => {
        // An Always My Car key pressed while watching another car: the press put
        // the camera on the target before the search.
        const replay = fakeReplay(action, {
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          viewedCarIdx: POLE_CAR,
          onTrack: (carIdx) => carIdx !== POLE_CAR,
        });

        void action.walkToFastestLap(
          "ctx-green",
          POLE_CAR,
          9,
          2,
          { carNumberRaw: POLE_CAR, userId: 700, subSessionId: undefined },
          VIEWED_CAR,
        );
        await vi.runAllTimersAsync();

        expect(action["logger"].warn).toHaveBeenCalledExactlyOnceWith(
          "Jump to fastest lap: carIdx 7 was not found on track in session 2/3; aborting",
        );
        expect(replay.state.frame).toBe(IN_RACE);
        expect(action["logger"].info).toHaveBeenCalledWith(
          "Jump to fastest lap: replay put back where the press found it",
        );
        expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
        expect(mockCamera.switchNum.mock.invocationCallOrder.at(-1) as number).toBeGreaterThan(
          mockReplay.setPlayPosition.mock.invocationCallOrder.at(-1) as number,
        );
      });

      it("sends no camera command when the search was for the car on screen", async () => {
        fakeReplay(action, {
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          viewedCarIdx: POLE_CAR,
          onTrack: (carIdx) => carIdx !== POLE_CAR,
        });

        void action.walkToFastestLap("ctx-green", POLE_CAR, 9, 2, {
          carNumberRaw: POLE_CAR,
          userId: 700,
          subSessionId: undefined,
        });
        await vi.runAllTimersAsync();

        expect(mockCamera.switchNum).not.toHaveBeenCalled();
      });
    });

    it("puts the cursor back when the race is not in the recording yet", async () => {
      // A live event still in qualifying: the session list names the race, the tape does not hold it.
      const layout = WEEKEND.slice(0, 2);
      const replay = fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout, cursor: 5_432 });

      await press();
      await vi.runAllTimersAsync();

      // An expected state of a live event, not a fault: info, and no warning.
      expect(action["logger"].info).toHaveBeenCalledWith(
        "Jump to race start: the target session is not in this recording yet",
      );
      expect(action["logger"].info).toHaveBeenCalledWith(
        "Jump to race start: replay put back where the press found it",
      );
      expect(action["logger"].warn).not.toHaveBeenCalled();
      // The map build walked through the recording; the user's place is restored.
      expect(mockReplay.nextSession).toHaveBeenCalled();
      expect(replay.state.frame).toBe(5_432);
      expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
      // The replay was paused at the press, and stays so: Play is the setting, and nothing was jumped to.
      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
      expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
      expect(action["activeFastestLapPress"]).toBeNull();
    });

    it("gives a playing replay its speed back when the race is not in the recording, whatever the setting", async () => {
      const layout = WEEKEND.slice(0, 2);
      const replay = fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout, cursor: 5_432 });
      const readPaused = action["sdkController"].getCurrentTelemetry;

      // Playing at 2x until the search's opening pause, and again once a speed is sent.
      action["sdkController"].getCurrentTelemetry = vi.fn(() => {
        const paused = mockReplay.pause.mock.calls.length > 0 && mockReplay.setPlaySpeed.mock.calls.length === 0;

        return { ...readPaused(), ReplayPlaySpeed: paused ? 0 : 2 } as TelemetryData;
      });
      setJumpPlayback("stopped");

      await press();
      await vi.runAllTimersAsync();

      expect(replay.state.frame).toBe(5_432);
      // Not "stopped": the press found nothing to jump to and leaves the replay as it was.
      expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(2, false);
      expect(mockReplay.setPlayPosition.mock.invocationCallOrder.at(-1) as number).toBeLessThan(
        mockReplay.setPlaySpeed.mock.invocationCallOrder[0],
      );
    });

    it("refuses to pick the latest race from a recording with more sessions than the search maps", async () => {
      // An AI event restarted three times in full: twelve session instances, where the map holds eleven.
      const layout: SessionLayout[] = Array.from({ length: 12 }, (_unused, index) => ({
        sessionNum: index % 3,
        sessionUniqueId: index + 1,
        startFrame: index * 12_000,
        endFrame: index * 12_000 + 11_999,
      }));
      const replay = fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout, cursor: 5_432 });

      await press();
      await vi.runAllTimersAsync();

      expect(action["logger"].warn).toHaveBeenCalledWith(
        "Jump to race start: the recording holds more sessions than the 11 the search maps; the latest session 2 cannot be told, aborting",
      );
      // Not the third race, which is the last one the map reached: the fourth is the latest.
      expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
      expect(replay.state.frame).toBe(5_432);
      expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
    });

    it("finds a race that started after an earlier press mapped the recording without it", async () => {
      const layout = WEEKEND.slice(0, 2);
      const replay = fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout, cursor: 5_432 });

      await press();
      await vi.runAllTimersAsync();

      expect(replay.state.frame).toBe(5_432);

      // The race is run. The cursor is still in practice, whose unique id the cached map holds.
      layout.push(WEEKEND[2]);
      await press();
      await vi.runAllTimersAsync();

      expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionNum: 2, sessionUniqueId: 3, lap: 1, frame: RACE_LAP_1_LINE - 1 }),
      );
      expect(replay.state.frame).toBe(RACE_LAP_1_LINE - 1 - 300);
    });

    it("hands the camera back when the jump back to the run-up stops short", async () => {
      const replay = fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      const moveCursor = mockReplay.setPlayPosition.getMockImplementation() as (
        mode: ReplayPosMode,
        frame: number,
      ) => boolean;
      const runUp = RACE_LAP_1_LINE - 1 - 300;

      // The search's own jumps go through; iRacing refuses the last one.
      mockReplay.setPlayPosition.mockImplementation((mode, frame) =>
        frame === runUp ? false : moveCursor(mode, frame),
      );

      await press();
      await vi.runAllTimersAsync();

      expect(action["logger"].warn).toHaveBeenCalledWith("Jump to race start: jump not sent");
      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
      expect(mockCamera.switchNum.mock.calls).toEqual([
        [POLE_CAR, 0, 0],
        [VIEWED_CAR, 0, 0],
      ]);
      expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
    });

    it("hands the camera back when the search gives up", async () => {
      const replay = fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

      // iRacing refuses every absolute jump: the search aborts at its first probe.
      mockReplay.setPlayPosition.mockImplementation(() => false);

      await press();
      await runPressOut();

      expect(action["logger"].warn).toHaveBeenCalledWith("Jump to race start: jump not sent; aborting walk");
      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
      expect(mockCamera.switchNum.mock.calls).toEqual([
        [POLE_CAR, 0, 0],
        [VIEWED_CAR, 0, 0],
      ]);
      expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
      expect(action["activeFastestLapPress"]).toBeNull();
    });

    it("leaves the camera alone when another replay command cancels the search", async () => {
      const replay = fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

      await press();
      // Inside the search's opening pause.
      await vi.advanceTimersByTimeAsync(100);
      cancelReplayCursorOwner("replay-markers next");
      await vi.runAllTimersAsync();

      expect(action["logger"].info).toHaveBeenCalledWith("Jump to race start: walk cancelled by replay-markers next");
      expect(mockCamera.switchNum).toHaveBeenCalledExactlyOnceWith(POLE_CAR, 0, 0);
      expect(replay.state.camCarIdx).toBe(POLE_CAR);
      expect(mockReplay.setPlayPosition).not.toHaveBeenCalled();
      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
      expect(action["activeFastestLapPress"]).toBeNull();
    });

    it("aborts before any replay command when the camera will not switch to the pole car", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      mockCamera.switchNum.mockImplementation(() => false);

      await press();
      await vi.runAllTimersAsync();

      expect(action["logger"].warn).toHaveBeenCalledWith("Jump to race start: camera switch failed, aborting");
      expect(countReplayCommands()).toBe(0);
      expect(action["activeFastestLapPress"]).toBeNull();
    });

    it("warns, and still applies the setting, when the camera will not switch back", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      mockCamera.switchNum.mockImplementation((carNum) => carNum === POLE_CAR);

      await press();
      await vi.runAllTimersAsync();

      expect(action["logger"].warn).toHaveBeenCalledWith(
        "Jump to race start: could not switch the camera back; it is left on the pole car",
      );
      expect(mockReplay.setPlaySpeed).toHaveBeenLastCalledWith(1, false);
    });
  });

  // A camera switch a search makes for itself outside a jump's landing step
  // (#1430): iRacing drops a camera change that arrives during a seek, and a
  // lap search follows the car on screen. Jump to Fastest Lap's search and
  // Jump to Race Start's are the same walk; both are pressed here.
  describe("the camera switches a search makes for itself (#1430)", () => {
    /** A dial jump's frame, well into the race: about half a second of seeking from the cursor. */
    const DIAL_FRAME = IN_RACE + 30_000;

    type Search = [label: string, start: () => Promise<void>];

    const SEARCHES: Search[] = [
      ["Jump to race start", () => press()],
      [
        "Jump to fastest lap",
        async () => {
          // An Always My Car key pressed while watching another car: the press
          // puts the camera on the target before the search.
          void action.walkToFastestLap(
            "ctx-fastest",
            POLE_CAR,
            9,
            2,
            { carNumberRaw: POLE_CAR, userId: 700, subSessionId: undefined },
            VIEWED_CAR,
            POLE_CAR,
          );
        },
      ],
    ];

    /** Each camera switch, with whether a seek was under way in the sim when it was sent. */
    function recordSwitches(replay: ReturnType<typeof fakeReplay>): { carNum: number; seeking: boolean }[] {
      const switches: { carNum: number; seeking: boolean }[] = [];
      const switchNum = mockCamera.switchNum.getMockImplementation() as (carNum: number) => boolean;

      mockCamera.switchNum.mockImplementation((carNum) => {
        switches.push({ carNum, seeking: replay.state.seeking });

        return switchNum(carNum);
      });

      return switches;
    }

    describe.each(SEARCHES)("%s", (label, start) => {
      it("borrows the camera for the target car at once on a quiet replay", async () => {
        const replay = fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
        const switches = recordSwitches(replay);

        await start();
        await vi.advanceTimersByTimeAsync(0);

        expect(switches).toEqual([{ carNum: POLE_CAR, seeking: false }]);
        expect(action["logger"].debug).not.toHaveBeenCalledWith(
          `${label}: a jump was still under way; camera switched anyway`,
        );
      });

      it("borrows the camera only once a jump under way has landed, and searches on the target car", async () => {
        const replay = fakeReplay(action, {
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          // The dial jump takes half a second, and its seek shows from the sim's next update.
          seekTakesMs: (distance) => (distance === DIAL_FRAME - IN_RACE ? 500 : 0),
          seekShowsAfterMs: 20,
        });
        const switches = recordSwitches(replay);

        pressReplayCommand({ kind: "jump", frame: DIAL_FRAME }, { by: "dial-frame-jog", origin: "ctx-dial" });
        await vi.advanceTimersByTimeAsync(10);
        await start();
        await vi.advanceTimersByTimeAsync(250);

        // The seek is under way: a switch sent now would be dropped.
        expect(replay.state.seeking).toBe(true);
        expect(switches).toEqual([]);

        await runPressOut();

        expect(switches[0]).toEqual({ carNum: POLE_CAR, seeking: false });
        expect(mockCamera.switchNum.mock.invocationCallOrder[0]).toBeLessThan(
          mockReplay.pause.mock.invocationCallOrder[0],
        );
        // The search ran on the target car and recorded its lap.
        expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ carIdx: POLE_CAR }),
        );
      });

      it("hands the camera back after a search that gave up only once the way back has landed", async () => {
        const replay = fakeReplay(action, {
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          // The first probe is never reached: the search gives up on it.
          seekStalls: (frame) => frame === 44_999,
        });
        const seek = mockReplay.setPlayPosition.getMockImplementation() as (
          mode: ReplayPosMode,
          frame: number,
        ) => boolean;

        // The way back takes longer than the walk waits for it, and lands later.
        mockReplay.setPlayPosition.mockImplementation((mode, frame) => {
          if (frame !== IN_RACE) return seek(mode, frame);

          replay.state.seeking = true;
          setTimeout(() => {
            replay.state.frame = IN_RACE;
            replay.state.seeking = false;
          }, 2_500);

          return true;
        });

        const switches = recordSwitches(replay);

        await start();
        await runPressOut();

        expect(action["logger"].warn).toHaveBeenCalledWith(
          `${label}: could not put the replay back; it is left paused where the search stopped`,
        );
        expect(replay.state.frame).toBe(IN_RACE);
        expect(switches).toEqual([
          { carNum: POLE_CAR, seeking: false },
          { carNum: VIEWED_CAR, seeking: false },
        ]);
        expect(action["logger"].debug).not.toHaveBeenCalledWith(
          `${label}: a jump was still under way; camera switched anyway`,
        );
      });

      it("hands the camera back anyway when the wait runs out, and says so", async () => {
        const replay = fakeReplay(action, {
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          // Every jump stalls: the probe and the way back.
          seekStalls: () => true,
        });
        const switches = recordSwitches(replay);

        await start();
        await runPressOut();

        expect(action["logger"].warn).toHaveBeenCalledWith(
          `${label}: could not put the replay back; it is left paused where the search stopped`,
        );
        expect(action["logger"].debug).toHaveBeenCalledWith(
          `${label}: a jump was still under way; camera switched anyway`,
        );
        expect(switches).toEqual([
          { carNum: POLE_CAR, seeking: false },
          { carNum: VIEWED_CAR, seeking: true },
        ]);
        expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
      });
    });

    // What the walk does when its camera never reached the target car, as a
    // switch sent into a seek is dropped: its bisection reads the target car's
    // own lap, but every lap search stops where the car on screen crosses a
    // line, and the walk's checks of the target car there fail. Pinned for each
    // way the car on screen can be off, which between them take every exit the
    // walk has here: whichever it takes, nothing reaches the record.
    describe("a search whose camera never reached the target car", () => {
      /** The car on screen crosses each line `offset` frames after the target car, and the switch onto the target is lost. */
      function cameraLeftOnAnotherCar(offset: number): ReturnType<typeof fakeReplay> {
        const replay = fakeReplay(action, {
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          lineOffsets: { [VIEWED_CAR]: offset },
        });

        mockCamera.switchNum.mockImplementation(() => true);

        return replay;
      }

      const NOT_CONVERGED = (lap: number, dist: string): string =>
        `walk did not converge (not at the end of lap ${lap} before the back-step (lap=${lap}, dist=${dist}, session=2/3)); nothing recorded`;

      it.each([
        ["well after", 2_000, "0.3998"],
        ["just after", 300, "0.0598"],
        ["just before", -300, "0.9398"],
        ["well before", -2_000, "0.5998"],
      ])(
        "Jump to Fastest Lap, the car on screen crossing each line %s the target car: rests where it got to with a warning, and records nothing",
        async (_how, offset, dist) => {
          const replay = cameraLeftOnAnotherCar(offset);

          void action.walkToFastestLap(
            "ctx-fastest",
            POLE_CAR,
            9,
            2,
            { carNumberRaw: POLE_CAR, userId: 700, subSessionId: undefined },
            VIEWED_CAR,
            POLE_CAR,
          );
          await runPressOut();

          expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
          expect(action["logger"].warn).toHaveBeenCalledExactlyOnceWith(
            `Jump to fastest lap: ${NOT_CONVERGED(8, dist)}`,
          );
          expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
          expect(action["logger"].info).not.toHaveBeenCalledWith(
            "Jump to fastest lap: replay put back where the press found it",
          );
        },
      );

      it.each<[string, number, string[], "put back" | "taken"]>([
        ["well after", 2_000, ["Jump to race start: lap-step 2 did not move the cursor; aborting"], "put back"],
        ["just after", 300, ["Jump to race start: lap-step 2 did not move the cursor; aborting"], "put back"],
        // Off by less than the run-up's bound: the frame is taken, and still not recorded.
        ["just before", -300, [`Jump to race start: ${NOT_CONVERGED(0, "0.9398")}`], "taken"],
        [
          "well before",
          -2_000,
          [
            `Jump to race start: ${NOT_CONVERGED(0, "0.5998")}`,
            "Jump to race start: the search did not reach the start of the pole car's lap 1",
          ],
          "put back",
        ],
      ])(
        "Jump to Race Start, the car on screen crossing each line %s the pole car: warns, records nothing, and the replay is %s",
        async (_how, offset, warnings, outcome) => {
          const replay = cameraLeftOnAnotherCar(offset);

          await press();
          await runPressOut();

          expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
          expect(vi.mocked(action["logger"].warn).mock.calls.map((call) => call[0])).toEqual(warnings);
          expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();

          if (outcome === "put back") {
            expect(replay.state.frame).toBe(IN_RACE);
            expect(action["logger"].info).toHaveBeenCalledWith(
              "Jump to race start: replay put back where the press found it",
            );
          } else {
            expect(replay.state.frame).not.toBe(IN_RACE);
            expect(action["logger"].info).not.toHaveBeenCalledWith(
              "Jump to race start: replay put back where the press found it",
            );
          }
        },
      );
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
      expect(action["activeFastestLapPress"]?.contextId).toBe("ctx-key");
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
