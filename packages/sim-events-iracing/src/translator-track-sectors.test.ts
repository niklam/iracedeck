/**
 * The translator's per-track, per-session caches through the real tick (issue
 * #1573): the one `trackSessionKey` all four are keyed by, and the track's
 * sectors as the `trackSectors` slice caches them — in every session type,
 * re-resolved on a new `(TrackID, SessionNum)`, `null` for sectors that fail
 * validation, and wiped at a replay like the other track caches; and the
 * order a sector start and a corner name swept on one tick reach the bus in:
 * the order their markers were crossed, a tie to the sector call (#1676).
 */
import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import {
  CarLeftRight,
  extractSectorStarts,
  REPLAY_EXIT_GRACE_MS,
  ReplayStateTracker,
  type SDKController,
  SessionState,
  type TelemetryCallback,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { type CornerMarker } from "@iracedeck/track-data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetSimEventsIracing, initializeSimEventsIracing, readSimState, trackSessionKey } from "./translator.js";

// The real sector parser behind a spy, so a test can count how often the
// translator's cache runs it.
vi.mock("@iracedeck/iracing-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/iracing-sdk")>();

  return { ...actual, extractSectorStarts: vi.fn(actual.extractSectorStarts) };
});

/** A track name no bundled snapshot carries, given {@link TEST_RING_MARKERS} below. */
const TEST_RING = "Test Ring";

/**
 * Corners placed against the five-sector layout: one exactly at sector 2's
 * start (0.2), a corner at the sector line; one 0.01 lap before sector 3's
 * start (0.4); one 0.01 lap after sector 4's (0.6).
 */
const TEST_RING_MARKERS: CornerMarker[] = [
  { startPct: 0.2, name: "Line Corner", slug: "line-corner" },
  { startPct: 0.39, name: "Early Corner", slug: "early-corner" },
  { startPct: 0.61, name: "Late Corner", slug: "late-corner" },
];

// The bundled corner data, with one synthetic track whose marker sits where the
// tests need it; every other name resolves as it really does.
vi.mock("@iracedeck/track-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/track-data")>();

  return {
    ...actual,
    resolveCornerMarkers: (trackName: string) =>
      trackName === TEST_RING ? TEST_RING_MARKERS : actual.resolveCornerMarkers(trackName),
  };
});

/**
 * The translator's cached sector starts, as its `trackSectors` slice holds
 * them — the value `handleTick` hands the sector diffs. `null` before the
 * translator is initialised.
 */
function cachedSectors(): readonly number[] | null {
  const state = readSimState();

  return state.initialized ? state.raw.state.trackSectors.starts : null;
}

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
    expect(snapshot.raw.state.cornerName.markersKey).toBe(key);
    expect(snapshot.raw.instance.pitSpeedLimitKey).toBe(key);
    expect(snapshot.raw.state.trackSectors.key).toBe(key);
  });
});

