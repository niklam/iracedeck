/**
 * Replay Control's Jump to Green Flag mode (issue #1354): the press path, its
 * guards, the three ways it finds the frame, and the key's unavailable look.
 * What the press aims at is `green-flag-target.test.ts`'s; the replay search
 * it borrows is covered, as Jump to Fastest Lap's, in `replay-control.test.ts`.
 */
import { getCarNumberRawFromSessionInfo, type ReplayPosMode, type TelemetryData } from "@iracedeck/iracing-sdk";
import type { GreenLookup, GreenQuery, LapStartLookup, LapStartQuery, LapStartRecord } from "@iracedeck/replay-store";
import { getGlobalSettings } from "@iracedeck/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetReplayCursor, cancelReplayCursorOwner } from "../../shared/replay-cursor.js";
import { withSteppedReplayState } from "../../shared/test-support/replay-state.js";
import { GREEN_APPROACH_FRAMES } from "./green-flag-target.js";
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

vi.mock("@iracedeck/deck-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/deck-iracing")>()),
  getCommands: vi.fn(),
}));

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: (_fields: unknown) => ({
      parse: (data: Record<string, unknown>) => ({ ...data }),
      safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
    }),
  },
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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

type KeyEvent = Parameters<ReplayControl["onKeyDown"]>[0];
type AppearEvent = Parameters<ReplayControl["onWillAppear"]>[0];

const GREEN = { mode: "jump-to-green-flag" };

