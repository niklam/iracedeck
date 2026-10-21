import { getCommands } from "@iracedeck/deck-iracing";
import { ReplayPosMode, replaySpeedToSdk, type TelemetryData } from "@iracedeck/iracing-sdk";
import {
  _resetReplayCursor,
  _resetReplayPositionState,
  cancelReplayCursorOwner,
  claimReplayCursor,
  currentReplayCursorOwner,
  pendingReplayJumpSpeed,
  pendingReplayTarget,
} from "@iracedeck/replay-engine";
import { steppedReplayState, type SteppedReplayState } from "@iracedeck/replay-engine/testing";
import { type ReplayMarker, type ReplaySessionStore } from "@iracedeck/replay-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _configureReplayCommandGate,
  _resetReplayCommandGate,
  pressReplayCommand,
} from "../../shared/replay-command-gate.js";
import { describeReplayJump, type ReplayJumpOutcome } from "../../shared/replay-jump-playback.js";
import {
  followMarkerJump,
  jumpToMarkerFrame,
  markerIndexAt,
  previewAddMarker,
  readReplayContext,
  REPLAY_EXIT_GRACE_MS,
  type ReplayContext,
  type ReplayContextSource,
  resolveJumpTarget,
  resolveMarkerJumpAnchor,
  walkMarkers,
} from "./replay-markers-ops.js";

const { mockGetGlobalSettings } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn((): Record<string, unknown> => ({})),
}));

vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: vi.fn(),
}));

vi.mock("@iracedeck/settings", () => ({
  getGlobalSettings: mockGetGlobalSettings,
}));

vi.mock("@iracedeck/replay-store", () => ({
  MARKER_DEDUPE_FRAMES: 60,
  MARKER_DELETE_WINDOW_FRAMES: 600,
  MARKER_NEXT_MIN_AHEAD_FRAMES: 60,
  MARKER_PREVIOUS_MIN_BEHIND_FRAMES: 120,
}));

function markers(...frames: number[]): ReplayMarker[] {
  return frames.map((frame) => ({ frame, sessionNum: 0, sessionTimeMs: 0 }));
}

describe("walkMarkers", () => {
  const list = markers(1_000, 2_000, 3_000, 4_000);
  const at = (frame: number) => list.find((m) => m.frame === frame)!;

  it("one step is the first target itself", () => {
    expect(walkMarkers(list, at(2_000), "next", 1).frame).toBe(2_000);
  });

  it("walks forward and back from the first target", () => {
    expect(walkMarkers(list, at(2_000), "next", 3).frame).toBe(4_000);
    expect(walkMarkers(list, at(3_000), "previous", 2).frame).toBe(2_000);
  });

  it("stops at either end without wrapping", () => {
    expect(walkMarkers(list, at(2_000), "next", 99).frame).toBe(4_000);
    expect(walkMarkers(list, at(2_000), "previous", 99).frame).toBe(1_000);
  });

  it("a first target missing from the list is returned as is", () => {
    const stray = { frame: 9_999, sessionNum: 0, sessionTimeMs: 0 };

    expect(walkMarkers(list, stray, "next", 3)).toBe(stray);
  });
});

describe("markerIndexAt", () => {
  const list = markers(1_000, 2_000);

  it("names the marker at the frame or up to 120 frames past it", () => {
    expect(markerIndexAt(list, 2_000)).toBe(1);
    expect(markerIndexAt(list, 2_120)).toBe(1);
    expect(markerIndexAt(list, 1_050)).toBe(0);
  });

  it("is -1 past the window, before the first marker, and with no markers", () => {
    expect(markerIndexAt(list, 2_121)).toBe(-1);
    expect(markerIndexAt(list, 999)).toBe(-1);
    expect(markerIndexAt([], 1_000)).toBe(-1);
  });
});

