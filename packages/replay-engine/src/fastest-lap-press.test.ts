/**
 * Jump to Fastest Lap (#607, #1203, #1275, #1276; moved out of Replay
 * Control's suite with the press in #1467): the press's guards, the record
 * jump, the walk and its session map, against a fake controller, replay and
 * camera. What the key does around a press — its icons, the replay busy
 * indicator, another key cancelling a walk, a disconnect dropping the map —
 * stays in `replay-control.test.ts`.
 */
import type { ReplayJumpPlayback } from "@iracedeck/app-constants";
import {
  getCarNumberRawFromSessionInfo,
  type ReplayPosMode,
  replaySpeedFromTelemetry,
  replaySpeedToSdk,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import type { LapStartLookup, LapStartQuery, LapStartRecord } from "@iracedeck/replay-store";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import {
  findFastestLapForCar,
  pressJumpToFastestLap,
  resolveFastestLapCarIdx,
  walkToFastestLap,
} from "./fastest-lap-press.js";
import { _activeLapPress } from "./lap-press.js";
import {
  multiSessionBuffer as lapBuffer,
  singleSessionBuffer as oneSessionLapBuffer,
  type SessionLayout,
} from "./lap-walk-buffer.test-support.js";
import { _getFastestLapSessionCache } from "./lap-walk.js";
import { getReplayGateView, type ReplayGateFactEnd, subscribeReplayGate } from "./replay-command-gate.js";
import { cancelReplayCursorOwner } from "./replay-cursor.js";
import { _resetReplayEngine } from "./replay-engine-reset.js";
import { configureTestEngine, type SpyLogger, type TestControllerReads } from "./replay-engine.test-support.js";
import { watchReplayLeft } from "./replay-left.test-support.js";
import { onReplaySpeedChanged } from "./replay-speed-state.js";
import { shownReplaySpeed } from "./replay-speed-view.js";
import { steppedReplayState, withSteppedReplayState } from "./replay-state.test-support.js";

vi.mock("@iracedeck/iracing-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/iracing-sdk")>()),
  getCarNumberRawFromSessionInfo: vi.fn(),
}));

vi.mock("@iracedeck/replay-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/replay-store")>()),
  getReplaySessionStore: vi.fn(),
  isReplaySessionStoreInitialized: vi.fn(() => false),
}));

/**
 * Runs the fake clock until a press has done all it will, for a test whose
 * walk ends on a search that found nothing. Not `vi.runAllTimersAsync()`: the
 * replay command gate keeps its record of such a search, and polls the replay
 * while it stands (#1430), so no timer is ever the last one.
 */
async function runPressOut(): Promise<void> {
  await vi.advanceTimersByTimeAsync(120_000);
}

/** Every speed the engine recorded as sent in the running test, in order (#1467): what the keys then show. */
const sentSpeeds: Array<{ speed: number; slowMotion: boolean }> = [];

describe("findFastestLapForCar", () => {
  function sessionInfoWith(
    sessions: Array<{ SessionNum: number; ResultsPositions?: Array<{ CarIdx: number; FastestLap: number }> }>,
  ) {
    return { SessionInfo: { Sessions: sessions } };
  }

  it("prefers ResultsPositions over telemetry CarIdxBestLapNum", () => {
    const sessionInfo = sessionInfoWith([
      {
        SessionNum: 2,
        ResultsPositions: [
          { CarIdx: 5, FastestLap: 12 },
          { CarIdx: 7, FastestLap: 9 },
        ],
      },
    ]);
    const telemetry = { SessionNum: 2, CarIdxBestLapNum: [0, 0, 0, 0, 0, 99, 0, 99] } as any;

    expect(findFastestLapForCar(sessionInfo, telemetry, 5)).toBe(12);
    expect(findFastestLapForCar(sessionInfo, telemetry, 7)).toBe(9);
  });

  it("matches the right session by SessionNum field, not array index", () => {
    // Sessions are sometimes listed out of order — never trust the index.
    const sessionInfo = sessionInfoWith([
      { SessionNum: 0, ResultsPositions: [{ CarIdx: 3, FastestLap: 7 }] },
      { SessionNum: 2, ResultsPositions: [{ CarIdx: 3, FastestLap: 15 }] },
      { SessionNum: 1, ResultsPositions: [{ CarIdx: 3, FastestLap: 11 }] },
    ]);
    const telemetry = { SessionNum: 1, CarIdxBestLapNum: [] } as any;

    expect(findFastestLapForCar(sessionInfo, telemetry, 3)).toBe(11);
  });

  it("returns null when ResultsPositions has no entry for the target car", () => {
    const sessionInfo = sessionInfoWith([{ SessionNum: 0, ResultsPositions: [{ CarIdx: 1, FastestLap: 5 }] }]);
    const telemetry = { SessionNum: 0 } as any;

    expect(findFastestLapForCar(sessionInfo, telemetry, 99)).toBeNull();
  });

  it("falls back to telemetry when ResultsPositions is empty (live session)", () => {
    const sessionInfo = sessionInfoWith([{ SessionNum: 0, ResultsPositions: [] }]);
    const telemetry = { SessionNum: 0, CarIdxBestLapNum: [0, 0, 8] } as any;

    expect(findFastestLapForCar(sessionInfo, telemetry, 2)).toBe(8);
  });

  it("falls back to telemetry when ResultsPositions has the car but FastestLap is 0", () => {
    // Practice session, driver completed an out-lap but no flying lap yet —
    // ResultsPositions exists with FastestLap=0; only live telemetry has the recorded lap.
    const sessionInfo = sessionInfoWith([{ SessionNum: 0, ResultsPositions: [{ CarIdx: 2, FastestLap: 0 }] }]);
    const telemetry = { SessionNum: 0, CarIdxBestLapNum: [0, 0, 6] } as any;

    expect(findFastestLapForCar(sessionInfo, telemetry, 2)).toBe(6);
  });

  it("falls back to telemetry when sessionInfo lacks the current session", () => {
    const sessionInfo = sessionInfoWith([{ SessionNum: 1, ResultsPositions: [{ CarIdx: 2, FastestLap: 5 }] }]);
    const telemetry = { SessionNum: 0, CarIdxBestLapNum: [0, 0, 4] } as any;

    expect(findFastestLapForCar(sessionInfo, telemetry, 2)).toBe(4);
  });

  it("returns null when neither source has data", () => {
    const sessionInfo = sessionInfoWith([{ SessionNum: 0, ResultsPositions: [] }]);
    const telemetry = { SessionNum: 0, CarIdxBestLapNum: [] } as any;

    expect(findFastestLapForCar(sessionInfo, telemetry, 2)).toBeNull();
  });

  it("returns null when telemetry is null and sessionInfo is empty", () => {
    expect(findFastestLapForCar(null, null, 0)).toBeNull();
  });

  it("handles missing SessionNum on telemetry by falling back to telemetry-only path", () => {
    const sessionInfo = sessionInfoWith([{ SessionNum: 0, ResultsPositions: [{ CarIdx: 2, FastestLap: 5 }] }]);
    const telemetry = { CarIdxBestLapNum: [0, 0, 3] } as any;

    // No SessionNum → skips ResultsPositions matching → falls back to telemetry.
    expect(findFastestLapForCar(sessionInfo, telemetry, 2)).toBe(3);
  });
});

