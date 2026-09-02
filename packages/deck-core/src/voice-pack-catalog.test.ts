import { describe, expect, it } from "vitest";

import { isVoicePackOfferable, parseVoicePackCatalog, type VoicePackCatalogEntry } from "./voice-pack-catalog.js";

const SHA = "a".repeat(64);

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "luca",
    label: "Luca",
    version: "1.2.0",
    voices: [{ id: "luca", label: "Luca" }],
    bytes: 13107200,
    sha256: SHA,
    url: "https://github.com/niklam/iRaceDeck/releases/download/voices-luca-1.2.0/luca-1.2.0.zip",
    ...overrides,
  };
}

function catalog(packs: unknown[]): Record<string, unknown> {
  return { schema: 1, packs };
}

describe("parseVoicePackCatalog", () => {
  it("reads a well-formed catalog", () => {
    const parsed = parseVoicePackCatalog(catalog([entry()]));

    expect(parsed).toHaveLength(1);
    expect(parsed?.[0].id).toBe("luca");
    expect(parsed?.[0].sha256).toBe(SHA);
  });

  it("keeps an optional description and minPluginVersion", () => {
    const parsed = parseVoicePackCatalog(
      catalog([entry({ description: "Calm, understated.", minPluginVersion: "3.2.0" })]),
    );

    expect(parsed?.[0].description).toBe("Calm, understated.");
    expect(parsed?.[0].minPluginVersion).toBe("3.2.0");
  });

  // The asymmetry that distinguishes this from parsePublishedChangelog. One bad
  // entry must not take every other pack offline — including the one the user
  // is trying to install right now.
  it("drops a malformed entry and keeps the rest", () => {
    const parsed = parseVoicePackCatalog(catalog([entry({ id: "luca" }), { id: "broken" }, entry({ id: "vixen" })]));

    expect(parsed?.map((p) => p.id)).toEqual(["luca", "vixen"]);
  });

  it.each([
    ["a non-object body", "nope"],
    ["a missing packs array", { schema: 1 }],
    ["packs that is not an array", { schema: 1, packs: {} }],
    ["an unknown schema version", { schema: 2, packs: [] }],
  ])("refuses %s", (_label, body) => {
    expect(parseVoicePackCatalog(body)).toBeUndefined();
  });

  it("accepts an empty catalog as a real answer", () => {
    expect(parseVoicePackCatalog(catalog([]))).toEqual([]);
  });

  it("ignores unknown fields so a new one cannot break an older plugin", () => {
    const parsed = parseVoicePackCatalog(catalog([entry({ futureField: { nested: true } })]));

    expect(parsed).toHaveLength(1);
  });

  it.each([
    ["an http url", { url: "http://example.com/luca.zip" }],
    ["a file url", { url: "file:///C:/luca.zip" }],
    ["a url that does not parse", { url: "not a url" }],
    ["an uppercase digest", { sha256: "A".repeat(64) }],
    ["a truncated digest", { sha256: "abc" }],
    ["a non-semver version", { version: "one point two" }],
    ["a non-kebab id", { id: "Luca" }],
    ["zero bytes", { bytes: 0 }],
    ["no voices", { voices: [] }],
  ])("drops an entry with %s", (_label, overrides) => {
    expect(parseVoicePackCatalog(catalog([entry(overrides)]))).toEqual([]);
  });

  it("keeps the first of two entries claiming one id", () => {
    const parsed = parseVoicePackCatalog(catalog([entry({ version: "1.0.0" }), entry({ version: "2.0.0" })]));

    expect(parsed).toHaveLength(1);
    expect(parsed?.[0].version).toBe("1.0.0");
  });
});

describe("isVoicePackOfferable", () => {
  const offer = (minPluginVersion?: string) =>
    parseVoicePackCatalog(catalog([entry(minPluginVersion ? { minPluginVersion } : {})]))?.[0] as VoicePackCatalogEntry;

  it("offers a pack that states no requirement", () => {
    expect(isVoicePackOfferable(offer(), "3.2.0")).toBe(true);
  });

  it("offers a pack whose requirement is exactly met", () => {
    expect(isVoicePackOfferable(offer("3.2.0"), "3.2.0")).toBe(true);
  });

  it("offers a pack to a newer plugin", () => {
    expect(isVoicePackOfferable(offer("3.2.0"), "3.5.1")).toBe(true);
  });

  it("does not offer a pack that needs a newer plugin", () => {
    expect(isVoicePackOfferable(offer("3.3.0"), "3.2.0")).toBe(false);
  });

  // With no way to establish the requirement is met, the honest answer is no.
  it("does not offer when the running version cannot be read", () => {
    expect(isVoicePackOfferable(offer("3.3.0"), "not-a-version")).toBe(false);
  });

  it("still offers an unconditional pack when the running version cannot be read", () => {
    expect(isVoicePackOfferable(offer(), "not-a-version")).toBe(true);
  });

  // A pre-release build is cut FROM the line it names and carries that line's
  // capabilities, so it is treated as having reached it. Strict semver ordering
  // says otherwise, which would make a pack requiring 3.2.0 unavailable on
  // every dev and RC build of 3.2.0 — including the version this repo is on.
  it.each([
    ["a dev build of the required version", "3.2.0-dev.0"],
    ["an rc build of the required version", "3.2.0-rc.1"],
    ["a dev build of a later version", "3.3.0-dev.2"],
  ])("offers a pack requiring 3.2.0 to %s", (_label, running) => {
    expect(isVoicePackOfferable(offer("3.2.0"), running)).toBe(true);
  });

  // The permissiveness stops at the version boundary: a pre-release of an
  // EARLIER line has not reached the requirement and is still refused.
  it("does not offer a pack requiring 3.2.0 to a dev build of 3.1.0", () => {
    expect(isVoicePackOfferable(offer("3.2.0"), "3.1.0-dev.4")).toBe(false);
  });
});