describe("resolveJumpTarget", () => {
  function context(telemetry: Partial<TelemetryData>): ReplayContext {
    // Walked by the shared rule: from 3 000 Next is 5 000, from 4 200 Previous is 1 000.
    const list = vi.fn(() => markers(1_000, 5_000));

    return {
      ok: true,
      telemetry: telemetry as TelemetryData,
      inReplay: telemetry.IsReplayPlaying === true,
      frame: 3_000,
      store: { markers: { list } } as unknown as ReplaySessionStore,
      scope: { subSessionId: 7 },
    };
  }

  it("walks the store's markers by the shared rule from the given frame, scoped", () => {
    const ctx = context({ IsReplayPlaying: true });

    expect(resolveJumpTarget("next", ctx)?.frame).toBe(5_000);
    expect(resolveJumpTarget("previous", ctx, 4_200)?.frame).toBe(1_000);
    // From 5 100, within Previous's window of 5 000, the one before; from 5 121, 5 000 itself.
    expect(resolveJumpTarget("previous", ctx, 5_100)?.frame).toBe(1_000);
    expect(resolveJumpTarget("previous", ctx, 5_121)?.frame).toBe(5_000);
    // From 4 940, 5 000 is not more than 60 frames ahead.
    expect(resolveJumpTarget("next", ctx, 4_940)).toBeNull();
    expect(ctx.store.markers.list).toHaveBeenCalledWith({ subSessionId: 7 });
  });

  it("is null out of a replay without asking the store", () => {
    const ctx = context({ IsReplayPlaying: false });

    expect(resolveJumpTarget("next", ctx)).toBeNull();
    expect(resolveJumpTarget("previous", ctx)).toBeNull();
    expect(ctx.store.markers.list).not.toHaveBeenCalled();
  });
});

