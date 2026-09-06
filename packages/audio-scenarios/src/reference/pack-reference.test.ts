import type { CalloutScript } from "@iracedeck/callout-script";
import { describe, expect, it } from "vitest";

import type { ContractReport, VocabularyReport } from "../interpreter.js";
import {
  buildPackReference,
  descriptionNamesGroup,
  type PackReferenceInput,
  serializePackReference,
} from "./pack-reference.js";

// ─── Fixture ─────────────────────────────────────────────────────────────────
//
// A small catalog that exercises every attribution path the reference makes:
// an entry whose references arrive only through an included fragment (and a
// fragment that fragment includes), a `skip: true` entry, a var whose
// description names a clip group, a `pools` alias, a frame override, literal
// voice clips in both spellings, and a group no config line describes.

function contract(overrides: Partial<ContractReport> & { id: string }): ContractReport {
  return {
    event: "flag.green.raised",
    description: "The green flag flies.",
    frame: "radio",
    family: "flag",
    weight: 100,
    queueable: false,
    interrupt: false,
    ...overrides,
  };
}

const CONTRACTS: readonly ContractReport[] = [
  // Deliberately out of order: the builder sorts, whatever the engine handed it.
  contract({ id: "pit-crew.spotter-call", event: null, family: "spotter", description: "A car pulls alongside." }),
  contract({ id: "pit-crew.readback-entry", event: "pitLane.entered", family: "pit-readback", weight: 200 }),
  contract({ id: "pit-crew.flag-green" }),
  contract({
    id: "pit-crew.incident",
    event: "incident.occurred",
    family: "incident",
    queueable: true,
    interrupt: true,
  }),
  contract({ id: "pit-crew.flag-blue", event: "flag.blue.raised", description: "A faster car is behind." }),
];

const VOCABULARY: VocabularyReport = {
  vars: [
    { name: "zz.unused", description: "Never referenced by any entry." },
    {
      name: "incident.points",
      description:
        'The penalty points the incident cost, spoken as a whole clause from the incidents group (incidents/points-2 is "That cost us two penalty points.").',
    },
    { name: "readback.fuel", description: "The fuel clause of the recap." },
  ],
  conds: [
    { name: "session.isRace", description: "The current session is a race." },
    { name: "readback.fuelQueued", description: "Fuel is queued for the stop." },
  ],
  cases: [
    {
      name: "readback.tirePattern",
      description: "Which tires are queued.",
      keys: { all: "All four tires.", none: "No tire change queued." },
    },
  ],
};

const SCRIPT: CalloutScript = {
  schema: 1,
  scenarios: {
    "pit-crew.readback-entry": {
      comment: "The service recap on pit entry.",
      test: "Harness → Pit → Entry.",
      sequence: ["pool:pit-readback/opener", "@readback-body"],
    },
    "pit-crew.flag-green": {
      comment: "Green flag, go.",
      test: "Harness → Flags → Green.",
      sequence: [{ if: "session.isRace", then: ["pool:flags/green"], else: ["pool:flags/green"] }],
    },
    "pit-crew.flag-blue": { skip: true, comment: "Not spoken in this voice." },
    "pit-crew.incident": {
      comment: "An incident and what it cost.",
      test: "Harness → Incidents → Contact.",
      sequence: ["pool:incidents/type-contact", { optional: ["{{incident.points}}"] }],
    },
    "pit-crew.spotter-call": {
      comment: "The spotter call.",
      test: "Harness → Spotter → Car left.",
      frame: "terse",
      sequence: [
        "pool:spot",
        "voice/{voice}/openers/alright.mp3",
        "/voice/default/units/km.mp3",
        "pool:undefined-alias",
      ],
    },
  },
  frames: {
    radio: { open: [{ clip: "sfx/IRD-tick-open.mp3" }], close: [] },
    terse: { open: [], close: [] },
  },
  pools: { spot: { group: "spotter", base: "car-left" } },
  fragments: {
    "readback-body": {
      sequence: [
        { if: "readback.fuelQueued", then: ["pool:pit-readback/fuel-on"], else: ["{{readback.fuel}}"] },
        "@tire-line",
      ],
    },
    "tire-line": {
      sequence: [{ case: "readback.tirePattern", of: { all: ["pool:pit-readback/tires-all"], default: [] } }],
    },
  },
};

