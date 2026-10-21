/**
 * The replay command gate with its senders together (#1430): the shared jump
 * sequence (Replay Markers, Jump to Fastest Lap's record jump), a key's press
 * and a dial's Frame Jog detent, against the fake replay of
 * `replay-command-gate.test-support.ts`. The cases are the spec's "The jump
 * sequence" list under Testing.
 */
import {
  _configureReplayEngine,
  _resetReplayCursor,
  _resetReplayPositionState,
  cancelReplayCursorOwner,
  pendingReplayTarget,
  planFrameMove,
} from "@iracedeck/replay-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _configureReplayCommandGate,
  _resetReplayCommandGate,
  pressReplayCommand,
  readReplayPosition,
  type ReplayGateCommand,
  type ReplayGateNotice,
  sendOwnedReplayCommand,
  subscribeReplayGate,
} from "./replay-command-gate.js";
import { fakeReplay, type FakeReplay, type FakeReplayOptions } from "./replay-command-gate.test-support.js";
import { beginReplayJump, type ReplayJumpOutcome, runReplayJump } from "./replay-jump-playback.js";

const { mockGetGlobalSettings } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn((): Record<string, unknown> => ({})),
}));

vi.mock("@iracedeck/settings", () => ({ getGlobalSettings: mockGetGlobalSettings }));

// The engine reads the two replay settings through its env (#1467); read them from the settings mock the cases set.
const engineSetting = (key: string): unknown => (mockGetGlobalSettings() as Record<string, unknown> | undefined)?.[key];

_configureReplayEngine({
  settings: {
    replayJumpPlayback: () => engineSetting("replayJumpPlayback"),
    fastestLapSearchDelayMs: () => engineSetting("fastestLapSearchDelayMs"),
  },
});

vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: vi.fn(() => {
    throw new Error("these tests send through the fake replay");
  }),
  getController: vi.fn(() => {
    throw new Error("these tests read the fake replay");
  }),
}));

const PLAY = { kind: "speed", speed: 1, slowMotion: false } as const;
const PLAYING = { speed: 1, slowMotion: false } as const;

let sim: FakeReplay;

function setUp(options: FakeReplayOptions = {}): FakeReplay {
  sim = fakeReplay({ frame: 2_000, ...options });
  _configureReplayCommandGate({
    replay: () => sim.replay,
    readTelemetry: () => sim.telemetry(),
    inReplay: () => true,
    connected: () => true,
    now: () => Date.now(),
  });

  return sim;
}

function setting(mode: "remember" | "play" | "stopped"): void {
  mockGetGlobalSettings.mockReturnValue({ replayJumpPlayback: mode });
}

/** A marker press: the shared jump sequence to `frame`, ended in its own `finally`. */
function marker(
  frame: number,
  options: { origin?: string; afterLanding?: () => boolean } = {},
): Promise<ReplayJumpOutcome> {
  const jump = beginReplayJump("next", sim.telemetry(), undefined, Date.now(), {
    frame,
    origin: options.origin,
    afterLanding: options.afterLanding,
  });

  return runReplayJump(jump, {
    frame,
    readTelemetry: () => sim.telemetry(),
    afterLanding: options.afterLanding,
  }).finally(() => jump.end());
}

function press(command: ReplayGateCommand, by = "key") {
  return pressReplayCommand(command, { by, origin: by });
}

/** One Frame Jog detent, as the dial sends it: a pause first on a moving replay, then the planned move. */
function jogDetent(ticks = 1): void {
  const telemetry = sim.telemetry();

  if (telemetry.ReplayPlaySpeed !== 0) press({ kind: "pause" }, "dial-frame-jog");

  const move = planFrameMove(ticks, readReplayPosition(sim.telemetry()));

  if (move.kind === "jump") press({ kind: "jump", frame: move.frame }, "dial-frame-jog");
  else if (move.kind === "step") press({ kind: "step", direction: move.direction }, "dial-frame-jog");
}

