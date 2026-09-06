import { describe, expect, it } from "vitest";

import {
  checkCoverage,
  coverageOf,
  danglingOf,
  orphansOf,
  stripTakeSuffix,
  TAKE_SUFFIX,
  VOICE_CLIP_PATH,
} from "./coverage.js";
import type { CalloutScript } from "./grammar.js";

// The rules themselves are held to a mistyped fixture in
// `@iracedeck/audio-assets`' `script-coverage.test.ts`, where they were born
// and where the bundled voice is checked with them. What this file pins is
// the seam that moved here: the authored list is plain `<group>/<name>`
// strings, the built-ins are a plain path list, and what counts as a
// var-driven group is the CALLER's knowledge.

function script(overrides: Partial<CalloutScript>): CalloutScript {
  return { schema: 1, scenarios: {}, frames: {}, pools: {}, ...overrides };
}

const ENTRY = { comment: "fixture", test: "fixture" };

/** The plugin's built-ins as the bundled manifest lists them — what a frame's literal paths are checked against. */
const SHARED_CLIPS = ["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3", "sfx/IRD-ambient-pit.mp3"];

describe("coverageOf — reads authored names the way the engine reads the files", () => {
  it("keeps the name as written AND its -NN-stripped base, so a reference to either spelling matches", () => {
    const coverage = coverageOf({
      script: script({ scenarios: { "pit-crew.flag-blue": { ...ENTRY, sequence: ["pool:flags/blue"] } } }),
      authored: ["flags/blue-01", "flags/blue-02", "start-lights/countdown-90"],
      sharedClips: [],
    });

    expect(coverage.authoredNames).toEqual(new Set(["flags/blue-01", "flags/blue-02", "start-lights/countdown-90"]));
    expect(coverage.authored).toEqual(new Set(["flags/blue", "start-lights/countdown"]));
    expect(coverage.scriptedGroups).toEqual(new Set(["flags"]));
  });

  // A frame's built-in paths used to be skipped unread: a misspelled tick
  // linted clean and aborted every framed callout at fire time (#835).
  it("checks a shared sfx/ literal against the plugin's built-ins — a misspelled tick is a finding, the right path is not", () => {
    const frames = (open: string) => ({ radio: { open: [{ clip: open }], close: ["/sfx/IRD-tick-close.mp3"] } });
    const misspelled = coverageOf({
      script: script({ frames: frames("sfx/IRD-tick-opne.mp3") }),
      authored: [],
      sharedClips: SHARED_CLIPS,
    });

    // Collected with the leading-slash escape stripped, as the engine strips it.
    expect(misspelled.sharedLiterals).toEqual(["sfx/IRD-tick-close.mp3", "sfx/IRD-tick-opne.mp3"]);
    expect(misspelled.missingSharedClips).toEqual(["sfx/IRD-tick-opne.mp3"]);
    expect(misspelled.unrecognisedLiterals).toEqual([]);

    const spelled = coverageOf({
      script: script({ frames: frames("sfx/IRD-tick-open.mp3") }),
      authored: [],
      sharedClips: SHARED_CLIPS,
    });

    expect(spelled.missingSharedClips).toEqual([]);
  });

  // A defined alias used to count as a reference whether or not any step
  // named it, so an alias left behind hid the orphan its source had become.
  it("counts a pools alias as referenced only when a live step names it, and lists the aliases nothing names", () => {
    const coverage = coverageOf({
      script: script({
        scenarios: { "pit-crew.flag-blue": { ...ENTRY, sequence: ["pool:used"] } },
        pools: {
          used: { group: "flags", base: "blue" },
          stale: { group: "flags", base: "green" },
          "stale-and-missing": { group: "flags", base: "nothing" },
        },
      }),
      authored: ["flags/blue-01", "flags/green-01"],
      sharedClips: [],
    });

    expect(coverage.referenced).toEqual(new Set(["flags/blue"]));
    expect(coverage.unusedAliases).toEqual(["stale", "stale-and-missing"]);
    // The source of an unused alias is an orphan (nothing live plays it) …
    expect(orphansOf(coverage, () => false)).toEqual(["flags/green"]);
    // … and still dangling when it is not shipped: a defined alias onto nothing is worth a line either way.
    expect(danglingOf(coverage)).toEqual(["flags/nothing"]);
  });
});

describe("the two helpers the reference builder shares", () => {
  it("reads a voice clip path in either spelling, with or without the leading-slash escape", () => {
    expect(VOICE_CLIP_PATH.exec("voice/{voice}/flags/blue-01.mp3")?.slice(1)).toEqual(["flags", "blue-01"]);
    expect(VOICE_CLIP_PATH.exec("/voice/default/units/km.mp3")?.slice(1)).toEqual(["units", "km"]);
    expect(VOICE_CLIP_PATH.test("flags/blue-01.mp3")).toBe(false);
    expect(VOICE_CLIP_PATH.test("voice/flags/blue-01.mp3")).toBe(false);
  });

  it("strips exactly a two-digit take suffix", () => {
    expect(stripTakeSuffix("blue-01")).toBe("blue");
    expect(stripTakeSuffix("countdown-90")).toBe("countdown");
    expect(stripTakeSuffix("points-2")).toBe("points-2");
    expect(TAKE_SUFFIX.exec("green-12")?.[1]).toBe("12");
  });
});

describe("orphansOf — the var-driven predicate is the caller's", () => {
  const twoGroups = coverageOf({
    script: script({ scenarios: { "pit-crew.flag-blue": { ...ENTRY, sequence: ["pool:flags/blue"] } } }),
    authored: ["flags/blue-01", "flags/green-01", "position-number/1", "position-number/2"],
    sharedClips: [],
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
          frames: { radio: { open: ["sfx/IRD-tick-opne.mp3"], close: [] } },
          pools: { stale: { group: "flags", base: "blue" } },
          fragments: { unused: { sequence: ["pool:flags/blue"] } },
        }),
        authored: ["flags/blue-01", "flags/orphan-01"],
        sharedClips: SHARED_CLIPS,
      },
      () => false,
    );

    expect(report).toEqual({
      orphans: ["flags/orphan"],
      dangling: ["flags/red"],
      undefinedPools: ["missing-alias"],
      unrecognisedLiterals: ["flags/white-01.mp3"],
      missingSharedClips: ["sfx/IRD-tick-opne.mp3"],
      unusedAliases: ["stale"],
      unknownIncludes: ["ghost"],
      unincludedFragments: ["unused"],
    });
  });

  it("danglingOf still folds the dangling kinds into one worded list for a test's failure message", () => {
    const coverage = coverageOf({
      script: script({
        scenarios: {
          "pit-crew.flag-blue": { ...ENTRY, sequence: ["pool:flags/red", "pool:alias", "x/y.mp3", "/sfx/nope.mp3"] },
        },
      }),
      authored: [],
      sharedClips: SHARED_CLIPS,
    });

    expect(danglingOf(coverage)).toEqual([
      'built-in "sfx/nope.mp3" (not a clip the plugin ships)',
      "flags/red",
      'literal "x/y.mp3" (not voice/<voice>/<group>/<name>.mp3 — a path this check cannot place)',
      'pool "alias" (named, defined nowhere under pools)',
    ]);
  });
});
