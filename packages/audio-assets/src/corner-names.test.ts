import { listCornerNames } from "@iracedeck/track-data";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The `corner-names` group is hand-authored since #1336: each entry's text is
// the name as it is spelled locally ("Brünnchen.", not the dataset's
// "Bruennchen") with a `language_code` for a non-English one, so the voice says
// it the way a local would. No generator rewrites it from `@iracedeck/track-data`
// any more, so this is what catches a dataset refresh that adds or drops a corner:
// the corner-name callout looks a clip up by slug, and a corner with no entry
// would go unspoken without a word.

const CONFIGS_DIR = join(import.meta.dirname, "..", "configs");

interface VoiceConfig {
  groups: Record<string, { name: string }[]>;
}

function cornerNameEntries(file: string): string[] | undefined {
  const config = JSON.parse(readFileSync(join(CONFIGS_DIR, file), "utf8")) as VoiceConfig;

  return config.groups["corner-names"]?.map((entry) => entry.name);
}

const expected = listCornerNames()
  .map(({ slug }) => `${slug}-01`)
  .sort();

const voicesWithCorners = readdirSync(CONFIGS_DIR)
  .filter((file) => file.endsWith(".voice.json"))
  .filter((file) => cornerNameEntries(file) !== undefined);

describe("corner-names group", () => {
  it("is authored by the default voice", () => {
    expect(voicesWithCorners).toContain("default.voice.json");
  });

  it.each(voicesWithCorners)("%s has exactly one entry per track-data corner", (file) => {
    expect([...cornerNameEntries(file)!].sort()).toEqual(expected);
  });
});
