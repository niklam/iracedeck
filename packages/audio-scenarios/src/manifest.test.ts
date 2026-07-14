import { describe, expect, it } from "vitest";

import {
  type AudioAssetsManifest,
  manifestVoices,
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
});
