import { AudioChannel } from "@iracedeck/audio-service";
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecOp } from "./engine-types.js";
import type { AudioAssetsManifest } from "./manifest.js";
import { PoolStore, type ScriptPoolSource } from "./pool-store.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const logger: ILogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
} as unknown as ILogger;

const manifest = (clips: string[]): AudioAssetsManifest => ({
  clips,
  ambientLoop: "sfx/ambient.mp3",
  ticks: { open: "sfx/tick-open.mp3", close: "sfx/tick-close.mp3" },
});

/** Two voices with different variant counts for `greet/hi`, plus two static clips. */
const twoVoices = manifest([
  "voice/v1/greet/hi-01.mp3",
  "voice/v1/greet/hi-02.mp3",
  "voice/v2/greet/hi-01.mp3",
  "voice/v2/greet/hi-02.mp3",
  "voice/v2/greet/hi-03.mp3",
  "static/a.mp3",
  "static/b.mp3",
  "static/c.mp3",
]);

const noScriptPools: ScriptPoolSource = () => undefined;

const play = (path: string, pool?: string): ExecOp => ({ kind: "play", channel: AudioChannel.Voice, path, pool });

/** Pin `Math.random` so a pick is the index `floor(value * clips.length)` before the no-repeat guard. */
const randomAt = (value: number): void => {
  vi.spyOn(Math, "random").mockReturnValue(value);
};

let voice: string | null;
let store: PoolStore;

