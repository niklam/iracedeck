import {
  initialReplayState,
  nextReplayState,
  replaySeekHeld,
  type ReplayState,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getReplayGateRecord,
  getReplayGateView,
  pressReplayCommand,
  type ReplayGateNotice,
  replaySearchOnItsWay,
  subscribeReplayGate,
} from "./replay-command-gate.js";
import { fakeReplay, type FakeReplay, type FakeReplayOptions } from "./replay-command-gate.test-support.js";
import { resetEngine } from "./replay-engine-reset.test-support.js";
import { beginReplayJump, runReplayJump } from "./replay-jump-playback.js";
import type { ReplaySpeed } from "./replay-jump-speed.js";
import { pendingReplayTarget } from "./replay-position-state.js";
import {
  awaitReplayWalkStart,
  recordedIndexAt,
  type RecordedSpanRule,
  type ReplayWalkDirection,
  ReplayWalkStartDropped,
  resolveReplayWalkAnchor,
  resolveReplayWalkStart,
  type SettledReplayWalkStart,
  walkRecordedEntries,
  walkRecordedIndex,
} from "./replay-record-walk.js";
import { pendingReplaySearch, queueReplaySearch } from "./replay-search-queue.js";
import { steppedReplayState, type SteppedReplayState } from "./replay-state.test-support.js";

/** {@link walkRecordedEntries} over bare frames with no rule — the marker walk — reduced to where it lands. */
function stepFrames(frames: readonly number[], anchor: number, direction: ReplayWalkDirection, steps: number) {
  const walked = walkRecordedEntries(
    frames.map((frame) => ({ frame })),
    anchor,
    direction,
    steps,
  );

  return walked.hit ? { frame: walked.entry.frame, steps: walked.steps } : null;
}

describe("walkRecordedEntries without a rule (the marker walk)", () => {
  const list = [1_000, 2_000, 3_000, 4_000];

  describe("Next: the first landing more than 60 frames past the anchor", () => {
    it("skips an entry 60 frames ahead or less, and takes one 61 ahead", () => {
      expect(stepFrames(list, 1_940, "next", 1)).toEqual({ frame: 3_000, steps: 1 });
      expect(stepFrames(list, 1_939, "next", 1)).toEqual({ frame: 2_000, steps: 1 });
    });

    it("from on an entry goes to the one after it", () => {
      expect(stepFrames(list, 2_000, "next", 1)).toEqual({ frame: 3_000, steps: 1 });
    });

    it("from before the list is its first entry", () => {
      expect(stepFrames(list, 0, "next", 1)).toEqual({ frame: 1_000, steps: 1 });
    });

    it("is a miss past the last entry's window", () => {
      expect(stepFrames(list, 3_940, "next", 1)).toBeNull();
      expect(stepFrames(list, 9_000, "next", 1)).toBeNull();
    });
  });

  describe("Previous: the entry the anchor is in past 120 frames, else the one before", () => {
    it("within 120 frames of an entry goes to the one before it", () => {
      expect(stepFrames(list, 3_000, "previous", 1)).toEqual({ frame: 2_000, steps: 1 });
      expect(stepFrames(list, 3_120, "previous", 1)).toEqual({ frame: 2_000, steps: 1 });
    });

    it("more than 120 frames past an entry goes back to that entry", () => {
      expect(stepFrames(list, 3_121, "previous", 1)).toEqual({ frame: 3_000, steps: 1 });
    });

    it("is a miss before the list, and on its first entry", () => {
      expect(stepFrames(list, 999, "previous", 1)).toBeNull();
      expect(stepFrames(list, 1_050, "previous", 1)).toBeNull();
    });
  });

  describe("steps", () => {
    it("moves further entries after the first step", () => {
      expect(stepFrames(list, 1_000, "next", 2)).toEqual({ frame: 3_000, steps: 2 });
      expect(stepFrames(list, 4_500, "previous", 3)).toEqual({ frame: 2_000, steps: 3 });
    });

    it("stops at either end and reports the steps it took", () => {
      expect(stepFrames(list, 1_500, "next", 10)).toEqual({ frame: 4_000, steps: 3 });
      expect(stepFrames(list, 3_500, "previous", 10)).toEqual({ frame: 1_000, steps: 3 });
    });

    it("zero steps is a miss", () => {
      expect(stepFrames(list, 0, "next", 0)).toBeNull();
      expect(stepFrames(list, 9_000, "previous", 0)).toBeNull();
    });

    it("an empty list is a miss", () => {
      expect(stepFrames([], 0, "next", 1)).toBeNull();
      expect(stepFrames([], 0, "previous", 1)).toBeNull();
    });
  });
});

describe("walkRecordedEntries with a span rule (#1426)", () => {
  /** Entries numbered like laps: consecutive numbers follow each other in the record. */
  type Numbered = { frame: number; n: number };
  const closed: RecordedSpanRule<Numbered> = { adjacent: (a, b) => b.n === a.n + 1, lastSpanOpen: false };
  const open: RecordedSpanRule<Numbered> = { ...closed, lastSpanOpen: true };
  // 1, 2, 3, then a gap, then 7, 8, 9.
  const list: Numbered[] = [1, 2, 3, 7, 8, 9].map((n) => ({ frame: n * 1_000, n }));

  it("steps more than one entry and stops before a gap, reporting the steps it took", () => {
    expect(walkRecordedEntries(list, 1_500, "next", 5, closed)).toMatchObject({ hit: true, index: 2, steps: 2 });
    expect(walkRecordedEntries(list, 8_500, "previous", 5, closed)).toMatchObject({ hit: true, index: 3, steps: 2 });
  });

  it("a first step that would cross a gap is a miss", () => {
    expect(walkRecordedEntries(list, 2_950, "next", 3, closed)).toEqual({ hit: false, reason: "gap in the record" });
    expect(walkRecordedEntries(list, 7_050, "previous", 1, closed)).toEqual({
      hit: false,
      reason: "gap in the record",
    });
  });

  it("an anchor in no recorded span is outside the record", () => {
    // Before the list, in the entry before the gap, and past a closed last entry.
    expect(walkRecordedEntries(list, 500, "next", 1, closed)).toEqual({ hit: false, reason: "outside the record" });
    expect(walkRecordedEntries(list, 3_500, "previous", 1, closed)).toEqual({
      hit: false,
      reason: "outside the record",
    });
    expect(walkRecordedEntries(list, 9_500, "previous", 1, closed)).toEqual({
      hit: false,
      reason: "outside the record",
    });
  });

  it("an open last span takes an anchor past the last entry", () => {
    expect(walkRecordedEntries(list, 9_500, "previous", 1, open)).toMatchObject({ hit: true, index: 5, steps: 1 });
    expect(walkRecordedEntries(list, 9_500, "next", 1, open)).toEqual({ hit: false, reason: "nothing that way" });
  });

  it("without a rule the walk crosses every pair, as Replay Markers always has", () => {
    expect(walkRecordedEntries(list, 2_500, "next", 3)).toMatchObject({ hit: true, index: 4, steps: 3 });
    expect(walkRecordedEntries(list, 500, "next", 1)).toMatchObject({ hit: true, index: 0, steps: 1 });
  });
});

