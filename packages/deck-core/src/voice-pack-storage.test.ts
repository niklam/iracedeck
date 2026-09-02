import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VOICE_PACK_PROVENANCE_FILE } from "./voice-pack-constants.js";
import { downloadVoicePack } from "./voice-pack-download.js";
import {
  createVoicePackStorage,
  createVoicePackStorageFileSystem,
  VOICE_PACK_LOCK_HEARTBEAT_MS,
  VOICE_PACK_LOCK_MAX_WAIT_MS,
  VOICE_PACK_LOCK_POLL_MS,
  VOICE_PACK_LOCK_STALE_MS,
  VOICE_PACK_TMP_DIR,
  VOICE_PACK_TRASH_DIR,
  type VoicePackLock,
  type VoicePackStorage,
  type VoicePackStorageFileSystem,
} from "./voice-pack-storage.js";

const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const ROOT = join("vp", "Voices");
const TMP = join(ROOT, VOICE_PACK_TMP_DIR);
const TRASH = join(ROOT, VOICE_PACK_TRASH_DIR);
const SHA = "a".repeat(64);

type Entry = { kind: "dir" } | { kind: "file"; data: Buffer };
type FaultOp = "makeDirectory" | "rename" | "remove" | "writeTextFile" | "createExclusive" | "openWrite";

/**
 * An in-memory tree behind the storage port.
 *
 * Models the two facts the choreography depends on: `rename` is refused onto an
 * existing target (Windows never replaces a directory), and a missing source is
 * `ENOENT`. `faults` makes one operation fail on demand, which is the only way
 * to prove what the installed pack looks like after each step goes wrong.
 */
class FakeFs implements VoicePackStorageFileSystem {
  readonly tree = new Map<string, Entry>();
  faults: { [K in FaultOp]?: (path: string, second?: string) => string | undefined } = {};

  private key(path: string): string {
    return normalize(path).replace(/[\\/]+$/, "");
  }

  private fault(op: FaultOp, path: string, second?: string): string | undefined {
    return this.faults[op]?.(this.key(path), second === undefined ? undefined : this.key(second));
  }

  private isDir(key: string): boolean {
    return this.tree.get(key)?.kind === "dir";
  }

  private subtree(key: string): string[] {
    return [...this.tree.keys()].filter((k) => k === key || k.startsWith(key + sep));
  }

  /** Test seeding: a directory with every ancestor. */
  dir(path: string): void {
    const key = this.key(path);

    if (key !== dirname(key)) this.dir(dirname(key));

    this.tree.set(key, { kind: "dir" });
  }

  /** Test seeding: a file with every ancestor directory. */
  file(path: string, text: string): void {
    this.dir(dirname(this.key(path)));
    this.tree.set(this.key(path), { kind: "file", data: Buffer.from(text) });
  }

  has(path: string): boolean {
    return this.tree.has(this.key(path));
  }

  read(path: string): string | undefined {
    const entry = this.tree.get(this.key(path));

    return entry?.kind === "file" ? entry.data.toString() : undefined;
  }

  children(path: string): string[] {
    const key = this.key(path);

    return [...this.tree.keys()]
      .filter((k) => k !== key && k.startsWith(key + sep) && !k.slice(key.length + 1).includes(sep))
      .map((k) => k.slice(key.length + 1))
      .sort();
  }

  /** Every file under `path`, as relative POSIX path -> text, for "intact" checks. */
  files(path: string): Record<string, string> {
    const key = this.key(path);
    const out: Record<string, string> = {};

    for (const k of this.subtree(key)) {
      const entry = this.tree.get(k);

      if (entry?.kind !== "file") continue;

      const relative = k
        .slice(key.length + 1)
        .split(sep)
        .join("/");
      out[relative] = entry.data.toString();
    }

    return out;
  }

  async makeDirectory(dir: string) {
    const code = this.fault("makeDirectory", dir);

    if (code !== undefined) return { ok: false as const, code };

    this.dir(dir);

    return { ok: true as const };
  }

  async listEntries(dir: string) {
    return this.children(dir);
  }

  async exists(path: string) {
    return this.has(path);
  }

