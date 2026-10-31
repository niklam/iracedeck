/**
 * The replay recorder's startup tick (issue #1468), against the REAL
 * `SDKController`. The controller starts on its first subscribe, and its
 * `tryConnect` notifies every subscriber when the connection comes up; then
 * `subscribe` hands the new subscriber the current telemetry once more. The
 * translator is the first subscriber (`plugin-runtime`'s sim phase), so with
 * iRacing already connected at plugin start it sees the first tick TWICE
 * during `initializeSimEventsIracing`. Before #1468 the replay recorders ran
 * inside the translator's callback and saw it twice too: `diffReplaySessions`'
 * two-consecutive-ticks agreement (`diff/replay-sessions.ts`) was met on that
 * one telemetry, `replay.sessionStarted` went out during init, before
 * replay-store subscribes (its phase runs later), and the pair counted as
 * published, so that session's start was lost for the whole connection. Since
 * #1468 the recorder is its own subscriber, subscribed once the controller has
 * started, so it gets only `subscribe`'s immediate delivery and publishes on
 * the first real poll. The equivalence golden cannot see this: its fake
 * controller delivers one offline tick per subscribe and models neither the
 * connect-time notification nor the double delivery. This test pins both the
 * controller's premise and the recorder's behaviour on top of it.
 */
import { _resetEventBus, getEventBus, initializeEventBus, type SimEventOf } from "@iracedeck/event-bus";
import {
  CarLeftRight,
  type IRacingSDK,
  SDKController,
  TELEMETRY_INTERVAL_MS,
  type TelemetryCallback,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REPLAY_RECORDER_SUBSCRIPTION_ID } from "./replay-recorder.js";
import { _resetSimEventsIracing, initializeSimEventsIracing } from "./translator.js";

/** The translator's controller subscription id (`translator.ts`, not exported). */
const TRANSLATOR_SUBSCRIPTION_ID = "__sim-events-iracing__";

const SUB_SESSION = 86697546;
const SESSION_NUM = 1;
const SESSION_UNIQUE_ID = 2;
/** The replay frame the session began at: every tick's frame is this plus its `SessionTime` × 60. */
const SESSION_START_FRAME = 120_000;

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

/** A live, in-car tick of the session, `n` ticks after the first. */
function carTick(n: number): TelemetryData {
  const sessionTime = 600 + n / 60;

  return {
    OnPitRoad: false,
    PlayerCarInPitStall: false,
    IsOnTrack: true,
    PlayerTrackSurface: TrkLoc.OnTrack,
    PlayerTrackSurfaceMaterial: 0,
    PlayerCarMyIncidentCount: 0,
    PlayerIncidents: 0,
    SessionFlags: 0,
    PitSvFlags: 0,
    PitSvTireCompound: 0,
    PlayerTireCompound: 0,
    EngineWarnings: 0,
    Speed: 0,
    CarLeftRight: CarLeftRight.Off,
    DRS_Status: 0,
    P2P_Status: false,
    RPM: 0,
    Lap: 0,
    LapDistPct: 0,
    FuelLevel: 10,
    SessionNum: SESSION_NUM,
    SessionUniqueID: SESSION_UNIQUE_ID,
    SessionTime: sessionTime,
    SessionTick: 50_000 + n,
    IsReplayPlaying: false,
    ReplayFrameNum: 0,
    ReplayFrameNumEnd: SESSION_START_FRAME + Math.round(sessionTime * 60),
  } as TelemetryData;
}

const SESSION_INFO = { WeekendInfo: { SubSessionID: SUB_SESSION, SimMode: "full" } };

/** `SDKController.test.ts`'s SDK double, connected from the start and serving `current()`. */
function createMockSDK(current: () => TelemetryData): IRacingSDK {
  return {
    connect: vi.fn().mockReturnValue(true),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    getTelemetry: vi.fn(() => current()),
    getSessionInfo: vi.fn().mockReturnValue(SESSION_INFO),
    getVar: vi.fn(),
    getVarNames: vi.fn().mockReturnValue([]),
    getVarHeader: vi.fn().mockReturnValue(null),
    broadcast: vi.fn(),
  } as unknown as IRacingSDK;
}

type Delivery = { telemetry: TelemetryData | null; isConnected: boolean };

describe("the replay recorder's startup tick, on the real SDKController (issue #1468)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    initializeEventBus(createMockLogger());
  });

  afterEach(() => {
    _resetSimEventsIracing();
    _resetEventBus();
    vi.useRealTimers();
  });

  it("does not publish the session's start during init, and publishes it once on the first poll", () => {
    let current = carTick(0);
    const firstTick = current;
    const controller = new SDKController(createMockSDK(() => current));

    // Record every delivery per subscriber, through the real subscribe.
    const deliveries = new Map<string, Delivery[]>();
    const realSubscribe = controller.subscribe.bind(controller);
    vi.spyOn(controller, "subscribe").mockImplementation((id: string, callback: TelemetryCallback) => {
      deliveries.set(id, []);
      realSubscribe(id, (telemetry, isConnected) => {
        deliveries.get(id)!.push({ telemetry, isConnected });
        callback(telemetry, isConnected);
      });
    });

    const published: SimEventOf<"replay.sessionStarted">[] = [];
    getEventBus().subscribe("replay.sessionStarted", (ev) => {
      published.push(ev);
    });

    initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

    // The premise, on the real controller: the translator subscribes first and
    // gets the first tick twice (the connect-time notification, then
    // subscribe's immediate delivery); the recorder, subscribed second, gets
    // it once. If the controller stops double-delivering, this goes red and
    // the premise of this test is stale.
    expect([...deliveries.keys()]).toEqual([TRANSLATOR_SUBSCRIPTION_ID, REPLAY_RECORDER_SUBSCRIPTION_ID]);
    expect(deliveries.get(TRANSLATOR_SUBSCRIPTION_ID)).toEqual([
      { telemetry: firstTick, isConnected: true },
      { telemetry: firstTick, isConnected: true },
    ]);
    expect(deliveries.get(REPLAY_RECORDER_SUBSCRIPTION_ID)).toEqual([{ telemetry: firstTick, isConnected: true }]);

    // One tick seen once is no agreement: nothing published during init.
    expect(published).toEqual([]);

    // The first poll, with the tick advanced: the second consecutive reading
    // agrees and the session's start is published, once.
    current = carTick(1);
    vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

    expect(deliveries.get(REPLAY_RECORDER_SUBSCRIPTION_ID)).toHaveLength(2);
    expect(published).toHaveLength(1);
    expect(published[0]!.data).toEqual({
      subSessionId: SUB_SESSION,
      sessionNum: SESSION_NUM,
      sessionUniqueId: SESSION_UNIQUE_ID,
      frame: SESSION_START_FRAME,
    });
    expect(published[0]!.telemetry).toBe(current);

    // Later polls do not publish the pair again.
    current = carTick(2);
    vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);
    current = carTick(3);
    vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);

    expect(deliveries.get(REPLAY_RECORDER_SUBSCRIPTION_ID)).toHaveLength(4);
    expect(published).toHaveLength(1);
  });
});
