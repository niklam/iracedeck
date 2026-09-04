import { zipSync } from "fflate";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { VoicePackArchiveFileSystem } from "./voice-pack-archive.js";
import type { VoicePackCatalogEntry } from "./voice-pack-catalog.js";
import { VOICE_PACK_PROVENANCE_FILE } from "./voice-pack-constants.js";
import {
  type BundledVoicePack,
  createVoicePackInstaller,
  createVoicePackInstallerFileSystem,
  readInstalledVoicePackSha,
  validateStagedVoicePack,
  VOICE_PACK_MANIFEST_FILE,
  VOICE_PACK_PROGRESS_INTERVAL_MS,
  type VoicePackInstallerDeps,
  type VoicePackInstallerFileSystem,
} from "./voice-pack-installer.js";
import { parseVoicePackProvenance } from "./voice-pack-provenance.js";
import { scanVoicePacks, type VoicePackFileSystem } from "./voice-pack-scanner.js";
import type { VoicePackCatalogState, VoicePackStatus } from "./voice-pack-status.js";
import {
  createVoicePackStorage,
  type SweepVoicePacksResult,
  VOICE_PACK_LOCK_POLL_MS,
  VOICE_PACK_TMP_DIR,
  VOICE_PACK_TRASH_DIR,
  type VoicePackStorageFileSystem,
} from "./voice-pack-storage.js";

const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// Absolute on both platforms (`C:\vp\Voices` / `/vp/Voices`): the extractor
// refuses a relative target, and it is composed for real below.
const ROOT = resolve(sep, "vp", "Voices");
const TMP = join(ROOT, VOICE_PACK_TMP_DIR);
const TRASH = join(ROOT, VOICE_PACK_TRASH_DIR);
const AUDIO_DIR = resolve(sep, "plugin", "assets", "audio");
const ID = "luca";
const PACK_DIR = join(ROOT, ID);
const OLD_SHA = "0".repeat(64);
const URL_ = "https://example.test/luca-1.1.0.zip";

type Entry = { kind: "dir" } | { kind: "file"; data: Buffer };
type FaultOp =
  | "makeDirectory"
  | "rename"
  | "remove"
  | "writeTextFile"
  | "createExclusive"
  | "openWrite"
  | "ensureDirectory"
  | "writeFile"
  | "readFile";

/**
 * One in-memory tree behind all four ports the installer composes — the
 * storage port, the extractor's write port, the scanner's read port and the
 * installer's own byte reader — so a failure induced at any one step can be
 * followed by an assertion about the WHOLE disk: what is at the live path,
 * what is in the trash, what debris is in `.tmp`, and what the real scanner
 * would make of it.
 *
 * The same two facts the storage test's fake models: `rename` is refused onto
 * an existing target (Windows never replaces a directory) and a missing source
 * is `ENOENT`. `faults` makes one operation fail on demand.
 */
class FakeDisk {
  readonly tree = new Map<string, Entry>();
  faults: { [K in FaultOp]?: (path: string, second?: string) => string | undefined } = {};
  /** Every write through the extractor's port, in order — its footprint in the staging directory. */
  readonly writes: string[] = [];
  /** Files whose bytes come back altered from `readFile` — a disk that lies. */
  readonly corruptOnRead = new Set<string>();

  key(path: string): string {
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

  dir(path: string): void {
    const key = this.key(path);

    if (key !== dirname(key)) this.dir(dirname(key));

    this.tree.set(key, { kind: "dir" });
  }

  file(path: string, content: string | Uint8Array): void {
    this.dir(dirname(this.key(path)));
    this.tree.set(this.key(path), { kind: "file", data: Buffer.from(content) });
  }

  has(path: string): boolean {
    return this.tree.has(this.key(path));
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

      out[
        k
          .slice(key.length + 1)
          .split(sep)
          .join("/")
      ] = entry.data.toString();
    }

    return out;
  }

  readonly storageFs: VoicePackStorageFileSystem = {
    makeDirectory: async (dir) => {
      const code = this.fault("makeDirectory", dir);

      if (code !== undefined) return { ok: false, code };

      this.dir(dir);

      return { ok: true };
    },
    listEntries: async (dir) => this.children(dir),
    exists: async (path) => this.has(path),
    rename: async (from, to) => {
      const code = this.fault("rename", from, to);

      if (code !== undefined) return { ok: false, code };

      const fromKey = this.key(from);
      const toKey = this.key(to);

      if (!this.tree.has(fromKey)) return { ok: false, code: "ENOENT" };

      if (!this.isDir(dirname(toKey))) return { ok: false, code: "ENOENT" };

      if (this.tree.has(toKey)) return { ok: false, code: "EPERM" };

      for (const k of this.subtree(fromKey)) {
        const entry = this.tree.get(k) as Entry;
        this.tree.delete(k);
        this.tree.set(toKey + k.slice(fromKey.length), entry);
      }

      return { ok: true };
    },
    remove: async (path) => {
      const code = this.fault("remove", path);

      if (code !== undefined) return { ok: false, code };

      for (const k of this.subtree(this.key(path))) this.tree.delete(k);

      return { ok: true };
    },
    readTextFile: async (file) => {
      const entry = this.tree.get(this.key(file));

      return entry?.kind === "file" ? entry.data.toString() : undefined;
    },
    writeTextFile: async (file, text) => {
      const code = this.fault("writeTextFile", file);

      if (code !== undefined) return { ok: false, code };

      if (!this.isDir(dirname(this.key(file)))) return { ok: false, code: "ENOENT" };

      this.tree.set(this.key(file), { kind: "file", data: Buffer.from(text) });

      return { ok: true };
    },
    createExclusive: async (file, text) => {
      const code = this.fault("createExclusive", file);

      if (code !== undefined) return { ok: false, code };

      if (this.tree.has(this.key(file))) return { ok: true, created: false };

      if (!this.isDir(dirname(this.key(file)))) return { ok: false, code: "ENOENT" };

      this.tree.set(this.key(file), { kind: "file", data: Buffer.from(text) });

      return { ok: true, created: true };
    },
    openWrite: async (file) => {
      const code = this.fault("openWrite", file);

      if (code !== undefined) return { ok: false, code };

      const key = this.key(file);

      if (this.isDir(key)) return { ok: false, code: "EISDIR" };

      if (!this.isDir(dirname(key))) return { ok: false, code: "ENOENT" };

      const entry: Entry = { kind: "file", data: Buffer.alloc(0) };
      this.tree.set(key, entry);

      return {
        ok: true,
        handle: {
          async write(chunk) {
            entry.data = Buffer.concat([entry.data, Buffer.from(chunk)]);
          },
          async close() {
            return { ok: true };
          },
        },
      };
    },
  };

  readonly archiveFs: VoicePackArchiveFileSystem = {
    ensureDirectory: (dir) => {
      const code = this.fault("ensureDirectory", dir);

      if (code !== undefined) return { ok: false, reason: code };

      const key = this.key(dir);

      if (this.tree.get(key)?.kind === "file") return { ok: false, reason: "EEXIST" };

      this.dir(key);

      return { ok: true };
    },
    writeFile: (file, bytes) => {
      const code = this.fault("writeFile", file);

      if (code !== undefined) return { ok: false, reason: code };

      const key = this.key(file);

      if (!this.isDir(dirname(key))) return { ok: false, reason: "ENOENT" };

      if (this.tree.has(key)) return { ok: false, reason: "EEXIST" };

      this.tree.set(key, { kind: "file", data: Buffer.from(bytes) });
      this.writes.push(key);

      return { ok: true };
    },
  };

  readonly scanFs: VoicePackFileSystem = {
    listDirectories: (dir) => this.children(dir).filter((name) => this.isDir(join(this.key(dir), name))),
    readTextFile: (file) => {
      const entry = this.tree.get(this.key(file));

      if (entry === undefined) return { ok: false, missing: true, reason: "ENOENT" };

      if (entry.kind === "dir") return { ok: false, missing: false, reason: "EISDIR" };

      return { ok: true, text: entry.data.toString() };
    },
    listMp3Files: (packDir) => {
      const key = this.key(packDir);

      return this.subtree(key)
        .filter((k) => k !== key && this.tree.get(k)?.kind === "file" && k.toLowerCase().endsWith(".mp3"))
        .map((k) =>
          k
            .slice(key.length + 1)
            .split(sep)
            .join("/"),
        )
        .sort();
    },
  };

