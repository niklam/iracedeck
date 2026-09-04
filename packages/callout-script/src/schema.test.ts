import { describe, expect, it } from "vitest";

import type { CalloutScript, ScriptStep } from "./grammar.js";
import {
  CalloutScriptEntrySchema,
  CalloutScriptSchema,
  FrameDefinitionSchema,
  parseCalloutScript,
  PoolDefinitionSchema,
  ScriptStepSchema,
} from "./schema.js";

/** The smallest script that parses: one scenario, one step, nothing else. */
function minimal(): CalloutScript {
  return {
    schema: 1,
    scenarios: { "pit-crew.flag-blue": { sequence: ["pool:flag-blue"] } },
    frames: {},
    pools: {},
  };
}

/** A script whose only scenario carries the given sequence. */
function withSequence(sequence: unknown): unknown {
  return { ...minimal(), scenarios: { "pit-crew.flag-blue": { sequence } } };
}

function problemsOf(json: unknown): readonly string[] {
  const result = parseCalloutScript(json);

  if (result.ok) throw new Error("expected the script to be rejected");

  return result.problems;
}

describe("parseCalloutScript", () => {
  it("parses a minimal valid script and returns it unchanged", () => {
    const result = parseCalloutScript(minimal());

    expect(result).toEqual({ ok: true, script: minimal() });
  });

  it("rejects a schema other than 1, naming the schema key", () => {
    const problems = problemsOf({ ...minimal(), schema: 2 });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^schema: /);
    // A higher number means a newer toolchain wrote it: say so, rather than
    // "expected 1", which tells the holder of a perfectly good pack nothing.
    expect(problems[0]).toMatch(/newer version/);
  });

  it("rejects a missing or non-numeric schema without the newer-version hint", () => {
    expect(problemsOf({ ...minimal(), schema: "1" })).toEqual(["schema: must be 1"]);

    const { schema: _schema, ...withoutSchema } = minimal();
    expect(problemsOf(withoutSchema)).toEqual(["schema: must be 1"]);
  });

  it("rejects a document that is not an object under a prefix that is not a key name", () => {
    // `(document)` rather than `schema`: a real key name would point the author
    // at a key that may be perfectly fine.
    expect(problemsOf(null)).toEqual(["(document): the script must be a JSON object, not null"]);
    expect(problemsOf([])).toEqual(["(document): the script must be a JSON object, not an array"]);
    expect(problemsOf("x")).toEqual(["(document): the script must be a JSON object, not a string"]);
    expect(problemsOf(1)).toEqual(["(document): the script must be a JSON object, not a number"]);
    expect(problemsOf(undefined)).toEqual(["(document): the script must be a JSON object, not undefined"]);
  });

  it("rejects a missing top-level key as required, naming it", () => {
    const { frames: _frames, ...withoutFrames } = minimal();

    expect(problemsOf(withoutFrames)).toEqual(["frames: required — expected an object"]);
  });

  it("describes a wrong type in plain words", () => {
    expect(problemsOf({ ...minimal(), scenarios: { a: null, b: 5, c: [] } })).toEqual([
      "scenarios.a: expected an object, received null",
      "scenarios.b: expected an object, received a number",
      "scenarios.c: expected an object, received an array",
    ]);
  });

  it("keeps a custom message on a type failure rather than rewording it", () => {
    expect(problemsOf(withSequence([{ pause: "250" }]))).toEqual([
      "scenarios.pit-crew.flag-blue.sequence[0].pause: must be a finite number of milliseconds",
    ]);
  });

  it("rejects an unknown key on an entry, naming the full path", () => {
    const problems = problemsOf({
      ...minimal(),
      scenarios: { "pit-crew.flag-blue": { sequnce: ["pool:flag-blue"] } },
    });

    // Two problems, both actionable: the typo is named where it sits, and the
    // key it was meant to be is reported missing.
    expect(problems).toContain("scenarios.pit-crew.flag-blue.sequnce: unrecognized key");
    expect(problems.some((p) => p.startsWith("scenarios.pit-crew.flag-blue.sequence: "))).toBe(true);
  });

  it("rejects an unknown top-level key using the key name as the prefix", () => {
    const problems = problemsOf({ ...minimal(), extra: 1 });

    expect(problems).toEqual(["extra: unrecognized key"]);
  });

  it("accepts skip: true without a sequence", () => {
    const script = { ...minimal(), scenarios: { "pit-crew.flag-blue": { skip: true } } };

    expect(parseCalloutScript(script)).toEqual({ ok: true, script });
  });

  it("rejects an entry with neither skip nor sequence", () => {
    const problems = problemsOf({ ...minimal(), scenarios: { "pit-crew.flag-blue": { comment: "later" } } });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^scenarios\.pit-crew\.flag-blue\.sequence: /);
    expect(problems[0]).toMatch(/skip/);
  });

  it("rejects skip: false without a sequence (false is not a skip)", () => {
    const problems = problemsOf({ ...minimal(), scenarios: { "pit-crew.flag-blue": { skip: false } } });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^scenarios\.pit-crew\.flag-blue\.sequence: /);
  });

  it("accepts every optional entry field alongside a sequence", () => {
    const script = {
      ...minimal(),
      scenarios: {
        "pit-crew.flag-blue": {
          comment: "Blue flag.",
          test: "Harness → Flags → blue.",
          skip: false,
          frame: "terse",
          sequence: ["pool:flag-blue"],
        },
      },
      frames: { terse: { open: [], close: [] } },
    };

    expect(parseCalloutScript(script)).toEqual({ ok: true, script });
  });

  it("round-trips every step form", () => {
    const everyForm: ScriptStep[] = [
      "pool:flag-blue",
      "pause:250",
      "@pit-crew.radio-open",
      "{{position.number}}",
      "flags/blue-1.mp3",
      { clip: "flags/blue-2.mp3" },
      { var: "position.number" },
      { pool: "flag-blue", noRepeat: false },
      { pool: "flags/blue" },
      { connector: true },
      { pause: 0 },
      { include: "pit-crew.radio-close" },
      { optional: ["{{lapTime.minute}}"] },
      { ambient: "start" },
      { ambient: "stop" },
      { ambient: "seek" },
      { if: "session.isRace", then: ["pool:flag-green-race"], else: ["pool:flag-green-practice"] },
      { if: "!readback.hasAnyService", then: ["pit-readback/empty-fallback.mp3"] },
      { case: "session.type", of: { practice: ["pool:a"], race: ["pool:b"], default: [] } },
    ];
    const script = withSequence(everyForm);

    expect(parseCalloutScript(script)).toEqual({ ok: true, script });
  });

  it("walks nested branches: a problem deep inside then/else/optional/of is path-prefixed", () => {
    const problems = problemsOf(
      withSequence([
        {
          if: "a",
          then: [{ optional: [{ case: "k", of: { x: [{ pause: -1 }] } }] }],
          else: [{ ambient: "loop" }],
        },
      ]),
    );

    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(
      /^scenarios\.pit-crew\.flag-blue\.sequence\[0\]\.then\[0\]\.optional\[0\]\.of\.x\[0\]\.pause: /,
    );
    expect(problems[1]).toMatch(/^scenarios\.pit-crew\.flag-blue\.sequence\[0\]\.else\[0\]\.ambient: /);
  });

  describe("pool names", () => {
    it("accepts a registered-style name and a single group/base slash", () => {
      expect(parseCalloutScript(withSequence([{ pool: "flag-blue" }, "pool:flags/blue"])).ok).toBe(true);
    });

    it.each(["a/b/c", "Flag-Blue", "-flag", "flag blue", "", "/blue", "flags/", "pool:x"])("rejects %j", (name) => {
      const problems = problemsOf(withSequence([{ pool: name }]));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^scenarios\.pit-crew\.flag-blue\.sequence\[0\]\.pool: /);
    });

    it("rejects a bad name in the string form too", () => {
      const problems = problemsOf(withSequence(["pool:a/b/c"]));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^scenarios\.pit-crew\.flag-blue\.sequence\[0\]: /);
    });

    it("rejects a pool definition named with a slash — registered names never carry one", () => {
      const problems = problemsOf({ ...minimal(), pools: { "flags/blue": { group: "flags", base: "blue" } } });

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^pools\.flags\/blue: /);
    });
  });

  describe("case", () => {
    it("rejects an empty `of`", () => {
      const problems = problemsOf(withSequence([{ case: "k", of: {} }]));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^scenarios\.pit-crew\.flag-blue\.sequence\[0\]\.of: /);
    });

    it("rejects a branch that is not a step list", () => {
      const problems = problemsOf(withSequence([{ case: "k", of: { x: "pool:a" } }]));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^scenarios\.pit-crew\.flag-blue\.sequence\[0\]\.of\.x: /);
    });
  });

  describe("pause", () => {
    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "250"])("rejects the object form with %j", (pause) => {
      const problems = problemsOf(withSequence([{ pause }]));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^scenarios\.pit-crew\.flag-blue\.sequence\[0\]\.pause: /);
    });

    it.each(["pause:-1", "pause:abc", "pause:", "pause:Infinity"])("rejects the string form %j", (step) => {
      const problems = problemsOf(withSequence([step]));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^scenarios\.pit-crew\.flag-blue\.sequence\[0\]: /);
    });
  });

  describe("ambient", () => {
    it("rejects an unknown action", () => {
      const problems = problemsOf(withSequence([{ ambient: "loop" }]));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^scenarios\.pit-crew\.flag-blue\.sequence\[0\]\.ambient: /);
    });
  });

  describe("if", () => {
    it("accepts a negated condition", () => {
      expect(parseCalloutScript(withSequence([{ if: "!x", then: [] }])).ok).toBe(true);
    });

    it.each(["", "!", "!!x", "a b"])("rejects the condition reference %j", (cond) => {
      const problems = problemsOf(withSequence([{ if: cond, then: [] }]));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^scenarios\.pit-crew\.flag-blue\.sequence\[0\]\.if: /);
    });

    it("requires `then`, reported as required even though the issue came out of a step form", () => {
      expect(problemsOf(withSequence([{ if: "x" }]))).toEqual([
        "scenarios.pit-crew.flag-blue.sequence[0].then: required — expected an array",
      ]);
    });
  });

  describe("include", () => {
    const twoSpellings =
      /an include is spelled "@<scenario-id>" \(string form\) or \{ "include": "<scenario-id>" \} \(object form\)/;

    it("rejects the object form spelled with the string form's @", () => {
      const problems = problemsOf(withSequence([{ include: "@pit-crew.radio-open" }]));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^scenarios\.pit-crew\.flag-blue\.sequence\[0\]\.include: /);
      expect(problems[0]).toMatch(twoSpellings);
    });

    it("rejects a string include whose id starts with a second @, with the same message", () => {
      // "@@x" would otherwise parse to an include of "@x" — the mirror image of
      // `{ include: "@x" }`, and the same mistake.
      const problems = problemsOf(withSequence(["@@pit-crew.radio-open"]));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^scenarios\.pit-crew\.flag-blue\.sequence\[0\]: /);
      expect(problems[0]).toMatch(twoSpellings);
    });

    it("rejects an empty include in either form", () => {
      expect(problemsOf(withSequence(["@"]))).toHaveLength(1);
      expect(problemsOf(withSequence([{ include: "" }]))).toHaveLength(1);
    });
  });

  describe("var", () => {
    it("rejects an empty var in either form", () => {
      expect(problemsOf(withSequence(["{{}}"]))).toHaveLength(1);
      expect(problemsOf(withSequence([{ var: "" }]))).toHaveLength(1);
    });
  });

  describe("step forms", () => {
    it("rejects an empty string step", () => {
      const problems = problemsOf(withSequence([""]));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^scenarios\.pit-crew\.flag-blue\.sequence\[0\]: /);
    });

    it("rejects an object with no recognised step key, listing the forms", () => {
      const problems = problemsOf(withSequence([{ clips: "x" }]));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^scenarios\.pit-crew\.flag-blue\.sequence\[0\]: /);
      expect(problems[0]).toMatch(/clip.*var.*pool.*connector.*pause.*include.*optional.*ambient.*if.*case/);
    });

    it("rejects a step that is neither a string nor an object", () => {
      for (const step of [1, null, true, ["pool:a"]]) {
        const problems = problemsOf(withSequence([step]));

        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(/^scenarios\.pit-crew\.flag-blue\.sequence\[0\]: /);
      }
    });

    it("rejects an extra key on a recognised form, naming the key", () => {
      const problems = problemsOf(withSequence([{ pool: "flag-blue", norepeat: true }]));

      expect(problems).toEqual(["scenarios.pit-crew.flag-blue.sequence[0].norepeat: unrecognized key"]);
    });

    it("rejects connector: false", () => {
      const problems = problemsOf(withSequence([{ connector: false }]));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^scenarios\.pit-crew\.flag-blue\.sequence\[0\]\.connector: /);
    });
  });

  describe("frames", () => {
    it("accepts a frame with open and close sequences and a comment", () => {
      const script = {
        ...minimal(),
        frames: {
          radio: { comment: "Beeps.", open: ["tick-open.mp3", { ambient: "start" }], close: [{ ambient: "stop" }] },
        },
      };

      expect(parseCalloutScript(script)).toEqual({ ok: true, script });
    });

    it("requires both open and close", () => {
      const problems = problemsOf({ ...minimal(), frames: { radio: { open: [] } } });

      expect(problems).toEqual(["frames.radio.close: required — expected an array"]);
    });

    it('rejects a frame named "none" — that name means unframed', () => {
      const problems = problemsOf({ ...minimal(), frames: { none: { open: [], close: [] } } });

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^frames\.none: /);
    });

    it("rejects an empty frame override on an entry", () => {
      const problems = problemsOf({
        ...minimal(),
        scenarios: { "pit-crew.flag-blue": { frame: "", sequence: [] } },
      });

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^scenarios\.pit-crew\.flag-blue\.frame: /);
    });
  });

  describe("pools", () => {
    it("accepts a definition with a comment", () => {
      const script = { ...minimal(), pools: { "flag-blue": { group: "flags", base: "blue", comment: "Blue." } } };

      expect(parseCalloutScript(script)).toEqual({ ok: true, script });
    });

    it("requires group and base to be non-empty", () => {
      const problems = problemsOf({ ...minimal(), pools: { "flag-blue": { group: "", base: "blue" } } });

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^pools\.flag-blue\.group: /);
    });
  });

  describe("scenario ids", () => {
    it("rejects whitespace in a scenario id, with the pattern's own message", () => {
      expect(problemsOf({ ...minimal(), scenarios: { "flag blue": { sequence: [] } } })).toEqual([
        "scenarios.flag blue: must be a scenario id: non-empty, no whitespace",
      ]);
    });

    it("rejects an empty scenario id, quoting the empty key so the path does not end in a dot", () => {
      expect(problemsOf({ ...minimal(), scenarios: { "": { sequence: [] } } })).toEqual([
        'scenarios."": must be a scenario id: non-empty, no whitespace',
      ]);
    });
  });

  it("reports every problem, not just the first", () => {
    const problems = problemsOf({
      ...minimal(),
      scenarios: { a: { sequence: [{ pause: -1 }] }, b: { comment: "no sequence" } },
      pools: { "flags/x": { group: "flags", base: "x" } },
    });

    expect(problems).toHaveLength(3);
  });

  it("never throws, whatever the input", () => {
    for (const json of [Symbol("s"), () => 1, new Date(), { schema: 1, scenarios: null, frames: 1, pools: "x" }]) {
      expect(() => parseCalloutScript(json)).not.toThrow();
      expect(parseCalloutScript(json).ok).toBe(false);
    }
  });
});

describe("the exported sub-schemas", () => {
  it("validate a step on their own", () => {
    expect(ScriptStepSchema.safeParse({ pool: "flag-blue" }).success).toBe(true);
    expect(ScriptStepSchema.safeParse({ pool: "Flag" }).success).toBe(false);
  });

  it("validate an entry, a frame and a pool definition on their own", () => {
    expect(CalloutScriptEntrySchema.safeParse({ skip: true }).success).toBe(true);
    expect(CalloutScriptEntrySchema.safeParse({}).success).toBe(false);
    expect(FrameDefinitionSchema.safeParse({ open: [], close: [] }).success).toBe(true);
    expect(FrameDefinitionSchema.safeParse({ open: [] }).success).toBe(false);
    expect(PoolDefinitionSchema.safeParse({ group: "flags", base: "blue" }).success).toBe(true);
    expect(PoolDefinitionSchema.safeParse({ group: "flags" }).success).toBe(false);
  });

  it("expose the whole-script schema for callers that want zod's own result", () => {
    expect(CalloutScriptSchema.safeParse(minimal()).success).toBe(true);
  });
});
