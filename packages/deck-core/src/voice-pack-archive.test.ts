import { UnzipInflate } from "fflate";
import { relative, resolve, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCountingDecoder,
  extractVoicePackArchive,
  isInsideDirectory,
  VOICE_PACK_ARCHIVE_LIMITS,
  VOICE_PACK_ARCHIVE_MAX_NAME_LENGTH,
  VOICE_PACK_ARCHIVE_PUSH_BYTES,
  type VoicePackArchiveFileSystem,
} from "./voice-pack-archive.js";

// ---------------------------------------------------------------------------
// A hand-rolled zip writer.
//
// The archives under test have to be able to LIE — a header that declares ten
// bytes over two megabytes of data, the same name twice, a compression method
// nobody registered, a data descriptor in place of sizes — and `zipSync`
// cannot be asked to write any of those. Writing the container by hand also
// keeps the test independent of the library being tested: an archive fflate's
// own writer produces is exactly what its reader is best at, which is the one
// shape a hostile archive never takes. Deflate streams come from `node:zlib`,
// which is fast on the highly repetitive data a bomb is made of.
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DESCRIPTOR = 0x08074b50;
const FLAG_UTF8 = 0x800;
const FLAG_DATA_DESCRIPTOR = 0x8;

type ArchiveEntry = {
  name: string;
  data?: Uint8Array;
  /** PKZIP method: 0 stored, 8 deflate. Anything else is written with the data as-is. */
  method?: number;
  /** Lies for the LOCAL header only; the data is written truthfully. */
  declare?: { compressed?: number; uncompressed?: number };
  /** Bit 3: sizes are zero in the header and follow the data in a descriptor. */
  dataDescriptor?: boolean;
};

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
}

function buildArchive(entries: readonly ArchiveEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array(0);
    const method = entry.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(data, { level: 9 })) : data;
    const name = new TextEncoder().encode(entry.name);
    const flags = FLAG_UTF8 | (entry.dataDescriptor ? FLAG_DATA_DESCRIPTOR : 0);
    const crc = crc32(data);
    const declaredCompressed = entry.dataDescriptor ? 0 : (entry.declare?.compressed ?? body.length);
    const declaredUncompressed = entry.dataDescriptor ? 0 : (entry.declare?.uncompressed ?? data.length);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, declaredCompressed, true);
    lv.setUint32(22, declaredUncompressed, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const parts = [local, body];

    if (entry.dataDescriptor) {
      const descriptor = new Uint8Array(16);
      const dv = new DataView(descriptor.buffer);
      dv.setUint32(0, SIG_DESCRIPTOR, true);
      dv.setUint32(4, crc, true);
      dv.setUint32(8, body.length, true);
      dv.setUint32(12, data.length, true);
      parts.push(descriptor);
    }

    const record = new Uint8Array(46 + name.length);
    const cv = new DataView(record.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);

    for (const part of parts) {
      chunks.push(part);
      offset += part.length;
    }
  }

  const centralStart = offset;
  const centralSize = central.reduce((total, record) => total + record.length, 0);
  chunks.push(...central);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  chunks.push(eocd);

  return concat(chunks);
}

/** Convenience for the common case: a name-to-content map, deflated. */
function archiveOf(files: Record<string, Uint8Array | string>): Uint8Array {
  return buildArchive(
    Object.entries(files).map(([name, content]) => ({
      name,
      data: typeof content === "string" ? new TextEncoder().encode(content) : content,
    })),
  );
}

/** Text that deflates well but nowhere near the ratio cap — a stand-in for a manifest or a script file. */
function text(bytes: number): Uint8Array {
  const lines: string[] = [];
  let length = 0;

  for (let i = 0; length < bytes; i++) {
    const line = `clip ${i} of the pack, group ${i % 17}, take ${i % 5}\n`;
    lines.push(line);
    length += line.length;
  }

  return new TextEncoder().encode(lines.join("")).subarray(0, bytes);
}

/** Bytes that do not compress at all — what an MP3's audio frames look like to deflate. */
function noise(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let state = 0x9e3779b9;

  for (let i = 0; i < bytes; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }

  return out;
}

const MiB = 1024 * 1024;

// ---------------------------------------------------------------------------
// The filesystem port, in memory.
// ---------------------------------------------------------------------------

const TARGET = resolve("packs", "luca");

