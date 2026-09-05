import { describe, expect, it } from "vitest";

import type { CalloutScript } from "./grammar.js";
import { collectScriptReferences } from "./references.js";

describe("collectScriptReferences", () => {
  it("collects every referencing form, deduped and sorted", () => {
    const script: CalloutScript = {
      schema: 1,
      scenarios: {
        "pit-crew.flag-green": {
          frame: "terse",
          sequence: [
            "pool:a",
            { pool: "b" },
            { pool: "a", noRepeat: false },
            "pool:flags/blue",
            "{{v}}",
            { var: "w" },
            { var: "v" },
            { if: "!c", then: ["pool:z"], else: [{ var: "u" }] },
            { case: "k", of: { x: [], default: [] } },
            "@frag",
            { include: "frag2" },
            "@frag",
            "pause:100",
            { pause: 5 },
            { connector: true },
            { ambient: "start" },
            "flags/green-1.mp3",
            { clip: "flags/green-2.mp3" },
          ],
        },
        "pit-crew.flag-blue": { skip: true },
        "pit-crew.flag-red": { frame: "terse", sequence: [] },
      },
      frames: { terse: { open: ["pool:tick"], close: [{ var: "sign-off" }] } },
      pools: { a: { group: "g", base: "a" } },
    };

    expect(collectScriptReferences(script)).toEqual({
      scenarioIds: ["pit-crew.flag-blue", "pit-crew.flag-green", "pit-crew.flag-red"],
      pools: ["a", "b", "connector", "flags/blue", "tick", "z"],
      vars: ["sign-off", "u", "v", "w"],
      conds: ["c"],
      cases: [{ name: "k", keys: ["x"] }],
      includes: ["frag", "frag2"],
      frames: ["terse"],
    });
  });

  it("walks nested then/else/optional/of branches", () => {
    const script: CalloutScript = {
      schema: 1,
      scenarios: {
        s: {
          sequence: [
            {
              if: "outer",
              then: [{ optional: [{ case: "k1", of: { a: [{ if: "!inner", then: ["{{deep}}"] }] } }] }],
              else: [{ case: "k2", of: { b: [{ optional: ["pool:p"] }], c: [] } }],
            },
          ],
        },
      },
      frames: {},
      pools: {},
    };

    expect(collectScriptReferences(script)).toEqual({
      scenarioIds: ["s"],
      pools: ["p"],
      vars: ["deep"],
      conds: ["inner", "outer"],
      cases: [
        { name: "k1", keys: ["a"] },
        { name: "k2", keys: ["b", "c"] },
      ],
      includes: [],
      frames: [],
    });
  });

  it("merges the keys of a case used more than once", () => {
    const script: CalloutScript = {
      schema: 1,
      scenarios: {
        s: { sequence: [{ case: "k", of: { b: [], default: [] } }] },
        t: { sequence: [{ case: "k", of: { a: [] } }] },
      },
      frames: {},
      pools: {},
    };

    expect(collectScriptReferences(script).cases).toEqual([{ name: "k", keys: ["a", "b"] }]);
  });

  // A connector step names no pool in the file, but it draws from one — the
  // `connector` pool — so a consumer checking pools against what it holds has
  // to see it, or a voice without a connector clip passes the check and then
  // aborts every callout that uses one.
  it("reports the connector pool for a { connector: true } step, once, wherever it appears", () => {
    const script: CalloutScript = {
      schema: 1,
      scenarios: {
        s: { sequence: [{ connector: true }, { optional: [{ connector: true }] }] },
        t: { sequence: [{ if: "c", then: [{ connector: true }] }] },
      },
      frames: { f: { open: [], close: [{ connector: true }] } },
      pools: {},
    };

    expect(collectScriptReferences(script).pools).toEqual(["connector"]);
  });

  it("reports the connector pool by the same name a script would define it under", () => {
    const script: CalloutScript = {
      schema: 1,
      scenarios: { s: { sequence: [{ connector: true }, "pool:connector"] } },
      frames: {},
      pools: { connector: { group: "connectors", base: "and" } },
    };

    expect(collectScriptReferences(script).pools).toEqual(["connector"]);
  });

  it('does not report the reserved frame name "none" as a frame reference', () => {
    const script: CalloutScript = {
      schema: 1,
      scenarios: { s: { frame: "none", sequence: [] }, t: { frame: "radio", sequence: [] } },
      frames: {},
      pools: {},
    };

    expect(collectScriptReferences(script).frames).toEqual(["radio"]);
  });

  it("returns empty lists for a script with nothing in it", () => {
    expect(collectScriptReferences({ schema: 1, scenarios: {}, frames: {}, pools: {} })).toEqual({
      scenarioIds: [],
      pools: [],
      vars: [],
      conds: [],
      cases: [],
      includes: [],
      frames: [],
    });
  });
});
