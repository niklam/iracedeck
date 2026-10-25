/**
 * Test support (#1467): the synthetic replay the Jump to Fastest Lap tests
 * walk through, moved out of Replay Control's suite with the walk so the
 * engine's tests and the action's own share one. Never imported by
 * production code.
 *
 * Synthetic multi-session replay buffer. Each `SessionLayout` occupies
 * `[startFrame, endFrame]` (inclusive); within a session, lap N spans
 * frames `[startFrame + N * framesPerLap, startFrame + (N+1) * framesPerLap)`
 * with `dist = (frame % framesPerLap) / framesPerLap`. The mock wires:
 *
 *   - `goToStart` → cursor to first session's startFrame.
 *   - `goToEnd` → cursor to bufferEnd (last session's endFrame). The
 *     walk must never call it (#1203); the mock keeps it so a
 *     regression shows as a call, not a TypeError.
 *   - `nextSession` → cursor to next session's startFrame, or no-op
 *     when already in the last session.
 *   - `setPlayPosition(Begin, frame)` → cursor clamped to buffer.
 *   - `nextLap` → cursor to start of next lap (lap+1, dist=0).
 *   - `prevLap` → cursor to end of previous lap (lap-1, dist≈0.999).
 *
 * `opts.lead` (#1432) is how many frames short of the line iRacing's lap
 * search rests: `nextLap` lands `lead` frames before the next line the
 * car has not reached within `lead` frames, still reading the lap before
 * it, and `prevLap` `lead` frames before the line of the lap the car
 * reads (one, at least). `lead: 0`, the default, is the model above: a
 * Next Lap that lands on the line.
 *
 * `getCurrentTelemetry()` returns SessionUniqueID + SessionNum + the
 * lap/dist for `carIdx`, plus `ReplayFrameNumEnd = bufferEnd - frame`
 * so `ReplayFrameNum + ReplayFrameNumEnd` is the constant recording
 * length the map build reads, and `ReplayPlaySpeed: 0`: a paused replay.
 * `getSessionInfo()` wires `ResultsPositions` so `findFastestLapForCar`
 * resolves to each session's `fastestLap`; `opts.fastestTime` (seconds)
 * fills `FastestTime` beside it for the #1203 convention check.
 */
import type { ReplayPosMode, TelemetryData } from "@iracedeck/iracing-sdk";
import { type Mock, vi } from "vitest";

export type SessionLayout = {
  sessionNum: number;
  sessionUniqueId: number;
  startFrame: number;
  endFrame: number;
  framesPerLap: number;
  fastestLap: number;
};

/** The controller reads a buffer replaces: the engine's controller in its own tests, the action's in Replay Control's. */
export interface LapBufferTarget {
  getCurrentTelemetry: () => TelemetryData | null;
  getSessionInfo: () => unknown;
}

/** The replay commands a buffer moves its cursor through. */
export interface LapBufferReplay {
  goToStart: Mock<() => boolean>;
  goToEnd: Mock<() => boolean>;
  nextSession: Mock<() => boolean>;
  setPlayPosition: Mock<(mode: ReplayPosMode, frameNumber: number) => boolean>;
  nextLap: Mock<() => boolean>;
  prevLap: Mock<() => boolean>;
}

/** What a buffer hands back: its cursor, its sessions (a test may extend the last), and its reads. */
export interface LapBuffer {
  cursor: { frame: number };
  sessions: SessionLayout[];
  bufferEnd: () => number;
  findSession: (frame: number) => SessionLayout | null;
}

