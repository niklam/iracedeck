import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createVoicePackArchiveFileSystem, createVoicePackFileSystem, VOICE_PACK_MAX_DEPTH } from "./voice-pack-fs.js";

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

  it("reads a file, and reports a missing one as missing", () => {
    writeFileSync(join(root, "a.json"), "{}");

    expect(fs().readTextFile(join(root, "a.json"))).toEqual({ ok: true, text: "{}" });
    expect(fs().readTextFile(join(root, "missing.json"))).toEqual({ ok: false, missing: true, reason: "ENOENT" });
  });

  it("reports a manifest it cannot open as unreadable rather than missing", () => {
    // A DIRECTORY named `voice-pack.json` is the reproducible case; a locked or
    // permission-denied file takes the same path. The scanner turns `missing`
    // into two different sentences, so getting this wrong tells a user their
    // file is absent while they are looking at it.
    mkdirSync(join(root, "voice-pack.json"));

    const read = fs().readTextFile(join(root, "voice-pack.json"));

    expect(read).toMatchObject({ ok: false, missing: false });
    // Path-free: the reason is shown in the settings window and rides the deck
    // host's settings copy, so only the errno travels.
    expect((read as { reason: string }).reason).not.toContain(root);
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

describe("createVoicePackArchiveFileSystem", () => {
  function archiveFs() {
    return createVoicePackArchiveFileSystem(logger as never);
  }

  it("creates a directory and every missing parent, and treats an existing one as success", () => {
    const dir = join(root, "luca", "voice", "luca", "flags");

    expect(archiveFs().ensureDirectory(dir)).toEqual({ ok: true });
    expect(archiveFs().ensureDirectory(dir)).toEqual({ ok: true });
    expect(existsSync(dir)).toBe(true);
  });

  it("reports a file standing where a directory is needed, by errno only", () => {
    writeFileSync(join(root, "voice"), "");

    const made = archiveFs().ensureDirectory(join(root, "voice", "luca"));

    expect(made.ok).toBe(false);
    expect((made as { reason: string }).reason).not.toContain(root);
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  it("writes a new file's bytes", () => {
    const file = join(root, "blue-01.mp3");

    expect(archiveFs().writeFile(file, new Uint8Array([1, 2, 3]))).toEqual({ ok: true });
    expect([...readFileSync(file)]).toEqual([1, 2, 3]);
  });

  it("refuses to write over anything already at the destination, leaving it as it was", () => {
    // The `wx` guarantee: a file — or a symlink — planted at the path before
    // the extractor got there is not followed and not overwritten. A plain
    // file is the reproducible stand-in for a symlink, which needs a privilege
    // to create on Windows; `O_EXCL` refuses both the same way.
    const file = join(root, "planted.json");
    writeFileSync(file, "planted");

    expect(archiveFs().writeFile(file, new Uint8Array([1]))).toEqual({ ok: false, reason: "EEXIST" });
    expect(readFileSync(file, "utf-8")).toBe("planted");
  });

  it("reports a missing parent rather than creating one", () => {
    expect(archiveFs().writeFile(join(root, "nope", "x.mp3"), new Uint8Array([1]))).toEqual({
      ok: false,
      reason: "ENOENT",
    });
  });
});
