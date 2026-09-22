import { describe, expect, it } from "vitest";

import { scanVoicePacks, VOICE_SCRIPT_MAX_BYTES, type VoicePackFileSystem } from "./voice-pack-scanner.js";

const ROOT = "/packs";
/** The development root (#1143) — deliberately no shared path segment with {@link ROOT}. */
const DEV_ROOT = "/dev/voice-packs";

/** A manifest that exists but cannot be opened — locked, EISDIR, permission denied. */
const UNREADABLE = Symbol("unreadable");

type FakePack = {
  manifest?: unknown;
  clips?: string[];
  install?: unknown;
  /**
   * Any other text file, by POSIX path relative to the pack folder — a voice's
   * `voice/<id>/callouts.json` (#1064). Absent means not on disk.
   */
  files?: Record<string, string | typeof UNREADABLE>;
};

/** POSIX form of a path the scanner built with `join`, without a trailing slash. */
function posix(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * A fake disk holding one pack tree PER ROOT (#1143): `listDirectories` answers
 * for the root it is asked about, and a file is resolved by the root its path
 * starts under, then by pack folder, then relative to that folder.
 */
function fakeFsAt(roots: Record<string, Record<string, FakePack>>): VoicePackFileSystem {
  const locate = (path: string): { tree: Record<string, FakePack>; parts: string[] } | undefined => {
    const normalised = posix(path);

    for (const [root, tree] of Object.entries(roots)) {
      if (normalised === root) return { tree, parts: [] };

      if (normalised.startsWith(`${root}/`)) return { tree, parts: normalised.slice(root.length + 1).split("/") };
    }

    return undefined;
  };

  return {
    listDirectories: (dir) => {
      const at = locate(dir);

      return at !== undefined && at.parts.length === 0 ? Object.keys(at.tree) : [];
    },
    readTextFile: (file) => {
      // Resolved RELATIVE TO THE PACK FOLDER, never by the file's parent
      // directory alone. The scanner reads three files per pack now — the
      // manifest and the install record at the root, and each voice's script
      // under `voice/<id>/` — and keying on the parent would answer a script
      // read with the manifest wherever a voice id equals its pack id, which
      // is the common case. A test would then pass against the wrong document.
      const at = locate(file);
      const entry = at?.tree[at.parts[0] ?? ""];
      const relative = at?.parts.slice(1).join("/") ?? "";
      const wanted =
        relative === "voice-pack.json"
          ? entry?.manifest
          : relative === ".install.json"
            ? entry?.install
            : entry?.files?.[relative];

      if (!entry || wanted === undefined) return { ok: false, missing: true, reason: "ENOENT" };

      if (wanted === UNREADABLE) return { ok: false, missing: false, reason: "EBUSY" };

      return { ok: true, text: typeof wanted === "string" ? wanted : JSON.stringify(wanted) };
    },
    listMp3Files: (packDir) => {
      const at = locate(packDir);

      return at?.tree[at.parts[0] ?? ""]?.clips ?? [];
    },
  };
}

/** The single-root fake every pre-#1143 test uses: `tree` sits under {@link ROOT}. */
function fakeFs(tree: Record<string, FakePack>): VoicePackFileSystem {
  return fakeFsAt({ [ROOT]: tree });
}

const luca = { schema: 1, id: "luca", label: "Luca", version: "1.2.0", voices: [{ id: "luca", label: "Luca" }] };

describe("scanVoicePacks", () => {
  it("returns nothing for a missing or empty root", () => {
    const result = scanVoicePacks({ root: ROOT, fs: fakeFs({}) });

    expect(result.packs).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("reads a pack and its clips", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({ luca: { manifest: luca, clips: ["voice/luca/flags/blue-01.mp3"] } }),
    });

    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]).toMatchObject({
      id: "luca",
      label: "Luca",
      version: "1.2.0",
      // The voice's identity outside the pack is `<pack>::<voice>` (#1144);
      // the bare declared id names its folder, and the clips keep that spelling.
      voices: [{ id: "luca::luca", packVoiceId: "luca", label: "Luca" }],
      clips: ["voice/luca/flags/blue-01.mp3"],
    });
    expect(result.packs[0].dir.replace(/\\/g, "/")).toBe("/packs/luca");
  });

  it("reports a folder with no voice-pack.json instead of throwing", () => {
    const result = scanVoicePacks({ root: ROOT, fs: fakeFs({ junk: { clips: [] } }) });

    expect(result.packs).toEqual([]);
    expect(result.problems).toEqual([{ pack: "junk", reason: "no voice-pack.json" }]);
  });

  it("distinguishes a manifest it could not READ from one that is not there", () => {
    // Locked by a sync client or AV, permission-denied, or a DIRECTORY of that
    // name. Reporting these as "no voice-pack.json" points the user at the one
    // paragraph of the docs that cannot help them — the file is right there.
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({ luca: { manifest: UNREADABLE, clips: ["voice/luca/flags/a.mp3"] } }),
    });

    expect(result.packs).toEqual([]);
    expect(result.problems).toEqual([{ pack: "luca", reason: "voice-pack.json could not be read (EBUSY)" }]);
  });

  it("reports a malformed manifest and keeps scanning the others", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({
        broken: { manifest: "{nope", clips: [] },
        luca: { manifest: luca, clips: ["voice/luca/flags/blue-01.mp3"] },
      }),
    });

    expect(result.packs.map((p) => p.id)).toEqual(["luca"]);
    expect(result.problems[0].pack).toBe("broken");
  });

  it("keeps only clips under a declared voice", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({
        luca: {
          manifest: luca,
          clips: ["voice/luca/flags/blue-01.mp3", "voice/other/flags/blue-01.mp3", "notes.mp3"],
        },
      }),
    });

    expect(result.packs[0].clips).toEqual(["voice/luca/flags/blue-01.mp3"]);
  });

  it("drops a pack whose clips are all outside its declared voices", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({ luca: { manifest: luca, clips: ["voice/other/flags/blue-01.mp3"] } }),
    });

    expect(result.packs).toEqual([]);
    expect(result.problems[0].reason).toContain("no clips");
  });

  it("ignores a pack whose folder name does not match its declared id", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({ renamed: { manifest: luca, clips: ["voice/luca/flags/blue-01.mp3"] } }),
    });

    expect(result.packs).toEqual([]);
    expect(result.problems[0].reason).toContain("does not match");
  });

  it("refuses a manifest whose id carries the voice-id separator, naming the separator (#1144)", () => {
    // The manifest is parsed before the folder-name check, so the reason a
    // user reads is the separator's, not "does not match its folder name".
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({ "a::b": { manifest: { ...luca, id: "a::b" }, clips: ["voice/luca/flags/blue-01.mp3"] } }),
    });

    expect(result.packs).toEqual([]);
    expect(result.problems).toEqual([{ pack: "a::b", reason: expect.stringMatching(/^id: must not contain "::"/) }]);
  });

  it("accepts a pack whose folder differs from its id only by case", () => {
    // Windows is the only platform the manifests declare, and there `Luca` and
    // `luca` are ONE directory — the manifest was already read through the
    // capitalised path. Refusing this would reject a working pack over a
    // distinction the filesystem does not make, with a message that reads as
    // satisfied to whoever is looking at the folder.
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({ Luca: { manifest: luca, clips: ["voice/luca/flags/blue-01.mp3"] } }),
    });

    expect(result.problems).toEqual([]);
    expect(result.packs.map((p) => p.id)).toEqual(["luca"]);
    expect(result.packs[0].dir.replace(/\\/g, "/")).toBe("/packs/Luca");
  });

  it("lists a voice two packs both declare under each pack's composite id (#1144)", () => {
    // Before #1144 the first pack by sorted id claimed the voice and the other
    // was muted with a problem row. Now a voice id is unique within a pack
    // only: both are listed, both keep their clips, and nothing is reported.
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({
        zeta: { manifest: { ...luca, id: "zeta" }, clips: ["voice/luca/flags/blue-01.mp3"] },
        alpha: { manifest: { ...luca, id: "alpha" }, clips: ["voice/luca/flags/blue-01.mp3"] },
      }),
    });

    expect(result.problems).toEqual([]);
    expect(result.packs.map((p) => p.id)).toEqual(["alpha", "zeta"]);
    expect(result.packs.map((p) => p.voices.map((v) => v.id))).toEqual([["alpha::luca"], ["zeta::luca"]]);
    expect(result.packs.map((p) => p.voices.map((v) => v.packVoiceId))).toEqual([["luca"], ["luca"]]);
    expect(result.packs.map((p) => p.clips)).toEqual([
      ["voice/luca/flags/blue-01.mp3"],
      ["voice/luca/flags/blue-01.mp3"],
    ]);
  });

  it("lists a sideloaded pack declaring `default` beside the managed pack, neither displacing the other", () => {
    // The case `priorityPacks` existed for (#1034 stage 3): a sideload sorting
    // before `default` used to take the `default` VOICE id off the pack the
    // plugin keeps current. With composite ids there is nothing to take.
    const aaa = { schema: 1, id: "aaa", label: "Aaa", version: "1.0.0", voices: [{ id: "default", label: "Mine" }] };
    const dflt = {
      schema: 1,
      id: "default",
      label: "Default",
      version: "1.0.0",
      voices: [{ id: "default", label: "Default" }],
    };
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({
        aaa: { manifest: aaa, clips: ["voice/default/flags/blue-01.mp3"] },
        default: { manifest: dflt, clips: ["voice/default/flags/blue-01.mp3"] },
      }),
    });

    expect(result.problems).toEqual([]);
    expect(result.packs.flatMap((p) => p.voices.map((v) => v.id))).toEqual(["aaa::default", "default::default"]);
  });

  it("is deterministic regardless of directory-listing order", () => {
    const forward = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({
        alpha: { manifest: { ...luca, id: "alpha" }, clips: ["voice/luca/flags/a.mp3"] },
        zeta: { manifest: { ...luca, id: "zeta" }, clips: ["voice/luca/flags/a.mp3"] },
      }),
    });
    const reversed = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({
        zeta: { manifest: { ...luca, id: "zeta" }, clips: ["voice/luca/flags/a.mp3"] },
        alpha: { manifest: { ...luca, id: "alpha" }, clips: ["voice/luca/flags/a.mp3"] },
      }),
    });

    expect(forward.packs.map((p) => p.id)).toEqual(reversed.packs.map((p) => p.id));
  });

  it("keeps every voice of a pack that shares one id with another pack", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({
        alpha: {
          manifest: { ...luca, id: "alpha", voices: [{ id: "luca", label: "Luca" }] },
          clips: ["voice/luca/flags/a.mp3"],
        },
        beta: {
          manifest: {
            ...luca,
            id: "beta",
            voices: [
              { id: "luca", label: "Luca" },
              { id: "nina", label: "Nina" },
            ],
          },
          clips: ["voice/luca/flags/a.mp3", "voice/nina/flags/a.mp3"],
        },
      }),
    });

    expect(result.packs.map((p) => p.id)).toEqual(["alpha", "beta"]);
    expect(result.packs[1].voices.map((v) => v.id)).toEqual(["beta::luca", "beta::nina"]);
    expect(result.packs[1].clips).toEqual(["voice/luca/flags/a.mp3", "voice/nina/flags/a.mp3"]);
  });

  it("skips the installer's own reserved folders", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({ ".tmp": { clips: [] }, ".trash": { clips: [] } }),
    });

    expect(result.packs).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("does not list a declared voice it ships no clips for", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({
        // `alpha` declares nina but ships only luca: its nina is dropped with a
        // reason, and `beta`'s nina is its own voice either way.
        alpha: {
          manifest: {
            ...luca,
            id: "alpha",
            voices: [
              { id: "luca", label: "Luca" },
              { id: "nina", label: "Nina" },
            ],
          },
          clips: ["voice/luca/flags/a.mp3"],
        },
        beta: {
          manifest: { ...luca, id: "beta", voices: [{ id: "nina", label: "Nina" }] },
          clips: ["voice/nina/flags/a.mp3"],
        },
      }),
    });

    expect(result.packs.map((p) => p.id)).toEqual(["alpha", "beta"]);
    expect(result.packs[0].voices.map((v) => v.id)).toEqual(["alpha::luca"]);
    expect(result.packs[1].voices.map((v) => v.id)).toEqual(["beta::nina"]);
    expect(result.problems).toEqual([{ pack: "alpha", reason: "no clips found under voice/nina/" }]);
  });

  describe("a voice must ship clips the ENGINE can reach, not merely files", () => {
    // The gate used to be `startsWith("voice/<id>/")`, which is looser than the
    // grammar `buildManifestPool` compiles. A pack failing either rule below
    // installed cleanly, reached the dropdown, and then played nothing at all,
    // with the only trace a debug line at fire time.

    it("refuses a voice whose clips carry an uppercase extension", () => {
      // `listMp3Files` matches `.mp3` case-insensitively and records the name
      // verbatim; the pool regex and the clipSet lookup are case-SENSITIVE.
      // `.MP3` is what plenty of Windows tools emit.
      const result = scanVoicePacks({
        root: ROOT,
        fs: fakeFs({ luca: { manifest: luca, clips: ["voice/luca/flags/blue-01.MP3"] } }),
      });

      expect(result.packs).toEqual([]);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0].reason).toContain("lowercase .mp3");
    });

    it("refuses a voice whose clips have no group segment", () => {
      const result = scanVoicePacks({
        root: ROOT,
        fs: fakeFs({ luca: { manifest: luca, clips: ["voice/luca/sample.mp3"] } }),
      });

      expect(result.packs).toEqual([]);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0].reason).toContain("<group>");
    });

    it("drops only the pack with unreachable clips; another pack's voice of the same id is unaffected", () => {
      const result = scanVoicePacks({
        root: ROOT,
        fs: fakeFs({
          alpha: {
            manifest: { ...luca, id: "alpha", voices: [{ id: "luca", label: "Luca" }] },
            clips: ["voice/luca/blue.MP3"],
          },
          beta: {
            manifest: { ...luca, id: "beta", voices: [{ id: "luca", label: "Luca" }] },
            clips: ["voice/luca/flags/blue-01.mp3"],
          },
        }),
      });

      expect(result.packs.map((p) => p.id)).toEqual(["beta"]);
      expect(result.packs[0].voices.map((v) => v.id)).toEqual(["beta::luca"]);
    });

    it("keeps the reachable clips and drops only the unreachable ones", () => {
      const result = scanVoicePacks({
        root: ROOT,
        fs: fakeFs({
          luca: { manifest: luca, clips: ["voice/luca/flags/blue-01.mp3", "voice/luca/stray.mp3"] },
        }),
      });

      expect(result.packs[0].clips).toEqual(["voice/luca/flags/blue-01.mp3"]);
      expect(result.problems).toEqual([]);
    });
  });

  it("reports a repeated voice id rather than silently keeping the first", () => {
    // The only malformation that used to produce no diagnostic anywhere. More
    // likely now that a voice carries a label, since two entries differing only
    // by label look like two distinct things to whoever wrote them.
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({
        luca: {
          manifest: {
            ...luca,
            voices: [
              { id: "luca", label: "Luca" },
              { id: "luca", label: "Luca (short)" },
            ],
          },
          clips: ["voice/luca/flags/a.mp3"],
        },
      }),
    });

    expect(result.packs[0].voices).toEqual([{ id: "luca::luca", packVoiceId: "luca", label: "Luca", script: null }]);
    expect(result.problems).toEqual([
      { pack: "luca", reason: 'voice "luca" is declared more than once; the first wins' },
    ]);
  });

  it("de-duplicates a voice id repeated in one manifest", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({
        luca: {
          manifest: {
            ...luca,
            voices: [
              { id: "luca", label: "Luca" },
              { id: "luca", label: "Luca" },
            ],
          },
          clips: ["voice/luca/flags/a.mp3"],
        },
      }),
    });

    expect(result.packs[0].voices.map((v) => v.id)).toEqual(["luca::luca"]);
    expect(result.packs[0].clips).toEqual(["voice/luca/flags/a.mp3"]);
  });

  it("carries the author through when present", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({ luca: { manifest: { ...luca, author: "Someone" }, clips: ["voice/luca/flags/a.mp3"] } }),
    });

    expect(result.packs[0].author).toBe("Someone");
  });
});

