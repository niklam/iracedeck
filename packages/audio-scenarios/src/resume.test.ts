/**
 * Resume with no scheduler (issue #1514): `opsEqual`, `planResume` and
 * `buildResumeState` over hand-built ops and fires — no bus, no pool store,
 * no `IAudioService`.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { describe, expect, it, vi } from "vitest";

import type { ActiveFireView, ExecOp, ResumeState } from "./engine-types.js";
import { buildResumeState, opsEqual, planResume, type ResumeWorld } from "./resume.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TICK_OPEN = "sfx/tick-open.mp3";
const TICK_CLOSE = "sfx/tick-close.mp3";

const play = (path: string, extra: Partial<Extract<ExecOp, { kind: "play" }>> = {}): ExecOp => ({
  kind: "play",
  channel: AudioChannel.Voice,
  path,
  ...extra,
});
const sfx = (path: string, frame: ExecOp["frame"]): ExecOp => play(path, { channel: AudioChannel.SFX, frame });
const ambient = (action: "start" | "stop" | "seek", frame?: ExecOp["frame"]): ExecOp => ({
  kind: "ambient",
  action,
  frame,
});
const pause = (ms: number, frame?: ExecOp["frame"]): ExecOp => ({ kind: "pause", ms, frame });

/** A framed body: a two-op open, two body clips, a two-op close. */
const FRAMED: ExecOp[] = [
  sfx(TICK_OPEN, "open"),
  ambient("start", "open"),
  play("voice/v1/a.mp3", { pool: "words" }),
  play("voice/v1/b.mp3"),
  ambient("stop", "close"),
  sfx(TICK_CLOSE, "close"),
];

/** A legacy sequence playing the built-in tick inline: no op carries a frame tag. */
const LEGACY: ExecOp[] = [
  play(TICK_OPEN, { channel: AudioChannel.SFX }),
  play("voice/v1/a.mp3"),
  play("voice/v1/b.mp3"),
  play(TICK_CLOSE, { channel: AudioChannel.SFX }),
];

function world(overrides: Partial<ResumeWorld> = {}): ResumeWorld {
  return {
    activeVoice: () => "v1",
    generation: () => 3,
    openTick: () => TICK_OPEN,
    ...overrides,
  };
}

function stash(ops: readonly ExecOp[], index: number, overrides: Partial<ResumeState> = {}): ResumeState {
  return { ops, index, voice: "v1", generation: 3, ...overrides };
}

function fire(overrides: Partial<ActiveFireView> = {}): ActiveFireView {
  return {
    id: "pit-crew.x",
    bus: AudioBus.Voice,
    weight: 50,
    ops: FRAMED,
    index: 0,
    sourceOps: FRAMED,
    sourceStart: 0,
    prerollCount: 0,
    cancelled: false,
    usedChannels: new Set([AudioChannel.Voice, AudioChannel.SFX, AudioChannel.Ambient]),
    event: null,
    sessionGeneration: 0,
    cutTail: [],
    ended: false,
    ...overrides,
  };
}

// ─── opsEqual ────────────────────────────────────────────────────────────────

describe("opsEqual", () => {
  it.each<[string, ExecOp[], ExecOp[], boolean]>([
    ["two empty lists", [], [], true],
    ["a length mismatch", [play("a")], [play("a"), play("b")], false],
    ["a kind mismatch", [play("a")], [pause(100)], false],
    // By pool: the take drawn is not part of what the body says (issue #1136).
    ["the same pool, different takes", [play("a-01", { pool: "words" })], [play("a-02", { pool: "words" })], true],
    ["different pools", [play("a-01", { pool: "words" })], [play("a-01", { pool: "numbers" })], false],
    ["a pool-drawn op against a path-drawn one", [play("a-01", { pool: "words" })], [play("a-01")], false],
    ["a path-drawn op against a pool-drawn one", [play("a-01")], [play("a-01", { pool: "words" })], false],
    // By path, for ops no pool produced.
    ["the same path", [play("a")], [play("a")], true],
    ["different paths", [play("a")], [play("b")], false],
    ["the same path on different channels", [play("a")], [play("a", { channel: AudioChannel.SFX })], false],
    [
      "the same pool on different channels",
      [play("a", { pool: "w" })],
      [play("a", { channel: AudioChannel.SFX, pool: "w" })],
      false,
    ],
    // The frame tag is part of an op's identity.
    [
      "the same clip as frame and as body",
      [sfx(TICK_OPEN, "open")],
      [play(TICK_OPEN, { channel: AudioChannel.SFX })],
      false,
    ],
    ["the same clip under two frame sides", [sfx(TICK_CLOSE, "close")], [sfx(TICK_CLOSE, "cut")], false],
    ["a tagged pause against an untagged one", [pause(100, "open")], [pause(100)], false],
    ["ambient ops of the same action", [ambient("start")], [ambient("start")], true],
    ["ambient ops of different actions", [ambient("start")], [ambient("stop")], false],
    ["pauses of the same length", [pause(250)], [pause(250)], true],
    ["pauses of different lengths", [pause(250)], [pause(300)], false],
    ["a whole framed body against itself", FRAMED, [...FRAMED], true],
    [
      "a framed body with one slot reordered",
      FRAMED,
      [FRAMED[0], FRAMED[1], FRAMED[3], FRAMED[2], FRAMED[4], FRAMED[5]],
      false,
    ],
  ])("%s", (_name, a, b, expected) => {
    expect(opsEqual(a, b)).toBe(expected);
  });
});

