/**
 * The paced search reads the gate's verdicts rather than keeping its own
 * (#1450): the frame a playing landing first read is the one the gate judged
 * the search on, and behind a jump of the plugin's the run reads how the gate
 * ended its target instead of inferring it from when the target left the
 * record. Against the fake replay of the gate's tests, as
 * `replay-search-queue.test.ts` is; the gate is the real one, seen through a
 * mock that only records what it answers, or stands in for one verdict where
 * a case says so.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import {
  getReplayGateRecord,
  pressReplayCommand,
  type ReplayGateNotice,
  type ReplaySearchLanding,
  type ReplayTargetFate,
  subscribeReplayGate,
} from "./replay-command-gate.js";
import { fakeReplay, type FakeReplay, type FakeReplayOptions } from "./replay-command-gate.test-support.js";
import { _configureReplayEngine } from "./replay-engine-env.js";
import { resetEngine } from "./replay-engine-reset.test-support.js";
import { pendingReplaySearch, queueReplaySearch, type ReplaySearchTarget } from "./replay-search-queue.js";

/** What the mocked gate records, and the one verdict a case may stand in for. */
const gate = vi.hoisted(() => ({
  /** Every landing the runner's search waits resolved with, in order. */
  landings: [] as ReplaySearchLanding[],
  /** Stands in for the gate's fate of a target; null reads the gate's own. */
  fate: null as ((id: number, real: (id: number) => ReplayTargetFate | null) => ReplayTargetFate | null) | null,
}));

vi.mock("./replay-command-gate.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./replay-command-gate.js")>();

  return {
    ...real,
    replayTargetFate: (id: number) =>
      gate.fate === null ? real.replayTargetFate(id) : gate.fate(id, real.replayTargetFate),
    waitForReplaySearchLanding: (options: Parameters<typeof real.waitForReplaySearchLanding>[0]) =>
      real.waitForReplaySearchLanding(options).then((landing) => {
        gate.landings.push(landing);

        return landing;
      }),
  };
});

const mockSettings = vi.fn((): Record<string, unknown> => ({}));

const engineSetting = (key: string): unknown => (mockSettings() as Record<string, unknown> | undefined)?.[key];

const engineSettings = {
  replayJumpPlayback: () => engineSetting("replayJumpPlayback"),
  fastestLapSearchDelayMs: () => engineSetting("fastestLapSearchDelayMs"),
};

const START = 50_000;
const PLAYING = { speed: 1, slowMotion: false } as const;
const PLAY = { kind: "speed", speed: 1, slowMotion: false } as const;

/** Every search lands a lap or an incident on from where it is sent; a session search finds nothing. */
const STEPS: NonNullable<FakeReplayOptions["searches"]> = {
  nextLap: (f) => f + 3_000,
  prevLap: (f) => f - 3_000,
  nextIncident: (f) => f + 1_000,
  prevIncident: (f) => f - 1_000,
};

/** What iRacing reports for the whole of a position jump under way. */
const SEEKING = {
  IsReplayPlaying: false,
  IsOnTrack: false,
  ReplayFrameNum: 0,
  ReplayPlaySpeed: 0,
  ReplayPlaySlowMotion: false,
  SessionNum: -1,
} as TelemetryData;

let sim: FakeReplay;
let notices: ReplayGateNotice[];
let warn: Mock<(message: string) => void>;

const engineRootLogger: ILogger = {
  ...silentLogger,
  createScope: (scope) =>
    scope === "ReplaySearch" ? { ...silentLogger, warn: (message) => warn(message) } : silentLogger,
};

/** The engine over the fake replay; `readTelemetry` replaces the fake's own reading for a case. */
function configure(readTelemetry: () => TelemetryData = () => sim.telemetry()): void {
  _configureReplayEngine({
    settings: engineSettings,
    logger: engineRootLogger,
    replay: () => sim.replay,
    readTelemetry,
    inReplay: () => true,
    connected: () => true,
    now: () => Date.now(),
  });
}

function setUp(options: FakeReplayOptions = {}): void {
  sim = fakeReplay({ frame: START, searches: STEPS, ...options });
  configure();
  notices = [];
  subscribeReplayGate((notice) => notices.push(notice));
}

function turn(target: ReplaySearchTarget, ticks: number): void {
  queueReplaySearch({ target, ticks, origin: "dial-a", owner: `replay-control-dial ${target}` });
}

async function untilIdle(maxMs = 30_000): Promise<void> {
  for (let waited = 0; waited < maxMs && pendingReplaySearch() !== null; waited += 20) {
    await vi.advanceTimersByTimeAsync(20);
  }

  expect(pendingReplaySearch()).toBeNull();
}

/** How the run ended, as its replay jump reported it to the gate's state seam. */
function runEnds(): string[] {
  return notices
    .filter((n) => n.origin === "dial-a")
    .flatMap((n) => n.ended.map((e) => e.reason))
    .filter((reason) => reason === "jump-landed" || reason === "walk-gave-up" || reason === "claim-taken");
}

