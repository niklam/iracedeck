import { describe, expect, it } from "vitest";

import { poolMemberPattern } from "./interpreter.js";
import {
  type AudioAssetsManifest,
  manifestVoices,
  mergeManifests,
  referenceVoice,
  scanDriverNames,
  scanRaceEngineerVoices,
} from "./manifest.js";

const manifest: AudioAssetsManifest = {
  clips: [
    "voice/luca/welcome.mp3",
    "voice/luca/names/niklas.mp3",
    "voice/luca/names/oivindl.mp3",
    "voice/titan/welcome.mp3",
    "voice/titan/names/niklas.mp3",
    "voice/titan/pit/box-this-lap.mp3",
    "sfx/IRD-tick-open.mp3",
    "ambient/pit-loop.mp3",
  ],
  ambientLoop: "ambient/pit-loop.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

describe("manifestVoices", () => {
  it("returns the set of voice keys from the manifest", () => {
    expect(manifestVoices(manifest)).toEqual(new Set(["luca", "titan"]));
  });

  it("returns an empty set when no voice clips are present", () => {
    expect(manifestVoices({ ...manifest, clips: ["sfx/IRD-tick-open.mp3"] })).toEqual(new Set());
  });
});

describe("scanRaceEngineerVoices", () => {
  it("returns voice keys sorted alphabetically", () => {
    expect(scanRaceEngineerVoices(manifest)).toEqual(["luca", "titan"]);
  });

  it("returns an empty array when no voice clips are present", () => {
    expect(scanRaceEngineerVoices({ ...manifest, clips: [] })).toEqual([]);
  });
});

describe("referenceVoice", () => {
  it("prefers the canonical 'default' voice when present", () => {
    const m: AudioAssetsManifest = {
      ...manifest,
      clips: ["voice/luca/welcome.mp3", "voice/default/welcome.mp3", "voice/titan/welcome.mp3"],
    };
    expect(referenceVoice(m)).toBe("default");
  });

  it("falls back to the first sorted voice when 'default' is absent", () => {
    expect(referenceVoice(manifest)).toBe("luca");
  });

  it("returns null when the manifest has no voices", () => {
    expect(referenceVoice({ ...manifest, clips: ["sfx/IRD-tick-open.mp3"] })).toBeNull();
  });
});

describe("scanDriverNames", () => {
  it("returns the union of driver names across voices, sorted", () => {
    expect(scanDriverNames(manifest)).toEqual(["niklas", "oivindl"]);
  });

  it("strips the .mp3 extension from each name", () => {
    const m: AudioAssetsManifest = {
      ...manifest,
      clips: ["voice/luca/names/with.dot.mp3"],
    };
    expect(scanDriverNames(m)).toEqual(["with.dot"]);
  });

  it("ignores clips that aren't direct children of voice/<voice>/names/", () => {
    const m: AudioAssetsManifest = {
      ...manifest,
      clips: ["voice/luca/names/sub/nested.mp3", "voice/luca/welcome.mp3"],
    };
    expect(scanDriverNames(m)).toEqual([]);
  });

  describe("name takes (#1173)", () => {
    // A pack may record a name as takes (`names/niklas-01.mp3`), which the
    // engine plays as the `niklas` pool. The list offers what is SPOKEN, so a
    // take lists as its base — otherwise the dropdown carries `niklas-01`
    // beside `niklas`, and picking it names a pool the bare clips never join.
    const names = (...clips: string[]): string[] => scanDriverNames({ ...manifest, clips });

    it("lists a bare clip as itself", () => {
      expect(names("voice/luca/names/niklas.mp3")).toEqual(["niklas"]);
    });

    it("lists a take as its base", () => {
      expect(names("voice/luca/names/niklas-01.mp3")).toEqual(["niklas"]);
    });

    it("folds a bare clip and its takes into one entry, across voices", () => {
      expect(
        names("voice/default/names/niklas.mp3", "voice/snoop/names/niklas-01.mp3", "voice/snoop/names/niklas-02.mp3"),
      ).toEqual(["niklas"]);
    });

    it("lists a name one pack carries only as a take under its base", () => {
      expect(names("voice/default/names/niklas.mp3", "voice/snoop/names/adam-01.mp3")).toEqual(["adam", "niklas"]);
    });

    it.each([
      ["digits with no hyphen", "r2d2"],
      ["a one-digit suffix", "abc-1"],
      ["a three-digit suffix", "abc-123"],
    ])("leaves a name ending in %s as it is (%s)", (_case, name) => {
      expect(names(`voice/luca/names/${name}.mp3`)).toEqual([name]);
    });

    it("lists every clip under exactly one name, by the engine's own pool rule", () => {
      // The pin: the fold is only right if each listed name, played as the
      // `names/<name>` pool, reaches the clips it came from. Membership is the
      // interpreter's `poolMemberPattern`, not a restatement of it — so a fold
      // that drifted from the engine fails here rather than going quiet in-game.
      const clips = [
        "voice/default/names/niklas.mp3",
        "voice/snoop/names/niklas-01.mp3",
        "voice/snoop/names/adam-01.mp3",
        "voice/snoop/names/adam-12.mp3",
        "voice/luca/names/r2d2.mp3",
        "voice/luca/names/abc-1.mp3",
        "voice/luca/names/abc-123.mp3",
      ];
      const listed = names(...clips);

      expect(listed).toEqual(["abc-1", "abc-123", "adam", "niklas", "r2d2"]);

      for (const clip of clips) {
        const owners = listed.filter((name) => poolMemberPattern("names", name).test(clip));

        expect(owners, `${clip} is reachable from exactly one listed name`).toHaveLength(1);
      }
    });
  });
});

describe("mergeManifests", () => {
  const builtIn: AudioAssetsManifest = {
    clips: ["sfx/IRD-tick-open.mp3", "voice/default/flags/blue-01.mp3"],
    ambientLoop: "sfx/IRD-ambient-pit.mp3",
    ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
  };

  it("returns the built-in manifest unchanged when there are no fragments", () => {
    expect(mergeManifests(builtIn, [])).toEqual(builtIn);
  });

  it("adds fragment clips and keeps the built-in special paths", () => {
    const merged = mergeManifests(builtIn, [["voice/luca/flags/blue-01.mp3"]]);

    expect(merged.clips).toContain("voice/luca/flags/blue-01.mp3");
    expect(merged.clips).toContain("voice/default/flags/blue-01.mp3");
    expect(merged.ambientLoop).toBe(builtIn.ambientLoop);
    expect(merged.ticks).toEqual(builtIn.ticks);
  });

  it("a pack cannot redefine the radio frame", () => {
    const merged = mergeManifests(builtIn, [["sfx/IRD-tick-open.mp3"]]);

    expect(merged.ticks.open).toBe("sfx/IRD-tick-open.mp3");
    expect(merged.ambientLoop).toBe("sfx/IRD-ambient-pit.mp3");
  });

  it("de-duplicates and sorts so the result is stable regardless of fragment order", () => {
    const a = mergeManifests(builtIn, [["voice/b/x.mp3"], ["voice/a/x.mp3", "voice/b/x.mp3"]]);
    const b = mergeManifests(builtIn, [["voice/a/x.mp3", "voice/b/x.mp3"], ["voice/b/x.mp3"]]);

    expect(a.clips).toEqual(b.clips);
    expect(a.clips.filter((c) => c === "voice/b/x.mp3")).toHaveLength(1);
    expect([...a.clips]).toEqual([...a.clips].sort());
  });

  it("does not mutate the built-in manifest", () => {
    const clips = [...builtIn.clips];
    mergeManifests(builtIn, [["voice/luca/flags/blue-01.mp3"]]);

    expect(builtIn.clips).toEqual(clips);
  });

  it("makes a pack's voice visible to the voice scanner", () => {
    const merged = mergeManifests(builtIn, [["voice/luca/flags/blue-01.mp3"]]);

    expect(scanRaceEngineerVoices(merged)).toEqual(["default", "luca"]);
  });
});
