import { qualifiedVoiceId } from "@iracedeck/callout-script";
import { describe, expect, it } from "vitest";

import { isFirstPartyVoicePack, orderRaceEngineerVoices, voiceDisplayLabels } from "./voice-labels.js";
import type { InstalledVoicePack, VoicePackProvenanceKind } from "./voice-pack-scanner.js";

/**
 * A pack declaring the given bare voice ids, its id defaulting to its
 * lower-cased label and its provenance to `sideload` — irrelevant to the
 * labelling tests below, which is why most callers leave it unset. Likewise
 * `script` (#1064): a label is the same with or without one, so every voice
 * here is clips-only.
 */
function pack(
  label: string,
  voices: { id: string; label: string }[],
  options: { id?: string; provenance?: VoicePackProvenanceKind } = {},
): InstalledVoicePack {
  const id = options.id ?? label.toLowerCase();

  return {
    id,
    label,
    version: "1.0.0",
    dir: `/packs/${label}`,
    voices: voices.map((voice) => ({
      id: qualifiedVoiceId(id, voice.id),
      packVoiceId: voice.id,
      label: voice.label,
      script: null,
    })),
    clips: [],
    provenance: options.provenance ?? "sideload",
  };
}

describe("voiceDisplayLabels", () => {
  it("keys every entry by the voice's composite id (#1144)", () => {
    // The map is read by the composite id the dropdown's options carry, so a
    // bare key would label nothing.
    expect(voiceDisplayLabels([pack("Vixen", [{ id: "vixen", label: "Vixen" }])])).toEqual({ "vixen::vixen": "Vixen" });
  });

  it("shows the voice alone when the pack IS the voice", () => {
    // The common case, and the one that made a naive `<pack>: <voice>` composite
    // read as "Vixen: Vixen".
    expect(voiceDisplayLabels([pack("Vixen", [{ id: "vixen", label: "Vixen" }])])).toEqual({ "vixen::vixen": "Vixen" });
  });

  it("prefixes when the pack names its single voice something else", () => {
    // The shape the project's own packs will take: `iRaceDeck` / `Default`.
    expect(voiceDisplayLabels([pack("iRaceDeck", [{ id: "default", label: "Default" }])])).toEqual({
      "iracedeck::default": "iRaceDeck: Default",
    });
  });

  it("prefixes EVERY voice of a multi-voice pack, including one matching the pack's name", () => {
    // The case that decides per-pack over per-voice. Deciding per voice would
    // render `Vixen` bare and `Vixen: Vixen Short` prefixed — one manifest,
    // written in one sitting, displayed two ways.
    const labels = voiceDisplayLabels([
      pack("Vixen", [
        { id: "vixen", label: "Vixen" },
        { id: "vixen-short", label: "Vixen Short" },
      ]),
    ]);

    expect(labels).toEqual({ "vixen::vixen": "Vixen: Vixen", "vixen::vixen-short": "Vixen: Vixen Short" });
  });

  it("disambiguates two packs that name a voice the same way", () => {
    const labels = voiceDisplayLabels([
      pack("Luca's Pack", [{ id: "luca", label: "Race Engineer" }]),
      pack("Other", [{ id: "other", label: "Race Engineer" }]),
    ]);

    expect(labels).toEqual({
      "luca's pack::luca": "Luca's Pack: Race Engineer",
      "other::other": "Other: Race Engineer",
    });
  });

  it("labels two packs' voices of the same bare id separately", () => {
    // Two `matt`s are two entries, because their composite ids differ — the
    // whole point of #1144. Whether their LABELS also differ is #1147's rule.
    const labels = voiceDisplayLabels([
      pack("Alpha", [{ id: "matt", label: "Matt" }]),
      pack("Beta", [{ id: "matt", label: "Matt" }]),
    ]);

    expect(labels).toEqual({ "alpha::matt": "Alpha: Matt", "beta::matt": "Beta: Matt" });
  });

  it("does not change an existing entry when another pack is installed", () => {
    // The property worth protecting, and the reason collision-prefixing was
    // rejected: a name is fixed when its pack is installed and never renamed by
    // somebody else's later arrival.
    const alone = voiceDisplayLabels([pack("Vixen", [{ id: "vixen", label: "Vixen" }])]);
    const withNeighbour = voiceDisplayLabels([
      pack("Vixen", [{ id: "vixen", label: "Vixen" }]),
      pack("Other", [{ id: "other", label: "Vixen" }]),
    ]);

    expect(withNeighbour["vixen::vixen"]).toBe(alone["vixen::vixen"]);
  });

  it("labels nothing when no pack is installed", () => {
    expect(voiceDisplayLabels([])).toEqual({});
  });

  it("still collides when two packs name BOTH themselves and their only voice the same", () => {
    // Pinned as the accepted bound rather than left to be discovered: pack IDS
    // are unique (they are folder names), pack LABELS are not. Rarer than the
    // renaming the alternative would cause, and accepted deliberately.
    const labels = voiceDisplayLabels([
      { ...pack("Race Engineer", [{ id: "one", label: "Race Engineer" }]), id: "one" },
      { ...pack("Race Engineer", [{ id: "two", label: "Race Engineer" }]), id: "two" },
    ]);

    expect(labels).toEqual({ "race engineer::one": "Race Engineer", "race engineer::two": "Race Engineer" });
  });
});

