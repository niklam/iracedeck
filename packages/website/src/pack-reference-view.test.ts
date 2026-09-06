import { describe, expect, it } from "vitest";

import reference from "./data/pack-reference.json";
import { type Callout, parsePackReference, type RecordingGroup } from "./pack-reference-types.js";
import {
  calloutHref,
  calloutsToc,
  caseAnchor,
  caseHref,
  condHref,
  describeBase,
  describeScheduling,
  describeTrigger,
  describeWeight,
  familyAnchor,
  groupByFamily,
  groupNote,
  groupPlayedBy,
  isUnusedGroup,
  isUnusedLine,
  lineAnchor,
  lineHref,
  linePlayedBy,
  NO_FAMILY_ANCHOR,
  NO_FAMILY_LABEL,
  PAUSE_MARKER,
  recordingScriptToc,
  renderTakeText,
  UNUSED_GROUP_NOTE,
  varAnchor,
  varHref,
  viaVarConsumers,
  vocabularyToc,
} from "./pack-reference-view.js";

const artifact = parsePackReference(reference);

function callout(overrides: Partial<Callout>): Callout {
  return {
    id: "pit-crew.example",
    family: null,
    event: "example.raised",
    description: "",
    frame: "radio",
    weight: 50,
    weightBand: "NORMAL",
    queueable: false,
    interrupt: false,
    base: null,
    comment: null,
    test: null,
    skip: false,
    references: { pools: [], vars: [], conds: [], cases: [], includes: [], frames: [] },
    ...overrides,
  };
}

describe("groupByFamily", () => {
  it("keeps families in code-point order and puts the no-family bucket last", () => {
    const groups = groupByFamily([
      callout({ id: "c", family: null }),
      callout({ id: "b", family: "flag" }),
      callout({ id: "a", family: "damage" }),
      callout({ id: "d", family: "flag" }),
    ]);

    expect(groups.map((g) => g.family)).toEqual(["damage", "flag", null]);
    expect(groups[1].callouts.map((c) => c.id)).toEqual(["b", "d"]);
    expect(groups[2].anchor).toBe(NO_FAMILY_ANCHOR);
  });

  it("omits the no-family bucket when every callout has a family", () => {
    expect(groupByFamily([callout({ family: "flag" })]).map((g) => g.family)).toEqual(["flag"]);
  });

  // The committed artifact is what the page renders; the ruling is that its
  // 19 unfamilied callouts render LAST, under one heading, with no family
  // invented for them.
  it("renders the artifact's unfamilied callouts last, and only once", () => {
    const groups = groupByFamily(artifact.callouts);
    const last = groups[groups.length - 1];

    expect(last.family).toBeNull();
    expect(last.callouts.length).toBeGreaterThan(0);
    expect(groups.filter((g) => g.family === null)).toHaveLength(1);
    expect(groups.flatMap((g) => g.callouts)).toHaveLength(artifact.callouts.length);
  });
});

describe("familyAnchor", () => {
  it("turns a dotted family into a plain anchor", () => {
    expect(familyAnchor("pit-service.fuel")).toBe("family-pit-service-fuel");
    expect(familyAnchor("flag")).toBe("family-flag");
  });
});

describe("describeWeight", () => {
  it("names the artifact's band beside the number and leaves an off-band value bare", () => {
    expect(describeWeight({ weight: 70, weightBand: "SAFETY" })).toBe("70 (safety)");
    expect(describeWeight({ weight: 120, weightBand: "PROXIMITY" })).toBe("120 (proximity)");
    expect(describeWeight({ weight: 65, weightBand: null })).toBe("65");
  });

  // The band is the generator's, from the engine's `WEIGHT`; the page keeps
  // no table to drift. A band names one number, and no callout is left
  // bandless on a number some other callout has a band for.
  it("finds the artifact's bands consistent with their numbers", () => {
    const byBand = new Map<string, Set<number>>();

    for (const c of artifact.callouts) {
      if (c.weightBand === null) continue;

      const weights = byBand.get(c.weightBand) ?? new Set<number>();
      weights.add(c.weight);
      byBand.set(c.weightBand, weights);
    }

    expect(byBand.size).toBeGreaterThan(0);

    for (const [band, weights] of byBand) expect([...weights], band).toHaveLength(1);

    const banded = new Set(artifact.callouts.filter((c) => c.weightBand !== null).map((c) => c.weight));

    for (const c of artifact.callouts) {
      if (c.weightBand === null) expect(banded.has(c.weight), `${c.id} (${c.weight})`).toBe(false);
    }
  });
});

