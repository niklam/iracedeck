import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pressReplayCommand } from "./replay-command-gate.js";
import { fakeReplay, type FakeReplay } from "./replay-command-gate.test-support.js";
import { resetEngine } from "./replay-engine-reset.test-support.js";
import { type ReplaySpeed } from "./replay-jump-speed.js";
import { noteReplaySpeedSent } from "./replay-speed-state.js";
import { shownReplaySpeed } from "./replay-speed-view.js";

function speed(value: number, slowMotion = false): ReplaySpeed {
  return { speed: value, slowMotion };
}

let sim: FakeReplay;

function setUp(): void {
  sim = fakeReplay({ frame: 2_000 });
  resetEngine({
    replay: () => sim.replay,
    readTelemetry: () => sim.telemetry(),
    inReplay: () => true,
    connected: () => true,
    now: () => Date.now(),
  });
}

describe("shownReplaySpeed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    setUp();
  });

  afterEach(() => {
    resetEngine();
    vi.useRealTimers();
  });

  it("shows the waiting speed while the gate holds one", () => {
    // A jump far across the tape is under way: a speed pressed now waits for its landing.
    pressReplayCommand({ kind: "jump", frame: 160_000 }, { by: "marker" });

    expect(pressReplayCommand({ kind: "speed", speed: 4, slowMotion: false }, { by: "fast-forward" })).toEqual({
      kind: "held",
    });

    expect(shownReplaySpeed(null, Date.now())).toEqual(speed(4));
    expect(shownReplaySpeed(speed(1), Date.now())).toEqual(speed(4));
  });

  it("falls back to the live speed", () => {
    expect(shownReplaySpeed(speed(2), Date.now())).toEqual(speed(2));
    expect(shownReplaySpeed(null, Date.now())).toEqual(speed(0));

    noteReplaySpeedSent(speed(8), Date.now(), { rememberSpeed: false });

    expect(shownReplaySpeed(speed(2), Date.now() + 10)).toEqual(speed(8));
  });
});
