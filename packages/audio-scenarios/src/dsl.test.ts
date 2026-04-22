import { describe, expect, it } from "vitest";

import { applyBase, parseStepShorthand, resolveStep } from "./dsl.js";

describe("parseStepShorthand", () => {
  it("treats a bare path as a clip", () => {
    expect(parseStepShorthand("foo/bar.mp3")).toEqual({ kind: "clip", path: "foo/bar.mp3" });
  });

  it("preserves a leading slash on a clip path for later base-escape handling", () => {
    expect(parseStepShorthand("/sfx/IRD-tick-open.mp3")).toEqual({
      kind: "clip",
      path: "/sfx/IRD-tick-open.mp3",
    });
  });

  it("parses pool:<name>", () => {
    expect(parseStepShorthand("pool:greeting")).toEqual({
      kind: "pool",
      name: "greeting",
      noRepeat: true,
    });
  });

  it("parses pause:<ms>", () => {
    expect(parseStepShorthand("pause:500")).toEqual({ kind: "pause", ms: 500 });
  });

  it("rejects a negative pause duration", () => {
    expect(() => parseStepShorthand("pause:-10")).toThrow("Invalid pause duration");
  });

  it("rejects a non-numeric pause duration", () => {
    expect(() => parseStepShorthand("pause:abc")).toThrow("Invalid pause duration");
  });

  it("parses @<id> as include", () => {
    expect(parseStepShorthand("@pit-crew.radio-open")).toEqual({
      kind: "include",
      id: "pit-crew.radio-open",
    });
  });

  it("parses {{name}} as var", () => {
    expect(parseStepShorthand("{{driver}}")).toEqual({ kind: "var", name: "driver" });
  });
});

describe("resolveStep", () => {
  it("normalizes the object form of every step type", () => {
    expect(resolveStep({ clip: "a.mp3" })).toEqual({ kind: "clip", path: "a.mp3" });
    expect(resolveStep({ var: "name" })).toEqual({ kind: "var", name: "name" });
    expect(resolveStep({ pool: "greeting" })).toEqual({ kind: "pool", name: "greeting", noRepeat: true });
    expect(resolveStep({ pool: "greeting", noRepeat: false })).toEqual({
      kind: "pool",
      name: "greeting",
      noRepeat: false,
    });
    expect(resolveStep({ connector: true })).toEqual({ kind: "connector" });
    expect(resolveStep({ pause: 250 })).toEqual({ kind: "pause", ms: 250 });
    expect(resolveStep({ include: "other" })).toEqual({ kind: "include", id: "other" });
    expect(resolveStep({ ambient: "start" })).toEqual({ kind: "ambient", action: "start" });
  });

  it("recursively resolves `if` branches", () => {
    const predicate = () => true;
    const out = resolveStep({ if: predicate, then: ["a.mp3"], else: ["b.mp3"] });

    expect(out).toEqual({
      kind: "if",
      predicate,
      then: [{ kind: "clip", path: "a.mp3" }],
      else: [{ kind: "clip", path: "b.mp3" }],
    });
  });
});

describe("applyBase", () => {
  it("prefixes a relative path with the base", () => {
    expect(applyBase("pit-crew", "greeting/alright.mp3")).toBe("pit-crew/greeting/alright.mp3");
  });

  it("strips the leading slash to escape the base", () => {
    expect(applyBase("pit-crew", "/sfx/IRD-tick-open.mp3")).toBe("sfx/IRD-tick-open.mp3");
  });

  it("passes through unchanged when no base is set", () => {
    expect(applyBase(undefined, "sfx/IRD-tick-open.mp3")).toBe("sfx/IRD-tick-open.mp3");
  });
});