describe("walkRecordedEntries with a landing (#1426)", () => {
  const list = [1_000, 2_000, 3_000].map((frame) => ({ frame }));
  const landing = (entry: { frame: number }) => entry.frame + 120;

  it("Previous measures its window from the landing of the entry the anchor is in", () => {
    // 2 200 is 200 past the start but 80 past the landing: still in the window, so the one before.
    expect(walkRecordedEntries(list, 2_200, "previous", 1, undefined, landing)).toMatchObject({ hit: true, index: 0 });
    expect(walkRecordedEntries(list, 2_241, "previous", 1, undefined, landing)).toMatchObject({ hit: true, index: 1 });
  });

  it("the entry the anchor is in and Next are still found on the recorded frames", () => {
    // Between a start and its landing the anchor is in that entry: Previous goes before it.
    expect(walkRecordedEntries(list, 2_050, "previous", 1, undefined, landing)).toMatchObject({ hit: true, index: 0 });
    expect(walkRecordedEntries(list, 2_050, "next", 1, undefined, landing)).toMatchObject({ hit: true, index: 2 });
    expect(walkRecordedEntries(list, 1_939, "next", 1, undefined, landing)).toMatchObject({ hit: true, index: 1 });
  });

  it("with no landing the windows are the marker ones, on the entry itself", () => {
    expect(walkRecordedEntries(list, 2_120, "previous", 1)).toMatchObject({ hit: true, index: 0 });
    expect(walkRecordedEntries(list, 2_121, "previous", 1)).toMatchObject({ hit: true, index: 1 });
  });
});

describe("walkRecordedIndex", () => {
  it("one step stays on the start and counts one", () => {
    expect(walkRecordedIndex(4, 1, "next", 1)).toEqual({ index: 1, steps: 1 });
    expect(walkRecordedIndex(4, 1, "next", 0)).toEqual({ index: 1, steps: 1 });
  });

  it("clamps at either end and counts only what it moved", () => {
    expect(walkRecordedIndex(4, 1, "next", 9)).toEqual({ index: 3, steps: 3 });
    expect(walkRecordedIndex(4, 1, "previous", 9)).toEqual({ index: 0, steps: 2 });
  });
});

describe("recordedIndexAt", () => {
  it("names the entry at the frame or up to 120 frames past it, else -1", () => {
    expect(recordedIndexAt([1_000, 2_000], 2_120)).toBe(1);
    expect(recordedIndexAt([1_000, 2_000], 2_121)).toBe(-1);
    expect(recordedIndexAt([1_000, 2_000], 999)).toBe(-1);
  });
});

