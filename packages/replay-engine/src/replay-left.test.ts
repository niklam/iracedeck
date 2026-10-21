import { REPLAY_EXIT_GRACE_MS, type TelemetryData } from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FASTEST_LAP_WALK_OWNER, RACE_START_WALK_OWNER } from "./lap-walk-owners.js";
import { claimReplayCursor } from "./replay-cursor.js";
import { configureReplayEngine } from "./replay-engine-configure.js";
import type { ReplayEngineController, ReplayEngineEnv } from "./replay-engine-env.js";
import { resetEngine } from "./replay-engine-reset.test-support.js";
import { onReplayLeft, type ReplayLeftReason } from "./replay-left.js";
import { replayLeftController, type WatchedReplayController, watchReplayLeft } from "./replay-left.test-support.js";
import {
  clearReplayTarget,
  pendingReplayTarget,
  recordReplayTarget,
  REPLAY_TARGET_GIVE_UP_MS,
} from "./replay-position-state.js";
import { steppedReplayState } from "./replay-state.test-support.js";

/** A replay on screen, paused on frame 1000. */
const REPLAY = { IsReplayPlaying: true, ReplayFrameNum: 1_000, ReplayPlaySpeed: 0 } as TelemetryData;
/** Back in the car: out of the replay, and no seek, since a driver is on track. */
const DRIVING = { IsReplayPlaying: false, IsOnTrack: true, ReplayFrameNum: 0 } as TelemetryData;
/** What a seek under way reads like: out of the replay, nobody driving. */
const SEEKING = { IsReplayPlaying: false, IsOnTrack: false, ReplayFrameNum: 0 } as TelemetryData;

/** A jump this far reads back only after more than three seconds of its own wait. */
const FAR_FRAME = 401_000;

let telemetry: TelemetryData | null;
let events: ReplayLeftReason[];
let stopListening: () => void;

/** The watch over a live session's debounced replay state, stepped from {@link telemetry}. */
function watchLiveSession(): WatchedReplayController {
  const state = steppedReplayState(() => telemetry);

  return watchReplayLeft({ replayState: () => state.getReplayState(), telemetry: () => telemetry });
}

/** Ticks `w` every 50 ms for `ms`, as the controller's poll would. */
async function tickFor(w: WatchedReplayController, ms: number): Promise<void> {
  for (let waited = 0; waited < ms; waited += 50) {
    await vi.advanceTimersByTimeAsync(50);
    w.tick();
  }
}

function engineOver(controller: ReplayEngineController): ReplayEngineEnv {
  return {
    controller,
    replay: () => {
      throw new Error("no replay surface in this test");
    },
    camera: () => {
      throw new Error("no camera surface in this test");
    },
    now: () => Date.now(),
    logger: silentLogger,
    settings: { replayJumpPlayback: () => undefined, fastestLapSearchDelayMs: () => undefined },
  };
}