describe("describeBase", () => {
  it("says where a bare clip path resolves: the voice's folder, the audio root, or under the base", () => {
    expect(describeBase({ base: "voice/{voice}" })).toBe(
      "voice/{voice} — a bare clip path resolves inside the active voice's folder",
    );
    expect(describeBase({ base: null })).toBe("none — a bare clip path resolves from the audio root");
    expect(describeBase({ base: "pit-crew" })).toBe(
      "pit-crew — a bare clip path resolves under pit-crew/ from the audio root",
    );
  });
});

describe("describeScheduling", () => {
  it("says what happens on a busy radio and against a quieter line", () => {
    expect(describeScheduling({ queueable: true, interrupt: true })).toBe(
      "deferred and replayed when the radio is busy; cuts a quieter line that is already playing",
    );
    expect(describeScheduling({ queueable: false, interrupt: false })).toBe(
      "dropped when the radio is busy; waits for a quieter line that is already playing to finish",
    );
  });
});

describe("describeTrigger", () => {
  it("shows the bus event, or says the plugin fires it", () => {
    expect(describeTrigger({ event: "flag.green.raised" })).toBe("flag.green.raised");
    expect(describeTrigger({ event: null })).toMatch(/fired by the plugin directly/);
  });
});

describe("renderTakeText", () => {
  it("turns an SSML break into the pause marker and drops any other tag", () => {
    expect(renderTakeText('Radio check. <break time="0.2s"/> Standing by.')).toBe(
      `Radio check. ${PAUSE_MARKER} Standing by.`,
    );
    expect(renderTakeText('Okay, <break time="0.3s" /> going silent.')).toBe(`Okay, ${PAUSE_MARKER} going silent.`);
    expect(renderTakeText("<speak>Hi <emphasis>there</emphasis></speak>")).toBe("Hi there");
  });

  it("leaves plain text alone", () => {
    expect(renderTakeText("Green flag, Green flag. Push now.")).toBe("Green flag, Green flag. Push now.");
  });

  // Every take text in the artifact must come out markup-free: the page
  // emits these as text, and a `<` that survived would read as raw SSML.
  it("strips every tag the committed artifact carries", () => {
    for (const group of artifact.recordingScript) {
      for (const line of group.lines) {
        for (const text of line.texts) expect(renderTakeText(text), `${group.group}/${line.base}`).not.toMatch(/<|>/);
      }
    }
  });
});

describe("viaVarConsumers", () => {
  it("resolves each var to the callouts whose entries name it", () => {
    const [via] = viaVarConsumers({ viaVar: ["incident.points"] }, artifact.vocabulary);
    const incidentPoints = artifact.vocabulary.vars.find((v) => v.name === "incident.points");

    expect(via.name).toBe("incident.points");
    expect(via.usedBy).toEqual(incidentPoints?.usedBy);
    expect(via.usedBy.length).toBeGreaterThan(0);
  });

  it("keeps a var the vocabulary does not carry, with nothing under it", () => {
    expect(viaVarConsumers({ viaVar: ["no.such"] }, artifact.vocabulary)).toEqual([{ name: "no.such", usedBy: [] }]);
  });
});