// ─── planResume ──────────────────────────────────────────────────────────────

describe("planResume", () => {
  describe("fresh: nothing to continue from", () => {
    it.each<[string, ResumeState | undefined]>([
      ["no resume", undefined],
      ["a resume at the head", stash(FRAMED, 0)],
      ["a resume at the end of the fresh expansion", stash(FRAMED, FRAMED.length)],
      ["a resume past the end of the fresh expansion", stash(FRAMED, FRAMED.length + 2)],
    ])("%s", (_name, resume) => {
      expect(planResume(resume, FRAMED, false, world())).toEqual({ kind: "fresh" });
    });

    it("reads nothing of the world", () => {
      const w = world({ activeVoice: vi.fn(() => "v1"), generation: vi.fn(() => 3), openTick: vi.fn(() => TICK_OPEN) });

      planResume(stash(FRAMED, 0), FRAMED, true, w);

      expect(w.activeVoice).not.toHaveBeenCalled();
      expect(w.generation).not.toHaveBeenCalled();
      expect(w.openTick).not.toHaveBeenCalled();
    });
  });

  describe("whole: each blocker, in order", () => {
    it.each<[string, ResumeState, ExecOp[], Partial<ResumeWorld>, string]>([
      [
        "the voice changed while stashed",
        stash(FRAMED, 2),
        FRAMED,
        { activeVoice: () => "v2" },
        "voice changed while stashed",
      ],
      [
        "the stash names no voice and one is active",
        stash(FRAMED, 2, { voice: null }),
        FRAMED,
        {},
        "voice changed while stashed",
      ],
      [
        "the scripts changed while stashed",
        stash(FRAMED, 2),
        FRAMED,
        { generation: () => 4 },
        "scripts changed while stashed",
      ],
      [
        "the expansion changed while stashed",
        stash(FRAMED, 2),
        [...FRAMED.slice(0, 3), play("voice/v1/c.mp3"), ...FRAMED.slice(4)],
        {},
        "the expansion changed while stashed",
      ],
      [
        "the voice is checked before the scripts",
        stash(FRAMED, 2),
        FRAMED,
        { activeVoice: () => "v2", generation: () => 4 },
        "voice changed while stashed",
      ],
      [
        "the scripts are checked before the ops",
        stash(FRAMED, 2),
        [...FRAMED.slice(0, 3), play("voice/v1/c.mp3"), ...FRAMED.slice(4)],
        { generation: () => 4 },
        "scripts changed while stashed",
      ],
    ])("%s", (_name, resume, expanded, overrides, blocked) => {
      expect(planResume(resume, expanded, false, world(overrides))).toEqual({ kind: "whole", blocked });
    });

    it("compares a pool-drawn slot by its pool, so another take is the same expansion", () => {
      const fresh = [...FRAMED];
      fresh[2] = play("voice/v1/a-02.mp3", { pool: "words" });

      expect(planResume(stash(FRAMED, 3), fresh, false, world()).kind).toBe("resume");
    });
  });

  describe("resume: the tail and its re-key", () => {
    it("replays the delivered ops tagged `open` ahead of the tail, and hands back the head", () => {
      const plan = planResume(stash(FRAMED, 3), FRAMED, false, world());

      expect(plan).toEqual({
        kind: "resume",
        ops: [FRAMED[0], FRAMED[1], ...FRAMED.slice(3)],
        sourceStart: 3,
        prerollCount: 2,
        head: FRAMED.slice(0, 3),
      });
    });

    it("cut inside a two-op open, replays the part already delivered rather than doubling it", () => {
      const plan = planResume(stash(FRAMED, 1), FRAMED, false, world());

      expect(plan).toMatchObject({
        kind: "resume",
        ops: [FRAMED[0], ...FRAMED.slice(1)],
        sourceStart: 1,
        prerollCount: 1,
      });
    });

    it('re-keys nothing for a body whose frame was never opened (`frame: "none"`)', () => {
      const bare = [play("voice/v1/a.mp3"), play("voice/v1/b.mp3"), play("voice/v1/c.mp3")];
      const plan = planResume(stash(bare, 1), bare, false, world());

      expect(plan).toEqual({
        kind: "resume",
        ops: bare.slice(1),
        sourceStart: 1,
        prerollCount: 0,
        head: bare.slice(0, 1),
      });
    });

    it("never reads the open tick for a scripted contract", () => {
      const openTick = vi.fn(() => TICK_OPEN);

      planResume(stash(FRAMED, 3), FRAMED, false, world({ openTick }));

      expect(openTick).not.toHaveBeenCalled();
    });

    it("a legacy scenario whose expansion carries a frame tag is re-keyed by the tag, not by path", () => {
      const openTick = vi.fn(() => TICK_OPEN);
      const plan = planResume(stash(FRAMED, 3), FRAMED, true, world({ openTick }));

      expect(plan).toMatchObject({ kind: "resume", prerollCount: 2 });
      expect(openTick).not.toHaveBeenCalled();
    });
  });

  describe("resume: the legacy preroll by path", () => {
    /** A legacy sequence that re-keys itself: the tick again before its second clip. */
    const REKEYED: ExecOp[] = [LEGACY[0], LEGACY[1], LEGACY[0], LEGACY[2], LEGACY[3]];

    it.each<[string, ExecOp[], number, ExecOp[], string]>([
      [
        "the tick was delivered: re-key with the manifest's open tick",
        LEGACY,
        2,
        [{ kind: "play", channel: AudioChannel.SFX, path: TICK_OPEN }],
        TICK_OPEN,
      ],
      ["the tail itself begins with the tick: no re-key", REKEYED, 2, [], TICK_OPEN],
      [
        "the tick was never delivered (the manifest's tick is another clip): no re-key",
        LEGACY,
        2,
        [],
        "sfx/other-open.mp3",
      ],
    ])("%s", (_name, ops, index, preroll, tick) => {
      const openTick = vi.fn(() => tick);
      const plan = planResume(stash(ops, index), ops, true, world({ openTick }));

      expect(plan).toEqual({
        kind: "resume",
        ops: [...preroll, ...ops.slice(index)],
        sourceStart: index,
        prerollCount: preroll.length,
        head: ops.slice(0, index),
      });
      // Read at the call, for this path only — `setManifest` may have swapped it.
      expect(openTick).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── buildResumeState ────────────────────────────────────────────────────────

describe("buildResumeState", () => {
  it.each<[string, Partial<ActiveFireView>, number | undefined]>([
    ["a fresh fire before its first op", { index: 0 }, 0],
    ["a fresh fire with its first op in flight", { index: 1 }, 0],
    ["a fresh fire with its third op in flight", { index: 3 }, 2],
    // A resumed fire: `ops` is `[preroll…] + sourceOps.slice(sourceStart)`.
    [
      "a resumed fire still in its preroll",
      { ops: [FRAMED[0], FRAMED[1], ...FRAMED.slice(3)], index: 1, sourceStart: 3, prerollCount: 2 },
      3,
    ],
    [
      "a resumed fire with its tail's first op in flight",
      { ops: [FRAMED[0], FRAMED[1], ...FRAMED.slice(3)], index: 3, sourceStart: 3, prerollCount: 2 },
      3,
    ],
    [
      "a resumed fire with its tail's second op in flight",
      { ops: [FRAMED[0], FRAMED[1], ...FRAMED.slice(3)], index: 4, sourceStart: 3, prerollCount: 2 },
      4,
    ],
    ["a fire whose position maps past its source expansion", { index: 8, sourceStart: 5, prerollCount: 0 }, undefined],
  ])("%s", (_name, overrides, sourceIndex) => {
    const state = buildResumeState(fire(overrides), "v1", 7);

    if (sourceIndex === undefined) {
      expect(state).toBeUndefined();
    } else {
      expect(state).toEqual({ ops: FRAMED, index: sourceIndex, voice: "v1", generation: 7 });
    }
  });

  it("stamps the voice and generation it was handed, `null` voice included", () => {
    expect(buildResumeState(fire({ index: 2 }), null, 0)).toEqual({
      ops: FRAMED,
      index: 1,
      voice: null,
      generation: 0,
    });
  });
});
