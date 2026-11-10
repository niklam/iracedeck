/**
 * The pit limiter's on / off edge through the real tick (issue #1272): a press
 * in the pit stall publishes `carControl.limiterToggled`, which `diffToggles`'
 * stall seed used to swallow, and a replay glance re-seeds the baseline, so a
 * limiter switched while the replay was up is never announced. The rules
 * themselves are pinned in `diff/limiter-toggle.test.ts`.
 */
import { _resetEventBus, getEventBus, initializeEventBus, type SimEventOf } from "@iracedeck/event-bus";
import {
  CarLeftRight,
  EngineWarnings,
  REPLAY_EXIT_GRACE_MS,
  ReplayStateTracker,
  type SDKController,
  type TelemetryCallback,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetSimEventsIracing, initializeSimEventsIracing } from "./translator.js";

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

type MockController = SDKController & { __tick: (telemetry: TelemetryData) => void };

function createMockController(): MockController {
  // Several subscribers, notified in subscription order as `SDKController`
  // does: the translator, then the replay recorder it starts (#1468).
  const subscribers = new Map<string, TelemetryCallback>();
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
    getSessionInfo: () => null,
    getReplayState: (nowMs: number = Date.now()) => replayState.read(nowMs),
    noteReplayLeftForLive: (nowMs: number = Date.now()) => replayState.noteLeftForLive(nowMs),
  } as unknown as MockController;

  controller.__tick = (telemetry) => {
    replayState.step(telemetry, null, Date.now());

    for (const cb of [...subscribers.values()]) cb(telemetry, true);
  };

  return controller;
}

/** A tick with the limiter `on`, in the pit stall or out on the circuit. */
function telemetry(on: boolean, inStall: boolean, overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    OnPitRoad: inStall,
    PlayerCarInPitStall: inStall,
    IsOnTrack: true,
    PlayerTrackSurface: inStall ? TrkLoc.InPitStall : TrkLoc.OnTrack,
    PlayerTrackSurfaceMaterial: 0,
    PitstopActive: false,
    PlayerCarMyIncidentCount: 0,
    PlayerIncidents: 0,
    SessionFlags: 0,
    SessionNum: 0,
    PitSvFlags: 0,
    PitSvTireCompound: 0,
    PlayerTireCompound: 0,
    EngineWarnings: on ? EngineWarnings.PitSpeedLimiter : 0,
    Speed: 0,
    CarLeftRight: CarLeftRight.Off,
    DRS_Status: 0,
    P2P_Status: false,
    RPM: 0,
    Lap: 0,
    LapDistPct: 0,
    FuelLevel: 10,
    ...overrides,
  } as TelemetryData;
}

describe("carControl.limiterToggled through handleTick (issue #1272)", () => {
  beforeEach(() => {
    initializeEventBus(createMockLogger());
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 10, 12));
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetSimEventsIracing();
    _resetEventBus();
  });

  function start(): { controller: MockController; toggled: ReturnType<typeof vi.fn> } {
    const controller = createMockController();
    const bus = getEventBus();
    const toggled = vi.fn();
    bus.subscribe("carControl.limiterToggled", toggled);
    initializeSimEventsIracing(bus, controller, createMockLogger(), { onStepError: "rethrow" });

    return { controller, toggled };
  }

  const data = (toggled: ReturnType<typeof vi.fn>): boolean[] =>
    toggled.mock.calls.map((call) => (call[0] as SimEventOf<"carControl.limiterToggled">).data.on);

  it("publishes a press in the pit stall", () => {
    const { controller, toggled } = start();

    controller.__tick(telemetry(false, true));
    vi.advanceTimersByTime(1_000);
    controller.__tick(telemetry(false, true));
    vi.advanceTimersByTime(16);
    controller.__tick(telemetry(true, true));

    expect(data(toggled)).toEqual([true]);
  });

  it("stays silent for a press during pit service", () => {
    const { controller, toggled } = start();

    controller.__tick(telemetry(false, true));
    vi.advanceTimersByTime(1_000);
    controller.__tick(telemetry(true, true, { PitstopActive: true }));

    expect(toggled).not.toHaveBeenCalled();
  });

  it("re-seeds after a replay glance: a limiter switched on meanwhile is not announced", () => {
    const { controller, toggled } = start();

    controller.__tick(telemetry(false, false));
    vi.advanceTimersByTime(1_000);
    controller.__tick(telemetry(false, false));

    // A replay glance; the limiter goes on meanwhile.
    vi.advanceTimersByTime(16);
    controller.__tick(telemetry(true, false, { IsReplayPlaying: true }));
    vi.advanceTimersByTime(16);
    controller.__tick(telemetry(true, false, { IsReplayPlaying: true }));

    // Back live once the exit grace has run out (#1324): the first live tick
    // seeds, and nothing is said for the change made during the replay.
    controller.__tick(telemetry(true, false));
    vi.advanceTimersByTime(REPLAY_EXIT_GRACE_MS);
    controller.__tick(telemetry(true, false));
    vi.advanceTimersByTime(16);
    controller.__tick(telemetry(true, false));
    expect(toggled).not.toHaveBeenCalled();

    // The re-seeded baseline is live: the next change publishes.
    vi.advanceTimersByTime(16);
    controller.__tick(telemetry(false, false));
    expect(data(toggled)).toEqual([false]);
  });
});
