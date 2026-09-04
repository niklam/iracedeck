import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { NO_FRAME as GRAMMAR_NO_FRAME, parseStringStep, POOL_NAME_PATTERN } from "@iracedeck/callout-script";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { ResolvedStep, Scenario, ScenarioContract } from "./dsl.js";
import { applyBase, DEFAULT_FRAME, NO_FRAME, parseStepShorthand, resolveStep, WEIGHT } from "./dsl.js";

describe("WEIGHT bands", () => {
  it("orders the bands TRANSIENT < CHATTER < NORMAL < SAFETY < CRITICAL < PROXIMITY", () => {
    expect(WEIGHT.TRANSIENT).toBeLessThan(WEIGHT.CHATTER);
    expect(WEIGHT.CHATTER).toBeLessThan(WEIGHT.NORMAL);
    expect(WEIGHT.NORMAL).toBeLessThan(WEIGHT.SAFETY);
    expect(WEIGHT.SAFETY).toBeLessThan(WEIGHT.CRITICAL);
    // Strictly above CRITICAL is load-bearing (#867): an equal-weight fire
    // never cuts, so PROXIMITY at CRITICAL would still drop spotter calls
    // behind an in-flight CRITICAL line.
    expect(WEIGHT.PROXIMITY).toBeGreaterThan(WEIGHT.CRITICAL);
  });
});

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

describe("parseStepShorthand agrees with the grammar's parseStringStep (issue #1064)", () => {
  /**
   * Every prefix, plus the edge cases the two parsers are known to read
   * differently. The grammar package narrows on purpose — `"pause:"` is NaN
   * there and `0` here, `"{{}}"` is an empty var there and a clip path here —
   * so the contract pinned below is one-directional: wherever the leaf
   * ACCEPTS a string, the DSL must produce the same kind and payload. What
   * the leaf rejects never reaches the engine (the schema refuses it first),
   * so the DSL's reading of those strings is deliberately unconstrained.
   */
  const corpus = [
    "pool:flag-blue",
    "pool:flags/blue",
    "pool:",
    "pool:A/b/c",
    "pool:flags/blue/extra",
    "pause:250",
    "pause:0",
    "pause:1.5",
    "pause:",
    "pause:abc",
    "pause:-1",
    "pause:Infinity",
    "@pit-crew.radio-open",
    "@",
    "{{position.number}}",
    "{{}}",
    "{{a}}b",
    "{{ spaced name }}",
    "flags/blue-01.mp3",
    "/sfx/IRD-tick-open.mp3",
    "pooled/thing.mp3",
    "pausing/thing.mp3",
    "",
  ];

  /** The grammar's notion of a usable string step, mirroring what its schema admits. */
  function leafAccepts(form: ReturnType<typeof parseStringStep>): boolean {
    switch (form.kind) {
      case "pool":
        return POOL_NAME_PATTERN.test(form.name);
      case "pause":
        return Number.isFinite(form.ms) && form.ms >= 0;
      case "include":
        return form.id.length > 0;
      case "var":
        return form.name.length > 0;
      case "clip":
        return form.path.length > 0;
    }
  }

  const accepted = corpus.filter((s) => leafAccepts(parseStringStep(s)));
  const rejected = corpus.filter((s) => !leafAccepts(parseStringStep(s)));

  it("covers both accepted and rejected strings", () => {
    expect(accepted.length).toBeGreaterThan(8);
    expect(rejected.length).toBeGreaterThan(5);
  });

  it.each(accepted)("reads %j the same way as the grammar", (s) => {
    const leaf = parseStringStep(s);
    const dsl = parseStepShorthand(s);

    expect(dsl.kind).toBe(leaf.kind);

    switch (leaf.kind) {
      case "pool":
        expect(dsl).toEqual({ kind: "pool", name: leaf.name, noRepeat: true });
        break;
      case "pause":
        expect(dsl).toEqual({ kind: "pause", ms: leaf.ms });
        break;
      case "include":
        expect(dsl).toEqual({ kind: "include", id: leaf.id });
        break;
      case "var":
        expect(dsl).toEqual({ kind: "var", name: leaf.name });
        break;
      case "clip":
        expect(dsl).toEqual({ kind: "clip", path: leaf.path });
        break;
    }
  });

  it("documents the two known divergences on strings the grammar rejects", () => {
    expect(parseStringStep("pause:")).toEqual({ kind: "pause", ms: Number.NaN });
    expect(parseStepShorthand("pause:")).toEqual({ kind: "pause", ms: 0 });

    expect(parseStringStep("{{}}")).toEqual({ kind: "var", name: "" });
    expect(parseStepShorthand("{{}}")).toEqual({ kind: "clip", path: "{{}}" });
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

  it("recursively resolves `optional` groups, including nested ones (issue #835)", () => {
    const out = resolveStep({ optional: ["a.mp3", { var: "name" }, { optional: ["b.mp3"] }] });

    expect(out).toEqual({
      kind: "optional",
      steps: [
        { kind: "clip", path: "a.mp3" },
        { kind: "var", name: "name" },
        { kind: "optional", steps: [{ kind: "clip", path: "b.mp3" }] },
      ],
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

// ─── Contracts and frames (issue #1064) ─────────────────────────────────────

describe("Scenario / ScenarioContract", () => {
  it("keeps the legacy Scenario shape assignable — a literal with a sequence still compiles", () => {
    // Type-level: this literal is exactly what every un-migrated catalog file
    // writes today. If `Scenario` stops accepting it, tsc (not vitest) fails
    // on this file — `src/**/*` is in the package's tsconfig.
    const s: Scenario = {
      id: "test.legacy",
      when: { event: "flag.green.raised", where: () => true },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.NORMAL,
      interrupt: false,
      queueable: true,
      resumable: true,
      pendingHoldMs: 0,
      cooldown: 1000,
      focusOwner: "spotter",
      family: "flag",
      triggerDelay: 0,
      base: "voice/{voice}",
      sequence: ["flags/blue-01.mp3", { if: () => true, then: ["pool:x"] }],
    };

    expect(s.sequence).toHaveLength(2);
  });

  it("a Scenario is a ScenarioContract plus a sequence, and a contract carries no sequence", () => {
    const c: ScenarioContract = {
      id: "test.contract",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      frame: NO_FRAME,
    };

    expectTypeOf<Scenario>().toMatchTypeOf<ScenarioContract>();
    expectTypeOf<ScenarioContract>().not.toHaveProperty("sequence");
    expect(c.frame).toBe("none");
  });

  it("names the default frame and the reserved unframed name, sharing the grammar's spelling", () => {
    expect(DEFAULT_FRAME).toBe("radio");
    expect(NO_FRAME).toBe("none");
    expect(NO_FRAME).toBe(GRAMMAR_NO_FRAME);
  });

  it("ResolvedStep carries the compiled `case` kind that only a script can produce", () => {
    const step: ResolvedStep = {
      kind: "case",
      name: "session.type",
      of: new Map([["race", [{ kind: "clip", path: "a.mp3" }]]]),
      fallback: [],
    };

    expect(step.kind).toBe("case");
  });
});
