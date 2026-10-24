/**
 * Jump to Race Start (#1354; moved out of Replay Control's suite with the
 * press in #1467): the press path, its guards and the three ways it finds the
 * frame, against a fake controller, replay and camera. What the press aims at
 * is `green-flag-target.test.ts`'s; the replay search it borrows is covered,
 * as Jump to Fastest Lap's, in `fastest-lap-press.test.ts`, except for the
 * camera switches a search makes for itself (#1430), which are pinned here
 * for both presses on this file's replay of laps and cars. What the key and
 * the dial do around a press — the key's unavailable look, the busy
 * indicator, the dial's gesture — stays in Replay Control's
 * `replay-control-race-start.test.ts`.
 */
import type { ReplayJumpPlayback } from "@iracedeck/app-constants";
import {
  getCarNumberRawFromSessionInfo,
  type ReplayPosMode,
  replaySpeedFromTelemetry,
  replaySpeedToSdk,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import type { GreenLookup, GreenQuery, LapStartLookup, LapStartQuery, LapStartRecord } from "@iracedeck/replay-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requestCameraSwitch } from "./camera-switch-waiter.js";
import { type LapPressResult, pressJumpToFastestLap, walkToFastestLap } from "./fastest-lap-press.js";
import { GREEN_APPROACH_FRAMES } from "./green-flag-target.js";
import { _activeLapPress } from "./lap-press.js";
import { pressJumpToRaceStart } from "./race-start-press.js";
import {
  FRAMES_PER_LAP,
  IN_RACE,
  POLE_CAR,
  RACE_LAP_1_LINE,
  RACE_START,
  type RaceWeekendOptions,
  raceWeekendReplay,
  type RaceWeekendSession as SessionLayout,
  VIEWED_CAR,
  WEEKEND,
  WEEKEND_TYPES,
} from "./race-weekend-replay.test-support.js";
import { pressReplayCommand, type ReplayGateFactEnd, subscribeReplayGate } from "./replay-command-gate.js";
import { cancelReplayCursorOwner } from "./replay-cursor.js";
import { _resetReplayEngine } from "./replay-engine-reset.js";
import { configureTestEngine, type SpyLogger, type TestControllerReads } from "./replay-engine.test-support.js";
import { watchReplayLeft } from "./replay-left.test-support.js";
import { RECORD_STEPS } from "./replay-record-step.js";
import { shownReplaySpeed } from "./replay-speed-view.js";
import { withSteppedReplayState } from "./replay-state.test-support.js";

vi.mock("@iracedeck/iracing-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/iracing-sdk")>()),
  getCarNumberRawFromSessionInfo: vi.fn(),
}));

vi.mock("@iracedeck/replay-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/replay-store")>()),
  getReplaySessionStore: vi.fn(),
  isReplaySessionStoreInitialized: vi.fn(() => false),
}));

/** The two settings the engine reads (#1467), as the cases set them; read at the time of use. */
const settings: { replayJumpPlayback: ReplayJumpPlayback | undefined; fastestLapSearchDelayMs: number | undefined } = {
  replayJumpPlayback: undefined,
  fastestLapSearchDelayMs: undefined,
};

