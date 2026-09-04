import type { CalloutScript, ScriptStep } from "@iracedeck/callout-script";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_FRAME, NO_FRAME, type ResolvedStep, resolveStep, type Step } from "./dsl.js";
import { type CompileDeps, compileVoiceScript } from "./script-compiler.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const RADIO_FRAME = {
  open: ["/sfx/IRD-tick-open.mp3", { ambient: "start" as const }, { ambient: "seek" as const }],
  close: [{ ambient: "stop" as const }, "/sfx/IRD-tick-close.mp3"],
};

/** A script with one framed scenario, the radio frame and one pool. */
function script(overrides: Partial<CalloutScript> = {}): CalloutScript {
  return {
    schema: 1,
    scenarios: {
      "pit-crew.flag-blue": { sequence: ["pool:flag-blue"] },
    },
    frames: { radio: RADIO_FRAME },
    pools: { "flag-blue": { group: "flags", base: "blue" } },
    ...overrides,
  };
}

function deps(overrides: Partial<CompileDeps> = {}): CompileDeps {
  return {
    contracts: new Map([["pit-crew.flag-blue", { frame: DEFAULT_FRAME }]]),
    vars: new Set(["position.number"]),
    conds: new Map([["session.isRace", () => true]]),
    cases: new Map([
      ["session.type", { resolve: () => "race", keys: new Set(["practice", "qualifying", "race"]) }],
    ]),
    legacyPools: new Set(["connector", "acknowledgment"]),
    fragments: new Set(["pit-crew.some-fragment"]),
    ...overrides,
  };
}

/** One scripted scenario over the default fixture, returning what compiled. */
function compileOne(
  sequence: ScriptStep[],
  extra: { deps?: Partial<CompileDeps>; script?: Partial<CalloutScript> } = {},
) {
  const compiled = compileVoiceScript(
    script({ scenarios: { "pit-crew.flag-blue": { sequence } }, ...extra.script }),
    deps(extra.deps),
  );

  return {
    compiled,
    scenario: compiled.scenarios.get("pit-crew.flag-blue"),
    skip: compiled.skipped.find((s) => s.id === "pit-crew.flag-blue"),
  };
}

/**
 * Structural view of a resolved step tree with the predicate closures
 * replaced by a marker, so a compiled `if` can be compared against the
 * closure DSL's resolution of the same shape.
 */
function shape(steps: readonly ResolvedStep[]): unknown[] {
  return steps.map((step) => {
    switch (step.kind) {
      case "if":
        return { kind: "if", then: shape(step.then), else: step.else ? shape(step.else) : undefined };
      case "optional":
        return { kind: "optional", steps: shape(step.steps) };
      case "case":
        return {
          kind: "case",
          name: step.name,
          of: Object.fromEntries([...step.of].map(([key, branch]) => [key, shape(branch)])),
          fallback: shape(step.fallback),
        };
      default:
        return step;
    }
  });
}

// ─── Conversion ──────────────────────────────────────────────────────────────