describe("the replay state survives the post-seek blip (#1230, read from the controller since #1324)", () => {
  /** A replay at `frame`; `ReplayFrameNumEnd` is the frames LEFT, never a position. */
  const replayAt = (frame: number) =>
    ({ IsReplayPlaying: true, ReplayFrameNum: frame, ReplayFrameNumEnd: 90_000 }) as TelemetryData;
  /** What telemetry reads for ~300 ms after a `setPlayPosition`, and what it reads from the car. */
  const notPlaying = { IsReplayPlaying: false, ReplayFrameNum: 0, ReplayFrameNumEnd: 90_000 } as TelemetryData;
  const store = {
    // From the held 4 000 Next is 5 000; from the blip's frame 0 it would be 1 000.
    markers: { list: vi.fn(() => markers(1_000, 5_000)) },
  } as unknown as ReplaySessionStore;
  let telemetry: TelemetryData = notPlaying;
  let sessionInfo: unknown = null;
  /** The controller's state, stepped with the real rule by every read. */
  let replay: SteppedReplayState;
  const source: ReplayContextSource = {
    getConnectionStatus: () => true,
    getCurrentTelemetry: () => telemetry,
    getSessionInfo: () => sessionInfo,
    getReplayState: (nowMs) => replay.getReplayState(nowMs),
    isStoreInitialized: () => true,
    getStore: () => store,
  };
  const SAVED_REPLAY = { WeekendInfo: { SimMode: "replay" } };

  function read(t: TelemetryData, nowMs: number): ReplayContext {
    telemetry = t;
    const context = readReplayContext(source, nowMs);

    if (!context.ok) throw new Error(context.reason);

    return context;
  }

  beforeEach(() => {
    _resetReplayCursor();
    sessionInfo = null;
    replay = steppedReplayState(
      () => telemetry,
      () => sessionInfo,
    );
  });

  it("a false read under the grace is still the replay, at the last replay frame seen", () => {
    expect(read(replayAt(4_000), 10_000)).toMatchObject({ inReplay: true, frame: 4_000 });

    expect(read(notPlaying, 10_300)).toMatchObject({ inReplay: true, frame: 4_000 });
    expect(read(notPlaying, 10_000 + REPLAY_EXIT_GRACE_MS - 1)).toMatchObject({ inReplay: true, frame: 4_000 });
  });

  it("a jump is still available in the grace, measured from the held frame", () => {
    read(replayAt(4_000), 10_000);
    const context = read(notPlaying, 10_300);

    expect(resolveJumpTarget("next", context)?.frame).toBe(5_000);
    expect(store.markers.list).toHaveBeenLastCalledWith(undefined);
  });

  it("false for the whole grace is the car: live, at the live edge", () => {
    read(replayAt(4_000), 10_000);
    read(notPlaying, 10_300);

    const context = read(notPlaying, 10_000 + REPLAY_EXIT_GRACE_MS);

    expect(context).toMatchObject({ inReplay: false, frame: 90_000 });
    expect(resolveJumpTarget("next", context)).toBeNull();
  });

  it("the grace runs from the LAST replay read, so a blip after every jump never adds up", () => {
    read(replayAt(4_000), 10_000);
    read(notPlaying, 10_500);
    read(replayAt(4_100), 10_600);

    expect(read(notPlaying, 11_500)).toMatchObject({ inReplay: true, frame: 4_100 });
  });

  it("never in a replay: live from the first read", () => {
    expect(read(notPlaying, 10_000)).toMatchObject({ inReplay: false, frame: 90_000 });
  });

  it("re-entering a replay is immediate", () => {
    read(replayAt(4_000), 10_000);
    read(notPlaying, 12_000);

    expect(read(replayAt(7_000), 12_010)).toMatchObject({ inReplay: true, frame: 7_000 });
  });

  it("a jump to live ends the grace: the next false read is the car at once, at the live edge", () => {
    read(replayAt(4_000), 10_000);
    replay.noteReplayLeftForLive(10_010);

    expect(read(notPlaying, 10_050)).toMatchObject({ inReplay: false, frame: 90_000 });
  });

  it("a replay read straight after a jump to live, before iRacing switches, does not revive the old frame", () => {
    read(replayAt(4_000), 10_000);
    replay.noteReplayLeftForLive(10_010);
    // The command lands a tick later: this read still shows the old replay position.
    expect(read(replayAt(4_000), 10_016)).toMatchObject({ inReplay: true, frame: 4_000 });

    expect(read(notPlaying, 10_050)).toMatchObject({ inReplay: false, frame: 90_000 });
  });

  it("in a saved replay a jump to the end keeps the grace: the post-seek blip is still the replay", () => {
    sessionInfo = SAVED_REPLAY;
    read(replayAt(4_000), 10_000);
    replay.noteReplayLeftForLive(10_010);

    expect(read(notPlaying, 10_050)).toMatchObject({ inReplay: true, frame: 4_000 });
  });

  it("a saved replay is never the car, whatever the flag reads past the grace", () => {
    sessionInfo = SAVED_REPLAY;
    read(replayAt(4_000), 10_000);

    expect(read({ ...notPlaying, ReplayFrameNum: 4_000 }, 10_000 + REPLAY_EXIT_GRACE_MS)).toMatchObject({
      inReplay: true,
      frame: 4_000,
    });
  });

  it("no usable frame on the controller is no context", () => {
    telemetry = { IsReplayPlaying: true } as TelemetryData;

    expect(readReplayContext(source, 10_000)).toEqual({ ok: false, reason: "No replay frame in telemetry" });
  });

  it("a replay left for the car stays left: the old frame is not revived later", () => {
    read(replayAt(4_000), 10_000);
    read(notPlaying, 11_000);

    expect(read(notPlaying, 11_010)).toMatchObject({ inReplay: false, frame: 90_000 });
  });
});

/** A replay speed as telemetry reports it. */
interface SimSpeed {
  ReplayPlaySpeed: number;
  ReplayPlaySlowMotion: boolean;
}

const PAUSED: SimSpeed = { ReplayPlaySpeed: 0, ReplayPlaySlowMotion: false };
const AT_1X: SimSpeed = { ReplayPlaySpeed: 1, ReplayPlaySlowMotion: false };

/** The clock the jump suites start at. */
const PRESS_AT = 10_000;

/**
 * A sim that acts on a replay command only at a later update, `lagMs` on — the
 * shape that makes waiting for the pause and for the landing matter. `calls`
 * is every command in the order it was sent. A refused command returns false;
 * an ignored one is accepted and never shows. Installs itself as
 * `getCommands().replay`, and as the replay the command gate reads (#1430).
 */
