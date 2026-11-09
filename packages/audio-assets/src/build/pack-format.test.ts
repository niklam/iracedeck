import { CALLOUT_SCRIPT_FILE } from "@iracedeck/callout-script";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installedPackageVersion } from "./installed-version.mjs";
import {
  archiveFormatIdentity,
  countSourceClips,
  listSourceClips,
  locateCalloutScript,
  ZIP_ENTRY_MTIME_FIELDS,
  ZIP_ENTRY_OPTIONS,
} from "./pack-format.mjs";

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
