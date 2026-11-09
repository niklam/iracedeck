/**
 * The translator's per-track, per-session caches through the real tick (issue
 * #1573): the one `trackSessionKey` all four are keyed by, and the track's
 * sectors as `getTrackSectors()` serves them — in every session type,
 * re-resolved on a new `(TrackID, SessionNum)`, `null` for sectors that fail
 * validation, and kept through a replay.
 */
import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import {
  CarLeftRight,
  REPLAY_EXIT_GRACE_MS,
  ReplayStateTracker,
  type SDKController,
  SessionState,
  type TelemetryCallback,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetSimEventsIracing,
  getTrackSectors,
  initializeSimEventsIracing,
  readSimState,
  trackSessionKey,
} from "./translator.js";

function createMockLogger(): ILogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: vi.fn(),
    createScope: vi.fn(),
  } as unknown as ILogger;
}

type MockController = SDKController & {
  __tick: (telemetry: TelemetryData) => void;
  __setSessionInfo: (info: Record<string, unknown> | null) => void;
};

function createMockController(): MockController {
  // Several subscribers, notified in subscription order as `SDKController`
  // does: the translator, then the replay recorder it starts (#1468).
  const subscribers = new Map<string, TelemetryCallback>();
  let sessionInfo: Record<string, unknown> | null = null;
  // The translator's replay guard reads the controller's debounced replay
  // state (#1324), stepped before each tick as the real controller does.
  const replayState = new ReplayStateTracker();

  const controller = {
    subscribe: (id: string, cb: TelemetryCallback) => {
      subscribers.set(id, cb);
      cb(null, false);
    },
    unsubscribe: (id: string) => {
      subscribers.delete(id);
    },
    getSessionInfo: () => sessionInfo,
    getReplayState: (nowMs: number = Date.now()) => replayState.read(nowMs),
    noteReplayLeftForLive: (nowMs: number = Date.now()) => replayState.noteLeftForLive(nowMs),
  } as unknown as MockController;

  controller.__tick = (telemetry) => {
    replayState.step(telemetry, sessionInfo, Date.now());

    for (const cb of [...subscribers.values()]) cb(telemetry, true);
  };
  controller.__setSessionInfo = (info) => {
    sessionInfo = info;
  };

  return controller;
}

/** Monza-like: five sectors, the first at the line. */
const FIVE_SECTORS = [
  { SectorNum: 0, SectorStartPct: 0 },
  { SectorNum: 1, SectorStartPct: 0.2 },
  { SectorNum: 2, SectorStartPct: 0.4 },
  { SectorNum: 3, SectorStartPct: 0.6 },
  { SectorNum: 4, SectorStartPct: 0.8 },
];

/** The mock session's three sectors. */
const THREE_SECTORS = [
  { SectorNum: 0, SectorStartPct: 0 },
  { SectorNum: 1, SectorStartPct: 0.333333 },
  { SectorNum: 2, SectorStartPct: 0.666667 },
];

type SessionInfoOptions = {
  trackId?: number;
  sessionType?: string;
  /** `undefined` leaves `SplitTimeInfo` out of the session info. */
  sectors?: unknown;
};

/** Session info naming one session per `SessionNum` 0–2, all of `sessionType`. */
function sessionInfo({ trackId = 42, sessionType = "Practice", sectors }: SessionInfoOptions = {}): Record<
  string,
  unknown
> {
  return {
    WeekendInfo: { TrackID: trackId, TrackLength: "4.00 km", TrackPitSpeedLimit: "80.00 kph", SimMode: "full" },
    SessionInfo: {
      Sessions: [0, 1, 2].map((n) => ({ SessionNum: n, SessionType: sessionType })),
    },
    DriverInfo: { DriverCarIdx: 0, Drivers: [] },
    ...(sectors === undefined ? {} : { SplitTimeInfo: { Sectors: sectors } }),
  };
}

