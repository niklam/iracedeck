import { describe, expect, it } from "vitest";

import {
  dedupeDeclaredVoices,
  displayLabel,
  isSemverVersion,
  packId,
  packIdMatchesFolder,
  parseVoicePackManifest,
  readVoicePackManifestText,
  USABLE_VOICE_CLIP,
  validateVoicePackManifest,
  VOICE_PACK_MANIFEST_FILE,
  VOICE_PACK_MANIFEST_SCHEMA_VERSION,
  VOICE_PACK_NEWER_SCHEMA_REASON,
  VOICE_SCRIPT_MAX_BYTES,
  VoicePackManifestSchema,
} from "./voice-pack.js";

const luca = { id: "luca", label: "Luca" };

const valid = JSON.stringify({
  schema: 1,
  id: "luca",
  label: "Luca",
  version: "1.2.0",
  author: "iRaceDeck",
  voices: [luca],
});

/** A well-formed manifest object with one field replaced. */
const manifestWith = (overrides: Record<string, unknown>) =>
  JSON.stringify({ schema: 1, id: "a", label: "A", version: "1.0.0", voices: [{ id: "a", label: "A" }], ...overrides });

describe("isSemverVersion", () => {
  // Every verdict below is `semver.valid(v) !== null` under semver 7.8.5,
  // deck-core's pinned version — the predicate exists so the leaf can refuse
  // exactly what the scanner refused while depending on nothing but zod. The
  // agreement itself is pinned by deck-core's `voice-pack-semver-parity.test.ts`,
  // which runs both over these same inputs; this file records what the
  // verdicts ARE, so a change here is visible as a change.
  it.each([
    ["a release", "1.2.3"],
    ["a prerelease", "1.0.0-rc.1"],
    ["build metadata", "1.2.3+build.7"],
    ["a numeric prerelease id with a leading zero followed by a letter", "1.2.3-0a"],
    ["build metadata with a leading zero", "1.2.3+01"],
    ["one leading lowercase v", "v1.2.3"],
    ["surrounding spaces", " 1.2.3 "],
    ["a trailing newline", "1.2.3\n"],
    ["a leading no-break space", " 1.2.3"],
    ["a leading BOM", "﻿1.2.3"],
    ["a major at the safe-integer ceiling", "9007199254740991.0.0"],
    ["the longest input semver reads", `1.0.0+${"a".repeat(250)}`],
  ])("accepts %s", (_label, version) => {
    expect(isSemverVersion(version)).toBe(true);
  });

  it.each([
    ["a two-part version", "1.2"],
    ["a word", "one"],
    ["an empty string", ""],
    ["a leading zero in the major", "01.2.3"],
    ["a leading zero in a numeric prerelease id", "1.2.3-01"],
    ["an empty prerelease identifier", "1.2.3-a..b"],
    ["an uppercase V", "V1.2.3"],
    ["two leading vs", "vv1.2.3"],
    ["a leading equals sign", "=1.2.3"],
    ["a major past the safe-integer ceiling", "9007199254740992.0.0"],
    ["an input longer than 256 characters", `1.0.0+${"a".repeat(251)}`],
    // The length is checked BEFORE the trim, as semver checks it: padding a
    // valid version past the cap with whitespace is still refused.
    ["a 257-character input that would be valid once trimmed", `1.2.3${" ".repeat(252)}`],
  ])("refuses %s", (_label, version) => {
    expect(isSemverVersion(version)).toBe(false);
  });
});

