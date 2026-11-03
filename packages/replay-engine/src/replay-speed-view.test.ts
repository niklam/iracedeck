import { replaySpeedToSdk, type TelemetryData } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getReplayGateRecord, pressReplayCommand } from "./replay-command-gate.js";
import { fakeReplay, type FakeReplay } from "./replay-command-gate.test-support.js";
import { resetEngine } from "./replay-engine-reset.test-support.js";
import { type ReplaySpeed } from "./replay-jump-speed.js";
import { keepDialPendingSpeed } from "./replay-speed-state.js";
import { noteReplaySpeedSent } from "./replay-speed-state.test-support.js";
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

describe("shownReplaySpeed over the gate's sends (#1427)", () => {
  /** What telemetry reads: a replay at `speed`, on a frame that does not move. */
  let shows: ReplaySpeed;
  const replay = {
    setPlaySpeed: vi.fn((): boolean => true),
    pause: vi.fn((): boolean => true),
    play: vi.fn((): boolean => true),
    nextFrame: vi.fn((): boolean => true),
  };

  function reading(): TelemetryData {
    return {
      IsReplayPlaying: true,
      ReplayFrameNum: 2_000,
      ReplayFrameNumEnd: 100_000,
      ReplayPlaySpeed: replaySpeedToSdk(shows.speed, shows.slowMotion),
      ReplayPlaySlowMotion: shows.slowMotion,
    } as TelemetryData;
  }

  /** What a surface shows on a tick now. */
  function shown(): ReplaySpeed {
    return shownReplaySpeed(shows, Date.now());
  }

  /** A press as the dial makes it: its own take keeps what it sent. */
  function dial(command: Parameters<typeof pressReplayCommand>[0]): void {
    keepDialPendingSpeed(() => pressReplayCommand(command, { by: "dial", rememberSpeed: true }));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    shows = speed(1);
    resetEngine({
      replay: () => replay as never,
      readTelemetry: () => reading(),
      inReplay: () => true,
      connected: () => true,
      now: () => Date.now(),
    });
  });

  afterEach(() => {
    resetEngine();
    vi.useRealTimers();
  });

  it("playing 1x, 2x and then 1x before telemetry shows the 2x: the old 1x ticks do not settle the 1x", async () => {
    dial({ kind: "speed", speed: 2, slowMotion: false });
    await vi.advanceTimersByTimeAsync(10);
    dial({ kind: "speed", speed: 1, slowMotion: false });

    await vi.advanceTimersByTimeAsync(6);
    expect(shown()).toEqual(speed(1));

    // The 2x lands, the 1x is still to come: the next detent must step from 1x.
    shows = speed(2);
    await vi.advanceTimersByTimeAsync(17);
    expect(shown()).toEqual(speed(1));

    shows = speed(1);
    await vi.advanceTimersByTimeAsync(17);
    expect(shown()).toEqual(speed(1));

    // Settled: iRacing's own bar reads at once.
    shows = speed(8);
    expect(shown()).toEqual(speed(8));
  });

  it("a Play / Pause double press inside the lag: the old ticks do not settle the Play", async () => {
    dial({ kind: "pause" });
    await vi.advanceTimersByTimeAsync(10);
    dial({ kind: "speed", speed: 1, slowMotion: false });

    await vi.advanceTimersByTimeAsync(6);
    expect(shown()).toEqual(speed(1));

    // The pause shows first: the Play is still to come, and the next press is a pause, not a second Play.
    shows = speed(0);
    await vi.advanceTimersByTimeAsync(17);
    expect(shown()).toEqual(speed(1));

    shows = speed(1);
    await vi.advanceTimersByTimeAsync(17);
    expect(shown()).toEqual(speed(1));

    shows = speed(0);
    expect(shown()).toEqual(speed(0));
  });

  it("Play / Pause three times on a paused replay: the first Play landing does not settle the chain", async () => {
    shows = speed(0);
    dial({ kind: "speed", speed: 1, slowMotion: false });
    await vi.advanceTimersByTimeAsync(10);
    dial({ kind: "pause" });
    await vi.advanceTimersByTimeAsync(10);
    dial({ kind: "speed", speed: 1, slowMotion: false });

    // The first Play lands, then the pause: the last Play is still to come.
    shows = speed(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(shown()).toEqual(speed(1));

    shows = speed(0);
    await vi.advanceTimersByTimeAsync(17);
    expect(shown()).toEqual(speed(1));

    // The gate too: a Frame Forward now goes into a replay that is about to play, and records no target.
    pressReplayCommand({ kind: "step", direction: 1 }, { by: "next-frame" });
    expect(getReplayGateRecord().target).toBeNull();
  });

  it("a key's command right after a Play: the surfaces follow telemetry, the gate still sees the replay starting to move", () => {
    shows = speed(0);
    dial({ kind: "speed", speed: 1, slowMotion: false });

    // A Frame Forward key: its take supersedes the Play for the surfaces, and the step goes into a replay
    // the gate knows is starting to play, so it records no target.
    pressReplayCommand({ kind: "step", direction: 1 }, { by: "next-frame" });

    expect(getReplayGateRecord().target).toBeNull();
    expect(shown()).toEqual(speed(0));
  });
});
