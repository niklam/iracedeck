import { getCommands } from "@iracedeck/deck-iracing";
import { ReplayPosMode, replaySpeedToSdk, type TelemetryData } from "@iracedeck/iracing-sdk";
import { type ReplayMarker, type ReplaySessionStore } from "@iracedeck/replay-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetReplayCursor,
  cancelReplayCursorOwner,
  claimReplayCursor,
  currentReplayCursorOwner,
  pendingReplayJumpSpeed,
  pendingReplayLanding,
  recordReplayLanding,
} from "../../shared/replay-cursor.js";
import { describeReplayJump, type ReplayJumpOutcome } from "../../shared/replay-jump-playback.js";
import { steppedReplayState, type SteppedReplayState } from "../../shared/test-support/replay-state.js";
import {
  DIAL_LANDING_HOLD_MS,
  followMarkerJump,
  jumpToMarkerFrame,
  markerIndexAt,
  previewAddMarker,
  readReplayContext,
  REPLAY_EXIT_GRACE_MS,
  type ReplayContext,
  type ReplayContextSource,
  resolveAnchorFrame,
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
    const next = vi.fn(() => markers(5_000)[0]!);
    const previous = vi.fn(() => markers(1_000)[0]!);

    return {
      ok: true,
      telemetry: telemetry as TelemetryData,
      inReplay: telemetry.IsReplayPlaying === true,
      frame: 3_000,
      store: { markers: { next, previous } } as unknown as ReplaySessionStore,
      scope: { subSessionId: 7 },
    };
  }

  it("asks the store's own next / previous from the given frame, scoped", () => {
    const ctx = context({ IsReplayPlaying: true });

    expect(resolveJumpTarget("next", ctx)?.frame).toBe(5_000);
    expect(resolveJumpTarget("previous", ctx, 4_200)?.frame).toBe(1_000);
    expect(ctx.store.markers.next).toHaveBeenCalledWith(3_000, { subSessionId: 7 });
    expect(ctx.store.markers.previous).toHaveBeenCalledWith(4_200, { subSessionId: 7 });
  });

  it("is null out of a replay without asking the store", () => {
    const ctx = context({ IsReplayPlaying: false });

    expect(resolveJumpTarget("next", ctx)).toBeNull();
    expect(resolveJumpTarget("previous", ctx)).toBeNull();
    expect(ctx.store.markers.next).not.toHaveBeenCalled();
  });
});