describe("the format constants", () => {
  it("names the manifest file the scanner opens", () => {
    expect(VOICE_PACK_MANIFEST_FILE).toBe("voice-pack.json");
  });

  it("is version 1 of the manifest format, the one value the schema accepts", () => {
    expect(VOICE_PACK_MANIFEST_SCHEMA_VERSION).toBe(1);
    expect(VoicePackManifestSchema.shape.schema.safeParse(VOICE_PACK_MANIFEST_SCHEMA_VERSION).success).toBe(true);
    expect(VoicePackManifestSchema.shape.schema.safeParse(VOICE_PACK_MANIFEST_SCHEMA_VERSION + 1).success).toBe(false);
  });

  it("caps a script at a megabyte", () => {
    expect(VOICE_SCRIPT_MAX_BYTES).toBe(1024 * 1024);
  });

  it("reaches exactly voice/<voice>/<group>/<name>.mp3 with a lowercase extension", () => {
    expect(USABLE_VOICE_CLIP.test("voice/luca/flags/blue-01.mp3")).toBe(true);
    expect(USABLE_VOICE_CLIP.test("voice/luca/flags/blue.mp3")).toBe(true);
    // A missing group is one level short of anything a pool can match.
    expect(USABLE_VOICE_CLIP.test("voice/luca/sample.mp3")).toBe(false);
    // One level too deep is not a pool member either.
    expect(USABLE_VOICE_CLIP.test("voice/luca/flags/extra/blue-01.mp3")).toBe(false);
    // What plenty of Windows tools emit; the pool regex is case-sensitive.
    expect(USABLE_VOICE_CLIP.test("voice/luca/flags/blue-01.MP3")).toBe(false);
    expect(USABLE_VOICE_CLIP.test("sfx/tick.mp3")).toBe(false);
    expect(USABLE_VOICE_CLIP.test("voice/luca/flags/notes.txt")).toBe(false);
  });
});

describe("packId and displayLabel", () => {
  it("accepts kebab-case ids and refuses the rest", () => {
    expect(packId.safeParse("luca").success).toBe(true);
    expect(packId.safeParse("aaa-test-2").success).toBe(true);
    expect(packId.safeParse("Luca").success).toBe(false);
    expect(packId.safeParse("2luca").success).toBe(false);
    expect(packId.safeParse("").success).toBe(false);
  });

  it("names the separator, ahead of the kebab-case rule, for an id that carries it (#1144)", () => {
    const result = packId.safeParse("a::b");

    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues[0]?.message).toMatch(/^must not contain "::"/);
  });

  it("bounds a label at 60 characters with no control characters", () => {
    expect(displayLabel.safeParse("x".repeat(60)).success).toBe(true);
    expect(displayLabel.safeParse("x".repeat(61)).success).toBe(false);
    expect(displayLabel.safeParse("").success).toBe(false);
    expect(displayLabel.safeParse("two\nlines").success).toBe(false);
  });
});