describe("the cached track sectors", () => {
  it("is null before the translator is initialised, and before its first live tick", () => {
    expect(cachedSectors()).toBeNull();

    start(sessionInfo({ sectors: FIVE_SECTORS }));

    expect(cachedSectors()).toBeNull();
  });

  it.each(["Practice", "Open Qualify", "Lone Qualify", "Race", "Offline Testing"])(
    "answers in a %s session",
    (sessionType) => {
      start(sessionInfo({ sessionType, sectors: FIVE_SECTORS }));
      controller.__tick(tick());

      expect(cachedSectors()).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
    },
  );

  it("keeps the cached sectors while the key holds, and re-resolves on a new TrackID", () => {
    start(sessionInfo({ trackId: 42, sectors: FIVE_SECTORS }));
    controller.__tick(tick());

    expect(cachedSectors()).toEqual([0, 0.2, 0.4, 0.6, 0.8]);

    // Same (TrackID, SessionNum), other sectors in the session info: the cache
    // holds, which is what makes the next step a test of the key.
    controller.__setSessionInfo(sessionInfo({ trackId: 42, sectors: THREE_SECTORS }));
    controller.__tick(tick());

    expect(cachedSectors()).toEqual([0, 0.2, 0.4, 0.6, 0.8]);

    controller.__setSessionInfo(sessionInfo({ trackId: 7, sectors: THREE_SECTORS }));
    controller.__tick(tick());

    expect(cachedSectors()).toEqual([0, 0.333333, 0.666667]);
  });

  // A SessionNum change resets the whole translator state (`resetPerSessionState`),
  // so this is the session reset clearing the cache, not the key at work; the
  // TrackID test above is the key's own test.
  it("is cleared by the session reset and re-resolved on a new SessionNum", () => {
    start(sessionInfo({ sectors: FIVE_SECTORS }));
    controller.__tick(tick(0));

    expect(cachedSectors()).toEqual([0, 0.2, 0.4, 0.6, 0.8]);

    controller.__setSessionInfo(sessionInfo({ sectors: THREE_SECTORS }));
    controller.__tick(tick(1));

    expect(cachedSectors()).toEqual([0, 0.333333, 0.666667]);
  });

  it("retries while null, so sectors that arrive after the first read are picked up", () => {
    start(sessionInfo());
    controller.__tick(tick());

    expect(cachedSectors()).toBeNull();

    controller.__setSessionInfo(sessionInfo({ sectors: THREE_SECTORS }));
    controller.__tick(tick());

    expect(cachedSectors()).toEqual([0, 0.333333, 0.666667]);
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

    expect(cachedSectors()).toBeNull();

    // Positive control: valid sectors answer. Under a new TrackID, since an
    // invalid list stands for its key (the next test).
    controller.__setSessionInfo(sessionInfo({ trackId: 7, sectors: THREE_SECTORS }));
    controller.__tick(tick());

    expect(cachedSectors()).toEqual([0, 0.333333, 0.666667]);
  });

  it("parses sectors that fail validation once per key, and retries only while the list is absent", () => {
    const parse = vi.mocked(extractSectorStarts);

    start(sessionInfo());
    parse.mockClear();

    // No SplitTimeInfo yet: every tick retries. This is also the spy's
    // positive control, so the counts below cannot pass on a dead counter.
    controller.__tick(tick());
    controller.__tick(tick());

    expect(parse).toHaveBeenCalledTimes(2);

    // The list arrives under the same key and fails validation (sector 1 off
    // the line): parsed once, and the null then stands while the key holds.
    controller.__setSessionInfo(
      sessionInfo({
        sectors: [
          { SectorNum: 0, SectorStartPct: 0.1 },
          { SectorNum: 1, SectorStartPct: 0.5 },
        ],
      }),
    );
    controller.__tick(tick());
    controller.__tick(tick());
    controller.__tick(tick());

    expect(parse).toHaveBeenCalledTimes(3);
    expect(cachedSectors()).toBeNull();

    // A new key parses again.
    controller.__setSessionInfo(sessionInfo({ trackId: 7, sectors: THREE_SECTORS }));
    controller.__tick(tick());

    expect(parse).toHaveBeenCalledTimes(4);
    expect(cachedSectors()).toEqual([0, 0.333333, 0.666667]);
  });

  it("keeps retrying while SplitTimeInfo carries no Sectors list", () => {
    const parse = vi.mocked(extractSectorStarts);
    const info = sessionInfo();

    start({ ...info, SplitTimeInfo: {} });
    parse.mockClear();
    controller.__tick(tick());
    controller.__tick(tick());

    expect(parse).toHaveBeenCalledTimes(2);
    expect(cachedSectors()).toBeNull();

    controller.__setSessionInfo({ ...info, SplitTimeInfo: { Sectors: THREE_SECTORS } });
    controller.__tick(tick());

    expect(cachedSectors()).toEqual([0, 0.333333, 0.666667]);
  });

  it("is wiped at a replay like the other track caches, and re-resolved on the first live tick after the grace", () => {
    vi.useFakeTimers();
    start(sessionInfo({ sectors: FIVE_SECTORS }));
    controller.__tick(tick());

    expect(cachedSectors()).toEqual([0, 0.2, 0.4, 0.6, 0.8]);

    controller.__tick(tick(0, { IsReplayPlaying: true, IsOnTrack: false }));

    expect(cachedSectors()).toBeNull();

    // Back to live, inside the replay state's exit grace (#1324): no live step
    // runs yet, so nothing re-resolves.
    controller.__tick(tick());

    expect(cachedSectors()).toBeNull();

    vi.advanceTimersByTime(REPLAY_EXIT_GRACE_MS + 1);
    controller.__tick(tick());

    expect(cachedSectors()).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
  });
});