  readonly readerFs: VoicePackInstallerFileSystem = {
    readFile: async (file) => {
      const code = this.fault("readFile", file);

      if (code !== undefined) return undefined;

      const key = this.key(file);
      const entry = this.tree.get(key);

      if (entry?.kind !== "file") return undefined;

      const bytes = new Uint8Array(entry.data);

      if (this.corruptOnRead.has(key)) bytes[0] ^= 0xff;

      return bytes;
    },
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function text(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

function manifestText(id = ID, version = "1.1.0"): string {
  return JSON.stringify({ schema: 1, id, label: "Luca", version, voices: [{ id, label: "Luca" }] });
}

function archiveOf(files: Record<string, string | Uint8Array>): Uint8Array<ArrayBuffer> {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, c]) => [name, typeof c === "string" ? text(c) : c])),
  );
}

const NEW_FILES = {
  "voice-pack.json": manifestText(),
  "voice/luca/flags/blue-01.mp3": "NEW",
  "voice/luca/flags/blue-02.mp3": "NEW2",
};
const NEW_ARCHIVE = archiveOf(NEW_FILES);
const NEW_SHA = sha256(NEW_ARCHIVE);

const OLD_PROVENANCE = JSON.stringify({
  schema: 1,
  source: "catalog",
  id: ID,
  version: "1.0.0",
  sha256: OLD_SHA,
  url: "https://example.test/luca-1.0.0.zip",
  installedAt: "2026-01-01T00:00:00.000Z",
});
const OLD_FILES = {
  ".install.json": OLD_PROVENANCE,
  "voice-pack.json": manifestText(ID, "1.0.0"),
  "voice/luca/flags/blue-01.mp3": "OLD",
};

function entryFor(archive: Uint8Array, overrides: Partial<VoicePackCatalogEntry> = {}): VoicePackCatalogEntry {
  return {
    id: ID,
    label: "Luca",
    version: "1.1.0",
    voices: [{ id: ID, label: "Luca" }],
    bytes: archive.length,
    sha256: sha256(archive),
    url: URL_,
    ...overrides,
  };
}

function installOldPack(disk: FakeDisk): void {
  for (const [path, content] of Object.entries(OLD_FILES)) disk.file(join(PACK_DIR, ...path.split("/")), content);
}

function fetchReturning(archive: Uint8Array<ArrayBuffer>) {
  return vi.fn(async (): Promise<Response> => new Response(archive, { status: 200 }));
}

/** A body that hands out `chunks` one per pull, ticking `onChunk` before each, and can drop the connection. */
function fetchStreaming(chunks: readonly Uint8Array[], opts: { failAfter?: number; onChunk?: () => void } = {}) {
  return vi.fn(async (): Promise<Response> => {
    let index = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (opts.failAfter !== undefined && index >= opts.failAfter) {
            controller.error(new Error("ECONNRESET"));

            return;
          }

          const chunk = chunks[index];

          if (chunk !== undefined) {
            opts.onChunk?.();
            controller.enqueue(chunk);
            index += 1;

            return;
          }

          controller.close();
        },
      },
      { highWaterMark: 0 },
    );

    return new Response(stream, { status: 200 });
  });
}

type HarnessOptions = {
  disk?: FakeDisk;
  entries?: readonly VoicePackCatalogEntry[];
  fetchImpl?: typeof fetch;
  bundled?: readonly BundledVoicePack[];
  now?: () => number;
  pluginVersion?: string;
  deps?: Partial<VoicePackInstallerDeps>;
};

function harness(opts: HarnessOptions = {}) {
  const disk = opts.disk ?? new FakeDisk();
  disk.dir(ROOT);
  const storage = createVoicePackStorage({ root: ROOT, fs: disk.storageFs, logger: logger as never });
  const calls: string[] = [];
  const published: VoicePackStatus[] = [];
  const banners = new Map<string, { level: string; message: string }>();
  const entries = opts.entries ?? [];
  const now = opts.now ?? (() => 1_700_000_000_000);
  const fetchImpl = opts.fetchImpl ?? fetchReturning(NEW_ARCHIVE);

  // The catalog's verdicts are recomputed from the disk on every `get`, the
  // way the real service does — through the installer's own exported reader,
  // which is what the plugin hands the service.
  const catalog = {
    get: vi.fn(async (): Promise<VoicePackCatalogState> => ({
      state: "ok",
      packs: entries.map((entry) => ({
        id: entry.id,
        label: entry.label,
        version: entry.version,
        bytes: entry.bytes,
        verdict:
          readInstalledVoicePackSha(disk.scanFs, join(ROOT, entry.id), entry.id) === entry.sha256
            ? "installed"
            : "install",
      })),
      checkedAt: now(),
    })),
    entry: vi.fn(async (id: string) => entries.find((entry) => entry.id === id)),
  };

  const deps: VoicePackInstallerDeps = {
    storage: {
      ...storage,
      promote: async (id, dir) => {
        calls.push("promote");

        return storage.promote(id, dir);
      },
    },
    packFs: disk.scanFs,
    archiveFs: disk.archiveFs,
    fs: disk.readerFs,
    catalog,
    ...(opts.bundled === undefined ? {} : { bundled: opts.bundled }),
    getPluginVersion: () => opts.pluginVersion ?? "3.2.0",
    stopPlayback: vi.fn(() => {
      calls.push("stopPlayback");
    }),
    publishStatus: vi.fn((status: VoicePackStatus) => {
      published.push(status);
    }),
    // The `_warnings` store, as the plugin binds it: keyed by id, latest wins.
    warnings: {
      set: vi.fn((id: string, level: string, message: string) => {
        banners.set(id, { level, message });
      }),
      clear: vi.fn((id: string) => {
        banners.delete(id);
      }),
    },
    refreshPacks: vi.fn(() => {
      calls.push("refreshPacks");
    }),
    now,
    fetchImpl,
    logger: logger as never,
  };
  Object.assign(deps, opts.deps ?? {});

  return {
    disk,
    storage,
    installer: createVoicePackInstaller(deps),
    deps,
    catalog,
    fetchImpl,
    calls,
    published,
    banners,
  };
}

function scanned(disk: FakeDisk, reservedVoices: readonly string[] = []) {
  return scanVoicePacks({ root: ROOT, fs: disk.scanFs, reservedVoices });
}

/** The property under test, in one place: the installed pack is exactly as it was, and nothing was moved aside. */
function expectOldPackUntouched(disk: FakeDisk): void {
  expect(disk.files(PACK_DIR)).toEqual(OLD_FILES);
  expect(disk.children(TRASH)).toEqual([]);
  expect(readInstalledVoicePackSha(disk.scanFs, PACK_DIR, ID)).toBe(OLD_SHA);
}

/** Nothing left in `.tmp` — no archive, no staging tree, no lock. */
function expectNoDebris(disk: FakeDisk): void {
  expect(disk.children(TMP)).toEqual([]);
}

/** The real scanner still sees exactly the old pack, and nothing else. */
function expectScannerSeesOnlyOldPack(disk: FakeDisk): void {
  const { packs, problems } = scanned(disk);

  expect(problems).toEqual([]);
  expect(packs.map((pack) => `${pack.id}@${pack.version}`)).toEqual(["luca@1.0.0"]);
  expect(packs[0]?.clips).toEqual(["voice/luca/flags/blue-01.mp3"]);
}