  async rename(from: string, to: string) {
    const code = this.fault("rename", from, to);

    if (code !== undefined) return { ok: false as const, code };

    const fromKey = this.key(from);
    const toKey = this.key(to);

    if (!this.tree.has(fromKey)) return { ok: false as const, code: "ENOENT" };

    if (!this.isDir(dirname(toKey))) return { ok: false as const, code: "ENOENT" };

    if (this.tree.has(toKey)) return { ok: false as const, code: "EPERM" };

    for (const k of this.subtree(fromKey)) {
      const entry = this.tree.get(k) as Entry;
      this.tree.delete(k);
      this.tree.set(toKey + k.slice(fromKey.length), entry);
    }

    return { ok: true as const };
  }

  async remove(path: string) {
    const code = this.fault("remove", path);

    if (code !== undefined) return { ok: false as const, code };

    for (const k of this.subtree(this.key(path))) this.tree.delete(k);

    return { ok: true as const };
  }

  async readTextFile(file: string) {
    return this.read(file);
  }

  async writeTextFile(file: string, text: string) {
    const code = this.fault("writeTextFile", file);

    if (code !== undefined) return { ok: false as const, code };

    if (!this.isDir(dirname(this.key(file)))) return { ok: false as const, code: "ENOENT" };

    this.tree.set(this.key(file), { kind: "file", data: Buffer.from(text) });

    return { ok: true as const };
  }

  async createExclusive(file: string, text: string) {
    const code = this.fault("createExclusive", file);

    if (code !== undefined) return { ok: false as const, code };

    if (this.tree.has(this.key(file))) return { ok: true as const, created: false };

    if (!this.isDir(dirname(this.key(file)))) return { ok: false as const, code: "ENOENT" };

    this.tree.set(this.key(file), { kind: "file", data: Buffer.from(text) });

    return { ok: true as const, created: true };
  }

  async openWrite(file: string) {
    const code = this.fault("openWrite", file);

    if (code !== undefined) return { ok: false as const, code };

    const key = this.key(file);

    if (this.isDir(key)) return { ok: false as const, code: "EISDIR" };

    if (!this.isDir(dirname(key))) return { ok: false as const, code: "ENOENT" };

    const entry: Entry = { kind: "file", data: Buffer.alloc(0) };
    this.tree.set(key, entry);
    let closed = false;

    return {
      ok: true as const,
      handle: {
        async write(chunk: Uint8Array) {
          if (closed) throw new Error("EBADF: write after close");

          entry.data = Buffer.concat([entry.data, Buffer.from(chunk)]);
        },
        async close() {
          closed = true;

          return { ok: true as const };
        },
      },
    };
  }
}

const OLD_PACK = { "voice-pack.json": '{"id":"luca","version":"1.0.0"}', "voice/luca/flags/blue-01.mp3": "OLD" };
const NEW_PACK = {
  "voice-pack.json": '{"id":"luca","version":"1.1.0"}',
  "voice/luca/flags/blue-01.mp3": "NEW",
  "voice/luca/flags/blue-02.mp3": "NEW2",
};

function seed(fs: FakeFs, dir: string, files: Record<string, string>): void {
  fs.dir(dir);

  for (const [relative, text] of Object.entries(files)) fs.file(join(dir, ...relative.split("/")), text);
}

let fs: FakeFs;
let storage: VoicePackStorage;