const ours = pack("Default", [{ id: "default", label: "Default" }], { id: "default", provenance: "catalog" });
const terse = pack("Default (Terse)", [{ id: "shawn", label: "Default (Terse)" }], {
  id: "iracedeck-terse",
  provenance: "catalog",
});

describe("isFirstPartyVoicePack", () => {
  it.each(["catalog", "bundled-seed", "development"] as const)("counts %s as iRaceDeck's own", (provenance) => {
    expect(isFirstPartyVoicePack({ provenance })).toBe(true);
  });

  it("never counts a sideload, whatever it is called", () => {
    expect(isFirstPartyVoicePack({ provenance: "sideload" })).toBe(false);
  });
});

describe("voiceDisplayLabels — first-party packs (#999)", () => {
  it("labels every voice of a first-party pack 'iRaceDeck: <pack label>'", () => {
    expect(voiceDisplayLabels([ours, terse])).toEqual({
      "default::default": "iRaceDeck: Default",
      "iracedeck-terse::shawn": "iRaceDeck: Default (Terse)",
    });
  });

  it("adds the voice label for every voice of a multi-voice first-party pack", () => {
    // `iRaceDeck: Pair` for both would render two identical dropdown entries.
    const duo = pack(
      "Pair",
      [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      { provenance: "catalog" },
    );
    expect(voiceDisplayLabels([duo])).toEqual({ "pair::a": "iRaceDeck: Pair: A", "pair::b": "iRaceDeck: Pair: B" });
  });

  it("keeps a single-voice first-party pack at 'iRaceDeck: <pack label>' even when its voice is named otherwise", () => {
    const solo = pack("Solo", [{ id: "x", label: "Someone" }], { provenance: "bundled-seed" });
    expect(voiceDisplayLabels([solo])).toEqual({ "solo::x": "iRaceDeck: Solo" });
  });

  it("gives a hand-placed copy of default no iRaceDeck prefix", () => {
    const copy = pack("Default", [{ id: "default", label: "Default" }], { id: "default", provenance: "sideload" });
    expect(voiceDisplayLabels([copy])).toEqual({ "default::default": "Default" });
  });
});

describe("orderRaceEngineerVoices (#999)", () => {
  it("puts the managed pack first, other iRaceDeck packs next, everyone else after, each by label", () => {
    const aaa = pack("Aaa", [{ id: "aaa", label: "Aaa" }]);
    const spoof = pack("iRaceDeck: Pro", [{ id: "pro", label: "iRaceDeck: Pro" }], { id: "pro" });
    const packs = [aaa, spoof, terse, ours];
    const labels = voiceDisplayLabels(packs);
    const voices = ["aaa::aaa", "default::default", "iracedeck-terse::shawn", "pro::pro"];

    expect(orderRaceEngineerVoices(voices, packs, labels)).toEqual([
      "default::default",
      "iracedeck-terse::shawn",
      "aaa::aaa",
      "pro::pro",
    ]);
  });

  it("keeps a voice no installed pack provides, sorted with the third-party voices", () => {
    const labels = voiceDisplayLabels([ours]);
    expect(orderRaceEngineerVoices(["zed", "default::default", "abe"], [ours], labels)).toEqual([
      "default::default",
      "abe",
      "zed",
    ]);
  });

  it("sorts an unlabelled voice by the name the dropdown shows, not by its raw id", () => {
    // `zeta::alpha` renders as `Alpha` (title-cased voice half), so it belongs
    // before a labelled `Beta` — the raw id `zeta::alpha` would sort after it.
    const beta = pack("Beta", [{ id: "beta", label: "Beta" }]);
    const labels = voiceDisplayLabels([beta]);
    expect(orderRaceEngineerVoices(["beta::beta", "zeta::alpha"], [beta], labels)).toEqual([
      "zeta::alpha",
      "beta::beta",
    ]);
  });

  it("does not put a sideloaded default first", () => {
    const copy = pack("Default", [{ id: "default", label: "Default" }], { id: "default", provenance: "sideload" });
    const aaa = pack("Aaa", [{ id: "aaa", label: "Aaa" }]);
    const packs = [copy, aaa, terse];
    expect(
      orderRaceEngineerVoices(
        ["aaa::aaa", "default::default", "iracedeck-terse::shawn"],
        packs,
        voiceDisplayLabels(packs),
      ),
    ).toEqual(["iracedeck-terse::shawn", "aaa::aaa", "default::default"]);
  });

  it("returns a new array and leaves its input alone", () => {
    const voices = ["iracedeck-terse::shawn", "default::default"];
    const ordered = orderRaceEngineerVoices(voices, [ours, terse], voiceDisplayLabels([ours, terse]));
    expect(ordered).toEqual(["default::default", "iracedeck-terse::shawn"]);
    expect(voices).toEqual(["iracedeck-terse::shawn", "default::default"]);
  });
});