function phases(published: readonly VoicePackStatus[], id = ID): (string | undefined)[] {
  return published.map((status) => status.installs[id]?.phase);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("createVoicePackInstaller — deciding", () => {
  it("downloads nothing when the installed digest matches the catalog", async () => {
    const disk = new FakeDisk();
    disk.file(join(PACK_DIR, VOICE_PACK_PROVENANCE_FILE), OLD_PROVENANCE.replace(OLD_SHA, NEW_SHA));
    disk.file(join(PACK_DIR, "voice", "luca", "flags", "blue-01.mp3"), "SAME");
    const { installer, fetchImpl, published } = harness({ disk, entries: [entryFor(NEW_ARCHIVE)] });

    await expect(installer.install(ID)).resolves.toEqual({ ok: true, outcome: "unchanged" });

    expect(fetchImpl).not.toHaveBeenCalled();
    expectNoDebris(disk);
    expect(disk.files(PACK_DIR)["voice/luca/flags/blue-01.mp3"]).toBe("SAME");
    expect(published.at(-1)?.installs).toEqual({});
  });

  it("refuses something that is not a pack id before looking anything up, and says so in the log", async () => {
    const { installer, catalog, fetchImpl, published } = harness();

    await expect(installer.install("../luca")).resolves.toMatchObject({ ok: false, code: "invalid-id" });

    expect(catalog.entry).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    // Unreachable from the page, so a programming error: logged, and NOT
    // published — a record keyed by a non-id would render on no row and be
    // cleared by nothing.
    expect(logger.warn).toHaveBeenCalledWith("Voice pack install refused: not a pack id");
    expect(published).toEqual([]);
  });

  it("refuses a pack the catalog does not list, and records the failure", async () => {
    const { installer, fetchImpl, published } = harness({ entries: [] });

    const result = await installer.install(ID);

    expect(result).toMatchObject({ ok: false, code: "not-in-catalog" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(published.at(-1)?.installs[ID]).toEqual({ phase: "failed", error: (result as { reason: string }).reason });
  });

  it("refuses a pack that needs a newer plugin", async () => {
    const { installer, fetchImpl } = harness({
      entries: [entryFor(NEW_ARCHIVE, { minPluginVersion: "9.0.0" })],
      pluginVersion: "3.2.0",
    });

    await expect(installer.install(ID)).resolves.toMatchObject({
      ok: false,
      code: "unsupported",
      reason: "This pack needs iRaceDeck 9.0.0 or newer.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-checks after the lock, and downloads nothing when another plugin has just installed the pack", async () => {
    const disk = new FakeDisk();
    installOldPack(disk);
    const { installer, fetchImpl } = harness({ disk, entries: [entryFor(NEW_ARCHIVE)] });
    // The other ecosystem's plugin held the lock, finished, and left a stale
    // lock file behind: our first exclusive create finds it, the takeover
    // succeeds, and by then the pack on disk is the catalog's.
    const inner = disk.storageFs.createExclusive;
    let attempts = 0;
    disk.storageFs.createExclusive = async (file, lockText) => {
      attempts += 1;

      if (attempts === 1) {
        disk.file(file, JSON.stringify({ pid: 1, acquiredAt: 0, heartbeatAt: 0 }));
        disk.file(join(PACK_DIR, VOICE_PACK_PROVENANCE_FILE), OLD_PROVENANCE.replace(OLD_SHA, NEW_SHA));

        return { ok: true, created: false };
      }

      return inner(file, lockText);
    };

    // A takeover falls through to the lock's poll sleep like any other retry
    // (the storage module says why); skip the two real seconds it would cost.
    vi.useFakeTimers({ toFake: ["setTimeout"] });

    try {
      const pending = installer.install(ID);

      // Let the install reach the sleep — every step before it resolves
      // within the microtask queue — then run the sleep out.
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
      await vi.advanceTimersByTimeAsync(VOICE_PACK_LOCK_POLL_MS);

      await expect(pending).resolves.toEqual({ ok: true, outcome: "unchanged" });
    } finally {
      vi.useRealTimers();
    }

    expect(attempts).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(disk.has(join(TMP, `${ID}.lock`))).toBe(false);
  });
});

describe("createVoicePackInstaller — a successful install", () => {
  it("replaces the installed pack, records provenance, stops playback before the swap and refreshes after it", async () => {
    const disk = new FakeDisk();
    installOldPack(disk);
    const entry = entryFor(NEW_ARCHIVE);
    const { installer, fetchImpl, calls, published, deps } = harness({ disk, entries: [entry] });

    await expect(installer.install(ID)).resolves.toEqual({ ok: true, outcome: "updated" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(URL_, expect.anything());

    // The new pack is live, with the installer's record inside it.
    const live = disk.files(PACK_DIR);
    const record = parseVoicePackProvenance(live[VOICE_PACK_PROVENANCE_FILE] ?? "");
    expect(record).toEqual({
      schema: 1,
      source: "catalog",
      id: ID,
      version: "1.1.0",
      sha256: NEW_SHA,
      url: URL_,
      installedAt: new Date(deps.now?.() ?? 0).toISOString(),
    });
    delete live[VOICE_PACK_PROVENANCE_FILE];
    expect(live).toEqual(NEW_FILES);

    // The old pack is intact in the trash, not deleted — deletion is the sweep's.
    const trashed = disk.children(TRASH);
    expect(trashed).toHaveLength(1);
    expect(trashed[0]).toMatch(/^luca\.\d+$/);
    expect(disk.files(join(TRASH, trashed[0] as string))).toEqual(OLD_FILES);

    expectNoDebris(disk);
    expect(calls).toEqual(["stopPlayback", "promote", "refreshPacks"]);

    const { packs, problems } = scanned(disk);
    expect(problems).toEqual([]);
    expect(packs.map((pack) => `${pack.id}@${pack.version}`)).toEqual(["luca@1.1.0"]);

    // Every phase was published in order, the install then left `installs`,
    // and the catalog's verdict flipped on the final publish.
    expect(phases(published).filter((phase, i, all) => phase !== all[i - 1])).toEqual([
      "downloading",
      "verifying",
      "extracting",
      "swapping",
      undefined,
    ]);
    expect(published.at(-1)?.catalog).toMatchObject({ state: "ok", packs: [{ id: ID, verdict: "installed" }] });
  });

  it("reports a first install as installed, with nothing to trash", async () => {
    const disk = new FakeDisk();
    const { installer } = harness({ disk, entries: [entryFor(NEW_ARCHIVE)] });

    await expect(installer.install(ID)).resolves.toEqual({ ok: true, outcome: "installed" });

    expect(disk.children(TRASH)).toEqual([]);
    expect(readInstalledVoicePackSha(disk.scanFs, PACK_DIR, ID)).toBe(NEW_SHA);
  });
});

/**
 * The property the whole design exists to protect, one induced failure per
 * step. Each case asserts the same three things about the disk afterwards —
 * the old pack is byte-for-byte where it was, nothing is in the trash, `.tmp`
 * is empty — and, through the real scanner, that the old pack is still the
 * only pack the engine could load.
 */
describe("createVoicePackInstaller — the installed pack survives every failure", () => {
  function withOldPack(opts: Omit<HarnessOptions, "disk"> = {}) {
    const disk = new FakeDisk();
    installOldPack(disk);

    return harness({ disk, entries: [entryFor(NEW_ARCHIVE)], ...opts });
  }

  async function expectFailure(h: ReturnType<typeof harness>, code: string) {
    const result = await h.installer.install(ID);

    expect(result).toMatchObject({ ok: false, code });
    expect(h.published.at(-1)?.installs[ID]).toEqual({ phase: "failed", error: (result as { reason: string }).reason });
    expectOldPackUntouched(h.disk);
    expectNoDebris(h.disk);
    expectScannerSeesOnlyOldPack(h.disk);

    return result as { ok: false; code: string; reason: string; detail?: string };
  }

  it("when the request cannot be made", async () => {
    const h = withOldPack({ fetchImpl: vi.fn(async () => Promise.reject(new TypeError("fetch failed"))) });

    const result = await expectFailure(h, "download");

    expect(result.reason).toContain("internet connection");
    expect(h.calls).toEqual([]);
  });

  it("when the server answers an error", async () => {
    const h = withOldPack({ fetchImpl: vi.fn(async () => new Response(null, { status: 500 })) });

    await expectFailure(h, "download");

    expect(h.calls).toEqual([]);
  });

  it("when the connection drops partway through the body — and the partial archive is discarded", async () => {
    const chunks = [NEW_ARCHIVE.subarray(0, 64), NEW_ARCHIVE.subarray(64)];
    const h = withOldPack({ fetchImpl: fetchStreaming(chunks, { failAfter: 1 }) });

    const result = await expectFailure(h, "download");

    expect(result.detail).toContain("transport");
    expect(h.calls).toEqual([]);
  });

  it("when every byte arrives and the digest is wrong", async () => {
    const other = archiveOf({ ...NEW_FILES, "voice/luca/flags/blue-01.mp3": "TAMPERED" });
    // The cap is sized to the tampered archive so that EVERY byte arrives and
    // the digest, not the byte cap, is what refuses it.
    const h = withOldPack({
      entries: [entryFor(NEW_ARCHIVE, { bytes: other.length })],
      fetchImpl: fetchReturning(other),
    });

    const result = await expectFailure(h, "verify");

    expect(result.reason).toContain("does not match the catalog");
    expect(h.calls).toEqual([]);
  });

  it("when the archive read back from disk is not the one that was downloaded", async () => {
    const h = withOldPack();
    h.disk.corruptOnRead.add(h.disk.key(join(TMP, `${ID}.${NEW_SHA}.zip`)));

    const result = await expectFailure(h, "verify");

    expect(result.reason).toContain("changed on disk");
    expect(h.calls).toEqual([]);
  });

  it("when extraction is refused after files have already landed in the staging directory", async () => {
    // Two good entries, then a forged provenance record: the extractor writes
    // the first two before it sees the third and refuses the archive whole.
    const hostile = archiveOf({
      "voice-pack.json": manifestText(),
      "voice/luca/flags/blue-01.mp3": "NEW",
      ".install.json": '{"source":"catalog"}',
    });
    const h = withOldPack({ entries: [entryFor(hostile)], fetchImpl: fetchReturning(hostile) });
    const stagingDir = join(TMP, `${ID}.${sha256(hostile)}`);

    const result = await expectFailure(h, "extract");

    // The debris existed — the extractor's footprint proves two files were
    // written under the staging directory — and it is gone.
    expect(h.disk.writes).toEqual([
      h.disk.key(join(stagingDir, "voice-pack.json")),
      h.disk.key(join(stagingDir, "voice", "luca", "flags", "blue-01.mp3")),
    ]);
    expect(h.disk.has(stagingDir)).toBe(false);
    expect(result.reason).toContain("hidden");
    expect(h.calls).toEqual([]);
  });

  it("when the download is not a zip at all", async () => {
    const junk = text("this is not an archive");
    const h = withOldPack({ entries: [entryFor(junk)], fetchImpl: fetchReturning(junk) });

    const result = await expectFailure(h, "extract");

    expect(result.reason).toContain("not a zip");
  });

  it("when staging debris cannot be discarded: it is never a pack, and the next sweep removes it", async () => {
    const hostile = archiveOf({ "voice-pack.json": manifestText(), ".install.json": "{}" });
    const h = withOldPack({ entries: [entryFor(hostile)], fetchImpl: fetchReturning(hostile) });
    const stagingDir = h.disk.key(join(TMP, `${ID}.${sha256(hostile)}`));
    // Only once it exists: `createStagingDir` empties the path first, and that
    // removal must succeed for the extraction to be reached at all.
    h.disk.faults.remove = (path) => (path === stagingDir && h.disk.has(stagingDir) ? "EBUSY" : undefined);

    const result = await h.installer.install(ID);

    expect(result).toMatchObject({ ok: false, code: "extract" });
    expectOldPackUntouched(h.disk);
    expect(h.disk.has(stagingDir)).toBe(true);
    // A dot-directory's contents are not a pack, whatever they contain.
    expectScannerSeesOnlyOldPack(h.disk);

    delete h.disk.faults.remove;

    await expect(h.installer.sweep()).resolves.toMatchObject({ removed: 1, failed: 0 });
    expectNoDebris(h.disk);
    expectOldPackUntouched(h.disk);
  });

  it("when the archive unpacked completely but is a different pack than the one requested", async () => {
    const other = archiveOf({ ...NEW_FILES, "voice-pack.json": manifestText("other") });
    const h = withOldPack({ entries: [entryFor(other)], fetchImpl: fetchReturning(other) });

    const result = await expectFailure(h, "invalid-pack");

    // Every file was written — this refusal comes AFTER a complete extract.
    expect(h.disk.writes).toHaveLength(3);
    expect(result.reason).toContain('the pack "other", not "luca"');
    expect(h.calls).toEqual([]);
  });

  it("when the archive carries no voice-pack.json", async () => {
    const bare = archiveOf({ "voice/luca/flags/blue-01.mp3": "NEW" });
    const h = withOldPack({ entries: [entryFor(bare)], fetchImpl: fetchReturning(bare) });

    const result = await expectFailure(h, "invalid-pack");

    expect(result.reason).toContain("no voice-pack.json");
  });

  it("when no clip sits where the engine can reach it", async () => {
    // One level short of `voice/<id>/<group>/<name>.mp3`: the scanner would
    // install this and report it mute, which is why it is refused HERE.
    const shallow = archiveOf({ "voice-pack.json": manifestText(), "voice/luca/sample.mp3": "x" });
    const h = withOldPack({ entries: [entryFor(shallow)], fetchImpl: fetchReturning(shallow) });

    const result = await expectFailure(h, "invalid-pack");

    expect(result.reason).toContain("no playable clips");
  });

  it("when the provenance record cannot be written", async () => {
    const h = withOldPack();
    h.disk.faults.writeTextFile = (path) => (path.endsWith(VOICE_PACK_PROVENANCE_FILE) ? "ENOSPC" : undefined);

    await expectFailure(h, "storage");

    expect(h.calls).toEqual([]);
  });

  it("when the installed pack cannot be moved aside: it stays live, and the staged copy is discarded", async () => {
    const h = withOldPack();
    const packKey = h.disk.key(PACK_DIR);
    h.disk.faults.rename = (from) => (from === packKey ? "EPERM" : undefined);

    const result = await expectFailure(h, "promote");

    expect(result.reason).toContain("left unchanged");
    // Playback was stopped for the swap, the swap failed, nothing was rescanned.
    expect(h.calls).toEqual(["stopPlayback", "promote"]);
  });

  it("when the staged pack cannot be moved into place: the old one is put back", async () => {
    const h = withOldPack();
    const packKey = h.disk.key(PACK_DIR);
    const stagingKey = h.disk.key(join(TMP, `${ID}.${NEW_SHA}`));
    h.disk.faults.rename = (from, to) => (from === stagingKey && to === packKey ? "EACCES" : undefined);

    const result = await expectFailure(h, "promote");

    expect(result.reason).toContain("left unchanged");
    expect(h.calls).toEqual(["stopPlayback", "promote"]);
  });

  it("when the old pack cannot be put back either: it is intact in the trash, the engine is refreshed, and the sweep keeps it", async () => {
    const h = withOldPack();
    const packKey = h.disk.key(PACK_DIR);
    // Both renames INTO the live path fail — the install and the restore —
    // which is the shape a volume in trouble, or a crash mid-swap, leaves.
    h.disk.faults.rename = (_from, to) => (to === packKey ? "EIO" : undefined);

    const result = await h.installer.install(ID);

    expect(result).toMatchObject({ ok: false, code: "promote" });
    expect(result).toMatchObject({ reason: expect.stringContaining(".trash") });
    expect(h.disk.has(PACK_DIR)).toBe(false);
    const trashed = h.disk.children(TRASH);
    expect(trashed).toHaveLength(1);
    expect(h.disk.files(join(TRASH, trashed[0] as string))).toEqual(OLD_FILES);
    expectNoDebris(h.disk);
    // The engine must stop advertising clips at a path that is now empty.
    expect(h.calls).toEqual(["stopPlayback", "promote", "refreshPacks"]);
    expect(scanned(h.disk).packs).toEqual([]);

    // The only copy of the pack is protected from the sweep for as long as no
    // installed copy exists — end to end, through the installer's own sweep.
    await expect(h.installer.sweep()).resolves.toMatchObject({ kept: 1, removed: 0 });
    expect(h.disk.files(join(TRASH, trashed[0] as string))).toEqual(OLD_FILES);

    // Once a copy is installed again, the trashed one has done its job.
    delete h.disk.faults.rename;
    await expect(h.installer.install(ID)).resolves.toEqual({ ok: true, outcome: "installed" });
    await expect(h.installer.sweep()).resolves.toMatchObject({ kept: 0, removed: 1 });
    expect(h.disk.children(TRASH)).toEqual([]);
  });

  it("after a crash between the two renames, the next start's sweep keeps the trashed copy", async () => {
    // The state a crash leaves: the old pack moved aside, nothing at the live
    // path, and no process left to roll it back.
    const disk = new FakeDisk();
    disk.dir(TMP);

    for (const [path, content] of Object.entries(OLD_FILES))
      disk.file(join(TRASH, "luca.1700000000000", path), content);

    const h = harness({ disk });

    await expect(h.installer.sweep()).resolves.toEqual({ removed: 0, failed: 0, kept: 1 });
    expect(disk.files(join(TRASH, "luca.1700000000000"))).toEqual(OLD_FILES);
  });
});

describe("createVoicePackInstaller — one operation per pack at a time", () => {
  it("a second install of the same pack joins the one in flight rather than starting a second download", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      await gate;

      return new Response(NEW_ARCHIVE);
    });
    const { installer } = harness({ entries: [entryFor(NEW_ARCHIVE)], fetchImpl });

    const first = installer.install(ID);
    const second = installer.install(ID);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, outcome: "installed" },
      { ok: true, outcome: "installed" },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a removal while an install of the same pack is in flight is refused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      await gate;

      return new Response(NEW_ARCHIVE);
    });
    const { installer, disk, banners } = harness({ entries: [entryFor(NEW_ARCHIVE)], fetchImpl });

    const install = installer.install(ID);

    await expect(installer.remove(ID)).resolves.toMatchObject({ ok: false, code: "busy" });
    // Said where the user is looking, and as information rather than a fault.
    expect(banners.get(`voice-pack-remove:${ID}`)).toEqual({
      level: "info",
      message: `Voice pack "${ID}" was not removed. This pack is being installed. Wait for it to finish and try again.`,
    });

    release();
    await expect(install).resolves.toEqual({ ok: true, outcome: "installed" });
    expect(disk.has(PACK_DIR)).toBe(true);
    // The install settled, so the banner has nothing left to describe.
    expect(banners.has(`voice-pack-remove:${ID}`)).toBe(false);
  });

  it("retires the 'being installed' banner when that install fails, too", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      await gate;

      throw new TypeError("fetch failed");
    });
    const { installer, banners } = harness({ entries: [entryFor(NEW_ARCHIVE)], fetchImpl });

    const install = installer.install(ID);
    await installer.remove(ID);
    expect(banners.has(`voice-pack-remove:${ID}`)).toBe(true);

    release();
    await expect(install).resolves.toMatchObject({ ok: false, code: "download" });
    expect(banners.has(`voice-pack-remove:${ID}`)).toBe(false);
  });

  it("a second removal of the same pack joins the one in flight rather than calling it an install", async () => {
    const disk = new FakeDisk();
    installOldPack(disk);
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const { installer, banners } = harness({
      disk,
      deps: {
        stopPlayback: vi.fn(async () => {
          await gate;
        }),
      },
    });

    const first = installer.remove(ID);
    const second = installer.remove(ID);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, removed: true },
      { ok: true, removed: true },
    ]);
    expect(disk.children(TRASH)).toHaveLength(1);
    expect(banners.size).toBe(0);
  });

  it("an install refused because a removal is in flight says so on the row, until the removal completes", async () => {
    const disk = new FakeDisk();
    installOldPack(disk);
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const { installer, published } = harness({
      disk,
      entries: [entryFor(NEW_ARCHIVE)],
      deps: {
        stopPlayback: vi.fn(async () => {
          await gate;
        }),
      },
    });

    const removal = installer.remove(ID);

    await expect(installer.install(ID)).resolves.toMatchObject({ ok: false, code: "busy" });
    expect(published.at(-1)?.installs[ID]).toEqual({
      phase: "failed",
      error: "This pack is being removed. Wait a moment and try again.",
    });
    expect(logger.warn).toHaveBeenCalledWith("Voice pack install failed");

    release();
    await expect(removal).resolves.toEqual({ ok: true, removed: true });
    // The removal's own success clears it; Retry after that installs.
    expect(published.at(-1)?.installs).toEqual({});
  });

  it("releases the pack once the install has settled, whichever way", async () => {
    const { installer } = harness({ entries: [] });

    await expect(installer.install(ID)).resolves.toMatchObject({ ok: false, code: "not-in-catalog" });
    await expect(installer.remove(ID)).resolves.toEqual({ ok: true, removed: false });
  });
});

