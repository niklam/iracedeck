import { describe, expect, it } from "vitest";

import { parseVoicePackManifest } from "./voice-pack-manifest.js";

const luca = { id: "luca", label: "Luca" };

const valid = JSON.stringify({
  schema: 1,
  id: "luca",
  label: "Luca",
  version: "1.2.0",
  author: "iRaceDeck",
  voices: [luca],
});

describe("parseVoicePackManifest", () => {
  it("accepts a well-formed manifest", () => {
    const result = parseVoicePackManifest(valid);

    expect(result).toEqual({
      ok: true,
      manifest: { schema: 1, id: "luca", label: "Luca", version: "1.2.0", author: "iRaceDeck", voices: [luca] },
    });
  });

  it("accepts a pack declaring several voices", () => {
    const voices = [
      { id: "a", label: "Ay" },
      { id: "b", label: "Bee" },
    ];
    const raw = JSON.stringify({ schema: 1, id: "duo", label: "Duo", version: "1.0.0", voices });
    const result = parseVoicePackManifest(raw);

    expect(result.ok && result.manifest.voices).toEqual(voices);
  });

  it("keeps a voice's label as written, including spaces and capitals", () => {
    // The label is presentation, not an id: spaces and capitals are the point
    // of the field (#1034), since the dropdown showed `titleCase(id)` before it
    // existed. It is bounded — length and control characters, below — but
    // nothing about its CONTENT is constrained the way an id's is.
    const voices = [{ id: "aaa-test", label: "AAA Test Voice" }];
    const raw = JSON.stringify({ schema: 1, id: "aaa-test", label: "Pack", version: "1.0.0", voices });
    const result = parseVoicePackManifest(raw);

    expect(result.ok && result.manifest.voices[0].label).toBe("AAA Test Voice");
  });

  it("accepts a manifest saved with a UTF-8 BOM", () => {
    // Hand-editing this file on Windows is the advertised install path, and
    // several Windows editors write a BOM. `JSON.parse` throws on one, so
    // without this a pack correct in every visible way is refused with "not
    // valid JSON" as the only clue. `settings-store.ts` strips one for exactly
    // the same reason.
    // Written as an escape, not a literal BOM: a literal one is invisible in a
    // diff and an editor could silently strip the very thing under test.
    const result = parseVoicePackManifest("\ufeff" + valid);

    expect(result.ok).toBe(true);
    expect(result.ok && result.manifest.id).toBe("luca");
  });

  it("ignores an unknown field rather than refusing the pack", () => {
    // `skipped` used to be reserved here for #1033. #1064's design moved
    // skipping into each voice's own script file, so the pack-level field was
    // removed before it shipped — and a pack that still carries one must load,
    // not be rejected over a field nothing reads.
    const raw = JSON.stringify({
      schema: 1,
      id: "luca",
      label: "Luca",
      version: "1.0.0",
      voices: [luca],
      skipped: ["voice/luca/openers/hi.mp3"],
    });
    const result = parseVoicePackManifest(raw);

    expect(result.ok).toBe(true);
    expect(result.ok && "skipped" in result.manifest).toBe(false);
  });

  it("accepts a prerelease version", () => {
    const raw = JSON.stringify({
      schema: 1,
      id: "a",
      label: "A",
      version: "1.0.0-rc.1",
      voices: [{ id: "a", label: "A" }],
    });

    expect(parseVoicePackManifest(raw).ok).toBe(true);
  });

  it.each([
    ["not json at all", "{nope"],
    [
      "a future schema version",
      JSON.stringify({ schema: 2, id: "a", label: "A", version: "1.0.0", voices: [{ id: "a", label: "A" }] }),
    ],
    ["a missing schema", JSON.stringify({ id: "a", label: "A", version: "1.0.0", voices: [{ id: "a", label: "A" }] })],
    [
      "a non-semver version",
      JSON.stringify({ schema: 1, id: "a", label: "A", version: "one", voices: [{ id: "a", label: "A" }] }),
    ],
    [
      "an id that is not kebab-case",
      JSON.stringify({ schema: 1, id: "Luca!", label: "A", version: "1.0.0", voices: [{ id: "a", label: "A" }] }),
    ],
    [
      "an empty label",
      JSON.stringify({ schema: 1, id: "a", label: "", version: "1.0.0", voices: [{ id: "a", label: "A" }] }),
    ],
    ["an empty voices list", JSON.stringify({ schema: 1, id: "a", label: "A", version: "1.0.0", voices: [] })],
    [
      "a voice id that is not kebab-case",
      JSON.stringify({ schema: 1, id: "a", label: "A", version: "1.0.0", voices: [{ id: "Nope", label: "A" }] }),
    ],
    // The three below are the shape change itself (#1034). A pack written
    // against the earlier `voices: ["luca"]` shape is refused rather than
    // half-read — and refused with `voices.0` in the reason, which is why the
    // schema literal stayed at 1: a bump would have said only "expected 2".
    [
      "a bare string where a voice entry belongs",
      JSON.stringify({ schema: 1, id: "a", label: "A", version: "1.0.0", voices: ["a"] }),
    ],
    [
      "a voice with no label",
      JSON.stringify({ schema: 1, id: "a", label: "A", version: "1.0.0", voices: [{ id: "a" }] }),
    ],
    [
      "a voice with an empty label",
      JSON.stringify({ schema: 1, id: "a", label: "A", version: "1.0.0", voices: [{ id: "a", label: "" }] }),
    ],
    // Bounds set at the freeze: a label is a third party's string rendered
    // straight into a dropdown option and a settings row. Tightening after
    // packs ship would reject packs that already install.
    [
      "a label longer than 60 characters",
      JSON.stringify({
        schema: 1,
        id: "a",
        label: "x".repeat(61),
        version: "1.0.0",
        voices: [{ id: "a", label: "A" }],
      }),
    ],
    [
      "a voice label containing a newline",
      JSON.stringify({ schema: 1, id: "a", label: "A", version: "1.0.0", voices: [{ id: "a", label: "two\nlines" }] }),
    ],
  ])("rejects %s", (_label, raw) => {
    const result = parseVoicePackManifest(raw);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason.length).toBeGreaterThan(0);
  });

  it("names the offending field in the reason", () => {
    const raw = JSON.stringify({ schema: 1, id: "a", label: "A", version: "one", voices: [{ id: "a", label: "A" }] });
    const result = parseVoicePackManifest(raw);

    expect(result.ok === false && result.reason).toContain("version");
  });

  it("tells a user to update the plugin when a pack is built for a newer schema", () => {
    // The whole payoff of `z.literal(1)`: refusing a newer pack LEGIBLY. Zod's
    // own text — "schema: Invalid literal value, expected 1" — says nothing
    // about needing a newer iRaceDeck to somebody holding a perfectly good pack.
    const raw = JSON.stringify({ schema: 2, id: "a", label: "A", version: "1.0.0", voices: [{ id: "a", label: "A" }] });
    const result = parseVoicePackManifest(raw);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("newer version of iRaceDeck");
    expect(result.ok === false && result.reason).not.toContain("Invalid literal");
  });

  it("accepts a label at exactly the 60-character bound", () => {
    const raw = JSON.stringify({
      schema: 1,
      id: "a",
      label: "A",
      version: "1.0.0",
      voices: [{ id: "a", label: "x".repeat(60) }],
    });

    expect(parseVoicePackManifest(raw).ok).toBe(true);
  });

  it("points at the voice entry when a pack uses the earlier string shape", () => {
    // The diagnostic that keeping `schema: 1` buys: a hand-made pack written
    // against the old shape is told WHICH field moved.
    const raw = JSON.stringify({ schema: 1, id: "a", label: "A", version: "1.0.0", voices: ["a"] });
    const result = parseVoicePackManifest(raw);

    expect(result.ok === false && result.reason).toContain("voices.0");
  });
});
