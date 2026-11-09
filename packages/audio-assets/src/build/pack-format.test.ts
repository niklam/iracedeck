import { CALLOUT_SCRIPT_FILE } from "@iracedeck/callout-script";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installedPackageVersion } from "./installed-version.mjs";
import {
  archiveFormatIdentity,
  countSourceClips,
  isCanonicalPackVersion,
  listSourceClips,
  locateCalloutScript,
  selectPacks,
  ZIP_ENTRY_MTIME_FIELDS,
  ZIP_ENTRY_OPTIONS,
} from "./pack-format.mjs";
import { VOICE_PACKS } from "./voice-packs.mjs";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);

  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("listSourceClips — the walk the record and the completeness check share", () => {
  it("lists every mp3 recursively as sorted POSIX paths, case-insensitive on the extension, and nothing else", () => {
    const root = tempDir("ird-list-clips-");

    mkdirSync(path.join(root, "flags"), { recursive: true });
    mkdirSync(path.join(root, "units", "nested"), { recursive: true });
    writeFileSync(path.join(root, "flags", "blue-01.mp3"), "a");
    writeFileSync(path.join(root, "flags", "blue-02.MP3"), "b");
    writeFileSync(path.join(root, "flags", "notes.txt"), "c");
    writeFileSync(path.join(root, "units", "litres.mp3"), "d");
    writeFileSync(path.join(root, "units", "nested", "deep.mp3"), "e");
    writeFileSync(path.join(root, CALLOUT_SCRIPT_FILE), "{}");

    // Sorted by code unit (`B` before `l`), never by locale.
    expect(listSourceClips(root)).toEqual([
      "flags/blue-01.mp3",
      "flags/blue-02.MP3",
      "units/litres.mp3",
      "units/nested/deep.mp3",
    ]);
    expect(countSourceClips(root)).toBe(4);
  });

  it("lists an empty tree as nothing rather than throwing", () => {
    const root = tempDir("ird-list-clips-empty-");

    expect(listSourceClips(root)).toEqual([]);
    expect(countSourceClips(root)).toBe(0);
  });
});

describe("locateCalloutScript — the exact-name rule", () => {
  it("finds the script directly under the voice by its exact name, and only there", () => {
    const root = tempDir("ird-locate-script-");

    mkdirSync(path.join(root, "flags"));
    writeFileSync(path.join(root, CALLOUT_SCRIPT_FILE), "{}");
    writeFileSync(path.join(root, "flags", CALLOUT_SCRIPT_FILE), "{}");

    expect(locateCalloutScript(root)).toEqual({ file: path.join(root, CALLOUT_SCRIPT_FILE), wrongCase: undefined });
    expect(locateCalloutScript(path.join(root, "flags"))).toEqual({
      file: path.join(root, "flags", CALLOUT_SCRIPT_FILE),
      wrongCase: undefined,
    });
  });

  it("reports a clips-only voice as having no script", () => {
    const root = tempDir("ird-locate-script-none-");

    writeFileSync(path.join(root, "notes.txt"), "");

    expect(locateCalloutScript(root)).toEqual({ file: null, wrongCase: undefined });
  });

  it("names a wrong-cased file rather than finding it, since the walk would not stage it", () => {
    const root = tempDir("ird-locate-script-case-");

    writeFileSync(path.join(root, "Callouts.json"), "{}");

    expect(locateCalloutScript(root)).toEqual({ file: null, wrongCase: "Callouts.json" });
  });
});

describe("isCanonicalPackVersion — the spelling the packer writes and the record names", () => {
  it.each(["1.2.3", "1.2.3-rc.1", "10.0.0-dev.0"])("accepts %s", (version) => {
    expect(isCanonicalPackVersion(version)).toBe(true);
  });

  it.each([
    ["a leading v, which the plugin would accept", "v1.2.3"],
    ["surrounding whitespace, which the plugin would trim", " 1.2.3"],
    ["a trailing newline", "1.2.3\n"],
    ["build metadata, which semver ignores when comparing", "1.2.3+build.7"],
    ["two parts", "1.2"],
    ["a number", 1],
    ["nothing", undefined],
  ])("refuses %s", (_what, version) => {
    expect(isCanonicalPackVersion(version)).toBe(false);
  });
});

describe("archiveFormatIdentity", () => {
  it("names the installed fflate version and the pinned zip options, with the mtime as date fields, not a Date", () => {
    const identity = archiveFormatIdentity();

    expect(identity).toEqual({
      fflate: installedPackageVersion("fflate", import.meta.url),
      zipEntryOptions: { level: 9, mtime: [1980, 0, 1, 0, 0, 0], os: 0, attrs: 0 },
    });
    // JSON-safe: the serialization is the same on every machine, whatever its time zone.
    expect(JSON.stringify(identity)).not.toContain("T00:00");
    expect(identity.zipEntryOptions.mtime).toEqual([...ZIP_ENTRY_MTIME_FIELDS]);
    // And it describes the options the archive is actually written with.
    expect(ZIP_ENTRY_OPTIONS).toMatchObject({ level: 9, os: 0, attrs: 0 });
    expect(ZIP_ENTRY_OPTIONS.mtime.getTime()).toBe(new Date(...ZIP_ENTRY_MTIME_FIELDS).getTime());
  });
});

// The one selector the packer's command line, `sealPackRecords` and the seal
// command share (#1667), so an unknown pack reads the same wherever it is typed.
describe("selectPacks", () => {
  const alpha = { id: "alpha", label: "Alpha", version: "1.0.0", voices: ["alpha"], bundled: false };
  const beta = { id: "beta", label: "Beta", version: "2.0.0", voices: ["beta"], bundled: false };

  it("is every pack, as a copy, when no id is named", () => {
    const all = selectPacks([], [alpha, beta]);

    expect(all).toEqual([alpha, beta]);
    expect(all).not.toBe([alpha, beta]);
    expect(selectPacks([]).map((pack) => pack.id)).toEqual(VOICE_PACKS.map((pack) => pack.id));
  });

  it("is the named packs in the order given, each once", () => {
    expect(selectPacks(["beta", "alpha", "beta"], [alpha, beta])).toEqual([beta, alpha]);
  });

  it("refuses an unknown id naming the known ones, in the registry's order", () => {
    expect(() => selectPacks(["alpha", "gamma"], [alpha, beta])).toThrow(
      'unknown pack "gamma" — known packs: alpha, beta',
    );
    expect(() => selectPacks(["nope"])).toThrow(`known packs: ${VOICE_PACKS.map((pack) => pack.id).join(", ")}`);
  });
});
