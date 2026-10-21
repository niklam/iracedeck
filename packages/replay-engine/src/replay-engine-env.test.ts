import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureReplayEngine } from "./replay-engine-configure.js";
import {
  _configureReplayEngine,
  _resetReplayEngineEnv,
  engineEnv,
  engineLogger,
  engineReads,
  type ReplayEngineController,
  type ReplayEngineEnv,
} from "./replay-engine-env.js";
import { _resetReplayLeft } from "./replay-left.js";

/** A controller whose every read answers, overridable per test. */
function fakeController(
  overrides: Partial<Record<keyof ReplayEngineController, unknown>> = {},
): ReplayEngineController {
  return {
    getCurrentTelemetry: vi.fn(() => null),
    getSessionInfo: vi.fn(() => null),
    getReplayState: vi.fn(() => ({ inReplay: true })),
    getConnectionStatus: vi.fn(() => false),
    noteReplayLeftForLive: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    ...overrides,
  } as unknown as ReplayEngineController;
}

function configured(overrides: Partial<ReplayEngineEnv> = {}): ReplayEngineEnv {
  return {
    controller: fakeController(),
    replay: () => {
      throw new Error("no replay surface in this test");
    },
    camera: () => {
      throw new Error("no camera surface in this test");
    },
    now: () => 0,
    logger: silentLogger,
    settings: { replayJumpPlayback: () => undefined, fastestLapSearchDelayMs: () => undefined },
    ...overrides,
  };
}

describe("replay engine env (#1467)", () => {
  afterEach(() => {
    _resetReplayLeft();
    _resetReplayEngineEnv();
  });

  it("reads nothing and sends nothing before it is configured", () => {
    expect(engineReads().readTelemetry()).toBeNull();
    expect(engineReads().inReplay()).toBe(false);
    expect(engineReads().connected()).toBe(true);
    expect(() => engineReads().leftForLive()).not.toThrow();
    expect(() => engineEnv().replay()).toThrow("replay engine not configured");
    expect(() => engineEnv().camera()).toThrow("replay engine not configured");
    expect(engineEnv().controller).toBeNull();
    expect(engineEnv().logger).toBe(silentLogger);
    expect(engineEnv().settings.replayJumpPlayback()).toBeUndefined();
    expect(engineEnv().settings.fastestLapSearchDelayMs()).toBeUndefined();
  });

  it("derives the reads from the injected controller, catching a throwing one", () => {
    const telemetry = { ReplayFrameNum: 42 };
    const controller = fakeController({ getCurrentTelemetry: vi.fn(() => telemetry) });
    configureReplayEngine(configured({ controller }));

    expect(engineReads().readTelemetry()).toBe(telemetry);
    expect(engineReads().inReplay()).toBe(true);
    expect(engineReads().connected()).toBe(false);
    engineReads().leftForLive();
    expect(controller.noteReplayLeftForLive).toHaveBeenCalledTimes(1);

    const boom = vi.fn(() => {
      throw new Error("no sdk");
    });
    configureReplayEngine(
      configured({
        controller: fakeController({
          getCurrentTelemetry: boom,
          getReplayState: boom,
          getConnectionStatus: boom,
          noteReplayLeftForLive: boom,
        }),
      }),
    );

    expect(engineReads().readTelemetry()).toBeNull();
    expect(engineReads().inReplay()).toBe(false);
    expect(engineReads().connected()).toBe(true);
    expect(() => engineReads().leftForLive()).not.toThrow();
    // Positive control: each read did reach the throwing controller.
    expect(boom).toHaveBeenCalledTimes(4);
  });

  it("reads the settings closures at the time of use", () => {
    let current: unknown = "play";
    let delay: unknown = 250;
    configureReplayEngine(
      configured({ settings: { replayJumpPlayback: () => current, fastestLapSearchDelayMs: () => delay } }),
    );

    expect(engineEnv().settings.replayJumpPlayback()).toBe("play");
    expect(engineEnv().settings.fastestLapSearchDelayMs()).toBe(250);

    current = "stopped";
    delay = 1000;

    expect(engineEnv().settings.replayJumpPlayback()).toBe("stopped");
    expect(engineEnv().settings.fastestLapSearchDelayMs()).toBe(1000);
  });

  it("lets a test override one read without a controller", () => {
    _configureReplayEngine({ inReplay: () => true });

    expect(engineReads().inReplay()).toBe(true);
    expect(engineReads().readTelemetry()).toBeNull();
    expect(engineReads().connected()).toBe(true);
  });

  it("starts each test override from the unconfigured default, so overrides do not accumulate", () => {
    _configureReplayEngine({ inReplay: () => true, now: () => 5 });
    _configureReplayEngine({ connected: () => false });

    expect(engineReads().inReplay()).toBe(false);
    expect(engineReads().connected()).toBe(false);
    expect(engineEnv().now()).not.toBe(5);
  });

  it("lets a read override win over the controller's read", () => {
    const controller = fakeController();
    _configureReplayEngine({ controller, inReplay: () => false });

    expect(engineReads().inReplay()).toBe(false);
    // The reads not overridden still come from the controller.
    expect(engineReads().connected()).toBe(false);
    expect(controller.getReplayState).not.toHaveBeenCalled();
  });

  it("drops a test's read overrides when the engine is configured", () => {
    _configureReplayEngine({ inReplay: () => true });
    configureReplayEngine(
      configured({ controller: fakeController({ getReplayState: vi.fn(() => ({ inReplay: false })) }) }),
    );

    expect(engineReads().inReplay()).toBe(false);
  });

  it("scopes engine loggers under the injected logger", () => {
    const names: string[] = [];
    const logger: ILogger = {
      ...silentLogger,
      createScope: (scope: string) => {
        names.push(scope);

        return silentLogger;
      },
    };
    configureReplayEngine(configured({ logger }));

    const first = engineLogger("ReplayGate");
    const second = engineLogger("ReplayGate");

    expect(names).toEqual(["ReplayGate"]);
    expect(second).toBe(first);

    engineLogger("ReplaySearch");
    expect(names).toEqual(["ReplayGate", "ReplaySearch"]);
  });

  it("scopes under a newly injected logger rather than one cached from the last", () => {
    const scopes: string[] = [];
    const make = (name: string): ILogger => ({
      ...silentLogger,
      createScope: (scope: string) => {
        scopes.push(`${name}:${scope}`);

        return silentLogger;
      },
    });
    configureReplayEngine(configured({ logger: make("a") }));
    engineLogger("ReplayGate");
    configureReplayEngine(configured({ logger: make("b") }));
    engineLogger("ReplayGate");

    expect(scopes).toEqual(["a:ReplayGate", "b:ReplayGate"]);
  });
});
