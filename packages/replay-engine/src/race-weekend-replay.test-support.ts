/**
 * Test support (#1467): the race weekend the Jump to Race Start tests run
 * against, moved out of Replay Control's suite with the press so the engine's
 * tests and the action's own share one. Never imported by production code.
 */
import type { ReplayPosMode, TelemetryData } from "@iracedeck/iracing-sdk";
import { type Mock, vi } from "vitest";

/** The car the tests watch at the press, and the one that started from pole. */
export const VIEWED_CAR = 4;
export const POLE_CAR = 7;

/** One session instance on the tape. */
export type RaceWeekendSession = {
  sessionNum: number;
  sessionUniqueId: number;
  startFrame: number;
  endFrame: number;
};

/** Every lap is this long, so a frame short of the line is a known fraction of a lap. */
export const FRAMES_PER_LAP = 5000;

/** Where a car on its grid slot reads: a few metres behind the line, inside what the search takes for the end of a lap. */
const GRID_SLOT_DIST = 0.9995;

/** The controller reads a race weekend replaces: the engine's controller in its own tests, the action's in Replay Control's. */
export interface RaceWeekendController {
  getCurrentTelemetry: () => TelemetryData | null;
  getSessionInfo: () => unknown;
}

/** The replay and camera commands a race weekend moves its cursor and its camera through. */
export interface RaceWeekendCommands {
  readonly replay: {
    goToStart: Mock<() => boolean>;
    nextSession: Mock<() => boolean>;
    setPlayPosition: Mock<(mode: ReplayPosMode, frameNumber: number) => boolean>;
    nextLap: Mock<() => boolean>;
    prevLap: Mock<() => boolean>;
  };
  readonly camera: { switchNum: Mock<(carNum: number, group: number, camera: number) => boolean> };
}

/** The shape of a race weekend: its sessions, its tape, and how the sim behaves on it. */
export interface RaceWeekendOptions {
  /** `SessionInfo.Sessions`, in `SessionNum` order. */
  sessionTypes: string[];
  /** The session instances on the tape, in frame order. */
  layout: RaceWeekendSession[];
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
}

/** What a race weekend hands back: the sim's state, which a test may change, and the session info it serves. */
export interface RaceWeekend {
  readonly state: {
    frame: number;
    camCarIdx: number;
    /** False once the test takes the sim out of the replay. */
    inReplay: boolean;
    /** True while a jump the sim has not finished is under way. */
    seeking: boolean;
    /** When the telemetry starts to show the seek under way. */
    seekShowsAt: number;
  };
  readonly sessionInfo: unknown;
}

/**
 * A synthetic replay the commands move a cursor through. A session
 * instance occupies `[startFrame, endFrame]`; within it lap N spans
 * `[startFrame + N * FRAMES_PER_LAP, startFrame + (N + 1) * FRAMES_PER_LAP)`,
 * for every car alike. `nextLap` / `prevLap` land `lapSearchShort` frames
 * before the next / previous line, which is how iRacing's lap search behaves:
 * one frame short by default; the walk finds the line from wherever they rest
 * (#1432).
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
export function raceWeekendReplay(
  controller: RaceWeekendController,
  commands: RaceWeekendCommands,
  options: RaceWeekendOptions,
): RaceWeekend {
  const { replay, camera } = commands;
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
  const firstLine = (session: RaceWeekendSession, carIdx: number): number =>
    session.startFrame + (gridWait > 0 ? gridWait : FRAMES_PER_LAP) + (options.lineOffsets?.[carIdx] ?? 0);
  const findSession = (frame: number): RaceWeekendSession | null =>
    layout.find((s) => frame >= s.startFrame && frame <= s.endFrame) ?? null;

  /** The frames a lap search can land on in `session`: `short` before each line the car on screen crosses. */
  const landings = (session: RaceWeekendSession): number[] => {
    const frames: number[] = [];

    for (let line = firstLine(session, state.camCarIdx); line <= session.endFrame; line += FRAMES_PER_LAP) {
      frames.push(line - short);
    }

    return frames;
  };

  replay.goToStart.mockImplementation(() => {
    state.frame = layout[0].startFrame;

    return true;
  });
  /** Bumped by every command that moves the cursor, so a search a later command replaced lands nowhere. */
  let searchSerial = 0;

  replay.nextSession.mockImplementation(() => {
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

  replay.setPlayPosition.mockImplementation((_mode, frame) => {
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
  replay.nextLap.mockImplementation(() => {
    const session = findSession(state.frame);
    const target = session ? landings(session).find((frame) => frame > state.frame) : undefined;

    if (target !== undefined) state.frame = target;

    return true;
  });
  replay.prevLap.mockImplementation(() => {
    const session = findSession(state.frame);
    const target = session
      ? landings(session)
          .reverse()
          .find((frame) => frame < state.frame)
      : undefined;

    if (target !== undefined) state.frame = target;

    return true;
  });
  camera.switchNum.mockImplementation((carNum) => {
    state.camCarIdx = carNum;

    return true;
  });

  controller.getCurrentTelemetry = vi.fn((): TelemetryData | null => {
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

  controller.getSessionInfo = vi.fn(() => sessionInfo);

  return { state, sessionInfo };
}

/** Practice, qualifying and one race, 50 000 frames each of the last two; the race is `SessionNum` 2 / unique id 3. */
export const WEEKEND: RaceWeekendSession[] = [
  { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 9_999 },
  { sessionNum: 1, sessionUniqueId: 2, startFrame: 10_000, endFrame: 19_999 },
  { sessionNum: 2, sessionUniqueId: 3, startFrame: 20_000, endFrame: 69_999 },
];
export const WEEKEND_TYPES = ["Practice", "Lone Qualify", "Race"];
export const RACE_START = 20_000;
/** The first frame of the race's lap 1, for every car: the pole car's lap-1 start a search finds (#1432). */
export const RACE_LAP_1_LINE = RACE_START + FRAMES_PER_LAP;

/** A cursor well into the race, a few laps after the start. */
export const IN_RACE = RACE_START + 3 * FRAMES_PER_LAP + 1_234;
