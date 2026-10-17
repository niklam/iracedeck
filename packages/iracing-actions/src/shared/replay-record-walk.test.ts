import { REPLAY_EXIT_GRACE_MS, type TelemetryData } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _configureReplayCommandGate, _resetReplayCommandGate, pressReplayCommand } from "./replay-command-gate.js";
import { fakeReplay, type FakeReplay } from "./replay-command-gate.test-support.js";
import { _resetReplayCursor } from "./replay-cursor.js";
import { beginReplayJump, runReplayJump } from "./replay-jump-playback.js";
import { _resetReplayPositionState, pendingReplayTarget } from "./replay-position-state.js";
import {
  recordedIndexAt,
  resolveReplayWalkAnchor,
  resolveReplayWalkStart,
  stepRecordedFrames,
  walkRecordedIndex,
} from "./replay-record-walk.js";

const { mockGetGlobalSettings } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn((): Record<string, unknown> => ({})),
}));

vi.mock("@iracedeck/settings", () => ({ getGlobalSettings: mockGetGlobalSettings }));

vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: vi.fn(() => {
    throw new Error("the walk's tests send through the fake replay");
  }),
  getController: vi.fn(() => {
    throw new Error("the walk's tests read the fake replay");
  }),
}));

describe("stepRecordedFrames", () => {
  const list = [1_000, 2_000, 3_000, 4_000];

  describe("Next: the first landing more than 60 frames past the anchor", () => {
    it("skips an entry 60 frames ahead or less, and takes one 61 ahead", () => {
      expect(stepRecordedFrames(list, 1_940, "next", 1)).toEqual({ frame: 3_000, steps: 1 });
      expect(stepRecordedFrames(list, 1_939, "next", 1)).toEqual({ frame: 2_000, steps: 1 });
    });

    it("from on an entry goes to the one after it", () => {
      expect(stepRecordedFrames(list, 2_000, "next", 1)).toEqual({ frame: 3_000, steps: 1 });
    });

    it("from before the list is its first entry", () => {
      expect(stepRecordedFrames(list, 0, "next", 1)).toEqual({ frame: 1_000, steps: 1 });
    });

    it("is a miss past the last entry's window", () => {
      expect(stepRecordedFrames(list, 3_940, "next", 1)).toBeNull();
      expect(stepRecordedFrames(list, 9_000, "next", 1)).toBeNull();
    });
  });

  describe("Previous: the entry the anchor is in past 120 frames, else the one before", () => {
    it("within 120 frames of an entry goes to the one before it", () => {
      expect(stepRecordedFrames(list, 3_000, "previous", 1)).toEqual({ frame: 2_000, steps: 1 });
      expect(stepRecordedFrames(list, 3_120, "previous", 1)).toEqual({ frame: 2_000, steps: 1 });
    });

    it("more than 120 frames past an entry goes back to that entry", () => {
      expect(stepRecordedFrames(list, 3_121, "previous", 1)).toEqual({ frame: 3_000, steps: 1 });
    });

    it("is a miss before the list, and on its first entry", () => {
      expect(stepRecordedFrames(list, 999, "previous", 1)).toBeNull();
      expect(stepRecordedFrames(list, 1_050, "previous", 1)).toBeNull();
    });
  });

  describe("steps", () => {
    it("moves further entries after the first step", () => {
      expect(stepRecordedFrames(list, 1_000, "next", 2)).toEqual({ frame: 3_000, steps: 2 });
      expect(stepRecordedFrames(list, 4_500, "previous", 3)).toEqual({ frame: 2_000, steps: 3 });
    });

    it("stops at either end and reports the steps it took", () => {
      expect(stepRecordedFrames(list, 1_500, "next", 10)).toEqual({ frame: 4_000, steps: 3 });
      expect(stepRecordedFrames(list, 3_500, "previous", 10)).toEqual({ frame: 1_000, steps: 3 });
    });

    it("zero steps is a miss", () => {
      expect(stepRecordedFrames(list, 0, "next", 0)).toBeNull();
      expect(stepRecordedFrames(list, 9_000, "previous", 0)).toBeNull();
    });

    it("an empty list is a miss", () => {
      expect(stepRecordedFrames([], 0, "next", 1)).toBeNull();
      expect(stepRecordedFrames([], 0, "previous", 1)).toBeNull();
    });
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
    _resetReplayCommandGate();
    _resetReplayCursor();
    _resetReplayPositionState();
    mockGetGlobalSettings.mockReturnValue({});
    sim = fakeReplay({ frame: 100_000 });
    _configureReplayCommandGate({
      replay: () => sim.replay,
      readTelemetry: () => sim.telemetry(),
      inReplay: () => true,
      connected: () => true,
      now: () => Date.now(),
    });
  });

  afterEach(() => {
    _resetReplayCommandGate();
    vi.useRealTimers();
  });

  type WalkState = Parameters<typeof resolveReplayWalkStart>[0];

  /** The debounced state as the controller reads it on a replay tick showing `frame`. */
  const replayTick = (frame: number): WalkState => ({
    inReplay: true,
    frame,
    tickReplayPlaying: true,
    replaySeenAt: Date.now(),
  });
  /** A tick that reads mid-seek: no frame of its own, and seen as a replay `seenAgo` ms ago (null: never). */
  const midSeekState = (frame: number | null, seenAgo: number | null, inReplay = true): WalkState => ({
    inReplay,
    frame,
    tickReplayPlaying: false,
    replaySeenAt: seenAgo === null ? null : Date.now() - seenAgo,
  });
  const midSeek = { IsReplayPlaying: false, ReplayFrameNum: 0, SessionNum: -1 } as TelemetryData;

  it("with nothing under way the anchor is the cursor", () => {
    expect(resolveReplayWalkAnchor(100_000, sim.telemetry())).toBe(100_000);
    expect(resolveReplayWalkStart(replayTick(100_000), sim.telemetry(), Date.now())).toEqual({
      frame: 100_000,
      from: "cursor",
    });
  });

  it("a standing target is the anchor, whatever the tick reads", () => {
    pressReplayCommand({ kind: "jump", frame: 900_000 }, { by: "test" });

    expect(pendingReplayTarget()).toMatchObject({ frame: 900_000 });
    expect(resolveReplayWalkAnchor(100_000, sim.telemetry())).toBe(900_000);
    expect(resolveReplayWalkStart(midSeekState(0, null), sim.telemetry(), Date.now())).toEqual({
      frame: 900_000,
      from: "target",
    });
    // A seek longer than the grace reads like a replay left in a live session; the plugin's jump is still headed there.
    expect(resolveReplayWalkStart(midSeekState(0, null, false), sim.telemetry(), Date.now())).toEqual({
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
    expect(resolveReplayWalkStart(midSeekState(0, 4_000, false), sim.telemetry(), Date.now())).toEqual({
      frame: 1_100_000,
      from: "target",
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    expect(pendingReplayTarget()).toBeNull();
    expect(resolveReplayWalkAnchor(sim.frame(), sim.telemetry())).toBe(1_100_000);
  });

  it("with no target, a tick that reads mid-seek inside the grace takes the debounced frame", () => {
    expect(resolveReplayWalkStart(midSeekState(42_000, REPLAY_EXIT_GRACE_MS - 1), midSeek, Date.now())).toEqual({
      frame: 42_000,
      from: "cursor",
    });
  });

  it("with no target and a tick still reading mid-seek once the grace is over, there is no cursor", () => {
    // A saved replay: the state stays in a replay, its frame the tick's 0.
    expect(resolveReplayWalkStart(midSeekState(0, REPLAY_EXIT_GRACE_MS), midSeek, Date.now())).toEqual({
      frame: null,
      reason: "no cursor",
    });
    expect(resolveReplayWalkStart(midSeekState(0, null), midSeek, Date.now())).toEqual({
      frame: null,
      reason: "no cursor",
    });
  });

  it("no frame at all is no cursor", () => {
    expect(resolveReplayWalkStart({ ...replayTick(0), frame: null }, null, Date.now())).toEqual({
      frame: null,
      reason: "no cursor",
    });
  });

  it("with no target, outside a replay there is nothing to step from", () => {
    expect(resolveReplayWalkStart({ ...replayTick(5_000), inReplay: false }, sim.telemetry(), Date.now())).toEqual({
      frame: null,
      reason: "not in a replay",
    });
  });
});