beforeEach(() => {
  fs = new FakeFs();
  fs.dir(ROOT);
  storage = createVoicePackStorage({ root: ROOT, fs, logger: logger as never });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("layout", () => {
  it("keeps its working directories as dot-directories the scanner skips", () => {
    expect(VOICE_PACK_TMP_DIR.startsWith(".")).toBe(true);
    expect(VOICE_PACK_TRASH_DIR.startsWith(".")).toBe(true);
    expect(VOICE_PACK_PROVENANCE_FILE.startsWith(".")).toBe(true);
  });

  it("places a pack directly under the root", () => {
    expect(storage.packDir("luca")).toBe(join(ROOT, "luca"));
    expect(storage.root).toBe(ROOT);
  });
});

describe("openDownload", () => {
  it("opens a truncated archive in .tmp, writes through the sink, and closes", async () => {
    const opened = await storage.openDownload("luca", SHA);

    expect(opened.ok).toBe(true);

    if (!opened.ok) return;

    expect(opened.path).toBe(join(TMP, `luca.${SHA}.zip`));
    await opened.sink.write(new TextEncoder().encode("PK"));
    await opened.sink.write(new TextEncoder().encode("rest"));

    expect(await opened.close()).toEqual({ ok: true });
    expect(await opened.close()).toEqual({ ok: true });
    expect(fs.read(opened.path)).toBe("PKrest");
  });

  it("removes a leftover of the same name first — even a directory", async () => {
    fs.file(join(TMP, `luca.${SHA}.zip`, "stray"), "x");

    const opened = await storage.openDownload("luca", SHA);

    expect(opened.ok).toBe(true);
    expect(fs.read(join(TMP, `luca.${SHA}.zip`))).toBe("");
  });

  it("discard closes and deletes the file", async () => {
    const opened = await storage.openDownload("luca", SHA);

    if (!opened.ok) throw new Error("expected ok");

    await opened.sink.write(new Uint8Array([1, 2, 3]));
    await opened.discard();

    expect(fs.has(opened.path)).toBe(false);
    expect(fs.children(TMP)).toEqual([]);
  });

  it("reports a .tmp it cannot create", async () => {
    fs.faults.makeDirectory = () => "EACCES";

    expect(await storage.openDownload("luca", SHA)).toEqual({ ok: false, code: "EACCES" });
  });

  it("reports a file it cannot open", async () => {
    fs.faults.openWrite = () => "EBUSY";

    expect(await storage.openDownload("luca", SHA)).toEqual({ ok: false, code: "EBUSY" });
  });

  it("refuses an id or digest that is not a plain name, before touching the disk", async () => {
    expect(await storage.openDownload("../etc", SHA)).toEqual({ ok: false, code: "EINVAL" });
    expect(await storage.openDownload("luca", `..${sep}x`)).toEqual({ ok: false, code: "EINVAL" });
    expect(await storage.openDownload("luca", SHA.toUpperCase())).toEqual({ ok: false, code: "EINVAL" });
    expect(fs.has(TMP)).toBe(false);
  });
});

describe("createStagingDir", () => {
  it("creates an empty .tmp/<id>.<sha> and discards it on request", async () => {
    const staged = await storage.createStagingDir("luca", SHA);

    expect(staged.ok).toBe(true);

    if (!staged.ok) return;

    expect(staged.dir).toBe(join(TMP, `luca.${SHA}`));
    expect(fs.has(staged.dir)).toBe(true);
    expect(fs.children(staged.dir)).toEqual([]);

    fs.file(join(staged.dir, "a.mp3"), "x");
    await staged.discard();

    expect(fs.has(staged.dir)).toBe(false);
  });

  it("empties a half-filled leftover from an earlier attempt", async () => {
    fs.file(join(TMP, `luca.${SHA}`, "voice", "luca", "flags", "stale.mp3"), "x");

    const staged = await storage.createStagingDir("luca", SHA);

    expect(staged.ok).toBe(true);
    expect(fs.children(join(TMP, `luca.${SHA}`))).toEqual([]);
  });

  it("reports a leftover it cannot remove", async () => {
    fs.file(join(TMP, `luca.${SHA}`, "held.mp3"), "x");
    fs.faults.remove = (path) => (path.endsWith(`luca.${SHA}`) ? "EBUSY" : undefined);

    expect(await storage.createStagingDir("luca", SHA)).toEqual({ ok: false, code: "EBUSY" });
  });
});

describe("writeProvenance", () => {
  it("writes .install.json into the given directory, serialized", async () => {
    fs.dir(join(TMP, `luca.${SHA}`));

    const result = await storage.writeProvenance(join(TMP, `luca.${SHA}`), {
      schema: 1,
      source: "catalog",
      id: "luca",
      version: "1.1.0",
      sha256: SHA,
      url: "https://example.test/luca.zip",
      installedAt: "2026-09-02T00:00:00.000Z",
    });

    expect(result).toEqual({ ok: true });
    const text = fs.read(join(TMP, `luca.${SHA}`, VOICE_PACK_PROVENANCE_FILE));
    expect(text?.endsWith("\n")).toBe(true);
    expect(JSON.parse(text as string)).toMatchObject({ id: "luca", sha256: SHA, source: "catalog" });
  });

  it("reports a write failure", async () => {
    expect(await storage.writeProvenance(join(TMP, "nope"), {} as never)).toEqual({ ok: false, code: "ENOENT" });
  });
});

describe("promote", () => {
  const target = join(ROOT, "luca");
  const staged = join(TMP, `luca.${SHA}`);

  beforeEach(() => {
    seed(fs, target, OLD_PACK);
    seed(fs, staged, NEW_PACK);
  });

  it("moves the old pack to .trash and the staged pack into place", async () => {
    const result = await storage.promote("luca", staged);

    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(result.trashedAt).toMatch(/^.*\.trash[\\/]luca\.\d+$/);
    expect(fs.files(target)).toEqual(NEW_PACK);
    expect(fs.files(result.trashedAt as string)).toEqual(OLD_PACK);
    expect(fs.has(staged)).toBe(false);
  });

  it("installs a first pack with nothing to trash", async () => {
    await fs.remove(target);

    const result = await storage.promote("luca", staged);

    expect(result).toEqual({ ok: true });
    expect(fs.files(target)).toEqual(NEW_PACK);
    expect(fs.children(TRASH)).toEqual([]);
  });

  it("uses a strictly increasing trash stamp, so two promotes in one millisecond cannot collide", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const first = await storage.promote("luca", staged);
    seed(fs, staged, NEW_PACK);
    const second = await storage.promote("luca", staged);

    if (!first.ok || !second.ok) throw new Error("expected both promotes to succeed");

    expect(first.trashedAt).toBeDefined();
    expect(second.trashedAt).toBeDefined();
    expect(first.trashedAt).not.toBe(second.trashedAt);
    expect(fs.children(TRASH)).toHaveLength(2);
  });

  it("touches nothing when .trash cannot be created", async () => {
    fs.faults.makeDirectory = (path) => (path.endsWith(VOICE_PACK_TRASH_DIR) ? "EACCES" : undefined);

    const result = await storage.promote("luca", staged);

    expect(result).toEqual({ ok: false, step: "prepare", code: "EACCES", previous: "untouched" });
    expect(fs.files(target)).toEqual(OLD_PACK);
    expect(fs.files(staged)).toEqual(NEW_PACK);
  });

  it("leaves the old pack untouched when it cannot be moved aside (a held clip)", async () => {
    fs.faults.rename = (from) => (from === normalize(target) ? "EPERM" : undefined);

    const result = await storage.promote("luca", staged);

    expect(result).toEqual({ ok: false, step: "retire-old", code: "EPERM", previous: "untouched" });
    expect(fs.files(target)).toEqual(OLD_PACK);
    expect(fs.files(staged)).toEqual(NEW_PACK);
    expect(fs.children(TRASH)).toEqual([]);
  });

  it("restores the old pack when the staged pack cannot be moved into place", async () => {
    fs.faults.rename = (from) => (from === normalize(staged) ? "EIO" : undefined);

    const result = await storage.promote("luca", staged);

    expect(result).toEqual({ ok: false, step: "install-new", code: "EIO", previous: "restored" });
    // Back where it was, byte for byte, and the trash entry it briefly occupied is gone.
    expect(fs.files(target)).toEqual(OLD_PACK);
    expect(fs.children(TRASH)).toEqual([]);
    expect(fs.files(staged)).toEqual(NEW_PACK);
  });

  it("restores nothing and says so when there was no old pack and the install fails", async () => {
    await fs.remove(target);
    fs.faults.rename = (from) => (from === normalize(staged) ? "EIO" : undefined);

    const result = await storage.promote("luca", staged);

    expect(result).toEqual({ ok: false, step: "install-new", code: "EIO", previous: "none" });
    expect(fs.has(target)).toBe(false);
  });

  it("names where the old pack is when both the install and the restore fail, intact", async () => {
    fs.faults.rename = (from, to) => (from === normalize(staged) || to === normalize(target) ? "EIO" : undefined);

    const result = await storage.promote("luca", staged);

    expect(result).toMatchObject({ ok: false, step: "install-new", code: "EIO" });

    if (result.ok || typeof result.previous === "string") throw new Error("expected a trashed path");

    expect(fs.files(result.previous.trashedAt)).toEqual(OLD_PACK);
    expect(fs.has(target)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(result.previous.trashedAt));

    // "Intact" has to survive the next start too: with no installed copy, the
    // sweep must leave this entry alone rather than delete the only one.
    await storage.sweep();

    expect(fs.files(result.previous.trashedAt)).toEqual(OLD_PACK);
  });

  it("survives the other ecosystem's plugin promoting an identical pack between its two renames", async () => {
    const otherStaged = join(TMP, `luca.${"b".repeat(64)}`);
    seed(fs, otherStaged, NEW_PACK);
    fs.faults.rename = (from) => {
      if (from !== normalize(staged)) return undefined;

      // The other process wins the race: its copy lands, then ours is refused.
      fs.faults.rename = undefined;
      void fs.rename(otherStaged, target);

      return "EPERM";
    };

    const result = await storage.promote("luca", staged);

    // Reported as a failure — the swap did not happen — but the pack is installed
    // and the previous one is intact in the trash, which the sweep then clears.
    expect(result).toMatchObject({ ok: false, step: "install-new", previous: { trashedAt: expect.any(String) } });
    expect(fs.files(target)).toEqual(NEW_PACK);

    if (result.ok || typeof result.previous === "string") throw new Error("expected a trashed path");

    expect(fs.files(result.previous.trashedAt)).toEqual(OLD_PACK);

    await storage.sweep();

    expect(fs.children(TRASH)).toEqual([]);
  });

  it("refuses an invalid id before touching anything", async () => {
    const result = await storage.promote("../luca", staged);

    expect(result).toEqual({ ok: false, step: "prepare", code: "EINVAL", previous: "untouched" });
    expect(fs.has(TRASH)).toBe(false);
  });
});

describe("retire", () => {
  const target = join(ROOT, "luca");

  it("moves the installed pack to .trash marked removed", async () => {
    seed(fs, target, OLD_PACK);

    const result = await storage.retire("luca");

    if (!result.ok || result.trashedAt === undefined) throw new Error("expected a trashed path");

    expect(result.trashedAt).toMatch(/luca\.\d+\.removed$/);
    expect(fs.has(target)).toBe(false);
    expect(fs.files(result.trashedAt)).toEqual(OLD_PACK);
  });

  it("marks copies an earlier install superseded as removed too", async () => {
    seed(fs, target, NEW_PACK);
    seed(fs, join(TRASH, "luca.100"), OLD_PACK);
    seed(fs, join(TRASH, "other.100"), OLD_PACK);

    await storage.retire("luca");

    const entries = fs.children(TRASH);
    expect(entries).toContain("luca.100.removed");
    expect(entries).toContain("other.100");
    expect(entries.some((name) => /^luca\.\d+\.removed$/.test(name) && name !== "luca.100.removed")).toBe(true);
  });

  it("succeeds with nothing to report when no pack is installed", async () => {
    expect(await storage.retire("luca")).toEqual({ ok: true });
  });

  it("leaves the pack in place when it cannot be moved", async () => {
    seed(fs, target, OLD_PACK);
    fs.faults.rename = () => "EPERM";

    expect(await storage.retire("luca")).toEqual({ ok: false, code: "EPERM" });
    expect(fs.files(target)).toEqual(OLD_PACK);
  });
});

describe("sweep", () => {
  it("empties .tmp and .trash of everything safe to delete", async () => {
    fs.file(join(TMP, `luca.${SHA}.zip`), "zip");
    fs.file(join(TMP, `luca.${SHA}`, "a.mp3"), "x");
    fs.file(join(TMP, "junk.txt"), "x");
    seed(fs, join(ROOT, "luca"), NEW_PACK);
    seed(fs, join(TRASH, "luca.100"), OLD_PACK);
    seed(fs, join(TRASH, "gone.100.removed"), OLD_PACK);
    fs.file(join(TRASH, "unparseable"), "x");

    const result = await storage.sweep();

    expect(result).toEqual({ removed: 6, failed: 0, kept: 0 });
    expect(fs.children(TMP)).toEqual([]);
    expect(fs.children(TRASH)).toEqual([]);
    expect(fs.files(join(ROOT, "luca"))).toEqual(NEW_PACK);
  });

  it("is a no-op when the working directories do not exist", async () => {
    expect(await storage.sweep()).toEqual({ removed: 0, failed: 0, kept: 0 });
  });

  it("keeps the only copy of a pack: a superseded entry whose installed copy is gone", async () => {
    seed(fs, join(TRASH, "luca.100"), OLD_PACK);

    const result = await storage.sweep();

    expect(result).toEqual({ removed: 0, failed: 0, kept: 1 });
    expect(fs.files(join(TRASH, "luca.100"))).toEqual(OLD_PACK);
  });

  it("deletes a removed entry regardless of whether the pack is installed", async () => {
    seed(fs, join(TRASH, "luca.100.removed"), OLD_PACK);

    await storage.sweep();

    expect(fs.children(TRASH)).toEqual([]);
  });

  it("skips .tmp entries belonging to another plugin's live download", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    fs.file(join(TMP, "luca.lock"), JSON.stringify({ pid: 1, acquiredAt: Date.now(), heartbeatAt: Date.now() }));
    fs.file(join(TMP, `luca.${SHA}.zip`), "in flight");
    fs.file(join(TMP, `other.${SHA}.zip`), "abandoned");

    const result = await storage.sweep();

    expect(result).toEqual({ removed: 1, failed: 0, kept: 2 });
    expect(fs.children(TMP)).toEqual([`luca.${SHA}.zip`, "luca.lock"]);
  });

  it("sweeps a stale lock along with its files", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const dead = Date.now() - VOICE_PACK_LOCK_STALE_MS - 1;
    fs.file(join(TMP, "luca.lock"), JSON.stringify({ pid: 1, acquiredAt: dead, heartbeatAt: dead }));
    fs.file(join(TMP, `luca.${SHA}.zip`), "abandoned");

    await storage.sweep();

    expect(fs.children(TMP)).toEqual([]);
  });

  it("tolerates an entry that cannot be deleted and carries on with the rest", async () => {
    fs.file(join(TMP, "held.zip"), "x");
    fs.file(join(TMP, "free.zip"), "x");
    fs.faults.remove = (path) => (path.endsWith("held.zip") ? "EBUSY" : undefined);

    const result = await storage.sweep();

    expect(result).toEqual({ removed: 1, failed: 1, kept: 0 });
    expect(fs.children(TMP)).toEqual(["held.zip"]);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("held.zip"));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("acquireLock", () => {
  const lockPath = join(TMP, "luca.lock");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
  });

  it("creates the lock, heartbeats it, and removes it on release", async () => {
    const lock = await storage.acquireLock("luca");

    expect(lock.acquired).toBe(true);
    const first = JSON.parse(fs.read(lockPath) as string);
    expect(first).toMatchObject({ pid: process.pid, acquiredAt: 5_000_000, heartbeatAt: 5_000_000 });

    await vi.advanceTimersByTimeAsync(VOICE_PACK_LOCK_HEARTBEAT_MS * 2 + 1);

    const later = JSON.parse(fs.read(lockPath) as string);
    expect(later.heartbeatAt).toBeGreaterThan(first.heartbeatAt);
    expect(later.acquiredAt).toBe(first.acquiredAt);

    await lock.release();
    await lock.release();

    expect(fs.has(lockPath)).toBe(false);
  });

  it("makes a second plugin wait until the holder releases", async () => {
    const other = createVoicePackStorage({ root: ROOT, fs, logger: logger as never });
    const held = await storage.acquireLock("luca");
    const settled: { lock?: VoicePackLock } = {};
    const waiting = other.acquireLock("luca").then((lock) => (settled.lock = lock));

    await vi.advanceTimersByTimeAsync(VOICE_PACK_LOCK_POLL_MS * 3);

    expect(settled.lock).toBeUndefined();

    await held.release();
    await vi.advanceTimersByTimeAsync(VOICE_PACK_LOCK_POLL_MS);
    await waiting;

    expect(settled.lock?.acquired).toBe(true);
    expect(fs.has(lockPath)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith("Waited for another plugin's voice pack install");
  });

  it("takes over a lock whose holder stopped heartbeating", async () => {
    const dead = Date.now() - VOICE_PACK_LOCK_STALE_MS - 1;
    fs.file(lockPath, JSON.stringify({ pid: 1, acquiredAt: dead, heartbeatAt: dead }));

    const lock = await storage.acquireLock("luca");

    expect(lock.acquired).toBe(true);
    expect(JSON.parse(fs.read(lockPath) as string).acquiredAt).toBe(Date.now());
  });

  it("treats an unreadable lock as stale", async () => {
    fs.file(lockPath, "not json");

    expect((await storage.acquireLock("luca")).acquired).toBe(true);
  });

  it("proceeds without the lock when the wait runs out on a holder that stays alive", async () => {
    const beat = (): void => {
      fs.file(lockPath, JSON.stringify({ pid: 1, acquiredAt: 1, heartbeatAt: Date.now() }));
    };
    beat();
    const foreign = setInterval(beat, VOICE_PACK_LOCK_HEARTBEAT_MS);
    const settled: { lock?: VoicePackLock } = {};
    const waiting = storage.acquireLock("luca").then((lock) => (settled.lock = lock));

    await vi.advanceTimersByTimeAsync(VOICE_PACK_LOCK_MAX_WAIT_MS - VOICE_PACK_LOCK_POLL_MS);

    expect(settled.lock).toBeUndefined();

    await vi.advanceTimersByTimeAsync(VOICE_PACK_LOCK_POLL_MS * 2);
    clearInterval(foreign);
    await waiting;

    expect(settled.lock?.acquired).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("proceeding without"));
    // Not ours: releasing the unacquired lock leaves the other holder's file alone.
    await settled.lock?.release();

    expect(fs.has(lockPath)).toBe(true);
  });

  it("proceeds without the lock when it cannot be created, and never deletes another holder's file", async () => {
    fs.file(lockPath, JSON.stringify({ pid: 1, acquiredAt: 1, heartbeatAt: Date.now() }));
    fs.faults.createExclusive = () => "EACCES";

    const lock = await storage.acquireLock("luca");

    expect(lock.acquired).toBe(false);
    await lock.release();

    expect(fs.has(lockPath)).toBe(true);
  });

  it("proceeds without the lock when .tmp cannot be created", async () => {
    fs.faults.makeDirectory = () => "EACCES";

    expect((await storage.acquireLock("luca")).acquired).toBe(false);
  });

  it("proceeds without the lock when a stale one cannot be removed", async () => {
    const dead = Date.now() - VOICE_PACK_LOCK_STALE_MS - 1;
    fs.file(lockPath, JSON.stringify({ pid: 1, acquiredAt: dead, heartbeatAt: dead }));
    fs.faults.remove = () => "EBUSY";

    expect((await storage.acquireLock("luca")).acquired).toBe(false);
  });
});

