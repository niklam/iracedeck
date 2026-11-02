/**
 * The translator's after-tick listeners (issue #1500): `onTranslatorTick`
 * runs each listener at the end of the translator's own controller callback,
 * so a read inside it sees the tick the translator has just handled. That
 * ordering is what a deck host's profile switch relies on instead of the
 * order the SDK controller's subscribers were added in. Each listener is called
 * through the translator's step boundary (#1559), under the one id
 * `translator:onTranslatorTick`, so a listener's throw is reported by #1558's
 * bounded reporter: the logging tests run the default `"report"` policy with a
 * fake clock, every other test `"rethrow"`.
 */
import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import {
  CarLeftRight,
  ReplayStateTracker,
  type SDKController,
  type TelemetryCallback,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetSimEventsIracing,
  getLatestTelemetry,
  getSessionKind,
  getSessionType,
  initializeSimEventsIracing,
  onTranslatorTick,
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

/** The `error` lines a mock logger was handed. */
function errorLines(logger: ILogger): string[] {
  return vi.mocked(logger.error).mock.calls.map(([message]) => message);
}

type MockController = SDKController & {
  __tick: (telemetry: TelemetryData | null, isConnected?: boolean) => void;
};

/**
 * A controller that, like the real one, calls a new subscriber back at once
 * with the offline `(null, false)` state, and steps the replay state before
 * each tick. Its session YAML has a practice, a qualifying and a race session.
 */
function createMockController(): MockController {
  // Several subscribers, notified in subscription order as `SDKController`
  // does: the translator, then the replay recorder it starts (#1468).
  const subscribers = new Map<string, TelemetryCallback>();
  const sessionInfo = {
    WeekendInfo: { SimMode: "full" },
    SessionInfo: {
      Sessions: [
        { SessionNum: 0, SessionType: "Practice" },
        { SessionNum: 1, SessionType: "Lone Qualify" },
        { SessionNum: 2, SessionType: "Race" },
      ],
    },
    DriverInfo: { DriverCarIdx: 0 },
  };
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

  controller.__tick = (telemetry, isConnected = true) => {
    if (telemetry) {
      replayState.step(telemetry, sessionInfo, Date.now());
    } else {
      replayState.reset();
    }

    for (const cb of [...subscribers.values()]) cb(telemetry, isConnected);
  };

  return controller;
}

function telemetry(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    OnPitRoad: false,
    PlayerCarInPitStall: false,
    IsOnTrack: true,
    PlayerTrackSurface: TrkLoc.OnTrack,
    PlayerTrackSurfaceMaterial: 0,
    PlayerCarMyIncidentCount: 0,
    PlayerIncidents: 0,
    SessionFlags: 0,
    SessionNum: 0,
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
    ...overrides,
  } as TelemetryData;
}

/** What one listener call saw of the translator's state. */
interface Seen {
  readonly sessionType: string;
  readonly sessionKind: string | null;
  readonly latestTelemetry: TelemetryData | null;
}

function recordSeen(into: Seen[]): () => void {
  return () => {
    into.push({ sessionType: getSessionType(), sessionKind: getSessionKind(), latestTelemetry: getLatestTelemetry() });
  };
}

