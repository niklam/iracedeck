import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getReplayGateRecord, pressReplayCommand } from "./replay-command-gate.js";
import { fakeReplay } from "./replay-command-gate.test-support.js";
import { claimReplayCursor, currentReplayCursorOwner } from "./replay-cursor.js";
import { _configureReplayEngine, engineEnv } from "./replay-engine-env.js";
import { _resetReplayEngine } from "./replay-engine-reset.js";
import { pendingReplayTarget } from "./replay-position-state.js";
import { pendingReplaySearch, queueReplaySearch } from "./replay-search-queue.js";

describe("_resetReplayEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    _resetReplayEngine();
    vi.useRealTimers();
  });

  it("ends what is under way in every module and leaves the engine unconfigured", async () => {
    const sim = fakeReplay({ frame: 2_000, searches: { nextLap: (from) => from + 3_000 } });

    _configureReplayEngine({
      replay: () => sim.replay,
      readTelemetry: () => sim.telemetry(),
      inReplay: () => true,
      connected: () => true,
    });
    pressReplayCommand({ kind: "jump", frame: 90_000 }, { by: "test", origin: "key" });
    queueReplaySearch({ target: "lap", ticks: 3, origin: "dial", owner: "replay-control-dial lap" });
    await vi.advanceTimersByTimeAsync(10);

    expect(pendingReplayTarget()).not.toBeNull();
    expect(pendingReplaySearch()).not.toBeNull();

    _resetReplayEngine();

    expect(pendingReplaySearch()).toBeNull();
    expect(pendingReplayTarget()).toBeNull();
    expect(currentReplayCursorOwner()).toBeNull();
    expect(getReplayGateRecord()).toMatchObject({ busySince: null, search: null, jump: null, waiting: null });
    expect(engineEnv().controller).toBeNull();
    expect(() => engineEnv().replay()).toThrow("replay engine not configured");
  });

  it("clears a cursor claim nothing else holds", () => {
    claimReplayCursor("test owner");

    _resetReplayEngine();

    expect(currentReplayCursorOwner()).toBeNull();
  });
});
