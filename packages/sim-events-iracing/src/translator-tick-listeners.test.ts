/**
 * The translator's after-tick listeners (issue #1500): `onTranslatorTick`
 * runs each listener at the end of the translator's own controller callback,
 * so a read inside it sees the tick the translator has just handled. That
 * ordering is what a deck host's profile switch relies on instead of the
 * order the SDK controller's subscribers were added in.
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

type MockController = SDKController & {
  __tick: (telemetry: TelemetryData | null, isConnected?: boolean) => void;
};

/**
 * A controller that, like the real one, calls a new subscriber back at once
 * with the offline `(null, false)` state, and steps the replay state before
 * each tick. Its session YAML has a practice, a qualifying and a race session.
 */
function createMockController(): MockController {
  let callback: TelemetryCallback | null = null;
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
    subscribe: (_id: string, cb: TelemetryCallback) => {
      callback = cb;
      cb(null, false);
    },
    unsubscribe: (_id: string) => {
      callback = null;
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

    callback?.(telemetry, isConnected);
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
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger());
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
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger());
    controller.__tick(telemetry({ SessionNum: 2 }));
    const seen: Seen[] = [];
    onTranslatorTick(recordSeen(seen));

    controller.__tick(null, false);

    expect(seen).toEqual([{ sessionType: "", sessionKind: null, latestTelemetry: null }]);
  });

  it("calls the listener on a connected callback that carries no telemetry, with the last tick's state kept", () => {
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger());
    const race = telemetry({ SessionNum: 2 });
    controller.__tick(race);
    const seen: Seen[] = [];
    onTranslatorTick(recordSeen(seen));

    controller.__tick(null, true);

    expect(seen).toEqual([{ sessionType: "Race", sessionKind: "race", latestTelemetry: race }]);
  });

  it("logs a listener that throws, and still runs the next listener and the translator's next tick", () => {
    const logger = createMockLogger();
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, logger);
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
    expect(logger.error).toHaveBeenCalledWith("Translator tick listener failed");
    expect(logger.debug).toHaveBeenCalledWith("Listener error: Error: listener broke");
  });

  it("logs a listener that keeps throwing once per run of failures, not at every tick", () => {
    const logger = createMockLogger();
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, logger);
    let broken = true;
    onTranslatorTick(() => {
      if (broken) throw new Error("listener broke");
    });
    const failures = (): number =>
      vi.mocked(logger.error).mock.calls.filter(([message]) => message === "Translator tick listener failed").length;

    for (let i = 0; i < 3; i += 1) controller.__tick(telemetry({ SessionNum: 2 }));

    expect(failures()).toBe(1);

    broken = false;
    controller.__tick(telemetry({ SessionNum: 2 }));
    broken = true;
    controller.__tick(telemetry({ SessionNum: 2 }));

    expect(failures()).toBe(2);
  });

  it("calls a listener registered during a pass from the next update on, and one re-registered during a pass once", () => {
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger());
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

  it("logs the first throw of a listener registered again after it unsubscribed and threw", () => {
    const logger = createMockLogger();
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, logger);
    let unsubscribe = (): void => undefined;
    let quit = true;
    // Unsubscribes before throwing on its first registration only, so its
    // second registration's throw is not cleared by an unsubscribe of its own.
    const quitting = (): void => {
      if (quit) unsubscribe();

      throw new Error("listener broke");
    };
    const failures = (): number =>
      vi.mocked(logger.error).mock.calls.filter(([message]) => message === "Translator tick listener failed").length;
    unsubscribe = onTranslatorTick(quitting);

    controller.__tick(telemetry({ SessionNum: 2 }));

    expect(failures()).toBe(1);

    quit = false;
    unsubscribe = onTranslatorTick(quitting);
    controller.__tick(telemetry({ SessionNum: 2 }));

    expect(failures()).toBe(2);
  });

  it("still calls the listeners when the translator throws on the tick, and lets the throw reach the controller", () => {
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger());
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
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger());
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
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger());
    expect(listener).toHaveBeenCalledOnce();

    controller.__tick(telemetry());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("drops every listener on _resetSimEventsIracing", () => {
    const listener = vi.fn();
    onTranslatorTick(listener);

    _resetSimEventsIracing();
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger());
    controller.__tick(telemetry());

    expect(listener).not.toHaveBeenCalled();
  });
});