function fakeSim(speed: SimSpeed, options: { lagMs?: number; seekLagMs?: number } = {}) {
  const lagMs = options.lagMs ?? 20;
  const seekLagMs = options.seekLagMs ?? lagMs;
  let telemetry = { IsReplayPlaying: true, ReplayFrameNum: 500, ...speed } as TelemetryData;
  const calls: string[] = [];
  const refuse = { speed: false, seek: false };
  const ignore = { speed: false, seek: false };

  const setPlaySpeed = vi.fn((value: number, slowMotion: boolean = false): boolean => {
    calls.push(`speed ${value}${slowMotion ? " slow" : ""}`);

    if (refuse.speed) return false;

    if (!ignore.speed) {
      setTimeout(() => {
        telemetry = {
          ...telemetry,
          ReplayPlaySpeed: replaySpeedToSdk(value, slowMotion),
          ReplayPlaySlowMotion: slowMotion,
        };
      }, lagMs);
    }

    return true;
  });
  const replay = {
    setPlaySpeed,
    // The SDK's pause() is setPlaySpeed(0), and the gate sends it as one.
    pause: vi.fn((): boolean => setPlaySpeed(0)),
    setPlayPosition: vi.fn((_mode: ReplayPosMode, frame: number): boolean => {
      calls.push(`seek ${frame}`);

      if (refuse.seek) return false;

      if (!ignore.seek) {
        setTimeout(() => {
          telemetry = { ...telemetry, ReplayFrameNum: frame };
        }, seekLagMs);
      }

      return true;
    }),
  };

  vi.mocked(getCommands).mockReturnValue({ replay } as never);
  _configureReplayCommandGate({ readTelemetry: () => telemetry, inReplay: () => true });

  return {
    replay,
    calls,
    refuse,
    ignore,
    read: (): TelemetryData => telemetry,
    moveTo(frame: number): void {
      telemetry = { ...telemetry, ReplayFrameNum: frame };
    },
  };
}

/** Runs the clock until a jump has ended, and returns how. */
async function settled(jump: Promise<ReplayJumpOutcome>, ms = 5_000): Promise<ReplayJumpOutcome> {
  await vi.advanceTimersByTimeAsync(ms);

  return jump;
}

function resetJumpState(): void {
  _resetReplayCursor();
  _resetReplayCommandGate();
  _resetReplayPositionState();
  vi.useFakeTimers({ now: PRESS_AT });
  mockGetGlobalSettings.mockReset().mockReturnValue({});
  vi.mocked(getCommands).mockReset();
}

