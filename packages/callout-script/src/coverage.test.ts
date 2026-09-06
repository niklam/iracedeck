import { describe, expect, it } from "vitest";

import { checkCoverage, coverageOf, danglingOf, orphansOf } from "./coverage.js";
import type { CalloutScript } from "./grammar.js";

// The rules themselves are held to a mistyped fixture in
// `@iracedeck/audio-assets`' `script-coverage.test.ts`, where they were born
// and where the bundled voice is checked with them. What this file pins is
// the seam that moved here: the authored list is plain `<group>/<name>`
// strings, and what counts as a var-driven group is the CALLER's knowledge.

function script(overrides: Partial<CalloutScript>): CalloutScript {
  return { schema: 1, scenarios: {}, frames: {}, pools: {}, ...overrides };
}

const ENTRY = { comment: "fixture", test: "fixture" };

describe("coverageOf — reads authored names the way the engine reads the files", () => {
  it("keeps the name as written AND its -NN-stripped base, so a reference to either spelling matches", () => {
    const coverage = coverageOf({
      script: script({ scenarios: { "pit-crew.flag-blue": { ...ENTRY, sequence: ["pool:flags/blue"] } } }),
      authored: ["flags/blue-01", "flags/blue-02", "start-lights/countdown-90"],
    });

    expect(coverage.authoredNames).toEqual(new Set(["flags/blue-01", "flags/blue-02", "start-lights/countdown-90"]));
    expect(coverage.authored).toEqual(new Set(["flags/blue", "start-lights/countdown"]));
    expect(coverage.scriptedGroups).toEqual(new Set(["flags"]));
  });
});

describe("orphansOf — the var-driven predicate is the caller's", () => {
  const twoGroups = coverageOf({
    script: script({ scenarios: { "pit-crew.flag-blue": { ...ENTRY, sequence: ["pool:flags/blue"] } } }),
    authored: ["flags/blue-01", "flags/green-01", "position-number/1", "position-number/2"],
  });

  it("with the unscripted-group reading, skips a group no step addresses and reports the rest", () => {
    const orphans = orphansOf(twoGroups, (group) => !twoGroups.scriptedGroups.has(group));

    expect(orphans).toEqual(["flags/green"]);
  });

  it("with a vocabulary-backed reading, reports an unscripted group no var draws from", () => {
    const orphans = orphansOf(twoGroups, () => false);

    expect(orphans).toEqual(["flags/green", "position-number/1", "position-number/2"]);
  });

  it("excuses every unreferenced base of a group the predicate claims, scripted or not", () => {
    const orphans = orphansOf(twoGroups, (group) => group === "flags" || group === "position-number");

    expect(orphans).toEqual([]);
  });
});

describe("checkCoverage — the one-call report", () => {
  it("returns every list a linter reads, each sorted", () => {
    const report = checkCoverage(
      {
        script: script({
          scenarios: {
            "pit-crew.flag-blue": { ...ENTRY, sequence: ["pool:flags/blue", "pool:flags/red", "pool:missing-alias"] },
            "pit-crew.flag-white": { ...ENTRY, sequence: ["flags/white-01.mp3", "@ghost"] },
          },
          fragments: { unused: { sequence: ["pool:flags/blue"] } },
        }),
        authored: ["flags/blue-01", "flags/orphan-01"],
      },
      () => false,
    );

    expect(report).toEqual({
      orphans: ["flags/orphan"],
      dangling: ["flags/red"],
      undefinedPools: ["missing-alias"],
      unrecognisedLiterals: ["flags/white-01.mp3"],
      unknownIncludes: ["ghost"],
      unincludedFragments: ["unused"],
    });
  });

  it("danglingOf still folds the three dangling kinds into one worded list for a test's failure message", () => {
    const coverage = coverageOf({
      script: script({
        scenarios: { "pit-crew.flag-blue": { ...ENTRY, sequence: ["pool:flags/red", "pool:alias", "x/y.mp3"] } },
      }),
      authored: [],
    });

    expect(danglingOf(coverage)).toEqual([
      "flags/red",
      'literal "x/y.mp3" (not voice/<voice>/<group>/<name>.mp3 — a path this check cannot place)',
      'pool "alias" (named, defined nowhere under pools)',
    ]);
  });
});