export function multiSessionBuffer(
  target: LapBufferTarget,
  replay: LapBufferReplay,
  carIdx: number,
  sessions: SessionLayout[],
  opts: {
    driverCarIdx?: number;
    initialCursor?: number;
    fastestTime?: number;
    subSessionId?: number;
    userId?: number;
    lead?: number;
  } = {},
): LapBuffer {
  const cursor = { frame: opts.initialCursor ?? sessions[0].startFrame };
  const lead = opts.lead ?? 0;
  // Read at every use: a test may extend the last session after the map is built (a live recording growing).
  const bufferEnd = (): number => sessions[sessions.length - 1].endFrame;

  const findSession = (frame: number): SessionLayout | null =>
    sessions.find((s) => frame >= s.startFrame && frame <= s.endFrame) ?? null;

  replay.goToStart.mockImplementation(() => {
    cursor.frame = sessions[0].startFrame;

    return true;
  });
  replay.goToEnd.mockImplementation(() => {
    cursor.frame = bufferEnd();

    return true;
  });
  replay.nextSession.mockImplementation(() => {
    const current = findSession(cursor.frame);

    if (!current) return false;

    const idx = sessions.indexOf(current);

    if (idx + 1 < sessions.length) {
      cursor.frame = sessions[idx + 1].startFrame;
    }

    return true;
  });
  replay.setPlayPosition.mockImplementation((_mode: unknown, frame: number) => {
    cursor.frame = Math.max(0, Math.min(bufferEnd(), frame));

    return true;
  });
  replay.nextLap.mockImplementation(() => {
    const session = findSession(cursor.frame);

    if (!session) return false;

    const relFrame = cursor.frame - session.startFrame;
    // The lap whose end is the next line more than `lead` frames ahead.
    const lap = Math.floor((relFrame + lead) / session.framesPerLap);

    cursor.frame = Math.min(bufferEnd(), session.startFrame + (lap + 1) * session.framesPerLap - lead);

    return true;
  });
  replay.prevLap.mockImplementation(() => {
    const session = findSession(cursor.frame);

    if (!session) return false;

    const relFrame = cursor.frame - session.startFrame;
    const lap = Math.floor(relFrame / session.framesPerLap);
    // Last frame of the PREVIOUS lap (lap-1, dist ≈ 0.999), or `lead` frames short of its end.
    const prevLapEnd = session.startFrame + lap * session.framesPerLap - Math.max(1, lead);

    cursor.frame = Math.max(session.startFrame, prevLapEnd);

    return true;
  });

  target.getCurrentTelemetry = vi.fn(() => {
    const session = findSession(cursor.frame);

    if (!session) {
      return {
        CamCarIdx: carIdx,
        IsReplayPlaying: true,
        ReplayPlaySpeed: 0,
        ReplayFrameNum: cursor.frame,
        ReplayFrameNumEnd: bufferEnd() - cursor.frame,
        SessionNum: -1,
        SessionUniqueID: 0,
        CarIdxLap: [],
        CarIdxLapDistPct: [],
        CarIdxBestLapNum: [],
      } as unknown as TelemetryData;
    }

    const relFrame = cursor.frame - session.startFrame;
    const lap = Math.floor(relFrame / session.framesPerLap);
    const dist = (relFrame % session.framesPerLap) / session.framesPerLap;
    const lapArr: number[] = [];
    const distArr: number[] = [];

    lapArr[carIdx] = lap;
    distArr[carIdx] = dist;

    return {
      CamCarIdx: carIdx,
      IsReplayPlaying: true,
      ReplayPlaySpeed: 0,
      ReplayFrameNum: cursor.frame,
      ReplayFrameNumEnd: bufferEnd() - cursor.frame,
      SessionNum: session.sessionNum,
      SessionUniqueID: session.sessionUniqueId,
      CarIdxLap: lapArr,
      CarIdxLapDistPct: distArr,
      CarIdxBestLapNum: [],
    } as unknown as TelemetryData;
  });

  target.getSessionInfo = vi.fn(() => ({
    ...(opts.subSessionId === undefined ? {} : { WeekendInfo: { SubSessionID: opts.subSessionId } }),
    DriverInfo: {
      DriverCarIdx: opts.driverCarIdx ?? carIdx,
      Drivers: [{ CarIdx: carIdx, UserID: opts.userId ?? 0 }],
    },
    SessionInfo: {
      Sessions: sessions.map((s) => ({
        SessionNum: s.sessionNum,
        ResultsPositions: [
          opts.fastestTime === undefined
            ? { CarIdx: carIdx, FastestLap: s.fastestLap }
            : { CarIdx: carIdx, FastestLap: s.fastestLap, FastestTime: opts.fastestTime },
        ],
      })),
    },
  }));

  return { cursor, sessions, bufferEnd, findSession };
}

/**
 * Single-session buffer with a default layout: SessionNum=2,
 * SessionUniqueID=3, frame range [0, 9999], 1000 frames per lap.
 * `initialCursor` starts at a frame inside that session so the
 * dispatch's first telemetry read sees `SessionNum=2`.
 */
export function singleSessionBuffer(
  target: LapBufferTarget,
  replay: LapBufferReplay,
  carIdx: number,
  fastestLap: number,
  opts: { initialCursor?: number; fastestTime?: number; subSessionId?: number; userId?: number; lead?: number } = {},
): LapBuffer {
  return multiSessionBuffer(
    target,
    replay,
    carIdx,
    [
      {
        sessionNum: 2,
        sessionUniqueId: 3,
        startFrame: 0,
        endFrame: 9999,
        framesPerLap: 1000,
        fastestLap,
      },
    ],
    { ...opts, initialCursor: opts.initialCursor ?? 5000 },
  );
}