describe("validateVoicePackManifest", () => {
  it("returns the parsed manifest for a well-formed document", () => {
    const result = validateVoicePackManifest(JSON.parse(valid));

    expect(result).toEqual({
      ok: true,
      manifest: { schema: 1, id: "luca", label: "Luca", version: "1.2.0", author: "iRaceDeck", voices: [luca] },
    });
  });

  it("reports EVERY problem, one line each, in the order the schema walks the document", () => {
    // The scanner shows the first; the linter shows them all. One walk serves
    // both, so the linter's list is exactly the scanner's reason and then the
    // rest, never a different reading of the same file.
    const result = validateVoicePackManifest({
      schema: 1,
      id: "Luca!",
      label: "x".repeat(61),
      version: "one",
      voices: [],
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems).toEqual([
      "id: must be lowercase kebab-case (a-z, 0-9, dashes)",
      "label: must be 60 characters or fewer",
      "version: must be a valid semver version",
      expect.stringMatching(/^voices: /),
    ]);
  });

  it("reports the first problem per field only — the one that names the fix", () => {
    // zod runs a string's checks without aborting at the first, so an id that
    // carries the separator fails the separator rule AND the kebab-case rule,
    // and an empty label fails both its minimum and its character rule. The
    // first of each is kept, in the schema's order: the separator's sentence,
    // because the schema checks it first.
    const json = { schema: 1, id: "My::Pack", label: "", version: "1.0.0", voices: [{ id: "a", label: "A" }] };

    // Positive control: zod really does report two issues at each field.
    const issues = VoicePackManifestSchema.safeParse(json).error?.issues ?? [];
    expect(issues.map((issue) => issue.path.join("."))).toEqual(["id", "id", "label", "label"]);

    expect(validateVoicePackManifest(json)).toEqual({
      ok: false,
      problems: [
        'id: must not contain "::" — iRaceDeck joins a pack id and a voice id with it',
        "label: Too small: expected string to have >=1 characters",
      ],
    });
  });

  it("keeps the first problem of each field apart, nested paths included", () => {
    const result = validateVoicePackManifest(
      JSON.parse(
        manifestWith({
          voices: [
            { id: "a::b", label: "A" },
            { id: "c::d", label: "C" },
          ],
        }),
      ),
    );

    expect(result.ok === false && result.problems).toEqual([
      expect.stringMatching(/^voices\.0\.id: must not contain "::"/),
      expect.stringMatching(/^voices\.1\.id: must not contain "::"/),
    ]);
  });

  it("reports a non-object document under (root)", () => {
    const result = validateVoicePackManifest("a string");

    expect(result.ok === false && result.problems).toEqual([expect.stringMatching(/^\(root\): /)]);
  });

  it("uses the newer-version sentence only for a schema number above 1", () => {
    const newer = validateVoicePackManifest(JSON.parse(manifestWith({ schema: 2 })));

    expect(newer.ok === false && newer.problems).toEqual([VOICE_PACK_NEWER_SCHEMA_REASON]);
    expect(VOICE_PACK_NEWER_SCHEMA_REASON).toContain("newer version of iRaceDeck");
    expect(VOICE_PACK_NEWER_SCHEMA_REASON).not.toContain("Invalid");
  });

  it.each([
    ["a missing schema", manifestWith({ schema: undefined })],
    ["a schema of 0", manifestWith({ schema: 0 })],
    ["a schema given as a string", manifestWith({ schema: "1" })],
    ["a schema of null", manifestWith({ schema: null })],
  ])("reports %s as an ordinary schema problem, not as a newer pack", (_label, raw) => {
    // An author who forgot the field, or typed it wrong, does not hold a pack
    // built by a newer toolchain — telling them to update the plugin would
    // send them away from the one line they need to fix.
    const result = validateVoicePackManifest(JSON.parse(raw));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems).toHaveLength(1);
    expect(result.ok === false && result.problems[0]).toMatch(/^schema: /);
    expect(result.ok === false && result.problems[0]).not.toContain("newer version");
  });
});

describe("readVoicePackManifestText", () => {
  it("returns the manifest and the parsed document for a well-formed text", () => {
    const result = readVoicePackManifestText(valid);

    expect(result).toEqual({ ok: true, manifest: JSON.parse(valid), json: JSON.parse(valid) });
  });

  it("strips a leading UTF-8 BOM before parsing", () => {
    // Written as an escape, not a literal BOM, for the reason the parse test below gives.
    expect(readVoicePackManifestText("﻿" + valid).ok).toBe(true);
  });

  it("reports text that is not JSON as one problem, with no document", () => {
    const result = readVoicePackManifestText("{");

    expect(result.ok).toBe(false);
    expect(result.json).toBeUndefined();
    expect(result.ok === false && result.problems).toEqual([expect.stringMatching(/^not valid JSON: /)]);
  });

  it("hands back the parsed document with the problems when the schema refuses it", () => {
    // What lets `lint:pack` still lint the voices a refused manifest names usably.
    const raw = manifestWith({ version: "one" });

    expect(readVoicePackManifestText(raw)).toEqual({
      ok: false,
      problems: ["version: must be a valid semver version"],
      json: JSON.parse(raw),
    });
  });

  it("reports exactly what validateVoicePackManifest reports for the same document", () => {
    const raw = JSON.stringify({ schema: 2, id: "A::b", label: "", voices: [] });
    const read = readVoicePackManifestText(raw);
    const validated = validateVoicePackManifest(JSON.parse(raw));

    expect(validated.ok).toBe(false);
    expect(read.ok === false && read.problems).toEqual(validated.ok === false && validated.problems);
  });
});