describe("onTranslatorTick (#1500)", () => {
  beforeEach(() => {
    initializeEventBus(createMockLogger());
  });

  afterEach(() => {
    _resetSimEventsIracing();
    _resetEventBus();
  });

  it("calls the listener after the translator has handled the tick, so it reads this tick's state", () => {
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger(), { onStepError: "rethrow" });
    const seen: Seen[] = [];
    onTranslatorTick(recordSeen(seen));

    const practice = telemetry({ SessionNum: 0 });
    const qualifying = telemetry({ SessionNum: 1 });
    const race = telemetry({ SessionNum: 2 });
    controller.__tick(practice);
    controller.__tick(qualifying);
    controller.__tick(race);

    expect(seen).toEqual([
      { sessionType: "Practice", sessionKind: "practice", latestTelemetry: practice },
      { sessionType: "Lone Qualify", sessionKind: "qualifying", latestTelemetry: qualifying },
      { sessionType: "Race", sessionKind: "race", latestTelemetry: race },
    ]);
  });

  it("calls the listener on a disconnect, after the translator has dropped the session", () => {
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger(), { onStepError: "rethrow" });
    controller.__tick(telemetry({ SessionNum: 2 }));
    const seen: Seen[] = [];
    onTranslatorTick(recordSeen(seen));

    controller.__tick(null, false);

    expect(seen).toEqual([{ sessionType: "", sessionKind: null, latestTelemetry: null }]);
  });

  it("calls the listener on a connected callback that carries no telemetry, with the last tick's state kept", () => {
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger(), { onStepError: "rethrow" });
    const race = telemetry({ SessionNum: 2 });
    controller.__tick(race);
    const seen: Seen[] = [];
    onTranslatorTick(recordSeen(seen));

    controller.__tick(null, true);

    expect(seen).toEqual([{ sessionType: "Race", sessionKind: "race", latestTelemetry: race }]);
  });

  it("reports a listener that throws, and still runs the next listener and the translator's next tick", () => {
    const logger = createMockLogger();
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, logger, { errorClock: () => 0 });
    const failing = vi.fn(() => {
      throw new Error("listener broke");
    });
    const seen: Seen[] = [];
    onTranslatorTick(failing);
    onTranslatorTick(recordSeen(seen));

    const practice = telemetry({ SessionNum: 0 });
    const race = telemetry({ SessionNum: 2 });
    expect(() => controller.__tick(practice)).not.toThrow();
    controller.__tick(race);

    expect(failing).toHaveBeenCalledTimes(2);
    expect(seen.map((s) => s.latestTelemetry)).toEqual([practice, race]);
    expect(getSessionKind()).toBe("race");
    // One `error` line with the stack, for the first throw at this site; the second is counted.
    expect(errorLines(logger)).toHaveLength(1);
    expect(errorLines(logger)[0]).toMatch(/^translator:onTranslatorTick threw: Error: listener broke\n\s+at /);
  });

  it("reports a listener that keeps throwing once, summarises its repeats a minute later, and declares recovery after a quiet minute", () => {
    const logger = createMockLogger();
    const controller = createMockController();
    let clock = 0;
    initializeSimEventsIracing(getEventBus(), controller, logger, { errorClock: () => clock });
    let broken = true;
    onTranslatorTick(() => {
      if (broken) throw new Error("listener broke");
    });

    // Throws at 0, 20 and 40 s: one `error` line, the repeats counted.
    for (const at of [0, 20_000, 40_000]) {
      clock = at;
      controller.__tick(telemetry({ SessionNum: 2 }));
    }

    expect(errorLines(logger)).toHaveLength(1);
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();

    // A minute after the first line, one summary of the repeats.
    clock = 60_000;
    controller.__tick(telemetry({ SessionNum: 2 }));

    expect(errorLines(logger)).toHaveLength(1);
    expect(vi.mocked(logger.warn).mock.calls.map(([message]) => message)).toEqual([
      expect.stringMatching(
        /^translator:onTranslatorTick threw 3 more times in the last 60s, latest at .*: Error: listener broke$/,
      ),
    ]);

    // A clean call inside the window is not a recovery; a quiet minute is.
    broken = false;
    clock = 61_000;
    controller.__tick(telemetry({ SessionNum: 2 }));
    clock = 120_000;
    controller.__tick(telemetry({ SessionNum: 2 }));

    expect(vi.mocked(logger.info).mock.calls.map(([message]) => message)).toContain(
      "translator:onTranslatorTick recovered: no errors for 60s, after 4 times in all",
    );

    broken = true;
    controller.__tick(telemetry({ SessionNum: 2 }));

    expect(errorLines(logger)).toHaveLength(2);
  });

  it("calls a listener registered during a pass from the next update on, and one re-registered during a pass once", () => {
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger(), { onStepError: "rethrow" });
    const late = vi.fn();
    const calls: string[] = [];
    let unsubscribeSelf = (): void => undefined;
    const restarting = (): void => {
      calls.push("restarting");
      unsubscribeSelf();
      unsubscribeSelf = onTranslatorTick(restarting);
    };
    unsubscribeSelf = onTranslatorTick(restarting);
    const unsubscribeAdder = onTranslatorTick(() => {
      onTranslatorTick(late);
      unsubscribeAdder();
    });

    controller.__tick(telemetry({ SessionNum: 2 }));

    expect(late).not.toHaveBeenCalled();
    expect(calls).toEqual(["restarting"]);

    controller.__tick(telemetry({ SessionNum: 2 }));

    expect(late).toHaveBeenCalledOnce();
    expect(calls).toEqual(["restarting", "restarting"]);
  });

  it("reports a listener that unsubscribes and then throws, runs the next one, and never calls it again", () => {
    const logger = createMockLogger();
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, logger, { errorClock: () => 0 });
    let unsubscribe = (): void => undefined;
    const quitting = vi.fn((): void => {
      unsubscribe();

      throw new Error("listener broke");
    });
    const next = vi.fn();
    unsubscribe = onTranslatorTick(quitting);
    onTranslatorTick(next);

    controller.__tick(telemetry({ SessionNum: 2 }));
    controller.__tick(telemetry({ SessionNum: 2 }));

    expect(quitting).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledTimes(2);
    expect(errorLines(logger)).toEqual([
      expect.stringMatching(/^translator:onTranslatorTick threw: Error: listener broke/),
    ]);
  });

  it('under "rethrow" runs every listener and throws the first listener\'s error once all have run', () => {
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger(), { onStepError: "rethrow" });
    const order: string[] = [];
    onTranslatorTick(() => {
      order.push("first");
      throw new Error("first broke");
    });
    onTranslatorTick(() => {
      order.push("second");
      throw new Error("second broke");
    });
    onTranslatorTick(() => {
      order.push("third");
    });

    expect(() => controller.__tick(telemetry({ SessionNum: 2 }))).toThrow("first broke");
    expect(order).toEqual(["first", "second", "third"]);
    // Nothing is carried into the next tick.
    order.length = 0;
    expect(() => controller.__tick(telemetry({ SessionNum: 2 }))).toThrow("first broke");
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("still calls the listeners when the translator throws on the tick, and lets the throw reach the controller", () => {
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger(), { onStepError: "rethrow" });
    const listener = vi.fn();
    onTranslatorTick(listener);
    // A tick the translator cannot read: every diff path reads the session number.
    const unreadable = telemetry();
    Object.defineProperty(unreadable, "SessionNum", {
      get: () => {
        throw new Error("unreadable tick");
      },
    });

    expect(() => controller.__tick(unreadable)).toThrow("unreadable tick");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("stops calling a listener once it unsubscribes, and leaves the others subscribed", () => {
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger(), { onStepError: "rethrow" });
    const dropped = vi.fn();
    const kept = vi.fn();
    const unsubscribe = onTranslatorTick(dropped);
    onTranslatorTick(kept);

    controller.__tick(telemetry());
    unsubscribe();
    controller.__tick(telemetry());

    expect(dropped).toHaveBeenCalledOnce();
    expect(kept).toHaveBeenCalledTimes(2);
  });

  it("keeps a listener registered before the translator starts, and calls it from the first controller callback on", () => {
    const listener = vi.fn();
    onTranslatorTick(listener);
    const controller = createMockController();

    // The controller calls a new subscriber back at once with its offline state.
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger(), { onStepError: "rethrow" });
    expect(listener).toHaveBeenCalledOnce();

    controller.__tick(telemetry());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("drops every listener on _resetSimEventsIracing", () => {
    const listener = vi.fn();
    onTranslatorTick(listener);

    _resetSimEventsIracing();
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger(), { onStepError: "rethrow" });
    controller.__tick(telemetry());

    expect(listener).not.toHaveBeenCalled();
  });
});