describe("download into storage", () => {
  function respondWith(chunks: readonly Uint8Array[]): typeof fetch {
    return vi.fn(async () => {
      let index = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index < chunks.length) controller.enqueue(chunks[index++]);
          else controller.close();
        },
      });

      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
  }

  const ARCHIVE = [new TextEncoder().encode("PK"), new TextEncoder().encode("payload")];
  const ARCHIVE_SHA = createHash("sha256")
    .update(Buffer.concat(ARCHIVE.map((c) => Buffer.from(c))))
    .digest("hex");

  it("lands a verified archive in .tmp, complete, with nothing promoted until the caller says so", async () => {
    const opened = await storage.openDownload("luca", ARCHIVE_SHA);

    if (!opened.ok) throw new Error("expected ok");

    const result = await downloadVoicePack({
      url: "https://example.test/luca.zip",
      expectedSha256: ARCHIVE_SHA,
      maxBytes: 11,
      sink: opened.sink,
      fetchImpl: respondWith(ARCHIVE),
    });
    await opened.close();

    expect(result).toEqual({ ok: true, sha256: ARCHIVE_SHA, bytes: 11 });
    expect(fs.read(opened.path)).toBe("PKpayload");
    expect(fs.has(join(ROOT, "luca"))).toBe(false);
  });

  it("a hash mismatch promotes nothing, and discard leaves .tmp empty", async () => {
    const wrong = "f".repeat(64);
    const opened = await storage.openDownload("luca", wrong);

    if (!opened.ok) throw new Error("expected ok");

    const result = await downloadVoicePack({
      url: "https://example.test/luca.zip",
      expectedSha256: wrong,
      maxBytes: 11,
      sink: opened.sink,
      fetchImpl: respondWith(ARCHIVE),
    });

    expect(result).toMatchObject({ ok: false, failure: "hash-mismatch" });

    await opened.discard();

    expect(fs.has(join(ROOT, "luca"))).toBe(false);
    expect(fs.children(TMP)).toEqual([]);
    expect(fs.has(TRASH)).toBe(false);
  });

  it("a sink that fails mid-download is reported as a sink failure, with the partial file discardable", async () => {
    const opened = await storage.openDownload("luca", ARCHIVE_SHA);

    if (!opened.ok) throw new Error("expected ok");

    await opened.close();

    const result = await downloadVoicePack({
      url: "https://example.test/luca.zip",
      expectedSha256: ARCHIVE_SHA,
      maxBytes: 11,
      sink: opened.sink,
      fetchImpl: respondWith(ARCHIVE),
    });

    expect(result).toMatchObject({ ok: false, failure: "sink", bytes: 0 });
    await opened.discard();

    expect(fs.children(TMP)).toEqual([]);
  });
});