describe("compileVoiceScript — step conversion", () => {
  it("compiles every step form to the ResolvedStep the closure DSL produces for the same shape", () => {
    const scriptSteps: ScriptStep[] = [
      "pool:flag-blue",
      "pause:250",
      "@pit-crew.some-fragment",
      "{{position.number}}",
      "flags/blue-01.mp3",
      { clip: "flags/blue-02.mp3" },
      { var: "position.number" },
      { pool: "flag-blue", noRepeat: false },
      { connector: true },
      { pause: 100 },
      { include: "pit-crew.some-fragment" },
      { ambient: "seek" },
      { optional: ["{{position.number}}", { pause: 50 }] },
      { if: "session.isRace", then: ["pool:flag-blue"], else: [{ optional: ["flags/blue-01.mp3"] }] },
    ];
    const closureSteps: Step[] = [
      "pool:flag-blue",
      "pause:250",
      "@pit-crew.some-fragment",
      "{{position.number}}",
      "flags/blue-01.mp3",
      { clip: "flags/blue-02.mp3" },
      { var: "position.number" },
      { pool: "flag-blue", noRepeat: false },
      { connector: true },
      { pause: 100 },
      { include: "pit-crew.some-fragment" },
      { ambient: "seek" },
      { optional: ["{{position.number}}", { pause: 50 }] },
      { if: () => true, then: ["pool:flag-blue"], else: [{ optional: ["flags/blue-01.mp3"] }] },
    ];

    const { scenario, skip } = compileOne(scriptSteps);

    expect(skip).toBeUndefined();
    expect(shape(scenario!.resolved)).toEqual(shape(closureSteps.map(resolveStep)));
  });

  it("compiles a `case` into the declared branches plus the `default` fallback", () => {
    const { scenario } = compileOne([
      {
        case: "session.type",
        of: { practice: ["flags/blue-01.mp3"], race: ["pool:flag-blue"], default: [{ pause: 10 }] },
      },
    ]);

    expect(shape(scenario!.resolved)).toEqual([
      {
        kind: "case",
        name: "session.type",
        of: {
          practice: [{ kind: "clip", path: "flags/blue-01.mp3" }],
          race: [{ kind: "pool", name: "flag-blue", noRepeat: true }],
        },
        fallback: [{ kind: "pause", ms: 10 }],
      },
    ]);
  });

  it("gives a `case` with no `default` an empty fallback", () => {
    const { scenario } = compileOne([{ case: "session.type", of: { race: ["pool:flag-blue"] } }]);
    const step = scenario!.resolved[0];

    expect(step.kind).toBe("case");
    expect(step.kind === "case" && step.fallback).toEqual([]);
  });

  it("compiles `if` to a predicate that calls the registered condition each time", () => {
    const cond = vi.fn(() => true);
    const { scenario } = compileOne([{ if: "session.isRace", then: ["pool:flag-blue"] }], {
      deps: { conds: new Map([["session.isRace", cond]]) },
    });
    const step = scenario!.resolved[0];

    expect(step.kind).toBe("if");

    if (step.kind !== "if") throw new Error("unreachable");

    expect(step.predicate({} as never)).toBe(true);
    expect(step.predicate({} as never)).toBe(true);
    expect(cond).toHaveBeenCalledTimes(2);
  });

  it("compiles `!cond` to a predicate that negates the registered condition", () => {
    const cond = vi.fn(() => true);
    const { scenario } = compileOne([{ if: "!session.isRace", then: ["pool:flag-blue"] }], {
      deps: { conds: new Map([["session.isRace", cond]]) },
    });
    const step = scenario!.resolved[0];

    if (step.kind !== "if") throw new Error("expected an if step");

    expect(step.predicate({} as never)).toBe(false);
    cond.mockReturnValue(false);
    expect(step.predicate({} as never)).toBe(true);
  });

  it("lets a throwing condition propagate so the interpreter's existing catch logs it and reads false", () => {
    const { scenario } = compileOne([{ if: "!session.isRace", then: ["pool:flag-blue"] }], {
      deps: {
        conds: new Map([
          [
            "session.isRace",
            () => {
              throw new Error("boom");
            },
          ],
        ]),
      },
    });
    const step = scenario!.resolved[0];

    if (step.kind !== "if") throw new Error("expected an if step");

    // Negated or not, a throw must never become `true`: the interpreter treats
    // a thrown predicate as false, which is only reachable if the throw escapes.
    expect(() => step.predicate({} as never)).toThrow("boom");
  });
});

// ─── Frames ──────────────────────────────────────────────────────────────────

