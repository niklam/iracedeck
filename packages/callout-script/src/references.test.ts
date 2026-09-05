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
      fragments: [],
      unincludedFragments: [],
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
      fragments: [],
      unincludedFragments: [],
    });
  });

  // The compiler stops at `skip: true` and compiles nothing else in the entry,
  // so a consumer checking references against what it holds must see the same
  // thing: the id, and neither the frame nor a sequence left beside the skip.
  it("lists a skip: true entry by id only — its frame and any sequence beside the skip are not references", () => {
    const script: CalloutScript = {
      schema: 1,
      scenarios: {
        spoken: { sequence: ["pool:a"] },
        skipped: { skip: true, frame: "terse", sequence: ["pool:b", "{{v}}", { if: "c", then: ["@frag"] }] },
      },
      frames: {},
      pools: {},
    };

    expect(collectScriptReferences(script)).toEqual({
      scenarioIds: ["skipped", "spoken"],
      pools: ["a"],
      vars: [],
      conds: [],
      cases: [],
      includes: [],
      frames: [],
      fragments: [],
      unincludedFragments: [],
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

  // Pack-defined fragments (issue #1065): what a fragment's sequence names is
  // a reference like any other — a pool used only inside one still has to
  // exist — and the names DEFINED are listed so a consumer can check that
  // every include targets one (`includes ⊆ fragments`).
  it("walks every fragment's sequence and lists the names the script defines, sorted", () => {
    const script: CalloutScript = {
      schema: 1,
      scenarios: { s: { sequence: ["@readback-body"] } },
      frames: {},
      pools: {},
      fragments: {
        "readback-body": {
          comment: "Shared by entry and exit.",
          sequence: ["pool:readback/fuel-on", "{{readback.tires}}", { if: "!readback.empty", then: ["@sign-off"] }],
        },
        "sign-off": { sequence: [{ case: "k", of: { a: [{ connector: true }] } }] },
      },
    };

    expect(collectScriptReferences(script)).toEqual({
      scenarioIds: ["s"],
      pools: ["connector", "readback/fuel-on"],
      vars: ["readback.tires"],
      conds: ["readback.empty"],
      cases: [{ name: "k", keys: ["a"] }],
      includes: ["readback-body", "sign-off"],
      frames: [],
      fragments: ["readback-body", "sign-off"],
      unincludedFragments: [],
    });
  });

  // The compiler converts a fragment only when something includes it, so a
  // fragment nothing includes — or that only a `skip: true` entry includes —
  // is checked by nobody through an entry, and what it references is not a
  // reference anything the engine compiles will resolve. The set is listed
  // so a consumer can hold it to `[]`, and can walk the live fragments only.
  it("lists the fragments no live entry, frame or live fragment includes — a skip: true entry's include does not count", () => {
    const script: CalloutScript = {
      schema: 1,
      scenarios: {
        s: { sequence: ["@used"] },
        skipped: { skip: true, sequence: ["@only-skipped"] },
      },
      frames: { f: { open: ["@in-frame"], close: [] } },
      pools: {},
      fragments: {
        used: { sequence: ["@through-used"] },
        "through-used": { sequence: ["pool:a"] },
        "in-frame": { sequence: ["pool:b"] },
        "only-skipped": { sequence: ["pool:c"] },
        dead: { sequence: ["@dead-helper"] },
        "dead-helper": { sequence: ["pool:d"] },
      },
    };
    const refs = collectScriptReferences(script);

    expect(refs.unincludedFragments).toEqual(["dead", "dead-helper", "only-skipped"]);
    // `includes` and `fragments` are unchanged by it: every include anywhere, every definition.
    expect(refs.includes).toEqual(["dead-helper", "in-frame", "through-used", "used"]);
    expect(refs.fragments).toEqual(["dead", "dead-helper", "in-frame", "only-skipped", "through-used", "used"]);
  });

  it("does not list a fragment that reaches itself only through a live include as unincluded", () => {
    const script: CalloutScript = {
      schema: 1,
      scenarios: { s: { sequence: ["@a"] } },
      frames: {},
      pools: {},
      fragments: { a: { sequence: ["@b"] }, b: { sequence: ["@a"] } },
    };

    expect(collectScriptReferences(script).unincludedFragments).toEqual([]);
  });

  it("lists an include of a fragment the script never defines, so a consumer can see the mismatch", () => {
    const script: CalloutScript = {
      schema: 1,
      scenarios: { s: { sequence: ["@ghost"] } },
      frames: {},
      pools: {},
    };
    const refs = collectScriptReferences(script);

    expect(refs.includes).toEqual(["ghost"]);
    expect(refs.fragments).toEqual([]);
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
      fragments: [],
      unincludedFragments: [],
    });
  });
});
