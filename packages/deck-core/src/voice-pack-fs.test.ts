import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createVoicePackFileSystem, VOICE_PACK_MAX_DEPTH } from "./voice-pack-fs.js";

const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ird-packs-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function fs() {
  return createVoicePackFileSystem(logger as never);
}

describe("createVoicePackFileSystem", () => {
  it("lists only directories", () => {
    mkdirSync(join(root, "luca"));
    writeFileSync(join(root, "loose.txt"), "x");

    expect(fs().listDirectories(root)).toEqual(["luca"]);
  });

  it("returns an empty list for a missing directory rather than throwing", () => {
    expect(fs().listDirectories(join(root, "nope"))).toEqual([]);
  });

  it("reads a file and returns undefined for a missing one", () => {
    writeFileSync(join(root, "a.json"), "{}");

    expect(fs().readTextFile(join(root, "a.json"))).toBe("{}");
    expect(fs().readTextFile(join(root, "missing.json"))).toBeUndefined();
  });

  it("walks mp3 files recursively as POSIX paths relative to the pack dir", () => {
    mkdirSync(join(root, "voice", "luca", "flags"), { recursive: true });
    writeFileSync(join(root, "voice", "luca", "flags", "blue-01.mp3"), "");
    writeFileSync(join(root, "voice", "luca", "flags", "notes.txt"), "");

    expect(fs().listMp3Files(root)).toEqual(["voice/luca/flags/blue-01.mp3"]);
  });

  it("matches the .mp3 extension case-insensitively", () => {
    mkdirSync(join(root, "voice", "luca"), { recursive: true });
    writeFileSync(join(root, "voice", "luca", "A.MP3"), "");

    expect(fs().listMp3Files(root)).toEqual(["voice/luca/A.MP3"]);
  });

  it("returns clips sorted so a scan is reproducible", () => {
    mkdirSync(join(root, "voice", "luca"), { recursive: true });

    for (const name of ["c.mp3", "a.mp3", "b.mp3"]) writeFileSync(join(root, "voice", "luca", name), "");

    expect(fs().listMp3Files(root)).toEqual(["voice/luca/a.mp3", "voice/luca/b.mp3", "voice/luca/c.mp3"]);
  });

  it("stops descending past the depth cap", () => {
    // One level deeper than the cap allows; the file there must not be listed.
    const segments = Array.from({ length: VOICE_PACK_MAX_DEPTH + 1 }, (_, i) => `d${i}`);
    mkdirSync(join(root, ...segments), { recursive: true });
    writeFileSync(join(root, ...segments, "deep.mp3"), "");

    expect(fs().listMp3Files(root)).toEqual([]);
  });

  it("returns an empty list for a missing pack directory", () => {
    expect(fs().listMp3Files(join(root, "nope"))).toEqual([]);
  });
});