/**
 * A key's search on a paused replay, then a second key press: the gate takes
 * over with a jump to the frame beside the reading, which rests three frames
 * past it, so only the gate's moved-and-held judgement lands it. Its target
 * and its takeover share one deadline, 3 s, on this short tape. Returns the
 * takeover's target id and the time it went out.
 */
async function takeOver(): Promise<{ id: number; at: number }> {
  setUp({ end: START + 10_000, unlandable: new Set([START + 1]), unlandableRest: START + 4 });
  pressReplayCommand({ kind: "search", search: "nextSession" }, { by: "next-session", origin: "key" });
  await vi.advanceTimersByTimeAsync(50);
  pressReplayCommand(PLAY, { by: "play-pause", origin: "key" });

  expect(pressReplayCommand(PLAY, { by: "play-pause", origin: "key" })).toMatchObject({ kind: "taking-over" });

  const target = getReplayGateRecord().target;

  expect(target).toMatchObject({ frame: START + 1, giveUpMs: 3_000 });

  return { id: target?.id ?? -1, at: Date.now() };
}

describe("the paced search reads the gate (#1450)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    mockSettings.mockReturnValue({ replayJumpPlayback: "remember" });
    warn = vi.fn<(message: string) => void>();
    gate.landings = [];
    gate.fate = null;
    resetEngine({ settings: engineSettings, logger: engineRootLogger });
  });

  afterEach(() => {
    gate.fate = null;
    resetEngine({ settings: engineSettings });
    vi.useRealTimers();
  });

  it("jumps back to the frame the gate noted as the landing's first, not to a leap before it that did not hold", async () => {
    setUp({ speed: PLAYING });

    const sentAt = Date.now();

    // The lap search lands on 53000 33 ms after the send. The first read after that, 40 ms after it, shows the
    // replay 500 frames short of the landing; from the next read on, the landing and playback from it.
    configure(() => {
      const reading = sim.telemetry();

      return Date.now() - sentAt === 40 ? { ...reading, ReplayFrameNum: (reading.ReplayFrameNum ?? 0) - 500 } : reading;
    });
    turn("lap", 1);
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

    expect(gate.landings[0]).toEqual({ outcome: "landed", firstFrame: back });
    // 60 ms after the send: 27 ms of play from 53000. The read that did not hold was 52500.
    expect(back).toBe(53_001);
    expect(sim.thrown).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("goes on behind a takeover that landed in the gate's last poll before its deadline, read after it", async () => {
    const { at } = await takeOver();

    // The takeover's jump shows as a seek until 70 ms before its deadline, and its landing has held 10 ms before
    // it, between two of the runner's reads 50 ms apart: the run first sees the target gone at the deadline.
    configure(() => (Date.now() < at + 2_930 ? SEEKING : sim.telemetry()));
    turn("lap", 1);
    await untilIdle();

    // The run takes the play that waited behind the takeover as its speed, and gives it back at the end.
    expect(sim.calls).toEqual(["nextSession", `setPlayPosition 0 ${START + 1}`, "nextLap", "setPlaySpeed 1 false"]);
    expect(sim.frame()).toBe(START + 4 + 3_000);
    expect(warn).not.toHaveBeenCalled();
    expect(runEnds()).toEqual(["jump-landed"]);
  });

  it("gives up behind a takeover the gate says moved nothing, however early it left the record", async () => {
    // The gate's takeovers today share their target's deadline, which it judges first, so one that moves nothing
    // ends as given up; the verdict stands in here for one recorded where the two clocks differ.
    const { id } = await takeOver();

    gate.fate = (fateOf, real) => (fateOf === id ? { kind: "nothing-moved" } : real(fateOf));
    turn("lap", 1);
    await untilIdle();

    expect(sim.calls).toEqual(["nextSession", `setPlayPosition 0 ${START + 1}`]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`did not land on frame ${START + 1} (reads ${START + 4})`),
    );
    expect(runEnds()).toEqual(["walk-gave-up"]);
  });

  it("goes on behind a target replaced by one that read back, and gives up behind one a go to start or end replaced", async () => {
    const landed = { kind: "read-back", held: true, telemetry: SEEKING } as const;
    const { id } = await takeOver();

    gate.fate = (fateOf, real) =>
      fateOf === id ? { kind: "replaced", by: id + 1_000 } : fateOf === id + 1_000 ? landed : real(fateOf);
    turn("lap", 1);
    await untilIdle();

    expect(sim.calls).toEqual(["nextSession", `setPlayPosition 0 ${START + 1}`, "nextLap", "setPlaySpeed 1 false"]);
    expect(runEnds()).toEqual(["jump-landed"]);

    resetEngine({ settings: engineSettings, logger: engineRootLogger });

    const second = await takeOver();

    gate.fate = (fateOf, real) => (fateOf === second.id ? { kind: "replaced", by: null } : real(fateOf));
    turn("lap", 1);
    await untilIdle();

    expect(sim.calls).toEqual(["nextSession", `setPlayPosition 0 ${START + 1}`]);
    expect(runEnds()).toEqual(["walk-gave-up"]);
  });
});