describe("createVoicePackInstaller — status and progress", () => {
  it("publishes download progress at most once per interval, and the phase changes at once", async () => {
    let clock = 1_700_000_000_000;
    const step = VOICE_PACK_PROGRESS_INTERVAL_MS / 10;
    const chunks = Array.from({ length: 25 }, (_, i) => NEW_ARCHIVE.subarray(i * 10, i * 10 + 10));
    const fetchImpl = fetchStreaming(chunks, {
      onChunk: () => {
        clock += step;
      },
    });
    const entry = entryFor(NEW_ARCHIVE, { bytes: 250 });
    // Only the first 250 bytes travel, so the digest will not match — this
    // test is about the ticks that arrive before that verdict.
    const { installer, published } = harness({ entries: [entry], fetchImpl, now: () => clock });

    await installer.install(ID);

    const downloading = published.filter((status) => status.installs[ID]?.phase === "downloading");

    // The phase change, then one per full interval of chunks: at +100 ms
    // (the first tick after the change), +1100 and +2100 — never 25.
    expect(downloading).toHaveLength(4);
    expect(downloading.map((status) => status.installs[ID]?.receivedBytes)).toEqual([0, 10, 110, 210]);
    expect(downloading.every((status) => status.installs[ID]?.totalBytes === 250)).toBe(true);
  });

  it("carries the last known catalog state on every publish, and refreshCatalog re-asks", async () => {
    const { installer, catalog, published } = harness({ entries: [entryFor(NEW_ARCHIVE)] });

    expect(installer.status()).toEqual({ catalog: { state: "unknown" }, installs: {} });

    await expect(installer.refreshCatalog()).resolves.toMatchObject({ state: "ok" });

    expect(catalog.get).toHaveBeenCalledTimes(1);
    expect(published.at(-1)?.catalog).toMatchObject({ state: "ok", packs: [{ id: ID, verdict: "install" }] });

    installer.republishStatus();

    expect(published).toHaveLength(2);
    expect(published[1]).toEqual(published[0]);
  });

  it("hands out a copy of the installs, never the live map", async () => {
    const { installer } = harness({ entries: [] });

    await installer.install(ID);
    const snapshot = installer.status();
    delete snapshot.installs[ID];

    expect(installer.status().installs[ID]).toMatchObject({ phase: "failed" });
  });
});