type MemoryFs = {
  fs: VoicePackArchiveFileSystem;
  /** Written files, keyed by POSIX path relative to TARGET. */
  files: Map<string, Uint8Array>;
  /** Every directory `ensureDirectory` was asked for, relative to TARGET. */
  dirs: string[];
};

function memoryFs(options: { failWrite?: string; failMkdir?: string } = {}): MemoryFs {
  const files = new Map<string, Uint8Array>();
  const dirs: string[] = [];
  const rel = (path: string) => relative(TARGET, path).split(sep).join("/");

  return {
    files,
    dirs,
    fs: {
      ensureDirectory(dir) {
        if (options.failMkdir) return { ok: false, reason: options.failMkdir };

        dirs.push(rel(dir));

        return { ok: true };
      },
      writeFile(file, bytes) {
        if (options.failWrite) return { ok: false, reason: options.failWrite };

        files.set(rel(file), new Uint8Array(bytes));

        return { ok: true };
      },
    },
  };
}

/**
 * Counts the compressed chunks that reach the real inflater. "Costs zero
 * decompressed bytes" is only provable by watching the decoder: a refused entry
 * must never have had a byte pushed into it.
 */
function spyOnInflate() {
  return vi.spyOn(UnzipInflate.prototype, "push");
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function extract(
  archive: Uint8Array,
  memory: MemoryFs,
  limits?: Parameters<typeof extractVoicePackArchive>[0]["limits"],
) {
  return extractVoicePackArchive({ archive, targetDir: TARGET, fs: memory.fs, limits });
}

function failure(result: Awaited<ReturnType<typeof extractVoicePackArchive>>) {
  if (result.ok) throw new Error("expected the extraction to be refused");

  return result;
}

// ---------------------------------------------------------------------------

describe("extractVoicePackArchive", () => {
  describe("accepts a well-formed pack", () => {
    it("writes every clip and the manifest, nested, in archive order", async () => {
      const manifest = '{"schema":1,"id":"luca"}\n';
      const blue1 = noise(3000);
      const blue2 = noise(2500);
      const four = noise(1800);
      const archive = buildArchive([
        { name: "voice-pack.json", data: new TextEncoder().encode(manifest) },
        { name: "voice/" },
        { name: "voice/luca/" },
        { name: "voice/luca/flags/" },
        { name: "voice/luca/flags/blue-01.mp3", data: blue1 },
        { name: "voice/luca/flags/blue-02.mp3", data: blue2 },
        { name: "voice/luca/position-number/" },
        { name: "voice/luca/position-number/4.mp3", data: four },
      ]);
      const memory = memoryFs();

      const result = await extract(archive, memory);

      expect(result).toEqual({
        ok: true,
        written: [
          "voice-pack.json",
          "voice/luca/flags/blue-01.mp3",
          "voice/luca/flags/blue-02.mp3",
          "voice/luca/position-number/4.mp3",
        ],
      });
      expect(new TextDecoder().decode(memory.files.get("voice-pack.json"))).toBe(manifest);
      expect(memory.files.get("voice/luca/flags/blue-01.mp3")).toEqual(blue1);
      expect(memory.files.get("voice/luca/flags/blue-02.mp3")).toEqual(blue2);
      expect(memory.files.get("voice/luca/position-number/4.mp3")).toEqual(four);
    });

    it("creates parents from the files it accepts and never from the archive's directory entries", async () => {
      const archive = buildArchive([
        { name: "empty/" },
        { name: "voice/luca/flags/" },
        { name: "voice/luca/flags/blue-01.mp3", data: noise(100) },
      ]);
      const memory = memoryFs();

      const result = await extract(archive, memory);

      expect(result.ok).toBe(true);
      expect(memory.dirs).toEqual(["voice/luca/flags"]);
      expect(memory.dirs).not.toContain("empty");
    });

    it("accepts stored (uncompressed) entries", async () => {
      const clip = noise(500);
      const memory = memoryFs();

      const result = await extract(
        buildArchive([{ name: "voice/luca/flags/blue-01.mp3", data: clip, method: 0 }]),
        memory,
      );

      expect(result).toEqual({ ok: true, written: ["voice/luca/flags/blue-01.mp3"] });
      expect(memory.files.get("voice/luca/flags/blue-01.mp3")).toEqual(clip);
    });

    it("accepts a streamed entry whose sizes arrive in a trailing data descriptor", async () => {
      // A streaming zip writer cannot know the sizes when it writes the header,
      // so the header says zero and fflate reports no size at all. The caps
      // must not depend on the header having one.
      const clip = noise(4000);
      const memory = memoryFs();

      const result = await extract(
        buildArchive([{ name: "voice/luca/flags/blue-01.mp3", data: clip, dataDescriptor: true }]),
        memory,
      );

      expect(result).toEqual({ ok: true, written: ["voice/luca/flags/blue-01.mp3"] });
      expect(memory.files.get("voice/luca/flags/blue-01.mp3")).toEqual(clip);
    });

    it("hands the archive to the parser in bounded slices", async () => {
      // The slice size is what bounds a bomb's transient: a synchronous inflater
      // expands everything it is handed before the caps can look. A whole-archive
      // push would make the caps observers of an allocation that already happened.
      const pushes = spyOnInflate();
      const clip = noise(5 * VOICE_PACK_ARCHIVE_PUSH_BYTES);

      const result = await extract(buildArchive([{ name: "voice/luca/flags/blue-01.mp3", data: clip }]), memoryFs());

      expect(result.ok).toBe(true);
      expect(pushes.mock.calls.length).toBeGreaterThanOrEqual(5);

      for (const [chunk] of pushes.mock.calls) expect(chunk.length).toBeLessThanOrEqual(VOICE_PACK_ARCHIVE_PUSH_BYTES);
    });
  });

  describe("refuses a hostile entry name without decompressing a byte", () => {
    it.each([
      ["../evil.mp3", /'\.\.'/],
      ["voice/../../evil.mp3", /'\.\.'/],
      ["..\\evil.mp3", /'\.\.'/],
      ["voice\\..\\..\\evil.mp3", /'\.\.'/],
      ["/etc/evil.mp3", /not a relative path/],
      ["\\evil.mp3", /not a relative path/],
      ["C:/evil.mp3", /drive/],
      ["c:\\evil.mp3", /drive/],
      ["C:evil.mp3", /drive/],
      ["\\\\server\\share\\evil.mp3", /network share/],
      ["//server/share/evil.mp3", /network share/],
      ["voice//luca.mp3", /empty path segment/],
      [".DS_Store.json", /hidden/],
      ["voice/luca/.DS_Store.mp3", /hidden/],
      ["__MACOSX/._blue-01.mp3", /hidden/],
      [".git/config.json", /hidden/],
      ["voice/luca/NUL.mp3", /reserved device name/],
      ["con.json", /reserved device name/],
      ["voice/luca/lpt1.mp3", /reserved device name/],
      ["voice/luca/blue 01.mp3", /character/],
      ["voice/luca/blue:01.mp3", /character/],
      ["voice/luca/blue*.mp3", /character/],
      ["voice/luca/blüe.mp3", /character/],
      ["voice/luca/blue\u200b.mp3", /character/],
      ["voice./luca.mp3", /ends with a dot/],
      [`voice/${"a".repeat(VOICE_PACK_ARCHIVE_MAX_NAME_LENGTH)}.mp3`, /longer than/],
    ])("%j", async (name, reason) => {
      const pushes = spyOnInflate();
      const memory = memoryFs();

      const result = failure(await extract(buildArchive([{ name, data: noise(200) }]), memory));

      expect(result.code).toBe("path");
      expect(result.reason).toMatch(reason);
      expect(memory.files.size).toBe(0);
      expect(memory.dirs).toEqual([]);
      expect(pushes).not.toHaveBeenCalled();
    });

    it("refuses `.install.json`, which only the installer may write", async () => {
      // The absence of this file is how a sideloaded pack is identified, and
      // its presence is the installer's own record of where a pack came from.
      // An archive that ships one is forging its provenance — and it ends in
      // `.json`, so the extension rule would have let it through. The dot rule
      // has to run first, and this test is what pins that order.
      const memory = memoryFs();
      const archive = archiveOf({
        "voice-pack.json": '{"schema":1}',
        ".install.json": '{"source":"catalog"}',
        "voice/luca/flags/blue-01.mp3": noise(100),
      });

      const result = failure(await extract(archive, memory));

      expect(result.code).toBe("path");
      expect(result.reason).toMatch(/\.install\.json/);
      expect(memory.files.has(".install.json")).toBe(false);
    });

    it("refuses a hostile directory entry rather than merely skipping it", async () => {
      const memory = memoryFs();

      const result = failure(
        await extract(
          buildArchive([{ name: "../outside/" }, { name: "voice/luca/flags/blue-01.mp3", data: noise(10) }]),
          memory,
        ),
      );

      expect(result.code).toBe("path");
      expect(memory.files.size).toBe(0);
      expect(memory.dirs).toEqual([]);
    });

    it("refuses a name that appears twice", async () => {
      // Two local headers with one name: whichever an extractor writes last
      // wins, silently. Built by hand because no zip writer will produce it.
      const memory = memoryFs();
      const archive = buildArchive([
        { name: "voice/luca/flags/blue-01.mp3", data: noise(100) },
        { name: "voice/luca/flags/blue-01.mp3", data: noise(100) },
      ]);

      const result = failure(await extract(archive, memory));

      expect(result.code).toBe("path");
      expect(result.reason).toMatch(/more than once/);
      expect(memory.files.size).toBe(1);
    });

    it("treats names that differ only by case as the same name", async () => {
      // The target filesystem is case-insensitive: these are one file on disk.
      const memory = memoryFs();
      const archive = archiveOf({
        "voice/luca/flags/blue-01.mp3": noise(100),
        "voice/LUCA/flags/BLUE-01.mp3": noise(100),
      });

      const result = failure(await extract(archive, memory));

      expect(result.code).toBe("path");
      expect(result.reason).toMatch(/more than once/);
    });
  });

  describe("refuses anything that is not a lowercase .mp3 or .json", () => {
    it.each([
      "voice/luca/flags/blue-01.MP3",
      "voice/luca/flags/blue-01.Mp3",
      "voice-pack.JSON",
      "readme.txt",
      "voice/luca/flags/blue-01",
      "voice/luca/flags/blue-01.mp3.bak",
    ])("%s", async (name) => {
      const pushes = spyOnInflate();
      const memory = memoryFs();

      const result = failure(await extract(buildArchive([{ name, data: noise(200) }]), memory));

      expect(result.code).toBe("extension");
      expect(result.reason).toMatch(/\.mp3 or \.json/);
      expect(memory.files.size).toBe(0);
      expect(pushes).not.toHaveBeenCalled();
    });
  });

  describe("caps", () => {
    it("stops at the entry-count cap, and the cap counts every entry the archive has", async () => {
      const memory = memoryFs();
      const archive = buildArchive([
        { name: "voice/luca/flags/blue-01.mp3", data: noise(100) },
        { name: "voice/luca/flags/blue-02.mp3", data: noise(100) },
        { name: "voice/luca/flags/" },
        { name: "voice/luca/flags/blue-03.mp3", data: noise(100) },
      ]);

      const result = failure(await extract(archive, memory, { maxEntries: 3 }));

      expect(result.code).toBe("entry-count");
      expect(result.reason).toMatch(/more than 3 entries/);
      expect(result.written).toEqual(["voice/luca/flags/blue-01.mp3", "voice/luca/flags/blue-02.mp3"]);
      expect(memory.files.has("voice/luca/flags/blue-03.mp3")).toBe(false);
    });

    it("stops at the total-bytes cap while the entry that crosses it is still expanding", async () => {
      // The third header lies small so the truthful-header shortcut cannot
      // refuse it early: only the bytes counted as they come out can.
      const memory = memoryFs();
      const archive = buildArchive([
        { name: "voice/luca/flags/a.mp3", data: noise(400 * 1024) },
        { name: "voice/luca/flags/b.mp3", data: noise(400 * 1024) },
        { name: "voice/luca/flags/c.mp3", data: noise(400 * 1024), declare: { uncompressed: 10 } },
      ]);

      const result = failure(await extract(archive, memory, { maxTotalBytes: MiB }));

      expect(result.code).toBe("total-bytes");
      expect(result.reason).toMatch(/more than 1 MB in total/);
      expect(result.written).toEqual(["voice/luca/flags/a.mp3", "voice/luca/flags/b.mp3"]);
      expect(memory.files.has("voice/luca/flags/c.mp3")).toBe(false);
    });

    it("stops at the per-entry cap", async () => {
      const memory = memoryFs();

      const result = failure(
        await extract(archiveOf({ "voice/luca/flags/a.mp3": noise(600_000) }), memory, {
          maxEntryBytes: 512_000,
        }),
      );

      expect(result.code).toBe("entry-bytes");
      expect(result.reason).toMatch(/more than 512 KB/);
      expect(memory.files.size).toBe(0);
    });

    it("aborts a zip bomb mid-entry on the compression-ratio cap", async () => {
      // 64 MiB of zeros deflates to ~64 KiB: a 1000:1 stream, which is what
      // deflate's ceiling looks like. Under default limits the first slice
      // already produces more than the grace floor at over 100:1. The header
      // lies small, as a real bomb's would — a truthful 64 MiB header is
      // refused before inflating, which is a different test.
      const pushes = spyOnInflate();
      const memory = memoryFs();
      const archive = buildArchive([
        { name: "voice/luca/flags/zeros.mp3", data: new Uint8Array(64 * MiB), declare: { uncompressed: 10 } },
      ]);
      const slicesIfCompleted = Math.ceil(archive.length / VOICE_PACK_ARCHIVE_PUSH_BYTES);

      const result = failure(await extract(archive, memory));

      expect(result.code).toBe("compression-ratio");
      expect(result.reason).toMatch(/zip bomb/);
      expect(result.reason).toMatch(new RegExp(`${VOICE_PACK_ARCHIVE_LIMITS.maxCompressionRatio}:1`));
      expect(memory.files.size).toBe(0);
      expect(memory.dirs).toEqual([]);
      // Aborted WHILE expanding: the inflater saw a fraction of the entry.
      expect(pushes.mock.calls.length).toBeGreaterThan(0);
      expect(pushes.mock.calls.length).toBeLessThan(slicesIfCompleted);
    });

    it("lets a small, highly compressible file through under the grace floor", async () => {
      // An MP3 whose ID3 tag is padded with zeros, or a JSON of repeated
      // structure, can open at hundreds-to-one. The ratio is only judged once
      // an entry has produced more than the grace floor, so such a file is
      // accepted — and lowering the floor is what refuses it, which pins the
      // floor as the thing doing the accepting.
      const archive = buildArchive([{ name: "voice/luca/flags/padded.mp3", data: new Uint8Array(256 * 1024) }]);

      expect((await extract(archive, memoryFs())).ok).toBe(true);

      const memory = memoryFs();
      const result = failure(await extract(archive, memory, { ratioGraceBytes: 1024 }));

      expect(result.code).toBe("compression-ratio");
      expect(memory.files.size).toBe(0);
    });

    it("accepts an ordinarily compressible file well past the grace floor", async () => {
      // Repetitive text — a callout script, a manifest with many entries —
      // deflates ten- or twentyfold, and past the grace floor its ratio IS
      // judged. This is the legitimate side of the cap: compressing well is
      // not what makes a bomb, and a cap that refused this would refuse JSON.
      const memory = memoryFs();

      const result = await extract(archiveOf({ "voice/luca/callouts.json": text(2 * MiB) }), memory);

      expect(result).toEqual({ ok: true, written: ["voice/luca/callouts.json"] });
      expect(memory.files.get("voice/luca/callouts.json")?.length).toBe(2 * MiB);
    });

    it("enforces the caps on bytes actually produced, not on what the header declares", async () => {
      // The header is attacker-written. This one claims ten bytes over two
      // megabytes of real data; a cap read off the header would wave it through.
      const memory = memoryFs();
      const archive = buildArchive([
        { name: "voice/luca/flags/a.mp3", data: noise(2 * MiB), declare: { uncompressed: 10 } },
      ]);

      const result = failure(await extract(archive, memory, { maxEntryBytes: MiB }));

      expect(result.code).toBe("entry-bytes");
      expect(memory.files.size).toBe(0);
    });

    it("refuses on a header that declares more than the cap without inflating it", async () => {
      // The opposite lie costs the liar only their own archive: a truthful
      // header of that size would be refused after inflating anyway, and a
      // false one is refused before. Either way nothing is decompressed.
      const pushes = spyOnInflate();
      const memory = memoryFs();
      const archive = buildArchive([
        { name: "voice/luca/flags/a.mp3", data: noise(100), declare: { uncompressed: 1024 * MiB } },
      ]);

      const result = failure(await extract(archive, memory));

      expect(result.code).toBe("entry-bytes");
      expect(memory.files.size).toBe(0);
      expect(pushes).not.toHaveBeenCalled();
    });

    it("refuses on a header whose declared size would cross the total cap", async () => {
      const pushes = spyOnInflate();
      const memory = memoryFs();
      const archive = buildArchive([
        { name: "voice/luca/flags/a.mp3", data: noise(100) },
        { name: "voice/luca/flags/b.mp3", data: noise(100), declare: { uncompressed: 2 * MiB } },
      ]);

      const result = failure(await extract(archive, memory, { maxTotalBytes: MiB }));

      expect(result.code).toBe("total-bytes");
      expect(result.written).toEqual(["voice/luca/flags/a.mp3"]);
      expect(pushes).toHaveBeenCalledTimes(1);
    });

    it("keeps its caps when a streamed entry declares no sizes at all", async () => {
      const memory = memoryFs();
      const archive = buildArchive([
        { name: "voice/luca/flags/zeros.mp3", data: new Uint8Array(8 * MiB), dataDescriptor: true },
      ]);

      const result = failure(await extract(archive, memory, { maxEntryBytes: MiB }));

      expect(["entry-bytes", "compression-ratio"]).toContain(result.code);
      expect(memory.files.size).toBe(0);
    });

    it.each([
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["zero", 0],
      ["negative", -1],
      ["undefined", undefined],
    ])("falls back to the default rather than disabling a cap given %s", async (_, value) => {
      // A caller's slip must not switch a cap off: `produced > NaN` is false
      // for every value, which would accept everything. The bomb is the proof,
      // with a lying header so only the counted caps can catch it, and each
      // cap isolated by leaving the other one legitimately out of reach.
      const bomb = buildArchive([
        { name: "voice/luca/flags/zeros.mp3", data: new Uint8Array(64 * MiB), declare: { uncompressed: 10 } },
      ]);

      const ratio = memoryFs();
      const byRatio = failure(
        await extract(bomb, ratio, { maxCompressionRatio: value, ratioGraceBytes: value, maxEntryBytes: 1024 * MiB }),
      );

      expect(byRatio.code).toBe("compression-ratio");
      expect(ratio.files.size).toBe(0);

      const entry = memoryFs();
      const byEntry = failure(await extract(bomb, entry, { maxEntryBytes: value, maxCompressionRatio: 100_000 }));

      expect(byEntry.code).toBe("entry-bytes");
      expect(entry.files.size).toBe(0);
    });
  });

  describe("refuses what it cannot parse", () => {
    it("refuses bytes that are not a zip archive", async () => {
      const memory = memoryFs();

      const result = failure(await extract(noise(4096), memory));

      expect(result.code).toBe("malformed");
      expect(result.reason).toMatch(/not a zip archive/);
      expect(memory.files.size).toBe(0);
    });

    it("refuses an empty buffer", async () => {
      const result = failure(await extract(new Uint8Array(0), memoryFs()));

      expect(result.code).toBe("malformed");
    });

    it("refuses an archive with entries but no files", async () => {
      const result = failure(await extract(buildArchive([{ name: "voice/" }, { name: "voice/luca/" }]), memoryFs()));

      expect(result.code).toBe("empty");
      expect(result.reason).toMatch(/no files/);
    });

    it("refuses a truncated archive and keeps nothing from the entry it was inside", async () => {
      const memory = memoryFs();
      const whole = archiveOf({ "voice/luca/flags/a.mp3": noise(100), "voice/luca/flags/b.mp3": noise(40000) });
      const truncated = whole.subarray(0, whole.length - 30000);

      const result = failure(await extract(truncated, memory));

      expect(result.code).toBe("malformed");
      expect(result.reason).toMatch(/damaged or truncated/);
      expect(result.written).toEqual(["voice/luca/flags/a.mp3"]);
      expect(memory.files.has("voice/luca/flags/b.mp3")).toBe(false);
    });

    it("refuses a streamed entry the archive ends in the middle of", async () => {
      const memory = memoryFs();
      const whole = buildArchive([{ name: "voice/luca/flags/a.mp3", data: noise(40000), dataDescriptor: true }]);
      // Cut inside the data: no descriptor and no next header ever tells the
      // parser the entry ended, so nothing may be written for it.
      const truncated = whole.subarray(0, 20000);

      const result = failure(await extract(truncated, memory));

      expect(result.code).toBe("malformed");
      expect(memory.files.size).toBe(0);
    });

    it("refuses an entry whose deflate stream is corrupt", async () => {
      const memory = memoryFs();
      const name = "voice/luca/flags/a.mp3";
      const archive = buildArchive([{ name, data: noise(20000) }]);
      // The stream starts right after the 30-byte local header and the name.
      // Its first byte carries BFINAL and BTYPE; 0b111 is the one block type
      // deflate reserves, so the very first thing the inflater reads is
      // invalid — scribbling further in would land inside a stored block of
      // this incompressible data, where any byte is as valid as any other.
      archive[30 + name.length] = 0x07;

      const result = failure(await extract(archive, memory));

      expect(result.code).toBe("malformed");
      expect(result.reason).toMatch(/could not be decompressed/);
      expect(memory.files.size).toBe(0);
    });

    it("refuses a compression method it does not implement", async () => {
      const pushes = spyOnInflate();
      const memory = memoryFs();

      const result = failure(
        await extract(buildArchive([{ name: "voice/luca/flags/a.mp3", data: noise(100), method: 12 }]), memory),
      );

      expect(result.code).toBe("malformed");
      expect(result.reason).toMatch(/compression method 12/);
      expect(memory.files.size).toBe(0);
      expect(pushes).not.toHaveBeenCalled();
    });

    it("refuses an empty file", async () => {
      const memory = memoryFs();

      const result = failure(await extract(buildArchive([{ name: "voice-pack.json" }]), memory));

      expect(result.code).toBe("malformed");
      expect(result.reason).toMatch(/empty/);
      expect(memory.files.size).toBe(0);
    });
  });

  describe("reports a write that fails", () => {
    it("names the file and the errno, and stops", async () => {
      const memory = memoryFs({ failWrite: "ENOSPC" });
      const archive = archiveOf({ "voice/luca/flags/a.mp3": noise(10), "voice/luca/flags/b.mp3": noise(10) });

      const result = failure(await extract(archive, memory));

      expect(result.code).toBe("write");
      expect(result.reason).toMatch(/voice\/luca\/flags\/a\.mp3/);
      expect(result.reason).toMatch(/ENOSPC/);
      expect(result.written).toEqual([]);
      // Stopped at the first failure rather than trying the rest.
      expect(memory.dirs).toEqual(["voice/luca/flags"]);
    });

    it("reports a folder it could not create", async () => {
      const result = failure(
        await extract(archiveOf({ "voice/luca/flags/a.mp3": noise(10) }), memoryFs({ failMkdir: "EACCES" })),
      );

      expect(result.code).toBe("write");
      expect(result.reason).toMatch(/EACCES/);
    });

    it("refuses a relative target directory rather than extracting into the working directory", async () => {
      const memory = memoryFs();

      const result = await extractVoicePackArchive({
        archive: archiveOf({ "a.json": "{}" }),
        targetDir: "packs/luca",
        fs: memory.fs,
      });

      expect(result.ok).toBe(false);
      expect(memory.files.size).toBe(0);
    });
  });

  it("does not put a hostile name's raw bytes into the reason", async () => {
    // The reason is rendered in the settings window and rides the deck host's
    // settings copy. Control and format characters — a newline, a bidi
    // override — are replaced, and the name is cut to a length a banner can hold.
    const name = `voice/luca/${"x".repeat(300)}\u202e\n.mp3`;

    const result = failure(await extract(buildArchive([{ name, data: noise(10) }]), memoryFs()));

    expect(result.reason).not.toMatch(/[\n\u202e]/);
    expect(result.reason.length).toBeLessThan(200);
  });
});

describe("isInsideDirectory", () => {
  it("is path arithmetic, not a string prefix", () => {
    // `…/luca` is a prefix of `…/luca-evil/x.mp3` as a string and unrelated to
    // it as a path — the classic hole in a `startsWith` containment check.
    const target = resolve("packs", "luca");

    expect(isInsideDirectory(target, resolve("packs", "luca-evil", "x.mp3"))).toBe(false);
    expect(isInsideDirectory(target, resolve("packs", "luca", "x.mp3"))).toBe(true);
    expect(isInsideDirectory(target, resolve("packs", "luca", "voice", "luca", "x.mp3"))).toBe(true);
  });

  it("excludes the directory itself and everything above it", () => {
    const target = resolve("packs", "luca");

    expect(isInsideDirectory(target, target)).toBe(false);
    expect(isInsideDirectory(target, resolve("packs"))).toBe(false);
    expect(isInsideDirectory(target, resolve("packs", "other", "x.mp3"))).toBe(false);
    expect(isInsideDirectory(target, resolve("x.mp3"))).toBe(false);
  });
});

describe("createCountingDecoder", () => {
  it("counts the bytes handed to the real decoder and drops everything after terminate()", () => {
    // fflate's `UnzipFile.terminate()` only forwards to a decoder that defines
    // one, and the synchronous inflater defines none — so without this, the
    // call the extractor makes on a refused entry would be a no-op.
    const pushed: number[] = [];

    class Inner {
      static compression = 8;
      ondata: (err: Error | null, data: Uint8Array, final: boolean) => void = () => {};
      push(chunk: Uint8Array, final: boolean) {
        pushed.push(chunk.length);
        this.ondata(null, chunk, final);
      }
    }

    const counter = { compressed: 0 };
    const Counting = createCountingDecoder(Inner, () => counter);
    const decoder = new Counting("a.mp3");
    const received: number[] = [];
    decoder.ondata = (_err, data) => received.push(data.length);

    decoder.push(new Uint8Array(10), false);
    decoder.push(new Uint8Array(5), false);
    expect(counter.compressed).toBe(15);
    expect(received).toEqual([10, 5]);

    decoder.terminate?.();
    decoder.push(new Uint8Array(7), true);
    expect(counter.compressed).toBe(15);
    expect(pushed).toEqual([10, 5]);
    expect(Counting.compression).toBe(8);
  });
});

describe("the compression-ratio cap at its own boundaries (#1100)", () => {
  // Every other ratio test overrides `ratioGraceBytes` to something small, so
  // none of them exercised the SHIPPED grace. These use the real defaults,
  // which is where the hole was.
  const GRACE = VOICE_PACK_ARCHIVE_LIMITS.ratioGraceBytes;

  function zeros(bytes: number): Uint8Array {
    return new Uint8Array(bytes);
  }

  function manyEntries(count: number, each: number): Uint8Array {
    const files: Record<string, Uint8Array> = {};

    for (let i = 0; i < count; i += 1) files[`voice/luca/flags/c${i}.mp3`] = zeros(each);

    return archiveOf(files);
  }

  // The boundary itself. `produced > grace` left an entry sitting EXACTLY on it
  // unjudged — and the grace is a round power of two, which is the size an
  // attacker picks rather than one they stumble onto.
  it("refuses an entry that produces exactly the grace", async () => {
    const memory = memoryFs();
    const result = failure(await extract(manyEntries(1, GRACE), memory));

    expect(result.code).toBe("compression-ratio");
    expect(memory.files.size).toBe(0);
  });

  // The per-entry test cannot see an attack spread thinly: entries just under
  // the grace are each individually unjudged, however many there are. Before
  // the aggregate cap this archive was ACCEPTED and wrote 24 MiB from 27 KB.
  it("refuses an archive whose entries each sit just under the grace", async () => {
    const memory = memoryFs();
    const archive = manyEntries(24, GRACE);
    const result = failure(await extract(archive, memory));

    expect(result.code).toBe("compression-ratio");
    // Bounded by the archive's own size rather than by the flat total cap:
    // whatever reached the staging directory is a small multiple of what was
    // downloaded, not half a gigabyte.
    expect(archive.length * VOICE_PACK_ARCHIVE_LIMITS.maxCompressionRatio).toBeLessThan(
      VOICE_PACK_ARCHIVE_LIMITS.maxTotalBytes,
    );
  });

  // The negative control, and the one that matters most: a cap that refuses
  // real packs is not a cap, it is an outage. MP3 is already compressed, so a
  // genuine pack runs at about 1:1 and must be nowhere near this.
  it("still accepts an archive of incompressible clips", async () => {
    const files: Record<string, Uint8Array> = { "voice-pack.json": new TextEncoder().encode('{"schema":1}') };

    for (let i = 0; i < 40; i += 1) {
      const clip = new Uint8Array(60_000);

      for (let j = 0; j < clip.length; j += 1) clip[j] = (Math.imul(j + i, 2_654_435_761) >>> 24) & 0xff;

      files[`voice/luca/flags/c${i}.mp3`] = clip;
    }

    const result = await extract(archiveOf(files), memoryFs());

    expect(result.ok).toBe(true);
  });
});