const GROUPS: PackReferenceInput["groups"] = {
  flags: [
    // Authored out of take order: the line's `texts` follow the take number, not the file.
    { name: "green-02", text: "Green green green." },
    { name: "blue-01", text: "Blue flag." },
    { name: "green-03", text: "Green flag. Go racing." },
    { name: "green-01", text: "Green flag, go go go." },
  ],
  incidents: [
    { name: "points-1", text: "One point." },
    { name: "points-2", text: "Two points." },
  ],
  spotter: [{ name: "car-left-01", text: "Car left." }],
  "pit-readback": [{ name: "fuel-on-01", text: "Fuel is on." }],
  units: [{ name: "km", text: "kilometers per hour" }],
  openers: [{ name: "alright", text: "Alright" }],
};

const MANIFEST_CLIPS: readonly string[] = [
  "sfx/IRD-tick-open.mp3",
  "voice/other/flags/green-01.mp3",
  "voice/default/units/km.mp3",
  "voice/default/spotter/car-left-01.mp3",
  "voice/default/pit-readback/fuel-on-01.mp3",
  "voice/default/orphan-group/lonely-01.mp3",
  "voice/default/openers/alright.mp3",
  "voice/default/incidents/points-2.mp3",
  "voice/default/incidents/points-1.mp3",
  "voice/default/flags/green-03.mp3",
  "voice/default/flags/green-01.mp3",
  "voice/default/flags/green-02.mp3",
  "voice/default/flags/blue-01.mp3",
];

function input(overrides: Partial<PackReferenceInput> = {}): PackReferenceInput {
  return {
    catalogVersion: "3.2.0-dev.0",
    contracts: CONTRACTS,
    vocabulary: VOCABULARY,
    script: SCRIPT,
    groups: GROUPS,
    manifestClips: MANIFEST_CLIPS,
    ...overrides,
  };
}

