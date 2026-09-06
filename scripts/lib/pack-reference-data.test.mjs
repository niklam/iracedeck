// The generator's summary (issue #1066): what `pnpm generate:pack-reference`
// prints for the coordinator to read, over a hand-built reference so nothing
// here needs the built dist. The freshness of the artifact itself is
// `../generate-pack-reference.test.mjs`, which does.
import { describe, expect, it } from "vitest";

import { PACK_REFERENCE_SOURCES, summarizePackReference } from "./pack-reference-data.mjs";

/** A recording line with every field the builder writes; the coverage columns default to "nothing draws from it". */
function line(base, overrides = {}) {
  return { base, texts: ["a line"], takes: 1, usedBy: [], viaVar: [], playedBy: null, ...overrides };
}

const REFERENCE = {
  _meta: { generatedFrom: [...PACK_REFERENCE_SOURCES] },
  callouts: [
    { id: "pit-crew.flag-green", skip: false },
    { id: "pit-crew.flag-blue", skip: true },
    { id: "pit-crew.incident", skip: false },
  ],
  vocabulary: {
    vars: [
      { name: "incident.points", usedBy: ["pit-crew.incident"] },
      { name: "zz.unused", usedBy: [] },
    ],
    conds: [{ name: "session.isRace", usedBy: [] }],
    cases: [{ name: "readback.tirePattern", usedBy: ["pit-crew.flag-green"] }],
  },
  recordingScript: [
    {
      group: "flags",
      lines: [
        line("green", { takes: 3, usedBy: ["pit-crew.flag-green"] }),
        // Inside a group something draws from, a line nothing draws from — and one with no text on file.
        line("stray", { texts: [] }),
      ],
    },
    // A group only a var reaches: consumed, every line of it.
    { group: "incidents", lines: [line("points-1", { viaVar: ["incident.points"] })] },
    // A group only the plugin reaches: consumed too, by `playedBy`, so it is not "recorded for nothing".
    {
      group: "toggle",
      lines: [line("radio-check", { playedBy: "the radio check when the sim connects" }), line("hello")],
    },
    // A group nothing reaches at all.
    { group: "openers", lines: [line("alright"), line("okay", { texts: [] })] },
  ],
};

describe("summarizePackReference", () => {
  it("counts callouts, skips, vocabulary, groups, lines and takes", () => {
    const summary = summarizePackReference(REFERENCE);

    expect(summary).toMatchObject({
      callouts: 3,
      skipped: ["pit-crew.flag-blue"],
      vars: 2,
      conds: 1,
      cases: 1,
      groups: 4,
      lines: 7,
      takes: 9,
    });
  });

  it("lists the lines with no config text as group/base", () => {
    expect(summarizePackReference(REFERENCE).linesWithoutText).toEqual(["flags/stray", "openers/okay"]);
  });

  it("tells a whole group nothing draws from apart from a single unconsumed line in a group something does", () => {
    const summary = summarizePackReference(REFERENCE);

    // `incidents` is a var's, `toggle` is the plugin's: neither is without a consumer.
    expect(summary.groupsWithoutConsumer).toEqual(["openers"]);
    // The stray flag line, and the toggle line the plugin does NOT play — never a line of a group listed above.
    expect(summary.linesWithoutConsumer).toEqual(["flags/stray", "toggle/hello"]);
  });

  it("lists the vocabulary no callout uses, by kind", () => {
    expect(summarizePackReference(REFERENCE).unusedVocabulary).toEqual(["var zz.unused", "cond session.isRace"]);
  });
});
