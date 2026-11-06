import { REPLAY_EXIT_GRACE_MS, type TelemetryData } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pressReplayCommand, replaySearchMayRunMs } from "./replay-command-gate.js";
import { fakeReplay, type FakeReplay, type FakeReplayOptions } from "./replay-command-gate.test-support.js";
import { _configureReplayEngine, type ReplayEngineController } from "./replay-engine-env.js";
import { resetEngine } from "./replay-engine-reset.test-support.js";
import { pendingReplayTarget, REPLAY_TARGET_GIVE_UP_MS, replayTargetGiveUpMs } from "./replay-position-state.js";
import { steppedReplayState } from "./replay-state.test-support.js";

/**
 * The gate tells the SDK's debounced replay state how long a seek of its own
 * still holds the replay (#1429): while iRacing carries out a seek the ticks
 * read as the car until the cursor lands, which outlasts the one-second exit
 * grace on a long jump.
 */

const engineSettings: { replayJumpPlayback(): unknown; fastestLapSearchDelayMs(): unknown } = {
  replayJumpPlayback: () => undefined,
  fastestLapSearchDelayMs: () => undefined,
};

const LIVE_SESSION = { WeekendInfo: { SimMode: "full" } };

let sim: FakeReplay;
let connected: boolean;
/** The remaining time of every hold the gate told, null for a release. */
let holds: (number | null)[];
/** The cap past the last sighting told with each, null for a release. */
let caps: (number | null)[];

/** The gate over a fake replay, with every hold it tells recorded in {@link holds}. */
function setUp(options: FakeReplayOptions = {}): FakeReplay {
  sim = fakeReplay(options);
  holds = [];
  caps = [];
  _configureReplayEngine({
    settings: engineSettings,
    replay: () => sim.replay,
    readTelemetry: () => sim.telemetry(),
    inReplay: () => true,
    connected: () => connected,
    seekHold: (hold) => {
      holds.push(hold?.remainingMs ?? null);
      caps.push(hold?.maxPastSightingMs ?? null);
    },
    now: () => Date.now(),
  });

  return sim;
}

function press(command: Parameters<typeof pressReplayCommand>[0], origin = "test") {
  return pressReplayCommand(command, { by: "test", origin });
}