describe("createVoicePackInstaller — never throws", () => {
  it("survives a throwing status setter, playback stop and refresh, and still installs", async () => {
    const disk = new FakeDisk();
    installOldPack(disk);
    const { installer } = harness({
      disk,
      entries: [entryFor(NEW_ARCHIVE)],
      deps: {
        publishStatus: () => {
          throw new Error("settings listener blew up");
        },
        stopPlayback: () => {
          throw new Error("audio engine gone");
        },
        refreshPacks: () => {
          throw new Error("scan blew up");
        },
      },
    });

    await expect(installer.install(ID)).resolves.toEqual({ ok: true, outcome: "updated" });
    expect(readInstalledVoicePackSha(disk.scanFs, PACK_DIR, ID)).toBe(NEW_SHA);
  });

  it("reports a throwing catalog as not-in-catalog and an unknown state", async () => {
    const { installer } = harness({
      deps: {
        catalog: {
          get: async () => {
            throw new Error("boom");
          },
          entry: async () => {
            throw new Error("boom");
          },
        },
      },
    });

    await expect(installer.install(ID)).resolves.toMatchObject({ ok: false, code: "not-in-catalog" });
    await expect(installer.refreshCatalog()).resolves.toEqual({ state: "unknown" });
  });

  it("reports a throwing version lookup as unsupported only when the pack actually pins a version", async () => {
    const pinned = harness({
      entries: [entryFor(NEW_ARCHIVE, { minPluginVersion: "1.0.0" })],
      deps: {
        getPluginVersion: () => {
          throw new Error("plugin config not initialised");
        },
      },
    });
    const unpinned = harness({
      entries: [entryFor(NEW_ARCHIVE)],
      deps: {
        getPluginVersion: () => {
          throw new Error("plugin config not initialised");
        },
      },
    });

    await expect(pinned.installer.install(ID)).resolves.toMatchObject({ ok: false, code: "unsupported" });
    await expect(unpinned.installer.install(ID)).resolves.toEqual({ ok: true, outcome: "installed" });
  });

  it("reports a throwing storage as an internal failure rather than rejecting", async () => {
    const { installer, published } = harness({
      entries: [entryFor(NEW_ARCHIVE)],
      deps: {
        storage: {
          root: ROOT,
          packDir: (id) => join(ROOT, id),
          openDownload: async () => {
            throw new Error("not a result");
          },
          createStagingDir: async () => ({ ok: false, code: "x" }),
          writeProvenance: async () => ({ ok: true }),
          promote: async () => ({ ok: false, step: "prepare", code: "x", previous: "untouched" }),
          retire: async () => ({ ok: true }),
          sweep: async () => {
            throw new Error("not a result");
          },
          acquireLock: async () => ({ acquired: false, release: async () => undefined }),
        },
      },
    });

    await expect(installer.install(ID)).resolves.toMatchObject({ ok: false, code: "internal" });
    expect(published.at(-1)?.installs[ID]?.phase).toBe("failed");
    await expect(installer.sweep()).resolves.toEqual({ removed: 0, failed: 0, kept: 0 });
  });
});