const mockReplay = {
  play: vi.fn(() => true),
  pause: vi.fn(() => true),
  setPlaySpeed: vi.fn<(speed: number, slowMotion?: boolean) => boolean>(() => true),
  setPlayPosition: vi.fn<(mode: ReplayPosMode, frameNumber: number) => boolean>(() => true),
  nextFrame: vi.fn(() => true),
  prevFrame: vi.fn(() => true),
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

/**
 * The SDK controller the engine reads (#1467): telemetry and session info the
 * race weekend replaces, and the controller's debounced replay state (#1324)
 * stepped from them at every read, as Replay Control's mocked controller had it.
 */
let controller: TestControllerReads;

/** The race weekend of `options` over this file's controller, replay and camera (`race-weekend-replay.test-support.ts`). */
function fakeReplay(options: RaceWeekendOptions): ReturnType<typeof raceWeekendReplay> {
  return raceWeekendReplay(controller, { replay: mockReplay, camera: mockCamera }, options);
}

function setJumpPlayback(mode: "remember" | "play" | "stopped"): void {
  settings.fastestLapSearchDelayMs = 400;
  settings.replayJumpPlayback = mode;
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
  /** The engine's `ReplayControl` scope: where the press and the walk log. */
  let logger: SpyLogger;

  /** One Jump to Race Start press under `origin`, as the key and the dial make it. */
  async function press(origin = "ctx-green"): Promise<LapPressResult> {
    return pressJumpToRaceStart({ origin });
  }

  /** The speed the keys show and step from: the engine's one record of it over a fresh read (#1467). */
  function shownSpeed(): { speed: number; slowMotion: boolean } {
    const telemetry = controller.getCurrentTelemetry();

    return shownReplaySpeed(telemetry ? replaySpeedFromTelemetry(telemetry) : null, Date.now());
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

    const { getReplaySessionStore, isReplaySessionStoreInitialized } = await import("@iracedeck/replay-store");

    vi.mocked(getCarNumberRawFromSessionInfo).mockImplementation((_sessionInfo: unknown, idx: number) => idx);
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
    controller = withSteppedReplayState({
      getCurrentTelemetry: vi.fn((): TelemetryData | null => null),
      getSessionInfo: vi.fn((): unknown => null),
    });
    // Every engine module reset — the walk's session-map cache, the in-flight
    // slot and the shared replay-cursor claim included — so each test starts
    // with nothing under way. The replay command gate (#1430) reads the replay
    // these tests simulate, so the jumps a press sends read back and nothing
    // stands after a walk.
    ({ logger } = configureTestEngine({
      controller,
      replay: mockReplay,
      camera: mockCamera,
      settings: {
        replayJumpPlayback: () => settings.replayJumpPlayback,
        fastestLapSearchDelayMs: () => settings.fastestLapSearchDelayMs,
      },
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    // Nothing under way after a case: a gate left polling would otherwise have its timer fire in a later test.
    _resetReplayEngine();
  });

  describe("a recorded green", () => {
    it("is one waited jump to five seconds before it, with no camera switch and no search", async () => {
      fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE, subSessionId: 89_265_205 });
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
      expect(logger.info).toHaveBeenCalledWith("Jump to race start: record HIT (matchedBy pair)");
      expect(_activeLapPress()).toBeNull();
    });

    it("never sends play() itself: the Replay jump playback setting decides what follows", async () => {
      fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
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
      fakeReplay({
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
      fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: 5_000 });
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
      expect(logger.info).toHaveBeenCalledWith("Jump to race start: record HIT (matchedBy sessionNum)");
    });

    it("targets the feature, the last race session, from outside a heat event's races", async () => {
      fakeReplay({
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
      fakeReplay({
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
      fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      // The seek is taken but the cursor stays put.
      mockReplay.setPlayPosition.mockImplementation(() => true);
      greenAt(30_215);

      await press();
      await vi.runAllTimersAsync();

      expect(mockReplay.setPlayPosition).toHaveBeenCalledTimes(1);
      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith("Jump to race start: jump did not land; nothing more sent");
      expect(_activeLapPress()).toBeNull();
    });

    it("warns and sends nothing more when iRacing refuses the seek", async () => {
      fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      mockReplay.setPlayPosition.mockImplementation(() => false);
      greenAt(30_215);

      await press();
      await vi.runAllTimersAsync();

      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith("Jump to race start: jump not sent");
    });

    it("pauses a moving replay before the seek, and restores its speed under Remember", async () => {
      const replay = fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      const readPaused = controller.getCurrentTelemetry;

      // Playing at 2x until the sequence's pause has been sent.
      controller.getCurrentTelemetry = vi.fn(
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
      fakeReplay({ sessionTypes: ["Practice"], layout: [WEEKEND[0]], cursor: 5_000 });

      const result = await press();
      await vi.runAllTimersAsync();

      expect(countReplayCommands()).toBe(0);
      expect(mockCamera.switchNum).not.toHaveBeenCalled();
      expect(mockStore.greens.findGreen).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith("Jump to race start: no race session in this replay; press ignored");
      // Not a press ignored behind one in flight: refused, which the key leaves out of the busy look (#1437).
      expect(result).toEqual({ kind: "refused", reason: "no race session" });
    });

    it("ignores a press on the SessionNum -1 tick after a seek", async () => {
      fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      const settled = controller.getCurrentTelemetry;

      controller.getCurrentTelemetry = vi.fn(() => ({ ...settled(), SessionNum: -1 }) as TelemetryData);
      greenAt(30_215);

      await press();
      await vi.runAllTimersAsync();

      expect(countReplayCommands()).toBe(0);
      expect(mockStore.greens.findGreen).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith("Jump to race start: replay session not settled yet; press ignored");
    });

    it("sends nothing from the car, where iRacing ignores replay commands", async () => {
      const replay = fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

      replay.state.inReplay = false;
      greenAt(30_215);

      await press();
      await vi.runAllTimersAsync();

      expect(countReplayCommands()).toBe(0);
      expect(mockCamera.switchNum).not.toHaveBeenCalled();
      expect(mockStore.greens.findGreen).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        "Jump to race start: replay not open; iRacing ignores replay commands from the car",
      );
    });

    it("ignores a second press while the first is in flight, and leaves the first to finish", async () => {
      const replay = fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

      // The seek is taken but the cursor stays put until the test moves it.
      mockReplay.setPlayPosition.mockImplementation(() => true);
      greenAt(30_215);

      const first = await press("ctx-a");
      await vi.advanceTimersByTimeAsync(200);
      const second = await press("ctx-b");
      await vi.advanceTimersByTimeAsync(200);

      expect(mockReplay.setPlayPosition).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith("Jump to race start: previous jump still in flight; press ignored");
      // The ignored press is the one the key shows not done (#1437); the first is left alone.
      expect(first).toEqual({ kind: "started" });
      expect(second).toEqual({ kind: "ignored" });
      expect(_activeLapPress()?.origin).toBe("ctx-a");

      // iRacing reaches the frame: the first press, not cancelled by the second, applies the setting.
      replay.state.frame = 29_915;
      await vi.runAllTimersAsync();

      expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
      expect(_activeLapPress()).toBeNull();
    });

    it("shares the in-flight slot with Jump to Fastest Lap, in both directions", async () => {
      fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      mockReplay.setPlayPosition.mockImplementation(() => true);
      greenAt(30_215);

      await press("ctx-green");
      await vi.advanceTimersByTimeAsync(200);

      const telemetry = controller.getCurrentTelemetry;

      // A fastest lap to jump to, so the press gets as far as the in-flight check.
      controller.getCurrentTelemetry = vi.fn(() => {
        const best: number[] = [];

        best[VIEWED_CAR] = 2;

        return { ...telemetry(), CarIdxBestLapNum: best } as TelemetryData;
      });
      const fastest = pressJumpToFastestLap({ origin: "ctx-fastest", target: "viewed-car" });

      expect(logger.info).toHaveBeenCalledWith("Jump to fastest lap: previous press still in flight; press ignored");
      expect(fastest).toEqual({ kind: "ignored" });
      expect(mockReplay.setPlayPosition).toHaveBeenCalledTimes(1);
      expect(mockCamera.switchNum).not.toHaveBeenCalled();
    });

    it("is cancelled by any other replay command, and then sends nothing more", async () => {
      const replay = fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

      mockReplay.setPlayPosition.mockImplementation(() => true);
      greenAt(30_215);

      await press("ctx-green");
      await vi.advanceTimersByTimeAsync(200);
      // The Next Lap key on a record miss: iRacing's own search, through the gate.
      pressReplayCommand(
        { kind: "search", search: RECORD_STEPS["next-lap"].search },
        { by: "next-lap", origin: "ctx-lap" },
      );

      expect(logger.info).toHaveBeenCalledWith("Jump to race start: jump cancelled by next-lap");
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
      expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining("landed on"));
      expect(_activeLapPress()).toBeNull();
    });
  });

  describe("no recorded green: the pole car's lap 1 from the lap record", () => {
    it("is one waited jump to five seconds before that lap start, with no camera switch", async () => {
      fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE, subSessionId: 89_265_205 });
      lapOneAt(25_090);

      await press();
      await vi.runAllTimersAsync();

      expect(logger.info).toHaveBeenCalledWith(
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
      expect(logger.info).toHaveBeenCalledWith("Jump to race start: lap record HIT (matchedBy pair)");
    });

    it("names the store's reason in the MISS line", async () => {
      fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      mockStore.greens.findGreen.mockImplementation(() => ({ hit: false, reason: "no file" }));
      lapOneAt(25_090);

      await press();
      await vi.runAllTimersAsync();

      expect(logger.info).toHaveBeenCalledWith(
        "Jump to race start: record MISS (no file); falling back to lap 1 of the pole car",
      );
    });

    it("takes the viewed car's lap 1 when the session has no qualifying grid", async () => {
      fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE, grid: false });
      lapOneAt(25_400);

      await press();
      await vi.runAllTimersAsync();

      expect(mockStore.laps.findLapStart.mock.calls[0][0]).toMatchObject({ carIdx: VIEWED_CAR, lap: 1 });
      expect(mockReplay.setPlayPosition).toHaveBeenCalledExactlyOnceWith(expect.anything(), 25_100);
    });

    it("takes the viewed car's lap 1 when the pole sitter took no part in the target race", async () => {
      // A heat whose results list the viewed car and not the qualifying pole sitter.
      fakeReplay({
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
      fakeReplay({
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
      fakeReplay({
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
      expect(logger.warn).toHaveBeenCalledWith(
        "Jump to race start: no pole car and no viewed car to take lap 1 from; press ignored",
      );
    });
  });

  describe("no recorded green and no lap record: a search of the replay", () => {
    it("borrows the camera for the pole car, lands five seconds before its lap 1, and hands the camera back before playback", async () => {
      const replay = fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

      await press();
      await vi.runAllTimersAsync();

      expect(logger.info).toHaveBeenCalledWith("Jump to race start: lap record MISS (no file); searching the replay");
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
      expect(_activeLapPress()).toBeNull();
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
        fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

        const ends = await walkEnds(async () => {
          await press();
          await vi.runAllTimersAsync();
        });

        expect(ends.at(-1)).toEqual({ fact: "underWay", class: "completed", reason: "jump-landed" });
        expect(ends.some((end) => end.reason === "walk-gave-up")).toBe(false);
      });

      it("ends given up when it puts the replay back", async () => {
        fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE, lapSearchShort: 600 });

        const ends = await walkEnds(async () => {
          await press();
          await vi.runAllTimersAsync();
        });

        expect(ends).toEqual([{ fact: "underWay", class: "gave-up", reason: "walk-gave-up" }]);
      });
    });

    it("logs the search as its own, not as Jump to Fastest Lap's", async () => {
      fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

      await press();
      await vi.runAllTimersAsync();

      const lines = [
        ...vi.mocked(logger.info).mock.calls,
        ...vi.mocked(logger.debug).mock.calls,
        ...vi.mocked(logger.warn).mock.calls,
      ].map((call) => String(call[0]));

      expect(lines).toContain("Jump to race start: walk converged (lap start recorded)");
      expect(lines.filter((line) => line.startsWith("Jump to fastest lap"))).toEqual([]);
    });

    it("does not touch the camera when the pole car is already on screen", async () => {
      fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE, viewedCarIdx: POLE_CAR });

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

      fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: restarted, cursor: 5_000 });

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

      fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: restarted, cursor: IN_RACE });

      await press();
      await vi.runAllTimersAsync();

      expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionUniqueId: 3, frame: RACE_LAP_1_LINE - 1 }),
      );
      expect(seekFrames().at(-1)).toBe(RACE_LAP_1_LINE - 1 - 300);
    });

    it("still lands when iRacing's lap search stops a few frames short of what the search can verify (#1432)", async () => {
      // Eleven frames before the line on a 5000-frame lap: dist 0.9978, under the record's 0.999.
      const replay = fakeReplay({
        sessionTypes: WEEKEND_TYPES,
        layout: WEEKEND,
        cursor: IN_RACE,
        lapSearchShort: 11,
      });

      await press();
      await vi.runAllTimersAsync();

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Jump to race start: walk did not converge"));
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
      const replay = fakeReplay({
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
      const replay = fakeReplay({
        sessionTypes: WEEKEND_TYPES,
        layout: WEEKEND,
        cursor: IN_RACE,
        lapSearchShort: 600,
      });

      await press();
      await vi.runAllTimersAsync();

      expect(logger.warn).toHaveBeenCalledWith(
        "Jump to race start: the search did not reach the start of the pole car's lap 1",
      );
      // No run-up jump: the search's back-step, then the way back to where the press was made.
      expect(seekFrames().slice(-2)).toEqual([RACE_LAP_1_LINE - 600 - 2, IN_RACE]);
      expect(replay.state.frame).toBe(IN_RACE);
      expect(logger.info).toHaveBeenCalledWith("Jump to race start: replay put back where the press found it");
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
      const replay = fakeReplay({ sessionTypes: ["Race"], layout: [race], cursor: 20_000, gridWaitFrames });
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
      const replay = fakeReplay({ sessionTypes: ["Race"], layout: [race], cursor: 20_000, gridWaitFrames });

      // iRacing's lap search does nothing: the probe in the grid wait is all the search has.
      mockReplay.nextLap.mockImplementation(() => true);

      await press();
      await vi.runAllTimersAsync();

      // The pole car reads lap 0 at 0.9995 there, inside both bounds, and it is still not the line.
      expect(logger.warn).toHaveBeenCalledWith(
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
        const replay = fakeReplay({
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
        expect(logger.warn).not.toHaveBeenCalled();
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
        const replay = fakeReplay({
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
        expect(logger.warn).not.toHaveBeenCalled();
        expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ lap: 1, frame: line - 1 }),
        );
        expect(replay.state.frame).toBe(line - 1 - 300);
      });

      it("reads a car gone after a frame that showed it as no information: it may be back", async () => {
        // On track for laps 0 to 5, in the garage for 14 000 frames, out again from lap 8.
        const replay = fakeReplay({
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          viewedCarIdx: POLE_CAR,
          onTrack: (carIdx, frame) => carIdx !== POLE_CAR || frame < 46_000 || frame >= 60_000,
        });
        const lapNine = RACE_START + 9 * FRAMES_PER_LAP;

        void walkToFastestLap("ctx-green", POLE_CAR, 9, 2, {
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
        expect(logger.warn).not.toHaveBeenCalled();
        expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ carIdx: POLE_CAR, lap: 9, frame: lapNine - 1 }),
        );
        expect(replay.state.frame).toBe(lapNine - 1 - 2);
      });

      it("steps from the nearest frame that showed the car when the probes run out on one that did not", async () => {
        // The pole car is on track only late in the race, from what the tape counts as lap 6.
        const replay = fakeReplay({
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
        expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
          "Jump to race start: CarIdxLap unavailable during lap-step 1 (lap=-1); aborting",
        );
        expect(replay.state.frame).toBe(IN_RACE);
        expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
      });

      it("gives up on a pole car that was never on track, and puts the replay back", async () => {
        const replay = fakeReplay({
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          onTrack: (carIdx) => carIdx !== POLE_CAR,
        });

        await press();
        await vi.runAllTimersAsync();

        expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
          "Jump to race start: carIdx 7 was not found on track in session 2/3; aborting",
        );
        // Five rounds of halving, none of which moved a bound, then the way back.
        expect(seekFrames()).toHaveLength(31 + 1);
        expect(seekFrames().at(-1)).toBe(IN_RACE);
        expect(replay.state.frame).toBe(IN_RACE);
        expect(logger.info).toHaveBeenCalledWith("Jump to race start: replay put back where the press found it");
        expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
        expect(mockReplay.nextLap).not.toHaveBeenCalled();
        expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
        // The camera goes back once the way back has landed, never into the seek.
        expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
        expect(mockCamera.switchNum.mock.invocationCallOrder.at(-1) as number).toBeGreaterThan(
          mockReplay.setPlayPosition.mock.invocationCallOrder.at(-1) as number,
        );
        expect(_activeLapPress()).toBeNull();
      });

      it("gives a playing replay its speed back after a search that found no car, whatever the setting", async () => {
        const replay = fakeReplay({
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          onTrack: (carIdx) => carIdx !== POLE_CAR,
        });
        const readPaused = controller.getCurrentTelemetry;

        // Playing at 2x until the search's opening pause, and again once a speed is sent.
        controller.getCurrentTelemetry = vi.fn(() => {
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
      const replay = fakeReplay({
        sessionTypes: WEEKEND_TYPES,
        layout: WEEKEND,
        cursor: IN_RACE,
        onTrack: (carIdx) => carIdx !== POLE_CAR,
      });
      const readPaused = controller.getCurrentTelemetry;

      // Playing at 2x until the search's opening pause.
      controller.getCurrentTelemetry = vi.fn(() => {
        const paused = mockReplay.pause.mock.calls.length > 0;

        return { ...readPaused(), ReplayPlaySpeed: paused ? 0 : 2 } as TelemetryData;
      });
      mockReplay.setPlaySpeed.mockImplementation(() => false);

      await press();
      await vi.runAllTimersAsync();

      expect(replay.state.frame).toBe(IN_RACE);
      expect(logger.warn).toHaveBeenCalledWith(
        "Jump to race start: speed command failed; replay left paused on the frame the press found it on",
      );
      expect(logger.info).not.toHaveBeenCalledWith("Jump to race start: replay put back where the press found it");
      // The keys read paused (#1467: the engine's one record of the speed), so the Play key plays.
      expect(shownSpeed().speed).toBe(0);
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
        const replay = fakeReplay({
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
        expect(logger.info).toHaveBeenCalledWith(
          "Jump to race start: session map built — subSession=123, S0/1[0-1295999], S1/2[1296000-end]",
        );
        expect(logger.warn).not.toHaveBeenCalled();
        expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ sessionNum: 1, lap: 1, frame: raceStart + FRAMES_PER_LAP - 1 }),
        );
        expect(replay.state.frame).toBe(raceStart + FRAMES_PER_LAP - 1 - 300);
      });

      it("sends no search from the last session a real event lists", async () => {
        fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE, subSessionId: 123 });

        await press();
        await vi.runAllTimersAsync();

        // Practice to qualifying, qualifying to the race, and nothing from the race.
        expect(mockReplay.nextSession).toHaveBeenCalledTimes(2);
        expect(logger.debug).toHaveBeenCalledWith(
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
        const replay = fakeReplay({
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
        expect(logger.debug).toHaveBeenCalledWith(
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
        const replay = fakeReplay({
          sessionTypes: ["Practice", "Race"],
          layout,
          cursor: SIX_HOURS + day - 10_000,
          subSessionId: 123,
          sessionSearchTakesMs,
          seekTakesMs: sessionSearchTakesMs,
        });

        await press();
        await vi.runAllTimersAsync();

        expect(logger.warn).not.toHaveBeenCalled();
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
        const replay = fakeReplay({
          sessionTypes: ["Race"],
          layout: [LONG_RACE],
          cursor: 2_000,
          seekTakesMs,
        });

        await press();
        await vi.runAllTimersAsync();

        // Three times the settle timeout of 1.6 s had passed before that probe landed.
        expect(seekFrames()[0]).toBe(648_000);
        expect(logger.warn).not.toHaveBeenCalled();
        expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ lap: 1, frame: FRAMES_PER_LAP - 1 }),
        );
        expect(replay.state.frame).toBe(FRAMES_PER_LAP - 1 - 300);
      });

      it("still gives up on a long jump that never lands, and puts the replay back", async () => {
        const replay = fakeReplay({
          sessionTypes: ["Race"],
          layout: [LONG_RACE],
          cursor: 2_000,
          seekTakesMs,
          seekStalls: (frame) => frame === 648_000,
        });

        await press();
        await vi.runAllTimersAsync();

        expect(logger.warn).toHaveBeenCalledExactlyOnceWith("Jump to race start: jump did not settle; aborting walk");
        expect(seekFrames()).toEqual([648_000, 2_000]);
        expect(replay.state.frame).toBe(2_000);
        expect(logger.info).toHaveBeenCalledWith("Jump to race start: replay put back where the press found it");
      });
    });

    describe("a jump the search stops waiting for", () => {
      it("puts the replay back, and the camera only once that has landed", async () => {
        // The first probe is still being sought when the search gives up on it:
        // the way back goes into that seek, and replaces it.
        const replay = fakeReplay({
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          seekStalls: (frame) => frame === 44_999,
        });

        await press();
        await vi.runAllTimersAsync();

        expect(logger.warn).toHaveBeenCalledExactlyOnceWith("Jump to race start: jump did not settle; aborting walk");
        expect(seekFrames()).toEqual([44_999, IN_RACE]);
        expect(replay.state.frame).toBe(IN_RACE);
        expect(replay.state.seeking).toBe(false);
        expect(logger.info).toHaveBeenCalledWith("Jump to race start: replay put back where the press found it");
        expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
        // Borrowed for the pole car, and returned after the way back landed.
        expect(mockCamera.switchNum.mock.calls.map((call) => call[0])).toEqual([POLE_CAR, VIEWED_CAR]);
        expect(mockCamera.switchNum.mock.invocationCallOrder[1]).toBeGreaterThan(
          mockReplay.setPlayPosition.mock.invocationCallOrder[1],
        );
        expect(_activeLapPress()).toBeNull();
      });

      it("says so when the way back does not land either, and leaves the replay paused", async () => {
        const replay = fakeReplay({
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          seekStalls: () => true,
        });

        await press();
        await runPressOut();

        expect(logger.warn).toHaveBeenCalledWith("Jump to race start: jump did not settle; aborting walk");
        expect(logger.warn).toHaveBeenCalledWith(
          "Jump to race start: could not put the replay back; it is left paused where the search stopped",
        );
        expect(seekFrames()).toEqual([44_999, IN_RACE]);
        expect(logger.info).not.toHaveBeenCalledWith("Jump to race start: replay put back where the press found it");
        expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
        expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
        expect(_activeLapPress()).toBeNull();
      });

      it("sends nothing more when another replay command arrives during the way back", async () => {
        const replay = fakeReplay({
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

        expect(logger.info).toHaveBeenCalledWith("Jump to race start: walk cancelled by next-lap");
        expect(logger.info).not.toHaveBeenCalledWith("Jump to race start: replay put back where the press found it");
        // That command's effect stands: no speed command, and the camera is left on the pole car.
        expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
        expect(replay.state.camCarIdx).toBe(POLE_CAR);
        expect(_activeLapPress()).toBeNull();
      });
    });

    describe("Jump to Fastest Lap takes the same way back", () => {
      it("returns the camera to the car that was on screen when its search finds no car", async () => {
        // An Always My Car key pressed while watching another car: the press put
        // the camera on the target before the search.
        const replay = fakeReplay({
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          viewedCarIdx: POLE_CAR,
          onTrack: (carIdx) => carIdx !== POLE_CAR,
        });

        void walkToFastestLap(
          "ctx-green",
          POLE_CAR,
          9,
          2,
          { carNumberRaw: POLE_CAR, userId: 700, subSessionId: undefined },
          VIEWED_CAR,
          // The camera goes back only when the press moved it (#1428): it switched onto the target car.
          POLE_CAR,
        );
        await vi.runAllTimersAsync();

        expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
          "Jump to fastest lap: carIdx 7 was not found on track in session 2/3; aborting",
        );
        expect(replay.state.frame).toBe(IN_RACE);
        expect(logger.info).toHaveBeenCalledWith("Jump to fastest lap: replay put back where the press found it");
        expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
        expect(mockCamera.switchNum.mock.invocationCallOrder.at(-1) as number).toBeGreaterThan(
          mockReplay.setPlayPosition.mock.invocationCallOrder.at(-1) as number,
        );
      });

      it("sends no camera command when the search was for the car on screen", async () => {
        fakeReplay({
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          viewedCarIdx: POLE_CAR,
          onTrack: (carIdx) => carIdx !== POLE_CAR,
        });

        void walkToFastestLap("ctx-green", POLE_CAR, 9, 2, {
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
      const replay = fakeReplay({ sessionTypes: WEEKEND_TYPES, layout, cursor: 5_432 });

      await press();
      await vi.runAllTimersAsync();

      // An expected state of a live event, not a fault: info, and no warning.
      expect(logger.info).toHaveBeenCalledWith("Jump to race start: the target session is not in this recording yet");
      expect(logger.info).toHaveBeenCalledWith("Jump to race start: replay put back where the press found it");
      expect(logger.warn).not.toHaveBeenCalled();
      // The map build walked through the recording; the user's place is restored.
      expect(mockReplay.nextSession).toHaveBeenCalled();
      expect(replay.state.frame).toBe(5_432);
      expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
      // The replay was paused at the press, and stays so: Play is the setting, and nothing was jumped to.
      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
      expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
      expect(_activeLapPress()).toBeNull();
    });

    it("gives a playing replay its speed back when the race is not in the recording, whatever the setting", async () => {
      const layout = WEEKEND.slice(0, 2);
      const replay = fakeReplay({ sessionTypes: WEEKEND_TYPES, layout, cursor: 5_432 });
      const readPaused = controller.getCurrentTelemetry;

      // Playing at 2x until the search's opening pause, and again once a speed is sent.
      controller.getCurrentTelemetry = vi.fn(() => {
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
      const replay = fakeReplay({ sessionTypes: WEEKEND_TYPES, layout, cursor: 5_432 });

      await press();
      await vi.runAllTimersAsync();

      expect(logger.warn).toHaveBeenCalledWith(
        "Jump to race start: the recording holds more sessions than the 11 the search maps; the latest session 2 cannot be told, aborting",
      );
      // Not the third race, which is the last one the map reached: the fourth is the latest.
      expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
      expect(replay.state.frame).toBe(5_432);
      expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
    });

    it("finds a race that started after an earlier press mapped the recording without it", async () => {
      const layout = WEEKEND.slice(0, 2);
      const replay = fakeReplay({ sessionTypes: WEEKEND_TYPES, layout, cursor: 5_432 });

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
      const replay = fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
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

      expect(logger.warn).toHaveBeenCalledWith("Jump to race start: jump not sent");
      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
      expect(mockCamera.switchNum.mock.calls).toEqual([
        [POLE_CAR, 0, 0],
        [VIEWED_CAR, 0, 0],
      ]);
      expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
    });

    it("hands the camera back when the search gives up", async () => {
      const replay = fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

      // iRacing refuses every absolute jump: the search aborts at its first probe.
      mockReplay.setPlayPosition.mockImplementation(() => false);

      await press();
      await runPressOut();

      expect(logger.warn).toHaveBeenCalledWith("Jump to race start: jump not sent; aborting walk");
      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
      expect(mockCamera.switchNum.mock.calls).toEqual([
        [POLE_CAR, 0, 0],
        [VIEWED_CAR, 0, 0],
      ]);
      expect(replay.state.camCarIdx).toBe(VIEWED_CAR);
      expect(_activeLapPress()).toBeNull();
    });

    it("leaves the camera alone when another replay command cancels the search", async () => {
      const replay = fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });

      await press();
      // Inside the search's opening pause.
      await vi.advanceTimersByTimeAsync(100);
      cancelReplayCursorOwner("replay-markers next");
      await vi.runAllTimersAsync();

      expect(logger.info).toHaveBeenCalledWith("Jump to race start: walk cancelled by replay-markers next");
      expect(mockCamera.switchNum).toHaveBeenCalledExactlyOnceWith(POLE_CAR, 0, 0);
      expect(replay.state.camCarIdx).toBe(POLE_CAR);
      expect(mockReplay.setPlayPosition).not.toHaveBeenCalled();
      expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
      expect(_activeLapPress()).toBeNull();
    });

    it("aborts before any replay command when the camera will not switch to the pole car", async () => {
      fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      mockCamera.switchNum.mockImplementation(() => false);

      await press();
      await vi.runAllTimersAsync();

      expect(logger.warn).toHaveBeenCalledWith("Jump to race start: camera switch failed, aborting");
      expect(countReplayCommands()).toBe(0);
      expect(_activeLapPress()).toBeNull();
    });

    it("warns, and still applies the setting, when the camera will not switch back", async () => {
      fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
      mockCamera.switchNum.mockImplementation((carNum) => carNum === POLE_CAR);

      await press();
      await vi.runAllTimersAsync();

      expect(logger.warn).toHaveBeenCalledWith(
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
      [
        "Jump to race start",
        async () => {
          await press();
        },
      ],
      [
        "Jump to fastest lap",
        async () => {
          // An Always My Car key pressed while watching another car: the press
          // puts the camera on the target before the search.
          void walkToFastestLap(
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
        const replay = fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE });
        const switches = recordSwitches(replay);

        await start();
        await vi.advanceTimersByTimeAsync(0);

        expect(switches).toEqual([{ carNum: POLE_CAR, seeking: false }]);
        expect(logger.debug).not.toHaveBeenCalledWith(`${label}: a jump was still under way; camera switched anyway`);
      });

      it("borrows the camera only once a jump under way has landed, and searches on the target car", async () => {
        const replay = fakeReplay({
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
        const replay = fakeReplay({
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

        expect(logger.warn).toHaveBeenCalledWith(
          `${label}: could not put the replay back; it is left paused where the search stopped`,
        );
        expect(replay.state.frame).toBe(IN_RACE);
        expect(switches).toEqual([
          { carNum: POLE_CAR, seeking: false },
          { carNum: VIEWED_CAR, seeking: false },
        ]);
        expect(logger.debug).not.toHaveBeenCalledWith(`${label}: a jump was still under way; camera switched anyway`);
      });

      it("hands the camera back anyway when the wait runs out, and says so", async () => {
        const replay = fakeReplay({
          sessionTypes: WEEKEND_TYPES,
          layout: WEEKEND,
          cursor: IN_RACE,
          // Every jump stalls: the probe and the way back.
          seekStalls: () => true,
        });
        const switches = recordSwitches(replay);

        await start();
        await runPressOut();

        expect(logger.warn).toHaveBeenCalledWith(
          `${label}: could not put the replay back; it is left paused where the search stopped`,
        );
        expect(logger.debug).toHaveBeenCalledWith(`${label}: a jump was still under way; camera switched anyway`);
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
        const replay = fakeReplay({
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

          void walkToFastestLap(
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
          expect(logger.warn).toHaveBeenCalledExactlyOnceWith(`Jump to fastest lap: ${NOT_CONVERGED(8, dist)}`);
          expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
          expect(logger.info).not.toHaveBeenCalledWith("Jump to fastest lap: replay put back where the press found it");
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
          expect(vi.mocked(logger.warn).mock.calls.map((call) => call[0])).toEqual(warnings);
          expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();

          if (outcome === "put back") {
            expect(replay.state.frame).toBe(IN_RACE);
            expect(logger.info).toHaveBeenCalledWith("Jump to race start: replay put back where the press found it");
          } else {
            expect(replay.state.frame).not.toBe(IN_RACE);
            expect(logger.info).not.toHaveBeenCalledWith(
              "Jump to race start: replay put back where the press found it",
            );
          }
        },
      );
    });
  });

  describe("a camera key during a search (#1428 / #1435)", () => {
    type Speed = { speed: number; slowMotion: boolean };

    const PAUSED_SPEED: Speed = { speed: 0, slowMotion: false };
    const NORMAL_SPEED: Speed = { speed: 1, slowMotion: false };
    const QUARTER_SPEED: Speed = { speed: 4, slowMotion: true };

    /** The car the camera key moves the camera to: neither the viewed car nor the pole car. */
    const KEY_CAR = 11;

    /**
     * The race weekend with a live speed, and every command listed in the
     * order sent: the telemetry reports the speed last commanded, as iRacing
     * does, while it shows the replay (a seek under way reads 0).
     */
    function liveWeekend(options: Partial<RaceWeekendOptions>, initial: Speed) {
      const replay = fakeReplay({ sessionTypes: WEEKEND_TYPES, layout: WEEKEND, cursor: IN_RACE, ...options });
      const commands: string[] = [];
      const listeners: (() => void)[] = [];
      let current = initial;
      const read = controller.getCurrentTelemetry;
      const seek = mockReplay.setPlayPosition.getMockImplementation() as (
        mode: ReplayPosMode,
        frame: number,
      ) => boolean;
      const switchNum = mockCamera.switchNum.getMockImplementation() as (
        carNum: number,
        group: number,
        camera: number,
      ) => boolean;
      /** Lists a command, then tells every listener: each only schedules what it does, never sends in the call. */
      const record = (command: string): void => {
        commands.push(command);

        for (const listener of listeners) listener();
      };

      controller.getCurrentTelemetry = vi.fn((): TelemetryData | null => {
        const telemetry = read();

        return telemetry?.IsReplayPlaying === true
          ? {
              ...telemetry,
              ReplayPlaySpeed: replaySpeedToSdk(current.speed, current.slowMotion),
              ReplayPlaySlowMotion: current.slowMotion,
            }
          : telemetry;
      });
      mockReplay.pause.mockImplementation(() => {
        current = PAUSED_SPEED;
        record("pause");

        return true;
      });
      mockReplay.setPlaySpeed.mockImplementation((speed, slowMotion = false) => {
        current = { speed, slowMotion };
        record(`speed ${speed}${slowMotion ? " slow" : ""}`);

        return true;
      });
      mockReplay.setPlayPosition.mockImplementation((mode, frame) => {
        const sent = seek(mode, frame);

        record(`seek ${frame}`);

        return sent;
      });

      for (const name of ["goToStart", "nextSession", "nextLap", "prevLap"] as const) {
        const run = mockReplay[name].getMockImplementation() as () => boolean;

        mockReplay[name].mockImplementation(() => {
          const sent = run();

          record(name);

          return sent;
        });
      }

      mockCamera.switchNum.mockImplementation((carNum, group, camera) => {
        const sent = switchNum(carNum, group, camera);

        record(`camera ${carNum}`);

        return sent;
      });

      return {
        replay,
        commands,
        speed: (): Speed => current,
        /** Runs `listener` after every command is listed. */
        onCommand: (listener: () => void): void => {
          listeners.push(listener);
        },
      };
    }

    /** The camera key: Replay Control's Next Car, through the engine's one waiter, as the key sends it. */
    function pressCameraKey(
      weekend: ReturnType<typeof liveWeekend>,
      overrides: { by?: string; interruptsWalks?: boolean; carNum?: number } = {},
    ): Promise<void> {
      const carNum = overrides.carNum ?? KEY_CAR;

      return requestCameraSwitch(() => mockCamera.switchNum(carNum, 0, 0), {
        by: overrides.by ?? "next-car",
        interruptsWalks: overrides.interruptsWalks,
        label: "Replay control",
        name: "next car",
        asked: "next-car pressed",
        surface: "the key",
        stillValid: () => weekend.replay.state.inReplay,
      });
    }

    /** What a walk sends from the camera key on: the way back, the press's camera move undone, the key's switch. */
    function wayBack(options: { seek: boolean; speed: Speed; moved: boolean }): string[] {
      const { speed, slowMotion } = options.speed;

      return [
        ...(options.seek ? [`seek ${IN_RACE}`] : []),
        ...(speed === 0 ? [] : [`speed ${speed}${slowMotion ? " slow" : ""}`]),
        ...(options.moved ? [`camera ${VIEWED_CAR}`] : []),
        `camera ${KEY_CAR}`,
      ];
    }

    type Phase = [phase: string, at: (commands: readonly string[], nudge: number) => boolean];

    const isLapSearch = (command: string): boolean => command === "nextLap" || command === "prevLap";
    const count = (commands: readonly string[], test: (command: string) => boolean): number =>
      commands.filter(test).length;

    /**
     * Each phase of the walk, as the command that opens it. On this weekend,
     * with lap searches landing 100 frames short of the line and every seek
     * taking 200 ms, both walks map the sessions, bisect, lap-step, nudge and
     * back-step: Jump to Race Start's nudge is its first Next Lap (its lap
     * steps go back), Jump to Fastest Lap's its third.
     */
    const PHASES: Phase[] = [
      // The press's own camera move: the walk's opening pause follows at once, and its wait is 400 ms.
      ["its opening pause", (commands) => commands.at(-1) === `camera ${POLE_CAR}`],
      [
        "a bisection probe's seek",
        (commands) =>
          commands.at(-1)?.startsWith("seek") === true && count(commands, (c) => c.startsWith("seek")) === 1,
      ],
      [
        "a lap-step search",
        (commands) => isLapSearch(commands.at(-1) ?? "") && count(commands, isLapSearch) === 1,
      ],
      [
        "the nudge",
        (commands, nudge) => commands.at(-1) === "nextLap" && count(commands, (c) => c === "nextLap") === nudge,
      ],
      [
        "the back-step",
        (commands) => commands.at(-1)?.startsWith("seek") === true && commands.some(isLapSearch),
      ],
    ];

    type Walk = [label: string, nudge: number, start: (viewedCarIdx: number) => Promise<void>];

    const WALKS: Walk[] = [
      [
        "Jump to race start",
        1,
        async () => {
          await press();
        },
      ],
      [
        "Jump to fastest lap",
        3,
        async (viewedCarIdx) => {
          // An Always My Car key: the press puts the camera on the target before the search.
          void walkToFastestLap(
            "ctx-fastest",
            POLE_CAR,
            9,
            2,
            { carNumberRaw: POLE_CAR, userId: 700, subSessionId: undefined },
            viewedCarIdx,
            POLE_CAR,
          );
        },
      ],
    ];

    /** Presses the camera key 10 ms after the first command `at` matches; `atKey` is how many commands came before. */
    function cameraKeyWhen(
      weekend: ReturnType<typeof liveWeekend>,
      at: (commands: readonly string[]) => boolean,
      overrides: Parameters<typeof pressCameraKey>[1] = {},
    ): { atKey: () => number | null; request: () => Promise<void> | null } {
      let atKey: number | null = null;
      let request: Promise<void> | null = null;
      let armed = true;

      weekend.onCommand(() => {
        if (!armed || !at(weekend.commands)) return;

        armed = false;
        setTimeout(() => {
          atKey = weekend.commands.length;
          request = pressCameraKey(weekend, overrides);
        }, 10);
      });

      return { atKey: () => atKey, request: () => request };
    }

    describe.each(WALKS)("%s", (label, nudge, start) => {
      describe.each(PHASES)("pressed during %s", (phase, at) => {
        it.each<[string, Speed]>([
          ["playing at 1x", NORMAL_SPEED],
          ["in slow motion at 1/4x", QUARTER_SPEED],
          ["paused", PAUSED_SPEED],
        ])(
          "from a replay %s: the walk stops, the replay is put back with the camera, then the key switches once",
          async (_state, before) => {
            const weekend = liveWeekend({ lapSearchShort: 100, seekTakesMs: () => 200 }, before);
            const key = cameraKeyWhen(weekend, (commands) => at(commands, nudge));

            await start(VIEWED_CAR);
            await runPressOut();

            const atKey = key.atKey();

            expect(atKey).not.toBeNull();
            // No further probe: the way back, the press's own camera move undone, then the key's switch.
            expect(weekend.commands.slice(atKey ?? 0)).toEqual(
              wayBack({ seek: phase !== "its opening pause", speed: before, moved: true }),
            );
            expect(weekend.replay.state.frame).toBe(IN_RACE);
            expect(weekend.speed()).toEqual(before);
            expect(weekend.replay.state.camCarIdx).toBe(KEY_CAR);
            expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(`${label}: walk interrupted by next-car; replay put back`);
            expect(_activeLapPress()).toBeNull();
            await key.request();
          },
        );
      });

      it("pressed while the press waits to move the camera, it moves nothing and has nothing to put back", async () => {
        const dialFrame = IN_RACE + 30_000;
        const weekend = liveWeekend(
          // The dial jump takes half a second; the press waits for it before its own camera move.
          { seekTakesMs: (distance) => (distance === dialFrame - IN_RACE ? 500 : 0), seekShowsAfterMs: 20 },
          PAUSED_SPEED,
        );

        pressReplayCommand({ kind: "jump", frame: dialFrame }, { by: "dial-frame-jog", origin: "ctx-dial" });
        // Before the seek shows: Jump to Race Start refuses a press made while the session reads -1.
        await vi.advanceTimersByTimeAsync(10);
        await start(VIEWED_CAR);
        await vi.advanceTimersByTimeAsync(100);

        // The press is waiting for the dial's jump to land before its camera move.
        expect(_activeLapPress()).not.toBeNull();
        expect(weekend.replay.state.seeking).toBe(true);

        const atKey = weekend.commands.length;
        const request = pressCameraKey(weekend);

        await runPressOut();
        await request;

        // The dial's jump lands, the press stops before any command of its own, and the key switches.
        expect(weekend.commands.slice(atKey)).toEqual([`camera ${KEY_CAR}`]);
        expect(weekend.commands).not.toContain(`camera ${POLE_CAR}`);
        expect(weekend.commands).not.toContain("pause");
        expect(weekend.replay.state.frame).toBe(dialFrame);
        expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
        expect(_activeLapPress()).toBeNull();
      });

      it("leaves the camera alone when the press had not moved it", async () => {
        const weekend = liveWeekend(
          { lapSearchShort: 100, seekTakesMs: () => 200, viewedCarIdx: POLE_CAR },
          NORMAL_SPEED,
        );
        const key = cameraKeyWhen(weekend, (commands) => count(commands, (c) => c.startsWith("seek")) === 1);

        await start(POLE_CAR);
        await runPressOut();

        expect(weekend.commands.slice(key.atKey() ?? 0)).toEqual(
          wayBack({ seek: true, speed: NORMAL_SPEED, moved: false }),
        );
        expect(weekend.commands.filter((c) => c === `camera ${VIEWED_CAR}`)).toEqual([]);
      });

      it("a replay key pressed during the way back cancels it: nothing more is sent, and its command stands", async () => {
        const weekend = liveWeekend({ lapSearchShort: 100, seekTakesMs: () => 200 }, NORMAL_SPEED);
        const key = cameraKeyWhen(weekend, (commands) => count(commands, (c) => c.startsWith("seek")) === 1);
        let atReplayKey: number | null = null;

        // The way back's seek: the replay key goes in while it is under way.
        weekend.onCommand(() => {
          if (atReplayKey !== null || weekend.commands.at(-1) !== `seek ${IN_RACE}`) return;

          atReplayKey = weekend.commands.length;
          setTimeout(() => {
            pressReplayCommand({ kind: "jump", frame: 60_000 }, { by: "dial-frame-jog", origin: "ctx-dial" });
          }, 10);
        });

        await start(VIEWED_CAR);
        await runPressOut();

        expect(key.atKey()).not.toBeNull();
        expect(atReplayKey).not.toBeNull();
        // The replay key's jump, then the camera key's switch: no speed and no camera move back from the walk.
        expect(weekend.commands.slice(atReplayKey ?? 0)).toEqual(["seek 60000", `camera ${KEY_CAR}`]);
        expect(weekend.replay.state.frame).toBe(60_000);
        expect(logger.info).toHaveBeenCalledWith(`${label}: walk cancelled by dial-frame-jog`);
        expect(logger.info).not.toHaveBeenCalledWith(`${label}: walk interrupted by next-car; replay put back`);
        expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
      });

      it("leaving the replay during a walk still cancels it, with no way back", async () => {
        const weekend = liveWeekend({ lapSearchShort: 100, seekTakesMs: () => 200 }, NORMAL_SPEED);
        // Back in the car: a sample no seek could show, so the departure is not held.
        const watch = watchReplayLeft({
          replayState: () => ({ inReplay: weekend.replay.state.inReplay }),
          telemetry: () =>
            ({ ...controller.getCurrentTelemetry(), IsReplayPlaying: false, IsOnTrack: true }) as TelemetryData,
        });
        let atLeave: number | null = null;

        // Interrupted in the opening pause, and the replay left before the walk unwinds.
        cameraKeyWhen(weekend, (commands) => commands.at(-1) === "pause");
        weekend.onCommand(() => {
          if (atLeave !== null || weekend.commands.at(-1) !== "pause") return;

          atLeave = weekend.commands.length;
          setTimeout(() => {
            weekend.replay.state.inReplay = false;
            watch.tick();
          }, 20);
        });

        await start(VIEWED_CAR);
        await runPressOut();

        expect(logger.info).toHaveBeenCalledWith(`${label}: walk cancelled by replay-left`);
        // Nothing after the pause: no speed back, no camera back, and the key's switch dropped with the replay.
        expect(weekend.commands.slice(atLeave ?? 0)).toEqual([]);
        expect(logger.info).not.toHaveBeenCalledWith(`${label}: walk interrupted by next-car; replay put back`);
      });

      it("an angle-only switch (interruptsWalks: false) does not interrupt it", async () => {
        const weekend = liveWeekend({}, PAUSED_SPEED);
        const key = cameraKeyWhen(weekend, (commands) => count(commands, (c) => c.startsWith("seek")) === 1, {
          by: "cycle-camera",
          interruptsWalks: false,
          carNum: POLE_CAR,
        });

        await start(VIEWED_CAR);
        await runPressOut();

        expect(key.atKey()).not.toBeNull();
        expect(logger.info).toHaveBeenCalledWith(`${label}: walk converged (lap start recorded)`);
        expect(mockStore.laps.recordLapStart).toHaveBeenCalledOnce();
        expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("walk interrupted"));
      });
    });

    describe("interrupted before it has read where the replay was", () => {
      it.each<[string, Speed, string[]]>([
        ["playing", NORMAL_SPEED, ["speed 1"]],
        ["paused", PAUSED_SPEED, []],
      ])("from a replay %s: only the captured speed goes back, none when it was zero", async (_state, before, sent) => {
        const weekend = liveWeekend({}, before);
        const key = cameraKeyWhen(weekend, (commands) => commands.at(-1) === `camera ${POLE_CAR}`);

        await press();
        await runPressOut();

        expect(weekend.commands.slice(key.atKey() ?? 0)).toEqual([
          ...sent,
          `camera ${VIEWED_CAR}`,
          `camera ${KEY_CAR}`,
        ]);
        expect(weekend.commands.filter((c) => c.startsWith("seek"))).toEqual([]);
        expect(weekend.speed()).toEqual(before);
      });
    });
  });
});
