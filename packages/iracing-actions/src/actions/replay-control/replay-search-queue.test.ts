/**
 * The Replay Control dial's paced search (#801) against the fake replay of the
 * gate's tests (`shared/replay-command-gate.test-support.ts`), which counts a
 * command sent bare into a jump or a search on its way as thrown. The cases
 * are the spec's "The queue", "The first search on a playing replay" and the
 * runner's part of "The origin token", under Testing.
 */
import { type ILogger, silentLogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _configureReplayCommandGate,
  _resetReplayCommandGate,
  getReplayGateRecord,
  pressReplayCommand,
  type ReplayGateNotice,
  subscribeReplayGate,
} from "../../shared/replay-command-gate.js";
import { fakeReplay, type FakeReplay, type FakeReplayOptions } from "../../shared/replay-command-gate.test-support.js";
import { _resetReplayCursor, currentReplayCursorOwner } from "../../shared/replay-cursor.js";
import { beginReplayJump, runReplayJump } from "../../shared/replay-jump-playback.js";
import { _resetReplayPositionState } from "../../shared/replay-position-state.js";
import {
  _configureReplaySearchQueue,
  _resetReplaySearchQueue,
  isReplaySearchRunning,
  onReplaySearchChange,
  onReplaySearchSpeedSent,
  pendingReplaySearch,
  queueReplaySearch,
  replaySearchPatienceMs,
  type ReplaySearchTarget,
  SEARCH_PATIENCE_MAX_MS,
  SEARCH_PATIENCE_MIN_MS,
  SEARCH_QUEUE_MAX,
  setReplaySearchQueueLogger,
} from "./replay-search-queue.js";
import {
  _resetReplaySpeedState,
  keepDialPendingSpeed,
  noteDialSpeedSent,
  resolveLiveSpeed,
} from "./replay-speed-state.js";

const { mockGetGlobalSettings } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn((): Record<string, unknown> => ({})),
}));

vi.mock("@iracedeck/settings", () => ({ getGlobalSettings: mockGetGlobalSettings }));

vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: vi.fn(() => {
    throw new Error("these tests send through the fake replay");
  }),
  getController: vi.fn(() => {
    throw new Error("these tests read the fake replay");
  }),
}));

/** Six hours of recording. */
const SIX_HOURS = 1_296_000;
const START = 50_000;

/** How long one hold of a reading takes: three reads, 50 ms apart. */
const HOLD_ONE_MS = 100;

const PLAYING = { speed: 1, slowMotion: false } as const;
const REVERSE = { speed: -1, slowMotion: false } as const;
const HALF = { speed: 2, slowMotion: true } as const;

/** Every search lands a lap, a session or an incident on from where it is sent. */
const STEPS: NonNullable<FakeReplayOptions["searches"]> = {
  nextLap: (f) => f + 3_000,
  prevLap: (f) => f - 3_000,
  nextSession: (f) => f + 22_375,
  prevSession: (f) => f - 22_375,
  nextIncident: (f) => f + 1_000,
  prevIncident: (f) => f - 1_000,
};

let sim: FakeReplay;
let inReplay: boolean;
let notices: ReplayGateNotice[];
let warn: ReturnType<typeof vi.fn>;

function setUp(options: FakeReplayOptions = {}): FakeReplay {
  sim = fakeReplay({ frame: START, searches: STEPS, ...options });
  _configureReplayCommandGate({
    replay: () => sim.replay,
    readTelemetry: () => sim.telemetry(),
    inReplay: () => inReplay,
    connected: () => true,
    now: () => Date.now(),
  });
  _configureReplaySearchQueue({ readTelemetry: () => sim.telemetry(), inReplay: () => inReplay });
  notices = [];
  subscribeReplayGate((notice) => notices.push(notice));

  return sim;
}

function setting(mode: "remember" | "play" | "stopped", extra: Record<string, unknown> = {}): void {
  mockGetGlobalSettings.mockReturnValue({ replayJumpPlayback: mode, ...extra });
}

function turn(target: ReplaySearchTarget, ticks: number, origin = "dial-a"): void {
  queueReplaySearch({ target, ticks, origin, owner: `replay-control-dial ${target}` });
}