/**
 * The real adapter, on a temp directory, following `voice-pack-fs.test.ts`.
 * Only the facts the choreography relies on are pinned here; the choreography
 * itself is tested above, against the fake.
 */
describe("createVoicePackStorageFileSystem", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ird-vp-storage-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const real = () => createVoicePackStorageFileSystem(logger as never);

  it("create-exclusive creates once and reports an existing file without touching it", async () => {
    const file = join(dir, "luca.lock");

    expect(await real().createExclusive(file, "first")).toEqual({ ok: true, created: true });
    expect(await real().createExclusive(file, "second")).toEqual({ ok: true, created: false });
    expect(await real().readTextFile(file)).toBe("first");
  });

  it("reports a rename of a missing source as ENOENT — the code promote branches on", async () => {
    expect(await real().rename(join(dir, "nope"), join(dir, "x"))).toEqual({ ok: false, code: "ENOENT" });
  });

  it("refuses to rename a directory onto an existing directory", async () => {
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "b"));
    writeFileSync(join(dir, "b", "held.txt"), "x");

    expect((await real().rename(join(dir, "a"), join(dir, "b"))).ok).toBe(false);
    expect(await real().exists(join(dir, "a"))).toBe(true);
  });

  it("renames a directory tree atomically into a new name", async () => {
    mkdirSync(join(dir, "staged", "voice"), { recursive: true });
    writeFileSync(join(dir, "staged", "voice", "a.mp3"), "x");

    expect(await real().rename(join(dir, "staged"), join(dir, "luca"))).toEqual({ ok: true });
    expect(await real().readTextFile(join(dir, "luca", "voice", "a.mp3"))).toBe("x");
    expect(await real().exists(join(dir, "staged"))).toBe(false);
  });

  it("removes a tree, and treats a missing path as removed", async () => {
    mkdirSync(join(dir, "t", "deep"), { recursive: true });
    writeFileSync(join(dir, "t", "deep", "f"), "x");

    expect(await real().remove(join(dir, "t"))).toEqual({ ok: true });
    expect(await real().remove(join(dir, "t"))).toEqual({ ok: true });
    expect(await real().exists(join(dir, "t"))).toBe(false);
  });

  it("lists entries, and an empty list for a missing directory", async () => {
    mkdirSync(join(dir, "d"));
    writeFileSync(join(dir, "f.txt"), "x");

    expect([...(await real().listEntries(dir))].sort()).toEqual(["d", "f.txt"]);
    expect(await real().listEntries(join(dir, "nope"))).toEqual([]);
  });

  it("creates nested directories and tolerates an existing one", async () => {
    expect(await real().makeDirectory(join(dir, "a", "b"))).toEqual({ ok: true });
    expect(await real().makeDirectory(join(dir, "a", "b"))).toEqual({ ok: true });
    expect(await real().exists(join(dir, "a", "b"))).toBe(true);
  });

  it("writes through an open handle and reads the bytes back after close", async () => {
    const file = join(dir, "luca.zip");
    const opened = await real().openWrite(file);

    if (!opened.ok) throw new Error("expected ok");

    await opened.handle.write(new TextEncoder().encode("PK"));
    await opened.handle.write(new Uint8Array(70_000).fill(7));

    expect(await opened.handle.close()).toEqual({ ok: true });
    const text = await real().readTextFile(file);
    expect(text?.length).toBe(70_002);
    expect(text?.startsWith("PK")).toBe(true);
  });

  it("returns undefined for a missing text file and reports a failed write", async () => {
    expect(await real().readTextFile(join(dir, "nope"))).toBeUndefined();
    expect((await real().writeTextFile(join(dir, "missing-dir", "f"), "x")).ok).toBe(false);
  });
});