describe("unused lines and groups", () => {
  const line = (base: string, overrides: Partial<RecordingGroup["lines"][number]> = {}) => ({
    base,
    texts: [],
    takes: 1,
    usedBy: [],
    viaVar: [],
    playedBy: null,
    ...overrides,
  });
  const used: RecordingGroup = {
    group: "flags",
    lines: [line("green-race", { usedBy: ["pit-crew.flag-green"] }), line("orphan")],
  };
  const unused: RecordingGroup = { group: "openers", lines: [line("hi")] };
  const RADIO_CHECK = "Played by the plugin itself: the radio check when the sim connects.";
  const NAME = "Played by the plugin itself: the driver's name, one clip per name.";
  // The plugin plays one line of it by path and nothing plays the other.
  const toggle: RecordingGroup = {
    group: "toggle",
    lines: [line("hello"), line("radio-check", { playedBy: RADIO_CHECK })],
  };
  // Every line of it is played the same way — the artifact repeats the text per line.
  const names: RecordingGroup = {
    group: "names",
    lines: [line("dave", { playedBy: NAME }), line("niklas", { playedBy: NAME })],
  };

  it("marks a line nothing draws from — not an entry, a var, or plugin code", () => {
    expect(isUnusedLine(used.lines[0])).toBe(false);
    expect(isUnusedLine(used.lines[1])).toBe(true);
    expect(isUnusedLine({ usedBy: [], viaVar: ["incident.points"], playedBy: null })).toBe(false);
    expect(isUnusedLine({ usedBy: [], viaVar: [], playedBy: RADIO_CHECK })).toBe(false);
  });

  it("marks a group only when every line is unused", () => {
    expect(isUnusedGroup(used)).toBe(false);
    expect(isUnusedGroup(unused)).toBe(true);
    expect(isUnusedGroup(toggle)).toBe(false);
  });

  it("hoists a playedBy every line of a group shares to the group, and leaves a mixed group's to its lines", () => {
    expect(groupPlayedBy(names)).toBe(NAME);
    expect(groupPlayedBy(toggle)).toBeUndefined();
    expect(groupPlayedBy(used)).toBeUndefined();
    expect(groupPlayedBy({ lines: [] })).toBeUndefined();
  });

  it("notes a group by the playedBy it shares, an unused one as a leftover, any other not at all", () => {
    expect(groupNote(names)).toBe(NAME);
    expect(groupNote(unused)).toBe(UNUSED_GROUP_NOTE);
    expect(groupNote(used)).toBeUndefined();
    expect(groupNote(toggle)).toBeUndefined();
  });

  it("puts a line's playedBy on the line unless the group note already says it", () => {
    expect(linePlayedBy(toggle.lines[1], groupNote(toggle))).toBe(RADIO_CHECK);
    expect(linePlayedBy(names.lines[0], groupNote(names))).toBeNull();
    expect(linePlayedBy(toggle.lines[0], groupNote(toggle))).toBeNull();
  });

  // The artifact carries the plugin-played lines; the page derives everything
  // from it. Whatever the generator marked has no script consumer (the plugin
  // is its only one), and the driver names read as one group note.
  it("finds every playedBy line in the artifact free of script consumers, and the names group hoisted", () => {
    const played = artifact.recordingScript.flatMap((g) => g.lines.filter((l) => l.playedBy !== null));

    expect(played.length).toBeGreaterThan(0);

    for (const l of played) {
      expect(l.usedBy, l.base).toEqual([]);
      expect(l.viaVar, l.base).toEqual([]);
    }

    const namesGroup = artifact.recordingScript.find((g) => g.group === "names");

    expect(namesGroup).toBeDefined();
    expect(groupPlayedBy(namesGroup as RecordingGroup)).toMatch(/driver's name/);
  });
});

describe("cross-page links", () => {
  it("anchors a callout by its id and a recording line by its pool path", () => {
    expect(calloutHref("pit-crew.flag-green")).toBe("/docs/voice-packs/reference/callouts/#pit-crew.flag-green");
    expect(lineAnchor("flags/green-race")).toBe("line-flags-green-race");
    expect(lineHref("flags/green-race")).toBe("/docs/voice-packs/reference/recording-script/#line-flags-green-race");
  });

  it("gives vars, conditions and cases distinct anchors on the vocabulary page", () => {
    expect(varAnchor("session.type")).not.toBe(caseAnchor("session.type"));
    expect(condHref("lapTime.hasMinuteComponent")).toBe(
      "/docs/voice-packs/reference/vocabulary/#cond-lapTime.hasMinuteComponent",
    );
    expect(varHref("lapTime.minute")).toBe("/docs/voice-packs/reference/vocabulary/#var-lapTime.minute");
    expect(caseHref("session.type")).toBe("/docs/voice-packs/reference/vocabulary/#case-session.type");
  });
});

describe("table of contents", () => {
  it("lists one entry per family, the no-family bucket last", () => {
    const toc = calloutsToc(artifact.callouts);

    expect(toc[0].depth).toBe(2);
    expect(toc[toc.length - 1]).toMatchObject({ slug: NO_FAMILY_ANCHOR, text: NO_FAMILY_LABEL });
  });

  it("lists the three vocabulary sections", () => {
    expect(vocabularyToc().map((t) => t.slug)).toEqual(["vars", "conds", "cases"]);
  });

  it("lists one entry per clip group", () => {
    const toc = recordingScriptToc(artifact.recordingScript);

    expect(toc).toHaveLength(artifact.recordingScript.length);
    expect(toc[0]).toMatchObject({ slug: `group-${artifact.recordingScript[0].group}` });
  });
});