describe("the anchor and the cursor", () => {
  let sim: FakeReplay;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    sim = fakeReplay({ frame: 100_000 });
    resetEngine({
      replay: () => sim.replay,
      readTelemetry: () => sim.telemetry(),
      inReplay: () => true,
      connected: () => true,
      now: () => Date.now(),
    });
  });

  afterEach(() => {
    resetEngine();
    vi.useRealTimers();
  });

  type WalkState = Parameters<typeof resolveReplayWalkStart>[0];

  /** The debounced state with `cursorFrame` as its cursor read (null: none). */
  const stateWith = (cursorFrame: number | null, inReplay = true): WalkState => ({ inReplay, cursorFrame });
  const midSeek = { IsReplayPlaying: false, ReplayFrameNum: 0, SessionNum: -1 } as TelemetryData;

  it("with nothing under way the anchor is the cursor", () => {
    expect(resolveReplayWalkAnchor(100_000, sim.telemetry())).toBe(100_000);
    expect(resolveReplayWalkStart(stateWith(100_000), sim.telemetry())).toEqual({
      frame: 100_000,
      from: "cursor",
    });
  });

  it("a standing target is the anchor, whatever the tick reads", () => {
    pressReplayCommand({ kind: "jump", frame: 900_000 }, { by: "test" });

    expect(pendingReplayTarget()).toMatchObject({ frame: 900_000 });
    expect(resolveReplayWalkAnchor(100_000, sim.telemetry())).toBe(900_000);
    expect(resolveReplayWalkStart(stateWith(null), sim.telemetry())).toEqual({ frame: 900_000, from: "target" });
    // A seek longer than the grace reads like a replay left in a live session; the plugin's jump is still headed there.
    expect(resolveReplayWalkStart(stateWith(null, false), sim.telemetry())).toEqual({
      frame: 900_000,
      from: "target",
    });
  });

  it("a target still anchors after more than a second for as long as its jump holds the cursor", async () => {
    // About eight seconds of seeking at iRacing's rate.
    const jump = beginReplayJump("test-jump", sim.telemetry(), undefined, Date.now(), { frame: 1_100_000 });
    const run = runReplayJump(jump, { frame: 1_100_000, readTelemetry: () => sim.telemetry() }).finally(() =>
      jump.end(),
    );

    await vi.advanceTimersByTimeAsync(4_000);

    expect(sim.busy()).toBe(true);
    expect(resolveReplayWalkAnchor(100_000, sim.telemetry())).toBe(1_100_000);
    expect(resolveReplayWalkStart(stateWith(null, false), sim.telemetry())).toEqual({
      frame: 1_100_000,
      from: "target",
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    expect(pendingReplayTarget()).toBeNull();
    expect(resolveReplayWalkAnchor(sim.frame(), sim.telemetry())).toBe(1_100_000);
  });

  it("with no target, the state's cursor read is the start, whatever the tick reads", () => {
    expect(resolveReplayWalkStart(stateWith(42_000), midSeek)).toEqual({ frame: 42_000, from: "cursor" });
  });

  it("with no target and no cursor read there is no cursor", () => {
    expect(resolveReplayWalkStart(stateWith(null), midSeek)).toEqual({ frame: null, reason: "no cursor" });
  });

  it("with no target, outside a replay there is nothing to step from", () => {
    expect(resolveReplayWalkStart(stateWith(5_000, false), sim.telemetry())).toEqual({
      frame: null,
      reason: "not in a replay",
    });
  });

  describe("over the SDK's own debounced state (#1660)", () => {
    const LIVE_SESSION = { WeekendInfo: { SimMode: "full" } };
    const SAVED_REPLAY = { WeekendInfo: { SimMode: "replay" } };
    const replayTick = (frame: number) =>
      ({ IsReplayPlaying: true, ReplayFrameNum: frame, ReplayFrameNumEnd: 100 }) as TelemetryData;
    const carTick = { IsReplayPlaying: false, ReplayFrameNum: 0, ReplayFrameNumEnd: 900 } as TelemetryData;

    it("a seek hold past the grace with no search gives the held frame", () => {
      // Seen at 0, held for 5 s, the ticks reading as the car meanwhile; read 3 s on, past the grace.
      let state = replaySeekHeld(
        nextReplayState(initialReplayState(), replayTick(500), LIVE_SESSION, 0),
        { untilMs: 5_000, maxPastSightingMs: 60_000 },
        10,
      );

      for (let t = 50; t <= 3_000; t += 50) state = nextReplayState(state, carTick, LIVE_SESSION, t);

      expect(resolveReplayWalkStart(state, midSeek)).toEqual({ frame: 500, from: "cursor" });
    });

    it("a saved replay whose tick reads mid-seek at frame 0 past the grace has no cursor", () => {
      const state = [0, 300, 1_000].reduce(
        (prev, t) => nextReplayState(prev, t === 0 ? replayTick(500) : midSeek, SAVED_REPLAY, t),
        initialReplayState(),
      );

      expect(state).toMatchObject({ inReplay: true, frame: 0 });
      expect(resolveReplayWalkStart(state, midSeek)).toEqual({ frame: null, reason: "no cursor" });
    });

    it("the live edge is never a start", () => {
      const state = nextReplayState(initialReplayState(), carTick, LIVE_SESSION, 0);

      expect(state.frame).toBe(900);
      expect(resolveReplayWalkStart({ ...state, inReplay: true }, carTick)).toEqual({
        frame: null,
        reason: "no cursor",
      });
    });
  });
});