describe("jump-to-fastest-lap", () => {
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
    nextIncident: vi.fn(() => true),
    prevIncident: vi.fn(() => true),
    goToStart: vi.fn(() => true),
    goToEnd: vi.fn(() => true),
    setPlayPosition: vi.fn<(mode: ReplayPosMode, frameNumber: number) => boolean>(() => true),
    searchSessionTime: vi.fn(() => true),
  };

  /** The two settings the engine reads (#1467), as the cases set them; read at the time of use. */
  const settings: { replayJumpPlayback: ReplayJumpPlayback | undefined; fastestLapSearchDelayMs: number } = {
    replayJumpPlayback: undefined,
    fastestLapSearchDelayMs: 400,
  };

  /**
   * Sets the **Replay jump playback** global setting (#1276) beside the
   * search delay. `undefined` leaves the key out, which reads as Remember.
   */
  function setJumpPlayback(mode: ReplayJumpPlayback | undefined, fastestLapSearchDelayMs = 400): void {
    settings.replayJumpPlayback = mode;
    settings.fastestLapSearchDelayMs = fastestLapSearchDelayMs;
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

  /** Shared helper — used by the dispatch + encoder describes below. */
  function telemetryWithBest(carIdx: number, bestLapNum: number, currentLap: number) {
    const bestLapNums: number[] = [];
    const currentLaps: number[] = [];

    bestLapNums[carIdx] = bestLapNum;
    currentLaps[carIdx] = currentLap;

    return {
      CamCarIdx: carIdx,
      CarIdxBestLapNum: bestLapNums,
      CarIdxLap: currentLaps,
      IsReplayPlaying: true,
      SessionNum: 0,
    };
  }

  /**
   * The SDK controller the engine reads (#1467): telemetry and session info a
   * case replaces, and the controller's debounced replay state (#1324) stepped
   * from them at every read, as Replay Control's mocked controller had it.
   */
  let controller: TestControllerReads;
  /** The engine's `ReplayControl` scope: where the press and the walk log. */
  let logger: SpyLogger;

  /** The speed the keys show and step from: the engine's one record of it over a fresh read (#1467). */
  function shownSpeed(): { speed: number; slowMotion: boolean } {
    const telemetry = controller.getCurrentTelemetry();

    return shownReplaySpeed(telemetry ? replaySpeedFromTelemetry(telemetry) : null, Date.now());
  }

  /** A buffer over this case's controller and replay (`lap-walk-buffer.test-support.ts`). */
  function multiSessionBuffer(
    carIdx: number,
    sessions: SessionLayout[],
    opts: Parameters<typeof lapBuffer>[4] = {},
  ): ReturnType<typeof lapBuffer> {
    return lapBuffer(controller, mockReplay, carIdx, sessions, opts);
  }

  /** The default single-session buffer over this case's controller and replay. */
  function singleSessionBuffer(
    carIdx: number,
    fastestLap: number,
    opts: Parameters<typeof oneSessionLapBuffer>[4] = {},
  ): ReturnType<typeof oneSessionLapBuffer> {
    return oneSessionLapBuffer(controller, mockReplay, carIdx, fastestLap, opts);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const { getReplaySessionStore, isReplaySessionStoreInitialized } = await import("@iracedeck/replay-store");
    // getCarNumberRawFromSessionInfo is mocked in the @iracedeck/iracing-sdk block above;
    // default it to returning the carIdx as the raw number so individual tests don't have
    // to wire fake session info.
    vi.mocked(getCarNumberRawFromSessionInfo).mockImplementation((_si: unknown, idx: number) => idx);
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
    // (Remember) a paused replay ends a press with no command at all. The
    // setting's three values are covered in "Replay jump playback (#1276)".
    setJumpPlayback("play");
    controller = withSteppedReplayState({
      getCurrentTelemetry: vi.fn((): TelemetryData | null => null),
      getSessionInfo: vi.fn((): unknown => null),
    });
    // Every engine module reset — the walk's session-map cache, the in-flight
    // slot and the shared replay-cursor claim included — so each test starts
    // clean. The replay command gate (#1430) reads the replay the buffers
    // simulate, so the jumps a press sends read back and nothing stands after
    // a walk.
    ({ logger } = configureTestEngine({
      controller,
      replay: mockReplay,
      camera: mockCamera,
      settings: {
        replayJumpPlayback: () => settings.replayJumpPlayback,
        fastestLapSearchDelayMs: () => settings.fastestLapSearchDelayMs,
      },
    }));
    sentSpeeds.length = 0;
    onReplaySpeedChanged((speed) => sentSpeeds.push(speed));
  });

  afterEach(() => {
    setJumpPlayback(undefined);
    // Nothing under way after a case: a test on real timers that leaves the
    // gate polling would otherwise have its timer fire in a later test.
    _resetReplayEngine();
  });

  describe("resolveFastestLapCarIdx", () => {
    it("returns CamCarIdx when target is viewed-car", () => {
      const carIdx = resolveFastestLapCarIdx("viewed-car", { CamCarIdx: 7 } as any);

      expect(carIdx).toBe(7);
    });

    it("returns -1 when target is viewed-car and telemetry is null", () => {
      expect(resolveFastestLapCarIdx("viewed-car", null)).toBe(-1);
    });

    it("returns DriverCarIdx from session info when target is always-my-car", () => {
      controller.getSessionInfo = vi.fn(() => ({ DriverInfo: { DriverCarIdx: 3 } }) as any);

      expect(resolveFastestLapCarIdx("always-my-car", { CamCarIdx: 99 } as any)).toBe(3);
    });

    it("returns -1 when target is always-my-car and session info is missing", () => {
      controller.getSessionInfo = vi.fn(() => null);

      expect(resolveFastestLapCarIdx("always-my-car", { CamCarIdx: 99 } as any)).toBe(-1);
    });
  });

  describe("dispatch", () => {
    it("logs a warning and does nothing when no target car is available (viewed-car)", async () => {
      controller.getCurrentTelemetry = vi.fn(() => ({ CamCarIdx: -1 }) as any);

      await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });

      expect(mockReplay.nextLap).not.toHaveBeenCalled();
      expect(mockReplay.prevLap).not.toHaveBeenCalled();
      expect(mockCamera.switchNum).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("No target car"));
    });

    it("rejects CarIdx 255 (no-driver/pace-car placeholder) before resolving the fastest lap", async () => {
      // CamCarIdx=255 happens mid-camera-transition and on the pace car —
      // never a real target. Should short-circuit before any walk starts.
      controller.getCurrentTelemetry = vi.fn(() => ({ CamCarIdx: 255 }) as any);

      await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });

      expect(mockReplay.nextLap).not.toHaveBeenCalled();
      expect(mockReplay.prevLap).not.toHaveBeenCalled();
      expect(mockCamera.switchNum).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("No target car"));
    });

    it("aborts the walk and warns when camera.switchNum fails", async () => {
      vi.useFakeTimers();
      onTestFinished(() => void vi.useRealTimers());
      // Camera switch returns false (SDK refused) — walker must not start.
      mockCamera.switchNum.mockReturnValueOnce(false);
      controller.getCurrentTelemetry = vi.fn(() => telemetryWithBest(2, 5, 0) as any);

      await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
      // Nothing is under way, so the wait before the switch ends with no timer.
      await vi.advanceTimersByTimeAsync(0);

      expect(mockCamera.switchNum).toHaveBeenCalledWith(2, 0, 0);
      expect(mockReplay.pause).not.toHaveBeenCalled();
      expect(mockReplay.setPlayPosition).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("camera switch failed"));
    });

    it("logs info and skips when the target car has no best lap yet", async () => {
      controller.getCurrentTelemetry = vi.fn(() => telemetryWithBest(2, 0, 0) as any);

      await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });

      expect(mockReplay.pause).not.toHaveBeenCalled();
      expect(mockReplay.setPlayPosition).not.toHaveBeenCalled();
      expect(mockCamera.switchNum).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        "Jump to fastest lap: iRacing reports no fastest lap for the target car",
      );
    });

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

    describe("session map building", () => {
      it("builds a map via goToStart + nextSession × N on first press, never goToEnd (#1203)", async () => {
        vi.useFakeTimers();

        try {
          multiSessionBuffer(
            4,
            [
              { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 999, framesPerLap: 100, fastestLap: -1 },
              {
                sessionNum: 1,
                sessionUniqueId: 2,
                startFrame: 1000,
                endFrame: 4999,
                framesPerLap: 1000,
                fastestLap: 2,
              },
              {
                sessionNum: 2,
                sessionUniqueId: 3,
                startFrame: 5000,
                endFrame: 14_999,
                framesPerLap: 1000,
                fastestLap: 4,
              },
            ],
            { initialCursor: 8000 },
          );

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(mockReplay.goToStart).toHaveBeenCalled();
          // 3 sessions → 3 nextSession calls (last one is the no-op detector).
          expect(mockReplay.nextSession.mock.calls.length).toBeGreaterThanOrEqual(2);
          // `goToEnd` would leave a live session's replay for the live view,
          // where ReplayFrameNum reads 0 and the last session's bounds collapse.
          expect(mockReplay.goToEnd).not.toHaveBeenCalled();

          const cache = _getFastestLapSessionCache();

          expect(cache).not.toBeNull();
          expect([...(cache?.sessionUniqueIds ?? [])].sort()).toEqual([1, 2, 3]);
          expect(cache?.sessions.map((s) => s.sessionNum)).toEqual([0, 1, 2]);
        } finally {
          vi.useRealTimers();
        }
      });

      it("computes each session's endFrame as the next session's startFrame - 1, keyed by (SessionNum, SessionUniqueID), and leaves the last open", async () => {
        vi.useFakeTimers();

        try {
          multiSessionBuffer(
            4,
            [
              { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 999, framesPerLap: 100, fastestLap: -1 },
              {
                sessionNum: 2,
                sessionUniqueId: 3,
                startFrame: 1000,
                endFrame: 10_999,
                framesPerLap: 1000,
                fastestLap: 4,
              },
            ],
            { initialCursor: 5000 },
          );

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          const cache = _getFastestLapSessionCache();

          expect(cache?.subSessionId).toBeUndefined();
          expect(cache?.sessions).toEqual([
            { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 999 }, // session 2's startFrame - 1
            // The last instance's end is open: every walk reads the recording's
            // length live as ReplayFrameNum + ReplayFrameNumEnd — never a goToEnd,
            // never a value frozen at build time.
            { sessionNum: 2, sessionUniqueId: 3, startFrame: 1000, endFrame: null },
          ]);
          expect(mockReplay.goToEnd).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe("session map cache (Set-of-uniqueIds)", () => {
      it("reuses the cached map when current SessionUniqueID is in the Set", async () => {
        vi.useFakeTimers();

        try {
          multiSessionBuffer(
            4,
            [
              { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 999, framesPerLap: 100, fastestLap: -1 },
              {
                sessionNum: 2,
                sessionUniqueId: 3,
                startFrame: 1000,
                endFrame: 10_999,
                framesPerLap: 1000,
                fastestLap: 4,
              },
            ],
            { initialCursor: 5000 },
          );

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          mockReplay.goToStart.mockClear();
          mockReplay.nextSession.mockClear();
          mockReplay.goToEnd.mockClear();

          // Second press: should reuse the map (no new goToStart / nextSession / goToEnd).
          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(mockReplay.goToStart).not.toHaveBeenCalled();
          expect(mockReplay.nextSession).not.toHaveBeenCalled();
          expect(mockReplay.goToEnd).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      });

      it("rebuilds when current SessionUniqueID is not in the cached Set (new race weekend)", async () => {
        vi.useFakeTimers();

        try {
          // First press: a race weekend with uniqueIds {1, 3}
          const firstWeekend = multiSessionBuffer(
            4,
            [
              { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 999, framesPerLap: 100, fastestLap: -1 },
              {
                sessionNum: 2,
                sessionUniqueId: 3,
                startFrame: 1000,
                endFrame: 10_999,
                framesPerLap: 1000,
                fastestLap: 4,
              },
            ],
            { initialCursor: 5000 },
          );

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(firstWeekend.cursor).toBeTruthy();
          expect([...(_getFastestLapSessionCache()?.sessionUniqueIds ?? [])].sort()).toEqual([1, 3]);

          // Second press: new race weekend with all-different uniqueIds.
          multiSessionBuffer(
            4,
            [
              {
                sessionNum: 0,
                sessionUniqueId: 10,
                startFrame: 0,
                endFrame: 999,
                framesPerLap: 100,
                fastestLap: -1,
              },
              {
                sessionNum: 2,
                sessionUniqueId: 11,
                startFrame: 1000,
                endFrame: 10_999,
                framesPerLap: 1000,
                fastestLap: 4,
              },
            ],
            { initialCursor: 5000 },
          );

          mockReplay.goToStart.mockClear();
          mockReplay.nextSession.mockClear();
          mockReplay.goToEnd.mockClear();

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          // Cache miss → rebuild → new goToStart / nextSession (still no goToEnd).
          expect(mockReplay.goToStart).toHaveBeenCalled();
          expect(mockReplay.nextSession).toHaveBeenCalled();
          expect(mockReplay.goToEnd).not.toHaveBeenCalled();
          // New cache contains the new uniqueIds.
          expect([...(_getFastestLapSessionCache()?.sessionUniqueIds ?? [])].sort()).toEqual([10, 11]);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe("record lookup (#1203)", () => {
      const recordHit = (frame: number, timeMs: number | null = null, matchedBy: "pair" | "sessionNum" = "pair") =>
        mockStore.laps.findLapStart.mockImplementation(() => ({ hit: true, frame, timeMs, matchedBy }));

      it("a hit sends one setPlayPosition(Begin, frame - 60), then switchNum and the speed command after the landing, and no search", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4);
          recordHit(5000, 91_433);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(mockStore.laps.findLapStart).toHaveBeenCalledWith({
            subSessionId: undefined,
            sessionNum: 2,
            sessionUniqueId: 3,
            carIdx: 4,
            carNumberRaw: 4,
            lap: 4,
          });
          expect(mockReplay.setPlayPosition).toHaveBeenCalledExactlyOnceWith(expect.anything(), 4940);
          expect(mockCamera.switchNum).toHaveBeenCalledExactlyOnceWith(4, 0, 0);
          // A paused replay needs no pause: the one speed command is the setting's.
          expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
          // The seek goes first; nothing may follow it until it lands (#1275).
          const seekAt = mockReplay.setPlayPosition.mock.invocationCallOrder[0];
          const switchAt = mockCamera.switchNum.mock.invocationCallOrder[0];
          const speedAt = mockReplay.setPlaySpeed.mock.invocationCallOrder[0];

          expect(seekAt).toBeLessThan(switchAt);
          expect(switchAt).toBeLessThan(speedAt);
          // The shared sequence speaks setPlaySpeed only.
          expect(mockReplay.play).not.toHaveBeenCalled();
          expect(mockReplay.pause).not.toHaveBeenCalled();
          expect(mockReplay.goToStart).not.toHaveBeenCalled();
          expect(mockReplay.goToEnd).not.toHaveBeenCalled();
          expect(mockReplay.nextSession).not.toHaveBeenCalled();
          expect(mockReplay.nextLap).not.toHaveBeenCalled();
          expect(mockReplay.prevLap).not.toHaveBeenCalled();
          expect(logger.info).toHaveBeenCalledWith("Jump to fastest lap: record HIT (matchedBy pair)");
          expect(_activeLapPress()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

      it("names the sessionNum fallback in the HIT line when the pair did not match", async () => {
        // Fake timers throughout this describe: a record jump polls for its
        // landing, and a real-timer poll outlives the test and calls the
        // shared mocks during a later one.
        vi.useFakeTimers();
        onTestFinished(() => void vi.useRealTimers());
        singleSessionBuffer(4, 4);
        recordHit(5000, null, "sessionNum");

        await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
        await vi.runAllTimersAsync();

        expect(logger.info).toHaveBeenCalledWith("Jump to fastest lap: record HIT (matchedBy sessionNum)");
      });

      it("under Play, records 1x as the speed sent, so the Play key's next press pauses", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4);
          recordHit(5000);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(sentSpeeds.at(-1)).toEqual({ speed: 1, slowMotion: false });
        } finally {
          vi.useRealTimers();
        }
      });

      describe("waiting for the landing (#1275)", () => {
        /** The seek is received but the cursor stays put until the test moves it, as a long iRacing search does. */
        function holdTheSeek(): void {
          mockReplay.setPlayPosition.mockImplementation(() => true);
        }

        it("sends nothing after the seek until ReplayFrameNum reads the target, then switches and applies the setting", async () => {
          vi.useFakeTimers();

          try {
            const buffer = singleSessionBuffer(4, 4, { initialCursor: 9000 });

            holdTheSeek();
            recordHit(5000);

            await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
            await vi.advanceTimersByTimeAsync(500);

            expect(mockReplay.setPlayPosition).toHaveBeenCalledExactlyOnceWith(expect.anything(), 4940);
            expect(mockCamera.switchNum).not.toHaveBeenCalled();
            expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();

            // iRacing's search reaches the frame.
            buffer.cursor.frame = 4940;
            await vi.advanceTimersByTimeAsync(100);

            expect(mockCamera.switchNum).toHaveBeenCalledExactlyOnceWith(4, 0, 0);
            expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
            expect(mockReplay.setPlayPosition).toHaveBeenCalledTimes(1);
          } finally {
            vi.useRealTimers();
          }
        });

        it("pauses a moving replay before the seek, so the landing can be read", async () => {
          vi.useFakeTimers();

          try {
            singleSessionBuffer(4, 4);
            recordHit(5000);
            const readPaused = controller.getCurrentTelemetry;

            // Moving until the sequence's pause, `setPlaySpeed(0)`, has been sent.
            controller.getCurrentTelemetry = vi.fn(() => ({
              ...(readPaused() as object),
              ReplayPlaySpeed: mockReplay.setPlaySpeed.mock.calls.length > 0 ? 0 : 1,
            })) as any;

            await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
            await vi.runAllTimersAsync();

            // The pause, then (after the landing) the setting's speed.
            expect(mockReplay.setPlaySpeed.mock.calls).toEqual([[0], [1, false]]);
            expect(mockReplay.setPlaySpeed.mock.invocationCallOrder[0]).toBeLessThan(
              mockReplay.setPlayPosition.mock.invocationCallOrder[0],
            );
            expect(mockReplay.setPlayPosition.mock.invocationCallOrder[0]).toBeLessThan(
              mockReplay.setPlaySpeed.mock.invocationCallOrder[1],
            );
          } finally {
            vi.useRealTimers();
          }
        });

        it("a jump that never lands warns and sends nothing more, leaving the replay where it stopped", async () => {
          vi.useFakeTimers();

          try {
            singleSessionBuffer(4, 4, { initialCursor: 9000 });
            holdTheSeek();
            recordHit(5000);

            await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
            await vi.runAllTimersAsync();

            expect(logger.warn).toHaveBeenCalledWith("Jump to fastest lap: jump did not land; nothing more sent");
            expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("target=4940 lastFrame=9000"));
            expect(mockCamera.switchNum).not.toHaveBeenCalled();
            expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
            expect(mockReplay.setPlayPosition).toHaveBeenCalledTimes(1);
            expect(_activeLapPress()).toBeNull();
          } finally {
            vi.useRealTimers();
          }
        });

        it("a second press while the jump waits is ignored before any command", async () => {
          vi.useFakeTimers();

          try {
            const buffer = singleSessionBuffer(4, 4, { initialCursor: 9000 });

            holdTheSeek();
            recordHit(5000);

            await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
            await vi.advanceTimersByTimeAsync(200);
            await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });

            expect(logger.info).toHaveBeenCalledWith(
              "Jump to fastest lap: previous press still in flight; press ignored",
            );
            expect(mockReplay.setPlayPosition).toHaveBeenCalledTimes(1);
            expect(mockStore.laps.findLapStart).toHaveBeenCalledTimes(1);

            buffer.cursor.frame = 4940;
            await vi.runAllTimersAsync();

            expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
          } finally {
            vi.useRealTimers();
          }
        });

        it("a Replay Markers-style jump during the wait cancels it; nothing more is sent", async () => {
          vi.useFakeTimers();

          try {
            const buffer = singleSessionBuffer(4, 4, { initialCursor: 9000 });

            holdTheSeek();
            recordHit(5000);

            await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
            await vi.advanceTimersByTimeAsync(200);

            expect(cancelReplayCursorOwner("next")).toBe("jump-to-fastest-lap record jump");
            expect(logger.info).toHaveBeenCalledWith("Jump to fastest lap: jump cancelled by next");

            // Even if the cursor now reads the target, the cancelled jump sends nothing.
            buffer.cursor.frame = 4940;
            await vi.runAllTimersAsync();

            expect(mockCamera.switchNum).not.toHaveBeenCalled();
            expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
            expect(_activeLapPress()).toBeNull();
          } finally {
            vi.useRealTimers();
          }
        });

        it("a failed camera switch after the landing warns and sends no speed", async () => {
          vi.useFakeTimers();

          try {
            singleSessionBuffer(4, 4);
            recordHit(5000);
            mockCamera.switchNum.mockReturnValueOnce(false);

            await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
            await vi.runAllTimersAsync();

            expect(logger.warn).toHaveBeenCalledWith(
              "Jump to fastest lap: camera switch failed; replay left at the lap start",
            );
            expect(mockReplay.setPlayPosition).toHaveBeenCalledExactlyOnceWith(expect.anything(), 4940);
            expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
            // The replay was paused at the press, so no pause went out: the keys read it paused.
            expect(sentSpeeds).toEqual([]);
            expect(shownSpeed().speed).toBe(0);
          } finally {
            vi.useRealTimers();
          }
        });

        /** Overlay fields on the buffer's telemetry, computed at each read. */
        function overlayTelemetry(fields: () => Record<string, unknown>): void {
          const read = controller.getCurrentTelemetry;

          controller.getCurrentTelemetry = vi.fn(() => ({ ...(read() as object), ...fields() })) as any;
        }

        it("treats an unknown speed as moving: pauses, and seeks only once the pause shows", async () => {
          vi.useFakeTimers();

          try {
            singleSessionBuffer(4, 4);
            recordHit(5000);
            // No speed at all until the pause has registered, a few polls later.
            let pausedAt: number | null = null;

            overlayTelemetry(() => {
              if (mockReplay.setPlaySpeed.mock.calls.length > 0) pausedAt ??= Date.now();

              return { ReplayPlaySpeed: pausedAt !== null && Date.now() - pausedAt >= 200 ? 0 : undefined };
            });

            await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
            await vi.advanceTimersByTimeAsync(100);

            expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(0);
            expect(mockReplay.setPlayPosition).not.toHaveBeenCalled();

            await vi.runAllTimersAsync();

            expect(mockReplay.setPlayPosition).toHaveBeenCalledExactlyOnceWith(expect.anything(), 4940);
            expect(mockReplay.setPlaySpeed.mock.calls).toEqual([[0], [1, false]]);
          } finally {
            vi.useRealTimers();
          }
        });

        it("a pause the SDK refuses sends no jump and records no speed", async () => {
          vi.useFakeTimers();

          try {
            singleSessionBuffer(4, 4);
            recordHit(5000);
            overlayTelemetry(() => ({ ReplayPlaySpeed: 1 }));
            mockReplay.setPlaySpeed.mockReturnValueOnce(false);

            await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
            await vi.runAllTimersAsync();

            expect(logger.warn).toHaveBeenCalledWith("Jump to fastest lap: pause failed; jump not sent");
            expect(mockReplay.setPlayPosition).not.toHaveBeenCalled();
            expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(0);
            // A refused pause is never the engine's speed (#1467).
            expect(sentSpeeds).toEqual([]);
          } finally {
            vi.useRealTimers();
          }
        });

        it("a pause that never shows in telemetry sends no jump", async () => {
          vi.useFakeTimers();

          try {
            singleSessionBuffer(4, 4);
            recordHit(5000);
            overlayTelemetry(() => ({ ReplayPlaySpeed: 1 }));

            await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
            await vi.runAllTimersAsync();

            expect(logger.warn).toHaveBeenCalledWith("Jump to fastest lap: replay did not pause; jump not sent");
            expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("lastSpeed=1"));
            expect(mockReplay.setPlayPosition).not.toHaveBeenCalled();
            expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(0);
          } finally {
            vi.useRealTimers();
          }
        });

        it("applies the setting as soon as the frame reads the target, without waiting out the SessionNum transient", async () => {
          vi.useFakeTimers();

          try {
            singleSessionBuffer(4, 4);
            recordHit(5000);
            // After the jump, the sim reports SessionNum -1 for longer than the whole timeout.
            overlayTelemetry(() => (mockReplay.setPlayPosition.mock.calls.length > 0 ? { SessionNum: -1 } : {}));

            await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
            await vi.advanceTimersByTimeAsync(50);

            expect(mockCamera.switchNum).toHaveBeenCalledExactlyOnceWith(4, 0, 0);
            expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
          } finally {
            vi.useRealTimers();
          }
        });

        it("waits at least three seconds for the landing, even at the lowest search delay", async () => {
          vi.useFakeTimers();

          try {
            // 50 ms × 4 would give up after 200 ms.
            setJumpPlayback("play", 50);

            const buffer = singleSessionBuffer(4, 4, { initialCursor: 9000 });

            holdTheSeek();
            recordHit(5000);

            await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
            await vi.advanceTimersByTimeAsync(2500);

            expect(logger.warn).not.toHaveBeenCalled();

            buffer.cursor.frame = 4940;
            await vi.runAllTimersAsync();

            expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
          } finally {
            vi.useRealTimers();
          }
        });
      });

      it("clamps the approach frame at 0 for a lap that starts inside the first second", async () => {
        vi.useFakeTimers();
        onTestFinished(() => void vi.useRealTimers());
        singleSessionBuffer(4, 4);
        recordHit(30);

        await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
        await vi.runAllTimersAsync();

        expect(mockReplay.setPlayPosition).toHaveBeenCalledWith(expect.anything(), 0);
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
      });

      it("passes WeekendInfo.SubSessionID to the lookup", async () => {
        vi.useFakeTimers();
        onTestFinished(() => void vi.useRealTimers());
        singleSessionBuffer(4, 4, { subSessionId: 86_697_546 });
        recordHit(5000);

        await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
        await vi.runAllTimersAsync();

        expect(mockStore.laps.findLapStart).toHaveBeenCalledWith(expect.objectContaining({ subSessionId: 86_697_546 }));
      });

      it("a miss logs the store's reason and walks", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4);
          mockStore.laps.findLapStart.mockImplementation(() => ({ hit: false, reason: "lap not recorded" }));

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(logger.info).toHaveBeenCalledWith("Jump to fastest lap: record MISS (lap not recorded); walking");
          expect(mockReplay.pause).toHaveBeenCalledTimes(1);
          expect(mockReplay.goToStart).toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      });

      it("walks when no store is initialized (a plugin without one), without touching the store", async () => {
        vi.useFakeTimers();

        try {
          const { isReplaySessionStoreInitialized } = await import("@iracedeck/replay-store");

          vi.mocked(isReplaySessionStoreInitialized).mockReturnValue(false);
          singleSessionBuffer(4, 4);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(logger.info).toHaveBeenCalledWith("Jump to fastest lap: record MISS (no store); walking");
          expect(mockStore.laps.findLapStart).not.toHaveBeenCalled();
          expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
          expect(mockReplay.pause).toHaveBeenCalledTimes(1);
          expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
        } finally {
          vi.useRealTimers();
        }
      });

      it("logs a FastestTime disagreement at debug and still jumps", async () => {
        vi.useFakeTimers();

        try {
          // ResultsPositions says 92.000 s; the record's lap 4 took 91.433 s.
          singleSessionBuffer(4, 4, { fastestTime: 92 });
          recordHit(5000, 91_433);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("FastestTime disagreement"));
          expect(mockReplay.setPlayPosition).toHaveBeenCalledWith(expect.anything(), 4940);
          expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
        } finally {
          vi.useRealTimers();
        }
      });

      it("stays quiet when FastestTime agrees with the record within a tick, or the lap is untimed", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4, { fastestTime: 91.44 });
          recordHit(5000, 91_433);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          recordHit(5000, null);
          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          // Both presses reached the lookup: the first jump had finished before the second.
          expect(mockStore.laps.findLapStart).toHaveBeenCalledTimes(2);
          expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining("FastestTime disagreement"));
        } finally {
          vi.useRealTimers();
        }
      });

      it("a press while a walk stands is ignored before any command, even when the record would hit", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          // Mid-walk: past the opening pause and the goToStart of the map build.
          await vi.advanceTimersByTimeAsync(1200);
          expect(mockReplay.goToStart).toHaveBeenCalledTimes(1);

          recordHit(5000);
          const commandsBefore = countReplayCommands();

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });

          // Ignored before the camera switch and before the lookup: the walk
          // in flight is converging on the same target, and a switchNum from
          // a key with another target would re-frame the car it is walking.
          expect(logger.info).toHaveBeenCalledWith(
            "Jump to fastest lap: previous press still in flight; press ignored",
          );
          expect(mockCamera.switchNum).toHaveBeenCalledTimes(1);
          expect(mockStore.laps.findLapStart).toHaveBeenCalledTimes(1);
          expect(countReplayCommands()).toBe(commandsBefore);
          expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("walk cancelled"));

          await vi.runAllTimersAsync();

          // The walk ran to its end untouched.
          expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
          expect(mockStore.laps.recordLapStart).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it("a Replay Markers-style jump (the shared cursor seam) during a walk cancels it; the walk sends nothing more", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.advanceTimersByTimeAsync(1200);

          const commandsBefore = countReplayCommands();

          // What replay-markers.ts does before its own setPlayPosition.
          expect(cancelReplayCursorOwner("next")).toBe("jump-to-fastest-lap walk");
          expect(logger.info).toHaveBeenCalledWith("Jump to fastest lap: walk cancelled by next");

          await runPressOut();

          expect(countReplayCommands()).toBe(commandsBefore);
          expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
          expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
          expect(_activeLapPress()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe("the end the walk reports to the gate (#1437)", () => {
      /** Every under-way end the gate notes for `ctx-1` until the returned stop. */
      function recordUnderWayEnds(): { ends: ReplayGateFactEnd[]; stop: () => void } {
        const ends: ReplayGateFactEnd[] = [];
        const stop = subscribeReplayGate((notice) => {
          if (notice.origin === "ctx-1") ends.push(...notice.ended.filter((end) => end.fact === "underWay"));
        });

        return { ends, stop };
      }

      it("a converged walk ends completed, as a jump that landed", async () => {
        vi.useFakeTimers();
        const { ends, stop } = recordUnderWayEnds();

        try {
          singleSessionBuffer(4, 4);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(logger.info).toHaveBeenCalledWith("Jump to fastest lap: walk converged (lap start recorded)");
          // The walk's own end is its last: completed. (Its probes end facts of their own on the way.)
          expect(ends.at(-1)).toEqual({ fact: "underWay", class: "completed", reason: "jump-landed" });
          expect(ends.some((end) => end.reason === "walk-gave-up")).toBe(false);
        } finally {
          stop();
          vi.useRealTimers();
        }
      });

      it("a walk that gives up still ends as one", async () => {
        vi.useFakeTimers();
        const { ends, stop } = recordUnderWayEnds();

        try {
          singleSessionBuffer(4, 4);
          // The cursor never moves on setPlayPosition.
          mockReplay.setPlayPosition.mockImplementation(() => true);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(logger.warn).toHaveBeenCalledWith("Jump to fastest lap: jump did not settle; aborting walk");
          // The way back's own seek, which never lands either, runs out after the walk has ended.
          expect(ends.filter((end) => end.reason === "walk-gave-up" || end.reason === "jump-landed")).toEqual([
            { fact: "underWay", class: "gave-up", reason: "walk-gave-up" },
          ]);
        } finally {
          stop();
          vi.useRealTimers();
        }
      });
    });

    describe("leaving the replay (#1467)", () => {
      /** Back in the car: out of the replay, and no seek shows. */
      const DRIVING = { IsReplayPlaying: false, IsOnTrack: true } as TelemetryData;
      /** A seek under way: out of the replay, nobody driving. */
      const SEEKING = { IsReplayPlaying: false, IsOnTrack: false } as TelemetryData;

      it("a fastest-lap walk stops when the replay is left, instead of running to its timeout", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4);
          let watchedInReplay = true;
          const watch = watchReplayLeft({
            replayState: () => ({ inReplay: watchedInReplay }),
            telemetry: () => DRIVING,
          });

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.advanceTimersByTimeAsync(1200);

          expect(_activeLapPress()).not.toBeNull();

          // The replay is left; the controller's poll ticks on. A probe's target still standing holds the
          // departure until it reads back.
          watchedInReplay = false;
          let commandsAtLeave: number | null = null;

          for (let waited = 0; waited < 10_000 && commandsAtLeave === null; waited += 20) {
            watch.tick();

            if (
              vi
                .mocked(logger.info)
                .mock.calls.some(([line]) => line === "Jump to fastest lap: walk cancelled by replay-left")
            ) {
              commandsAtLeave = countReplayCommands();
            } else {
              await vi.advanceTimersByTimeAsync(20);
            }
          }

          expect(commandsAtLeave).not.toBeNull();

          await runPressOut();

          // No further replay command, nothing recorded, and the press's slot and busy registration are gone.
          expect(countReplayCommands()).toBe(commandsAtLeave);
          expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
          expect(_activeLapPress()).toBeNull();
          expect(getReplayGateView("ctx-1").underWay).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

      it("a walk whose probe seek outlasts the one-second grace is not cancelled by its own seek", async () => {
        vi.useFakeTimers();
        let ticker: ReturnType<typeof setInterval> | null = null;

        try {
          const buffer = singleSessionBuffer(4, 4);
          // Every jump lands 1.5 s after it is sent, inside the walk's 1.6 s wait; in a live session the
          // debounced replay state gives the replay up a second into it.
          let pending: number | null = null;

          mockReplay.setPlayPosition.mockImplementation((_mode: unknown, frame: number) => {
            pending = Math.max(0, Math.min(buffer.bufferEnd(), frame));
            setTimeout(() => {
              buffer.cursor.frame = pending as number;
              pending = null;
            }, 1_500);

            return true;
          });

          const tickTelemetry = (): TelemetryData | null =>
            pending !== null ? SEEKING : controller.getCurrentTelemetry();
          const state = steppedReplayState(tickTelemetry);
          const watch = watchReplayLeft({ replayState: () => state.getReplayState(), telemetry: tickTelemetry });

          ticker = setInterval(() => watch.tick(), 20);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });

          // Positive control: a probe's seek did read as out of the replay past the grace.
          let sawOutOfReplay = false;

          for (let waited = 0; waited < 120_000 && _activeLapPress() !== null; waited += 100) {
            await vi.advanceTimersByTimeAsync(100);

            if (!state.getReplayState().inReplay) sawOutOfReplay = true;
          }

          expect(sawOutOfReplay).toBe(true);
          expect(logger.info).not.toHaveBeenCalledWith("Jump to fastest lap: walk cancelled by replay-left");
          expect(logger.info).toHaveBeenCalledWith("Jump to fastest lap: walk converged (lap start recorded)");
          expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
        } finally {
          if (ticker !== null) clearInterval(ticker);

          vi.useRealTimers();
        }
      });
    });

    describe("walk repairs (#1203)", () => {
      it("records the opening pause and the closing speed as sent, and under Play ends playing", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          // Nothing is under way, so the waits before the switch and the walk end with no timer.
          await vi.advanceTimersByTimeAsync(0);

          // The pause is sent before the walk's first timer; the engine records it at once.
          expect(mockReplay.pause).toHaveBeenCalledTimes(1);
          expect(sentSpeeds.at(-1)).toEqual({ speed: 0, slowMotion: false });

          await vi.runAllTimersAsync();

          expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
          expect(sentSpeeds.at(-1)).toEqual({ speed: 1, slowMotion: false });
          // The speed is the press's last command: after the back-step has landed.
          const lastJump = Math.max(...mockReplay.setPlayPosition.mock.invocationCallOrder);

          expect(mockReplay.setPlaySpeed.mock.invocationCallOrder[0]).toBeGreaterThan(lastJump);
          // The walk's own pause is the only pause(), and nothing calls play().
          expect(mockReplay.pause).toHaveBeenCalledTimes(1);
          expect(mockReplay.play).not.toHaveBeenCalled();
          expect(logger.info).toHaveBeenCalledWith("Jump to fastest lap: walk converged (lap start recorded)");
        } finally {
          vi.useRealTimers();
        }
      });

      it("a converged walk records its landed frame, back-adjusted by the back-step, with the time left to the store", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4, { subSessionId: 86_697_546, userId: 123_456 });

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          const backstepFrame = mockReplay.setPlayPosition.mock.calls.at(-1)?.[1];

          expect(typeof backstepFrame).toBe("number");
          expect(mockStore.laps.recordLapStart).toHaveBeenCalledTimes(1);
          expect(mockStore.laps.recordLapStart).toHaveBeenCalledWith({
            subSessionId: 86_697_546,
            sessionNum: 2,
            sessionUniqueId: 3,
            carIdx: 4,
            carNumberRaw: 4,
            userId: 123_456,
            lap: 4,
            frame: (backstepFrame as number) + 2,
          });
          // End of lap 3 in the fixture is frame 3999: the recorded start of lap 4 sits there.
          expect((backstepFrame as number) + 2).toBeGreaterThanOrEqual(3997);
          expect((backstepFrame as number) + 2).toBeLessThanOrEqual(3999);
        } finally {
          vi.useRealTimers();
        }
      });

      it("keeps no per-car frame cache: a second press whose record still misses walks again", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          mockReplay.setPlayPosition.mockClear();

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(mockReplay.setPlayPosition.mock.calls.length).toBeGreaterThan(1);
          expect(mockStore.laps.recordLapStart).toHaveBeenCalledTimes(2);
        } finally {
          vi.useRealTimers();
        }
      });

      it("does not record when no store is initialized, and still applies the setting", async () => {
        vi.useFakeTimers();

        try {
          const { isReplaySessionStoreInitialized } = await import("@iracedeck/replay-store");

          vi.mocked(isReplaySessionStoreInitialized).mockReturnValue(false);
          singleSessionBuffer(4, 4);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
          expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
          expect(logger.info).toHaveBeenCalledWith("Jump to fastest lap: walk converged (lap start not recorded)");
        } finally {
          vi.useRealTimers();
        }
      });

      it("an absolute jump waits for ReplayFrameNum to read the sent frame before the next command", async () => {
        vi.useFakeTimers();

        try {
          const buffer = singleSessionBuffer(4, 4);
          // Every jump lands 900 ms after it is sent: longer than the 400 ms
          // clock wait the old walk trusted (it would have read the previous
          // frame's telemetry and bisected the wrong bracket), shorter than
          // the 1600 ms settle timeout.
          let pending: number | null = null;
          let commandsWhileInFlight = 0;

          mockReplay.setPlayPosition.mockImplementation((_mode: unknown, frame: number) => {
            if (pending !== null) commandsWhileInFlight++;

            pending = Math.max(0, Math.min(buffer.bufferEnd(), frame));
            setTimeout(() => {
              buffer.cursor.frame = pending as number;
              pending = null;
            }, 900);

            return true;
          });

          for (const command of [mockReplay.nextLap, mockReplay.prevLap] as const) {
            const impl = command.getMockImplementation()!;

            command.mockImplementation(() => {
              if (pending !== null) commandsWhileInFlight++;

              return impl();
            });
          }

          // The speed that ends the press must wait for the back-step to land too.
          mockReplay.setPlaySpeed.mockImplementation(() => {
            if (pending !== null) commandsWhileInFlight++;

            return true;
          });

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(commandsWhileInFlight).toBe(0);
          expect(mockReplay.setPlayPosition.mock.calls.length).toBeGreaterThan(1);
          expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
          expect(buffer.cursor.frame).toBeGreaterThanOrEqual(3990);
          expect(buffer.cursor.frame).toBeLessThanOrEqual(3999);
        } finally {
          vi.useRealTimers();
        }
      });

      it("aborts past the settle timeout when no jump lands, the way back included, leaving the replay paused and the slot free", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4);
          // The cursor never moves on setPlayPosition.
          mockReplay.setPlayPosition.mockImplementation(() => true);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(logger.warn).toHaveBeenCalledWith("Jump to fastest lap: jump did not settle; aborting walk");
          // The probe, and the way back to the frame of the press (#1354), which does not land either.
          expect(mockReplay.setPlayPosition.mock.calls.map((call) => call[1])).toEqual([expect.any(Number), 5000]);
          expect(logger.warn).toHaveBeenCalledWith(
            "Jump to fastest lap: could not put the replay back; it is left paused where the search stopped",
          );
          // Whatever the setting says (Play here), an aborted walk stays paused.
          expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
          expect(sentSpeeds.at(-1)).toEqual({ speed: 0, slowMotion: false });
          expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();

          // The walk slot is released: the next press walks again.
          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(mockReplay.pause).toHaveBeenCalledTimes(2);
        } finally {
          vi.useRealTimers();
        }
      });

      it("a search waits for the frame to move and then hold before the next command", async () => {
        vi.useFakeTimers();

        try {
          const buffer = singleSessionBuffer(4, 4);
          // After a lap search the cursor is "in transit" for 120 ms: every
          // telemetry read shows a different frame (the sim resolving the
          // boundary), and only then does it hold at the landed frame.
          let transitUntil = 0;
          let reads = 0;
          let commandsInTransit = 0;
          const settled = controller.getCurrentTelemetry;

          controller.getCurrentTelemetry = vi.fn(() => {
            const tel = settled() as any;

            if (Date.now() < transitUntil) {
              reads++;

              return { ...tel, ReplayFrameNum: tel.ReplayFrameNum - 10 - (reads % 2) };
            }

            return tel;
          });

          for (const command of [mockReplay.nextLap, mockReplay.prevLap] as const) {
            const impl = command.getMockImplementation()!;

            command.mockImplementation(() => {
              if (Date.now() < transitUntil) commandsInTransit++;

              const result = impl();

              transitUntil = Date.now() + 120;

              return result;
            });
          }

          for (const command of [mockReplay.setPlayPosition, mockReplay.setPlaySpeed] as const) {
            const impl = command.getMockImplementation()!;

            command.mockImplementation((...args: any[]) => {
              if (Date.now() < transitUntil) commandsInTransit++;

              return (impl as (...a: any[]) => boolean)(...args);
            });
          }

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(mockReplay.nextLap.mock.calls.length + mockReplay.prevLap.mock.calls.length).toBeGreaterThan(0);
          expect(commandsInTransit).toBe(0);
          expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
          expect(buffer.cursor.frame).toBeGreaterThanOrEqual(3990);
          expect(buffer.cursor.frame).toBeLessThanOrEqual(3999);
        } finally {
          vi.useRealTimers();
        }
      });

      it("keeps fastestLapSearchDelayMs as the minimum gap after a search", async () => {
        vi.useFakeTimers();

        try {
          setJumpPlayback("play", 600);
          singleSessionBuffer(4, 4);

          const stamps: Array<{ name: string; at: number }> = [];
          const searches = new Set(["goToStart", "nextSession", "nextLap", "prevLap"]);

          for (const name of [
            "goToStart",
            "nextSession",
            "nextLap",
            "prevLap",
            "setPlayPosition",
            "setPlaySpeed",
          ] as const) {
            const command = mockReplay[name] as unknown as ReturnType<typeof vi.fn<(...args: any[]) => boolean>>;
            const impl = command.getMockImplementation()!;

            command.mockImplementation((...args: any[]) => {
              stamps.push({ name, at: Date.now() });

              return impl(...args);
            });
          }

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          const searchStamps = stamps.filter((s) => searches.has(s.name));

          expect(searchStamps.length).toBeGreaterThan(0);

          for (let i = 0; i < stamps.length - 1; i++) {
            if (!searches.has(stamps[i].name)) continue;

            expect(stamps[i + 1].at - stamps[i].at).toBeGreaterThanOrEqual(600);
          }

          // The press ran to its end: its speed command is the last stamp.
          expect(stamps.at(-1)?.name).toBe("setPlaySpeed");
        } finally {
          vi.useRealTimers();
        }
      });

      it("runs one walk per action instance: a second fastest-lap press from another key is ignored", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await pressJumpToFastestLap({ origin: "ctx-2", target: "viewed-car" });
          await vi.advanceTimersByTimeAsync(0);

          expect(mockReplay.pause).toHaveBeenCalledTimes(1);
          expect(mockCamera.switchNum).toHaveBeenCalledTimes(1);
          expect(logger.info).toHaveBeenCalledWith(
            "Jump to fastest lap: previous press still in flight; press ignored",
          );

          await vi.runAllTimersAsync();

          expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
          expect(mockStore.laps.recordLapStart).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe("the walk records only what it verified (#1203 review)", () => {
      it("lap-step budget exhausted: stays where it got to, warns, records nothing, and still applies the setting", async () => {
        vi.useFakeTimers();

        try {
          const buffer = singleSessionBuffer(4, 4);

          // A sim whose lap search moves the cursor one frame at a time:
          // every step "moves", none reaches the lap before the target.
          mockReplay.prevLap.mockImplementation(() => {
            buffer.cursor.frame -= 1;

            return true;
          });
          mockReplay.nextLap.mockImplementation(() => {
            buffer.cursor.frame += 1;

            return true;
          });

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(mockReplay.prevLap.mock.calls.length + mockReplay.nextLap.mock.calls.length).toBe(10);
          expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("walk did not converge (lap-step budget of 10 exhausted"),
          );
          expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
          expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("walk converged"));
          // The press still ends through the setting: Play here.
          expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
          expect(sentSpeeds.at(-1)).toEqual({ speed: 1, slowMotion: false });
          expect(_activeLapPress()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

      it("a nudge whose search did not move the cursor is non-convergence: nothing recorded", async () => {
        vi.useFakeTimers();

        try {
          // Fastest lap 6 → the lap-step lands at the START of lap 5 (dist 0),
          // so the walk nudges with nextLap; that second nextLap is ignored.
          const buffer = singleSessionBuffer(4, 6);
          const nextLap = mockReplay.nextLap.getMockImplementation()!;
          let nextLaps = 0;

          mockReplay.nextLap.mockImplementation(() => {
            nextLaps++;

            return nextLaps >= 2 ? true : nextLap();
          });

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(nextLaps).toBe(2);
          expect(logger.warn).toHaveBeenCalledWith(
            "Jump to fastest lap: walk did not converge (nudge (nextLap) unmoved); nothing recorded",
          );
          expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
          expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
          // Left two ticks before the start of lap 5, where the nudge left it.
          expect(buffer.cursor.frame).toBe(4998);
        } finally {
          vi.useRealTimers();
        }
      });

      it("a landing whose SessionUniqueID is not the target's is non-convergence: nothing recorded", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4);
          // The session restarts mid-walk: from the first lap search on, every
          // sample carries a new SessionUniqueID under the same SessionNum.
          const settled = controller.getCurrentTelemetry;

          controller.getCurrentTelemetry = vi.fn(() => {
            const tel = settled() as any;
            const lapSearches = mockReplay.nextLap.mock.calls.length + mockReplay.prevLap.mock.calls.length;

            return lapSearches > 0 ? { ...tel, SessionUniqueID: 4 } : tel;
          });

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("walk did not converge (landed outside the target session 2/3"),
          );
          expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
          expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
        } finally {
          vi.useRealTimers();
        }
      });

      it("a probe that reads another session drops the session map and puts the replay back (#1354)", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4);
          // From the first probe on, every sample carries another SessionUniqueID:
          // the bounds the map gave do not describe this recording.
          const settled = controller.getCurrentTelemetry;

          controller.getCurrentTelemetry = vi.fn(() => {
            const tel = settled() as any;
            const probing = mockReplay.setPlayPosition.mock.calls.length === 1;

            return probing ? { ...tel, SessionUniqueID: 4 } : tel;
          });

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining("read session 2/4; the session map does not match the recording, aborting"),
          );
          expect(_getFastestLapSessionCache()).toBeNull();
          // One probe, then the way back to the frame of the press; no lap search, nothing recorded.
          expect(mockReplay.setPlayPosition.mock.calls.map((call) => call[1])).toEqual([expect.any(Number), 5000]);
          expect(mockReplay.nextLap).not.toHaveBeenCalled();
          expect(mockReplay.prevLap).not.toHaveBeenCalled();
          expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
          expect(logger.info).toHaveBeenCalledWith("Jump to fastest lap: replay put back where the press found it");
        } finally {
          vi.useRealTimers();
        }
      });

      it("a converged walk's record names the session instance the landing sample showed", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4, { subSessionId: 555 });

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ subSessionId: 555, sessionNum: 2, sessionUniqueId: 3, lap: 4 }),
          );
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe("the session map follows the replay it describes (#1203 review)", () => {
      it("a live recording that grew after the map was built is bisected to its current end (no rebuild)", async () => {
        vi.useFakeTimers();

        try {
          const buffer = singleSessionBuffer(4, 4);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(mockReplay.goToStart).toHaveBeenCalledTimes(1);
          expect(mockStore.laps.recordLapStart).toHaveBeenCalledTimes(1);

          // Twenty more laps recorded since; the fastest is now lap 25.
          buffer.sessions[0].endFrame = 29_999;
          buffer.sessions[0].fastestLap = 25;

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          // Cache hit — and the end read live, so the bisection reached lap 24's end.
          expect(mockReplay.goToStart).toHaveBeenCalledTimes(1);
          expect(logger.warn).not.toHaveBeenCalled();
          expect(mockStore.laps.recordLapStart).toHaveBeenCalledTimes(2);

          const frame = mockStore.laps.recordLapStart.mock.calls[1][0].frame;

          expect(mockStore.laps.recordLapStart.mock.calls[1][0].lap).toBe(25);
          expect(frame).toBeGreaterThanOrEqual(24_997);
          expect(frame).toBeLessThanOrEqual(24_999);
        } finally {
          vi.useRealTimers();
        }
      });

      it("a second replay with the same small SessionUniqueIDs but another SubSessionID rebuilds the map", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4, { subSessionId: 100 });

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(_getFastestLapSessionCache()?.subSessionId).toBe(100);
          expect(mockReplay.goToStart).toHaveBeenCalledTimes(1);

          // Another .rpy in the same process: SessionUniqueID 3 again (they
          // restart at 1 per sim run), a different subsession.
          singleSessionBuffer(4, 4, { subSessionId: 200 });

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(mockReplay.goToStart).toHaveBeenCalledTimes(2);
          expect(_getFastestLapSessionCache()?.subSessionId).toBe(200);
          expect(mockStore.laps.recordLapStart).toHaveBeenLastCalledWith(
            expect.objectContaining({ subSessionId: 200, sessionUniqueId: 3 }),
          );
        } finally {
          vi.useRealTimers();
        }
      });

      it("a restarted session (same SessionNum, new SessionUniqueID) is a second entry, and the target's own instance is bisected", async () => {
        vi.useFakeTimers();

        try {
          multiSessionBuffer(
            4,
            [
              { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 999, framesPerLap: 100, fastestLap: 4 },
              {
                sessionNum: 0,
                sessionUniqueId: 2,
                startFrame: 1000,
                endFrame: 10_999,
                framesPerLap: 1000,
                fastestLap: 4,
              },
            ],
            { initialCursor: 5000 },
          );

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(_getFastestLapSessionCache()?.sessions).toEqual([
            { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 999 },
            { sessionNum: 0, sessionUniqueId: 2, startFrame: 1000, endFrame: null },
          ]);

          // Every probe stayed inside the second instance's bounds.
          for (const call of mockReplay.setPlayPosition.mock.calls) {
            expect(call[1]).toBeGreaterThanOrEqual(1000);
          }

          // End of lap 3 in the second instance: 1000 + 3999.
          const frame = mockStore.laps.recordLapStart.mock.calls[0][0].frame;

          expect(frame).toBeGreaterThanOrEqual(4997);
          expect(frame).toBeLessThanOrEqual(4999);
          expect(mockStore.laps.recordLapStart).toHaveBeenCalledWith(
            expect.objectContaining({ sessionNum: 0, sessionUniqueId: 2, lap: 4 }),
          );
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe("the walk refuses what it cannot verify (#1203 review)", () => {
      it("sends nothing from the car: IsReplayPlaying !== true refuses the press before the camera switch, hit or miss", async () => {
        singleSessionBuffer(4, 4);
        const settled = controller.getCurrentTelemetry;

        controller.getCurrentTelemetry = vi.fn(() => ({
          ...(settled() as any),
          IsReplayPlaying: false,
        }));

        await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });

        mockStore.laps.findLapStart.mockImplementation(() => ({
          hit: true,
          frame: 5000,
          timeMs: null,
          matchedBy: "pair",
        }));
        await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });

        expect(logger.info).toHaveBeenCalledWith(
          "Jump to fastest lap: replay not open; iRacing ignores replay commands from the car",
        );
        expect(mockCamera.switchNum).not.toHaveBeenCalled();
        expect(mockStore.laps.findLapStart).not.toHaveBeenCalled();
        expect(countReplayCommands()).toBe(0);
        expect(_getFastestLapSessionCache()).toBeNull();
      });

      it.each<[string, LapStartLookup]>([
        ["a record hit jumps", { hit: true, frame: 5000, timeMs: null, matchedBy: "pair" }],
        ["a record miss walks", { hit: false, reason: "lap not recorded" }],
      ])(
        "accepts a press inside the post-seek grace, where IsReplayPlaying reads false (#1324): %s",
        async (_name, lookup) => {
          vi.useFakeTimers();

          try {
            singleSessionBuffer(4, 4);
            mockStore.laps.findLapStart.mockImplementation(() => lookup);
            const settled = controller.getCurrentTelemetry;

            // A replay tick, then ~300 ms of the blip every seek leaves behind.
            controller.getReplayState();
            controller.getCurrentTelemetry = vi.fn(() => ({
              ...(settled() as any),
              IsReplayPlaying: false,
            }));
            await vi.advanceTimersByTimeAsync(300);

            await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
            controller.getCurrentTelemetry = settled;
            await vi.runAllTimersAsync();

            expect(logger.info).not.toHaveBeenCalledWith(
              "Jump to fastest lap: replay not open; iRacing ignores replay commands from the car",
            );
            expect(mockStore.laps.findLapStart).toHaveBeenCalledTimes(1);

            if (lookup.hit) {
              expect(mockReplay.setPlayPosition).toHaveBeenCalledExactlyOnceWith(expect.anything(), 4940);
            } else {
              expect(mockReplay.goToStart).toHaveBeenCalled();
            }
          } finally {
            vi.useRealTimers();
          }
        },
      );

      // The debounced state admits a press inside the grace, which also
      // covers the second after the user left for the car through iRacing's
      // own UI — indistinguishable at press time. The walk's own samples
      // settle it: the raw flag never reads true from the car (#1324 review).
      describe("a map built inside the grace is kept only once the raw flag has read true", () => {
        const RAN_FROM_CAR =
          "Jump to fastest lap: the walk ran from the car (IsReplayPlaying never read true); session map discarded";

        /** A replay tick sighted, then the flag false from here on: the press lands 300 ms into the grace. */
        async function pressInsideGrace() {
          singleSessionBuffer(4, 4);
          const settled = controller.getCurrentTelemetry;

          controller.getReplayState();
          controller.getCurrentTelemetry = vi.fn(() => ({
            ...(settled() as any),
            IsReplayPlaying: false,
          }));
          await vi.advanceTimersByTimeAsync(300);
          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });

          return settled;
        }

        it("caches nothing and sends no jump when no sample of the walk reads the flag true: the user was back in the car", async () => {
          vi.useFakeTimers();

          try {
            await pressInsideGrace();
            await runPressOut();

            // The raw flag reading false is a seek to the replay command gate
            // while the debounced state still holds the replay, so the camera
            // switch waits for it to end (#1430). The gate and the walk read
            // the one debounced state: once the grace runs out the gate counts
            // the replay left, so the wait ends without giving up, and the walk
            // refuses before it sends anything, where it used to run and learn
            // from its own samples that it ran from the car.
            expect(logger.debug).not.toHaveBeenCalledWith(
              "Jump to fastest lap: a jump was still under way; camera switched anyway",
            );
            expect(logger.info).toHaveBeenCalledWith(
              "Jump to fastest lap: replay not open; iRacing ignores replay commands from the car",
            );
            expect(countReplayCommands()).toBe(0);
            expect(_getFastestLapSessionCache()).toBeNull();
            expect(mockReplay.setPlayPosition).not.toHaveBeenCalled();
            expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
          } finally {
            vi.useRealTimers();
          }
        });

        it("caches the map and completes the walk when the flag returns true after the blip: the press really was post-seek", async () => {
          vi.useFakeTimers();

          try {
            const settled = await pressInsideGrace();

            // The blip ends: every sample from here reads the replay.
            controller.getCurrentTelemetry = settled;
            await vi.runAllTimersAsync();

            expect(logger.info).not.toHaveBeenCalledWith(RAN_FROM_CAR);
            expect(_getFastestLapSessionCache()?.sessions.map((s) => s.sessionUniqueId)).toEqual([3]);
            expect(mockStore.laps.recordLapStart).toHaveBeenCalledTimes(1);
          } finally {
            vi.useRealTimers();
          }
        });
      });

      it("a goToStart that leaves the cursor away from frame 0 aborts the map build and caches nothing", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4);
          mockReplay.goToStart.mockImplementation(() => true);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await runPressOut();

          expect(logger.warn).toHaveBeenCalledWith(
            "Jump to fastest lap: goToStart did not move the cursor; aborting map build",
          );
          expect(_getFastestLapSessionCache()).toBeNull();
          expect(mockReplay.nextSession).not.toHaveBeenCalled();
          expect(mockReplay.setPlayPosition).not.toHaveBeenCalled();
          expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
          expect(sentSpeeds.at(-1)).toEqual({ speed: 0, slowMotion: false });
          expect(_activeLapPress()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

      it("a goToStart that does not move a cursor already at frame 0 is the one legitimate no-op", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4, { initialCursor: 0 });

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(_getFastestLapSessionCache()?.sessions).toHaveLength(1);
          expect(mockStore.laps.recordLapStart).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it("a nextSession that moves the cursor but never settles aborts the build and caches nothing", async () => {
        vi.useFakeTimers();

        try {
          multiSessionBuffer(
            4,
            [
              { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 999, framesPerLap: 100, fastestLap: -1 },
              {
                sessionNum: 2,
                sessionUniqueId: 3,
                startFrame: 1000,
                endFrame: 10_999,
                framesPerLap: 1000,
                fastestLap: 4,
              },
            ],
            { initialCursor: 5000 },
          );
          // After nextSession the cursor seeks on disk and never holds a
          // frame within the timeout.
          const settled = controller.getCurrentTelemetry;
          let seeking = false;

          // The frame flips at every one of the walk's polls. By the clock,
          // not by the read: the replay command gate reads the telemetry too.
          controller.getCurrentTelemetry = vi.fn(() => {
            const tel = settled() as any;

            if (!seeking) return tel;

            return { ...tel, ReplayFrameNum: tel.ReplayFrameNum + 100 + (Math.floor(Date.now() / 50) % 2) };
          });
          mockReplay.nextSession.mockImplementation(() => {
            seeking = true;

            return true;
          });

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(logger.warn).toHaveBeenCalledWith(
            "Jump to fastest lap: nextSession #1 moved the cursor but it never settled; aborting",
          );
          expect(_getFastestLapSessionCache()).toBeNull();
          // No probe: the one seek is the way back to the frame of the press (#1354).
          expect(mockReplay.setPlayPosition.mock.calls.map((call) => call[1])).toEqual([5000]);
          expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
          expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe("a search's decision sample is taken after the gap (#1203 review)", () => {
      it("an intermediate frame the sim holds for a while before the gap ends is not taken as the landing", async () => {
        vi.useFakeTimers();

        try {
          const buffer = singleSessionBuffer(4, 4);
          // After each lap search the telemetry reports a frame ten short of
          // the landing for 250 ms — held across several 50 ms reads — and
          // only then the frame the cursor actually landed on.
          let intermediateUntil = 0;
          const settled = controller.getCurrentTelemetry;

          controller.getCurrentTelemetry = vi.fn(() => {
            const tel = settled() as any;

            return Date.now() < intermediateUntil ? { ...tel, ReplayFrameNum: tel.ReplayFrameNum - 10 } : tel;
          });

          for (const command of [mockReplay.nextLap, mockReplay.prevLap] as const) {
            const impl = command.getMockImplementation()!;

            command.mockImplementation(() => {
              const result = impl();

              intermediateUntil = Date.now() + 250;

              return result;
            });
          }

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          // The back-step was computed from the true landing (3999), not the
          // intermediate 3989: it targets 3997 and the record says 3999.
          expect(mockReplay.setPlayPosition.mock.calls.at(-1)?.[1]).toBe(3997);
          expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ frame: 3999 }),
          );
          expect(buffer.cursor.frame).toBe(3997);
        } finally {
          vi.useRealTimers();
        }
      });

      it("the post-pause sample that keys the map is read out of the SessionNum -1 transient", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4);
          // The pause lands the cursor in the transient for 700 ms: SessionNum
          // -1 and a SessionUniqueID of 0 that the old walk keyed on.
          let transientUntil = 0;
          const settled = controller.getCurrentTelemetry;

          controller.getCurrentTelemetry = vi.fn(() => {
            const tel = settled() as any;

            return Date.now() < transientUntil ? { ...tel, SessionNum: -1, SessionUniqueID: 0, CarIdxLap: [] } : tel;
          });
          mockReplay.pause.mockImplementation(() => {
            transientUntil = Date.now() + 700;

            return true;
          });

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(logger.warn).not.toHaveBeenCalled();
          expect([..._getFastestLapSessionCache()!.sessionUniqueIds]).toEqual([3]);
          expect(mockStore.laps.recordLapStart).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ sessionUniqueId: 3 }),
          );
        } finally {
          vi.useRealTimers();
        }
      });

      it("a pause whose telemetry never leaves the transient aborts the walk before any search", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4);
          const settled = controller.getCurrentTelemetry;
          let paused = false;

          controller.getCurrentTelemetry = vi.fn(() => {
            const tel = settled() as any;

            return paused ? { ...tel, SessionNum: -1, SessionUniqueID: 0 } : tel;
          });
          mockReplay.pause.mockImplementation(() => {
            paused = true;

            return true;
          });

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(logger.warn).toHaveBeenCalledWith(
            "Jump to fastest lap: telemetry did not settle after pause; aborting",
          );
          expect(mockReplay.goToStart).not.toHaveBeenCalled();
          expect(_getFastestLapSessionCache()).toBeNull();
          expect(_activeLapPress()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe("Replay jump playback (#1276)", () => {
      type Speed = { speed: number; slowMotion: boolean };
      /** One row: the state's name, the setting, the speed before the press, the commands expected, the speed left. */
      type PlaybackCase = [string, ReplayJumpPlayback, Speed, string[], Speed];

      const PAUSED: Speed = { speed: 0, slowMotion: false };
      const NORMAL: Speed = { speed: 1, slowMotion: false };
      const QUARTER: Speed = { speed: 4, slowMotion: true };
      const FORWARD_8: Speed = { speed: 8, slowMotion: false };
      const REWIND_8: Speed = { speed: -8, slowMotion: false };

      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      /**
       * Makes the buffer's replay speed live and lists what is sent. The
       * telemetry reports the speed last commanded the way iRacing does (the
       * raw value plus the slow-motion flag) — through `setPlaySpeed`, or
       * through `pause()`, which only the walk's opening sends. `commands`
       * holds every speed command, seek and camera switch in the order sent.
       * `holdSeeks` leaves the cursor where it is until the test moves it,
       * as a long iRacing search does.
       */
      function liveReplay(initial: Speed, options: { holdSeeks?: boolean } = {}) {
        let current = initial;
        const commands: string[] = [];
        const readBuffer = controller.getCurrentTelemetry;
        const moveCursor = mockReplay.setPlayPosition.getMockImplementation();

        controller.getCurrentTelemetry = vi.fn((): TelemetryData => ({
          ...readBuffer(),
          ReplayPlaySpeed: replaySpeedToSdk(current.speed, current.slowMotion),
          ReplayPlaySlowMotion: current.slowMotion,
        }));
        mockReplay.pause.mockImplementation(() => {
          commands.push("pause");
          current = PAUSED;

          return true;
        });
        mockReplay.setPlaySpeed.mockImplementation((speed, slowMotion = false) => {
          commands.push(`speed ${speed}${slowMotion ? " slow" : ""}`);
          current = { speed, slowMotion };

          return true;
        });
        mockReplay.setPlayPosition.mockImplementation((mode, frame) => {
          commands.push(`seek ${frame}`);

          return options.holdSeeks ? true : (moveCursor?.(mode, frame) ?? true);
        });
        mockCamera.switchNum.mockImplementation(() => {
          commands.push("camera");

          return true;
        });

        return {
          commands,
          /** The speed commands alone: a walk sends many seeks between them. */
          speedCommands: (): string[] => commands.filter((c) => c === "pause" || c.startsWith("speed")),
          /** What is sent after the last seek. */
          afterLastSeek: (): string[] =>
            commands.slice(commands.map((c) => c.startsWith("seek")).lastIndexOf(true) + 1),
          /** The speed telemetry reports now. */
          speed: (): Speed => current,
        };
      }

      /** The speed the icons and the Play key read: the engine's one record of it (#1467). */
      const cachedSpeed = () => shownSpeed();

      async function press(): Promise<void> {
        await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
      }

      const recordHit = (frame: number) =>
        mockStore.laps.findLapStart.mockImplementation(() => ({ hit: true, frame, timeMs: null, matchedBy: "pair" }));

      describe("a record hit", () => {
        it.each<PlaybackCase>([
          ["paused", "remember", PAUSED, ["seek 4940", "camera"], PAUSED],
          ["paused", "play", PAUSED, ["seek 4940", "camera", "speed 1"], NORMAL],
          ["paused", "stopped", PAUSED, ["seek 4940", "camera"], PAUSED],
          ["playing at 1x", "remember", NORMAL, ["speed 0", "seek 4940", "camera", "speed 1"], NORMAL],
          ["playing at 1x", "play", NORMAL, ["speed 0", "seek 4940", "camera", "speed 1"], NORMAL],
          ["playing at 1x", "stopped", NORMAL, ["speed 0", "seek 4940", "camera"], PAUSED],
          [
            "in slow motion at 1/4x",
            "remember",
            QUARTER,
            ["speed 0", "seek 4940", "camera", "speed 4 slow"],
            QUARTER,
          ],
          ["in slow motion at 1/4x", "play", QUARTER, ["speed 0", "seek 4940", "camera", "speed 1"], NORMAL],
          ["in slow motion at 1/4x", "stopped", QUARTER, ["speed 0", "seek 4940", "camera"], PAUSED],
          ["fast-forwarding at 8x", "remember", FORWARD_8, ["speed 0", "seek 4940", "camera", "speed 8"], FORWARD_8],
          ["fast-forwarding at 8x", "play", FORWARD_8, ["speed 0", "seek 4940", "camera", "speed 1"], NORMAL],
          ["fast-forwarding at 8x", "stopped", FORWARD_8, ["speed 0", "seek 4940", "camera"], PAUSED],
          ["rewinding at -8x", "remember", REWIND_8, ["speed 0", "seek 4940", "camera", "speed -8"], REWIND_8],
          ["rewinding at -8x", "play", REWIND_8, ["speed 0", "seek 4940", "camera", "speed 1"], NORMAL],
          ["rewinding at -8x", "stopped", REWIND_8, ["speed 0", "seek 4940", "camera"], PAUSED],
        ])(
          "from a replay %s, %s: the commands in order and the speed left",
          async (_state, mode, before, commands, after) => {
            setJumpPlayback(mode);
            singleSessionBuffer(4, 4);
            const replay = liveReplay(before);

            recordHit(5000);
            await press();
            await vi.runAllTimersAsync();

            expect(replay.commands).toEqual(commands);
            expect(replay.speed()).toEqual(after);
            expect(cachedSpeed()).toEqual(after);
            // The shared sequence speaks setPlaySpeed only.
            expect(mockReplay.play).not.toHaveBeenCalled();
            expect(mockReplay.pause).not.toHaveBeenCalled();
            expect(_activeLapPress()).toBeNull();
          },
        );

        it("an absent setting is Remember", async () => {
          setJumpPlayback(undefined);
          singleSessionBuffer(4, 4);
          const replay = liveReplay(FORWARD_8);

          recordHit(5000);
          await press();
          await vi.runAllTimersAsync();

          expect(replay.commands).toEqual(["speed 0", "seek 4940", "camera", "speed 8"]);
          expect(cachedSpeed()).toEqual(FORWARD_8);
        });

        it("remembers slow motion from what iRacing reports: raw 3 with the flag is 1/4x, restored as setPlaySpeed(4, true)", async () => {
          setJumpPlayback("remember");
          singleSessionBuffer(4, 4);
          liveReplay(QUARTER);
          recordHit(5000);

          expect(controller.getCurrentTelemetry()).toMatchObject({
            ReplayPlaySpeed: 3,
            ReplayPlaySlowMotion: true,
          });

          await press();
          await vi.runAllTimersAsync();

          expect(mockReplay.setPlaySpeed.mock.calls).toEqual([[0], [4, true]]);
        });

        it("sends nothing between the seek and the landing; the camera switch comes after it and before the speed", async () => {
          setJumpPlayback("remember");
          const buffer = singleSessionBuffer(4, 4, { initialCursor: 9000 });
          const replay = liveReplay(NORMAL, { holdSeeks: true });

          recordHit(5000);
          await press();
          await vi.advanceTimersByTimeAsync(1000);

          expect(replay.commands).toEqual(["speed 0", "seek 4940"]);
          // The sequence's own pause is in the cache while it waits.
          expect(cachedSpeed()).toEqual(PAUSED);

          // iRacing's search reaches the frame.
          buffer.cursor.frame = 4940;
          await vi.advanceTimersByTimeAsync(100);

          expect(replay.commands).toEqual(["speed 0", "seek 4940", "camera", "speed 1"]);
          expect(cachedSpeed()).toEqual(NORMAL);
        });

        it.each<ReplayJumpPlayback>(["remember", "play", "stopped"])(
          "%s: a jump that never lands warns, sends nothing after the seek, and the cache says paused",
          async (mode) => {
            setJumpPlayback(mode);
            singleSessionBuffer(4, 4, { initialCursor: 9000 });
            const replay = liveReplay(NORMAL, { holdSeeks: true });

            recordHit(5000);
            await press();
            await vi.runAllTimersAsync();

            expect(logger.warn).toHaveBeenCalledWith("Jump to fastest lap: jump did not land; nothing more sent");
            // The last frame seen is named with the frame sent.
            expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("target=4940 lastFrame=9000"));
            expect(replay.commands).toEqual(["speed 0", "seek 4940"]);
            expect(replay.speed()).toEqual(PAUSED);
            expect(cachedSpeed()).toEqual(PAUSED);
            expect(_activeLapPress()).toBeNull();
          },
        );

        it("a second replay command during the wait ends the jump with no further command", async () => {
          setJumpPlayback("play");
          const buffer = singleSessionBuffer(4, 4, { initialCursor: 9000 });
          const replay = liveReplay(FORWARD_8, { holdSeeks: true });

          recordHit(5000);
          await press();
          await vi.advanceTimersByTimeAsync(300);

          expect(replay.commands).toEqual(["speed 0", "seek 4940"]);

          // What any other replay key does before its own command.
          expect(cancelReplayCursorOwner("next")).toBe("jump-to-fastest-lap record jump");
          expect(logger.info).toHaveBeenCalledWith("Jump to fastest lap: jump cancelled by next");

          // Even with the cursor on the target now, the cancelled jump sends nothing.
          buffer.cursor.frame = 4940;
          await vi.runAllTimersAsync();

          expect(replay.commands).toEqual(["speed 0", "seek 4940"]);
          expect(_activeLapPress()).toBeNull();
        });

        it("a seek the SDK refuses warns and sends nothing more", async () => {
          setJumpPlayback("play");
          singleSessionBuffer(4, 4);
          liveReplay(PAUSED);
          mockReplay.setPlayPosition.mockImplementation(() => false);
          recordHit(5000);

          await press();
          await vi.runAllTimersAsync();

          expect(logger.warn).toHaveBeenCalledWith("Jump to fastest lap: jump not sent");
          expect(mockReplay.setPlayPosition).toHaveBeenCalledExactlyOnceWith(expect.anything(), 4940);
          expect(mockCamera.switchNum).not.toHaveBeenCalled();
          expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
          expect(_activeLapPress()).toBeNull();
        });

        it("a speed command the SDK refuses warns, and the cache says what the replay is still doing", async () => {
          setJumpPlayback("play");
          singleSessionBuffer(4, 4);
          liveReplay(PAUSED);
          mockReplay.setPlaySpeed.mockImplementation(() => false);
          recordHit(5000);

          await press();
          await vi.runAllTimersAsync();

          expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
          expect(logger.warn).toHaveBeenCalledWith(
            "Jump to fastest lap: speed command failed; replay left paused on the frame",
          );
          expect(cachedSpeed()).toEqual(PAUSED);
        });
      });

      describe("the walk", () => {
        it.each<PlaybackCase>([
          ["paused", "remember", PAUSED, ["pause"], PAUSED],
          ["playing at 1x", "remember", NORMAL, ["pause", "speed 1"], NORMAL],
          ["in slow motion at 1/4x", "remember", QUARTER, ["pause", "speed 4 slow"], QUARTER],
          ["fast-forwarding at 8x", "remember", FORWARD_8, ["pause", "speed 8"], FORWARD_8],
          ["rewinding at -8x", "remember", REWIND_8, ["pause", "speed -8"], REWIND_8],
          ["paused", "play", PAUSED, ["pause", "speed 1"], NORMAL],
          ["rewinding at -8x", "play", REWIND_8, ["pause", "speed 1"], NORMAL],
          ["paused", "stopped", PAUSED, ["pause"], PAUSED],
          ["playing at 1x", "stopped", NORMAL, ["pause"], PAUSED],
        ])(
          "from a replay %s, %s: the speed captured at the press is what the end applies",
          async (_state, mode, before, speedCommands, after) => {
            setJumpPlayback(mode);
            singleSessionBuffer(4, 4);
            const replay = liveReplay(before);

            await press();
            // Nothing is under way, so the waits before the camera switch and
            // before the walk settle at once, with no timer.
            await vi.advanceTimersByTimeAsync(0);

            // The walk's own pause is out before its first timer: the speed
            // to restore was read at the press, before it, not after.
            expect(replay.speedCommands()).toEqual(["pause"]);
            expect(cachedSpeed()).toEqual(PAUSED);

            await vi.runAllTimersAsync();

            expect(replay.speedCommands()).toEqual(speedCommands);
            // The speed, when one is sent, follows the back-step's landing.
            expect(replay.afterLastSeek()).toEqual(speedCommands.slice(1));
            expect(replay.speed()).toEqual(after);
            expect(cachedSpeed()).toEqual(after);
            expect(mockReplay.play).not.toHaveBeenCalled();
            expect(mockStore.laps.recordLapStart).toHaveBeenCalledTimes(1);
            expect(_activeLapPress()).toBeNull();
          },
        );

        it.each<[ReplayJumpPlayback, string[], Speed]>([
          ["remember", ["pause", "speed 8"], FORWARD_8],
          ["play", ["pause", "speed 1"], NORMAL],
          ["stopped", ["pause"], PAUSED],
        ])(
          "%s: a walk that did not converge also ends through the setting, and records nothing",
          async (mode, speedCommands, after) => {
            setJumpPlayback(mode);
            // Fastest lap 6: the lap-step lands at the start of lap 5, and
            // the nudge's nextLap is ignored by the sim.
            singleSessionBuffer(4, 6);
            const nextLap = mockReplay.nextLap.getMockImplementation()!;
            let nextLaps = 0;

            mockReplay.nextLap.mockImplementation(() => {
              nextLaps++;

              return nextLaps >= 2 ? true : nextLap();
            });

            const replay = liveReplay(FORWARD_8);

            await press();
            await vi.runAllTimersAsync();

            expect(logger.warn).toHaveBeenCalledWith(
              "Jump to fastest lap: walk did not converge (nudge (nextLap) unmoved); nothing recorded",
            );
            expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
            expect(replay.speedCommands()).toEqual(speedCommands);
            expect(replay.afterLastSeek()).toEqual(speedCommands.slice(1));
            expect(replay.speed()).toEqual(after);
            expect(cachedSpeed()).toEqual(after);
          },
        );

        it.each<ReplayJumpPlayback>(["remember", "play"])(
          "%s: an aborted walk whose way back does not land stays paused where it stopped",
          async (mode) => {
            setJumpPlayback(mode);
            singleSessionBuffer(4, 4);
            // No absolute jump ever lands.
            const replay = liveReplay(NORMAL, { holdSeeks: true });

            await press();
            await vi.runAllTimersAsync();

            expect(logger.warn).toHaveBeenCalledWith("Jump to fastest lap: jump did not settle; aborting walk");
            expect(replay.speedCommands()).toEqual(["pause"]);
            expect(replay.speed()).toEqual(PAUSED);
            expect(cachedSpeed()).toEqual(PAUSED);
            expect(_activeLapPress()).toBeNull();
          },
        );

        it("a replay command during the walk ends it with no speed command, whatever was captured", async () => {
          setJumpPlayback("remember");
          singleSessionBuffer(4, 4);
          const replay = liveReplay(NORMAL);

          await press();
          await vi.advanceTimersByTimeAsync(1200);

          const commandsBefore = countReplayCommands();

          expect(cancelReplayCursorOwner("next")).toBe("jump-to-fastest-lap walk");
          await runPressOut();

          expect(countReplayCommands()).toBe(commandsBefore);
          expect(replay.speedCommands()).toEqual(["pause"]);
          expect(mockStore.laps.recordLapStart).not.toHaveBeenCalled();
          expect(_activeLapPress()).toBeNull();
        });

        it("a speed command the SDK refuses at the end warns; the lap start is recorded and the cache says paused", async () => {
          setJumpPlayback("play");
          singleSessionBuffer(4, 4);
          liveReplay(PAUSED);
          mockReplay.setPlaySpeed.mockImplementation(() => false);

          await press();
          await vi.runAllTimersAsync();

          expect(mockReplay.setPlaySpeed).toHaveBeenCalledExactlyOnceWith(1, false);
          expect(logger.warn).toHaveBeenCalledWith(
            "Jump to fastest lap: speed command failed; replay left paused on the frame",
          );
          expect(mockStore.laps.recordLapStart).toHaveBeenCalledTimes(1);
          expect(cachedSpeed()).toEqual(PAUSED);
        });
      });
    });

    describe("walk phases (end-to-end on a single-session buffer)", () => {
      it("lands at lap === targetLap - 1 with dist ≥ 0.999 (= end of lap before fastest)", async () => {
        vi.useFakeTimers();

        try {
          // Fastest lap = 4 → target = lap 3. In the single-session buffer
          // (1000 frames per lap), end of lap 3 = frame 3 * 1000 + 999 = 3999.
          const buffer = singleSessionBuffer(4, 4);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          // After bisection + lap-step + nudge + 2-tick back-step, the cursor
          // should be at end-of-lap-3 minus 2 ticks (~3997).
          expect(buffer.cursor.frame).toBeGreaterThanOrEqual(3990);
          expect(buffer.cursor.frame).toBeLessThanOrEqual(3999);
        } finally {
          vi.useRealTimers();
        }
      });

      it("calls nextSession to skip past sessions before the target session", async () => {
        vi.useFakeTimers();

        try {
          multiSessionBuffer(
            4,
            [
              { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 999, framesPerLap: 100, fastestLap: -1 },
              {
                sessionNum: 1,
                sessionUniqueId: 2,
                startFrame: 1000,
                endFrame: 4999,
                framesPerLap: 1000,
                fastestLap: 2,
              },
              {
                sessionNum: 2,
                sessionUniqueId: 3,
                startFrame: 5000,
                endFrame: 14_999,
                framesPerLap: 1000,
                fastestLap: 4,
              },
            ],
            { initialCursor: 8000 },
          );

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          expect(mockReplay.nextSession.mock.calls.length).toBeGreaterThanOrEqual(2);
        } finally {
          vi.useRealTimers();
        }
      });

      it("bisects within the target session bounds, not the whole buffer", async () => {
        vi.useFakeTimers();

        try {
          // Two sessions: session 0 has 100 fast laps (frame 0-9999) we should
          // NEVER probe in bisection; session 2 holds the target. Watch every
          // setPlayPosition frame stays in session 2.
          multiSessionBuffer(
            4,
            [
              {
                sessionNum: 0,
                sessionUniqueId: 1,
                startFrame: 0,
                endFrame: 9999,
                framesPerLap: 100,
                fastestLap: -1,
              },
              {
                sessionNum: 2,
                sessionUniqueId: 3,
                startFrame: 10_000,
                endFrame: 19_999,
                framesPerLap: 1000,
                fastestLap: 4,
              },
            ],
            { initialCursor: 12_000 },
          );

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          // Bisection-driven setPlayPosition calls (skip the trailing back-step).
          const bisectionFrames = mockReplay.setPlayPosition.mock.calls.slice(0, -1).map((call) => call[1]);

          // Guard against a vacuously-passing loop if the walker never
          // actually bisected — without this the test would silently miss
          // a regression where phase 3 was skipped entirely.
          expect(bisectionFrames.length).toBeGreaterThan(0);

          for (const frame of bisectionFrames) {
            expect(frame).toBeGreaterThanOrEqual(10_000);
            expect(frame).toBeLessThanOrEqual(19_999);
          }
        } finally {
          vi.useRealTimers();
        }
      });

      it("calls nextLap / prevLap during the lap-step phase", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4, { initialCursor: 5000 });

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          // Either nextLap or prevLap fires at least once during the lap-step
          // and nudge phases — whichever direction reaches lap=3.
          const totalLapStepCalls = mockReplay.nextLap.mock.calls.length + mockReplay.prevLap.mock.calls.length;

          expect(totalLapStepCalls).toBeGreaterThan(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it("does a single setPlayPosition(Begin, frame - 2) for the back-step", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          // The LAST setPlayPosition is the 2-tick back-step. Frame just
          // before it (= the pre-back-step cursor position) should be 2
          // frames higher than the LAST setPlayPosition's target.
          const calls = mockReplay.setPlayPosition.mock.calls;
          const lastTargetFrame = calls[calls.length - 1][1];
          const secondLastTargetFrame = calls[calls.length - 2]?.[1];

          // The very last call IS the back-step. It targets a frame 2 less
          // than the frame the cursor sat on right before it.
          expect(typeof secondLastTargetFrame).toBe("number");
          // Cursor frame just before back-step is at end-of-lap-3 ≈ 3999.
          // Back-step target is 3999 - 2 = 3997.
          expect(lastTargetFrame).toBeLessThanOrEqual(3997);
          expect(lastTargetFrame).toBeGreaterThanOrEqual(3995);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe("guards", () => {
      it("a walk started while a press holds the slot is ignored: logged, nothing sent, and said so", async () => {
        vi.useFakeTimers();
        onTestFinished(() => void vi.useRealTimers());
        singleSessionBuffer(4, 4);

        // A record jump that never lands holds the slot for ctx-1.
        mockReplay.setPlayPosition.mockImplementation(() => true);
        mockStore.laps.findLapStart.mockImplementation(() => ({
          hit: true,
          frame: 5000,
          timeMs: null,
          matchedBy: "pair",
        }));
        expect(await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" })).toEqual({ kind: "started" });
        await vi.advanceTimersByTimeAsync(100);

        const commandsBefore = countReplayCommands();

        expect(await walkToFastestLap("ctx-2", 4, 4, 2, { carNumberRaw: 4, userId: 0, subSessionId: undefined })).toBe(
          "ignored",
        );
        expect(logger.info).toHaveBeenCalledWith("Jump to fastest lap: walk already in flight; press ignored");
        expect(logger.debug).toHaveBeenCalledWith("In-flight walk context: ctx-1, ignored press context: ctx-2");
        expect(countReplayCommands()).toBe(commandsBefore);
        expect(_activeLapPress()?.origin).toBe("ctx-1");
      });

      it("a press while one is in flight comes back ignored, for the key to report; a refused one comes back refused", async () => {
        vi.useFakeTimers();
        onTestFinished(() => void vi.useRealTimers());
        singleSessionBuffer(4, 4);

        expect(await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" })).toEqual({ kind: "started" });
        expect(await pressJumpToFastestLap({ origin: "ctx-2", target: "viewed-car" })).toEqual({ kind: "ignored" });

        await runPressOut();

        controller.getCurrentTelemetry = vi.fn(() => ({ CamCarIdx: -1 }) as TelemetryData);

        expect(await pressJumpToFastestLap({ origin: "ctx-2", target: "viewed-car" })).toEqual({
          kind: "refused",
          reason: "no target car",
        });
      });

      it("ignores a second press while a walk is already in flight on the same context", async () => {
        vi.useFakeTimers();

        try {
          singleSessionBuffer(4, 4);

          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          // Second press while the first is still in-flight (timers not drained).
          await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });
          await vi.runAllTimersAsync();

          // pause was called only once (by the first walk; the second was a no-op).
          expect(mockReplay.pause).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it("uses DriverCarIdx (not CamCarIdx) when target is always-my-car", async () => {
        vi.useFakeTimers();

        try {
          multiSessionBuffer(
            3,
            [
              {
                sessionNum: 2,
                sessionUniqueId: 3,
                startFrame: 0,
                endFrame: 9999,
                framesPerLap: 1000,
                fastestLap: 4,
              },
            ],
            { driverCarIdx: 3 },
          );
          // CamCarIdx is 3 by default in multiSessionBuffer — override telemetry
          // so the camera is on a DIFFERENT car (99).
          const originalGetTelemetry = controller.getCurrentTelemetry;

          controller.getCurrentTelemetry = vi.fn(() => {
            const tel = (originalGetTelemetry as any)() as any;

            return { ...tel, CamCarIdx: 99 };
          });

          await pressJumpToFastestLap({ origin: "ctx-1", target: "always-my-car" });
          await vi.runAllTimersAsync();

          // Camera switched to the driver's car (idx 3), NOT the viewed car (99).
          expect(mockCamera.switchNum).toHaveBeenCalledWith(3, 0, 0);
          // The lookup and the record both address driverCarIdx=3.
          expect(mockStore.laps.findLapStart).toHaveBeenCalledWith(expect.objectContaining({ carIdx: 3, lap: 4 }));
          expect(mockStore.laps.recordLapStart).toHaveBeenCalledWith(expect.objectContaining({ carIdx: 3, lap: 4 }));
        } finally {
          vi.useRealTimers();
        }
      });

      it("warns when the target car has no resolvable car number", async () => {
        vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValueOnce(null);
        controller.getCurrentTelemetry = vi.fn(() => telemetryWithBest(2, 5, 3) as any);

        await pressJumpToFastestLap({ origin: "ctx-1", target: "viewed-car" });

        expect(mockCamera.switchNum).not.toHaveBeenCalled();
        expect(mockReplay.pause).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("car number"));
      });
    });
  });
});