async function wait(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** The calls after the first `from` ones, the commands that are not seeks or pauses kept as they are. */
function speedsAfterSeek(): string[] {
  const seek = sim.calls.findIndex((c) => c.startsWith("setPlayPosition"));

  return sim.calls.slice(seek + 1);
}

describe("the jump sequence and the other senders (#1430)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    _resetReplayCommandGate();
    _resetReplayCursor();
    _resetReplayPositionState();
    setting("remember");
  });

  afterEach(() => {
    _resetReplayCommandGate();
    vi.useRealTimers();
  });

  it("sends no pause of its own while a dial's jump is under way", async () => {
    setUp({ speed: PLAYING });
    jogDetent(5);

    const outcome = marker(150_000);

    await wait(3_000);
    await expect(outcome).resolves.toMatchObject({ kind: "landed" });

    // The dial's pause, its jump, the marker's seek: no second pause into the dial's seek.
    expect(sim.calls.slice(0, 3)).toEqual(["pause", "setPlayPosition 0 2005", "setPlayPosition 0 150000"]);
    expect(sim.thrown).toBe(0);
  });

  it("sends a Play pressed during it once, at the landing", async () => {
    setUp();
    void marker(150_000);
    await wait(100);

    expect(press(PLAY)).toEqual({ kind: "held" });

    await wait(3_000);

    expect(sim.calls).toEqual(["setPlayPosition 0 150000", "setPlaySpeed 1 false"]);
    expect(sim.thrown).toBe(0);
  });

  describe("a search pressed during it", () => {
    it.each([
      ["remember", ["nextLap", "setPlaySpeed 1 false"]],
      ["play", ["nextLap", "setPlaySpeed 1 false"]],
      ["stopped", ["nextLap"]],
    ] as const)("goes out once the landing has held, followed by the playback step under %s", async (mode, after) => {
      setting(mode);
      setUp({ speed: PLAYING, speedLagMs: 20, searches: { nextLap: (from) => from + 500 } });
      void marker(150_000);
      await wait(60);
      press({ kind: "search", search: "nextLap" });
      await wait(4_000);

      expect(speedsAfterSeek()).toEqual(after);
      expect(sim.frame()).toBeGreaterThanOrEqual(150_500);
      expect(sim.thrown).toBe(0);
    });

    it("is dropped, with no playback step, when the jump ends off its target", async () => {
      setUp({ unlandable: new Set([150_000]), unlandableRest: 150_004 });
      void marker(150_000);
      await wait(60);
      press({ kind: "search", search: "nextLap" });
      await wait(30_000);

      expect(sim.calls).toEqual(["setPlayPosition 0 150000"]);
    });

    it("that finds nothing still gets the playback step, by the takeover's jump, once it could no longer be running", async () => {
      setUp({ speed: PLAYING });
      void marker(150_000);
      await wait(100);
      press({ kind: "search", search: "nextLap" });
      await wait(40_000);

      expect(speedsAfterSeek()).toEqual(["nextLap", "setPlayPosition 0 150001", "setPlaySpeed 1 false"]);
      expect(sim.thrown).toBe(0);
    });
  });

  it("captures a speed waiting in the slot when it starts, and does not send it", async () => {
    setUp();
    press({ kind: "jump", frame: 100_000 }, "dial-frame-jog");
    press(PLAY);

    void marker(150_000);
    await wait(4_000);

    expect(sim.calls).toEqual(["setPlayPosition 0 100000", "setPlayPosition 0 150000", "setPlaySpeed 1 false"]);
    expect(sim.thrown).toBe(0);
  });

  describe("with its pause sent and not yet shown", () => {
    it.each([
      ["a Play", PLAY as ReplayGateCommand, ["setPlaySpeed 0", "setPlayPosition 0 150000", "setPlaySpeed 1 false"]],
      ["a pause", { kind: "pause" } as ReplayGateCommand, ["setPlaySpeed 0", "setPlayPosition 0 150000"]],
    ])("leaves one seek, to the jump's frame, once the pause shows: %s", async (_name, command, calls) => {
      setUp({ speed: PLAYING, speedLagMs: 40 });

      const outcome = marker(150_000);

      expect(sim.calls).toEqual(["setPlaySpeed 0"]);
      press(command);
      await wait(3_000);

      await expect(outcome).resolves.toMatchObject({ kind: "cancelled" });
      expect(sim.calls).toEqual(calls);
      // Landed on the jump's frame: paused there, or playing on from it.
      expect(sim.frame()).toBeGreaterThanOrEqual(150_000);
      expect(sim.frame()).toBeLessThan(150_000 + 60 * 4);
      expect(sim.thrown).toBe(0);
    });

    it("leaves one seek for a search too, which then goes out on the held landing", async () => {
      setUp({ speed: PLAYING, speedLagMs: 40, searches: { nextLap: (from) => from + 500 } });
      void marker(150_000);
      press({ kind: "search", search: "nextLap" });
      await wait(4_000);

      expect(sim.calls.slice(0, 3)).toEqual(["setPlaySpeed 0", "setPlayPosition 0 150000", "nextLap"]);
      expect(sim.frame()).toBeGreaterThanOrEqual(150_500);
      expect(sim.thrown).toBe(0);
    });

    it("a Frame Jog detent moves the target one frame on and sends its seek at once, with no second pause", async () => {
      setUp({ speed: PLAYING, speedLagMs: 40 });

      const outcome = marker(150_000);

      jogDetent();

      expect(sim.calls).toEqual(["setPlaySpeed 0", "setPlayPosition 0 150001"]);

      await wait(3_000);

      // Nothing more when the pause shows: the sequence's playback step is not applied.
      await expect(outcome).resolves.toMatchObject({ kind: "cancelled" });
      expect(sim.calls).toEqual(["setPlaySpeed 0", "setPlayPosition 0 150001"]);
      expect(sim.frame()).toBe(150_001);
      expect(sim.speed().speed).toBe(0);
    });

    it("a held Play and then a second marker press end in one seek, to the second marker's frame", async () => {
      setUp({ speed: PLAYING, speedLagMs: 40 });
      void marker(150_000);
      press(PLAY);
      void marker(160_000);
      await wait(4_000);

      expect(sim.calls.filter((c) => c.startsWith("setPlayPosition"))).toEqual(["setPlayPosition 0 160000"]);
      expect(sim.frame()).toBeGreaterThanOrEqual(160_000);
      expect(sim.calls.at(-1)).toBe("setPlaySpeed 1 false");
      expect(sim.thrown).toBe(0);
    });

    it("a car key that takes the cursor leaves no target and no seek", async () => {
      setUp({ speed: PLAYING, speedLagMs: 40 });
      void marker(150_000);
      cancelReplayCursorOwner("jump-to-my-car");

      expect(pendingReplayTarget()).toBeNull();

      await wait(3_000);

      expect(sim.calls).toEqual(["setPlaySpeed 0"]);
    });

    it("a pause that never shows clears the target, and a Play held behind it is dropped", async () => {
      setUp({ speed: PLAYING, speedLagMs: 60_000 });
      void marker(150_000);
      press(PLAY);
      await wait(10_000);

      expect(pendingReplayTarget()).toBeNull();
      expect(sim.calls).toEqual(["setPlaySpeed 0"]);
    });
  });

  it("a Frame Jog detent just after the seek went out ends one frame from the marker, paused, with no playback step", async () => {
    setUp({ speed: PLAYING, speedLagMs: 20 });

    const outcome = marker(150_000);

    for (let i = 0; i < 20 && !sim.calls.some((c) => c.startsWith("setPlayPosition")); i++) await wait(5);

    jogDetent();
    await wait(3_000);

    await expect(outcome).resolves.toMatchObject({ kind: "cancelled" });
    expect(sim.calls).toEqual(["setPlaySpeed 0", "setPlayPosition 0 150000", "setPlayPosition 0 150001"]);
    expect(sim.frame()).toBe(150_001);
    expect(sim.speed().speed).toBe(0);
  });

  it("started while a key's search has not landed, forgets it and sends its pause and seek as on a quiet replay", async () => {
    setUp({ speed: PLAYING, speedLagMs: 20, searches: { nextSession: (from) => from + 600_000 } });
    press({ kind: "search", search: "nextSession" });
    await wait(50);

    const outcome = marker(150_000);

    await wait(3_000);
    await expect(outcome).resolves.toMatchObject({ kind: "landed" });

    expect(sim.calls.slice(0, 3)).toEqual(["nextSession", "setPlaySpeed 0", "setPlayPosition 0 150000"]);
    expect(sim.frame()).toBeGreaterThanOrEqual(150_000);
    expect(sim.thrown).toBe(0);
  });

  describe("what the review of #1430 turned up", () => {
    it("a second marker press after the first one's pause has shown sends only its own seek", async () => {
      setUp({ speed: PLAYING, speedLagMs: 40 });
      void marker(150_000);
      // The pause has shown, and the gate's own poll has not run since: the clock moves, no timer fires.
      vi.setSystemTime(Date.now() + 45);
      void marker(160_000);

      expect(sim.calls).toEqual(["setPlaySpeed 0", "setPlayPosition 0 160000"]);

      await wait(4_000);

      expect(sim.frame()).toBeGreaterThanOrEqual(160_000);
      expect(sim.thrown).toBe(0);
    });

    it("a jump to the frame a paused replay already shows lands at once, and a Play after it is not held", async () => {
      setUp({ frame: 150_000 });

      const outcome = marker(150_000);

      expect(pendingReplayTarget()).toBeNull();
      await wait(100);
      await expect(outcome).resolves.toMatchObject({ kind: "landed" });
      expect(press(PLAY)).toEqual({ kind: "sent", ok: true });
    });

    it("a jump that set the replay playing again has not paused it: a Pause pressed then is sent", () => {
      setUp({ speed: PLAYING });

      const jump = beginReplayJump("walk", sim.telemetry());

      expect(sendOwnedReplayCommand(jump.claim, { kind: "pause" })).toBe("sent");
      expect(sendOwnedReplayCommand(jump.claim, PLAY)).toBe("sent");
      expect(press({ kind: "pause" })).toEqual({ kind: "sent", ok: true });
      jump.end();
    });

    it("a retarget by the same token does not end its run", () => {
      setUp({ speed: PLAYING, speedLagMs: 40 });

      const notices: ReplayGateNotice[] = [];

      subscribeReplayGate((notice) => notices.push(notice));
      void marker(150_000, { origin: "markers-dial" });
      void marker(160_000, { origin: "markers-dial" });

      expect(notices.flatMap((n) => (n.origin === "markers-dial" ? n.ended : []))).toEqual([]);
    });

    it("a token's walk taken by its own Play, which leaves it nothing under way, ends replaced, not run out (#1437)", () => {
      setUp();

      const notices: ReplayGateNotice[] = [];
      // A walk has no target of its own: only its held jump keeps the token under way.
      const jump = beginReplayJump("walk", sim.telemetry(), undefined, Date.now(), { origin: "walk-key" });

      subscribeReplayGate((notice) => notices.push(notice));

      expect(press(PLAY, "walk-key")).toEqual({ kind: "sent", ok: true });
      jump.end();

      expect(notices.flatMap((n) => (n.origin === "walk-key" ? n.ended : []))).toEqual([
        { fact: "underWay", class: "superseded", reason: "replaced" },
      ]);
    });
  });

  describe("what the second read of #1430 turned up", () => {
    it("a Play pressed behind the gate's own playback step waits, and does not take over the search", async () => {
      setUp({ speed: PLAYING, speedLagMs: 20, searches: { nextLap: (from) => from + 60_000 } });
      void marker(150_000);
      await wait(60);
      press({ kind: "search", search: "nextLap" });

      for (let i = 0; i < 200 && !sim.calls.includes("nextLap"); i++) await wait(20);

      await wait(30);

      expect(press(PLAY)).toEqual({ kind: "held" });

      await wait(3_000);

      expect(sim.calls.filter((c) => c.startsWith("setPlayPosition"))).toEqual(["setPlayPosition 0 150000"]);
      expect(sim.frame()).toBeGreaterThanOrEqual(210_000);
      expect(sim.thrown).toBe(0);
    });

    it("a second marker jump carries on the playback a search waiting behind the first one carried", async () => {
      setUp({ speed: PLAYING, speedLagMs: 20, searches: { nextLap: (from) => from + 500 } });
      void marker(150_000);
      await wait(60);
      press({ kind: "search", search: "nextLap" });
      void marker(160_000);
      await wait(4_000);

      expect(sim.calls.at(-1)).toBe("setPlaySpeed 1 false");
      expect(sim.calls).not.toContain("nextLap");
    });

    it("runs the jump's step after the landing when a press takes the cursor in the poll that reads it", async () => {
      setUp();

      const afterLanding = vi.fn(() => true);

      void marker(150_000, { afterLanding });
      // The seek lands with no poll run since: the press's own reading is the first to see it.
      vi.setSystemTime(Date.now() + 3_000);
      press(PLAY);
      await wait(1_000);

      expect(afterLanding).toHaveBeenCalledTimes(1);
    });

    it("a jump to the frame on screen while a search is on its way is a real jump, with a target", () => {
      setUp({ frame: 150_000, searches: { nextSession: (from) => from + 600_000 } });
      press({ kind: "search", search: "nextSession" });
      void marker(150_000);

      expect(pendingReplayTarget()).toMatchObject({ frame: 150_000 });
    });
  });

  describe("the jump's own step after the landing", () => {
    it("still runs when a Play took the cursor during the seek", async () => {
      setUp();

      const afterLanding = vi.fn(() => true);

      void marker(150_000, { afterLanding });
      await wait(100);
      press(PLAY);
      await wait(3_000);

      expect(afterLanding).toHaveBeenCalledTimes(1);
      expect(sim.calls).toEqual(["setPlayPosition 0 150000", "setPlaySpeed 1 false"]);
    });

    it("does not run when a car key took the cursor", async () => {
      setUp();

      const afterLanding = vi.fn(() => true);

      void marker(150_000, { afterLanding });
      await wait(100);
      cancelReplayCursorOwner("jump-to-my-car");
      await wait(3_000);

      expect(afterLanding).not.toHaveBeenCalled();
    });
  });
});