describe("a start while a search of the gate's is on its way (#1660)", () => {
  let sim: FakeReplay;
  let state: SteppedReplayState;
  /** False once the test leaves the replay: the debounced state and the engine read it as gone. */
  let onScreen: boolean;
  /** The engine's word to the controller that the plugin left the replay for live. */
  let leftForLive: ReturnType<typeof vi.fn<() => void>>;
  const ORIGIN = "key-1";

  /** The debounced state as a press reads it: the stepped tracker's, or nothing on screen once the replay is left. */
  const readState = (): ReplayState => {
    const read = state.getReplayState();

    return onScreen ? read : { ...read, inReplay: false, cursorFrame: null };
  };

  /** Where the fake's searches land: Next Session 100 000 frames on, Next Lap a long way on, Next Incident nowhere. */
  function setUp(
    options: { speed?: ReplaySpeed; frame?: number; searches?: FakeReplayOptions["searches"] } = {},
  ): void {
    sim = fakeReplay({
      frame: options.frame ?? 100_000,
      speed: options.speed,
      searches: {
        nextSession: (from) => from + 100_000,
        nextLap: (from) => from + 900_000,
        nextIncident: () => null,
        ...options.searches,
      },
    });
    state = steppedReplayState(() => sim.telemetry());
    onScreen = true;
    leftForLive = vi.fn(() => state.noteReplayLeftForLive());
    resetEngine({
      replay: () => sim.replay,
      readTelemetry: () => sim.telemetry(),
      inReplay: () => onScreen && state.getReplayState().inReplay,
      connected: () => true,
      seekHold: (hold) => state.noteReplaySeekHold(hold),
      leftForLive,
      now: () => Date.now(),
    });
  }

  /** A search pressed from another surface than the key under test. */
  const search = (kind: "nextSession" | "nextLap" | "nextIncident") =>
    pressReplayCommand({ kind: "search", search: kind }, { by: "test-search", origin: "dial-1" });

  /** Awaits a start whose act only records it. */
  function awaitStart(origin?: string): { starts: SettledReplayWalkStart[]; done: Promise<SettledReplayWalkStart> } {
    const starts: SettledReplayWalkStart[] = [];
    const done = awaitReplayWalkStart(
      readState,
      () => sim.telemetry(),
      (start) => {
        starts.push(start);

        return start;
      },
      { origin },
    );

    return { starts, done };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    resetEngine();
    vi.useRealTimers();
  });

  it("acts at once, inside the call, when nothing is on its way", async () => {
    setUp();

    const { starts, done } = awaitStart(ORIGIN);

    expect(starts).toEqual([{ frame: 100_000, from: "cursor" }]);
    await expect(done).resolves.toEqual({ frame: 100_000, from: "cursor" });
    expect(getReplayGateView(ORIGIN).waiting).toBeNull();
  });

  it("reads `search on its way` while a search may be on its way, and resolves to its landing", async () => {
    setUp();
    search("nextSession");

    expect(resolveReplayWalkStart(readState(), sim.telemetry())).toEqual({
      frame: null,
      reason: "search on its way",
    });

    const { starts, done } = awaitStart(ORIGIN);

    expect(starts).toEqual([]);

    await vi.advanceTimersByTimeAsync(3_000);

    await expect(done).resolves.toEqual({ frame: 200_000, from: "cursor" });
    expect(starts).toHaveLength(1);
  });

  it("steps from the landing a fresh tick shows when the debounced state still holds the cursor from before the search", async () => {
    setUp();
    search("nextSession");

    // The controller's state, never stepped with the ticks the gate's polls took: still at the pre-search frame.
    const stale = (): ReplayState => ({ ...state.getReplayState(), inReplay: true, cursorFrame: 100_000 });
    const done = awaitReplayWalkStart(
      stale,
      () => sim.telemetry(),
      (start) => start,
    );

    await vi.advanceTimersByTimeAsync(3_000);

    await expect(done).resolves.toEqual({ frame: 200_000, from: "cursor" });
  });

  it("reads every press queued behind the landing from a fresh tick, not only the first", async () => {
    setUp();
    search("nextSession");

    // Never stepped with the ticks the gate's polls took; both presses send nothing (no marker that way).
    const stale = (): ReplayState => ({ ...state.getReplayState(), inReplay: true, cursorFrame: 100_000 });
    const first = awaitReplayWalkStart(
      stale,
      () => sim.telemetry(),
      (start) => start,
    );
    const second = awaitReplayWalkStart(
      stale,
      () => sim.telemetry(),
      (start) => start,
    );

    await vi.advanceTimersByTimeAsync(3_000);

    await expect(first).resolves.toEqual({ frame: 200_000, from: "cursor" });
    await expect(second).resolves.toEqual({ frame: 200_000, from: "cursor" });
  });

  it("keeps the debounced cursor when the fresh tick after a landing is not the replay's", async () => {
    setUp();
    search("nextSession");

    let fresh: TelemetryData | null = null;
    const done = awaitReplayWalkStart(
      () => ({ ...state.getReplayState(), inReplay: true, cursorFrame: 100_000 }),
      () => fresh ?? sim.telemetry(),
      (start) => start,
    );

    // Before the landing, the press's own telemetry read turns to a tick from the car; the gate's reads stay the sim's.
    await vi.advanceTimersByTimeAsync(300);
    fresh = { IsReplayPlaying: false, ReplayFrameNum: 0, ReplayFrameNumEnd: 900 } as TelemetryData;
    await vi.advanceTimersByTimeAsync(2_700);

    await expect(done).resolves.toEqual({ frame: 100_000, from: "cursor" });
  });

  it("does not wait for a go to end", () => {
    setUp();
    pressReplayCommand({ kind: "go-to", end: "end" }, { by: "test-go-to" });

    expect(resolveReplayWalkStart(readState(), sim.telemetry())).not.toEqual({
      frame: null,
      reason: "search on its way",
    });
  });

  it("waits for a go to start, whose landing is where the replay is headed", async () => {
    setUp();
    pressReplayCommand({ kind: "go-to", end: "start" }, { by: "test-go-to" });

    expect(resolveReplayWalkStart(readState(), sim.telemetry())).toEqual({
      frame: null,
      reason: "search on its way",
    });

    const { done } = awaitStart();

    await vi.advanceTimersByTimeAsync(3_000);

    await expect(done).resolves.toEqual({ frame: 0, from: "cursor" });
  });

  it("waits a long search on a paused replay through to its landing, and starts there", async () => {
    setUp();
    // Nine hundred thousand frames: about seven seconds of seeking, which nothing shows on a paused replay.
    search("nextLap");

    const { starts, done } = awaitStart();

    // Past the paced search's three-second patience the search still runs: the press still waits.
    await vi.advanceTimersByTimeAsync(3_500);

    expect(starts).toEqual([]);

    await vi.advanceTimersByTimeAsync(4_500);

    await expect(done).resolves.toEqual({ frame: 1_000_000, from: "cursor" });
  });

  it("re-reads the cursor once a search that found nothing on a paused replay could no longer be running, not before", async () => {
    setUp();
    search("nextIncident");

    const couldRunMs = replaySearchOnItsWay()?.couldRunMs ?? 0;
    const { starts, done } = awaitStart();

    expect(couldRunMs).toBeGreaterThan(3_500);

    await vi.advanceTimersByTimeAsync(couldRunMs - 100);

    expect(starts).toEqual([]);

    await vi.advanceTimersByTimeAsync(200);

    await expect(done).resolves.toEqual({ frame: 100_000, from: "cursor" });
    // The search it waited out no longer counts: the next press does not wait for it again.
    expect(resolveReplayWalkStart(readState(), sim.telemetry())).toEqual({ frame: 100_000, from: "cursor" });
  });

  it("re-reads the cursor when the search found nothing on a playing replay", async () => {
    setUp({ speed: { speed: 1, slowMotion: false } });
    search("nextIncident");

    const { done } = awaitStart();

    expect(resolveReplayWalkStart(readState(), sim.telemetry())).toEqual({
      frame: null,
      reason: "search on its way",
    });

    await vi.advanceTimersByTimeAsync(3_000);

    const start = await done;

    expect(start).toMatchObject({ from: "cursor" });
    expect(start.frame).toBeGreaterThan(100_000);
  });

  it("anchors on a jump that replaced the search", async () => {
    setUp();
    search("nextSession");

    const { done } = awaitStart();

    await vi.advanceTimersByTimeAsync(100);
    pressReplayCommand({ kind: "jump", frame: 700_000 }, { by: "test-jump" });
    await vi.advanceTimersByTimeAsync(100);

    await expect(done).resolves.toEqual({ frame: 700_000, from: "target" });
  });

  it("reads `not in a replay` promptly when the replay is left, and ends its waiting fact as replay-left", async () => {
    setUp();

    const notices: ReplayGateNotice[] = [];

    subscribeReplayGate((notice) => notices.push(notice));
    search("nextLap");

    const { done } = awaitStart(ORIGIN);

    await vi.advanceTimersByTimeAsync(200);
    onScreen = false;
    sim.leave();
    await vi.advanceTimersByTimeAsync(100);

    await expect(done).resolves.toEqual({ frame: null, reason: "not in a replay" });

    const ends = notices.filter((n) => n.origin === ORIGIN).flatMap((n) => n.ended);

    expect(ends).toEqual([{ fact: "waiting", class: "gave-up", reason: "replay-left" }]);
    expect(getReplayGateView(ORIGIN).waiting).toBeNull();
  });

  it("resolves two waiting presses in press order, the second from the first's recorded target", async () => {
    setUp();
    search("nextSession");

    const order: string[] = [];
    const jumps: Promise<unknown>[] = [];
    /** A Next press's act: the start, then a jump 50 000 frames on from it, its target recorded at once. */
    const press = (name: string) =>
      awaitReplayWalkStart(
        readState,
        () => sim.telemetry(),
        (start) => {
          order.push(`${name} ${start.frame === null ? start.reason : `${start.from} ${start.frame}`}`);

          if (start.frame === null) return;

          const frame = start.frame + 50_000;
          const jump = beginReplayJump(`test-${name}`, sim.telemetry(), undefined, Date.now(), { frame });

          jumps.push(runReplayJump(jump, { frame, readTelemetry: () => sim.telemetry() }).finally(() => jump.end()));
        },
      );

    const first = press("a");
    const second = press("b");

    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.all([first, second]);
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all(jumps);

    expect(order).toEqual(["a cursor 200000", "b target 250000"]);
    expect(sim.frame()).toBe(300_000);
  });

  it("waits for the dial's whole paced run, steps from its final landing, and leaves the run uncancelled", async () => {
    setUp();
    queueReplaySearch({ target: "session", ticks: 3, origin: "dial-1", owner: "replay-control-dial session" });

    const order: string[] = [];
    const jumps: Promise<unknown>[] = [];

    // Into the run, past its first landing: between two of its searches nothing is on its way.
    await vi.advanceTimersByTimeAsync(1_200);

    expect(pendingReplaySearch()).not.toBeNull();
    expect(resolveReplayWalkStart(readState(), sim.telemetry())).toEqual({
      frame: null,
      reason: "search on its way",
    });

    // A Replay Markers Next: its start, then a jump 50 000 frames on from it.
    const a = awaitReplayWalkStart(
      readState,
      () => sim.telemetry(),
      (start) => {
        order.push(start.frame === null ? start.reason : `${start.from} ${start.frame}`);

        if (start.frame === null) return;

        const frame = start.frame + 50_000;
        const jump = beginReplayJump("test-marker", sim.telemetry(), undefined, Date.now(), { frame });

        jumps.push(runReplayJump(jump, { frame, readTelemetry: () => sim.telemetry() }).finally(() => jump.end()));
      },
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await a;
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all(jumps);

    expect(order).toEqual(["cursor 400000"]);
    expect(sim.calls.filter((call) => call === "nextSession")).toHaveLength(3);
    expect(sim.frame()).toBe(450_000);
  });

  it("steps from the paced run's final landing a fresh tick shows when the debounced state never stepped through the run", async () => {
    setUp();
    queueReplaySearch({ target: "session", ticks: 3, origin: "dial-1", owner: "replay-control-dial session" });
    await vi.advanceTimersByTimeAsync(1_200);

    expect(pendingReplaySearch()).not.toBeNull();

    // The controller's state, never stepped with the ticks the run and the gate took: still at the pre-run frame.
    const done = awaitReplayWalkStart(
      () => ({ ...state.getReplayState(), inReplay: true, cursorFrame: 100_000 }),
      () => sim.telemetry(),
      (start) => start,
    );

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(done).resolves.toEqual({ frame: 400_000, from: "cursor" });
    expect(sim.calls.filter((call) => call === "nextSession")).toHaveLength(3);
  });

  it("waits through a playing run's jump back, whose target is the run's own, for the run's final landing", async () => {
    setUp({
      speed: { speed: 1, slowMotion: false },
      searches: { nextLap: (from) => from + 3_000, prevLap: (from) => from - 3_000 },
    });
    // One lap on the playing path, then two back against the play: the run pauses on the landing and jumps back.
    queueReplaySearch({ target: "lap", ticks: 1, origin: "dial-1", owner: "replay-control-dial lap" });
    queueReplaySearch({ target: "lap", ticks: -2, origin: "dial-1", owner: "replay-control-dial lap" });

    for (let i = 0; i < 400 && getReplayGateRecord().target === null; i++) await vi.advanceTimersByTimeAsync(10);

    const back = getReplayGateRecord().target;

    expect(back).not.toBeNull();
    expect(pendingReplaySearch()).not.toBeNull();
    expect(resolveReplayWalkStart(readState(), sim.telemetry())).toEqual({
      frame: null,
      reason: "search on its way",
    });

    const order: string[] = [];
    const jumps: Promise<unknown>[] = [];
    const a = awaitReplayWalkStart(
      readState,
      () => sim.telemetry(),
      (start) => {
        order.push(start.frame === null ? start.reason : `${start.from} ${start.frame}`);

        if (start.frame === null) return;

        const frame = start.frame + 50_000;
        const jump = beginReplayJump("test-marker", sim.telemetry(), undefined, Date.now(), { frame });

        jumps.push(runReplayJump(jump, { frame, readTelemetry: () => sim.telemetry() }).finally(() => jump.end()));
      },
    );

    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(15_000);
    await a;
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all(jumps);

    const landing = (back?.frame ?? 0) - 6_000;

    expect(order).toEqual([`cursor ${landing}`]);
    // The run sent both of its steps back, and the press's jump went after them.
    expect(sim.calls.filter((call) => call === "prevLap")).toHaveLength(2);
    expect(sim.calls.indexOf(`setPlayPosition 0 ${landing + 50_000}`)).toBeGreaterThan(
      sim.calls.lastIndexOf("prevLap"),
    );
  });

  describe("press order across the gate's slot", () => {
    /** An incident search lands 30 000 frames on. */
    const withIncidents = { searches: { nextIncident: (from: number) => from + 30_000 } };
    /** A key's Next Incident, which the gate holds in its slot behind a search on its way. */
    const incidentKey = () =>
      pressReplayCommand({ kind: "search", search: "nextIncident" }, { by: "test-incident", origin: "key-g" });

    /** A marker-style press: its start, then a jump 50 000 frames on from it, its target recorded at once. */
    function jumpPress(name: string, order: string[], jumps: Promise<unknown>[]): Promise<void> {
      return awaitReplayWalkStart(
        readState,
        () => sim.telemetry(),
        (start) => {
          order.push(`${name} ${start.frame === null ? start.reason : `${start.from} ${start.frame}`}`);

          if (start.frame === null) return;

          const frame = start.frame + 50_000;
          const jump = beginReplayJump(`test-${name}`, sim.telemetry(), undefined, Date.now(), { frame });

          jumps.push(runReplayJump(jump, { frame, readTelemetry: () => sim.telemetry() }).finally(() => jump.end()));
        },
      );
    }

    it("a start pressed before the slot's command goes first at the landing, and the command waits behind its jump", async () => {
      setUp(withIncidents);
      search("nextSession");

      const order: string[] = [];
      const jumps: Promise<unknown>[] = [];
      const a = jumpPress("a", order, jumps);

      expect(incidentKey()).toEqual({ kind: "held" });

      await vi.advanceTimersByTimeAsync(3_000);
      await a;
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.all(jumps);

      // The session landed at 200 000; the marker press stepped from there, then the incident search from its jump.
      expect(order).toEqual(["a cursor 200000"]);
      expect(sim.calls.filter((call) => call !== "pause")).toEqual([
        "nextSession",
        "setPlayPosition 0 250000",
        "nextIncident",
      ]);
      expect(sim.frame()).toBe(280_000);
      expect(sim.thrown).toBe(0);
    });

    it("a slot command pressed before the start still goes first, and the start waits for its search", async () => {
      setUp(withIncidents);
      search("nextSession");

      const order: string[] = [];
      const jumps: Promise<unknown>[] = [];

      expect(incidentKey()).toEqual({ kind: "held" });

      const a = jumpPress("a", order, jumps);

      await vi.advanceTimersByTimeAsync(3_000);
      await a;
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.all(jumps);

      expect(order).toEqual(["a cursor 230000"]);
      expect(sim.calls.filter((call) => call !== "pause")).toEqual([
        "nextSession",
        "nextIncident",
        "setPlayPosition 0 280000",
      ]);
      expect(sim.frame()).toBe(280_000);
    });

    it("a start that went first and pressed a search does not drop the newer slot command, which waits for that search", async () => {
      setUp(withIncidents);
      search("nextSession");

      // A Replay Control miss: the press falls back to the key's own search through the gate.
      const a = awaitReplayWalkStart(
        readState,
        () => sim.telemetry(),
        () => pressReplayCommand({ kind: "search", search: "nextSession" }, { by: "test-a" }),
      );

      expect(incidentKey()).toEqual({ kind: "held" });

      await vi.advanceTimersByTimeAsync(3_000);

      await expect(a).resolves.toEqual({ kind: "sent", ok: true });

      await vi.advanceTimersByTimeAsync(3_000);

      expect(sim.calls).toEqual(["nextSession", "nextSession", "nextIncident"]);
      expect(sim.frame()).toBe(330_000);
      expect(sim.thrown).toBe(0);
    });

    it("a go to end held back for a start, then sent against the start's jump, still tells the controller it left for live", async () => {
      setUp();
      search("nextSession");

      const order: string[] = [];
      const jumps: Promise<unknown>[] = [];
      const a = jumpPress("a", order, jumps);

      // Jump to Live, held behind the search on its way.
      expect(pressReplayCommand({ kind: "go-to", end: "end" }, { by: "test-live", origin: "key-live" })).toEqual({
        kind: "held",
      });

      await vi.advanceTimersByTimeAsync(3_000);
      await a;

      expect(order).toEqual(["a cursor 200000"]);
      expect(sim.calls.filter((call) => call !== "pause")).toEqual([
        "nextSession",
        "setPlayPosition 0 250000",
        "goToEnd",
      ]);
      expect(leftForLive).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.allSettled(jumps);
    });

    it("a command behind a search that can no longer be running waits for a start pressed before it, then waits behind its jump", async () => {
      setUp();
      // Finds nothing on a paused replay: unseen, it ends only when it could no longer be running.
      search("nextIncident");

      const couldRunMs = replaySearchOnItsWay()?.couldRunMs ?? 0;
      const order: string[] = [];
      const jumps: Promise<unknown>[] = [];
      const a = jumpPress("a", order, jumps);

      expect(
        pressReplayCommand({ kind: "search", search: "nextSession" }, { by: "test-session", origin: "key-g" }),
      ).toEqual({ kind: "held" });

      await vi.advanceTimersByTimeAsync(couldRunMs + 500);
      await a;
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.all(jumps);

      // No takeover into the step: the step went first from the cursor, then the session search from its jump.
      expect(order).toEqual(["a cursor 100000"]);
      expect(sim.calls).toEqual(["nextIncident", "setPlayPosition 0 150000", "nextSession"]);
      expect(sim.frame()).toBe(250_000);
      expect(sim.thrown).toBe(0);
    });

    it("a command held at its search's end waits behind a start's jump that left the search record standing", async () => {
      setUp();
      search("nextIncident");

      const couldRunMs = replaySearchOnItsWay()?.couldRunMs ?? 0;
      let jump: ReturnType<typeof beginReplayJump> | null = null;
      // A jump sequence that records its frame and sends no position jump of its own leaves the search record as it is.
      const a = awaitReplayWalkStart(
        readState,
        () => sim.telemetry(),
        (start) => {
          if (start.frame === null) return;

          jump = beginReplayJump("test-a", sim.telemetry(), undefined, Date.now(), {
            frame: start.frame + 50_000,
            sendsPositionJump: false,
          });
        },
      );

      expect(
        pressReplayCommand({ kind: "search", search: "nextSession" }, { by: "test-session", origin: "key-g" }),
      ).toEqual({ kind: "held" });

      await vi.advanceTimersByTimeAsync(couldRunMs + 500);
      await a;

      // Decided against the start's jump by the table: a search waits for its read-back, no takeover is sent.
      expect(sim.calls).toEqual(["nextIncident"]);
      expect(getReplayGateRecord().waiting).toMatchObject({ command: "nextSession", behind: "jump" });

      (jump as ReturnType<typeof beginReplayJump> | null)?.end();
    });

    it("a go to end released against a start's jump and refused by the SDK ends as refused, with no word of leaving for live", async () => {
      setUp();
      search("nextSession");

      const notices: ReplayGateNotice[] = [];

      subscribeReplayGate((notice) => notices.push(notice));

      const order: string[] = [];
      const jumps: Promise<unknown>[] = [];
      const a = jumpPress("a", order, jumps);

      vi.mocked(sim.replay.goToEnd).mockReturnValue(false);

      expect(pressReplayCommand({ kind: "go-to", end: "end" }, { by: "test-live", origin: "key-live" })).toEqual({
        kind: "held",
      });

      await vi.advanceTimersByTimeAsync(3_000);
      await a;

      expect(order).toEqual(["a cursor 200000"]);
      expect(sim.replay.goToEnd).toHaveBeenCalledTimes(1);
      expect(notices.filter((n) => n.origin === "key-live").flatMap((n) => n.ended)).toEqual([
        { fact: "waiting", class: "gave-up", reason: "refused" },
      ]);
      expect(leftForLive).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.allSettled(jumps);
    });

    /**
     * When the gate's own polls judge the session search landed, in ms from its send: a dry run of the same
     * timeline. The landing is judged on the first read 50 ms after the leap, so a press a few ms before it reads
     * the landing in its own settle, before the waiting start's poll does.
     */
    async function landingJudgedAt(): Promise<number> {
      setUp(withIncidents);
      search("nextSession");
      // Settled or dropped by the reset after it; neither matters to the dry run.
      awaitReplayWalkStart(
        readState,
        () => sim.telemetry(),
        () => undefined,
      ).catch(() => undefined);

      for (let ms = 1; ms <= 3_000; ms++) {
        await vi.advanceTimersByTimeAsync(1);

        if (getReplayGateRecord().search?.onItsWay === "no") return ms;
      }

      throw new Error("the session search never landed");
    }

    it("a press whose own read is the gate's first read of the landing does not overtake the earlier start", async () => {
      const landedAt = await landingJudgedAt();

      resetEngine();
      vi.setSystemTime(1_000_000);
      setUp(withIncidents);
      search("nextSession");

      const order: string[] = [];
      const jumps: Promise<unknown>[] = [];
      const a = jumpPress("a", order, jumps);

      await vi.advanceTimersByTimeAsync(landedAt - 5);

      expect(getReplayGateRecord().search?.onItsWay).not.toBe("no");
      expect(incidentKey()).toEqual({ kind: "held" });
      // The press's own settle read the landing, and the start has not acted: the moment the overtake happened in.
      expect(getReplayGateRecord().search?.onItsWay).toBe("no");
      expect(order).toEqual([]);

      await vi.advanceTimersByTimeAsync(100);
      await a;
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.all(jumps);

      expect(order).toEqual(["a cursor 200000"]);
      expect(sim.calls.filter((call) => call !== "pause")).toEqual([
        "nextSession",
        "setPlayPosition 0 250000",
        "nextIncident",
      ]);
      expect(sim.thrown).toBe(0);
    });

    it("an absolute jump pressed in that moment still goes out at once, and the waiting start steps from its target", async () => {
      const landedAt = await landingJudgedAt();

      resetEngine();
      vi.setSystemTime(1_000_000);
      setUp(withIncidents);
      search("nextSession");

      const order: string[] = [];
      const a = awaitReplayWalkStart(
        readState,
        () => sim.telemetry(),
        (start) => order.push(start.frame === null ? start.reason : `${start.from} ${start.frame}`),
      );

      await vi.advanceTimersByTimeAsync(landedAt - 5);

      expect(pressReplayCommand({ kind: "jump", frame: 600_000 }, { by: "test-jump" })).toMatchObject({ kind: "sent" });
      expect(order).toEqual([]);

      await vi.advanceTimersByTimeAsync(100);
      await a;

      expect(order).toEqual(["target 600000"]);
    });

    it("two step presses with no record during a search fall back to two searches, the second from the first's landing", async () => {
      setUp({ searches: { nextLap: (from: number) => from + 3_000 } });
      search("nextSession");

      const order: string[] = [];
      /** A Replay Control Next Lap with no lap record: its act falls back to the key's search through the gate. */
      const lapPress = (name: string) =>
        awaitReplayWalkStart(
          readState,
          () => sim.telemetry(),
          (start) => {
            order.push(`${name} ${start.frame === null ? start.reason : `${start.from} ${start.frame}`}`);

            return pressReplayCommand({ kind: "search", search: "nextLap" }, { by: `test-${name}` });
          },
        );

      const first = lapPress("a");
      const second = lapPress("b");

      await vi.advanceTimersByTimeAsync(3_000);

      await expect(first).resolves.toEqual({ kind: "sent", ok: true });
      await expect(second).resolves.toEqual({ kind: "sent", ok: true });

      expect(order).toEqual(["a cursor 200000", "b cursor 203000"]);
      expect(sim.calls).toEqual(["nextSession", "nextLap", "nextLap"]);
      expect(sim.frame()).toBe(206_000);
    });

    it("a held-back command released at once and refused by the SDK ends as refused", async () => {
      setUp(withIncidents);
      search("nextSession");

      const notices: ReplayGateNotice[] = [];

      subscribeReplayGate((notice) => notices.push(notice));

      // A marker step that finds no marker: its act sends nothing, so the key's search goes out as it is.
      const a = awaitReplayWalkStart(
        readState,
        () => sim.telemetry(),
        () => undefined,
      );

      expect(incidentKey()).toEqual({ kind: "held" });
      vi.mocked(sim.replay.nextIncident).mockReturnValue(false);

      await vi.advanceTimersByTimeAsync(3_000);
      await a;

      expect(sim.replay.nextIncident).toHaveBeenCalledTimes(1);
      expect(notices.filter((n) => n.origin === "key-g").flatMap((n) => n.ended)).toEqual([
        { fact: "waiting", class: "gave-up", reason: "refused" },
      ]);
    });

    it("when the start that went first sends nothing, the slot's command goes out before the next start reads", async () => {
      setUp(withIncidents);
      search("nextSession");

      const order: string[] = [];
      const a = awaitReplayWalkStart(
        readState,
        () => sim.telemetry(),
        (start) => order.push(`a ${start.frame}`),
      );

      expect(incidentKey()).toEqual({ kind: "held" });

      // Pressed after the incident key: it waits for the incident search the key sends once the first press has acted.
      const b = awaitReplayWalkStart(
        readState,
        () => sim.telemetry(),
        (start) => order.push(`b ${start.frame}`),
      );

      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.all([a, b]);

      expect(order).toEqual(["a 200000", "b 230000"]);
      expect(sim.calls).toEqual(["nextSession", "nextIncident"]);
      expect(getReplayGateView("key-g")).toEqual({ underWay: null, waiting: null });
    });
  });

  it("resolves every press waiting on one search to its landing", async () => {
    setUp();
    search("nextSession");

    const first = awaitStart();
    const second = awaitStart();

    expect(first.starts).toEqual([]);
    expect(second.starts).toEqual([]);

    await vi.advanceTimersByTimeAsync(3_000);

    await expect(first.done).resolves.toEqual({ frame: 200_000, from: "cursor" });
    await expect(second.done).resolves.toEqual({ frame: 200_000, from: "cursor" });
  });

  it("rejects a press whose act throws, and goes on with the next", async () => {
    setUp();
    search("nextSession");

    const failing = awaitReplayWalkStart(
      readState,
      () => sim.telemetry(),
      () => {
        throw new Error("boom");
      },
    );
    const next = awaitStart();

    failing.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(failing).rejects.toThrow("boom");
    await expect(next.done).resolves.toEqual({ frame: 200_000, from: "cursor" });
  });

  it("rejects only the press whose own reads throw, ends its waiting fact as refused, and goes on with the next", async () => {
    setUp();

    const notices: ReplayGateNotice[] = [];

    subscribeReplayGate((notice) => notices.push(notice));
    search("nextSession");

    let readsFail = false;
    const failing = awaitReplayWalkStart(
      () => {
        if (readsFail) throw new Error("state read failed");

        return readState();
      },
      () => sim.telemetry(),
      () => "acted",
      { origin: "key-x" },
    );
    const next = awaitStart();

    failing.catch(() => undefined);
    readsFail = true;
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(failing).rejects.toThrow("state read failed");
    await expect(next.done).resolves.toEqual({ frame: 200_000, from: "cursor" });
    // A give-up the busy indicator shows as not-done for its second.
    expect(notices.filter((n) => n.origin === "key-x").flatMap((n) => n.ended)).toEqual([
      { fact: "waiting", class: "gave-up", reason: "refused" },
    ]);
    expect(getReplayGateView("key-x").waiting).toBeNull();
  });

  it("shows the press as waiting for its origin while it waits, and hands over to its jump as completed", async () => {
    setUp();

    const notices: ReplayGateNotice[] = [];

    subscribeReplayGate((notice) => notices.push(notice));
    search("nextSession");

    let jump: ReturnType<typeof beginReplayJump> | null = null;
    const done = awaitReplayWalkStart(
      readState,
      () => sim.telemetry(),
      (start) => {
        if (start.frame === null) return;

        jump = beginReplayJump("test-key", sim.telemetry(), undefined, Date.now(), {
          frame: start.frame + 50_000,
          origin: ORIGIN,
        });
      },
      { origin: ORIGIN },
    );

    expect(getReplayGateView(ORIGIN)).toMatchObject({ waiting: { since: Date.now() }, underWay: null });
    // The wait fills no slot: the gate's own record of what waits is unchanged.
    expect(getReplayGateRecord().waiting).toBeNull();

    await vi.advanceTimersByTimeAsync(3_000);
    await done;

    const mine = notices.filter((n) => n.origin === ORIGIN);

    // One change hands the still mark straight to the jump under way, never to rest between.
    expect(mine.map((n) => ({ waiting: n.view.waiting !== null, underWay: n.view.underWay !== null }))).toEqual([
      { waiting: true, underWay: false },
      { waiting: false, underWay: true },
    ]);
    expect(mine[1]?.ended).toEqual([{ fact: "waiting", class: "completed", reason: "sent-on-landing" }]);

    (jump as ReturnType<typeof beginReplayJump> | null)?.end();
  });

  it("still queues a press with nothing to wait for behind an earlier one waiting, in press order", async () => {
    setUp();
    search("nextSession");

    const order: string[] = [];
    const first = awaitReplayWalkStart(
      readState,
      () => sim.telemetry(),
      (start) => order.push(`a ${start.frame}`),
    );

    await vi.advanceTimersByTimeAsync(100);
    // A jump from another surface replaces the search; the first press has not read again yet.
    pressReplayCommand({ kind: "jump", frame: 700_000 }, { by: "test-jump" });

    const second = awaitReplayWalkStart(
      readState,
      () => sim.telemetry(),
      (start) => order.push(`b ${start.frame}`),
    );

    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([first, second]);

    expect(order).toEqual(["a 700000", "b 700000"]);
  });

  it("a reset drops the waiting starts and their waiting facts", async () => {
    setUp();
    search("nextSession");

    const { starts, done } = awaitStart(ORIGIN);

    resetEngine();

    // Settled, never left hanging, and its act never runs.
    await expect(done).rejects.toBeInstanceOf(ReplayWalkStartDropped);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(starts).toEqual([]);
    expect(getReplayGateView(ORIGIN).waiting).toBeNull();

    // Nothing from before the reset is left to queue behind or to act: a press with nothing to wait for acts at once.
    setUp();

    expect(awaitStart().starts).toEqual([{ frame: 100_000, from: "cursor" }]);
    expect(starts).toEqual([]);
  });
});