describe("parseVoicePackManifest", () => {
  it("reports text that is not JSON as its reason", () => {
    const result = parseVoicePackManifest("{");

    expect(result.ok === false && result.reason).toMatch(/^not valid JSON: /);
  });

  it("accepts a well-formed manifest", () => {
    const result = parseVoicePackManifest(valid);

    expect(result).toEqual({
      ok: true,
      manifest: { schema: 1, id: "luca", label: "Luca", version: "1.2.0", author: "iRaceDeck", voices: [luca] },
    });
  });

  it("is the schema the parse goes through", () => {
    expect(VoicePackManifestSchema.safeParse(JSON.parse(valid)).success).toBe(true);
    expect(VoicePackManifestSchema.safeParse(JSON.parse(manifestWith({ version: "one" }))).success).toBe(false);
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
    // valid JSON" as the only clue. deck-core's `settings-store.ts` strips one
    // for exactly the same reason.
    // Written as an escape, not a literal BOM: a literal one is invisible in a
    // diff and an editor could silently strip the very thing under test.
    const result = parseVoicePackManifest("﻿" + valid);

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
    expect(parseVoicePackManifest(manifestWith({ version: "1.0.0-rc.1" })).ok).toBe(true);
  });

  it("accepts a version with a leading v, as the scanner always has", () => {
    // Tightening this would refuse packs that install today; the linter now
    // agrees with the scanner instead of the other way round (#1134).
    expect(parseVoicePackManifest(manifestWith({ version: "v1.0.0" })).ok).toBe(true);
  });

  it.each([
    ["not json at all", "{nope"],
    ["a future schema version", manifestWith({ schema: 2 })],
    ["a missing schema", manifestWith({ schema: undefined })],
    ["a non-semver version", manifestWith({ version: "one" })],
    ["an id that is not kebab-case", manifestWith({ id: "Luca!" })],
    ["an empty label", manifestWith({ label: "" })],
    ["an empty voices list", manifestWith({ voices: [] })],
    ["a voice id that is not kebab-case", manifestWith({ voices: [{ id: "Nope", label: "A" }] })],
    // The three below are the shape change itself (#1034). A pack written
    // against the earlier `voices: ["luca"]` shape is refused rather than
    // half-read — and refused with `voices.0` in the reason, which is why the
    // schema literal stayed at 1: a bump would have said only "expected 2".
    ["a bare string where a voice entry belongs", manifestWith({ voices: ["a"] })],
    ["a voice with no label", manifestWith({ voices: [{ id: "a" }] })],
    ["a voice with an empty label", manifestWith({ voices: [{ id: "a", label: "" }] })],
    // Bounds set at the freeze: a label is a third party's string rendered
    // straight into a dropdown option and a settings row. Tightening after
    // packs ship would reject packs that already install.
    ["a label longer than 60 characters", manifestWith({ label: "x".repeat(61) })],
    ["a voice label containing a newline", manifestWith({ voices: [{ id: "a", label: "two\nlines" }] })],
  ])("rejects %s", (_label, raw) => {
    const result = parseVoicePackManifest(raw);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason.length).toBeGreaterThan(0);
  });

  describe("an id containing the voice-id separator (#1144)", () => {
    // Kebab-case already excludes `::`, so this is not a new rejection — it is
    // a better reason. An author who tried to qualify an id by hand is told
    // WHY the separator is refused, ahead of the general kebab-case message.
    it("refuses a pack id, naming the separator", () => {
      const result = parseVoicePackManifest(manifestWith({ id: "a::b" }));

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/^id: must not contain "::"/);
      expect(result.ok === false && result.reason).not.toContain("kebab-case");
    });

    it("refuses a voice id, naming the separator", () => {
      const result = parseVoicePackManifest(manifestWith({ voices: [{ id: "a::b", label: "A" }] }));

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/^voices\.0\.id: must not contain "::"/);
    });

    it("still gives the kebab-case reason for an id that is merely malformed", () => {
      const result = parseVoicePackManifest(manifestWith({ id: "Luca!" }));

      expect(result.ok === false && result.reason).toContain("kebab-case");
    });
  });

  it("names the offending field in the reason", () => {
    const result = parseVoicePackManifest(manifestWith({ version: "one" }));

    expect(result.ok === false && result.reason).toContain("version");
  });

  it("reports the FIRST problem only — the scanner's one line per refused pack", () => {
    const result = parseVoicePackManifest(manifestWith({ id: "Luca!", version: "one" }));

    expect(result.ok === false && result.reason).toMatch(/^id: /);
    expect(result.ok === false && result.reason).not.toContain("version");
  });

  it("tells a user to update the plugin when a pack is built for a newer schema", () => {
    // The whole payoff of `z.literal(1)`: refusing a newer pack LEGIBLY. Zod's
    // own text — "schema: Invalid input: expected 1" — says nothing about
    // needing a newer iRaceDeck to somebody holding a perfectly good pack.
    const result = parseVoicePackManifest(manifestWith({ schema: 2 }));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe(VOICE_PACK_NEWER_SCHEMA_REASON);
    expect(result.ok === false && result.reason).not.toContain("Invalid");
  });

  it("does NOT tell a user to update the plugin over a missing or malformed schema field (#1134)", () => {
    for (const raw of [manifestWith({ schema: undefined }), manifestWith({ schema: 0 })]) {
      const result = parseVoicePackManifest(raw);

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/^schema: /);
      expect(result.ok === false && result.reason).not.toContain("newer version");
    }
  });

  it("accepts a label at exactly the 60-character bound", () => {
    expect(parseVoicePackManifest(manifestWith({ voices: [{ id: "a", label: "x".repeat(60) }] })).ok).toBe(true);
  });

  it("points at the voice entry when a pack uses the earlier string shape", () => {
    // The diagnostic that keeping `schema: 1` buys: a hand-made pack written
    // against the old shape is told WHICH field moved.
    const result = parseVoicePackManifest(manifestWith({ voices: ["a"] }));

    expect(result.ok === false && result.reason).toContain("voices.0");
  });
});