beforeEach(() => {
  vi.clearAllMocks();
  voice = "v1";
  store = new PoolStore(twoVoices, logger, () => voice, noScriptPools);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Commit on acceptance ────────────────────────────────────────────────────

describe("PickSession", () => {
  it("commits a pick into the pool's no-repeat tracker only on commit, not at the pick", () => {
    store.definePool("abc", ["static/a.mp3", "static/b.mp3", "static/c.mp3"]);
    randomAt(0);

    // Two sessions that are never committed draw the same take: nothing was
    // heard, so nothing is avoided.
    expect(store.pickFromPool("abc", store.openSession(), true)).toBe("static/a.mp3");
    expect(store.pickFromPool("abc", store.openSession(), true)).toBe("static/a.mp3");

    const accepted = store.openSession();
    expect(store.pickFromPool("abc", accepted, true)).toBe("static/a.mp3");
    accepted.commit();

    // The committed take is now the one the next fire steers away from.
    expect(store.pickFromPool("abc", store.openSession(), true)).toBe("static/b.mp3");
  });

  it("consults the session first, so two draws from one pool inside one body avoid each other", () => {
    store.definePool("abc", ["static/a.mp3", "static/b.mp3", "static/c.mp3"]);
    randomAt(0);

    const session = store.openSession();
    expect(store.pickFromPool("abc", session, true)).toBe("static/a.mp3");
    expect(store.pickFromPool("abc", session, true)).toBe("static/b.mp3");
  });

  it("does not avoid the last take when noRepeat is off", () => {
    store.definePool("abc", ["static/a.mp3", "static/b.mp3", "static/c.mp3"]);
    randomAt(0);

    const session = store.openSession();
    expect(store.pickFromPool("abc", session, false)).toBe("static/a.mp3");
    expect(store.pickFromPool("abc", session, false)).toBe("static/a.mp3");
  });

  it("restores a snapshot, so the picks of a failed attempt commit nothing", () => {
    store.definePool("abc", ["static/a.mp3", "static/b.mp3", "static/c.mp3"]);
    randomAt(0);

    const session = store.openSession();
    expect(store.pickFromPool("abc", session, true)).toBe("static/a.mp3");

    const before = session.snapshot();
    // The attempt that will fail draws the next take…
    expect(store.pickFromPool("abc", session, true)).toBe("static/b.mp3");
    // …and is put back.
    session.restore(before);
    session.commit();

    // Only `a` was committed: the next fire avoids `a`, not `b`.
    expect(store.pickFromPool("abc", store.openSession(), true)).toBe("static/b.mp3");
  });

  it("a snapshot is a copy: picks made after it do not leak into it", () => {
    store.definePool("abc", ["static/a.mp3", "static/b.mp3", "static/c.mp3"]);
    randomAt(0);

    const session = store.openSession();
    const empty = session.snapshot();
    store.pickFromPool("abc", session, true);
    session.restore(empty);
    session.commit();

    // Nothing committed, so the next session draws `a` again.
    expect(store.pickFromPool("abc", store.openSession(), true)).toBe("static/a.mp3");
  });
});

// ─── setManifest ─────────────────────────────────────────────────────────────

describe("setManifest", () => {
  it("re-derives manifest pools, drops cached refs and resets every tracker", () => {
    store.definePoolFromManifest("greet", "greet", "hi");
    store.definePool("ab", ["static/a.mp3", "static/b.mp3"]);
    randomAt(0.9);

    // v1 has two takes of `hi`; the cached ref sees the same two.
    const first = store.openSession();
    expect(store.pickFromPool("greet", first, true)).toBe("voice/v1/greet/hi-02.mp3");
    expect(store.pickFromPoolRef("pool:greet/hi", first)).toBe("voice/v1/greet/hi-02.mp3");
    expect(store.pickFromPool("ab", first, true)).toBe("static/b.mp3");
    first.commit();
    expect(store.pools.has("pool:greet/hi")).toBe(true);

    store.setManifest(manifest(["voice/v1/greet/hi-01.mp3", "static/a.mp3", "static/b.mp3"]));

    // The cached ref is gone until the next pick rebuilds it against the new manifest.
    expect(store.pools.has("pool:greet/hi")).toBe(false);
    expect(store.hasClip("voice/v1/greet/hi-02.mp3")).toBe(false);
    expect(store.currentManifest().clips).toHaveLength(3);

    const after = store.openSession();
    // Both the registered pool and the ref now hold one take.
    expect(store.pickFromPool("greet", after, true)).toBe("voice/v1/greet/hi-01.mp3");
    expect(store.pickFromPoolRef("pool:greet/hi", after)).toBe("voice/v1/greet/hi-01.mp3");
    // The static pool keeps its clips but its tracker was reset: without the
    // reset the committed `b` would steer this pick to `a`.
    expect(store.pickFromPool("ab", after, true)).toBe("static/b.mp3");
  });

  it("drops a script-defined pool's cached state", () => {
    const source: ScriptPoolSource = (_voice, name) => (name === "line" ? { group: "greet", base: "hi" } : undefined);
    store = new PoolStore(twoVoices, logger, () => voice, source);
    randomAt(0.9);

    expect(store.pickFromPool("line", store.openSession(), true)).toBe("voice/v1/greet/hi-02.mp3");

    store.setManifest(manifest(["voice/v1/greet/hi-01.mp3"]));

    expect(store.pickFromPool("line", store.openSession(), true)).toBe("voice/v1/greet/hi-01.mp3");
  });
});

// ─── The voice-change reset ──────────────────────────────────────────────────

describe("the no-repeat reset on a voice change", () => {
  it("is written at pick time, so it holds even for a fire the gate refuses afterwards", () => {
    store.definePoolFromManifest("greet", "greet", "hi");
    randomAt(0);

    // v1 hears take 0 and commits it.
    const heard = store.openSession();
    expect(store.pickFromPool("greet", heard, true)).toBe("voice/v1/greet/hi-01.mp3");
    heard.commit();

    // v2 picks, and the fire is refused by the gate: no commit.
    voice = "v2";
    expect(store.pickFromPool("greet", store.openSession(), true)).toBe("voice/v2/greet/hi-01.mp3");

    // Back on v1 the tracker was reset by the v2 pick: were the reset part of
    // the commit, `lastIndex` would still be 0 for v1 and this would be hi-02.
    voice = "v1";
    expect(store.pickFromPool("greet", store.openSession(), true)).toBe("voice/v1/greet/hi-01.mp3");
  });

  it("applies to a cached ref too", () => {
    randomAt(0);

    const heard = store.openSession();
    expect(store.pickFromPoolRef("pool:greet/hi", heard)).toBe("voice/v1/greet/hi-01.mp3");
    heard.commit();
    // The same voice avoids the committed take…
    expect(store.pickFromPoolRef("pool:greet/hi", store.openSession())).toBe("voice/v1/greet/hi-02.mp3");

    // …and another voice starts fresh.
    voice = "v2";
    expect(store.pickFromPoolRef("pool:greet/hi", store.openSession())).toBe("voice/v2/greet/hi-01.mp3");
  });
});

// ─── restoreHeadPoolIndices ──────────────────────────────────────────────────

describe("restoreHeadPoolIndices", () => {
  it("puts back only the pools the remaining ops do not draw", () => {
    store.definePool("p1", ["static/a.mp3", "static/b.mp3", "static/c.mp3"]);
    store.definePool("p2", ["static/a.mp3", "static/b.mp3"]);

    // The fresh expansion committed take 2 of p1 and take 1 of p2.
    randomAt(0.9);
    const fresh = store.openSession();
    expect(store.pickFromPool("p1", fresh, true)).toBe("static/c.mp3");
    expect(store.pickFromPool("p2", fresh, true)).toBe("static/b.mp3");
    fresh.commit();

    // The stashed head played take 0 of both; the resumed tail still draws p2.
    const head = [play("static/a.mp3", "p1"), play("static/a.mp3", "p2")];
    const remaining = [play("static/b.mp3", "p2")];
    store.restoreHeadPoolIndices(head, remaining);

    randomAt(0);
    const next = store.openSession();
    // p1 was put back to take 0, so the next fire avoids `a`.
    expect(store.pickFromPool("p1", next, true)).toBe("static/b.mp3");
    // p2 kept its fresh commit (take 1), so take 0 is free.
    expect(store.pickFromPool("p2", next, true)).toBe("static/a.mp3");
  });

  it("skips a pool it cannot account for and a path not in the pool", () => {
    store.definePool("p1", ["static/a.mp3", "static/b.mp3"]);
    randomAt(0.9);
    const fresh = store.openSession();
    store.pickFromPool("p1", fresh, true);
    fresh.commit();

    expect(() =>
      store.restoreHeadPoolIndices([play("x.mp3", "unknown"), play("not-in-pool.mp3", "p1"), play("static/a.mp3")], []),
    ).not.toThrow();

    // p1's tracker is untouched: take 1 is still avoided.
    randomAt(0.9);
    expect(store.pickFromPool("p1", store.openSession(), true)).toBe("static/a.mp3");
  });

  it("matches a {voice}-templated static pool by the path the op carries", () => {
    store.definePool("hi", ["voice/{voice}/greet/hi-01.mp3", "voice/{voice}/greet/hi-02.mp3"]);
    randomAt(0.9);
    const fresh = store.openSession();
    expect(store.pickFromPool("hi", fresh, true)).toBe("voice/{voice}/greet/hi-02.mp3");
    fresh.commit();

    store.restoreHeadPoolIndices([play("voice/v1/greet/hi-01.mp3", "hi")], []);

    randomAt(0);
    expect(store.pickFromPool("hi", store.openSession(), true)).toBe("voice/{voice}/greet/hi-02.mp3");
  });
});

// ─── Registration and views ──────────────────────────────────────────────────

describe("definePool", () => {
  it("rejects a pool naming a clip the manifest lacks, and reports it", () => {
    expect(store.definePool("bad", ["static/a.mp3", "static/missing.mp3"])).toBe(false);
    expect(store.pools.has("bad")).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Pool "bad" rejected'));
  });

  it("accepts a pool whose clips exist and warns on a reference-voice miss without rejecting", () => {
    expect(store.definePool("ok", ["static/a.mp3"])).toBe(true);
    expect(store.definePool("typo", ["voice/{voice}/greet/nope.mp3"])).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Pool "typo": no clip for reference voice'));
  });
});

describe("views", () => {
  it("registeredPoolNames lists registered names and never a cached ref", () => {
    store.definePool("ab", ["static/a.mp3"]);
    store.definePoolFromManifest("greet", "greet", "hi");
    store.pickFromPoolRef("pool:greet/hi", store.openSession());

    expect(store.pools.has("pool:greet/hi")).toBe(true);
    expect([...store.registeredPoolNames()].sort()).toEqual(["ab", "greet"]);
  });

  it("a script-defined pool shadows a registered pool of the same name for the active voice only", () => {
    const source: ScriptPoolSource = (v, name) =>
      v === "v1" && name === "line" ? { group: "greet", base: "hi" } : undefined;
    store = new PoolStore(twoVoices, logger, () => voice, source);
    store.definePool("line", ["static/a.mp3"]);
    randomAt(0);

    expect(store.pickFromPool("line", store.openSession(), true)).toBe("voice/v1/greet/hi-01.mp3");

    voice = "v2";
    expect(store.pickFromPool("line", store.openSession(), true)).toBe("static/a.mp3");
  });

  it("clearScriptPools drops the per-voice cache so the next pick rebuilds it", () => {
    const source: ScriptPoolSource = (_v, name) => (name === "line" ? { group: "greet", base: "hi" } : undefined);
    store = new PoolStore(twoVoices, logger, () => voice, source);
    randomAt(0);

    const heard = store.openSession();
    expect(store.pickFromPool("line", heard, true)).toBe("voice/v1/greet/hi-01.mp3");
    heard.commit();
    expect(store.pickFromPool("line", store.openSession(), true)).toBe("voice/v1/greet/hi-02.mp3");

    // A rebuilt pool starts with no take heard.
    store.clearScriptPools();
    expect(store.pickFromPool("line", store.openSession(), true)).toBe("voice/v1/greet/hi-01.mp3");
  });

  it("substituteVoice fills the placeholder with the active voice and leaves other paths alone", () => {
    expect(store.substituteVoice("voice/{voice}/greet/hi-01.mp3")).toBe("voice/v1/greet/hi-01.mp3");
    expect(store.substituteVoice("static/a.mp3")).toBe("static/a.mp3");

    voice = null;
    expect(store.substituteVoice("voice/{voice}/greet/hi-01.mp3")).toBe("voice//greet/hi-01.mp3");
  });

  it("a manifest pool with no active voice, or empty for it, picks nothing", () => {
    store.definePoolFromManifest("greet", "greet", "hi");

    voice = null;
    expect(store.pickFromPool("greet", store.openSession(), true)).toBeNull();

    voice = "v3";
    expect(store.pickFromPool("greet", store.openSession(), true)).toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("an unknown pool and a malformed ref are errors that pick nothing", () => {
    expect(store.pickFromPool("nope", store.openSession(), true)).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('unknown pool "nope"'));

    expect(store.pickFromPoolRef("pool:nobase/", store.openSession())).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('malformed pool reference "pool:nobase/"'));
  });
});
