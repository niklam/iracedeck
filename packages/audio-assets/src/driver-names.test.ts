import { DRIVER_NAME_ALIASES, DRIVER_NAME_GROUPS, stripTakeSuffix } from "@iracedeck/callout-script";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { audioAssetsPath, VOICE_PACKS } from "./build/index.mjs";
import { loadVoiceConfigs, type VoiceConfig } from "./generate/config.ts";
import { findDriverNameAliasEntries } from "./generate/driver-name-aliases.ts";

// Driver names in the first-party voices (#1580). A spelling spoken as another
// listed name is an alias (`@iracedeck/callout-script`'s `DRIVER_NAME_ALIASES`)
// and plays its canonical's clips, so every first-party voice records each
// canonical in every group a name is spoken from and no alias in any of them:
// a missing canonical silences every alias of it as well, and an alias entry is
// five paid clips per voice the plugin never needs. A third-party pack may
// record an alias spelling (the plugin plays its own clips then), so this is a
// rule for our configs, never for `lint:pack`.

const configs = loadVoiceConfigs(path.join(audioAssetsPath, "configs"));
const firstPartyVoices = VOICE_PACKS.flatMap((pack) => [...pack.voices]);
const canonicals = [...new Set(Object.values(DRIVER_NAME_ALIASES))].sort();

/** The take-folded entry names `voice` records in `group`. */
function recorded(voice: Pick<VoiceConfig, "groups">, group: string): Set<string> {
  return new Set((voice.groups[group] ?? []).map((entry) => stripTakeSuffix(entry.name)));
}

/** Every `<group>/<canonical>` the voice does not record. */
function missingCanonicals(voice: Pick<VoiceConfig, "groups">): string[] {
  return DRIVER_NAME_GROUPS.flatMap((group) =>
    canonicals
      .filter((canonical) => !recorded(voice, group).has(canonical))
      .map((canonical) => `${group}/${canonical}`),
  );
}

/** Every `<group>/<entry>` recording an alias spelling, with its canonical. */
function aliasEntries(voice: Pick<VoiceConfig, "groups">): string[] {
  return findDriverNameAliasEntries(voice).map(({ group, name, canonical }) => `${group}/${name} (→ ${canonical})`);
}

describe("driver names in the first-party voices (#1580)", () => {
  it("finds a config for every first-party voice", () => {
    expect(firstPartyVoices.length).toBeGreaterThan(0);
    expect(firstPartyVoices.filter((voice) => !configs.has(voice))).toEqual([]);
    expect(canonicals.length).toBeGreaterThan(0);
  });

  it.each(firstPartyVoices)("%s records every canonical in every driver-name group", (voiceId) => {
    expect(missingCanonicals(configs.get(voiceId)!)).toEqual([]);
  });

  it.each(firstPartyVoices)("%s records no alias in any driver-name group", (voiceId) => {
    expect(aliasEntries(configs.get(voiceId)!)).toEqual([]);
  });

  // Positive controls: each rule fails on the config it guards, edited the one
  // way it exists to catch, so a green run above is not a check that cannot fail.
  describe("each rule fails when broken", () => {
    const voiceId = firstPartyVoices[0];
    const groups = configs.get(voiceId)!.groups;

    it("an alias entry put back into the names group", () => {
      const names = groups.names ?? [];
      const withAlias = { groups: { ...groups, names: [...names, { ...names[0], name: "geoff", text: "Jeff" }] } };

      expect(aliasEntries(withAlias)).toEqual(["names/geoff (→ jeff)"]);
    });

    it("a canonical removed from one group", () => {
      const group = DRIVER_NAME_GROUPS[DRIVER_NAME_GROUPS.length - 1];
      const without = {
        groups: { ...groups, [group]: (groups[group] ?? []).filter((entry) => stripTakeSuffix(entry.name) !== "jeff") },
      };

      expect(missingCanonicals(without)).toEqual([`${group}/jeff`]);
    });
  });
});