describe("packIdMatchesFolder", () => {
  it("matches the folder name case-insensitively, since the filesystem underneath does", () => {
    expect(packIdMatchesFolder("luca", "luca")).toBe(true);
    expect(packIdMatchesFolder("luca", "Luca")).toBe(true);
    expect(packIdMatchesFolder("luca", "LUCA")).toBe(true);
  });

  it("refuses a folder that names a different pack", () => {
    expect(packIdMatchesFolder("luca", "renamed")).toBe(false);
    expect(packIdMatchesFolder("luca", "luca-2")).toBe(false);
  });
});

describe("dedupeDeclaredVoices", () => {
  it("keeps the first of two entries sharing an id and lists the dropped id", () => {
    const { voices, repeated } = dedupeDeclaredVoices([
      { id: "luca", label: "Luca" },
      { id: "matt", label: "Matt" },
      { id: "luca", label: "Luca again" },
    ]);

    expect(voices).toEqual([
      { id: "luca", label: "Luca" },
      { id: "matt", label: "Matt" },
    ]);
    expect(repeated).toEqual(["luca"]);
  });

  it("lists every dropped entry, in declaration order, once per repeat", () => {
    const { voices, repeated } = dedupeDeclaredVoices([
      { id: "a" },
      { id: "b" },
      { id: "a" },
      { id: "b" },
      { id: "a" },
    ]);

    expect(voices).toEqual([{ id: "a" }, { id: "b" }]);
    expect(repeated).toEqual(["a", "b", "a"]);
  });

  it("keys on the id, never the label", () => {
    // Two entries naming the same voice under different labels are one voice.
    const { voices } = dedupeDeclaredVoices([
      { id: "luca", label: "Luca" },
      { id: "luca", label: "Luca (radio)" },
    ]);

    expect(voices).toHaveLength(1);
    expect(voices[0].label).toBe("Luca");
  });

  it("returns a list with nothing repeated unchanged", () => {
    const input = [{ id: "a" }, { id: "b" }];

    expect(dedupeDeclaredVoices(input)).toEqual({ voices: input, repeated: [] });
  });
});
