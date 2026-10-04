import { listCornerNames } from "@iracedeck/track-data";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { audioAssetsPath, PUBLISHED_VOICE_IDS } from "./build/index.mjs";
import { loadVoiceConfigs } from "./generate/config.ts";

// The `corner-names` group is hand-authored since #1336: each entry's text is
// the name as it is spelled locally ("Brünnchen.", not the dataset's
// "Bruennchen") with a `language_code` for a non-English one, so the voice says
// it the way a local would. No generator rewrites it from `@iracedeck/track-data`
// any more, so these are what catch a dataset refresh that adds or drops a
// corner: the corner-name callout looks a clip up by slug, and a corner with no
// clip would go unspoken without a word.

const CONFIGS_DIR = path.join(audioAssetsPath, "configs");
const configs = loadVoiceConfigs(CONFIGS_DIR);

function cornerEntries(voiceId: string) {
  return configs.get(voiceId)?.groups["corner-names"] ?? [];
}

const expected = listCornerNames()
  .map(({ slug }) => `${slug}-01`)
  .sort();

describe("corner-names group", () => {
  it.each(PUBLISHED_VOICE_IDS)("%s has exactly one entry per track-data corner", (voiceId) => {
    expect(
      cornerEntries(voiceId)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(expected);
  });

  it.each(PUBLISHED_VOICE_IDS)("%s ships a clip for every entry", (voiceId) => {
    const missing = cornerEntries(voiceId)
      .map((entry) => `voice/${voiceId}/corner-names/${entry.name}.mp3`)
      .filter((clip) => !existsSync(path.join(audioAssetsPath, clip)));

    expect(missing).toEqual([]);
  });

  // The two first-party voices are one engineer in two styles, and a corner's
  // name is not a matter of style: a pronunciation fixed in one voice only is
  // the drift #1336 repaired.
  it.each(PUBLISHED_VOICE_IDS.filter((voiceId) => voiceId !== "default"))(
    "%s carries the default voice's corner-names entries verbatim",
    (voiceId) => {
      expect(cornerEntries(voiceId)).toEqual(cornerEntries("default"));
    },
  );

  // The generator this group came from spelled every number out and refused a
  // digit it had no rule for; a hand-written "Turn 12." in an English reading
  // risks a misread clip. A digit is fine where the entry names its language,
  // as the Italian and Dutch numbered corners do.
  it("keeps digits only in entries that name their language", () => {
    const unlocalised = cornerEntries("default")
      .filter((entry) => /\d/.test(entry.text) && !entry.voice_settings?.language_code)
      .map((entry) => entry.name);

    expect(unlocalised).toEqual([]);
  });
});
