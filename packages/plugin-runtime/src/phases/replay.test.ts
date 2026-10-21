import type { ReplayEngineEnv } from "@iracedeck/replay-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

function fakeCore() {
  const logger = { name: "replay engine logger" };
  const createLogger = vi.fn(() => logger);
  const controller = { name: "controller" };
  const core = { controller, adapter: { createLogger } } as unknown as Core;

  return { core, controller, createLogger, logger };
}

/** The env `initReplay` handed the engine. */
function configuredEnv(): ReplayEngineEnv {
  expect(configureReplayEngine).toHaveBeenCalledTimes(1);

  return configureReplayEngine.mock.calls[0][0];
}

describe("initReplay (#1467)", () => {
  beforeEach(() => vi.clearAllMocks());

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
});
