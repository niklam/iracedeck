import { describe, expect, it } from "vitest";

import { BUNDLED_VOICE_IDS, VOICE_PACKS } from "./voice-packs.mjs";

describe("voice-packs.mjs — no voice ships inside a plugin (#1144)", () => {
  // Re-bundling a voice used to be one word, `bundled: true`. #1144 namespaced
  // voice ids by pack and removed what a bundled voice leaned on, so the word
  // alone now ships a voice with no script beside its own pack's copy. This
  // test is the tripwire that says so, at the edit, rather than in the sim.

  it("marks no pack bundled until what a bundled voice needs is restored", () => {
    const bundled = VOICE_PACKS.filter((pack) => pack.bundled).map((pack) => pack.id);

    expect(
      bundled,
      `voice-packs.mjs marks ${JSON.stringify(bundled)} as bundled. Since #1144 that is not the whole job — first ` +
        "restore the voice-pack service's read of a bundled voice's callouts.json (without it the voice speaks no " +
        "callout), decide how a bundled voice is named beside its pack's `<pack id>::<voice id>` (its clips list " +
        "under the bare id, next to e.g. `default::default`), and restore the catalog's bundled-voice verdict " +
        "(`isProvidedByBundle`) so the same pack is not offered for download too; then update this test.",
    ).toEqual([]);
  });

  it("derives an empty bundled-voice list from that", () => {
    expect(BUNDLED_VOICE_IDS).toEqual([]);
  });
});