describe("the replay's pending target is the anchor (#1230, #1430)", () => {
  beforeEach(resetJumpState);

  afterEach(() => {
    _resetReplayCommandGate();
    vi.useRealTimers();
  });

  it("a jump records its marker as the target at the press", () => {
    const sim = fakeSim(PAUSED);

    void jumpToMarkerFrame("next", 4_000, sim.read);

    expect(sim.replay.setPlayPosition).toHaveBeenCalledExactlyOnceWith(ReplayPosMode.Begin, 4_000);
    expect(pendingReplayTarget()).toMatchObject({ frame: 4_000 });
    expect(resolveMarkerJumpAnchor(500, sim.read())).toBe(4_000);
  });

  it("a moving replay's jump anchors on its marker before its seek goes out", () => {
    const sim = fakeSim(AT_1X);

    void jumpToMarkerFrame("dial-next", 4_000, sim.read);

    // Only the pause is out; the next detent already measures from the marker.
    expect(sim.calls).toEqual(["speed 0"]);
    expect(resolveMarkerJumpAnchor(500, sim.read())).toBe(4_000);
  });

  it("a jump still seeking anchors on its marker however long it takes", async () => {
    const sim = fakeSim(PAUSED);

    sim.ignore.seek = true;
    void jumpToMarkerFrame("dial-next", 4_000, sim.read);
    await vi.advanceTimersByTimeAsync(2_500);

    expect(resolveMarkerJumpAnchor(500, sim.read())).toBe(4_000);
  });

  it("the anchor is the live frame once the target has read back, so a later drift cannot revive it", async () => {
    const sim = fakeSim(PAUSED);

    await settled(jumpToMarkerFrame("next", 4_000, sim.read), 200);

    expect(resolveMarkerJumpAnchor(4_000, sim.read())).toBe(4_000);
    expect(pendingReplayTarget()).toBeNull();

    sim.moveTo(4_500);

    expect(resolveMarkerJumpAnchor(4_500, sim.read())).toBe(4_500);
  });

  it("any surface's jump is the anchor, a dial's frame move included: the replay is headed there", () => {
    const sim = fakeSim(PAUSED);

    pressReplayCommand({ kind: "jump", frame: 9_000 }, { by: "dial-frame-jog" });

    expect(resolveMarkerJumpAnchor(500, sim.read())).toBe(9_000);
  });

  it("a cursor take by a key that sends no replay command leaves a sent target standing", () => {
    const sim = fakeSim(PAUSED);

    void jumpToMarkerFrame("next", 4_000, sim.read);
    cancelReplayCursorOwner("jump-to-my-car");

    expect(resolveMarkerJumpAnchor(500, sim.read())).toBe(4_000);
  });

  it("a jump that was not sent leaves no target, whatever stood before it", async () => {
    // The first jump's seek is out and has not landed when the second is pressed.
    const sim = fakeSim(PAUSED, { seekLagMs: 400 });
    const first = jumpToMarkerFrame("dial-next", 2_000, sim.read);

    await vi.advanceTimersByTimeAsync(100);
    sim.refuse.seek = true;

    await expect(jumpToMarkerFrame("next", 4_000, sim.read)).resolves.toMatchObject({
      kind: "stopped",
      reason: "seek-failed",
    });

    expect(pendingReplayTarget()).toBeNull();
    expect(resolveMarkerJumpAnchor(500, sim.read())).toBe(500);
    await expect(settled(first)).resolves.toEqual({ kind: "cancelled", by: "next" });
  });
});