describe("the replay state survives the post-seek blip (#1230, read from the controller since #1324)", () => {
  /** A replay at `frame`; `ReplayFrameNumEnd` is the frames LEFT, never a position. */
  const replayAt = (frame: number) =>
    ({ IsReplayPlaying: true, ReplayFrameNum: frame, ReplayFrameNumEnd: 90_000 }) as TelemetryData;
  /** What telemetry reads for ~300 ms after a `setPlayPosition`, and what it reads from the car. */
  const notPlaying = { IsReplayPlaying: false, ReplayFrameNum: 0, ReplayFrameNumEnd: 90_000 } as TelemetryData;
  const store = {
    markers: { next: vi.fn(() => markers(5_000)[0]!), previous: vi.fn(() => null) },
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
    expect(store.markers.next).toHaveBeenLastCalledWith(4_000, undefined);
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

describe("resolveAnchorFrame", () => {
  it("keeps the target only while pending", () => {
    const landing = { frame: 2_000, sentAt: 10_000 };

    expect(resolveAnchorFrame(null, 500, 10_000)).toBe(500);
    expect(resolveAnchorFrame(landing, 500, 10_500)).toBe(2_000);
    expect(resolveAnchorFrame(landing, 500, 10_000 + DIAL_LANDING_HOLD_MS)).toBe(500);
    expect(resolveAnchorFrame(landing, 1_950, 10_100)).toBe(1_950);
  });
});

/** A replay speed as telemetry reports it. */
interface SimSpeed {
  ReplayPlaySpeed: number;
  ReplayPlaySlowMotion: boolean;
}

const PAUSED: SimSpeed = { ReplayPlaySpeed: 0, ReplayPlaySlowMotion: false };
const AT_1X: SimSpeed = { ReplayPlaySpeed: 1, ReplayPlaySlowMotion: false };

/** The clock the jump suites start at, so a landing's `sentAt` is a known number. */
const PRESS_AT = 10_000;

/**
 * A sim that acts on a replay command only at a later update, `lagMs` on — the
 * shape that makes waiting for the pause and for the landing matter. `calls`
 * is every command in the order it was sent. A refused command returns false;
 * an ignored one is accepted and never shows. Installs itself as
 * `getCommands().replay`.
 */
function fakeSim(speed: SimSpeed, options: { lagMs?: number; seekLagMs?: number } = {}) {
  const lagMs = options.lagMs ?? 20;
  const seekLagMs = options.seekLagMs ?? lagMs;
  let telemetry = { IsReplayPlaying: true, ReplayFrameNum: 500, ...speed } as TelemetryData;
  const calls: string[] = [];
  const refuse = { speed: false, seek: false };
  const ignore = { speed: false, seek: false };

  const replay = {
    setPlaySpeed: vi.fn((value: number, slowMotion: boolean = false): boolean => {
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
    }),
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

  return { replay, calls, refuse, ignore, read: (): TelemetryData => telemetry };
}

/** Runs the clock until a jump has ended, and returns how. */
async function settled(jump: Promise<ReplayJumpOutcome>, ms = 5_000): Promise<ReplayJumpOutcome> {
  await vi.advanceTimersByTimeAsync(ms);

  return jump;
}

describe("the shared landing (#1230)", () => {
  beforeEach(() => {
    _resetReplayCursor();
    vi.useFakeTimers({ now: PRESS_AT });
    mockGetGlobalSettings.mockReset().mockReturnValue({});
    vi.mocked(getCommands).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a jump records its target at the press", () => {
    const sim = fakeSim(PAUSED);

    void jumpToMarkerFrame("next", 4_000, sim.read);

    expect(sim.replay.setPlayPosition).toHaveBeenCalledExactlyOnceWith(ReplayPosMode.Begin, 4_000);
    expect(pendingReplayLanding()).toEqual({ frame: 4_000, sentAt: PRESS_AT });
  });

  it("a jump that was not sent leaves no landing, whatever stood before it", async () => {
    // The first jump's seek is out and has not landed when the second is pressed.
    const sim = fakeSim(PAUSED, { seekLagMs: 400 });
    const first = jumpToMarkerFrame("dial-next", 2_000, sim.read);

    await vi.advanceTimersByTimeAsync(100);
    sim.refuse.seek = true;

    await expect(jumpToMarkerFrame("next", 4_000, sim.read)).resolves.toMatchObject({
      kind: "stopped",
      reason: "seek-failed",
    });

    // Neither the refused target nor the one before it: the next jump measures from the live frame.
    expect(pendingReplayLanding()).toBeNull();
    expect(resolveMarkerJumpAnchor(500)).toBe(500);
    await expect(settled(first)).resolves.toEqual({ kind: "cancelled", by: "next" });
  });

  it("the anchor is the landing while it is pending, from any surface", () => {
    void jumpToMarkerFrame("dial-next", 4_000, fakeSim(PAUSED).read);

    expect(resolveMarkerJumpAnchor(500, PRESS_AT + 200)).toBe(4_000);
    expect(pendingReplayLanding()).not.toBeNull();
  });

  it("a settled landing anchors no more and is dropped, so a later drift cannot revive it", () => {
    void jumpToMarkerFrame("next", 4_000, fakeSim(PAUSED).read);

    expect(resolveMarkerJumpAnchor(3_990, PRESS_AT + 100)).toBe(3_990);
    expect(pendingReplayLanding()).toBeNull();
    expect(resolveMarkerJumpAnchor(500, PRESS_AT + 200)).toBe(500);
  });

  it("an expired landing is dropped", () => {
    recordReplayLanding(4_000, PRESS_AT);

    expect(resolveMarkerJumpAnchor(500, PRESS_AT + DIAL_LANDING_HOLD_MS)).toBe(500);
    expect(pendingReplayLanding()).toBeNull();
  });

  it("a jump still running anchors on its marker however long ago it was pressed", async () => {
    // The seek is out and iRacing is taking its time: the live frame reads 0 meanwhile.
    const sim = fakeSim(PAUSED);

    sim.ignore.seek = true;
    void jumpToMarkerFrame("dial-next", 4_000, sim.read);
    await vi.advanceTimersByTimeAsync(DIAL_LANDING_HOLD_MS + 500);

    expect(resolveMarkerJumpAnchor(0)).toBe(4_000);
    expect(pendingReplayLanding()).not.toBeNull();
  });

  it("once the jump has ended, the hold decides", async () => {
    await settled(jumpToMarkerFrame("next", 4_000, fakeSim(PAUSED).read), 200);

    // The replay has moved on from the marker by other means.
    expect(resolveMarkerJumpAnchor(4_500, PRESS_AT + DIAL_LANDING_HOLD_MS - 1)).toBe(4_000);
    expect(resolveMarkerJumpAnchor(4_500, PRESS_AT + DIAL_LANDING_HOLD_MS)).toBe(4_500);
    expect(pendingReplayLanding()).toBeNull();
  });

  it("another owner taking the cursor clears it", () => {
    void jumpToMarkerFrame("next", 4_000, fakeSim(PAUSED).read);

    cancelReplayCursorOwner("play-pause");

    expect(resolveMarkerJumpAnchor(500, PRESS_AT + 100)).toBe(500);
  });
});

describe("jumpToMarkerFrame runs the shared jump sequence (#1276)", () => {
  beforeEach(() => {
    _resetReplayCursor();
    vi.useFakeTimers({ now: PRESS_AT });
    mockGetGlobalSettings.mockReset().mockReturnValue({});
    vi.mocked(getCommands).mockReset();
  });

  afterEach(() => {
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

  it("a moving replay has its landing recorded at the press, before its seek goes out", async () => {
    const sim = fakeSim(AT_1X);
    const jump = jumpToMarkerFrame("dial-next", 4_000, sim.read);

    // Only the pause is out; the next detent already measures from the marker.
    expect(sim.calls).toEqual(["speed 0"]);
    expect(pendingReplayLanding()).toEqual({ frame: 4_000, sentAt: PRESS_AT });
    expect(resolveMarkerJumpAnchor(500)).toBe(4_000);

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

  it("a landed jump leaves its landing for the anchor rule to settle", async () => {
    const sim = fakeSim(PAUSED);

    await settled(jumpToMarkerFrame("next", 4_000, sim.read), 200);

    expect(pendingReplayLanding()).toEqual({ frame: 4_000, sentAt: PRESS_AT });
    expect(resolveMarkerJumpAnchor(4_000)).toBe(4_000);
    expect(pendingReplayLanding()).toBeNull();
  });

  describe("a jump that stopped short clears the landing it recorded", () => {
    type Sim = ReturnType<typeof fakeSim>;

    const stops: Array<[string, SimSpeed, (sim: Sim) => void]> = [
      ["pause-failed", AT_1X, (sim) => (sim.refuse.speed = true)],
      ["pause-timeout", AT_1X, (sim) => (sim.ignore.speed = true)],
      ["seek-failed", PAUSED, (sim) => (sim.refuse.seek = true)],
      ["seek-timeout", PAUSED, (sim) => (sim.ignore.seek = true)],
    ];

    it.each(stops)("%s", async (reason, speed, breakIt) => {
      const sim = fakeSim(speed);

      breakIt(sim);
      // A landing an earlier jump left: the claim clears it, and nothing brings it back.
      recordReplayLanding(2_000, PRESS_AT - 100);

      const jump = jumpToMarkerFrame("next", 4_000, sim.read);

      // While the jump is under way its own landing anchors.
      expect(pendingReplayLanding()).toEqual({ frame: 4_000, sentAt: PRESS_AT });
      await expect(settled(jump)).resolves.toMatchObject({ kind: "stopped", reason });
      expect(pendingReplayLanding()).toBeNull();
    });

    it("leaves a later jump's landing alone", async () => {
      const sim = fakeSim(PAUSED);

      // Both pressed before the first has had the chance to clear its landing.
      sim.refuse.seek = true;
      const first = jumpToMarkerFrame("next", 2_000, sim.read);

      sim.refuse.seek = false;
      const second = jumpToMarkerFrame("dial-next", 4_000, sim.read);

      await expect(first).resolves.toMatchObject({ kind: "stopped", reason: "seek-failed" });
      expect(pendingReplayLanding()).toEqual({ frame: 4_000, sentAt: PRESS_AT });

      await expect(settled(second)).resolves.toMatchObject({ kind: "landed" });
      expect(pendingReplayLanding()).toEqual({ frame: 4_000, sentAt: PRESS_AT });
    });

    it("leaves a later jump's landing alone even when it is for the same frame at the same moment", async () => {
      const sim = fakeSim(PAUSED);

      sim.refuse.seek = true;
      const first = jumpToMarkerFrame("next", 4_000, sim.read);

      sim.refuse.seek = false;
      void jumpToMarkerFrame("dial-next", 4_000, sim.read);

      await expect(first).resolves.toMatchObject({ kind: "stopped", reason: "seek-failed" });
      expect(pendingReplayLanding()).toEqual({ frame: 4_000, sentAt: PRESS_AT });
    });

    it("leaves alone a landing recorded after the anchor rule dropped its own", async () => {
      const sim = fakeSim(PAUSED);

      sim.ignore.seek = true;

      const jump = jumpToMarkerFrame("next", 4_000, sim.read);

      // The replay reads within a second of the marker without reading it: the
      // anchor rule drops the landing, and something else records one.
      await vi.advanceTimersByTimeAsync(DIAL_LANDING_HOLD_MS);
      expect(resolveMarkerJumpAnchor(4_010)).toBe(4_010);
      recordReplayLanding(7_000, PRESS_AT + DIAL_LANDING_HOLD_MS);

      await expect(settled(jump)).resolves.toMatchObject({ kind: "stopped", reason: "seek-timeout" });
      expect(pendingReplayLanding()).toEqual({ frame: 7_000, sentAt: PRESS_AT + DIAL_LANDING_HOLD_MS });
    });
  });

  it("a cancelled jump sends nothing more and touches no landing", async () => {
    const sim = fakeSim(AT_1X, { seekLagMs: 400 });
    const jump = jumpToMarkerFrame("next", 4_000, sim.read);

    await vi.advanceTimersByTimeAsync(200);
    expect(sim.calls).toEqual(["speed 0", "seek 4000"]);

    // The driver's own command takes the cursor, and with it the landing.
    expect(cancelReplayCursorOwner("play-pause")).toBe("next");
    expect(pendingReplayLanding()).toBeNull();
    recordReplayLanding(7_000, PRESS_AT + 200);

    await expect(settled(jump)).resolves.toEqual({ kind: "cancelled", by: "play-pause" });
    expect(sim.calls).toEqual(["speed 0", "seek 4000"]);
    expect(pendingReplayLanding()).toEqual({ frame: 7_000, sentAt: PRESS_AT + 200 });
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

    it("a command that throws: the landing goes too, since the replay is headed nowhere known", async () => {
      const sim = fakeSim(PAUSED);

      sim.replay.setPlayPosition.mockImplementation(() => {
        throw new Error("broadcast failed");
      });

      const jump = jumpToMarkerFrame("next", 4_000, sim.read);

      expect(pendingReplayLanding()).toEqual({ frame: 4_000, sentAt: PRESS_AT });
      await expect(jump).rejects.toThrow("broadcast failed");
      expect(currentReplayCursorOwner()).toBeNull();
      expect(pendingReplayJumpSpeed()).toBeNull();
      expect(pendingReplayLanding()).toBeNull();
    });
  });

  it("with no replay commands to send through, takes neither the cursor nor the landing", async () => {
    vi.mocked(getCommands).mockImplementation(() => {
      throw new Error("SDK not initialized");
    });
    claimReplayCursor("jump-to-fastest-lap");
    recordReplayLanding(2_000, PRESS_AT - 100);

    await expect(jumpToMarkerFrame("next", 4_000, () => null)).rejects.toThrow("SDK not initialized");

    expect(currentReplayCursorOwner()).toBe("jump-to-fastest-lap");
    expect(pendingReplayLanding()).toEqual({ frame: 2_000, sentAt: PRESS_AT - 100 });
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
