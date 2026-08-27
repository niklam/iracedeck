import { describe, expect, it } from "vitest";

import { scanVoicePacks, type VoicePackFileSystem } from "./voice-pack-scanner.js";

const ROOT = "/packs";

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

      if (!entry || entry.manifest === undefined) return undefined;

      return typeof entry.manifest === "string" ? entry.manifest : JSON.stringify(entry.manifest);
    },
    listMp3Files: (packDir) => tree[folderOf(packDir)]?.clips ?? [],
  };
}

const luca = { schema: 1, id: "luca", label: "Luca", version: "1.2.0", voices: ["luca"] };

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
      voices: ["luca"],
      clips: ["voice/luca/flags/blue-01.mp3"],
    });
    expect(result.packs[0].dir.replace(/\\/g, "/")).toBe("/packs/luca");
  });

  it("reports a folder with no voice-pack.json instead of throwing", () => {
    const result = scanVoicePacks({ root: ROOT, fs: fakeFs({ junk: { clips: [] } }) });

    expect(result.packs).toEqual([]);
    expect(result.problems).toEqual([{ pack: "junk", reason: "no voice-pack.json" }]);
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

  it("resolves a voice claimed by two packs to the first by sorted pack id, and reports the loser", () => {
    const result = scanVoicePacks({
      root: ROOT,
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
      fs: fakeFs({
        alpha: { manifest: { ...luca, id: "alpha" }, clips: ["voice/luca/a.mp3"] },
        zeta: { manifest: { ...luca, id: "zeta" }, clips: ["voice/luca/a.mp3"] },
      }),
    });
    const reversed = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({
        zeta: { manifest: { ...luca, id: "zeta" }, clips: ["voice/luca/a.mp3"] },
        alpha: { manifest: { ...luca, id: "alpha" }, clips: ["voice/luca/a.mp3"] },
      }),
    });

    expect(forward.packs.map((p) => p.id)).toEqual(reversed.packs.map((p) => p.id));
  });

  it("keeps a pack's second voice when only its first collides", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({
        alpha: { manifest: { ...luca, id: "alpha", voices: ["luca"] }, clips: ["voice/luca/a.mp3"] },
        beta: {
          manifest: { ...luca, id: "beta", voices: ["luca", "nina"] },
          clips: ["voice/luca/a.mp3", "voice/nina/a.mp3"],
        },
      }),
    });

    expect(result.packs.map((p) => p.id)).toEqual(["alpha", "beta"]);
    expect(result.packs[1].voices).toEqual(["nina"]);
    expect(result.packs[1].clips).toEqual(["voice/nina/a.mp3"]);
  });

  it("skips the installer's own reserved folders", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({ ".tmp": { clips: [] }, ".trash": { clips: [] } }),
    });

    expect(result.packs).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("refuses a voice the plugin's own bundled audio provides", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({ luca: { manifest: luca, clips: ["voice/luca/a.mp3"] } }),
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
          manifest: { ...luca, id: "duo", voices: ["luca", "nina"] },
          clips: ["voice/luca/a.mp3", "voice/nina/a.mp3"],
        },
      }),
      reservedVoices: ["luca"],
    });

    expect(result.packs[0].voices).toEqual(["nina"]);
    expect(result.packs[0].clips).toEqual(["voice/nina/a.mp3"]);
  });

  it("does not claim a declared voice it ships no clips for", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({
        // `alpha` declares nina but ships only luca; `beta` really has nina and
        // must not be locked out by alpha's empty declaration.
        alpha: { manifest: { ...luca, id: "alpha", voices: ["luca", "nina"] }, clips: ["voice/luca/a.mp3"] },
        beta: { manifest: { ...luca, id: "beta", voices: ["nina"] }, clips: ["voice/nina/a.mp3"] },
      }),
    });

    expect(result.packs.map((p) => p.id)).toEqual(["alpha", "beta"]);
    expect(result.packs[0].voices).toEqual(["luca"]);
    expect(result.packs[1].voices).toEqual(["nina"]);
    expect(result.problems).toEqual([{ pack: "alpha", reason: "no clips found under voice/nina/" }]);
  });

  it("de-duplicates a voice id repeated in one manifest", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({ luca: { manifest: { ...luca, voices: ["luca", "luca"] }, clips: ["voice/luca/a.mp3"] } }),
    });

    expect(result.packs[0].voices).toEqual(["luca"]);
    expect(result.packs[0].clips).toEqual(["voice/luca/a.mp3"]);
  });

  it("carries the author through when present", () => {
    const result = scanVoicePacks({
      root: ROOT,
      fs: fakeFs({ luca: { manifest: { ...luca, author: "Someone" }, clips: ["voice/luca/a.mp3"] } }),
    });

    expect(result.packs[0].author).toBe("Someone");
  });
});
