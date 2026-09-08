import { describe, expect, it } from "vitest";

import { voiceDisplayLabels } from "./voice-labels.js";
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
    const result = scanVoicePacks({ root: ROOT, reservedVoices: [], fs: fakeFs({}) });

    expect(result.packs).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("reads a pack and its clips", () => {
    const result = scanVoicePacks({
      root: ROOT,
      reservedVoices: [],
      fs: fakeFs({ luca: { manifest: luca, clips: ["voice/luca/flags/blue-01.mp3"] } }),
    });

    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]).toMatchObject({
      id: "luca",
      label: "Luca",
      version: "1.2.0",
      voices: [{ id: "luca", label: "Luca" }],
      clips: ["voice/luca/flags/blue-01.mp3"],
    });
    expect(result.packs[0].dir.replace(/\\/g, "/")).toBe("/packs/luca");
  });

  it("reports a folder with no voice-pack.json instead of throwing", () => {
    const result = scanVoicePacks({ root: ROOT, reservedVoices: [], fs: fakeFs({ junk: { clips: [] } }) });

    expect(result.packs).toEqual([]);
    expect(result.problems).toEqual([{ pack: "junk", reason: "no voice-pack.json" }]);
  });

  it("distinguishes a manifest it could not READ from one that is not there", () => {
    // Locked by a sync client or AV, permission-denied, or a DIRECTORY of that
    // name. Reporting these as "no voice-pack.json" points the user at the one
    // paragraph of the docs that cannot help them — the file is right there.
    const result = scanVoicePacks({
      root: ROOT,
      reservedVoices: [],
      fs: fakeFs({ luca: { manifest: UNREADABLE, clips: ["voice/luca/flags/a.mp3"] } }),
    });

    expect(result.packs).toEqual([]);
    expect(result.problems).toEqual([{ pack: "luca", reason: "voice-pack.json could not be read (EBUSY)" }]);
  });

  it("reports a malformed manifest and keeps scanning the others", () => {
    const result = scanVoicePacks({
      root: ROOT,
      reservedVoices: [],
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
      reservedVoices: [],
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
      reservedVoices: [],
      fs: fakeFs({ luca: { manifest: luca, clips: ["voice/other/flags/blue-01.mp3"] } }),
    });

    expect(result.packs).toEqual([]);
    expect(result.problems[0].reason).toContain("no clips");
  });

  it("ignores a pack whose folder name does not match its declared id", () => {
    const result = scanVoicePacks({
      root: ROOT,
      reservedVoices: [],
      fs: fakeFs({ renamed: { manifest: luca, clips: ["voice/luca/flags/blue-01.mp3"] } }),
    });

    expect(result.packs).toEqual([]);
    expect(result.problems[0].reason).toContain("does not match");
  });

  it("accepts a pack whose folder differs from its id only by case", () => {
    // Windows is the only platform the manifests declare, and there `Luca` and
    // `luca` are ONE directory — the manifest was already read through the
    // capitalised path. Refusing this would reject a working pack over a
    // distinction the filesystem does not make, with a message that reads as
    // satisfied to whoever is looking at the folder.
    const result = scanVoicePacks({
      root: ROOT,
      reservedVoices: [],
      fs: fakeFs({ Luca: { manifest: luca, clips: ["voice/luca/flags/blue-01.mp3"] } }),
    });

    expect(result.problems).toEqual([]);
    expect(result.packs.map((p) => p.id)).toEqual(["luca"]);
    expect(result.packs[0].dir.replace(/\\/g, "/")).toBe("/packs/Luca");
  });

  it("resolves a voice claimed by two packs to the first by sorted pack id, and reports the loser", () => {
    const result = scanVoicePacks({
      root: ROOT,
      reservedVoices: [],
      fs: fakeFs({
        zeta: { manifest: { ...luca, id: "zeta" }, clips: ["voice/luca/flags/blue-01.mp3"] },
        alpha: { manifest: { ...luca, id: "alpha" }, clips: ["voice/luca/flags/blue-01.mp3"] },
      }),
    });

    expect(result.packs.map((p) => p.id)).toEqual(["alpha"]);
    expect(result.problems).toEqual([{ pack: "zeta", reason: 'voice "luca" is already provided by pack "alpha"' }]);
  });

  describe("priorityPacks (#1034 stage 3)", () => {
    const aaa = { schema: 1, id: "aaa", label: "Aaa", version: "1.0.0", voices: [{ id: "default", label: "Mine" }] };
    const dflt = {
      schema: 1,
      id: "default",
      label: "Default",
      version: "1.0.0",
      voices: [{ id: "default", label: "Default" }],
    };
    const tree = {
      aaa: { manifest: aaa, clips: ["voice/default/flags/blue-01.mp3"] },
      default: { manifest: dflt, clips: ["voice/default/flags/blue-01.mp3"] },
    };

    it("lets the named packs claim their voices before the alphabetical order does", () => {
      // With nothing reserved, a sideloaded `aaa` sorts before `default` and
      // would take the `default` VOICE id off the pack the plugin keeps
      // current — the managed pack claims first.
      const result = scanVoicePacks({ root: ROOT, reservedVoices: [], priorityPacks: ["default"], fs: fakeFs(tree) });

      expect(result.packs.map((p) => p.id)).toEqual(["default"]);
      expect(result.problems).toEqual([
        { pack: "aaa", reason: 'voice "default" is already provided by pack "default"' },
      ]);
    });

    it("keeps the alphabetical order without it", () => {
      const result = scanVoicePacks({ root: ROOT, reservedVoices: [], fs: fakeFs(tree) });

      expect(result.packs.map((p) => p.id)).toEqual(["aaa"]);
      expect(result.problems).toEqual([
        { pack: "default", reason: 'voice "default" is already provided by pack "aaa"' },
      ]);
    });

    it("skips a priority pack that is not on disk, and matches the folder case-insensitively like the id rule", () => {
      const result = scanVoicePacks({
        root: ROOT,
        reservedVoices: [],
        priorityPacks: ["missing", "default"],
        // Both capitalised, so the plain sort still puts `Aaa` first and the
        // priority is what decides.
        fs: fakeFs({ Aaa: tree.aaa, Default: tree.default }),
      });

      expect(result.packs.map((p) => p.id)).toEqual(["default"]);
      expect(result.problems).toEqual([
        { pack: "Aaa", reason: 'voice "default" is already provided by pack "Default"' },
      ]);
    });
  });

  it("is deterministic regardless of directory-listing order", () => {
    const forward = scanVoicePacks({
      root: ROOT,
      reservedVoices: [],
      fs: fakeFs({
        alpha: { manifest: { ...luca, id: "alpha" }, clips: ["voice/luca/flags/a.mp3"] },
        zeta: { manifest: { ...luca, id: "zeta" }, clips: ["voice/luca/flags/a.mp3"] },
      }),
    });
    const reversed = scanVoicePacks({
      root: ROOT,
      reservedVoices: [],
      fs: fakeFs({
        zeta: { manifest: { ...luca, id: "zeta" }, clips: ["voice/luca/flags/a.mp3"] },
        alpha: { manifest: { ...luca, id: "alpha" }, clips: ["voice/luca/flags/a.mp3"] },
      }),
    });

    expect(forward.packs.map((p) => p.id)).toEqual(reversed.packs.map((p) => p.id));
  });

  it("keeps a pack's second voice when only its first collides", () => {
    const result = scanVoicePacks({
      root: ROOT,
      reservedVoices: [],
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
    expect(result.packs[1].voices.map((v) => v.id)).toEqual(["nina"]);
    expect(result.packs[1].clips).toEqual(["voice/nina/flags/a.mp3"]);
  });

  it("skips the installer's own reserved folders", () => {
    const result = scanVoicePacks({
      root: ROOT,
      reservedVoices: [],
      fs: fakeFs({ ".tmp": { clips: [] }, ".trash": { clips: [] } }),
    });

    expect(result.packs).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("refuses a voice the plugin's own bundled audio provides", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({ luca: { manifest: luca, clips: ["voice/luca/flags/a.mp3"] } }),
      reservedVoices: ["luca"],
    });

    expect(result.packs).toEqual([]);
    expect(result.problems[0].reason).toContain("bundled audio");
  });

  it("keeps a pack's other voice when only one collides with a bundled voice", () => {
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
        },
      }),
      reservedVoices: ["luca"],
    });

    expect(result.packs[0].voices.map((v) => v.id)).toEqual(["nina"]);
    expect(result.packs[0].clips).toEqual(["voice/nina/flags/a.mp3"]);
  });

  it("does not claim a declared voice it ships no clips for", () => {
    const result = scanVoicePacks({
      root: ROOT,
      reservedVoices: [],
      fs: fakeFs({
        // `alpha` declares nina but ships only luca; `beta` really has nina and
        // must not be locked out by alpha's empty declaration.
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
    expect(result.packs[0].voices.map((v) => v.id)).toEqual(["luca"]);
    expect(result.packs[1].voices.map((v) => v.id)).toEqual(["nina"]);
    expect(result.problems).toEqual([{ pack: "alpha", reason: "no clips found under voice/nina/" }]);
  });

  describe("a voice must ship clips the ENGINE can reach, not merely files", () => {
    // The gate used to be `startsWith("voice/<id>/")`, which is looser than the
    // grammar `buildManifestPool` compiles. A pack failing either rule below
    // installed cleanly, claimed its voice — locking out a pack that had it
    // properly — reached the dropdown, and then played nothing at all, with the
    // only trace a debug line at fire time.

    it("refuses a voice whose clips carry an uppercase extension", () => {
      // `listMp3Files` matches `.mp3` case-insensitively and records the name
      // verbatim; the pool regex and the clipSet lookup are case-SENSITIVE.
      // `.MP3` is what plenty of Windows tools emit.
      const result = scanVoicePacks({
        root: ROOT,
        reservedVoices: [],
        fs: fakeFs({ luca: { manifest: luca, clips: ["voice/luca/flags/blue-01.MP3"] } }),
      });

      expect(result.packs).toEqual([]);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0].reason).toContain("lowercase .mp3");
    });

    it("refuses a voice whose clips have no group segment", () => {
      const result = scanVoicePacks({
        root: ROOT,
        reservedVoices: [],
        fs: fakeFs({ luca: { manifest: luca, clips: ["voice/luca/sample.mp3"] } }),
      });

      expect(result.packs).toEqual([]);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0].reason).toContain("<group>");
    });

    it("does not lock the voice out of a later pack that ships it properly", () => {
      const result = scanVoicePacks({
        root: ROOT,
        reservedVoices: [],
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
      expect(result.packs[0].voices.map((v) => v.id)).toEqual(["luca"]);
    });

    it("keeps the reachable clips and drops only the unreachable ones", () => {
      const result = scanVoicePacks({
        root: ROOT,
        reservedVoices: [],
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
      reservedVoices: [],
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

    expect(result.packs[0].voices).toEqual([{ id: "luca", label: "Luca", script: null }]);
    expect(result.problems).toEqual([
      { pack: "luca", reason: 'voice "luca" is declared more than once; the first wins' },
    ]);
  });

  it("de-duplicates a voice id repeated in one manifest", () => {
    const result = scanVoicePacks({
      root: ROOT,
      reservedVoices: [],
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

    expect(result.packs[0].voices.map((v) => v.id)).toEqual(["luca"]);
    expect(result.packs[0].clips).toEqual(["voice/luca/flags/a.mp3"]);
  });

  it("carries the author through when present", () => {
    const result = scanVoicePacks({
      root: ROOT,
      reservedVoices: [],
      fs: fakeFs({ luca: { manifest: { ...luca, author: "Someone" }, clips: ["voice/luca/flags/a.mp3"] } }),
    });

    expect(result.packs[0].author).toBe("Someone");
  });
});

describe("scanVoicePacks and the bundled seed (#1100)", () => {
  const seedRecord = {
    schema: 1,
    source: "bundled-seed",
    id: "default",
    version: "3.2.0",
    sha256: "d".repeat(64),
    installedAt: "2026-09-02T00:00:00.000Z",
  };

  const bundled = {
    schema: 1,
    id: "default",
    label: "Default",
    version: "3.2.0",
    voices: [{ id: "default", label: "Default" }],
  };

  const scan = (install?: unknown) =>
    scanVoicePacks({
      root: ROOT,
      reservedVoices: ["default"],
      fs: fakeFs({ default: { manifest: bundled, install, clips: ["voice/default/flags/blue-01.mp3"] } }),
    });

  it("lists the pack we seeded from the plugin's own bundle, providing nothing", () => {
    const result = scan(seedRecord);

    // LISTED since #1100. It is on disk, and a card reading "No voice packs
    // installed" beside a button that opens a folder containing exactly this
    // pack was a contradiction the user met on their first screen. Its voice is
    // still dropped — the bundle owns that id, and that was never in question —
    // so it is listed as providing nothing, which is what `voices` means.
    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]).toMatchObject({
      id: "default",
      label: "Default",
      version: "3.2.0",
      voices: [],
      clips: [],
      provenance: "bundled-seed",
    });
    // The point of the exemption: no report, because nothing is wrong.
    expect(result.problems).toEqual([]);
  });

  // THE TRAP, pinned rather than left to be noticed later (#1100).
  //
  // `default` is ALREADY in the voice dropdown, provided by the plugin's own
  // audio. Listing the seeded pack must not also register its voice, or the
  // dropdown gains a SECOND "Default": two rows, one voice, and nothing for the
  // user to tell them apart. Listing a pack and contributing a voice are two
  // different jobs and this pack must only do the first.
  //
  // Asserted against BOTH publishers' actual inputs rather than against the
  // scanner's output shape alone, because they derive differently and a change
  // could break one without the other: `_voiceLabels` is built by
  // `voiceDisplayLabels` from the installed packs — which now include this one,
  // where they did not before — and `_raceEngineerVoices` is built from the
  // clip paths packs contribute to the merged manifest.
  it("contributes nothing to either published voice list", () => {
    const result = scan(seedRecord);

    // `_voiceLabels`: the seed is in this input now and must add no entry. A
    // `default` key here would rename the bundled voice in the dropdown.
    expect(voiceDisplayLabels(result.packs)).toEqual({});

    // `_raceEngineerVoices`: derived from the clips packs contribute. One clip
    // under `voice/default/` would put a second `default` in the list.
    expect(result.packs.flatMap((pack) => pack.clips)).toEqual([]);
  });

  // The id-match rule added for the provenance badge must not reach this row.
  // It does not even apply: the seeded branch hardcodes `bundled-seed` after
  // `isBundledSeed` has already required the record to name this pack. Pinned
  // because a regression here turns "Built-in" into "Installed by hand" on
  // every machine, which is the badge lying in the opposite direction.
  it("still reports the seed as bundled-seed, not sideload", () => {
    expect(scan(seedRecord).packs[0].provenance).toBe("bundled-seed");
  });

  // The branch fires only when the BUNDLE took every voice (#1100). A seed
  // whose voice another pack already claimed has a real problem, and must not
  // render as a healthy "Built-in" row with its own problem line underneath —
  // shown as fine and broken at once. Not reachable for `default` while it is
  // reserved, but it is exactly the state the branch is carried into once the
  // plugin stops bundling audio.
  it("does not list a seed as built-in when another pack took its voice", () => {
    const result = scanVoicePacks({
      root: ROOT,
      reservedVoices: [],
      fs: fakeFs({
        alpha: {
          manifest: {
            schema: 1,
            id: "alpha",
            label: "Alpha",
            version: "1.0.0",
            voices: [{ id: "shared", label: "Shared" }],
          },
          clips: ["voice/shared/flags/a.mp3"],
        },
        default: {
          manifest: { ...bundled, voices: [{ id: "shared", label: "Shared" }] },
          install: seedRecord,
          clips: ["voice/shared/flags/a.mp3"],
        },
      }),
    });

    expect(result.packs.map((pack) => pack.id)).toEqual(["alpha"]);
    expect(result.problems).toEqual([
      { pack: "default", reason: `voice "shared" is already provided by pack "alpha"` },
    ]);
  });

  // The hostile cases, and the reason the exemption is written as narrowly as
  // it is. Each must keep reporting; if a later change widens the branch into
  // "any pack with an .install.json may claim a bundled voice", one of these
  // fails rather than the behaviour quietly going missing.
  it.each([
    ["no provenance at all — an ordinary sideloaded pack", undefined],
    ["a catalog install rather than a seed", { ...seedRecord, source: "catalog", url: "https://example.com/x.zip" }],
    ["a seed record naming a different pack", { ...seedRecord, id: "luca" }],
    ["a provenance file that does not parse", "{ not json"],
    ["a provenance file that cannot be read", UNREADABLE],
    ["a record with no source at all", { ...seedRecord, source: undefined }],
  ])("still reports a pack claiming a bundled voice with %s", (_label, install) => {
    const result = scan(install);

    expect(result.packs).toEqual([]);
    expect(result.problems).toEqual([
      { pack: "default", reason: `voice "default" is provided by the plugin's bundled audio` },
    ]);
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
      reservedVoices: [],
      fs: fakeFs({ luca: { manifest: luca, install, clips: ["voice/luca/flags/blue-01.mp3"] } }),
    });

  it.each([
    ["catalog", "catalog"],
    ["bundled-seed", "bundled-seed"],
  ])("reports a %s install from the record we wrote", (source, expected) => {
    expect(scan(record(source)).packs[0].provenance).toBe(expected);
  });

  // A record has to name THIS pack. `isBundledSeed` and the installer's hash
  // read both already require it; this path did not, so a folder copied or
  // renamed by hand kept its old `.install.json` and rendered as "Downloaded"
  // for a pack never downloaded under that id — the provenance badge lying in
  // the one place it exists to tell the truth.
  it("reports sideload when the record names a different pack", () => {
    const result = scanVoicePacks({
      root: ROOT,
      reservedVoices: [],
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
      reservedVoices: [],
      fs: fakeFs({ luca: { manifest: luca, clips: ["voice/luca/flags/blue-01.mp3"], files, ...overrides } }),
    });

  it("carries the parsed script on the voice", () => {
    const result = scan({ [SCRIPT_PATH]: JSON.stringify(script) });

    expect(result.problems).toEqual([]);
    expect(result.packs[0].voices).toEqual([{ id: "luca", label: "Luca", script }]);
  });

  it("lists a voice with no script file as clips-only, with no problem", () => {
    // The spec's "no script file at all → a clips-only voice": valid, and its
    // callouts are all skipped downstream. Not a problem, because a pack built
    // for the format before scripts existed is exactly this shape.
    const result = scan();

    expect(result.problems).toEqual([]);
    expect(result.packs[0].voices).toEqual([{ id: "luca", label: "Luca", script: null }]);
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
        reservedVoices: [],
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

      const result = scanVoicePacks({ root: ROOT, reservedVoices: [], fs: throwing });

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

    it("does not claim the voice, so a later pack that ships it properly still can", () => {
      const result = scanVoicePacks({
        root: ROOT,
        reservedVoices: [],
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
      expect(result.packs[0].voices).toEqual([{ id: "luca", label: "Luca", script: null }]);
      expect(result.problems.map((p) => p.pack)).toEqual(["alpha"]);
    });

    it("keeps a pack's other voice, and only that voice's clips", () => {
      const result = scanVoicePacks({
        root: ROOT,
        reservedVoices: [],
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

      expect(result.packs[0].voices).toEqual([{ id: "nina", label: "Nina", script }]);
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

  it("leaves the bundled seed's listing untouched", () => {
    // The seeded copy of the bundled pack carries its script too — it rides
    // the voice tree — but the seed's voices are dropped to the bundle BEFORE
    // the per-voice loop, so the script is never read and can never surface
    // as a problem on a row that is listed as providing nothing.
    const result = scanVoicePacks({
      root: ROOT,
      reservedVoices: ["default"],
      fs: fakeFs({
        default: {
          manifest: {
            schema: 1,
            id: "default",
            label: "Default",
            version: "3.2.0",
            voices: [{ id: "default", label: "Default" }],
          },
          install: {
            schema: 1,
            source: "bundled-seed",
            id: "default",
            version: "3.2.0",
            sha256: "d".repeat(64),
            installedAt: "2026-09-02T00:00:00.000Z",
          },
          clips: ["voice/default/flags/blue-01.mp3"],
          files: { "voice/default/callouts.json": "{nope" },
        },
      }),
    });

    expect(result.problems).toEqual([]);
    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]).toMatchObject({ id: "default", voices: [], clips: [], provenance: "bundled-seed" });
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
      reservedVoices: [],
      fs: fakeFsAt({ [DEV_ROOT]: { default: { manifest: dflt, install: catalogRecord, clips } }, [ROOT]: {} }),
    });

    expect(result.problems).toEqual([]);
    expect(result.packs).toHaveLength(1);

    const pack = result.packs.find((p) => p.id === "default");

    expect(pack?.provenance).toBe("development");
    expect(pack?.voices.map((v) => v.id)).toEqual(["default"]);
    expect(pack?.dir.replace(/\\/g, "/")).toBe(`${DEV_ROOT}/default`);
  });

  it("lets the dev copy claim a voice ahead of the same pack under root, and reports the loser", () => {
    const result = scanVoicePacks({
      root: ROOT,
      devRoot: DEV_ROOT,
      reservedVoices: [],
      priorityPacks: ["default"],
      fs: fakeFsAt({
        [DEV_ROOT]: { default: { manifest: dflt, clips } },
        [ROOT]: { default: { manifest: dflt, install: catalogRecord, clips } },
      }),
    });

    expect(result.packs.filter((p) => p.id === "default")).toHaveLength(1);
    expect(result.packs[0]?.provenance).toBe("development");
    expect(result.packs[0]?.dir.replace(/\\/g, "/")).toBe(`${DEV_ROOT}/default`);
    expect(result.problems).toContainEqual({
      pack: "default",
      reason: 'voice "default" is already provided by the development build of pack "default"',
    });
  });

  it("falls back to the root pack when the dev copy is unusable", () => {
    // A staged folder with no manifest yet — the packer was interrupted, or
    // the folder is empty. It claims nothing, so the AppData pack is heard.
    const result = scanVoicePacks({
      root: ROOT,
      devRoot: DEV_ROOT,
      reservedVoices: [],
      fs: fakeFsAt({
        [DEV_ROOT]: { default: { clips } },
        [ROOT]: { default: { manifest: dflt, clips } },
      }),
    });

    expect(result.packs.map((p) => [p.id, p.provenance])).toEqual([["default", "sideload"]]);
    expect(result.problems.map((p) => p.reason)).toContain("no voice-pack.json");
  });

  it("keeps priorityPacks order within each root", () => {
    // Under the dev root a sideloaded-looking `aaa` sorts before `default` and
    // declares the same voice; `priorityPacks` still decides, root by root.
    const aaa = { schema: 1, id: "aaa", label: "Aaa", version: "1.0.0", voices: [{ id: "default", label: "Mine" }] };
    const result = scanVoicePacks({
      root: ROOT,
      devRoot: DEV_ROOT,
      reservedVoices: [],
      priorityPacks: ["default"],
      fs: fakeFsAt({
        [DEV_ROOT]: { aaa: { manifest: aaa, clips }, default: { manifest: dflt, clips } },
        [ROOT]: {},
      }),
    });

    expect(result.packs.map((p) => [p.id, p.provenance])).toEqual([["default", "development"]]);
    expect(result.problems).toEqual([
      { pack: "aaa", reason: 'voice "default" is already provided by the development build of pack "default"' },
    ]);
  });

  it("behaves exactly as before when devRoot is absent", () => {
    // Same disk, no dev root: the AppData pack is listed with its record's
    // provenance, and nothing under the development directory is even listed.
    const fs = fakeFsAt({
      [DEV_ROOT]: { default: { manifest: dflt, clips } },
      [ROOT]: { default: { manifest: dflt, install: catalogRecord, clips } },
    });
    const result = scanVoicePacks({ root: ROOT, reservedVoices: [], priorityPacks: ["default"], fs });

    expect(result.problems).toEqual([]);
    expect(result.packs.map((p) => [p.id, p.provenance])).toEqual([["default", "catalog"]]);
    expect(result.packs[0]?.dir.replace(/\\/g, "/")).toBe(`${ROOT}/default`);
  });
});