describe("replayLeft (#1467)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    resetEngine();
    telemetry = REPLAY;
    events = [];
    stopListening = onReplayLeft((event) => events.push(event.reason));
  });

  afterEach(() => {
    stopListening();
    resetEngine();
    vi.useRealTimers();
  });

  it("emits left on the debounced exit edge", async () => {
    const w = watchLiveSession();

    telemetry = DRIVING;
    w.tick();
    await vi.advanceTimersByTimeAsync(REPLAY_EXIT_GRACE_MS - 1);
    w.tick();

    expect(events).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    w.tick();

    expect(events).toEqual(["left"]);

    await tickFor(w, 5_000);

    expect(events).toEqual(["left"]);
  });

  it("a replay blip inside the grace window emits nothing", async () => {
    const w = watchLiveSession();

    telemetry = DRIVING;
    await tickFor(w, 700);
    telemetry = REPLAY;
    await tickFor(w, 5_000);

    expect(events).toEqual([]);
  });

  it("emits disconnected on a null tick after a connected one, once", () => {
    telemetry = null;
    const w = watchLiveSession();

    // Nothing was ever connected: a null tick is no departure.
    w.tick(null, false);

    expect(events).toEqual([]);

    telemetry = REPLAY;
    w.tick();
    w.tick(null, false);
    w.tick(null, false);

    expect(events).toEqual(["disconnected"]);

    // Connected again, telemetry gone with the connection still read up: a disconnect too.
    w.tick(REPLAY, true);
    w.tick(null, true);

    expect(events).toEqual(["disconnected", "disconnected"]);
  });

  it("configuring again replaces the watch", () => {
    let inReplay = true;
    const first = replayLeftController({ replayState: () => ({ inReplay }), telemetry: () => telemetry });
    const second = replayLeftController({ replayState: () => ({ inReplay }), telemetry: () => telemetry });

    configureReplayEngine(engineOver(first.controller));
    configureReplayEngine(engineOver(second.controller));

    expect(first.unsubscribe).toHaveBeenCalledWith("replay-engine");
    expect(second.subscribe).toHaveBeenCalledTimes(1);

    inReplay = false;
    telemetry = DRIVING;
    first.tick();
    second.tick();

    expect(events).toEqual(["left"]);
  });

  it("ends a lap walk's claim with replay-left and leaves the others", () => {
    let inReplay = true;
    const w = watchReplayLeft({ replayState: () => ({ inReplay }), telemetry: () => telemetry });
    const leaveAndComeBack = (): void => {
      inReplay = false;
      telemetry = DRIVING;
      w.tick();
      inReplay = true;
      telemetry = REPLAY;
      w.tick();
    };

    for (const owner of [FASTEST_LAP_WALK_OWNER, RACE_START_WALK_OWNER]) {
      const claim = claimReplayCursor(owner);

      leaveAndComeBack();

      expect(claim.cancelledBy).toBe("replay-left");
    }

    // A record jump keeps its claim and its own wait; a Jump to Live, which leaves on purpose, keeps whatever it holds.
    for (const owner of ["jump-to-fastest-lap record jump", "replay-control-jump-to-live"]) {
      const claim = claimReplayCursor(owner);

      leaveAndComeBack();

      expect(claim.cancelledBy).toBeNull();
      claim.release();
    }

    expect(events).toEqual(["left", "left", "left", "left"]);
  });

  describe("the edge held through the plugin's own seek", () => {
    it("an edge during the plugin's own long seek is held, and nothing is emitted when the target reads back", async () => {
      const w = watchLiveSession();

      recordReplayTarget(FAR_FRAME, REPLAY, Date.now());
      telemetry = SEEKING;
      // The grace runs out a second into the seek: the edge, held by the target.
      await tickFor(w, REPLAY_EXIT_GRACE_MS + 2_000);

      expect(events).toEqual([]);

      // The seek lands: the target reads back and the replay is on screen again.
      clearReplayTarget();
      telemetry = { ...REPLAY, ReplayFrameNum: FAR_FRAME } as TelemetryData;
      await tickFor(w, 20_000);

      expect(events).toEqual([]);
    });

    it("left is emitted once the standing target's own wait lapses with the state still false", async () => {
      const w = watchLiveSession();
      const target = recordReplayTarget(FAR_FRAME, REPLAY, Date.now());

      // The target's own wait, longer than the flat three seconds.
      expect(target.giveUpMs).toBeGreaterThan(REPLAY_TARGET_GIVE_UP_MS);

      telemetry = SEEKING;
      // The edge is the tick at which the grace has run out; the flat three seconds after it hold nothing up.
      await tickFor(w, REPLAY_EXIT_GRACE_MS);
      await tickFor(w, REPLAY_TARGET_GIVE_UP_MS + 50);

      expect(events).toEqual([]);

      await vi.advanceTimersByTimeAsync(target.giveUpMs - REPLAY_TARGET_GIVE_UP_MS - 50 - 1);
      w.tick();

      expect(events).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      w.tick();

      expect(events).toEqual(["left"]);
      expect(pendingReplayTarget()).not.toBeNull();
    });

    it("the hold lapses on its own timer when no tick comes", async () => {
      const w = watchLiveSession();
      const target = recordReplayTarget(FAR_FRAME, REPLAY, Date.now());

      telemetry = SEEKING;
      await tickFor(w, REPLAY_EXIT_GRACE_MS);
      // No more ticks: the sim may deliver none on a paused replay.
      await vi.advanceTimersByTimeAsync(target.giveUpMs - 1);

      expect(events).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);

      expect(events).toEqual(["left"]);
    });

    it("a seek showing without a target holds the edge for REPLAY_TARGET_GIVE_UP_MS", async () => {
      const w = watchLiveSession();

      telemetry = SEEKING;
      await tickFor(w, REPLAY_EXIT_GRACE_MS);
      await tickFor(w, REPLAY_TARGET_GIVE_UP_MS - 50);

      expect(events).toEqual([]);

      await tickFor(w, 50);

      expect(events).toEqual(["left"]);
    });

    it("a disconnect is not held", async () => {
      const w = watchLiveSession();

      recordReplayTarget(FAR_FRAME, REPLAY, Date.now());
      telemetry = SEEKING;
      await tickFor(w, REPLAY_EXIT_GRACE_MS + 500);
      w.tick(null, false);

      expect(events).toEqual(["disconnected"]);

      // The held departure went with the connection: nothing more comes of it.
      await vi.advanceTimersByTimeAsync(30_000);

      expect(events).toEqual(["disconnected"]);
    });
  });
});