describe("scanVoicePacks reports where a pack came from (#1100)", () => {
  const record = (source: string) => ({
    schema: 1,
    source,
    id: "luca",
    version: "1.2.0",
    sha256: "e".repeat(64),
    installedAt: "2026-09-02T00:00:00.000Z",
    ...(source === "catalog" ? { url: "https://example.com/luca-1.2.0.zip" } : {}),
  });

  const scan = (install?: unknown) =>
    scanVoicePacks({
      root: ROOT,
      fs: fakeFs({ luca: { manifest: luca, install, clips: ["voice/luca/flags/blue-01.mp3"] } }),
    });

  it.each([
    ["catalog", "catalog"],
    ["bundled-seed", "bundled-seed"],
  ])("reports a %s install from the record we wrote", (source, expected) => {
    expect(scan(record(source)).packs[0].provenance).toBe(expected);
  });

  it("lists a bundled-seed pack as an ordinary pack, voices and clips included", () => {
    // Until #1144 a seed whose voices the plugin bundled was listed providing
    // nothing. No plugin bundles a voice any more and nothing is reserved, so
    // the record decides the badge and nothing else: the pack is heard.
    const result = scan(record("bundled-seed"));

    expect(result.problems).toEqual([]);
    expect(result.packs[0]).toMatchObject({
      id: "luca",
      voices: [{ id: "luca::luca", packVoiceId: "luca" }],
      clips: ["voice/luca/flags/blue-01.mp3"],
      provenance: "bundled-seed",
    });
  });

  // A record has to name THIS pack. The installer's hash read already requires
  // it; this path did not, so a folder copied or
  // renamed by hand kept its old `.install.json` and rendered as "Downloaded"
  // for a pack never downloaded under that id — the provenance badge lying in
  // the one place it exists to tell the truth.
  it("reports sideload when the record names a different pack", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({
        luca: {
          manifest: luca,
          install: { ...record("catalog"), id: "someone-else" },
          clips: ["voice/luca/flags/a.mp3"],
        },
      }),
    });

    expect(result.packs[0].provenance).toBe("sideload");
  });

  // "sideload" is the ABSENCE of a usable record, never a claim a pack makes —
  // which is why the source enum has no such value for anyone to write. A pack
  // that forges a record cannot describe itself as sideloaded, and one whose
  // record is unusable reads as sideloaded, which is the truthful answer.
  it.each([
    ["no record at all", undefined],
    ["a record that does not parse", "{ not json"],
    ["a record that cannot be read", UNREADABLE],
    ["a record naming an unknown source", JSON.stringify({ ...record("catalog"), source: "sideload" })],
  ])("reports sideload for %s", (_label, install) => {
    expect(scan(install).packs[0].provenance).toBe("sideload");
  });
});