/** A live, on-track tick of the player (car 0) in session `sessionNum`. */
function tick(sessionNum = 0, overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    SessionTime: 100,
    OnPitRoad: false,
    PlayerCarInPitStall: false,
    IsOnTrack: true,
    IsReplayPlaying: false,
    PlayerTrackSurface: TrkLoc.OnTrack,
    PlayerTrackSurfaceMaterial: 0,
    PlayerCarMyIncidentCount: 0,
    PlayerIncidents: 0,
    SessionFlags: 0,
    SessionNum: sessionNum,
    SessionState: SessionState.Racing,
    SessionLapsRemainEx: 20,
    SessionTimeRemain: 1800,
    PitSvFlags: 0,
    PitSvTireCompound: 0,
    PlayerTireCompound: 0,
    EngineWarnings: 0,
    Speed: 44,
    CarLeftRight: CarLeftRight.Off,
    DRS_Status: 0,
    P2P_Status: false,
    RPM: 0,
    Lap: 3,
    LapCompleted: 2,
    LapDistPct: 0.3,
    FuelLevel: 10,
    CarIdxLapCompleted: [2],
    CarIdxLapDistPct: [0.3],
    CarIdxTrackSurface: [TrkLoc.OnTrack],
    CarIdxClass: [0],
    CarIdxLastLapTime: [90],
    ...overrides,
  } as TelemetryData;
}

let controller: MockController;

function start(info: Record<string, unknown>): void {
  controller = createMockController();
  controller.__setSessionInfo(info);
  initializeSimEventsIracing(getEventBus(), controller, createMockLogger(), { onStepError: "rethrow" });
}

beforeEach(() => {
  _resetEventBus();
  initializeEventBus();
});

afterEach(() => {
  _resetSimEventsIracing();
  vi.useRealTimers();
});

describe("trackSessionKey", () => {
  it("is `${TrackID}|${SessionNum}`", () => {
    expect(trackSessionKey({ WeekendInfo: { TrackID: 42 } }, tick(2))).toBe("42|2");
  });

  it("writes an absent TrackID or SessionNum as an empty part", () => {
    expect(trackSessionKey({}, tick(1))).toBe("|1");
    expect(trackSessionKey({ WeekendInfo: { TrackID: 42 } }, tick(0, { SessionNum: undefined }))).toBe("42|");
  });

  it("keys the track length, corner markers, pit speed limit and sector caches the same way", () => {
    const info = sessionInfo({ sectors: FIVE_SECTORS });

    start(info);
    controller.__tick(tick(2));

    const snapshot = readSimState();

    if (!snapshot.initialized) throw new Error("translator not initialised");

    const key = trackSessionKey(info, tick(2));

    expect(key).toBe("42|2");
    expect(snapshot.raw.state.trackLengthKey).toBe(key);
    expect(snapshot.raw.state.cornerMarkersKey).toBe(key);
    expect(snapshot.raw.instance.pitSpeedLimitKey).toBe(key);
    expect(snapshot.raw.state.trackSectors.key).toBe(key);
  });
});