describe("createVoicePackInstaller — remove", () => {
  it("retires the pack to the trash, stops playback first, refreshes, and clears its failure", async () => {
    const disk = new FakeDisk();
    installOldPack(disk);
    const { installer, calls, published } = harness({
      disk,
      entries: [entryFor(NEW_ARCHIVE)],
      fetchImpl: vi.fn(async () => Promise.reject(new TypeError("fetch failed"))),
    });
    // A failure on record for this pack, from an earlier attempt.
    await expect(installer.install(ID)).resolves.toMatchObject({ ok: false, code: "download" });
    expect(published.at(-1)?.installs[ID]?.phase).toBe("failed");

    await expect(installer.remove(ID)).resolves.toEqual({ ok: true, removed: true });

    expect(disk.has(PACK_DIR)).toBe(false);
    const trashed = disk.children(TRASH);
    expect(trashed).toHaveLength(1);
    expect(trashed[0]).toMatch(/^luca\.\d+\.removed$/);
    expect(disk.files(join(TRASH, trashed[0] as string))).toEqual(OLD_FILES);
    expect(calls).toEqual(["stopPlayback", "refreshPacks"]);
    expect(published.at(-1)?.installs).toEqual({});
    expect(published.at(-1)?.catalog).toMatchObject({ packs: [{ id: ID, verdict: "install" }] });
  });

  it("reports nothing removed when the pack was not installed", async () => {
    const { installer } = harness();

    await expect(installer.remove(ID)).resolves.toEqual({ ok: true, removed: false });
  });

  it("reports a pack that cannot be moved, and leaves it where it is", async () => {
    const disk = new FakeDisk();
    installOldPack(disk);
    disk.faults.rename = (from) => (from === disk.key(PACK_DIR) ? "EBUSY" : undefined);
    const { installer, banners } = harness({ disk });

    await expect(installer.remove(ID)).resolves.toMatchObject({ ok: false, code: "storage" });
    expectOldPackUntouched(disk);
    // Said where the user is looking — the Installed Voices list has no row
    // state to carry a failure, so it is the page's banner, naming the pack
    // and what to do.
    expect(banners.get(`voice-pack-remove:${ID}`)).toEqual({
      level: "warning",
      message:
        `Voice pack "${ID}" was not removed. ` +
        "The pack could not be moved to the trash. Close anything that may be using its files and try again.",
    });
    expect(logger.warn).toHaveBeenCalledWith("Voice pack removal failed");
  });

  it("retires the removal banner once a later removal of the pack succeeds", async () => {
    const disk = new FakeDisk();
    installOldPack(disk);
    let held = true;
    disk.faults.rename = (from) => (held && from === disk.key(PACK_DIR) ? "EBUSY" : undefined);
    const { installer, banners } = harness({ disk });

    await installer.remove(ID);
    expect(banners.has(`voice-pack-remove:${ID}`)).toBe(true);

    held = false;
    await expect(installer.remove(ID)).resolves.toEqual({ ok: true, removed: true });
    expect(banners.has(`voice-pack-remove:${ID}`)).toBe(false);
  });

  it("retires the removal banner once an install replaces the pack instead", async () => {
    const disk = new FakeDisk();
    installOldPack(disk);
    let held = true;
    disk.faults.rename = (from) => (held && from === disk.key(PACK_DIR) ? "EBUSY" : undefined);
    const { installer, banners } = harness({ disk, entries: [entryFor(NEW_ARCHIVE)] });

    await installer.remove(ID);
    expect(banners.has(`voice-pack-remove:${ID}`)).toBe(true);

    held = false;
    await expect(installer.install(ID)).resolves.toEqual({ ok: true, outcome: "updated" });
    expect(banners.has(`voice-pack-remove:${ID}`)).toBe(false);
  });

  it("keeps one banner per pack, so two failures do not overwrite each other", async () => {
    const disk = new FakeDisk();
    installOldPack(disk);
    disk.dir(join(ROOT, "vixen"));
    disk.faults.rename = () => "EBUSY";
    const { installer, banners } = harness({ disk });

    await installer.remove(ID);
    await installer.remove("vixen");

    expect([...banners.keys()].sort()).toEqual([`voice-pack-remove:${ID}`, "voice-pack-remove:vixen"]);
  });

  it("survives a throwing banner store, and still reports the failure", async () => {
    const disk = new FakeDisk();
    installOldPack(disk);
    disk.faults.rename = (from) => (from === disk.key(PACK_DIR) ? "EBUSY" : undefined);
    const explode = () => {
      throw new Error("settings exploded");
    };
    const { installer } = harness({ disk, deps: { warnings: { set: explode, clear: explode } } });

    await expect(installer.remove(ID)).resolves.toMatchObject({ ok: false, code: "storage" });
    expect(logger.warn).toHaveBeenCalledWith("Voice packs: posting the removal banner threw; continuing");
  });

  it("refuses something that is not a pack id, and says so in the log", async () => {
    const { installer, banners } = harness();

    await expect(installer.remove("..")).resolves.toMatchObject({ ok: false, code: "invalid-id" });
    expect(logger.warn).toHaveBeenCalledWith("Voice pack removal refused: not a pack id");
    expect(banners.size).toBe(0);
  });
});