describe("scanVoicePacks reads a voice's callouts.json beside its clips (#1064)", () => {
  const SCRIPT_PATH = "voice/luca/callouts.json";
  const script = {
    schema: 1,
    scenarios: { "flag-green": { sequence: ["pool:flag-green"] } },
    frames: {},
    pools: {},
  };

  const scan = (files?: FakePack["files"], overrides: Partial<FakePack> = {}) =>
    scanVoicePacks({
      root: ROOT,
      fs: fakeFs({ luca: { manifest: luca, clips: ["voice/luca/flags/blue-01.mp3"], files, ...overrides } }),
    });

  it("carries the parsed script on the voice", () => {
    const result = scan({ [SCRIPT_PATH]: JSON.stringify(script) });

    expect(result.problems).toEqual([]);
    expect(result.packs[0].voices).toEqual([{ id: "luca::luca", packVoiceId: "luca", label: "Luca", script }]);
  });

  it("lists a voice with no script file as clips-only, with no problem", () => {
    // The spec's "no script file at all → a clips-only voice": valid, and its
    // callouts are all skipped downstream. Not a problem, because a pack built
    // for the format before scripts existed is exactly this shape.
    const result = scan();

    expect(result.problems).toEqual([]);
    expect(result.packs[0].voices).toEqual([{ id: "luca::luca", packVoiceId: "luca", label: "Luca", script: null }]);
    expect(result.packs[0].clips).toEqual(["voice/luca/flags/blue-01.mp3"]);
  });

  it("strips a UTF-8 BOM before parsing, as the manifest reader does", () => {
    // `JSON.parse` throws on a BOM and several Windows editors write one. The
    // manifest reader strips it for the same reason; the script must not be
    // stricter than the manifest about the same accident.
    const result = scan({ [SCRIPT_PATH]: String.fromCharCode(0xfeff) + JSON.stringify(script) });

    expect(result.problems).toEqual([]);
    expect(result.packs[0].voices[0].script).toEqual(script);
  });

  describe("a malformed script drops THE VOICE, exactly as no usable clips does", () => {
    it("drops a voice whose script is not valid JSON, naming the file", () => {
      const result = scan({ [SCRIPT_PATH]: "{nope" });

      expect(result.packs).toEqual([]);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0].pack).toBe("luca");
      // The grammar's own problem follows — a JSON failure is reported under
      // the document prefix like any other root problem, with the parser's
      // message: an author hand-editing the file gets the position, not just
      // a verdict.
      expect(result.problems[0].reason).toMatch(/^voice "luca": callouts\.json \(document\): not valid JSON: \S/);
    });

    it("drops a voice whose script is nested too deeply to read, and never throws", () => {
      // A thousand nested `optional`s once took the grammar past the call
      // stack. The scan runs where a throw ends the plugin; a sideloaded pack
      // can put any document it likes on disk.
      let step: unknown = "pool:flag-green";

      for (let i = 0; i < 1000; i++) step = { optional: [step] };

      const deep = JSON.stringify({ ...script, scenarios: { "flag-green": { sequence: [step] } } });
      const result = scanVoicePacks({
        root: ROOT,
        fs: fakeFs({
          deep: {
            manifest: { ...luca, id: "deep" },
            clips: ["voice/luca/flags/a.mp3"],
            files: { [SCRIPT_PATH]: deep },
          },
          nina: {
            manifest: { ...luca, id: "nina", voices: [{ id: "nina", label: "Nina" }] },
            clips: ["voice/nina/flags/a.mp3"],
            files: { "voice/nina/callouts.json": JSON.stringify(script) },
          },
        }),
      });

      expect(result.packs.map((p) => p.id)).toEqual(["nina"]);
      expect(result.problems).toEqual([
        { pack: "deep", reason: 'voice "luca": callouts.json (document): the script is nested too deeply to read' },
      ]);
    });

    it("drops a voice whose script is larger than the cap, before the grammar sees it", () => {
      // Padding inside a string keeps the document valid JSON: the size
      // check is what refuses it, not the parser.
      const padded = JSON.stringify({ ...script, frames: {}, pools: {}, comment: "x".repeat(VOICE_SCRIPT_MAX_BYTES) });
      const result = scan({ [SCRIPT_PATH]: padded });

      expect(padded.length).toBeGreaterThan(VOICE_SCRIPT_MAX_BYTES);
      expect(result.packs).toEqual([]);
      expect(result.problems).toEqual([
        { pack: "luca", reason: `voice "luca": callouts.json is larger than ${VOICE_SCRIPT_MAX_BYTES} bytes` },
      ]);
    });

    it("reads a script exactly at the cap", () => {
      const room = VOICE_SCRIPT_MAX_BYTES - JSON.stringify({ ...script, comment: "" }).length;
      const exact = JSON.stringify({ ...script, comment: "x".repeat(room) });

      expect(exact.length).toBe(VOICE_SCRIPT_MAX_BYTES);
      // `comment` is not a top-level key the grammar knows, so the verdict is
      // the grammar's — which proves the text reached it.
      expect(scan({ [SCRIPT_PATH]: exact }).problems).toEqual([
        { pack: "luca", reason: 'voice "luca": callouts.json comment: unrecognized key' },
      ]);
    });

    it("reports a port that throws as this voice's problem rather than ending the scan", () => {
      const throwing: VoicePackFileSystem = {
        ...fakeFs({ luca: { manifest: luca, clips: ["voice/luca/flags/blue-01.mp3"] } }),
        readTextFile(file) {
          if (file.replace(/\\/g, "/").endsWith(SCRIPT_PATH)) throw new Error("boom");

          return { ok: true, text: JSON.stringify(luca) };
        },
      };

      const result = scanVoicePacks({ root: ROOT, fs: throwing });

      expect(result.packs).toEqual([]);
      expect(result.problems).toEqual([
        { pack: "luca", reason: 'voice "luca": callouts.json could not be read (boom)' },
      ]);
    });

    it("drops a voice whose script fails the schema, naming the path the parser reports", () => {
      const result = scan({
        [SCRIPT_PATH]: JSON.stringify({
          ...script,
          scenarios: { "flag-green": { sequence: ["pool:flag-green", 42] } },
        }),
      });

      expect(result.packs).toEqual([]);
      expect(result.problems).toEqual([
        {
          pack: "luca",
          reason: expect.stringMatching(/^voice "luca": callouts\.json scenarios\.flag-green\.sequence\[1\]: /),
        },
      ]);
    });

    it("reports the FIRST schema problem only — one line per dropped voice", () => {
      // Two bad steps produce two parser problems. The Installed Voices list
      // gets one line per voice; the rest is for the author to find once the
      // first is fixed, the same way the manifest reader reports.
      const result = scan({
        [SCRIPT_PATH]: JSON.stringify({ ...script, scenarios: { "flag-green": { sequence: [42, 43] } } }),
      });

      expect(result.problems).toHaveLength(1);
      expect(result.problems[0].reason).toContain("sequence[0]");
      expect(result.problems[0].reason).not.toContain("sequence[1]");
    });

    it("drops a voice whose script cannot be READ, distinguishing that from no file", () => {
      // Locked by a sync client, permission-denied, or a directory of that
      // name. A voice with a script it cannot open is not a clips-only voice;
      // listing it as one would silently mute every callout the author wrote.
      const result = scan({ [SCRIPT_PATH]: UNREADABLE });

      expect(result.packs).toEqual([]);
      expect(result.problems).toEqual([
        { pack: "luca", reason: 'voice "luca": callouts.json could not be read (EBUSY)' },
      ]);
    });

    it("drops only the pack whose script is broken; another pack's voice of the same id is unaffected", () => {
      const result = scanVoicePacks({
        root: ROOT,
        fs: fakeFs({
          alpha: {
            manifest: { ...luca, id: "alpha" },
            clips: ["voice/luca/flags/a.mp3"],
            files: { [SCRIPT_PATH]: "{nope" },
          },
          beta: { manifest: { ...luca, id: "beta" }, clips: ["voice/luca/flags/b.mp3"] },
        }),
      });

      expect(result.packs.map((p) => p.id)).toEqual(["beta"]);
      expect(result.packs[0].voices).toEqual([{ id: "beta::luca", packVoiceId: "luca", label: "Luca", script: null }]);
      expect(result.problems.map((p) => p.pack)).toEqual(["alpha"]);
    });

    it("keeps a pack's other voice, and only that voice's clips", () => {
      const result = scanVoicePacks({
        root: ROOT,
        fs: fakeFs({
          duo: {
            manifest: {
              ...luca,
              id: "duo",
              voices: [
                { id: "luca", label: "Luca" },
                { id: "nina", label: "Nina" },
              ],
            },
            clips: ["voice/luca/flags/a.mp3", "voice/nina/flags/a.mp3"],
            files: { [SCRIPT_PATH]: "{nope", "voice/nina/callouts.json": JSON.stringify(script) },
          },
        }),
      });

      expect(result.packs[0].voices).toEqual([{ id: "duo::nina", packVoiceId: "nina", label: "Nina", script }]);
      expect(result.packs[0].clips).toEqual(["voice/nina/flags/a.mp3"]);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0].reason).toMatch(/^voice "luca": callouts\.json /);
    });
  });

  it("checks clips before the script, so a voice with nothing to play reports that alone", () => {
    // Ordering, pinned: the clip gate comes first. A voice that fails it is
    // already dropped, and a second line about its script would tell the
    // author to fix a file for a voice that has nothing to play anyway.
    const result = scan({ [SCRIPT_PATH]: "{nope" }, { clips: [] });

    expect(result.packs).toEqual([]);
    expect(result.problems).toEqual([{ pack: "luca", reason: "no clips found under voice/luca/" }]);
  });
});