describe("sectorStart.approaching through the tick", () => {
  /** Every `sectorStart.approaching` the bus carries, as its payload. */
  function collect(): Array<{ sector: number; sectorCount: number }> {
    const seen: Array<{ sector: number; sectorCount: number }> = [];

    getEventBus().subscribe("sectorStart.approaching", (event) => {
      seen.push(event.data);
    });

    return seen;
  }

  // 44 m/s × 1 s (the default corner call lead) on 4000 m: the lead point is
  // 0.011 lap ahead, so 0.18 → 0.19 sweeps it from 0.191 to 0.201, across
  // sector 2's start at 0.2.
  it.each(["Offline Testing", "Practice", "Lone Practice"])(
    "publishes as the lead point crosses a sector start in a %s session",
    (sessionType) => {
      const seen = collect();

      start(sessionInfo({ sessionType, sectors: FIVE_SECTORS }));
      controller.__tick(tick(0, { LapDistPct: 0.18 }));
      controller.__tick(tick(0, { LapDistPct: 0.19 }));

      // No TrackName in the session info, so no corner markers: the sector
      // start is published all the same.
      expect(seen).toEqual([{ sector: 2, sectorCount: 5 }]);
    },
  );

  it.each(["Race", "Open Qualify", "Lone Qualify", "Warmup"])("is silent in a %s session", (sessionType) => {
    const seen = collect();

    start(sessionInfo({ sessionType, sectors: FIVE_SECTORS }));
    controller.__tick(tick(0, { LapDistPct: 0.18 }));
    controller.__tick(tick(0, { LapDistPct: 0.19 }));

    expect(seen).toEqual([]);
    // The sectors are there all the same: the silence is the session gate's.
    expect(cachedSectors()).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
  });

  it("publishes nothing for a crossing in a replay, and the next live crossing after the grace publishes", () => {
    vi.useFakeTimers();
    const seen = collect();

    start(sessionInfo({ sessionType: "Offline Testing", sectors: FIVE_SECTORS }));
    controller.__tick(tick(0, { LapDistPct: 0.18 }));
    // On track and crossing sector 2's start, but in a replay.
    controller.__tick(tick(0, { LapDistPct: 0.19, IsReplayPlaying: true }));

    expect(seen).toEqual([]);

    // Back to live, inside the exit grace: still the replay's (#1324).
    controller.__tick(tick(0, { LapDistPct: 0.195 }));

    expect(seen).toEqual([]);

    vi.advanceTimersByTime(REPLAY_EXIT_GRACE_MS + 1);
    controller.__tick(tick(0, { LapDistPct: 0.38 }));
    controller.__tick(tick(0, { LapDistPct: 0.39 }));

    expect(seen).toEqual([{ sector: 3, sectorCount: 5 }]);
  });
});

describe("a sector start and a corner name swept on one tick (#1676)", () => {
  /** Every sector-start and corner-name event the bus carries, in the order it carries them. */
  function collectInOrder(): string[] {
    const seen: string[] = [];

    getEventBus().subscribe("sectorStart.approaching", (event) => {
      seen.push(`sector ${event.data.sector}`);
    });
    getEventBus().subscribe("cornerName.approaching", (event) => {
      seen.push(`corner ${event.data.name}`);
    });

    return seen;
  }

  function startOnTestRing(sectors: unknown): void {
    const info = sessionInfo({ sessionType: "Offline Testing", sectors });
    (info.WeekendInfo as Record<string, unknown>).TrackName = TEST_RING;
    start(info);
  }

  // As above, 0.18 → 0.19 sweeps the lead point from 0.191 to 0.201, over
  // both sector 2's start and the corner at 0.2: a tie, which goes to the
  // sector call.
  it("publishes sectorStart.approaching before cornerName.approaching for a corner at the sector line", () => {
    const seen = collectInOrder();

    startOnTestRing(FIVE_SECTORS);
    controller.__tick(tick(0, { LapDistPct: 0.18 }));
    controller.__tick(tick(0, { LapDistPct: 0.19 }));

    expect(seen).toEqual(["sector 2", "corner Line Corner"]);
  });

  it("publishes the corner alone on the same tick with no sector start in the swept interval", () => {
    const seen = collectInOrder();

    // Three sectors at 0, 0.333 and 0.667: none between 0.191 and 0.201.
    startOnTestRing(THREE_SECTORS);
    controller.__tick(tick(0, { LapDistPct: 0.18 }));
    controller.__tick(tick(0, { LapDistPct: 0.19 }));

    expect(seen).toEqual(["corner Line Corner"]);
  });

  // A tick wider than one frame (an event-loop stall): 0.03 of a lap, under the
  // sweep's 0.05 teleport threshold. 0.37 → 0.40 sweeps the lead point from
  // 0.381 to 0.411, over the corner at 0.39 and then sector 3's start at 0.4.
  it("publishes the corner name first on a wide tick that crosses its marker before the sector start", () => {
    const seen = collectInOrder();

    startOnTestRing(FIVE_SECTORS);
    controller.__tick(tick(0, { LapDistPct: 0.37 }));
    controller.__tick(tick(0, { LapDistPct: 0.4 }));

    expect(seen).toEqual(["corner Early Corner", "sector 3"]);
  });

  // The same width: 0.57 → 0.60 sweeps from 0.581 to 0.611, over sector 4's
  // start at 0.6 and then the corner at 0.61.
  it("publishes the sector call first on a wide tick that crosses the sector start before the marker", () => {
    const seen = collectInOrder();

    startOnTestRing(FIVE_SECTORS);
    controller.__tick(tick(0, { LapDistPct: 0.57 }));
    controller.__tick(tick(0, { LapDistPct: 0.6 }));

    expect(seen).toEqual(["sector 4", "corner Late Corner"]);
  });
});