describe("getTrackSectors", () => {
  it("is null before the translator is initialised, and before its first live tick", () => {
    expect(getTrackSectors()).toBeNull();

    start(sessionInfo({ sectors: FIVE_SECTORS }));

    expect(getTrackSectors()).toBeNull();
  });

  it.each(["Practice", "Open Qualify", "Lone Qualify", "Race", "Offline Testing"])(
    "answers in a %s session",
    (sessionType) => {
      start(sessionInfo({ sessionType, sectors: FIVE_SECTORS }));
      controller.__tick(tick());

      expect(getTrackSectors()).toEqual({ starts: [0, 0.2, 0.4, 0.6, 0.8] });
    },
  );

  it("keeps the cached sectors while the key holds, and re-resolves on a new TrackID", () => {
    start(sessionInfo({ trackId: 42, sectors: FIVE_SECTORS }));
    controller.__tick(tick());

    expect(getTrackSectors()).toEqual({ starts: [0, 0.2, 0.4, 0.6, 0.8] });

    // Same (TrackID, SessionNum), other sectors in the session info: the cache
    // holds, which is what makes the next step a test of the key.
    controller.__setSessionInfo(sessionInfo({ trackId: 42, sectors: THREE_SECTORS }));
    controller.__tick(tick());

    expect(getTrackSectors()).toEqual({ starts: [0, 0.2, 0.4, 0.6, 0.8] });

    controller.__setSessionInfo(sessionInfo({ trackId: 7, sectors: THREE_SECTORS }));
    controller.__tick(tick());

    expect(getTrackSectors()).toEqual({ starts: [0, 0.333333, 0.666667] });
  });

  // A SessionNum change resets the whole translator state (`resetPerSessionState`),
  // so this is the session reset clearing the cache, not the key at work; the
  // TrackID test above is the key's own test.
  it("is cleared by the session reset and re-resolved on a new SessionNum", () => {
    start(sessionInfo({ sectors: FIVE_SECTORS }));
    controller.__tick(tick(0));

    expect(getTrackSectors()).toEqual({ starts: [0, 0.2, 0.4, 0.6, 0.8] });

    controller.__setSessionInfo(sessionInfo({ sectors: THREE_SECTORS }));
    controller.__tick(tick(1));

    expect(getTrackSectors()).toEqual({ starts: [0, 0.333333, 0.666667] });
  });

  it("retries while null, so sectors that arrive after the first read are picked up", () => {
    start(sessionInfo());
    controller.__tick(tick());

    expect(getTrackSectors()).toBeNull();

    controller.__setSessionInfo(sessionInfo({ sectors: THREE_SECTORS }));
    controller.__tick(tick());

    expect(getTrackSectors()).toEqual({ starts: [0, 0.333333, 0.666667] });
  });

  it.each([
    [
      "a first sector off the line",
      [
        { SectorNum: 0, SectorStartPct: 0.1 },
        { SectorNum: 1, SectorStartPct: 0.5 },
      ],
    ],
    [
      "a repeated start",
      [
        { SectorNum: 0, SectorStartPct: 0 },
        { SectorNum: 1, SectorStartPct: 0 },
      ],
    ],
    [
      "a start at 1",
      [
        { SectorNum: 0, SectorStartPct: 0 },
        { SectorNum: 1, SectorStartPct: 1 },
      ],
    ],
    ["an empty list", []],
  ])("is null for session info whose sectors fail validation: %s", (_label, sectors) => {
    start(sessionInfo({ sectors }));
    controller.__tick(tick());

    expect(getTrackSectors()).toBeNull();

    // Positive control: the same session with valid sectors answers.
    controller.__setSessionInfo(sessionInfo({ sectors: THREE_SECTORS }));
    controller.__tick(tick());

    expect(getTrackSectors()).toEqual({ starts: [0, 0.333333, 0.666667] });
  });

  it("holds through a replay glance and its exit grace, kept as the same object", () => {
    vi.useFakeTimers();
    start(sessionInfo({ sectors: FIVE_SECTORS }));
    controller.__tick(tick());

    expect(getTrackSectors()).toEqual({ starts: [0, 0.2, 0.4, 0.6, 0.8] });

    const before = readSimState();

    if (!before.initialized) throw new Error("translator not initialised");

    const slice = before.raw.state.trackSectors;

    controller.__tick(tick(0, { IsReplayPlaying: true, IsOnTrack: false }));

    expect(getTrackSectors()).toEqual({ starts: [0, 0.2, 0.4, 0.6, 0.8] });

    // Back to live, inside the replay state's exit grace (#1324): still held.
    controller.__tick(tick());

    expect(getTrackSectors()).toEqual({ starts: [0, 0.2, 0.4, 0.6, 0.8] });

    vi.advanceTimersByTime(REPLAY_EXIT_GRACE_MS + 1);
    controller.__tick(tick());

    expect(getTrackSectors()).toEqual({ starts: [0, 0.2, 0.4, 0.6, 0.8] });

    const after = readSimState();

    if (!after.initialized) throw new Error("translator not initialised");

    // Kept whole by reference across the wipe, not re-resolved into a new one.
    expect(after.raw.state.trackSectors).toBe(slice);
  });
});