describe("createVoicePackInstaller — seed by copy", () => {
  const BUNDLED_SHA = "b".repeat(64);
  const BUNDLED_CLIPS = {
    "voice/default/flags/blue-01.mp3": "BUNDLED-1",
    "voice/default/position-number/4.mp3": "BUNDLED-2",
  };

  function bundledDefault(): BundledVoicePack {
    return {
      entry: {
        id: "default",
        label: "Default",
        version: "1.0.0",
        description: "The one that ships.",
        voices: [{ id: "default", label: "Default" }],
        bytes: 7_879_224,
        sha256: BUNDLED_SHA,
        url: "https://example.test/default-1.0.0.zip",
      },
      audioDir: AUDIO_DIR,
    };
  }

  function withBundle(disk: FakeDisk): void {
    for (const [path, content] of Object.entries(BUNDLED_CLIPS))
      disk.file(join(AUDIO_DIR, ...path.split("/")), content);

    // Not a voice: never copied.
    disk.file(join(AUDIO_DIR, "sfx", "tick.mp3"), "TICK");
  }

  it("copies the bundled pack into an empty folder with bundled-seed provenance, touching no network", async () => {
    const disk = new FakeDisk();
    withBundle(disk);
    const { installer, fetchImpl, calls, catalog } = harness({ disk, bundled: [bundledDefault()] });

    const result = await installer.seed();

    expect(result).toEqual({
      outcome: "attempted",
      results: [{ id: "default", result: { ok: true, outcome: "installed" } }],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(catalog.entry).not.toHaveBeenCalled();

    const live = disk.files(join(ROOT, "default"));
    const record = parseVoicePackProvenance(live[VOICE_PACK_PROVENANCE_FILE] ?? "");
    expect(record).toEqual({
      schema: 1,
      source: "bundled-seed",
      id: "default",
      version: "1.0.0",
      sha256: BUNDLED_SHA,
      installedAt: "2023-11-14T22:13:20.000Z",
    });
    expect(JSON.parse(live[VOICE_PACK_MANIFEST_FILE] ?? "")).toEqual({
      id: "default",
      label: "Default",
      schema: 1,
      version: "1.0.0",
      voices: [{ id: "default", label: "Default" }],
    });
    delete live[VOICE_PACK_PROVENANCE_FILE];
    delete live[VOICE_PACK_MANIFEST_FILE];
    expect(live).toEqual(BUNDLED_CLIPS);

    // No previous pack, so nothing to stop; the engine is refreshed.
    expect(calls).toEqual(["promote", "refreshPacks"]);
    expectNoDebris(disk);
  });

  it("writes the one source value the scanner exempts from the bundled-voice collision report", async () => {
    const disk = new FakeDisk();
    withBundle(disk);
    const { installer } = harness({ disk, bundled: [bundledDefault()] });

    await installer.seed();

    // With `default` bundled, the seeded copy loses the voice to the bundle —
    // expected — and is reported as NO PROBLEM, because its record says it is
    // our own seed. A sideload claiming the same id would be reported.
    //
    // It is still LISTED though (#1100), providing nothing: `voices` and
    // `clips` both empty, so it appears on the Installed Voices card without
    // putting a second `default` in the voice dropdown.
    const quiet = scanned(disk, ["default"]);
    expect(quiet.problems).toEqual([]);
    expect(quiet.packs).toHaveLength(1);
    expect(quiet.packs[0]).toMatchObject({ id: "default", voices: [], clips: [], provenance: "bundled-seed" });

    // Once the bundle is gone (the next release), the same copy is live.
    const live = scanned(disk, []);
    expect(live.problems).toEqual([]);
    expect(live.packs.map((pack) => `${pack.id}:${pack.provenance}`)).toEqual(["default:bundled-seed"]);
  });

  it("records the catalog's digest, so the next catalog check downloads nothing", async () => {
    const disk = new FakeDisk();
    withBundle(disk);
    const bundled = bundledDefault();
    const { installer, fetchImpl } = harness({ disk, bundled: [bundled], entries: [bundled.entry] });

    await installer.seed();

    await expect(installer.install("default")).resolves.toEqual({ ok: true, outcome: "unchanged" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing is bundled", async () => {
    const disk = new FakeDisk();
    const { installer } = harness({ disk });

    await expect(installer.seed()).resolves.toEqual({ outcome: "skipped", reason: "nothing-bundled" });
    expect(disk.children(ROOT)).toEqual([]);
  });

  it("does nothing when any pack is already present, even one that is not the bundled pack", async () => {
    const disk = new FakeDisk();
    withBundle(disk);
    installOldPack(disk);
    const { installer } = harness({ disk, bundled: [bundledDefault()] });

    await expect(installer.seed()).resolves.toEqual({ outcome: "skipped", reason: "packs-present" });
    expect(disk.has(join(ROOT, "default"))).toBe(false);
    expect(disk.writes).toEqual([]);
  });

  it("treats a folder holding only .tmp and .trash as empty", async () => {
    const disk = new FakeDisk();
    withBundle(disk);
    disk.dir(TMP);
    disk.dir(TRASH);
    const { installer } = harness({ disk, bundled: [bundledDefault()] });

    await expect(installer.seed()).resolves.toMatchObject({ outcome: "attempted" });
    expect(disk.has(join(ROOT, "default"))).toBe(true);
  });

  it("refuses a bundle with no clips for the voice, and leaves no debris", async () => {
    const disk = new FakeDisk();
    disk.file(join(AUDIO_DIR, "sfx", "tick.mp3"), "TICK");
    const { installer, published } = harness({ disk, bundled: [bundledDefault()] });

    const result = await installer.seed();

    expect(result).toMatchObject({
      outcome: "attempted",
      results: [{ id: "default", result: { ok: false, code: "invalid-pack" } }],
    });
    expect(disk.has(join(ROOT, "default"))).toBe(false);
    expectNoDebris(disk);
    expect(published.at(-1)?.installs.default?.phase).toBe("failed");
  });

  it("discards the staged copy when a clip cannot be read", async () => {
    const disk = new FakeDisk();
    withBundle(disk);
    disk.faults.readFile = (path) => (path.endsWith("4.mp3") ? "EIO" : undefined);
    const { installer } = harness({ disk, bundled: [bundledDefault()] });

    const result = await installer.seed();

    expect(result).toMatchObject({
      outcome: "attempted",
      results: [{ id: "default", result: { ok: false, code: "storage" } }],
    });
    expect(disk.has(join(ROOT, "default"))).toBe(false);
    expectNoDebris(disk);
  });

  it("holds the install lock while copying, so another plugin's startup sweep spares the half-copied tree", async () => {
    const disk = new FakeDisk();
    withBundle(disk);
    // The other ecosystem's plugin, started at the same login: its sweep runs
    // over the SHARED .tmp while this seed is between two clips. Unlocked,
    // that sweep deletes the staging tree — manifest and first clip — and the
    // copy carries on regardless, since every later write recreates its own
    // parents; the seed then fails on the missing manifest, and in the
    // orderings where the manifest survives it promotes a short pack.
    const otherPlugin = createVoicePackStorage({ root: ROOT, fs: disk.storageFs, logger: logger as never });
    let sweptDuringCopy: SweepVoicePacksResult | undefined;
    const { installer } = harness({
      disk,
      bundled: [bundledDefault()],
      deps: {
        fs: {
          readFile: async (file) => {
            if (sweptDuringCopy === undefined && file.endsWith("4.mp3")) sweptDuringCopy = await otherPlugin.sweep();

            return disk.readerFs.readFile(file);
          },
        },
      },
    });

    const result = await installer.seed();

    // The sweep saw a live lock and kept both the lock and the staging tree.
    expect(sweptDuringCopy).toEqual({ removed: 0, failed: 0, kept: 2 });
    expect(result).toEqual({
      outcome: "attempted",
      results: [{ id: "default", result: { ok: true, outcome: "installed" } }],
    });
    const live = disk.files(join(ROOT, "default"));
    delete live[VOICE_PACK_PROVENANCE_FILE];
    delete live[VOICE_PACK_MANIFEST_FILE];
    expect(live).toEqual(BUNDLED_CLIPS);
    // Released once the copy is promoted; nothing left in .tmp.
    expect(disk.has(join(TMP, "default.lock"))).toBe(false);
    expectNoDebris(disk);
  });

  describe("copies each bundled voice's callouts.json beside its clips (#1064)", () => {
    // Deliberately NOT what `JSON.stringify` would emit — key order, indent,
    // a trailing newline and a non-ASCII character in a comment — so a copy
    // that had been re-serialised on the way would read differently.
    const SCRIPT_TEXT = [
      "{",
      '  "schema": 1,',
      '  "pools": {},',
      '  "frames": {},',
      '  "scenarios": {',
      '    "flag-green": {',
      '      "comment": "Green — go racing",',
      '      "sequence": ["pool:flag-green"]',
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    const SCRIPT_PATH = "voice/default/callouts.json";

    function withBundledScript(disk: FakeDisk, text = SCRIPT_TEXT): void {
      disk.file(join(AUDIO_DIR, ...SCRIPT_PATH.split("/")), text);
    }

    it("lands the file byte for byte where the scanner reads it", async () => {
      const disk = new FakeDisk();
      withBundle(disk);
      withBundledScript(disk);
      const { installer } = harness({ disk, bundled: [bundledDefault()] });

      await expect(installer.seed()).resolves.toEqual({
        outcome: "attempted",
        results: [{ id: "default", result: { ok: true, outcome: "installed" } }],
      });

      const live = disk.files(join(ROOT, "default"));
      expect(live[SCRIPT_PATH]).toBe(SCRIPT_TEXT);
      delete live[VOICE_PACK_PROVENANCE_FILE];
      delete live[VOICE_PACK_MANIFEST_FILE];
      delete live[SCRIPT_PATH];
      expect(live).toEqual(BUNDLED_CLIPS);
      // Through the extractor's write port, like every other staged file.
      expect(disk.writes.some((path) => path.endsWith(join("voice", "default", "callouts.json")))).toBe(true);

      // The real scanner, once the bundle is gone, finds a scripted voice.
      const { packs, problems } = scanned(disk, []);
      expect(problems).toEqual([]);
      expect(packs[0]?.voices[0]?.script).toMatchObject({ schema: 1, scenarios: { "flag-green": {} } });
      expectNoDebris(disk);
    });

    it("seeds clips only for a bundled voice that has no script, which the scanner lists as clips-only", async () => {
      const disk = new FakeDisk();
      withBundle(disk);
      const { installer } = harness({ disk, bundled: [bundledDefault()] });

      await expect(installer.seed()).resolves.toMatchObject({
        results: [{ id: "default", result: { ok: true, outcome: "installed" } }],
      });

      expect(disk.has(join(ROOT, "default", "voice", "default", "callouts.json"))).toBe(false);

      const { packs, problems } = scanned(disk, []);
      expect(problems).toEqual([]);
      expect(packs[0]?.voices).toEqual([{ id: "default", label: "Default", script: null }]);
    });

    it("decides per voice: a two-voice bundle where only one has a script", async () => {
      const disk = new FakeDisk();
      withBundle(disk);
      withBundledScript(disk);
      disk.file(join(AUDIO_DIR, "voice", "second", "flags", "blue-01.mp3"), "SECOND-1");
      const bundled = bundledDefault();
      bundled.entry.voices = [
        { id: "default", label: "Default" },
        { id: "second", label: "Second" },
      ];
      const { installer } = harness({ disk, bundled: [bundled] });

      await expect(installer.seed()).resolves.toMatchObject({
        results: [{ id: "default", result: { ok: true, outcome: "installed" } }],
      });

      const live = disk.files(join(ROOT, "default"));
      expect(live[SCRIPT_PATH]).toBe(SCRIPT_TEXT);
      expect(live["voice/second/callouts.json"]).toBeUndefined();
      expect(live["voice/second/flags/blue-01.mp3"]).toBe("SECOND-1");
    });

    it("discards the staged copy when a bundled script exists but cannot be read, rather than seeding a mute pack", async () => {
      // A script that is there but unopenable is not "no script": seeding the
      // clips alone would leave a copy that, once the bundle is dropped, is a
      // voice with every callout skipped and nothing saying why — and the
      // seed never runs again into a folder that holds a pack. Failing keeps
      // the folder empty, so the next start tries again.
      const disk = new FakeDisk();
      withBundle(disk);
      // A directory at the file's path: the scanner's port answers EISDIR,
      // which is a read failure that is not `missing`.
      disk.dir(join(AUDIO_DIR, ...SCRIPT_PATH.split("/")));
      const { installer } = harness({ disk, bundled: [bundledDefault()] });

      const result = await installer.seed();

      expect(result).toMatchObject({
        outcome: "attempted",
        results: [{ id: "default", result: { ok: false, code: "storage" } }],
      });
      expect(disk.has(join(ROOT, "default"))).toBe(false);
      expectNoDebris(disk);
    });

    it("copies the script without validating it — the scanner is the judge, on the next scan", async () => {
      // The seed's job is a faithful copy of what the build shipped. Whether
      // that is a valid script is the scanner's call, and a malformed one is
      // reported there as a problem on the voice — which is exactly the
      // signal the packaging bug should produce.
      const disk = new FakeDisk();
      withBundle(disk);
      withBundledScript(disk, "{not json");
      const { installer } = harness({ disk, bundled: [bundledDefault()] });

      await expect(installer.seed()).resolves.toMatchObject({
        results: [{ id: "default", result: { ok: true, outcome: "installed" } }],
      });
      expect(disk.files(join(ROOT, "default"))[SCRIPT_PATH]).toBe("{not json");
      expect(scanned(disk, []).problems.map((problem) => problem.reason)).toEqual([
        expect.stringContaining("callouts.json is not valid JSON"),
      ]);
    });
  });

  it("copies nothing when the other plugin seeded the pack while this one waited for the lock", async () => {
    const disk = new FakeDisk();
    withBundle(disk);
    const { installer } = harness({ disk, bundled: [bundledDefault()] });
    // The other plugin finishes between this one's "is the folder empty?"
    // check and its lock: by the time the lock is ours, the pack is in place
    // with the catalog's digest recorded — the same re-check the install
    // path makes after ITS lock.
    const inner = disk.storageFs.createExclusive;
    disk.storageFs.createExclusive = async (file, lockText) => {
      disk.file(
        join(ROOT, "default", VOICE_PACK_PROVENANCE_FILE),
        JSON.stringify({
          schema: 1,
          source: "bundled-seed",
          id: "default",
          version: "1.0.0",
          sha256: BUNDLED_SHA,
          installedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      disk.file(join(ROOT, "default", "voice", "default", "flags", "blue-01.mp3"), "THEIRS");

      return inner(file, lockText);
    };

    await expect(installer.seed()).resolves.toEqual({
      outcome: "attempted",
      results: [{ id: "default", result: { ok: true, outcome: "unchanged" } }],
    });
    expect(disk.writes).toEqual([]);
    expect(disk.files(join(ROOT, "default"))["voice/default/flags/blue-01.mp3"]).toBe("THEIRS");
    expect(disk.has(join(TMP, "default.lock"))).toBe(false);
  });
});

describe("validateStagedVoicePack", () => {
  const written = ["voice-pack.json", "voice/luca/flags/blue-01.mp3"];

  it("accepts a manifest for the requested pack with a reachable clip", () => {
    const result = validateStagedVoicePack(ID, { ok: true, text: manifestText() }, written);

    expect(result).toMatchObject({ ok: true, manifest: { id: ID, version: "1.1.0" } });
  });

  it("tells a missing manifest apart from an unreadable one", () => {
    expect(validateStagedVoicePack(ID, { ok: false, missing: true, reason: "ENOENT" }, written)).toEqual({
      ok: false,
      reason: "it has no voice-pack.json",
    });
    expect(validateStagedVoicePack(ID, { ok: false, missing: false, reason: "EACCES" }, written)).toEqual({
      ok: false,
      reason: "its voice-pack.json could not be read (EACCES)",
    });
  });

  it("names the field a malformed manifest broke on", () => {
    const result = validateStagedVoicePack(ID, { ok: true, text: '{"schema":1,"id":"luca"}' }, written);

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("label") });
  });

  it("refuses a pack that disagrees with the entry that offered it", () => {
    expect(validateStagedVoicePack(ID, { ok: true, text: manifestText("other") }, written)).toEqual({
      ok: false,
      reason: 'it is the pack "other", not "luca"',
    });
  });

  it("requires a clip at pool depth for at least one declared voice", () => {
    const shallow = ["voice-pack.json", "voice/luca/sample.mp3"];
    const otherVoice = ["voice-pack.json", "voice/other/flags/blue-01.mp3"];

    expect(validateStagedVoicePack(ID, { ok: true, text: manifestText() }, shallow)).toMatchObject({ ok: false });
    expect(validateStagedVoicePack(ID, { ok: true, text: manifestText() }, otherVoice)).toMatchObject({ ok: false });
  });
});

describe("readInstalledVoicePackSha", () => {
  it("answers the recorded digest only for a record naming the same pack", () => {
    const disk = new FakeDisk();
    installOldPack(disk);

    expect(readInstalledVoicePackSha(disk.scanFs, PACK_DIR, ID)).toBe(OLD_SHA);
    // A folder copied from another pack carries the other pack's record.
    expect(readInstalledVoicePackSha(disk.scanFs, PACK_DIR, "other")).toBeUndefined();
  });

  it("answers nothing for a sideload or an unusable record", () => {
    const disk = new FakeDisk();
    disk.file(join(ROOT, "hand", "voice-pack.json"), manifestText("hand"));
    disk.file(join(ROOT, "junk", VOICE_PACK_PROVENANCE_FILE), "not json");

    expect(readInstalledVoicePackSha(disk.scanFs, join(ROOT, "hand"), "hand")).toBeUndefined();
    expect(readInstalledVoicePackSha(disk.scanFs, join(ROOT, "junk"), "junk")).toBeUndefined();
  });
});

describe("createVoicePackInstallerFileSystem", () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a file's bytes, and answers nothing for a missing one", async () => {
    dir = mkdtempSync(join(tmpdir(), "ird-installer-"));
    writeFileSync(join(dir, "a.bin"), Buffer.from([1, 2, 3]));
    const fs = createVoicePackInstallerFileSystem(logger as never);

    expect(Array.from((await fs.readFile(join(dir, "a.bin"))) ?? [])).toEqual([1, 2, 3]);
    await expect(fs.readFile(join(dir, "missing.bin"))).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });
});