function lineOf(ref: ReturnType<typeof buildPackReference>, group: string, base: string) {
  const line = ref.recordingScript.find((g) => g.group === group)?.lines.find((l) => l.base === base);

  if (!line) throw new Error(`no recording line ${group}/${base}`);

  return line;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("buildPackReference", () => {
  it("publishes every contract as a callout: the contract's own fields, the entry's prose, and what the entry references", () => {
    const ref = buildPackReference(input());

    expect(ref.generatedFrom).toEqual({ catalogVersion: "3.2.0-dev.0" });
    expect(ref.callouts).toHaveLength(CONTRACTS.length);
    expect(ref.callouts.find((c) => c.id === "pit-crew.incident")).toEqual({
      id: "pit-crew.incident",
      family: "incident",
      event: "incident.occurred",
      description: "The green flag flies.",
      frame: "radio",
      weight: 100,
      queueable: true,
      interrupt: true,
      comment: "An incident and what it cost.",
      test: "Harness → Incidents → Contact.",
      skip: false,
      references: {
        pools: ["incidents/type-contact"],
        vars: ["incident.points"],
        conds: [],
        cases: [],
        includes: [],
        frames: [],
      },
    });
  });

  it("sorts callouts by id, vocabulary by name, groups and lines by name, and every reference list — in code-point order", () => {
    const ref = buildPackReference(input());

    expect(ref.callouts.map((c) => c.id)).toEqual([
      "pit-crew.flag-blue",
      "pit-crew.flag-green",
      "pit-crew.incident",
      "pit-crew.readback-entry",
      "pit-crew.spotter-call",
    ]);
    expect(ref.vocabulary.vars.map((v) => v.name)).toEqual(["incident.points", "readback.fuel", "zz.unused"]);
    expect(ref.vocabulary.conds.map((c) => c.name)).toEqual(["readback.fuelQueued", "session.isRace"]);
    expect(ref.recordingScript.map((g) => g.group)).toEqual([
      "flags",
      "incidents",
      "openers",
      "orphan-group",
      "pit-readback",
      "spotter",
      "units",
    ]);
    expect(ref.recordingScript[0].lines.map((l) => l.base)).toEqual(["blue", "green"]);
    // Code-point order, not locale order: a generated artifact must not depend
    // on the ICU of the machine that ran the generator.
    expect(
      buildPackReference(
        input({
          contracts: [contract({ id: "test.Zulu" }), contract({ id: "test.alpha" }), contract({ id: "test_alpha" })],
          script: {
            ...SCRIPT,
            scenarios: { "test.Zulu": { skip: true }, "test.alpha": { skip: true }, test_alpha: { skip: true } },
          },
        }),
      ).callouts.map((c) => c.id),
    ).toEqual(["test.Zulu", "test.alpha", "test_alpha"]);
  });

  it("attributes what an included fragment references to the including callout — through a fragment the fragment itself includes", () => {
    const ref = buildPackReference(input());
    const readback = ref.callouts.find((c) => c.id === "pit-crew.readback-entry");

    expect(readback?.references).toEqual({
      pools: ["pit-readback/fuel-on", "pit-readback/opener", "pit-readback/tires-all"],
      vars: ["readback.fuel"],
      conds: ["readback.fuelQueued"],
      cases: [{ name: "readback.tirePattern", keys: ["all"] }],
      includes: ["readback-body", "tire-line"],
      frames: [],
    });

    // The vocabulary's `usedBy` is the same attribution, inverted.
    expect(ref.vocabulary.vars.find((v) => v.name === "readback.fuel")?.usedBy).toEqual(["pit-crew.readback-entry"]);
    expect(ref.vocabulary.conds.find((c) => c.name === "readback.fuelQueued")?.usedBy).toEqual([
      "pit-crew.readback-entry",
    ]);
    expect(ref.vocabulary.cases.find((c) => c.name === "readback.tirePattern")).toEqual({
      name: "readback.tirePattern",
      description: "Which tires are queued.",
      keys: { all: "All four tires.", none: "No tire change queued." },
      usedBy: ["pit-crew.readback-entry"],
    });
    expect(ref.vocabulary.vars.find((v) => v.name === "zz.unused")?.usedBy).toEqual([]);
    // And so is a recording line's — the fragment's pool draws the entry in.
    expect(lineOf(ref, "pit-readback", "fuel-on").usedBy).toEqual(["pit-crew.readback-entry"]);
  });

  it("publishes a skip: true entry as skipped — its comment kept, nothing referenced, nothing it names attributed", () => {
    const ref = buildPackReference(input());

    expect(ref.callouts.find((c) => c.id === "pit-crew.flag-blue")).toEqual({
      id: "pit-crew.flag-blue",
      family: "flag",
      event: "flag.blue.raised",
      description: "A faster car is behind.",
      frame: "radio",
      weight: 100,
      queueable: false,
      interrupt: false,
      comment: "Not spoken in this voice.",
      test: null,
      skip: true,
      references: { pools: [], vars: [], conds: [], cases: [], includes: [], frames: [] },
    });
    expect(lineOf(ref, "flags", "blue").usedBy).toEqual([]);
  });

  it("builds the recording script off the voice's manifest clips: takes per base, every take's text in take order, [] when the config has none", () => {
    const ref = buildPackReference(input());

    // `-NN` takes collapse to one base; every take's text is kept, by take
    // number — the bundled voice's takes differ per take, so publishing only
    // the first would hide the alternates a pack author is asked to record.
    expect(lineOf(ref, "flags", "green")).toEqual({
      base: "green",
      texts: ["Green flag, go go go.", "Green green green.", "Green flag. Go racing."],
      takes: 3,
      usedBy: ["pit-crew.flag-green"],
      viaVar: [],
    });
    // A bare name (no take suffix) is looked up as written, and counts as the first take.
    expect(lineOf(ref, "units", "km")).toEqual({
      base: "km",
      texts: ["kilometers per hour"],
      takes: 1,
      usedBy: ["pit-crew.spotter-call"],
      viaVar: [],
    });
    // A clip the config never describes still ships, so it is still a line to record.
    expect(lineOf(ref, "orphan-group", "lonely")).toEqual({
      base: "lonely",
      texts: [],
      takes: 1,
      usedBy: [],
      viaVar: [],
    });
    // Another voice's clips and the shared sfx are not this voice's lines.
    expect(ref.recordingScript.some((g) => g.group === "sfx")).toBe(false);
    expect(ref.recordingScript.flatMap((g) => g.lines).reduce((n, l) => n + l.takes, 0)).toBe(11);
  });

  it("orders texts by shipped take — a bare take first, then -01, -02, … — whatever order the config or the manifest lists them in, and only for takes that ship", () => {
    const ref = buildPackReference(
      input({
        manifestClips: [
          "voice/default/flags/green-02.mp3",
          "voice/default/flags/green.mp3",
          "voice/default/flags/green-01.mp3",
        ],
        groups: {
          flags: [
            { name: "green-02", text: "two" },
            { name: "green-03", text: "three — authored, never shipped" },
            { name: "green", text: "bare" },
            { name: "green-01", text: "one" },
          ],
        },
      }),
    );

    expect(lineOf(ref, "flags", "green")).toEqual({
      base: "green",
      texts: ["bare", "one", "two"],
      takes: 3,
      usedBy: ["pit-crew.flag-green"],
      viaVar: [],
    });
  });

  it("lists a var-only line with no direct consumer and the var in viaVar — the website derives the var's callouts from the vocabulary", () => {
    const ref = buildPackReference(input());

    // `incident.points` draws `incidents/points-N`; no entry addresses either
    // base directly, so `usedBy` is empty and the var is the only link.
    for (const base of ["points-1", "points-2"]) {
      expect(lineOf(ref, "incidents", base)).toEqual({
        base,
        texts: [base === "points-1" ? "One point." : "Two points."],
        takes: 1,
        usedBy: [],
        viaVar: ["incident.points"],
      });
    }

    expect(ref.vocabulary.vars.find((v) => v.name === "incident.points")?.usedBy).toEqual(["pit-crew.incident"]);
  });

  it("keeps a directly addressed line's consumers to the entries that address it, even inside a group a var also draws from", () => {
    const ref = buildPackReference(
      input({
        manifestClips: [...MANIFEST_CLIPS, "voice/default/incidents/type-contact-01.mp3"],
        groups: { ...GROUPS, incidents: [...GROUPS.incidents, { name: "type-contact-01", text: "Contact." }] },
      }),
    );

    // The incident entry names `incidents/type-contact` itself, so it is the
    // direct consumer; the group-level var is still noted, and only there.
    expect(lineOf(ref, "incidents", "type-contact")).toEqual({
      base: "type-contact",
      texts: ["Contact."],
      takes: 1,
      usedBy: ["pit-crew.incident"],
      viaVar: ["incident.points"],
    });
  });

  it("resolves a pools alias to its group/base, keeps an alias the script does not define as written, and counts literal voice clips in either spelling", () => {
    const ref = buildPackReference(input());
    const spotter = ref.callouts.find((c) => c.id === "pit-crew.spotter-call");

    expect(spotter?.references.pools).toEqual(["spotter/car-left", "undefined-alias"]);
    expect(lineOf(ref, "spotter", "car-left").usedBy).toEqual(["pit-crew.spotter-call"]);
    expect(lineOf(ref, "openers", "alright").usedBy).toEqual(["pit-crew.spotter-call"]);
    expect(lineOf(ref, "units", "km").usedBy).toEqual(["pit-crew.spotter-call"]);
  });

  it("reports the contract's default frame on the callout and the entry's override under references.frames", () => {
    const ref = buildPackReference(input());
    const spotter = ref.callouts.find((c) => c.id === "pit-crew.spotter-call");

    expect(spotter?.frame).toBe("radio");
    expect(spotter?.references.frames).toEqual(["terse"]);

    const unframed = buildPackReference(
      input({
        script: {
          ...SCRIPT,
          scenarios: { ...SCRIPT.scenarios, "pit-crew.flag-green": { frame: "none", sequence: ["pool:flags/green"] } },
        },
      }),
    ).callouts.find((c) => c.id === "pit-crew.flag-green");

    expect(unframed?.references.frames).toEqual([]);
    expect(unframed?.comment).toBeNull();
    expect(unframed?.test).toBeNull();
  });

  it("refuses a contract the script has no entry for, naming it — a legacy scenario speaking from code is exactly what that looks like", () => {
    const contracts = [...CONTRACTS, contract({ id: "pit-crew.legacy-line" }), contract({ id: "pit-crew.another" })];

    expect(() => buildPackReference(input({ contracts }))).toThrow(/pit-crew\.another.*pit-crew\.legacy-line/);
    expect(() => buildPackReference(input({ contracts }))).toThrow(/legacy/);
  });

  it("reads the voice's clips under the voice it is given", () => {
    const ref = buildPackReference(input({ voice: "other" }));

    expect(ref.recordingScript).toEqual([
      {
        group: "flags",
        // One shipped take, so one text — the two other authored takes are not this voice's.
        lines: [
          { base: "green", texts: ["Green flag, go go go."], takes: 1, usedBy: ["pit-crew.flag-green"], viaVar: [] },
        ],
      },
    ]);
  });
});

describe("descriptionNamesGroup", () => {
  it("matches the group as a slashed example or as the head of '<group> group' / '<group> clip group'", () => {
    expect(descriptionNamesGroup("spoken from the incidents group (incidents/points-2 is …)", "incidents")).toBe(true);
    expect(descriptionNamesGroup("from the pit-limiter/unit-kmh clip", "pit-limiter")).toBe(true);
    expect(descriptionNamesGroup("Draws from the session-start clip group.", "session-start")).toBe(true);
    expect(descriptionNamesGroup("drawn from the spotter group", "spotter")).toBe(true);
  });

  it("does not match the group as a plain word, or inside a longer kebab-case name", () => {
    expect(descriptionNamesGroup("The trend line for the gap that just changed.", "gap")).toBe(false);
    expect(descriptionNamesGroup("drawn from the lap-time-decimal group", "lap-time")).toBe(false);
    expect(descriptionNamesGroup("drawn from the lap-time-decimal group", "decimal")).toBe(false);
    expect(descriptionNamesGroup("Draws from the session-start-greeting clip group.", "session-start")).toBe(false);
    expect(descriptionNamesGroup("a gap/ahead-closing line", "ahead-closing")).toBe(false);
  });
});

describe("serializePackReference", () => {
  it("writes 2-space JSON with a trailing newline, keys in declared order", () => {
    const text = serializePackReference(buildPackReference(input()));

    expect(text.startsWith('{\n  "generatedFrom": {\n    "catalogVersion": "3.2.0-dev.0"\n  },\n  "callouts": [')).toBe(
      true,
    );
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toMatch(
      /"id": "pit-crew\.flag-blue",\n\s+"family": "flag",\n\s+"event": "flag\.blue\.raised",\n\s+"description": /,
    );
    expect(text).toMatch(/"vocabulary": \{\n\s+"vars": \[/);
    expect(text).toMatch(
      /"recordingScript": \[\n\s+\{\n\s+"group": "flags",\n\s+"lines": \[\n\s+\{\n\s+"base": "blue",/,
    );
    expect(JSON.parse(text)).toEqual(buildPackReference(input()));
  });
});
