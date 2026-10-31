import type { ReplayEngineEnv } from "@iracedeck/replay-engine/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callLog, implement, resetRecorder } from "../test-support/recorder.js";
import type { Core } from "../types.js";
import { initReplay } from "./replay.js";

const { configureReplayEngine, getCommands, getGlobalSettings } = vi.hoisted(() => ({
  configureReplayEngine: vi.fn<(env: ReplayEngineEnv) => void>(),
  getCommands: vi.fn(),
  getGlobalSettings: vi.fn((): Record<string, unknown> => ({})),
}));

vi.mock("@iracedeck/replay-engine", () => ({ configureReplayEngine }));
vi.mock("@iracedeck/deck-iracing", () => ({ getCommands }));
vi.mock("@iracedeck/settings", () => ({ getGlobalSettings }));
vi.mock("@iracedeck/deck-core", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/replay-store", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));

function fakeCore() {
  const logger = { name: "replay engine logger" };
  const createLogger = vi.fn(() => logger);
  const controller = { name: "controller" };
  const handlers = new Map<string, (ev: { data: unknown }) => void>();
  const bus = {
    subscribe: (name: string, handler: (ev: { data: unknown }) => void) => handlers.set(name, handler),
  };
  const core = { controller, bus, adapter: { createLogger } } as unknown as Core;

  return { core, controller, createLogger, logger, handlers };
}

/** The env `initReplay` handed the engine. */
function configuredEnv(): ReplayEngineEnv {
  expect(configureReplayEngine).toHaveBeenCalledTimes(1);

  return configureReplayEngine.mock.calls[0][0];
}

describe("initReplay (#1467)", () => {
  let exitListenersBefore: Set<unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRecorder();
    exitListenersBefore = new Set(process.listeners("exit"));
  });

  afterEach(() => {
    for (const listener of process.listeners("exit")) {
      if (!exitListenersBefore.has(listener)) process.removeListener("exit", listener);
    }
  });

  it("configures the replay engine with the controller, a logger and live settings closures", () => {
    const { core, controller, createLogger, logger } = fakeCore();

    initReplay(core);

    const env = configuredEnv();
    expect(env.controller).toBe(controller);
    expect(createLogger).toHaveBeenCalledWith("ReplayEngine");
    expect(env.logger).toBe(logger);
    expect(env.now()).toBeTypeOf("number");

    getGlobalSettings.mockReturnValue({ fastestLapSearchDelayMs: 250, replayJumpPlayback: "play" });
    expect(env.settings.fastestLapSearchDelayMs()).toBe(250);
    expect(env.settings.replayJumpPlayback()).toBe("play");

    // The same closures read the settings of the moment, not those at configure time.
    getGlobalSettings.mockReturnValue({ fastestLapSearchDelayMs: 1000, replayJumpPlayback: "stopped" });
    expect(env.settings.fastestLapSearchDelayMs()).toBe(1000);
    expect(env.settings.replayJumpPlayback()).toBe("stopped");
  });

  it("reaches the SDK commands only when the engine asks", () => {
    const replay = { name: "replay surface" };
    const camera = { name: "camera surface" };
    getCommands.mockReturnValue({ replay, camera });

    initReplay(fakeCore().core);

    expect(getCommands).not.toHaveBeenCalled();
    const env = configuredEnv();

    expect(env.replay()).toBe(replay);
    expect(getCommands).toHaveBeenCalledTimes(1);
    expect(env.camera()).toBe(camera);
    expect(getCommands).toHaveBeenCalledTimes(2);
  });

  it("creates the replay store, flushes it on exit and hands each replay record event to its section (#1203, #1354, #1426)", () => {
    const store = {
      laps: {
        recordLapStart: () => callLog.push("laps.recordLapStart"),
        recordLapTime: () => callLog.push("laps.recordLapTime"),
      },
      greens: { record: () => callLog.push("greens.record") },
      sessions: { record: () => callLog.push("sessions.record") },
      incidents: { record: () => callLog.push("incidents.record") },
      flushSync: () => callLog.push("flushSync"),
    };
    implement("initializeReplaySessionStore", () => store);
    const { core, handlers } = fakeCore();

    const replay = initReplay(core);

    expect(replay).toEqual({ replayStore: store });

    for (const [event, call] of [
      ["replay.lapStarted", "laps.recordLapStart"],
      ["replay.lapTimed", "laps.recordLapTime"],
      ["replay.greenFlag", "greens.record"],
      ["replay.sessionStarted", "sessions.record"],
      ["replay.incident", "incidents.record"],
    ]) {
      callLog.length = 0;
      handlers.get(event)?.({ data: {} });

      expect(callLog, event).toEqual([call]);
    }

    // The exit flush: one new "exit" listener, and it flushes the store synchronously.
    const added = process.listeners("exit").filter((l) => !exitListenersBefore.has(l));
    expect(added).toHaveLength(1);
    callLog.length = 0;
    (added[0] as () => void)();
    expect(callLog).toEqual(["flushSync"]);
  });
});