describe("compileVoiceScript — frames", () => {
  it("assigns the contract's default frame when the entry names none", () => {
    const { scenario } = compileOne(["pool:flag-blue"]);

    expect(scenario!.frame).toBe(DEFAULT_FRAME);
  });

  it("lets an entry's `frame` override the contract default", () => {
    const compiled = compileVoiceScript(
      script({
        scenarios: { "pit-crew.flag-blue": { frame: "terse", sequence: ["pool:flag-blue"] } },
        frames: { radio: RADIO_FRAME, terse: { open: ["/sfx/IRD-tick-open.mp3"], close: [] } },
      }),
      deps(),
    );

    expect(compiled.scenarios.get("pit-crew.flag-blue")!.frame).toBe("terse");
  });

  it("never needs a definition for NO_FRAME, from the entry or from the contract", () => {
    const fromEntry = compileVoiceScript(
      script({ scenarios: { "pit-crew.flag-blue": { frame: NO_FRAME, sequence: ["pool:flag-blue"] } }, frames: {} }),
      deps(),
    );
    const fromContract = compileVoiceScript(
      script({ frames: {} }),
      deps({ contracts: new Map([["pit-crew.flag-blue", { frame: NO_FRAME }]]) }),
    );

    expect(fromEntry.scenarios.get("pit-crew.flag-blue")!.frame).toBe(NO_FRAME);
    expect(fromContract.scenarios.get("pit-crew.flag-blue")!.frame).toBe(NO_FRAME);
    expect(fromEntry.skipped).toEqual([]);
    expect(fromContract.skipped).toEqual([]);
  });

  it("skips an entry that needs the default frame when the script defines no such frame", () => {
    const { scenario, skip } = compileOne(["pool:flag-blue"], { script: { frames: {} } });

    expect(scenario).toBeUndefined();
    expect(skip).toEqual({ id: "pit-crew.flag-blue", reason: 'unknown frame "radio"', deliberate: false });
  });

  it("skips an entry whose frame override names no defined frame", () => {
    const compiled = compileVoiceScript(
      script({ scenarios: { "pit-crew.flag-blue": { frame: "ghost", sequence: ["pool:flag-blue"] } } }),
      deps(),
    );

    expect(compiled.skipped).toEqual([
      { id: "pit-crew.flag-blue", reason: 'unknown frame "ghost"', deliberate: false },
    ]);
  });

  it("compiles every frame's own steps and exposes them by name", () => {
    const { compiled } = compileOne(["pool:flag-blue"]);
    const radio = compiled.frames.get("radio")!;

    expect(shape(radio.open)).toEqual([
      { kind: "clip", path: "/sfx/IRD-tick-open.mp3" },
      { kind: "ambient", action: "start" },
      { kind: "ambient", action: "seek" },
    ]);
    expect(shape(radio.close)).toEqual([
      { kind: "ambient", action: "stop" },
      { kind: "clip", path: "/sfx/IRD-tick-close.mp3" },
    ]);
  });

  it("skips a scenario whose frame references something unknown, naming the frame and the reference", () => {
    const { compiled, scenario } = compileOne(["pool:flag-blue"], {
      script: { frames: { radio: { open: ["pool:beep"], close: [] } } },
    });

    expect(scenario).toBeUndefined();
    expect(compiled.frames.has("radio")).toBe(false);
    expect(compiled.skipped).toEqual([
      { id: "pit-crew.flag-blue", reason: 'frame "radio": unknown pool "beep"', deliberate: false },
    ]);
  });
});

// ─── Pools ───────────────────────────────────────────────────────────────────

describe("compileVoiceScript — pools", () => {
  it("exposes the script's pool definitions without their comments", () => {
    const { compiled } = compileOne(["pool:flag-blue"], {
      script: { pools: { "flag-blue": { group: "flags", base: "blue", comment: "why" } } },
    });

    expect([...compiled.pools]).toEqual([["flag-blue", { group: "flags", base: "blue" }]]);
  });

  it("skips an entry that references a pool neither the script nor the code registry defines", () => {
    const { scenario, skip } = compileOne(["pool:flag-purple"]);

    expect(scenario).toBeUndefined();
    expect(skip).toEqual({ id: "pit-crew.flag-blue", reason: 'unknown pool "flag-purple"', deliberate: false });
  });

  it("accepts a pool that only the code registry defines", () => {
    const { scenario, skip } = compileOne([{ pool: "acknowledgment" }]);

    expect(skip).toBeUndefined();
    expect(shape(scenario!.resolved)).toEqual([{ kind: "pool", name: "acknowledgment", noRepeat: true }]);
  });

  it("does not let a prototype property pass for a pool definition", () => {
    const { skip } = compileOne(["pool:constructor"]);

    expect(skip).toEqual({ id: "pit-crew.flag-blue", reason: 'unknown pool "constructor"', deliberate: false });
  });

  it("accepts a slashed group/base pool without any definition", () => {
    const { scenario, skip } = compileOne(["pool:flags/blue"]);

    expect(skip).toBeUndefined();
    expect(shape(scenario!.resolved)).toEqual([{ kind: "pool", name: "flags/blue", noRepeat: true }]);
  });

  it("requires the connector pool for a connector step", () => {
    const { skip } = compileOne([{ connector: true }], { deps: { legacyPools: new Set() } });

    expect(skip).toEqual({ id: "pit-crew.flag-blue", reason: 'unknown pool "connector"', deliberate: false });
  });

  it("lets a script's own connector pool satisfy a connector step", () => {
    const { skip } = compileOne([{ connector: true }], {
      deps: { legacyPools: new Set() },
      script: { pools: { connector: { group: "connector", base: "and" } } },
    });

    expect(skip).toBeUndefined();
  });
});

// ─── References ──────────────────────────────────────────────────────────────