describe("development root (#1143)", () => {
  const dflt = {
    schema: 1,
    id: "default",
    label: "Default",
    version: "3.3.0",
    voices: [{ id: "default", label: "Default" }],
  };
  const catalogRecord = {
    schema: 1,
    source: "catalog",
    id: "default",
    version: "3.3.0",
    sha256: "c".repeat(64),
    installedAt: "2026-09-08T00:00:00.000Z",
    url: "https://example.com/default-3.3.0.zip",
  };
  const clips = ["voice/default/flags/blue-01.mp3"];

  it("lists a pack found under devRoot with provenance development, whatever its record says", () => {
    // The dev copy carries a catalog `.install.json` naming itself — the
    // packer's staged output, or a folder copied from AppData. Provenance is
    // decided by WHERE the pack was found, never read from a record there.
    const result = scanVoicePacks({
      root: ROOT,
      devRoot: DEV_ROOT,
      fs: fakeFsAt({ [DEV_ROOT]: { default: { manifest: dflt, install: catalogRecord, clips } }, [ROOT]: {} }),
    });

    expect(result.problems).toEqual([]);
    expect(result.packs).toHaveLength(1);

    const pack = result.packs.find((p) => p.id === "default");

    expect(pack?.provenance).toBe("development");
    expect(pack?.voices.map((v) => v.id)).toEqual(["default::default"]);
    expect(pack?.dir.replace(/\\/g, "/")).toBe(`${DEV_ROOT}/default`);
  });

  it("shadows the same pack id under root with one pack-level problem", () => {
    const result = scanVoicePacks({
      root: ROOT,
      devRoot: DEV_ROOT,
      fs: fakeFsAt({
        [DEV_ROOT]: { default: { manifest: dflt, clips } },
        [ROOT]: { default: { manifest: dflt, install: catalogRecord, clips } },
      }),
    });

    expect(result.packs.filter((p) => p.id === "default")).toHaveLength(1);
    expect(result.packs[0]?.provenance).toBe("development");
    expect(result.packs[0]?.dir.replace(/\\/g, "/")).toBe(`${DEV_ROOT}/default`);
    // The PACK is shadowed, not each of its voices in turn: one id, one row,
    // one reason. A per-voice reason here would read as nonsense — "pack
    // default already provides it" about the pack called default — and said
    // nothing about the row the user is looking at.
    expect(result.problems).toEqual([
      {
        pack: "default",
        reason: 'pack "default" is provided by the development build; the copy under the packs root is ignored',
      },
    ]);
  });

  it("shadows the whole root pack, including voices the dev copy does not provide", () => {
    // The real regression: the root copy survived by declaring a voice the dev
    // copy had not claimed, giving TWO `packs` rows with the same id — and
    // every consumer of this list is keyed by id, so which of them a lookup
    // found came down to array order.
    const devA = { schema: 1, id: "default", label: "Default", version: "3.3.0", voices: [{ id: "a", label: "A" }] };
    const rootAB = {
      schema: 1,
      id: "default",
      label: "Default",
      version: "3.3.0",
      voices: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    };
    const result = scanVoicePacks({
      root: ROOT,
      devRoot: DEV_ROOT,
      fs: fakeFsAt({
        [DEV_ROOT]: { default: { manifest: devA, clips: ["voice/a/flags/blue-01.mp3"] } },
        [ROOT]: {
          default: {
            manifest: rootAB,
            install: catalogRecord,
            clips: ["voice/a/flags/blue-01.mp3", "voice/b/flags/blue-01.mp3"],
          },
        },
      }),
    });

    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]?.provenance).toBe("development");
    expect(result.packs[0]?.voices.map((v) => v.id)).toEqual(["default::a"]);
    expect(result.problems).toEqual([
      {
        pack: "default",
        reason: 'pack "default" is provided by the development build; the copy under the packs root is ignored',
      },
    ]);
  });

  it("lists a DIFFERENT pack id under root even when it declares the same voice as a dev pack (#1144)", () => {
    // The shadowing rule is about one PACK id existing under both roots. A
    // voice id shared between two different packs is two voices, as it is
    // between two packs under one root.
    const mine = { schema: 1, id: "mine", label: "Mine", version: "1.0.0", voices: [{ id: "default", label: "Mine" }] };
    const result = scanVoicePacks({
      root: ROOT,
      devRoot: DEV_ROOT,
      fs: fakeFsAt({
        [DEV_ROOT]: { default: { manifest: dflt, clips } },
        [ROOT]: { mine: { manifest: mine, clips } },
      }),
    });

    expect(result.problems).toEqual([]);
    expect(result.packs.map((p) => [p.id, p.provenance])).toEqual([
      ["default", "development"],
      ["mine", "sideload"],
    ]);
    expect(result.packs.flatMap((p) => p.voices.map((v) => v.id))).toEqual(["default::default", "mine::default"]);
  });

  it("does not shadow a root pack whose id only a SKIPPED dev folder carries", () => {
    // The dev folder is listed by the OS but was never listed as a pack — no
    // manifest. Shadowing on folder name alone would silence the AppData copy
    // in favour of nothing at all.
    const result = scanVoicePacks({
      root: ROOT,
      devRoot: DEV_ROOT,
      fs: fakeFsAt({
        [DEV_ROOT]: { default: { clips } },
        [ROOT]: { default: { manifest: dflt, clips } },
      }),
    });

    expect(result.packs.map((p) => [p.id, p.provenance])).toEqual([["default", "sideload"]]);
    expect(result.problems.map((p) => p.reason)).toEqual(["no voice-pack.json"]);
  });

  it("matches the shadowed folder name case-insensitively", () => {
    const result = scanVoicePacks({
      root: ROOT,
      devRoot: DEV_ROOT,
      fs: fakeFsAt({
        [DEV_ROOT]: { default: { manifest: dflt, clips } },
        [ROOT]: { Default: { manifest: dflt, install: catalogRecord, clips } },
      }),
    });

    expect(result.packs).toHaveLength(1);
    expect(result.problems).toEqual([
      {
        pack: "Default",
        reason: 'pack "Default" is provided by the development build; the copy under the packs root is ignored',
      },
    ]);
  });

  it("falls back to the root pack when the dev copy is unusable", () => {
    // A staged folder with no manifest yet — the packer was interrupted, or
    // the folder is empty. It lists nothing, so the AppData pack is heard.
    const result = scanVoicePacks({
      root: ROOT,
      devRoot: DEV_ROOT,
      fs: fakeFsAt({
        [DEV_ROOT]: { default: { clips } },
        [ROOT]: { default: { manifest: dflt, clips } },
      }),
    });

    expect(result.packs.map((p) => [p.id, p.provenance])).toEqual([["default", "sideload"]]);
    expect(result.problems.map((p) => p.reason)).toContain("no voice-pack.json");
  });

  it("behaves exactly as before when devRoot is absent", () => {
    // Same disk, no dev root: the AppData pack is listed with its record's
    // provenance, and nothing under the development directory is even listed.
    const fs = fakeFsAt({
      [DEV_ROOT]: { default: { manifest: dflt, clips } },
      [ROOT]: { default: { manifest: dflt, install: catalogRecord, clips } },
    });
    const result = scanVoicePacks({ root: ROOT, fs });

    expect(result.problems).toEqual([]);
    expect(result.packs.map((p) => [p.id, p.provenance])).toEqual([["default", "catalog"]]);
    expect(result.packs[0]?.dir.replace(/\\/g, "/")).toBe(`${ROOT}/default`);
  });
});