describe("jumpToMarkerFrame runs the shared jump sequence (#1276)", () => {
  beforeEach(resetJumpState);

  afterEach(() => {
    _resetReplayCommandGate();
    vi.useRealTimers();
  });

  it("a paused replay gets its seek within the call, and nothing else under Remember state", async () => {
    const sim = fakeSim(PAUSED);
    const jump = jumpToMarkerFrame("next", 4_000, sim.read);

    expect(sim.calls).toEqual(["seek 4000"]);
    expect(currentReplayCursorOwner()).toBe("next");

    await expect(settled(jump)).resolves.toEqual({
      kind: "landed",
      speed: { speed: 0, slowMotion: false },
      command: "none",
    });
    expect(sim.calls).toEqual(["seek 4000"]);
  });

  it("a moving replay pauses, seeks once the pause shows, and plays on under Remember state", async () => {
    const sim = fakeSim(AT_1X);
    const jump = jumpToMarkerFrame("dial-next", 4_000, sim.read);

    await expect(settled(jump)).resolves.toEqual({
      kind: "landed",
      speed: { speed: 1, slowMotion: false },
      command: "sent",
    });
    expect(sim.calls).toEqual(["speed 0", "seek 4000", "speed 1"]);
  });

  it("takes the cursor from whatever held it before anything is sent", () => {
    const sim = fakeSim(AT_1X);
    const sentAtCancel: number[] = [];

    claimReplayCursor("jump-to-fastest-lap", () => sentAtCancel.push(sim.calls.length));
    void jumpToMarkerFrame("next", 4_000, sim.read);

    expect(sentAtCancel).toEqual([0]);
    expect(currentReplayCursorOwner()).toBe("next");
  });

  it("carries the press's origin token into the gate's view", () => {
    const sim = fakeSim(PAUSED);

    void jumpToMarkerFrame("next", 4_000, sim.read, PRESS_AT, "marker-key");

    expect(pendingReplayTarget()).toMatchObject({ frame: 4_000, origin: "marker-key" });
  });

  describe("a jump that stopped short before its seek went out clears the target it recorded", () => {
    type Sim = ReturnType<typeof fakeSim>;

    const stops: Array<[string, SimSpeed, (sim: Sim) => void]> = [
      ["pause-failed", AT_1X, (sim) => (sim.refuse.speed = true)],
      ["pause-timeout", AT_1X, (sim) => (sim.ignore.speed = true)],
      ["seek-failed", PAUSED, (sim) => (sim.refuse.seek = true)],
    ];

    it.each(stops)("%s", async (reason, speed, breakIt) => {
      const sim = fakeSim(speed);

      breakIt(sim);

      const jump = jumpToMarkerFrame("next", 4_000, sim.read);

      // While the jump is under way its own target anchors; a refused seek on a paused replay
      // has stopped within the call.
      if (reason !== "seek-failed") expect(pendingReplayTarget()).toMatchObject({ frame: 4_000 });

      await expect(settled(jump)).resolves.toMatchObject({ kind: "stopped", reason });
      expect(pendingReplayTarget()).toBeNull();
    });

    it("leaves a later jump's target alone, also one for the same frame", async () => {
      const sim = fakeSim(PAUSED);

      // Both pressed before the first has had the chance to clear its target.
      sim.refuse.seek = true;
      const first = jumpToMarkerFrame("next", 4_000, sim.read);

      sim.refuse.seek = false;
      const second = jumpToMarkerFrame("dial-next", 4_000, sim.read);

      await expect(first).resolves.toMatchObject({ kind: "stopped", reason: "seek-failed" });
      expect(pendingReplayTarget()).toMatchObject({ frame: 4_000 });
      await expect(settled(second)).resolves.toMatchObject({ kind: "landed" });
    });
  });

  it("a seek that never lands leaves its target to its own wait, which gives it up", async () => {
    const sim = fakeSim(PAUSED);

    sim.ignore.seek = true;

    await expect(settled(jumpToMarkerFrame("next", 4_000, sim.read))).resolves.toMatchObject({
      kind: "stopped",
      reason: "seek-timeout",
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(pendingReplayTarget()).toBeNull();
  });

  it("a key's Play during the jump waits for the landing and goes out once", async () => {
    const sim = fakeSim(PAUSED, { seekLagMs: 400 });
    const jump = jumpToMarkerFrame("next", 4_000, sim.read);

    await vi.advanceTimersByTimeAsync(100);
    expect(
      pressReplayCommand({ kind: "speed", speed: 1, slowMotion: false }, { by: "play-pause", origin: "key" }),
    ).toEqual({ kind: "held" });

    await expect(settled(jump)).resolves.toEqual({ kind: "cancelled", by: "play-pause" });
    expect(sim.calls).toEqual(["seek 4000", "speed 1"]);
  });

  describe("hands the cursor back, and drops the speed it captured, however it ended", () => {
    it("landed: the speed it applied stands for the next jump", async () => {
      const sim = fakeSim(AT_1X);

      await expect(settled(jumpToMarkerFrame("next", 4_000, sim.read), 150)).resolves.toMatchObject({ kind: "landed" });

      expect(currentReplayCursorOwner()).toBeNull();
      expect(pendingReplayJumpSpeed()).toMatchObject({ speed: 1, slowMotion: false, appliedAt: expect.any(Number) });
    });

    it("stopped short: the speed it captured does not outlive it", async () => {
      const sim = fakeSim(AT_1X);

      sim.ignore.seek = true;

      await expect(settled(jumpToMarkerFrame("next", 4_000, sim.read))).resolves.toMatchObject({ kind: "stopped" });

      expect(currentReplayCursorOwner()).toBeNull();
      expect(pendingReplayJumpSpeed()).toBeNull();
    });

    it("a command that throws is a command refused: the jump stops, and its target goes", async () => {
      const sim = fakeSim(PAUSED);

      sim.replay.setPlayPosition.mockImplementation(() => {
        throw new Error("broadcast failed");
      });

      await expect(jumpToMarkerFrame("next", 4_000, sim.read)).resolves.toMatchObject({
        kind: "stopped",
        reason: "seek-failed",
      });
      expect(currentReplayCursorOwner()).toBeNull();
      expect(pendingReplayJumpSpeed()).toBeNull();
      expect(pendingReplayTarget()).toBeNull();
    });
  });

  it("with no replay commands to send through, stops with nothing sent and leaves no target", async () => {
    vi.mocked(getCommands).mockImplementation(() => {
      throw new Error("SDK not initialized");
    });

    await expect(jumpToMarkerFrame("next", 4_000, () => null)).resolves.toMatchObject({ kind: "stopped" });

    expect(currentReplayCursorOwner()).toBeNull();
    expect(pendingReplayTarget()).toBeNull();
  });
});

describe("followMarkerJump", () => {
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const stopped: ReplayJumpOutcome = { kind: "stopped", reason: "seek-timeout", telemetry: null };
  const cancelled: ReplayJumpOutcome = { kind: "cancelled", by: "play-pause" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a jump that stopped short is a warning and the details at debug, in the shared wording, led by the surface's name", async () => {
    followMarkerJump(logger, "next marker", 4_000, Promise.resolve(stopped));
    await Promise.resolve();

    const report = describeReplayJump(stopped, 4_000);

    expect(report.warn).not.toBeNull();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(`next marker: ${report.warn}`);
    expect(logger.debug).toHaveBeenCalledExactlyOnceWith(`next marker: ${report.detail}`);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("a jump with nothing wrong is the details at debug only", async () => {
    followMarkerJump(logger, "Dial previous marker", 4_000, Promise.resolve(cancelled));
    await Promise.resolve();

    expect(logger.debug).toHaveBeenCalledExactlyOnceWith(
      `Dial previous marker: ${describeReplayJump(cancelled, 4_000).detail}`,
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("a rejection is caught and logged as an error", async () => {
    followMarkerJump(logger, "next marker", 4_000, Promise.reject(new Error("broadcast failed")));
    await Promise.resolve();

    expect(logger.error).toHaveBeenCalledExactlyOnceWith("next marker: jump failed: Error: broadcast failed");
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });
});

describe("previewAddMarker", () => {
  function context(active: { subSessionId: number } | null, scope?: { subSessionId: number }): ReplayContext {
    return {
      ok: true,
      telemetry: {
        IsReplayPlaying: true,
        ReplayFrameNum: 3_000,
        ReplaySessionNum: 1,
        ReplaySessionTime: 50,
      } as TelemetryData,
      inReplay: true,
      frame: 3_000,
      store: {
        markers: { list: () => markers(1_000) },
        getActiveSession: () => active,
      } as unknown as ReplaySessionStore,
      scope,
    };
  }

  it("names the marker an Add would store", () => {
    expect(previewAddMarker(context({ subSessionId: 7 }, { subSessionId: 7 }), 5)?.frame).toBe(2_700);
    expect(previewAddMarker(context({ subSessionId: 7 }), 5)?.frame).toBe(2_700);
  });

  it("is null with no active record, since the store would refuse the Add", () => {
    expect(previewAddMarker(context(null, { subSessionId: 7 }), 5)).toBeNull();
    expect(previewAddMarker(context(null), 5)).toBeNull();
  });

  it("is null when the active record is another session's", () => {
    expect(previewAddMarker(context({ subSessionId: 8 }, { subSessionId: 7 }), 5)).toBeNull();
  });

  it("is null for a duplicate", () => {
    expect(previewAddMarker(context({ subSessionId: 7 }, { subSessionId: 7 }), 33)).toBeNull();
  });

  it("refuses exactly where the store does: 60 frames away is a duplicate, 61 is not", () => {
    const base = context({ subSessionId: 7 }, { subSessionId: 7 });

    expect(previewAddMarker({ ...base, frame: 1_060 }, 0)).toBeNull();
    expect(previewAddMarker({ ...base, frame: 1_061 }, 0)?.frame).toBe(1_061);
  });
});