describe("compileVoiceScript — unknown references", () => {
  it.each<[string, ScriptStep, string]>([
    ["var (string form)", "{{ghost}}", 'unknown var "ghost"'],
    ["var (object form)", { var: "ghost" }, 'unknown var "ghost"'],
    ["cond", { if: "ghost", then: [] }, 'unknown condition "ghost"'],
    ["negated cond", { if: "!ghost", then: [] }, 'unknown condition "ghost"'],
    ["case", { case: "ghost", of: { default: [] } }, 'unknown case "ghost"'],
    ["include (string form)", "@ghost", 'unknown include "ghost"'],
    ["include (object form)", { include: "ghost" }, 'unknown include "ghost"'],
    ["nested in then", { if: "session.isRace", then: ["{{ghost}}"] }, 'unknown var "ghost"'],
    ["nested in else", { if: "session.isRace", then: [], else: ["pool:ghost"] }, 'unknown pool "ghost"'],
    ["nested in optional", { optional: ["@ghost"] }, 'unknown include "ghost"'],
    ["nested in a case branch", { case: "session.type", of: { race: ["{{ghost}}"] } }, 'unknown var "ghost"'],
  ])("skips an entry with an unknown %s, naming the reference", (_label, step, reason) => {
    const { scenario, skip } = compileOne([step]);

    expect(scenario).toBeUndefined();
    expect(skip).toEqual({ id: "pit-crew.flag-blue", reason, deliberate: false });
  });

  it("skips an entry whose case maps a key the resolver never declared, naming the key", () => {
    const { skip } = compileOne([{ case: "session.type", of: { race: [], hotlap: ["pool:flag-blue"] } }]);

    expect(skip).toEqual({
      id: "pit-crew.flag-blue",
      reason: 'case "session.type": unknown key "hotlap"',
      deliberate: false,
    });
  });

  it("accepts an include that targets a legacy fragment", () => {
    const { skip } = compileOne(["@pit-crew.some-fragment"]);

    expect(skip).toBeUndefined();
  });

  it("reports only the first problem of an entry", () => {
    const { skip } = compileOne(["pool:ghost-a", "pool:ghost-b"]);

    expect(skip!.reason).toBe('unknown pool "ghost-a"');
  });

  it("never throws on a step the grammar would have refused, and names the step instead", () => {
    // The schema rejects this before it ever reaches the engine; the compiler
    // still must not throw when handed it (e.g. a hand-built script in a test).
    const { skip } = compileOne(["pause:abc"]);

    expect(skip).toEqual({
      id: "pit-crew.flag-blue",
      reason: "invalid step: Invalid pause duration: pause:abc",
      deliberate: false,
    });
  });
});

// ─── Skip semantics ──────────────────────────────────────────────────────────

describe("compileVoiceScript — skip semantics", () => {
  it("records a `skip: true` entry as a deliberate skip", () => {
    const compiled = compileVoiceScript(script({ scenarios: { "pit-crew.flag-blue": { skip: true } } }), deps());

    expect(compiled.scenarios.size).toBe(0);
    expect(compiled.skipped).toEqual([{ id: "pit-crew.flag-blue", reason: "skip: true", deliberate: true }]);
  });

  it("records a contract with no entry as a deliberate `no script` skip", () => {
    const compiled = compileVoiceScript(
      script(),
      deps({
        contracts: new Map([
          ["pit-crew.flag-blue", { frame: DEFAULT_FRAME }],
          ["pit-crew.flag-red", { frame: DEFAULT_FRAME }],
        ]),
      }),
    );

    expect(compiled.scenarios.has("pit-crew.flag-blue")).toBe(true);
    expect(compiled.skipped).toEqual([{ id: "pit-crew.flag-red", reason: "no script", deliberate: true }]);
  });

  it("does not let a prototype property pass for a script entry", () => {
    const compiled = compileVoiceScript(
      script({ scenarios: {} }),
      deps({ contracts: new Map([["toString", { frame: NO_FRAME }]]) }),
    );

    expect(compiled.skipped).toEqual([{ id: "toString", reason: "no script", deliberate: true }]);
  });

  it("records an entry whose id is not a contract as a `no contract` skip", () => {
    const compiled = compileVoiceScript(
      script({
        scenarios: { "pit-crew.flag-blue": { sequence: ["pool:flag-blue"] }, "pit-crew.ghost": { sequence: [] } },
      }),
      deps(),
    );

    expect(compiled.skipped).toEqual([{ id: "pit-crew.ghost", reason: "no contract", deliberate: false }]);
  });

  it("records an entry with neither a sequence nor `skip: true` as a `no sequence` skip", () => {
    const compiled = compileVoiceScript(script({ scenarios: { "pit-crew.flag-blue": { skip: false } } }), deps());

    expect(compiled.skipped).toEqual([{ id: "pit-crew.flag-blue", reason: "no sequence", deliberate: false }]);
  });

  it("compiles an empty sequence — the entry is present and says nothing", () => {
    const { scenario, skip } = compileOne([]);

    expect(skip).toBeUndefined();
    expect(scenario!.resolved).toEqual([]);
  });
});
