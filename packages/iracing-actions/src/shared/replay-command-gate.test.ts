import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _configureReplayCommandGate,
  _resetReplayCommandGate,
  getReplayGateRecord,
  getReplayGateView,
  pressReplayCommand,
  type ReplayGateNotice,
  replaySearchMayRunMs,
  settleReplayByJump,
  subscribeReplayGate,
  waitForReplaySearchLanding,
  waitForReplaySettled,
  waitingReplaySpeed,
} from "./replay-command-gate.js";
import { fakeReplay, type FakeReplay, type FakeReplayOptions } from "./replay-command-gate.test-support.js";
import { _resetReplayCursor, claimReplayCursor } from "./replay-cursor.js";
import { _resetReplayPositionState, pendingReplayTarget, replayTargetGiveUpMs } from "./replay-position-state.js";

const { mockGetGlobalSettings } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn((): Record<string, unknown> => ({})),
}));

vi.mock("@iracedeck/settings", () => ({ getGlobalSettings: mockGetGlobalSettings }));

vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: vi.fn(() => {
    throw new Error("the gate's tests send through the fake replay");
  }),
  getController: vi.fn(() => {
    throw new Error("the gate's tests read the fake replay");
  }),
}));

/** Six hours of recording. */
const SIX_HOURS = 1_296_000;

const PLAY = { kind: "speed", speed: 1, slowMotion: false } as const;
const PAUSE = { kind: "pause" } as const;

let sim: FakeReplay;
let inReplay: boolean;
let connected: boolean;

function setUp(options: FakeReplayOptions = {}): FakeReplay {
  sim = fakeReplay(options);
  _configureReplayCommandGate({
    replay: () => sim.replay,
    readTelemetry: () => sim.telemetry(),
    inReplay: () => inReplay,
    connected: () => connected,
    now: () => Date.now(),
  });

  return sim;
}

