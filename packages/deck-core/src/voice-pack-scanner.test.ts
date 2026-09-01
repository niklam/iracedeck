import { describe, expect, it } from "vitest";

import { scanVoicePacks, type VoicePackFileSystem } from "./voice-pack-scanner.js";

const ROOT = "/packs";

/** A manifest that exists but cannot be opened — locked, EISDIR, permission denied. */
const UNREADABLE = Symbol("unreadable");

type FakePack = { manifest?: unknown; clips?: string[] };

/** Last path segment, normalised across separators. */
function folderOf(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1) ?? "";
}

function fakeFs(tree: Record<string, FakePack>): VoicePackFileSystem {
  return {
    listDirectories: (dir) => (folderOf(dir) === "packs" ? Object.keys(tree) : []),
    readTextFile: (file) => {
      const parts = file.replace(/\\/g, "/").split("/");
      const entry = tree[parts.at(-2) ?? ""];

      if (!entry || entry.manifest === undefined) return { ok: false, missing: true, reason: "ENOENT" };

      if (entry.manifest === UNREADABLE) return { ok: false, missing: false, reason: "EBUSY" };

      return { ok: true, text: typeof entry.manifest === "string" ? entry.manifest : JSON.stringify(entry.manifest) };
    },
    listMp3Files: (packDir) => tree[folderOf(packDir)]?.clips ?? [],
  };
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

    expect(result.packs[0].voices).toEqual([{ id: "luca", label: "Luca" }]);
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