async function wait(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Runs the clock until no run is under way, at most `maxMs`. */
async function untilIdle(maxMs = 30_000): Promise<void> {
  for (let waited = 0; waited < maxMs && pendingReplaySearch() !== null; waited += 20) await wait(20);

  expect(pendingReplaySearch()).toBeNull();
}

/** Runs the clock until `call` has been sent `times` times, at most `maxMs`. */
async function until(call: string, times = 1, maxMs = 10_000): Promise<void> {
  for (let waited = 0; waited < maxMs && sim.calls.filter((c) => c === call).length < times; waited += 10) {
    await wait(10);
  }
}

/** How each run of `origin` ended, as its replay jump reported it to the gate's state seam. */
function runEnds(origin = "dial-a"): string[] {
  return notices
    .filter((n) => n.origin === origin)
    .flatMap((n) => n.ended.map((e) => e.reason))
    .filter((reason) => reason === "jump-landed" || reason === "walk-gave-up" || reason === "claim-taken");
}

/** Records each send of the named commands: when it went out, and whether the sim was still busy with a move. */
function trackSends(names: readonly string[]): { name: string; at: number; busy: boolean }[] {
  const sends: { name: string; at: number; busy: boolean }[] = [];
  const replay = sim.replay as unknown as Record<string, ReturnType<typeof vi.fn>>;

  for (const name of names) {
    const fn = replay[name];
    const original = fn.getMockImplementation() as ((...args: unknown[]) => unknown) | undefined;

    if (original === undefined) throw new Error(`no ${name} on the fake`);

    fn.mockImplementation((...args: unknown[]) => {
      sends.push({ name, at: Date.now(), busy: sim.busy() });

      return original(...args);
    });
  }

  return sends;
}

/** Runs `act` when the runner hears its `nth` search land (the sim no longer busy). Returns the unsubscribe. */
function onLanding(nth: number, act: () => void): () => void {
  let seen = 0;

  return onReplaySearchChange(() => {
    const searches = sim.calls.filter((c) => /^(next|prev)(Lap|Session|Incident)$/.test(c)).length;

    if (sim.busy() || searches <= seen) return;

    seen = searches;

    if (seen === nth) act();
  });
}

/** A record jump of the dial's (#1276's sequence), as the Lap mode sends one: the seek goes out at once on a paused replay. */
function recordJump(frame: number, origin = "dial-a"): void {
  const jump = beginReplayJump("replay-control-dial lap record", sim.telemetry(), undefined, Date.now(), {
    frame,
    origin,
  });

  void runReplayJump(jump, { frame, readTelemetry: () => sim.telemetry() }).finally(() => jump.end());
}

describe("the paced search runner (#801)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    _resetReplaySearchQueue();
    _resetReplayCommandGate();
    _resetReplayCursor();
    _resetReplayPositionState();
    setting("remember");
    inReplay = true;
    warn = vi.fn();
    setReplaySearchQueueLogger({ ...silentLogger, warn } as ILogger);
  });

  afterEach(() => {
    _resetReplaySearchQueue();
    _resetReplayCommandGate();
    vi.useRealTimers();
  });

  describe("the queue", () => {
    it("sends a count of three one at a time, each once the last has landed, then the playback step once", async () => {
      setUp();
      setting("play");

      const sends = trackSends(["nextLap"]);

      turn("lap", 3);
      await untilIdle();

      expect(sim.calls).toEqual(["nextLap", "nextLap", "nextLap", "setPlaySpeed 1 false"]);
      expect(sends.map((s) => s.busy)).toEqual([false, false, false]);
      expect(sim.frame()).toBeGreaterThanOrEqual(START + 9_000);
      expect(sim.thrown).toBe(0);
      expect(runEnds()).toEqual(["jump-landed"]);
    });

    it("sends no search on the first read of a landing, only once it has held three reads 50 ms apart", async () => {
      setUp();

      const sends = trackSends(["nextLap"]);

      turn("lap", 3);
      await untilIdle();

      // Each search lands about 33 ms after it goes out (3000 frames at 2048 a sim update).
      for (let i = 1; i < sends.length; i++) expect(sends[i].at - (sends[i - 1].at + 33)).toBeGreaterThanOrEqual(100);
    });

    it("sends no search on the first read of the pause, only on the third", async () => {
      setUp({ speed: { speed: 4, slowMotion: false }, speedLagMs: 30 });

      const sends = trackSends(["setPlaySpeed", "nextLap"]);

      turn("lap", 1);
      await untilIdle();

      expect(sim.calls.slice(0, 2)).toEqual(["setPlaySpeed 0", "nextLap"]);
      // The pause reads back 30 ms after it goes out.
      expect(sends[1].at - (sends[0].at + 30)).toBeGreaterThanOrEqual(100);
    });

    it("sends the search of a turn made while the end's landing holds, then the playback step", async () => {
      setUp();
      setting("play");
      onLanding(1, () => setTimeout(() => turn("lap", 1), 30));
      turn("lap", 1);
      await untilIdle();

      expect(sim.calls).toEqual(["nextLap", "nextLap", "setPlaySpeed 1 false"]);
      expect(sim.frame()).toBe(START + 6_000);
      expect(sim.thrown).toBe(0);
      expect(runEnds()).toEqual(["jump-landed"]);
    });

    it("ends on the hold it was making when a reversal brings the count to zero, with no second hold", async () => {
      setUp();
      setting("play");

      const sends = trackSends(["setPlaySpeed"]);
      let landedAt = 0;

      onLanding(1, () => {
        landedAt = Date.now();
        setTimeout(() => turn("lap", -1), 30);
      });
      turn("lap", 2);
      await untilIdle();

      expect(sim.calls).toEqual(["nextLap", "setPlaySpeed 1 false"]);
      // One hold is three reads 50 ms apart; a second would put the playback step 100 ms later still.
      expect(sends[0].at - landedAt).toBeLessThan(HOLD_ONE_MS + 50);
      expect(sim.thrown).toBe(0);
    });

    it("settles a search that has not landed within the patience by a jump, then sends it once more once that has held", async () => {
      let lost = true;

      setUp({
        searches: {
          nextLap: (f) => {
            if (lost) {
              lost = false;

              return null;
            }

            return f + 3_000;
          },
        },
      });

      const sends = trackSends(["nextLap", "setPlayPosition"]);

      turn("lap", 1);
      await untilIdle();

      expect(sim.calls).toEqual(["nextLap", `setPlayPosition 0 ${START + 1}`, "nextLap"]);
      // The patience: three seconds from a frame far from the end of a six-hour tape.
      expect(sends[1].at - sends[0].at).toBeGreaterThanOrEqual(SEARCH_PATIENCE_MAX_MS);
      expect(sends[1].at - sends[0].at).toBeLessThan(SEARCH_PATIENCE_MAX_MS + 100);
      // The retry waits for the settle jump's landing (about 20 ms) and its three reads.
      expect(sends[2].at - sends[1].at).toBeGreaterThanOrEqual(120);
      expect(sim.frame()).toBe(START + 1 + 3_000);
      expect(sim.thrown).toBe(0);
      expect(runEnds()).toEqual(["jump-landed"]);
    });

    it("settles again after a second search that does not land, drops the rest and sends no playback step", async () => {
      setUp({ searches: {} });
      setting("play");
      turn("lap", 3);
      await untilIdle();

      expect(sim.calls).toEqual([
        "nextLap",
        `setPlayPosition 0 ${START + 1}`,
        "nextLap",
        `setPlayPosition 0 ${START + 2}`,
      ]);
      expect(sim.thrown).toBe(0);
      expect(runEnds()).toEqual(["walk-gave-up"]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("ends with nothing more sent when the settle jump moves nothing", async () => {
      setUp({ frame: SIX_HOURS - 6_000, searches: {} });
      vi.mocked(sim.replay.setPlayPosition).mockImplementation((mode: number, frame: number) => {
        sim.calls.push(`setPlayPosition ${mode} ${frame}`);

        return true;
      });
      turn("lap", 2);
      await untilIdle();
      await wait(5_000);

      expect(sim.calls).toEqual(["nextLap", `setPlayPosition 0 ${SIX_HOURS - 6_000 + 1}`]);
      expect(runEnds()).toEqual(["walk-gave-up"]);
    });

    it("waits the same patience at the start of a six-hour recording as of a three-hour one", async () => {
      const patienceAt = async (end: number): Promise<number> => {
        _resetReplaySearchQueue();
        _resetReplayCommandGate();
        _resetReplayCursor();
        _resetReplayPositionState();
        setUp({ frame: 0, end, searches: {} });

        const sends = trackSends(["nextSession", "setPlayPosition"]);

        turn("session", 1);
        await untilIdle();

        return sends[1].at - sends[0].at;
      };

      const six = await patienceAt(SIX_HOURS);
      const three = await patienceAt(SIX_HOURS / 2);

      expect(Math.abs(six - three)).toBeLessThanOrEqual(20);
      expect(six).toBeGreaterThanOrEqual(SEARCH_PATIENCE_MAX_MS);
      expect(six).toBeLessThan(SEARCH_PATIENCE_MAX_MS + 100);
    });

    it("subtracts a turn the other way, carrying the count through zero", async () => {
      setUp({ minSeekMs: 200 });
      turn("lap", 3);
      await until("nextLap");
      turn("lap", -5);

      // Three, one of them on its way, less five: three back once it lands.
      expect(pendingReplaySearch()?.count).toBe(-3);

      await untilIdle();

      expect(sim.calls).toEqual(["nextLap", "prevLap", "prevLap", "prevLap"]);
      expect(sim.frame()).toBe(START + 3_000 - 9_000);
      expect(sim.thrown).toBe(0);
    });

    it("replaces the count for another target: the first run ends superseded and the new one waits for its search", async () => {
      setUp({ minSeekMs: 300 });
      turn("lap", 3, "dial-a");
      await until("nextLap");
      turn("incident", 1, "dial-b");

      expect(runEnds("dial-a")).toEqual(["claim-taken"]);
      expect(pendingReplaySearch()).toEqual({ target: "incident", count: 1, origin: "dial-b" });
      expect(getReplayGateRecord().jump).toMatchObject({ origin: "dial-b" });

      await untilIdle();

      expect(sim.calls).toEqual(["nextLap", "nextIncident"]);
      expect(sim.frame()).toBe(START + 3_000 + 1_000);
      expect(sim.thrown).toBe(0);
      expect(runEnds("dial-b")).toEqual(["jump-landed"]);
    });

    it("warns and drops the rest when the pause never reads back", async () => {
      setUp({ speed: { speed: 4, slowMotion: false }, speedLagMs: 60_000 });
      turn("lap", 3);
      await untilIdle(10_000);

      expect(sim.calls).toEqual(["setPlaySpeed 0"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("the pause never read back"));
      expect(runEnds()).toEqual(["walk-gave-up"]);
    });

    it("ends with nothing more sent when another replay command takes the cursor", async () => {
      setUp();
      turn("lap", 3);
      await until("nextLap");
      await wait(150);
      pressReplayCommand({ kind: "speed", speed: 1, slowMotion: false }, { by: "play-pause", origin: "key" });

      expect(isReplaySearchRunning("lap")).toBe(false);

      await wait(5_000);

      expect(sim.calls).toEqual(["nextLap", "setPlaySpeed 1 false"]);
      expect(runEnds()).toEqual(["claim-taken"]);
      expect(sim.thrown).toBe(0);
    });

    it.each([
      [15, "nextLap"],
      [-15, "prevLap"],
    ])("clamps a turn of %i to ten", async (ticks, call) => {
      setUp({ frame: 200_000 });
      turn("lap", ticks);

      expect(pendingReplaySearch()?.count).toBe(Math.sign(ticks) * SEARCH_QUEUE_MAX);

      await untilIdle();

      expect(sim.calls.filter((c) => c === call)).toHaveLength(SEARCH_QUEUE_MAX);
      expect(sim.calls).toHaveLength(SEARCH_QUEUE_MAX);
    });

    it("clamps what is left after the search on its way, never showing more than ten", async () => {
      setUp({ frame: 200_000, minSeekMs: 300 });
      turn("lap", 1);
      await until("nextLap");
      turn("lap", -15);

      expect(pendingReplaySearch()?.count).toBe(-SEARCH_QUEUE_MAX);

      await untilIdle();

      expect(sim.calls).toEqual(["nextLap", ...Array<string>(SEARCH_QUEUE_MAX).fill("prevLap")]);
      expect(sim.thrown).toBe(0);
    });

    it("pauses a moving replay before awaiting anything when nothing is on its way, and sends no pause on a paused one", async () => {
      setUp({ speed: { speed: 4, slowMotion: false } });
      turn("lap", 1);

      expect(sim.calls).toEqual(["setPlaySpeed 0"]);

      await untilIdle();
      _resetReplaySearchQueue();
      _resetReplayCommandGate();
      _resetReplayCursor();
      _resetReplayPositionState();
      setUp();
      turn("lap", 1);

      expect(sim.calls).toEqual([]);

      await untilIdle();

      expect(sim.calls).toEqual(["nextLap"]);
    });

    it("keeps the dial's pending speed when its turn starts a run, as the dial's own cursor take", async () => {
      _resetReplaySpeedState();
      setUp({ speed: { speed: 2, slowMotion: false }, speedLagMs: 300 });

      // The dial's press pauses the replay, as the surface sends it: its own take keeps the pending speed it then notes.
      const paused = keepDialPendingSpeed(() =>
        pressReplayCommand({ kind: "pause" }, { by: "replay-control-dial press", origin: "dial-a" }),
      );

      expect(paused).toEqual({ kind: "sent", ok: true });
      noteDialSpeedSent({ speed: 0, slowMotion: false }, Date.now());

      // Within the hold a turn starts a run on the paused path, telemetry still showing the 2x from before the press.
      turn("lap", 1);

      expect(isReplaySearchRunning("lap")).toBe(true);
      expect(resolveLiveSpeed({ speed: 2, slowMotion: false }, Date.now())).toEqual({ speed: 0, slowMotion: false });

      await untilIdle();

      expect(sim.thrown).toBe(0);
    });

    it("waits behind a key's search for its landing, then pauses a replay it left playing", async () => {
      setUp({ speed: { speed: 4, slowMotion: false }, minSeekMs: 400 });
      pressReplayCommand({ kind: "search", search: "nextSession" }, { by: "next-session", origin: "key" });
      turn("lap", 1);

      expect(sim.calls).toEqual(["nextSession"]);

      await untilIdle();

      expect(sim.calls.slice(0, 3)).toEqual(["nextSession", "setPlaySpeed 0", "nextLap"]);
      expect(sim.thrown).toBe(0);
    });

    it("waits behind a key's search on a paused replay and sends no pause", async () => {
      setUp({ minSeekMs: 400 });

      const sends = trackSends(["nextSession", "nextLap"]);

      pressReplayCommand({ kind: "search", search: "nextSession" }, { by: "next-session", origin: "key" });
      turn("lap", 1);
      await untilIdle();

      expect(sim.calls).toEqual(["nextSession", "nextLap"]);
      expect(sends[1].at - (sends[0].at + 400)).toBeGreaterThanOrEqual(100);
      expect(sim.thrown).toBe(0);
    });

    it("settles a key's search by a jump once its patience has run out, and sends no pause of its own", async () => {
      // Across most of six hours: about ten seconds of seeking, more than the patience.
      setUp({ searches: { ...STEPS, nextSession: () => SIX_HOURS - 1_000 } });
      pressReplayCommand({ kind: "search", search: "nextSession" }, { by: "next-session", origin: "key" });
      turn("lap", 1);
      await untilIdle();

      expect(sim.calls).toEqual(["nextSession", `setPlayPosition 0 ${START + 1}`, "nextLap"]);
      expect(sim.thrown).toBe(0);
    });

    it("gives back the speed the replay had when a key's search went out, not what it read behind it", async () => {
      setUp({ speed: HALF, minSeekMs: 400 });
      pressReplayCommand({ kind: "search", search: "nextSession" }, { by: "next-session", origin: "key" });
      turn("lap", 1);
      await untilIdle();

      expect(sim.calls).toEqual(["nextSession", "setPlaySpeed 0", "nextLap", "setPlaySpeed 2 true"]);
      expect(sim.thrown).toBe(0);
    });

    it("waits for a record jump's frame before anything else when it took the cursor from it", async () => {
      setUp();

      const sends = trackSends(["setPlayPosition", "nextLap"]);

      recordJump(160_000);
      turn("lap", 1);

      expect(sim.calls).toEqual(["setPlayPosition 0 160000"]);

      await untilIdle();

      expect(sim.calls).toEqual(["setPlayPosition 0 160000", "nextLap"]);
      // The jump of 110000 frames lands after about 900 ms; the search goes out three reads after that.
      expect(sends[1].at - sends[0].at).toBeGreaterThanOrEqual(900 + 100);
      expect(sim.frame()).toBe(163_000);
      expect(sim.thrown).toBe(0);
    });

    it("waits in a live session behind a record jump seeking past the controller's grace, then steps and applies the playback", async () => {
      setUp();
      setting("play");

      // A live session's controller: the replay is given up a second after telemetry stops reading as one.
      let notReplaySince: number | null = null;
      const liveInReplay = (): boolean => {
        if (sim.telemetry().IsReplayPlaying === true) {
          notReplaySince = null;

          return true;
        }

        notReplaySince ??= Date.now();

        return Date.now() - notReplaySince < 1_000;
      };

      _configureReplayCommandGate({
        replay: () => sim.replay,
        readTelemetry: () => sim.telemetry(),
        inReplay: liveInReplay,
        connected: () => true,
        now: () => Date.now(),
      });
      _configureReplaySearchQueue({ readTelemetry: () => sim.telemetry(), inReplay: liveInReplay });

      // 350000 frames: about 2.9 s of seeking. The turn comes once the controller has given the replay up.
      recordJump(400_000);
      await wait(1_200);

      expect(liveInReplay()).toBe(false);

      turn("lap", 1);
      await wait(500);

      expect(isReplaySearchRunning("lap")).toBe(true);

      await untilIdle();

      expect(sim.calls).toEqual(["setPlayPosition 0 400000", "nextLap", "setPlaySpeed 1 false"]);
      expect(sim.frame()).toBe(403_000);
      expect(sim.thrown).toBe(0);
      expect(runEnds()).toEqual(["jump-landed"]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("goes on behind a takeover whose jump lands a few frames off, as the gate counts it landed", async () => {
      // The takeover jumps to the frame beside the reading, which rests three frames past it.
      setUp({
        searches: { ...STEPS, nextSession: (f) => f + 600_000 },
        unlandable: new Set([START + 1]),
        unlandableRest: START + 4,
      });

      const key = { by: "next-session", origin: "key" };

      pressReplayCommand({ kind: "search", search: "nextSession" }, key);
      await wait(50);
      pressReplayCommand({ kind: "speed", speed: 1, slowMotion: false }, { by: "play-pause", origin: "key" });

      expect(
        pressReplayCommand({ kind: "speed", speed: 1, slowMotion: false }, { by: "play-pause", origin: "key" }),
      ).toMatchObject({ kind: "taking-over" });
      expect(getReplayGateRecord().target?.frame).toBe(START + 1);

      turn("lap", 1);
      await untilIdle();

      // The run takes the play that waited behind the takeover as its speed, and gives it at the end.
      expect(sim.calls).toEqual(["nextSession", `setPlayPosition 0 ${START + 1}`, "nextLap", "setPlaySpeed 1 false"]);
      expect(sim.frame()).toBeGreaterThanOrEqual(START + 4 + 3_000);
      expect(sim.thrown).toBe(0);
      expect(runEnds()).toEqual(["jump-landed"]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("gives up with nothing sent when the record jump's frame never reads back", async () => {
      setUp({ unlandable: new Set([160_000]), unlandableRest: 170_000 });
      recordJump(160_000);
      turn("lap", 1);
      await untilIdle(10_000);

      expect(sim.calls).toEqual(["setPlayPosition 0 160000"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("did not land on frame 160000"));
      expect(runEnds()).toEqual(["walk-gave-up"]);
    });

    it("still sees a record jump's seek go out, and its frame arrive, when it started before that jump's pause showed", async () => {
      setUp({ speed: PLAYING, speedLagMs: 200 });
      recordJump(160_000);

      expect(sim.calls).toEqual(["setPlaySpeed 0"]);

      turn("lap", 1);
      await untilIdle();

      // One pause, the record jump's; the runner then steps from the landing and gives back the speed it had.
      expect(sim.calls).toEqual(["setPlaySpeed 0", "setPlayPosition 0 160000", "nextLap", "setPlaySpeed 1 false"]);
      expect(sim.thrown).toBe(0);
    });

    it("sends the pause after an inherited landing, never before it", async () => {
      setUp({ speed: PLAYING });
      // Sent bare into a playing replay: it records no target, and the replay plays on from its landing.
      pressReplayCommand({ kind: "jump", frame: 160_000 }, { by: "set-play-position" });
      turn("lap", 1);

      expect(sim.calls).toEqual(["setPlayPosition 0 160000"]);

      await untilIdle();

      expect(sim.calls.slice(0, 3)).toEqual(["setPlayPosition 0 160000", "setPlaySpeed 0", "nextLap"]);
      expect(sim.thrown).toBe(0);
    });

    it("says a lap run is under way, so a Lap turn goes to the count and not to the record", async () => {
      setUp();
      turn("lap", 2);

      expect(isReplaySearchRunning("lap")).toBe(true);
      expect(isReplaySearchRunning("session")).toBe(false);

      await untilIdle();

      expect(isReplaySearchRunning("lap")).toBe(false);
    });

    it("shares the one runner between two dials, the run keeping the token of the dial that started it", async () => {
      setUp();
      turn("lap", 2, "dial-a");
      turn("lap", 1, "dial-b");

      expect(pendingReplaySearch()).toEqual({ target: "lap", count: 3, origin: "dial-a" });

      await until("nextLap");

      expect(getReplayGateRecord().search?.origin).toBe("dial-a");

      await untilIdle();

      expect(sim.calls).toEqual(["nextLap", "nextLap", "nextLap"]);
      expect(runEnds("dial-b")).toEqual([]);
    });

    it("ends on a pause pressed during the run, with nothing sent for it", async () => {
      setUp({ speed: { speed: 4, slowMotion: false }, minSeekMs: 300 });
      turn("lap", 3);
      await until("nextLap");

      expect(pressReplayCommand({ kind: "pause" }, { by: "play-pause", origin: "key" })).toMatchObject({
        kind: "not-sent",
      });

      await wait(3_000);

      expect(sim.calls).toEqual(["setPlaySpeed 0", "nextLap"]);
      expect(pendingReplaySearch()).toBeNull();
      expect(runEnds()).toEqual(["claim-taken"]);
      expect(sim.thrown).toBe(0);
    });

    it("tells its listeners of every change of the count and of the run's end", async () => {
      setUp();

      const heard: (number | null)[] = [];
      const unsubscribe = onReplaySearchChange(() => heard.push(pendingReplaySearch()?.count ?? null));

      turn("lap", 2);
      turn("lap", -1);
      await untilIdle();
      unsubscribe();
      turn("lap", 1);

      expect(heard[0]).toBe(2);
      expect(heard[1]).toBe(1);
      expect(heard.at(-1)).toBeNull();
      expect(heard.filter((c) => c === null)).toHaveLength(1);
    });

    it("tells its speed listeners of the pause it sends and of the speed the playback step leaves", async () => {
      setUp({ speed: { speed: 4, slowMotion: false } });
      setting("play");

      const heard: { speed: number; slowMotion: boolean }[] = [];
      const unsubscribe = onReplaySearchSpeedSent((speed) => heard.push(speed));

      turn("lap", 1);

      expect(heard).toEqual([{ speed: 0, slowMotion: false }]);

      await untilIdle();
      unsubscribe();

      expect(sim.calls).toEqual(["setPlaySpeed 0", "nextLap", "setPlaySpeed 1 false"]);
      expect(heard).toEqual([
        { speed: 0, slowMotion: false },
        { speed: 1, slowMotion: false },
      ]);
    });

    it("gives the speed a superseded run captured back at the end of the run that replaced it", async () => {
      setUp({ speed: { speed: 4, slowMotion: false }, minSeekMs: 300 });
      turn("lap", 1, "dial-a");
      await until("nextLap");
      turn("incident", 1, "dial-b");
      await untilIdle();

      // The lap run paused the replay at 4x; its search was on its way, which read paused when it went out.
      expect(sim.calls).toEqual(["setPlaySpeed 0", "nextLap", "nextIncident", "setPlaySpeed 4 false"]);
      expect(sim.thrown).toBe(0);
    });

    it("ends with no give-up when the replay is left during the run", async () => {
      setUp();
      turn("lap", 3);
      await until("nextLap");
      inReplay = false;
      await untilIdle(5_000);

      expect(sim.calls).toEqual(["nextLap"]);
      expect(runEnds()).toEqual(["claim-taken"]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("catches a failure inside the runner, ends the run and hands the cursor back", async () => {
      setUp();

      let reads = 0;

      _configureReplaySearchQueue({
        readTelemetry: () => sim.telemetry(),
        inReplay: () => {
          reads++;

          if (reads > 1) throw new Error("the replay state failed");

          return true;
        },
      });
      turn("lap", 1);
      await wait(500);

      expect(pendingReplaySearch()).toBeNull();
      expect(currentReplayCursorOwner()).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("the replay state failed"));
      expect(runEnds()).toEqual(["walk-gave-up"]);
    });
  });

  describe("the patience", () => {
    it("is the gate's figure, never under 1.6 s and never over the cap", () => {
      expect(replaySearchPatienceMs(21_000)).toBe(SEARCH_PATIENCE_MAX_MS);
      expect(replaySearchPatienceMs(10_000)).toBe(SEARCH_PATIENCE_MAX_MS);
      expect(replaySearchPatienceMs(2_200)).toBe(2_200);
      expect(replaySearchPatienceMs(500)).toBe(SEARCH_PATIENCE_MIN_MS);
    });

    it("is still 1.6 s with the Fastest Lap Search Delay at its minimum", () => {
      setting("remember", { fastestLapSearchDelayMs: 50 });

      expect(replaySearchPatienceMs(200)).toBe(SEARCH_PATIENCE_MIN_MS);
    });

    it("takes the walk's wait in place of either bound where that is the longer", () => {
      setting("remember", { fastestLapSearchDelayMs: 1_000 });

      expect(replaySearchPatienceMs(500)).toBe(4_000);
      expect(replaySearchPatienceMs(21_000)).toBe(4_000);
    });
  });

  describe("the first search on a playing replay", () => {
    it.each([
      ["at 1x forward, a step on", PLAYING, "lap", 1, "nextLap"],
      ["at 1x in reverse, a step back", REVERSE, "lap", -1, "prevLap"],
      ["at 1x forward, an incident back", PLAYING, "incident", -1, "prevIncident"],
      ["at 1x in reverse, a session back", REVERSE, "session", -1, "prevSession"],
    ] as const)(
      "%s: goes out before any pause, and a landing at zero under Remember sends nothing more",
      async (_name, speed, target, ticks, call) => {
        setUp({ frame: 200_000, speed });
        turn(target, ticks);

        expect(sim.calls).toEqual([call]);

        await untilIdle();

        expect(sim.calls).toEqual([call]);
        expect(sim.thrown).toBe(0);
        expect(runEnds()).toEqual(["jump-landed"]);
      },
    );

    it("in slow motion: goes out before any pause, and the playback step puts back the speed the search cleared", async () => {
      setUp({ speed: HALF });
      turn("lap", 1);

      expect(sim.calls).toEqual(["nextLap"]);

      await untilIdle();

      expect(sim.calls).toEqual(["nextLap", "setPlaySpeed 2 true"]);
      expect(sim.speed()).toEqual(HALF);
    });

    it("ends on found nothing with nothing more sent: no pause, no playback step, and the run gave up", async () => {
      setUp({ speed: PLAYING, searches: {} });
      setting("stopped");
      turn("incident", 1);
      await untilIdle(2_000);

      expect(sim.calls).toEqual(["nextIncident"]);
      expect(sim.speed()).toEqual(PLAYING);
      expect(runEnds()).toEqual(["walk-gave-up"]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("waits past the patience for a search seen on its way, and it lands", async () => {
      setUp({ speed: PLAYING, minSeekMs: 6_000 });
      turn("session", 1);
      await wait(SEARCH_PATIENCE_MAX_MS + 2_000);

      expect(isReplaySearchRunning("session")).toBe(true);

      await untilIdle();

      expect(sim.calls).toEqual(["nextSession"]);
      expect(runEnds()).toEqual(["jump-landed"]);
    });

    it("goes on with a turn made while the landing at zero holds: pauses, steps, then the playback step", async () => {
      setUp({ frame: 200_000, speed: PLAYING });
      onLanding(1, () => setTimeout(() => turn("lap", 1), 30));
      turn("lap", 1);
      await untilIdle();

      expect(sim.calls).toEqual(["nextLap", "setPlaySpeed 0", "nextLap", "setPlaySpeed 1 false"]);
      expect(sim.thrown).toBe(0);
      expect(runEnds()).toEqual(["jump-landed"]);
    });

    it("applies the playback step on a landing at zero, with no pause sent", async () => {
      setUp({ speed: PLAYING });
      setting("stopped");
      turn("lap", 1);
      await untilIdle();

      expect(sim.calls).toEqual(["nextLap", "setPlaySpeed 0 false"]);
    });

    it("pauses on a landing with the count not at zero, jumps back to the frame it first read before a lap step against the play, then steps paused", async () => {
      setUp({ speed: PLAYING });
      turn("lap", 1);

      expect(sim.calls).toEqual(["nextLap"]);

      turn("lap", -2);
      await untilIdle();

      expect(sim.calls).toEqual([
        "nextLap",
        "setPlaySpeed 0",
        expect.stringMatching(/^setPlayPosition 0 \d+$/),
        "prevLap",
        "prevLap",
        "setPlaySpeed 1 false",
      ]);

      const back = Number(sim.calls[2].split(" ")[2]);

      expect(back).toBeGreaterThanOrEqual(START + 3_000);
      expect(back).toBeLessThanOrEqual(START + 3_003);
      expect(sim.frame()).toBe(back - 6_000);
      expect(sim.thrown).toBe(0);
    });

    it("sends no jump back when the pause left a slow replay on the frame the landing first read, and steps on promptly", async () => {
      // The fake's search clears slow motion, so the replay stands on the landing frame by landing on the tape's
      // last frame: the frame the slow replay iRacing leaves would still show when the pause reads back.
      setUp({ speed: { speed: 16, slowMotion: true }, end: START + 3_000 });

      // A jump to the frame on screen moves nothing and shows no seek, so it could never read back.
      const setPlayPosition = vi.mocked(sim.replay.setPlayPosition);
      const original = setPlayPosition.getMockImplementation();

      if (original === undefined) throw new Error("no setPlayPosition on the fake");

      setPlayPosition.mockImplementation((mode, frame) => {
        if (frame === sim.frame()) {
          sim.calls.push(`setPlayPosition ${mode} ${frame}`);

          return true;
        }

        return original(mode, frame);
      });

      const sends = trackSends(["setPlaySpeed", "prevLap"]);

      turn("lap", 1);
      turn("lap", -2);
      await untilIdle(10_000);

      expect(sim.calls).toEqual(["nextLap", "setPlaySpeed 0", "prevLap", "prevLap", "setPlaySpeed 16 true"]);
      // The first step back goes out on the pause's held read-back, not at a give-up.
      expect(sends[1].name).toBe("prevLap");
      expect(sends[1].at - sends[0].at).toBeLessThan(500);
      expect(sim.frame()).toBe(START + 3_000 - 6_000);
      expect(sim.thrown).toBe(0);
      expect(warn).not.toHaveBeenCalled();
      expect(runEnds()).toEqual(["jump-landed"]);
    });

    it.each([
      [
        "a lap step in the direction of play",
        "lap",
        [2],
        ["nextLap", "setPlaySpeed 0", "nextLap", "setPlaySpeed 1 false"],
      ],
      [
        "an incident step against it",
        "incident",
        [1, -2],
        ["nextIncident", "setPlaySpeed 0", "prevIncident", "prevIncident", "setPlaySpeed 1 false"],
      ],
    ] as const)("sends no jump back for %s", async (_name, target, turns, calls) => {
      setUp({ speed: PLAYING });

      for (const ticks of turns) turn(target, ticks);

      await untilIdle();

      expect(sim.calls).toEqual(calls);
      expect(sim.thrown).toBe(0);
    });

    it("pauses first for a lap step against the direction of play", async () => {
      setUp({ speed: PLAYING });
      turn("lap", -1);

      expect(sim.calls).toEqual(["setPlaySpeed 0"]);

      await untilIdle();

      expect(sim.calls.slice(0, 2)).toEqual(["setPlaySpeed 0", "prevLap"]);
    });

    it("pauses first at 2x", async () => {
      setUp({ speed: { speed: 2, slowMotion: false } });
      turn("incident", 1);

      expect(sim.calls).toEqual(["setPlaySpeed 0"]);

      await untilIdle();

      expect(sim.calls.slice(0, 2)).toEqual(["setPlaySpeed 0", "nextIncident"]);
    });

    it("ends with a warning and nothing sent when a search is still seen on its way at the two-minute ceiling", async () => {
      setUp({ speed: PLAYING, minSeekMs: 130_000 });
      turn("session", 1);
      await wait(125_000);

      expect(pendingReplaySearch()).toBeNull();
      expect(sim.calls).toEqual(["nextSession"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("never landed"));
      expect(runEnds()).toEqual(["walk-gave-up"]);
    });
  });

  describe("the origin token", () => {
    it("rides on the runner's replay jump, every search it sends and its settle jumps", async () => {
      setUp({ searches: {}, minSeekMs: 300 });
      turn("lap", 1);

      expect(getReplayGateRecord().jump).toMatchObject({ owner: "replay-control-dial lap", origin: "dial-a" });

      await until("nextLap");

      expect(getReplayGateRecord().search?.origin).toBe("dial-a");

      await untilIdle();

      expect(new Set(notices.map((n) => n.origin))).toEqual(new Set(["dial-a"]));
    });
  });
});
