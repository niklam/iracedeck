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
    // The label is presentation: it is not an id and no rule constrains it
    // beyond being non-empty. Naming a voice `AAA Test Voice` is the point of
    // the field (#1034) — the dropdown showed `titleCase(id)` before it existed.
    const voices = [{ id: "aaa-test", label: "AAA Test Voice" }];
    const raw = JSON.stringify({ schema: 1, id: "aaa-test", label: "Pack", version: "1.0.0", voices });
    const result = parseVoicePackManifest(raw);

    expect(result.ok && result.manifest.voices[0].label).toBe("AAA Test Voice");
  });

  it("keeps a skipped list without interpreting it", () => {
    const raw = JSON.stringify({
      schema: 1,
      id: "luca",
      label: "Luca",
      version: "1.0.0",
      voices: [luca],
      skipped: ["voice/luca/openers/hi.mp3"],
    });
    const result = parseVoicePackManifest(raw);

    expect(result.ok && result.manifest.skipped).toEqual(["voice/luca/openers/hi.mp3"]);
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

  it("points at the voice entry when a pack uses the earlier string shape", () => {
    // The diagnostic that keeping `schema: 1` buys: a hand-made pack written
    // against the old shape is told WHICH field moved.
    const raw = JSON.stringify({ schema: 1, id: "a", label: "A", version: "1.0.0", voices: ["a"] });
    const result = parseVoicePackManifest(raw);

    expect(result.ok === false && result.reason).toContain("voices.0");
  });
});