async function wait(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function press(command: Parameters<typeof pressReplayCommand>[0], origin?: string) {
  return pressReplayCommand(command, { by: "test", origin });
}

/** A jump far across the tape, as a marker or a dial jump sends it. */
function farJump(frame = 160_000): void {
  press({ kind: "jump", frame }, "marker");
}

describe("replay command gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    _resetReplayCommandGate();
    _resetReplayCursor();
    _resetReplayPositionState();
    mockGetGlobalSettings.mockReturnValue({});
    inReplay = true;
    connected = true;
  });

  afterEach(() => {
    _resetReplayCommandGate();
    vi.useRealTimers();
  });

  describe("with nothing under way", () => {
    it.each([
      ["a speed", PLAY, "setPlaySpeed 1 false"],
      ["a pause", PAUSE, "pause"],
      ["a frame step", { kind: "step", direction: 1 } as const, "nextFrame"],
      ["a search", { kind: "search", search: "nextLap" } as const, "nextLap"],
      ["go to the end", { kind: "go-to", end: "end" } as const, "goToEnd"],
    ])("sends %s at once", (_name, command, call) => {
      setUp();

      expect(press(command)).toEqual({ kind: "sent", ok: true });
      expect(sim.calls).toEqual([call]);
    });

    it("sends a speed through the SDK call the surface names", () => {
      setUp();

      press({ kind: "speed", speed: 1, slowMotion: false, send: (r) => r.play() });

      expect(sim.calls).toEqual(["play"]);
    });

    it("records a frame step on a paused replay as a target one frame on", () => {
      setUp({ frame: 5_000 });

      press({ kind: "step", direction: 1 });

      expect(pendingReplayTarget()).toMatchObject({ frame: 5_001 });
    });

    it("sends a jump to the frame on screen and records no target", () => {
      setUp({ frame: 5_000 });

      press({ kind: "jump", frame: 5_000 });

      expect(sim.calls).toEqual(["setPlayPosition 0 5000"]);
      expect(pendingReplayTarget()).toBeNull();
    });
  });

  describe("behind a position jump", () => {
    it("holds a speed and sends it on the read-back, with nothing thrown", async () => {
      setUp({ frame: 2_000 });
      farJump();

      expect(press(PLAY, "key-play")).toEqual({ kind: "held" });
      expect(sim.calls).toEqual(["setPlayPosition 0 160000"]);

      await wait(2_000);

      expect(sim.calls).toEqual(["setPlayPosition 0 160000", "setPlaySpeed 1 false"]);
      expect(sim.thrown).toBe(0);
      expect(sim.frame()).toBeGreaterThanOrEqual(160_000);
    });

    it("holds a press behind a jump across six hours for as long as it seeks, and sends it on the landing", async () => {
      setUp({ frame: 0 });
      farJump(SIX_HOURS - 100);
      await wait(1_000);
      press(PLAY, "key-play");

      await wait(9_000);

      expect(sim.calls).toEqual([`setPlayPosition 0 ${SIX_HOURS - 100}`]);
      expect(getReplayGateRecord().waiting).toMatchObject({ command: "speed 1", behind: "jump" });

      await wait(2_000);

      expect(sim.calls.at(-1)).toBe("setPlaySpeed 1 false");
      expect(sim.thrown).toBe(0);
    });

    it("sends no pause into it: the replay is paused for the jump", () => {
      setUp({ frame: 2_000 });
      farJump();

      expect(press(PAUSE)).toMatchObject({ kind: "not-sent" });
      expect(sim.calls).toEqual(["setPlayPosition 0 160000"]);
    });

    it("lets a pause take back a held speed", async () => {
      setUp({ frame: 2_000 });
      farJump();
      press(PLAY);
      press(PAUSE);
      await wait(2_000);

      expect(sim.calls).toEqual(["setPlayPosition 0 160000"]);
    });

    it("turns a frame step into an absolute jump one frame from the target", async () => {
      setUp({ frame: 2_000 });
      farJump();

      expect(press({ kind: "step", direction: 1 })).toEqual({ kind: "sent", ok: true });
      await wait(2_000);

      expect(sim.calls).toEqual(["setPlayPosition 0 160000", "setPlayPosition 0 160001"]);
      expect(sim.frame()).toBe(160_001);
      expect(sim.thrown).toBe(0);
    });

    it("holds a search until the landing has held three reads 50 ms apart", async () => {
      setUp({ frame: 2_000, searches: { nextLap: (from) => from + 6_000 } });
      farJump();
      press({ kind: "search", search: "nextLap" });

      // The jump lands after ~1.3 s; the search goes out only once its landing has held.
      for (let i = 0; i < 150 && !sim.calls.includes("nextLap"); i++) await wait(20);

      const landedBy = Date.now();

      expect(sim.calls).toEqual(["setPlayPosition 0 160000", "nextLap"]);
      await wait(1_000);

      expect(sim.frame()).toBe(166_000);
      expect(sim.thrown).toBe(0);
      expect(landedBy).toBeGreaterThan(1_000_000);
    });

    it("sends go to the end at once, clearing the target", () => {
      setUp({ frame: 2_000 });
      farJump();

      expect(press({ kind: "go-to", end: "end" })).toEqual({ kind: "sent", ok: true });
      expect(pendingReplayTarget()).toBeNull();
      expect(sim.calls).toEqual(["setPlayPosition 0 160000", "goToEnd"]);
    });

    it("lets the newest word win in the slot", async () => {
      setUp({ frame: 2_000 });
      farJump();
      press(PLAY);
      press({ kind: "speed", speed: 4, slowMotion: false });

      expect(waitingReplaySpeed()).toEqual({ speed: 4, slowMotion: false });

      await wait(2_000);

      expect(sim.calls).toEqual(["setPlayPosition 0 160000", "setPlaySpeed 4 false"]);
    });

    it("drops a held press with nothing sent when the jump ends off its target", async () => {
      setUp({ frame: 2_000, unlandable: new Set([160_000]), unlandableRest: 160_004 });
      farJump();
      press(PLAY);

      await wait(replayTargetGiveUpMs(158_000) + 500);

      expect(sim.calls).toEqual(["setPlayPosition 0 160000"]);
      expect(getReplayGateRecord().waiting).toBeNull();
    });

    it("lets a new jump empty the slot", async () => {
      setUp({ frame: 2_000 });
      farJump();
      press({ kind: "search", search: "nextLap" });
      press({ kind: "jump", frame: 50_000 });
      await wait(3_000);

      expect(sim.calls).toEqual(["setPlayPosition 0 160000", "setPlayPosition 0 50000"]);
    });
  });

  describe("behind a search that may be on its way", () => {
    it("holds a speed until the landing has held, then sends it", async () => {
      setUp({ frame: 2_000, searches: { nextSession: (from) => from + 22_375 } });
      press({ kind: "search", search: "nextSession" });
      await wait(50);

      expect(press(PLAY)).toEqual({ kind: "held" });

      await wait(1_000);

      expect(sim.calls).toEqual(["nextSession", "setPlaySpeed 1 false"]);
      expect(sim.thrown).toBe(0);
    });

    it.each([
      ["a pause on a playing replay", PAUSE, { speed: 1, slowMotion: false }, "pause"],
      ["a frame step", { kind: "step", direction: 1 } as const, { speed: 0, slowMotion: false }, "nextFrame"],
      ["another search", { kind: "search", search: "nextLap" } as const, { speed: 0, slowMotion: false }, "nextLap"],
    ])("holds %s for the landing", async (_name, command, speed, call) => {
      setUp({
        frame: 2_000,
        speed,
        searches: { nextSession: (from) => from + 60_000, nextLap: (from) => from + 500 },
      });
      press({ kind: "search", search: "nextSession" });
      await wait(40);
      press(command);

      expect(sim.calls).toEqual(["nextSession"]);

      await wait(2_000);

      expect(sim.calls).toEqual(["nextSession", call]);
      expect(sim.thrown).toBe(0);
    });

    it("sends nothing for a pause on a paused replay", () => {
      setUp({ frame: 2_000, searches: { nextSession: (from) => from + 60_000 } });
      press({ kind: "search", search: "nextSession" });

      expect(press(PAUSE)).toMatchObject({ kind: "not-sent" });
    });

    it("waits however long a search across six hours takes", async () => {
      setUp({ frame: 0, searches: { nextSession: () => SIX_HOURS - 1_000 } });
      press({ kind: "search", search: "nextSession" });
      await wait(1_000);
      press(PLAY);

      await wait(8_000);

      expect(sim.calls).toEqual(["nextSession"]);

      await wait(3_000);

      expect(sim.calls).toEqual(["nextSession", "setPlaySpeed 1 false"]);
      expect(sim.thrown).toBe(0);
    });

    it("takes over at once on a second press: a jump beside the reading, then the press's command", async () => {
      setUp({ frame: 2_000, searches: { nextSession: (from) => from + 600_000 } });
      press({ kind: "search", search: "nextSession" });
      await wait(50);
      press(PLAY);

      expect(press(PLAY)).toMatchObject({ kind: "taking-over" });
      expect(sim.calls).toEqual(["nextSession", "setPlayPosition 0 2001"]);

      await wait(500);

      expect(sim.calls).toEqual(["nextSession", "setPlayPosition 0 2001", "setPlaySpeed 1 false"]);
      expect(sim.thrown).toBe(0);
    });

    it("takes over when a lone press has waited out the time the search could run", async () => {
      setUp({ frame: 0, searches: {} });
      press({ kind: "search", search: "nextSession" });
      press(PLAY);

      const couldRunMs = replaySearchMayRunMs(sim.telemetry(), 1);

      // From the start of six hours: about 21 s, never under the walk's 1.6 s.
      expect(couldRunMs).toBeGreaterThan(20_000);
      expect(couldRunMs).toBeLessThan(22_000);

      await wait(couldRunMs - 200);

      expect(sim.calls).toEqual(["nextSession"]);

      await wait(600);

      expect(sim.calls).toEqual(["nextSession", "setPlayPosition 0 1", "setPlaySpeed 1 false"]);
      expect(sim.thrown).toBe(0);
    });

    it("takes over at once for a press after that time, while the record stands", async () => {
      setUp({ frame: 1_290_000 });
      press({ kind: "search", search: "nextSession" });
      await wait(3_000);

      expect(press(PLAY)).toMatchObject({ kind: "taking-over" });
    });

    it("never drops a press behind a search for time", async () => {
      setUp({ frame: 0 });
      press({ kind: "search", search: "nextSession" });
      press(PLAY);
      await wait(60_000);

      expect(sim.calls.at(-1)).toBe("setPlaySpeed 1 false");
    });

    it("sends an absolute jump at once and forgets the search", async () => {
      setUp({ frame: 2_000, searches: { nextSession: (from) => from + 60_000 } });
      press({ kind: "search", search: "nextSession" });
      await wait(40);
      press({ kind: "jump", frame: 9_000 });

      expect(getReplayGateRecord().search).toBeNull();
      await wait(1_000);
      expect(sim.frame()).toBe(9_000);
      expect(sim.thrown).toBe(0);
    });

    it("gives a search that took over back the speed the replay had when the first went out", async () => {
      setUp({
        frame: 2_000,
        speed: { speed: 4, slowMotion: true },
        searches: { nextSession: (from) => from + 600_000, nextLap: (from) => from + 500 },
      });
      press({ kind: "search", search: "nextSession" });
      await wait(40);
      press({ kind: "search", search: "nextLap" });
      press({ kind: "search", search: "nextLap" });
      await wait(3_000);

      // Pause and jump, the search, then the speed it had: a quarter, in slow motion.
      expect(sim.calls).toEqual([
        "nextSession",
        "pause",
        "setPlayPosition 0 2001",
        "nextLap",
        "setPlaySpeed 4 true",
      ]);
    });
  });

  describe("a playing replay", () => {
    it("sees a search on its way when the frame stands still, and waits for its landing", async () => {
      setUp({ frame: 2_000, speed: { speed: 1, slowMotion: false }, searches: { nextSession: (f) => f + 60_000 } });
      press({ kind: "search", search: "nextSession" }, "key-next");
      await wait(120);

      expect(getReplayGateView("key-next").underWay).toMatchObject({ seen: true });

      press(PAUSE);
      await wait(1_500);

      expect(sim.calls).toEqual(["nextSession", "pause"]);
      expect(sim.thrown).toBe(0);
    });

    it("lets a waiting press take over about 400 ms after a search that found nothing", async () => {
      setUp({ frame: 2_000, speed: { speed: 1, slowMotion: false } });
      press({ kind: "search", search: "nextSession" });
      press(PAUSE);

      await wait(300);

      expect(sim.calls).toEqual(["nextSession"]);

      await wait(300);

      expect(sim.calls).toEqual(["nextSession", "pause", expect.stringMatching(/^setPlayPosition 0 \d+$/)]);
      expect(sim.thrown).toBe(0);
    });

    it.each([
      ["16x", { speed: 16, slowMotion: false }],
      ["reverse", { speed: -1, slowMotion: false }],
      ["a quarter", { speed: 4, slowMotion: true }],
    ])("sees a stall at %s", async (_name, speed) => {
      setUp({ frame: 200_000, speed, searches: { nextSession: (f) => f + 120_000 } });
      press({ kind: "search", search: "nextSession" }, "key-next");
      await wait(600);

      expect(getReplayGateRecord().search?.onItsWay).toBe("seen");
    });
  });

  describe("the state seam", () => {
    it("sends the same commands in the same order with and without a listener, one that throws included", async () => {
      const run = async (listen: boolean): Promise<string[]> => {
        _resetReplayCommandGate();
        _resetReplayPositionState();
        _resetReplayCursor();
        setUp({ frame: 2_000, searches: { nextSession: (f) => f + 60_000 } });

        if (listen) {
          subscribeReplayGate(() => {
            throw new Error("listener failed");
          });
        }

        farJump();
        press(PLAY, "a");
        await wait(1_500);
        press({ kind: "search", search: "nextSession" }, "b");
        await wait(30);
        press(PAUSE, "b");
        press(PAUSE, "b");
        await wait(2_000);

        return [...sim.calls];
      };

      expect(await run(true)).toEqual(await run(false));
    });

    it("reports a held command going out as one notice: waiting ended, under way begun, the press time kept", async () => {
      setUp({ frame: 2_000, searches: { nextLap: (f) => f + 500 } });
      const notices: ReplayGateNotice[] = [];

      subscribeReplayGate((notice) => notices.push(notice));
      farJump();
      press({ kind: "search", search: "nextLap" }, "lap-key");

      const pressedAt = Date.now();

      expect(getReplayGateView("lap-key")).toEqual({ underWay: null, waiting: { since: pressedAt } });

      for (let i = 0; i < 100 && !sim.calls.includes("nextLap"); i++) await wait(20);

      const goingOut = notices.find((n) => n.origin === "lap-key" && n.ended.some((e) => e.fact === "waiting"));

      expect(goingOut).toMatchObject({
        view: { underWay: { since: pressedAt }, waiting: null },
        ended: [{ fact: "waiting", class: "completed", reason: "sent-on-landing" }],
      });
    });

    it("keeps `since` through a retarget by the same token and ends another token's fact as superseded", () => {
      setUp({ frame: 2_000 });
      const notices: ReplayGateNotice[] = [];

      subscribeReplayGate((notice) => notices.push(notice));
      press({ kind: "jump", frame: 100_000 }, "dial");

      const since = getReplayGateView("dial").underWay?.since;

      vi.setSystemTime(Date.now() + 30);
      press({ kind: "jump", frame: 100_010 }, "dial");

      expect(getReplayGateView("dial").underWay?.since).toBe(since);

      press({ kind: "jump", frame: 120_000 }, "marker");

      expect(notices.at(-2)).toMatchObject({
        origin: "dial",
        ended: [{ fact: "underWay", class: "superseded", reason: "retargeted" }],
      });
    });

    it("ends every fact at once on a disconnect", async () => {
      setUp({ frame: 2_000 });
      farJump();
      press(PLAY, "play-key");
      connected = false;
      await wait(40);

      expect(getReplayGateView("marker")).toEqual({ underWay: null, waiting: null });
      expect(getReplayGateView("play-key")).toEqual({ underWay: null, waiting: null });
      expect(getReplayGateRecord().waiting).toBeNull();
    });

    it("ends a search and a waiting press when the replay is left, but keeps a target until its wait runs out", async () => {
      setUp({ frame: 2_000, searches: { nextSession: (f) => f + 60_000 } });
      press({ kind: "search", search: "nextSession" }, "next");
      press(PLAY, "play");
      inReplay = false;
      await wait(40);

      expect(getReplayGateView("next").underWay).toBeNull();
      expect(getReplayGateView("play").waiting).toBeNull();

      inReplay = true;
      farJump();
      inReplay = false;
      await wait(500);

      expect(getReplayGateView("marker").underWay).not.toBeNull();
    });

    it("has no view for a send with no token", () => {
      setUp({ frame: 2_000 });
      press({ kind: "jump", frame: 100_000 });

      expect(getReplayGateRecord().target).toMatchObject({ frame: 100_000, origin: undefined });
    });
  });

  describe("the waits #1426 and #801 build on", () => {
    it("settled: waits out a jump, never superseded without a claim, and counts only jumps in its jumps-only form", async () => {
      setUp({ frame: 2_000, searches: { nextSession: (f) => f + 60_000 } });
      farJump();

      const settled = waitForReplaySettled({ reads: 2, timeoutMs: 10_000 });

      await wait(3_000);

      await expect(settled).resolves.toBe("settled");

      press({ kind: "search", search: "nextSession" });

      await expect(waitForReplaySettled({ timeoutMs: 10, jumpsOnly: true })).resolves.toBe("settled");
    });

    it("settled: superseded when the caller's claim is taken", async () => {
      setUp({ frame: 2_000 });
      farJump();

      const claim = claimReplayCursor("runner");
      const settled = waitForReplaySettled({ timeoutMs: 10_000, claim });

      press(PLAY);
      await wait(100);

      await expect(settled).resolves.toBe("superseded");
    });

    it("a search's landing: landed, not landed on a paused replay, found nothing on a playing one", async () => {
      setUp({ frame: 2_000, searches: { nextLap: (f) => f + 6_000 } });
      press({ kind: "search", search: "nextLap" });

      const landed = waitForReplaySearchLanding({ patienceMs: 400, hardBoundMs: 5_000 });

      await wait(500);
      await expect(landed).resolves.toBe("landed");

      press({ kind: "search", search: "nextSession" });

      const quiet = waitForReplaySearchLanding({ patienceMs: 400, hardBoundMs: 5_000 });

      await wait(500);
      await expect(quiet).resolves.toBe("not-landed");

      _resetReplayCommandGate();
      setUp({ frame: 2_000, speed: { speed: 1, slowMotion: false } });
      press({ kind: "search", search: "nextSession" });

      const nothing = waitForReplaySearchLanding({ patienceMs: 5_000, hardBoundMs: 10_000 });

      await wait(800);
      await expect(nothing).resolves.toBe("found-nothing");
    });

    it("settle by a jump: pauses a moving replay, jumps beside the reading and reports the landing", async () => {
      setUp({ frame: 2_000, speed: { speed: 1, slowMotion: false }, searches: { nextSession: (f) => f + 600_000 } });
      press({ kind: "search", search: "nextSession" });
      await wait(100);

      const settled = settleReplayByJump();

      await wait(500);
      await expect(settled).resolves.toBe("settled");
      expect(sim.calls.slice(1, 3)).toEqual(["pause", expect.stringMatching(/^setPlayPosition 0 \d+$/)]);
      expect(sim.thrown).toBe(0);
    });
  });

  describe("what the review of #1430 turned up", () => {
    it("records no target for a jump sent bare into a moving replay, so a Pause once its seek has landed is sent", async () => {
      setUp({ frame: 2_000, speed: { speed: 1, slowMotion: false } });
      press({ kind: "jump", frame: 50_000 }, "set-play-position");

      expect(pendingReplayTarget()).toBeNull();
      // The seek itself still shows, and holds a pause back while it does.
      expect(press(PAUSE)).toMatchObject({ kind: "not-sent" });

      await wait(500);

      expect(press(PAUSE)).toEqual({ kind: "sent", ok: true });
    });

    it("lets a repeat of the held input wait behind a search, where a second press would take over", async () => {
      setUp({ frame: 2_000, searches: { nextSession: (from) => from + 600_000 } });
      press({ kind: "search", search: "nextSession" });
      await wait(50);
      press(PLAY);

      expect(pressReplayCommand(PLAY, { by: "test", repeat: true })).toEqual({ kind: "held" });
      expect(sim.calls).toEqual(["nextSession"]);
    });

    it("tells the replay state the plugin left for live when a Jump to Live goes out from the slot", async () => {
      const leftForLive = vi.fn();

      setUp({ frame: 2_000, searches: { nextLap: (from) => from + 6_000 } });
      _configureReplayCommandGate({
        replay: () => sim.replay,
        readTelemetry: () => sim.telemetry(),
        inReplay: () => inReplay,
        connected: () => connected,
        leftForLive,
        now: () => Date.now(),
      });
      press({ kind: "search", search: "nextLap" });
      await wait(10);

      expect(press({ kind: "go-to", end: "end" })).toEqual({ kind: "held" });

      await wait(1_000);

      expect(sim.calls).toEqual(["nextLap", "goToEnd"]);
      expect(leftForLive).toHaveBeenCalledTimes(1);
    });
  });

  describe("the raw record", () => {
    it("says what is under way and what waits", () => {
      setUp({ frame: 2_000 });
      farJump();
      press(PLAY, "play-key");

      expect(getReplayGateRecord()).toMatchObject({
        target: { frame: 160_000, origin: "marker" },
        waiting: { command: "speed 1", origin: "play-key", behind: "jump" },
      });
    });
  });

  describe("the control: the fake replay throws what the gate holds", () => {
    it("counts a speed sent bare into a jump as thrown, and the jump lands off its target", async () => {
      setUp({ frame: 2_000 });
      sim.replay.setPlayPosition(0, 160_000);
      await wait(100);
      sim.replay.setPlaySpeed(1, false);
      await wait(3_000);

      expect(sim.thrown).toBe(1);
      expect(sim.frame()).not.toBe(160_000);
    });

    it("counts a speed sent bare into a search on its way as thrown", async () => {
      setUp({ frame: 2_000, searches: { nextSession: (from) => from + 60_000 } });
      sim.replay.nextSession();
      await wait(50);
      sim.replay.setPlaySpeed(1, false);
      await wait(2_000);

      expect(sim.thrown).toBeGreaterThan(0);
    });

    it("counts nothing for a pause and a jump into a search, the route measured safe", async () => {
      setUp({ frame: 2_000, searches: { nextSession: (from) => from + 60_000 } });
      sim.replay.nextSession();
      await wait(50);
      sim.replay.pause();
      sim.replay.setPlayPosition(0, 2_001);
      await wait(500);

      expect(sim.thrown).toBe(0);
    });
  });

  it("reads the gate's state through TelemetryData only", () => {
    // A compile-time guard that the fake speaks the SDK's shape.
    const reading: TelemetryData = setUp().telemetry();

    expect(reading.IsReplayPlaying).toBe(true);
  });
});