async function wait(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("replay command gate: the replay state's seek hold (#1429)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    resetEngine({ settings: engineSettings });
    connected = true;
  });

  afterEach(() => {
    resetEngine({ settings: engineSettings });
    vi.useRealTimers();
  });

  it("holds for a sent target's own wait, and tells it once while it stands", async () => {
    setUp({ frame: 2_000 });

    press({ kind: "jump", frame: 1_200_000 });

    const target = pendingReplayTarget();

    expect(target).toMatchObject({ sent: true });
    expect(holds).toEqual([target?.giveUpMs]);

    // The poll runs every change under the jump; the hold has not changed, so nothing more is told.
    await wait(2_000);

    expect(pendingReplayTarget()).not.toBeNull();
    expect(holds).toHaveLength(1);
  });

  it("releases the hold when the target reads back", async () => {
    setUp({ frame: 2_000 });

    press({ kind: "jump", frame: 160_000 });
    await wait(5_000);

    expect(pendingReplayTarget()).toBeNull();
    expect(holds).toEqual([expect.any(Number), null]);
  });

  it("tells the remaining wait of a retarget, counted from its own send", async () => {
    setUp({ frame: 2_000 });

    press({ kind: "jump", frame: 1_200_000 });
    await wait(200);
    press({ kind: "jump", frame: 1_100_000 });

    const retarget = pendingReplayTarget();

    expect(holds).toEqual([expect.any(Number), retarget?.giveUpMs]);
  });

  it("releases the hold when the target is given up", async () => {
    // The jump rests a few frames off its target, so it never reads back.
    setUp({ frame: 2_000, unlandable: new Set([160_000]) });

    press({ kind: "jump", frame: 160_000 });

    const giveUpMs = pendingReplayTarget()?.giveUpMs ?? 0;

    await wait(giveUpMs - 100);

    expect(holds).toEqual([giveUpMs]);

    await wait(500);

    expect(pendingReplayTarget()).toBeNull();
    expect(holds).toEqual([giveUpMs, null]);
  });

  it("releases the hold when the sim disconnects with the target standing", async () => {
    setUp({ frame: 2_000 });

    press({ kind: "jump", frame: 1_200_000 });
    connected = false;
    await wait(100);

    expect(pendingReplayTarget()).toBeNull();
    expect(holds).toEqual([expect.any(Number), null]);
  });

  it("releases the hold for a go to end that clears a standing target, and never holds for one", () => {
    setUp({ frame: 2_000 });

    press({ kind: "jump", frame: 1_200_000 });
    press({ kind: "go-to", end: "end" });

    expect(sim.calls.at(-1)).toBe("goToEnd");
    expect(holds).toEqual([expect.any(Number), null]);
  });

  it("tells nothing for a go to end with nothing under way: it leaves the replay, and holds nothing", () => {
    setUp({ frame: 2_000 });

    press({ kind: "go-to", end: "end" });

    expect(sim.calls).toEqual(["goToEnd"]);
    expect(holds).toEqual([]);
  });

  it("holds a search on its way for the time it could be running, and releases it on the landing", async () => {
    setUp({ frame: 2_000, searches: { nextLap: (from) => from + 50_000 } });
    const couldRunMs = replaySearchMayRunMs(sim.telemetry(), 1);

    press({ kind: "search", search: "nextLap" });

    expect(holds).toEqual([couldRunMs]);

    await wait(2_000);

    expect(sim.frame()).toBe(52_000);
    expect(holds).toEqual([couldRunMs, null]);
  });

  it("holds a go to start, which stays in the replay, as a search on its way", () => {
    setUp({ frame: 200_000 });
    const couldRunMs = replaySearchMayRunMs(sim.telemetry(), -1);

    press({ kind: "go-to", end: "start" });

    expect(sim.calls).toEqual(["goToStart"]);
    expect(holds).toEqual([couldRunMs]);
  });

  describe("the cap past the last sighting: the longest seek the tape allows", () => {
    it("is the jump wait across the whole tape, by the last replay reading", () => {
      // Six hours of tape: frame 2 000 with 1 294 000 frames left.
      setUp({ frame: 2_000 });

      press({ kind: "jump", frame: 1_200_000 });

      expect(caps).toEqual([replayTargetGiveUpMs(1_296_000)]);
      expect(caps[0]).toBeGreaterThan(REPLAY_TARGET_GIVE_UP_MS);
    });

    it("is REPLAY_TARGET_GIVE_UP_MS on a short tape", () => {
      setUp({ frame: 2_000, end: 6_000 });
      press({ kind: "jump", frame: 4_000 });

      expect(caps).toEqual([REPLAY_TARGET_GIVE_UP_MS]);
    });

    it("is the jump's own wait when no reading has said how long the tape is", () => {
      const unsized = setUp({ frame: 2_000 });
      const read = unsized.telemetry.bind(unsized);

      vi.spyOn(unsized, "telemetry").mockImplementation(
        () => ({ ...read(), ReplayFrameNumEnd: undefined }) as TelemetryData,
      );
      press({ kind: "jump", frame: 1_200_000 });

      // The tape's own cap would be REPLAY_TARGET_GIVE_UP_MS, and would end the hold long before this jump lands.
      const giveUpMs = pendingReplayTarget()?.giveUpMs;

      expect(giveUpMs).toBeGreaterThan(REPLAY_TARGET_GIVE_UP_MS);
      expect(caps).toEqual([giveUpMs]);
    });

    it("never falls under the own wait of a search on its way, which can pass a short tape's", () => {
      // A short tape: the tape's own cap is REPLAY_TARGET_GIVE_UP_MS, the search's floor the fastest-lap walk's.
      engineSettings.fastestLapSearchDelayMs = () => 2_000;

      try {
        setUp({ frame: 2_000, end: 6_000, searches: { nextLap: (from) => from + 1_000 } });
        const couldRunMs = replaySearchMayRunMs(sim.telemetry(), 1);

        press({ kind: "search", search: "nextLap" });

        expect(couldRunMs).toBeGreaterThan(REPLAY_TARGET_GIVE_UP_MS);
        expect(holds).toEqual([couldRunMs]);
        expect(caps).toEqual([couldRunMs]);
      } finally {
        engineSettings.fastestLapSearchDelayMs = () => undefined;
      }
    });

    it("is told again when it changes though the hold's time does not", async () => {
      let left = 1_294_000;
      const sized = setUp({ frame: 2_000 });
      const read = sized.telemetry.bind(sized);

      vi.spyOn(sized, "telemetry").mockImplementation(() => {
        const t = read();

        return (t.IsReplayPlaying === true ? { ...t, ReplayFrameNumEnd: left } : t) as TelemetryData;
      });
      press({ kind: "search", search: "nextLap" });
      // The tape grew under a live session's replay: the next poll reads it longer, and the cap follows.
      left += 600_000;
      await wait(100);

      expect(holds).toHaveLength(2);
      expect(holds[1]).toBeLessThan(holds[0] ?? 0);
      expect(caps).toEqual([replayTargetGiveUpMs(1_296_000), replayTargetGiveUpMs(1_896_000)]);
    });
  });

  describe("over the SDK's own replay state", () => {
    /** A controller over the fake replay whose debounced state is the SDK's tracker, stepped on each read. */
    function controllerOver(replay: FakeReplay): ReplayEngineController {
      return {
        getCurrentTelemetry: () => replay.telemetry(),
        getSessionInfo: () => LIVE_SESSION as never,
        getConnectionStatus: () => true,
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        ...steppedReplayState(
          (): TelemetryData => replay.telemetry(),
          () => LIVE_SESSION,
        ),
      };
    }

    /** The state, read every 50 ms for `ms`, as the controller's poll would step it. */
    async function readEvery50(controller: ReplayEngineController, ms: number): Promise<boolean[]> {
      const seen: boolean[] = [];

      for (let t = 0; t < ms; t += 50) {
        await wait(50);
        seen.push(controller.getReplayState().inReplay);
      }

      return seen;
    }

    it("keeps a long jump in the replay past the grace, and lands in it", async () => {
      sim = fakeReplay({ frame: 2_000 });
      const controller = controllerOver(sim);

      resetEngine({ settings: engineSettings, controller, replay: () => sim.replay, now: () => Date.now() });
      expect(controller.getReplayState().inReplay).toBe(true);

      press({ kind: "jump", frame: 1_200_000 });

      // About 9.7 s at iRacing's search rate: every read of it is in the replay, the ticks never are.
      expect(sim.telemetry().IsReplayPlaying).toBe(false);
      expect(await readEvery50(controller, REPLAY_EXIT_GRACE_MS * 5)).not.toContain(false);

      await wait(6_000);

      expect(sim.frame()).toBe(1_200_000);
      expect(controller.getReplayState()).toMatchObject({ inReplay: true, frame: 1_200_000 });
      expect(pendingReplayTarget()).toBeNull();
    });

    it("control: without the hold told, the same jump reads as the car once the grace has run out", async () => {
      sim = fakeReplay({ frame: 2_000 });
      const controller = controllerOver(sim);

      resetEngine({
        settings: engineSettings,
        controller,
        replay: () => sim.replay,
        now: () => Date.now(),
        seekHold: () => {},
      });
      expect(controller.getReplayState().inReplay).toBe(true);

      press({ kind: "jump", frame: 1_200_000 });

      expect(await readEvery50(controller, REPLAY_EXIT_GRACE_MS * 5)).toContain(false);
    });
  });
});
