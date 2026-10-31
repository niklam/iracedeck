import defaultVoicePackCatalogEntry from "@iracedeck/audio-assets/catalog/default.json" with { type: "json" };
import { silentLogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetRecorder } from "../../test-support/recorder.js";
import { COMPILED_IN_VOICE_PACK_ENTRIES, seedableBundledPacks } from "./seed.js";

// Recorded like every other phase test's; the catalog entry schema is a
// non-function export, so it stays real and the seed validates for real.
vi.mock("@iracedeck/voice-packs", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);

/** A valid catalog entry carrying `voiceIds`, built from the committed `default` entry. */
function entry(id: string, voiceIds: readonly string[]): Record<string, unknown> {
  return {
    ...defaultVoicePackCatalogEntry,
    id,
    voices: voiceIds.map((voiceId) => ({ id: voiceId, label: voiceId })),
  };
}

function setup() {
  const logger = { ...silentLogger, warn: vi.fn(), debug: vi.fn() };
  const seed = (entries: readonly unknown[], bundledVoices: readonly string[]) =>
    seedableBundledPacks({ entries, bundledVoices, audioDir: "C:/plugin/assets/audio", logger });

  return { logger, seed };
}

describe("seedableBundledPacks (#1377)", () => {
  beforeEach(() => resetRecorder());

  it("seeds an entry whose every voice the build bundles, from the plugin's audio directory", () => {
    const { logger, seed } = setup();

    const packs = seed([entry("default", ["default", "terse"])], ["default", "terse", "other"]);

    expect(packs).toHaveLength(1);
    expect(packs[0]?.entry.id).toBe("default");
    expect(packs[0]?.entry.voices.map((v) => v.id)).toEqual(["default", "terse"]);
    expect(packs[0]?.audioDir).toBe("C:/plugin/assets/audio");
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("skips an invalid entry with a warning and its reason at debug, and goes on to the next", () => {
    const { logger, seed } = setup();

    const packs = seed([{ id: "broken" }, entry("default", ["default"])], ["default"]);

    expect(
      packs.map((p) => p.entry.id),
      "the valid entry after the invalid one is still seeded",
    ).toEqual([
      "default",
    ]);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      "A compiled-in voice pack catalog entry is invalid; that pack will not be seeded",
    );
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  it("does not seed a published pack whose voices the build does not all carry", () => {
    const { logger, seed } = setup();

    const packs = seed([entry("partial", ["default", "terse"]), entry("absent", ["matt"])], ["default"]);

    expect(packs).toEqual([]);
    expect(logger.debug.mock.calls).toEqual([
      ['Voice pack "partial" is published, not bundled; not seeded'],
      ['Voice pack "absent" is published, not bundled; not seeded'],
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("compiles in a valid default entry, which seeds nothing while no voice is bundled", () => {
    const { logger, seed } = setup();

    expect(COMPILED_IN_VOICE_PACK_ENTRIES).toEqual([defaultVoicePackCatalogEntry]);
    // Since 3.3.0 no plugin ships a voice: the entry parses, and is skipped as published.
    expect(seed(COMPILED_IN_VOICE_PACK_ENTRIES, [])).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledExactlyOnceWith('Voice pack "default" is published, not bundled; not seeded');
  });
});