function fakeEvent(actionId: string, settings: Record<string, unknown> = GREEN) {
  return { action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn() }, payload: { settings } };
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
  };
  const bufferEnd = (): number => layout[layout.length - 1].endFrame;
  /** The frame of a session's first line crossing: into lap 1 after a grid wait, else into lap 1 after a full lap 0. */
  const firstLine = (session: SessionLayout): number => session.startFrame + (gridWait > 0 ? gridWait : FRAMES_PER_LAP);
  const findSession = (frame: number): SessionLayout | null =>
    layout.find((s) => frame >= s.startFrame && frame <= s.endFrame) ?? null;

  /** The frames a lap search can land on in `session`: `short` before each line. */
  const landings = (session: SessionLayout): number[] => {
    const frames: number[] = [];

    for (let line = firstLine(session); line <= session.endFrame; line += FRAMES_PER_LAP) {
      frames.push(line - short);
    }

    return frames;
  };

  mockReplay.goToStart.mockImplementation(() => {
    state.frame = layout[0].startFrame;

    return true;
  });
  mockReplay.nextSession.mockImplementation(() => {
    const current = findSession(state.frame);
    const next = current ? layout[layout.indexOf(current) + 1] : undefined;

    if (next) state.frame = next.startFrame;

    return true;
  });
  mockReplay.setPlayPosition.mockImplementation((_mode, frame) => {
    state.frame = Math.max(0, Math.min(bufferEnd(), frame));

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
      const sinceLine = state.frame - firstLine(session);
      // Before the first line: standing on the grid, or running lap 0.
      const lap = sinceLine < 0 ? 0 : 1 + Math.floor(sinceLine / FRAMES_PER_LAP);
      const dist =
        sinceLine >= 0
          ? (sinceLine % FRAMES_PER_LAP) / FRAMES_PER_LAP
          : gridWait > 0
            ? GRID_SLOT_DIST
            : (state.frame - session.startFrame) / FRAMES_PER_LAP;

      for (const carIdx of [VIEWED_CAR, POLE_CAR]) {
        laps[carIdx] = lap;
        dists[carIdx] = dist;
      }
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

function seekFrames(): number[] {
  return mockReplay.setPlayPosition.mock.calls.map((call) => call[1]);
}

describe("Replay Control: Jump to Green Flag (#1354)", () => {
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
    // Every press polls for a landing; a real-timer poll would outlive its test.
    vi.useFakeTimers();
    _resetFastestLapSessionCache();
    _resetReplayCursor();

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
      expect(action["logger"].info).toHaveBeenCalledWith("Jump to green: record HIT (matchedBy pair)");
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
      expect(action["logger"].info).toHaveBeenCalledWith("Jump to green: record HIT (matchedBy sessionNum)");
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
      expect(action["logger"].warn).toHaveBeenCalledWith("Jump to green: jump did not land; nothing more sent");
      expect(action["activeFastestLapPress"]).toBeNull();
    });

    it("warns and sends nothing more when iRacing refuses the seek", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      mockReplay.setPlayPosition.mockImplementation(() => false);
      greenAt(30_215);

      await press();
      await vi.runAllTimersAsync();

      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
      expect(action["logger"].warn).toHaveBeenCalledWith("Jump to green: jump not sent");
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
        "Jump to green: no race session in this replay; press ignored",
      );
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
        "Jump to green: replay session not settled yet; press ignored",
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
        "Jump to green: replay not open; iRacing ignores replay commands from the car",
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
      expect(action["logger"].info).toHaveBeenCalledWith("Jump to green: previous jump still in flight; press ignored");
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

      // The cursor reaches the frame after all: the cancelled press must not apply its speed.
      replay.state.frame = 29_915;
      await vi.runAllTimersAsync();

      expect(mockReplay.nextLap).toHaveBeenCalledTimes(1);
      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
      expect(action["logger"].info).toHaveBeenCalledWith("Jump to green: jump cancelled by next-lap");
      expect(action["activeFastestLapPress"]).toBeNull();
    });

    it("does nothing on a dial: a single moment has no direction to turn in", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      greenAt(30_215);

      await action.onDialRotate({
        action: { id: "ctx-dial" },
        payload: { settings: GREEN, ticks: 1 },
      } as unknown as Parameters<ReplayControl["onDialRotate"]>[0]);
      await action.onDialDown({
        action: { id: "ctx-dial" },
        payload: { settings: GREEN },
      } as unknown as Parameters<ReplayControl["onDialDown"]>[0]);
      await vi.runAllTimersAsync();

      expect(countReplayCommands()).toBe(0);
      expect(mockStore.greens.findGreen).not.toHaveBeenCalled();
    });
  });

  describe("no recorded green: the pole car's lap 1 from the lap record", () => {
    it("is one waited jump to five seconds before that lap start, with no camera switch", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE, subSessionId: 89_265_205 });
      lapOneAt(25_090);

      await press();
      await vi.runAllTimersAsync();

      expect(action["logger"].info).toHaveBeenCalledWith(
        "Jump to green: record MISS (no green); falling back to lap 1 of the pole car",
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
      expect(action["logger"].info).toHaveBeenCalledWith("Jump to green: lap record HIT (matchedBy pair)");
    });

    it("names the store's reason in the MISS line", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      mockStore.greens.findGreen.mockImplementation(() => ({ hit: false, reason: "no file" }));
      lapOneAt(25_090);

      await press();
      await vi.runAllTimersAsync();

      expect(action["logger"].info).toHaveBeenCalledWith(
        "Jump to green: record MISS (no file); falling back to lap 1 of the pole car",
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
        "Jump to green: no pole car and no viewed car to take lap 1 from; press ignored",
      );
    });
  });

  describe("no recorded green and no lap record: a search of the replay", () => {
    it("borrows the camera for the pole car, lands five seconds before its lap 1, and hands the camera back before playback", async () => {
      const replay = fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

      await press();
      await vi.runAllTimersAsync();

      expect(action["logger"].info).toHaveBeenCalledWith(
        "Jump to green: lap record MISS (no file); searching the replay",
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

    it("logs the search as its own, not as Jump to Fastest Lap's", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

      await press();
      await vi.runAllTimersAsync();

      const lines = [
        ...vi.mocked(action["logger"].info).mock.calls,
        ...vi.mocked(action["logger"].debug).mock.calls,
        ...vi.mocked(action["logger"].warn).mock.calls,
      ].map((call) => String(call[0]));

      expect(lines).toContain("Jump to green: walk converged (lap start recorded)");
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
        expect.stringContaining("Jump to green: walk did not converge"),
      );
      // Nothing unverified goes into the lap record...
      expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
      // ...but the landing is near enough to anchor a five-second run-up.
      expect(replay.state.frame).toBe(RACE_LAP_1_LINE - 11 - 300);
      expect(mockReplay.setPlaySpeed).toHaveBeenLastCalledWith(1, false);
      expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
    });

    it("leaves the replay where the search stopped when the landing is too far from the line", async () => {
      // 100 frames short: dist 0.98, outside what the run-up absorbs.
      const replay = fakeReplay(action, {
        sessionTypes: WEEKEND_TYPES,
        layout: WEEKEND,
        cursor: IN_RACE,
        lapSearchShort: 100,
      });

      await press();
      await vi.runAllTimersAsync();

      expect(action["logger"].warn).toHaveBeenCalledWith(
        "Jump to green: the search did not reach the start of the pole car's lap 1; replay left where it stopped",
      );
      // The search's two-tick back-step is the last seek: no run-up jump, and no speed command.
      expect(replay.state.frame).toBe(RACE_LAP_1_LINE - 100 - 2);
      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
      // The camera goes back all the same.
      expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
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
        "Jump to green: the search did not reach the start of the pole car's lap 1; replay left where it stopped",
      );
      expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
      expect(replay.state.frame).toBe(10_999 - 2);
      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
    });

    it("puts the cursor back when the race is not in the recording yet", async () => {
      // A live event still in qualifying: the session list names the race, the tape does not hold it.
      const layout = WEEKEND.slice(0, 2);
      const replay = fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout, cursor: 5_432 });

      await press();
      await vi.runAllTimersAsync();

      // An expected state of a live event, not a fault: info, and no warning.
      expect(action["logger"].info).toHaveBeenCalledWith(
        "Jump to green: the target session is not in this recording yet; replay put back",
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
        "Jump to green: the recording holds more sessions than the 11 the search maps; the latest session 2 cannot be told, aborting",
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

      expect(action["logger"].warn).toHaveBeenCalledWith("Jump to green: jump not sent");
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
      await vi.runAllTimersAsync();

      expect(action["logger"].warn).toHaveBeenCalledWith("Jump to green: jump not sent; aborting walk");
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

      expect(action["logger"].info).toHaveBeenCalledWith("Jump to green: walk cancelled by replay-markers next");
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

      expect(action["logger"].warn).toHaveBeenCalledWith("Jump to green: camera switch failed, aborting");
      expect(countReplayCommands()).toBe(0);
      expect(action["activeFastestLapPress"]).toBeNull();
    });

    it("warns, and still applies the setting, when the camera will not switch back", async () => {
      fakeReplay(action, { sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      mockCamera.switchNum.mockImplementation((carNum) => carNum === POLE_CAR);

      await press();
      await vi.runAllTimersAsync();

      expect(action["logger"].warn).toHaveBeenCalledWith(
        "Jump to green: could not switch the camera back; it is left on the pole car",
      );
      expect(mockReplay.setPlaySpeed).toHaveBeenLastCalledWith(1, false);
    });
  });

  describe("the key", () => {
    const lastIcon = () => mockAssembleIcon.mock.calls.at(-1)?.[0] as Record<string, unknown>;

    it("has its own title and artwork", () => {
      const uri = generateReplayControlSvg({ mode: "jump-to-green-flag" });

      expect(uri).toContain("GREEN\nFLAG");
      expect(String(lastIcon().graphicSvg)).toContain("<svg");
      expect(lastIcon().dimmed).toBeUndefined();
      expect(lastIcon().colors).toEqual({ backgroundColor: "#101010", textColor: "#ffffff", graphic1Color: "#2ecc71" });
    });

    it("draws the unavailable look greyed and faded, background kept", () => {
      generateReplayControlSvg({ mode: "jump-to-green-flag" }, false, undefined, undefined, false, true);

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
