import { describe, expect, it } from "vitest";

import { voiceDisplayLabels } from "./voice-labels.js";
import { scanVoicePacks, type VoicePackFileSystem } from "./voice-pack-scanner.js";

const ROOT = "/packs";

/** A manifest that exists but cannot be opened — locked, EISDIR, permission denied. */
const UNREADABLE = Symbol("unreadable");

type FakePack = { manifest?: unknown; clips?: string[]; install?: unknown };

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
      // The scanner reads two files per pack now, so the fake has to tell them
      // apart. Keying on the folder alone would answer every read with the
      // manifest, and an `.install.json` test would then assert against the
      // wrong document while appearing to pass.
      const wanted = parts.at(-1) === ".install.json" ? entry?.install : entry?.manifest;

      if (!entry || wanted === undefined) return { ok: false, missing: true, reason: "ENOENT" };

      if (wanted === UNREADABLE) return { ok: false, missing: false, reason: "EBUSY" };

      return { ok: true, text: typeof wanted === "string" ? wanted : JSON.stringify(wanted) };
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
