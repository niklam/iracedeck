import { qualifiedVoiceId } from "@iracedeck/callout-script";
import { describe, expect, it } from "vitest";

import { voiceDisplayLabels } from "./voice-labels.js";
import type { InstalledVoicePack } from "./voice-pack-scanner.js";

/** A pack whose id is its lower-cased label, declaring the given bare voice ids. */
function pack(label: string, voices: { id: string; label: string }[]): InstalledVoicePack {
  const id = label.toLowerCase();

  // `provenance` is irrelevant to labelling — a pack is named the same way
  // whoever installed it — but the type requires it, so a sideload stands in.
  // Likewise `script` (#1064): a label is the same with or without one, so
  // every voice here is clips-only.
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
    provenance: "sideload",
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
