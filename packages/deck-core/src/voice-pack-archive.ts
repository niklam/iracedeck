/**
 * Safe extraction of a downloaded voice-pack archive (issue #1034, stage 2).
 *
 * This is the one module in the feature whose failure mode is ACCEPTING: every
 * other stage refuses by parsing a document it can hold in one hand, while
 * this one turns bytes fetched from the network into files on the user's
 * disk. So every byte of the archive is treated as hostile — the entry names,
 * the sizes the headers declare, the count of entries, the compression method,
 * the data itself — and nothing fflate says about any of them is taken on
 * trust. The spec's install pipeline says the same in one line ("validating
 * every entry ourselves regardless of what the library does"); this file is
 * that line's worth of reasoning.
 *
 * Three attacks shape the design:
 *
 * - **Path traversal.** `../../Stream Deck/plugin.js`, `C:\…`, `\\server\share`,
 *   a leading slash — an entry name is a string the archive's author typed, and
 *   the classic extractor bug is joining it onto the target directory. Names are
 *   refused by a positive allow-list per segment (letters, digits, `.`, `_`, `-`;
 *   not dot-led, not `..`, not a Windows device name, no trailing dot), and the
 *   resolved destination is then proved to be inside the target by path
 *   arithmetic rather than a string prefix — `…\luca` is a prefix of
 *   `…\luca-evil\x.mp3` and unrelated to it.
 * - **Provenance forgery.** `.install.json` is written by the installer and is
 *   how a sideloaded pack is told apart from a catalog one — see
 *   `voice-pack-provenance.ts`. A pack that shipped one would be claiming its
 *   own origin. It ends in `.json`, so the extension rule alone would admit it;
 *   the dot rule runs first and refuses every hidden name, and the archive is
 *   refused whole rather than the entry skipped, because a pack that tries
 *   this is not a pack to finish installing.
 * - **Zip bombs.** A few kilobytes of deflate can expand a thousandfold. The
 *   headers declare sizes, and the headers are the attacker's. So every cap is
 *   enforced against bytes ACTUALLY PRODUCED, counted as the inflater emits
 *   them, and the entry is abandoned the moment a cap is crossed — not after
 *   the whole thing has been expanded and measured.
 *
 * Why fflate's streaming `Unzip` and not `unzipSync`: `unzipSync` hands back
 * every entry fully decompressed — the bomb has gone off before any check can
 * run. `Unzip` fires `onfile` when an entry's header is parsed and decompresses
 * NOTHING unless `start()` is called, so a refused name costs zero decompressed
 * bytes, and output arrives in chunks while the entry is still expanding. The
 * synchronous `UnzipInflate` is used rather than the `Async*` variant: that one
 * inlines a worker script whose survival under bundling is fragile, and this
 * ships inside `bin/plugin.js`.
 *
 * Two consequences of the synchronous inflater are worth knowing. It expands
 * everything it is handed in one call before any handler runs, so the archive
 * is fed to `Unzip` in {@link VOICE_PACK_ARCHIVE_PUSH_BYTES} slices: that
 * slice, times deflate's ~1032:1 ceiling, is the largest transient a bomb can
 * force before the caps see it (about 17 MB). And `UnzipFile.terminate()` only
 * forwards to a decoder that defines one, which the synchronous inflater does
 * not — so the decoder is wrapped ({@link createCountingDecoder}) to count the
 * compressed bytes it is given, which is what the ratio is measured against,
 * and to make `terminate()` really drop everything after it.
 *
 * What is deliberately NOT done here, and why:
 *
 * - **CRCs are not checked.** Integrity is the archive's sha-256, verified by
 *   the installer before this runs; a CRC an attacker wrote proves nothing.
 * - **The central directory is ignored.** fflate's streaming reader walks the
 *   local headers, and the name validated is the name written. An archive whose
 *   central directory disagrees with its local headers (a "schizophrenic" zip)
 *   fools tools that trust one and extract the other; nothing here reads both.
 * - **Symlinks cannot be created.** Only file bytes are written, through a port
 *   that writes files; a symlink entry, if a zip carried one, becomes a file
 *   containing its target text — and would need a `.mp3` or `.json` name.
 * - **Directory entries are never created.** Parents are made from the paths
 *   of the files accepted, so a directory entry with a hostile name is refused
 *   like any other name but a benign one is simply skipped.
 * - **Encryption is not detected by flag.** fflate exposes no general-purpose
 *   flag bits, and re-parsing local headers to read one would mean a second
 *   parser. An encrypted entry is refused because its ciphertext does not
 *   inflate, and an AES entry (method 99) because the method is unsupported.
 *
 * Never throws. The callers are the settings window's command handler and an
 * install service, and an exception out of either ends the plugin process.
 */
import {
  type AsyncFlateStreamHandler,
  type FlateError,
  Unzip,
  type UnzipDecoder,
  type UnzipDecoderConstructor,
  type UnzipFile,
  UnzipInflate,
  UnzipPassThrough,
} from "fflate";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";

/**
 * The disk operations extraction needs, and nothing more — the sibling of the
 * scanner's `VoicePackFileSystem` port, for the same reason: the extractor is
 * then a pure function of the archive and this port, its tests need no disk,
 * and the single `node:fs` implementation is the only place an I/O error can
 * be raised. Both methods report rather than throw, matching `readTextFile`.
 *
 * `writeFile` is called for a path that does not exist yet, under a target
 * directory the caller created fresh for this extraction. An implementation
 * should open with exclusive create (`wx`) so that a file — or a symlink —
 * planted at the destination before the install ran is refused rather than
 * followed or overwritten; nothing in a staging directory is ours to replace.
 */
export interface VoicePackArchiveFileSystem {
  /** Create `dir` and every missing parent; already existing is success. */
  ensureDirectory(dir: string): VoicePackArchiveWrite;
  /** Write `bytes` as a new file at `file`. */
  writeFile(file: string, bytes: Uint8Array): VoicePackArchiveWrite;
}

/** The outcome of one disk operation. `reason` is path-free: an errno where there is one. */
export type VoicePackArchiveWrite = { ok: true } | { ok: false; reason: string };

export interface VoicePackArchiveLimits {
  /** Entries of any kind — files, directories, junk — the archive may contain. */
  maxEntries: number;
  /** Uncompressed bytes across every accepted file. */
  maxTotalBytes: number;
  /** Uncompressed bytes of any one file. */
  maxEntryBytes: number;
  /** Produced-to-consumed ratio above which an entry is a bomb. */
  maxCompressionRatio: number;
  /** Bytes an entry may produce before its ratio is judged at all. */
  ratioGraceBytes: number;
}

/**
 * Defaults, calibrated against the bundled `default` voice on 2026-09-02: 1545
 * clips in 48 directories, 33 MB in all, the largest clip 84 KB, and the
 * largest JSON anywhere in the audio pipeline 480 KB (the voice config a #1064
 * script would derive from is 196 KB). Each cap sits far above what a
 * legitimate pack needs and far below what would hurt, so the only archives
 * that meet one are broken or hostile:
 *
 * - `maxEntries` 20 000 — a five-voice pack is roughly 8 000 entries with its
 *   directories; the cap bounds the number of files an archive can make the
 *   plugin create.
 * - `maxTotalBytes` 512 MB — five voices are ~165 MB. This is the bound on
 *   disk used by the staging directory and on the work a bomb can extract.
 * - `maxEntryBytes` 16 MB — two hundred times the largest clip. Entries are
 *   buffered whole before being written (one write per file, no partial file
 *   to clean up on failure), so this is also the memory one entry can hold.
 * - `maxCompressionRatio` 100 — speech in MP3 is incompressible (~1:1); JSON
 *   compresses 5–20:1; deflate tops out near 1032:1. Anything past 100:1 is
 *   not audio and not a manifest.
 * - `ratioGraceBytes` 1 MB — the ratio is a signal, and on a small sample it
 *   is noise: an MP3 whose ID3 tag was padded with zeros opens at hundreds to
 *   one for a few kilobytes and then settles. An entry is judged only once it
 *   has produced more than this, which no legitimate file does at a bomb's
 *   ratio, while a bomb's first 16 KB slice sails past it in one chunk.
 */
export const VOICE_PACK_ARCHIVE_LIMITS: Readonly<VoicePackArchiveLimits> = {
  maxEntries: 20_000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntryBytes: 16 * 1024 * 1024,
  maxCompressionRatio: 100,
  ratioGraceBytes: 1024 * 1024,
};

/**
 * Longest entry name accepted, in characters after separator normalisation.
 *
 * The deepest legitimate path is `voice/<id>/<group>/<name>-NN.mp3`, well under
 * 100. The cap bounds directory depth and name length together, and keeps the
 * whole destination inside Windows' historical 260-character limit for a
 * staging directory that already spends ~150 of them.
 */
export const VOICE_PACK_ARCHIVE_MAX_NAME_LENGTH = 160;

/**
 * How much of the archive is handed to the parser per call.
 *
 * The synchronous inflater expands an entire slice before any handler runs, so
 * this is the unit the caps can act at. At deflate's ceiling a slice this size
 * produces about 17 MB, which is the largest allocation a bomb can force before
 * it is refused. Smaller slices would lower that bound at the cost of more
 * parser re-entries per megabyte; 16 KB is where a 33 MB pack costs a few
 * thousand calls and a bomb costs one.
 */
export const VOICE_PACK_ARCHIVE_PUSH_BYTES = 16 * 1024;

/**
 * Slices between turns of the event loop. Extraction is synchronous work and
 * runs while iRacing may be running, with telemetry polled every 10 ms: a
 * 33 MB pack extracted in one go would hold the loop for the whole of it —
 * the inflation is quick (a zero-filled stream inflated at ~400 MB/s of output
 * when measured), the 1 500 synchronous file writes behind it are not. Every
 * sixteen slices (256 KB of archive, a few milliseconds of work) the loop gets
 * a turn.
 */
const SLICES_PER_TURN = 16;

export const VOICE_PACK_ARCHIVE_FAILURE_CODES = [
  "path",
  "extension",
  "entry-count",
  "total-bytes",
  "entry-bytes",
  "compression-ratio",
  "malformed",
  "empty",
  "write",
] as const;

export type VoicePackArchiveFailureCode = (typeof VOICE_PACK_ARCHIVE_FAILURE_CODES)[number];

/**
 * `written` is present on failure as well: the files that landed before the
 * refusal, as POSIX paths relative to the target, so the caller can say what
 * it is discarding. The caller discards the whole staging directory either
 * way — a partial pack is never installed.
 */
export type ExtractVoicePackArchiveResult =
  | { ok: true; written: readonly string[] }
  | { ok: false; code: VoicePackArchiveFailureCode; reason: string; written: readonly string[] };

export interface ExtractVoicePackArchiveOptions {
  /** The whole archive. Not mutated, but must not be mutated by the caller until the promise settles. */
  archive: Uint8Array;
  /** Absolute path of a directory that exists and is empty. */
  targetDir: string;
  fs: VoicePackArchiveFileSystem;
  /** Overrides for {@link VOICE_PACK_ARCHIVE_LIMITS}; anything not a positive finite number keeps the default. */
  limits?: Partial<VoicePackArchiveLimits>;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const ACCEPTED_EXTENSIONS = [".mp3", ".json"] as const;

/**
 * What a path segment may be made of.
 *
 * A positive list rather than a list of forbidden characters, because the
 * forbidden list is long and platform-shaped — `<>:"|?*`, C0 controls, the
 * Unicode bidi overrides that reverse how a name reads, zero-width joiners,
 * NFC/NFD look-alikes, `:` as an NTFS stream separator — and every one of them
 * is absent from what the packer emits, which is kebab-case ASCII throughout.
 * Refusing the rest costs no legitimate pack anything and retires the whole
 * class at once.
 */
const SEGMENT_CHARACTERS = /^[A-Za-z0-9._-]+$/;

/**
 * Names Windows reserves for devices whatever directory or extension they are
 * given: writing `NUL.mp3` succeeds and stores nothing, `CON.json` writes to
 * the console. Matched on the stem before the first dot, case-insensitively,
 * which is how the Win32 namespace matches them. The superscript digit forms
 * (`COM¹`) never reach this test — {@link SEGMENT_CHARACTERS} is ASCII-only.
 */
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

type EntryNameCheck =
  | { ok: true; segments: readonly string[]; directory: boolean }
  | { ok: false; code: "path" | "extension"; problem: string };

type NameRule = { refuse: (value: string) => boolean; problem: string };

/**
 * Rules on the whole name, after `\` has become `/`. Ordered: UNC is tested
 * before the plain leading slash so `\\server\share` is named for what it is
 * rather than reported as merely absolute.
 */
const WHOLE_NAME_RULES: readonly NameRule[] = [
  {
    refuse: (name) => name.length > VOICE_PACK_ARCHIVE_MAX_NAME_LENGTH,
    problem: `is longer than ${VOICE_PACK_ARCHIVE_MAX_NAME_LENGTH} characters`,
  },
  { refuse: (name) => name.startsWith("//"), problem: "names a network share" },
  { refuse: (name) => name.startsWith("/"), problem: "is not a relative path" },
  { refuse: (name) => /^[A-Za-z]:/.test(name), problem: "names a drive" },
];

/**
 * Rules on each `/`-separated segment. Ordered so a refusal says the most
 * specific true thing: `..` is reported as traversal, not as "hidden", though
 * the dot rule would catch it too.
 *
 * The dot rule covers `.`, `.install.json`, `.DS_Store`, `.git/` and macOS's
 * `._` resource forks in one line. It refuses the ARCHIVE, not merely the
 * entry, and it runs before the extension rule ever sees the name — see the
 * provenance-forgery paragraph in the module comment for why `.install.json`
 * in particular must never reach the rule that would accept its extension.
 */
const SEGMENT_RULES: readonly NameRule[] = [
  { refuse: (segment) => segment === "", problem: "has an empty path segment" },
  { refuse: (segment) => segment === "..", problem: "contains a '..' segment" },
  { refuse: (segment) => segment.startsWith("."), problem: "is hidden (a name starting with a dot)" },
  {
    refuse: (segment) => !SEGMENT_CHARACTERS.test(segment),
    problem: "contains a character iRaceDeck does not allow in a file name",
  },
  // Windows silently strips a trailing dot, so `voice./x` would be written as
  // `voice/x` — a path other than the one that was validated.
  { refuse: (segment) => segment.endsWith("."), problem: "ends with a dot" },
  { refuse: (segment) => RESERVED_DEVICE_NAME.test(segment), problem: "uses a Windows-reserved device name" },
];

/**
 * The name rules, applied in the order that makes each refusal say the right
 * thing.
 *
 * Every rule is a refusal, never a rewrite: a name is not "cleaned" into
 * something safe, because the cleaned name is one the author did not write and
 * the archive's own `voice/<id>/…` grammar depends on names arriving intact.
 * The only transformation is `\` to `/`, and that is a reading of the zip
 * format rather than a repair — the spec says `/`, Windows tools write `\`.
 */
function checkEntryName(raw: string): EntryNameCheck {
  const name = raw.replace(/\\/g, "/");
  const wholeNameProblem = WHOLE_NAME_RULES.find((rule) => rule.refuse(name));

  if (wholeNameProblem) return { ok: false, code: "path", problem: wholeNameProblem.problem };

  const directory = name.endsWith("/");
  const body = directory ? name.slice(0, -1) : name;

  if (body === "") return { ok: false, code: "path", problem: "is empty" };

  const segments = body.split("/");

  for (const segment of segments) {
    const segmentProblem = SEGMENT_RULES.find((rule) => rule.refuse(segment));

    if (segmentProblem) return { ok: false, code: "path", problem: segmentProblem.problem };
  }

  if (!directory) {
    const last = segments[segments.length - 1] ?? "";

    // Lowercase exactly, because the scanner's pool grammar is case-sensitive:
    // `blue-01.MP3` would install, claim its voice, and never play.
    if (!ACCEPTED_EXTENSIONS.some((extension) => last.endsWith(extension))) {
      return { ok: false, code: "extension", problem: "is not a .mp3 or .json file (the extension must be lowercase)" };
    }
  }

  return { ok: true, segments, directory };
}

/**
 * Whether `candidate` is strictly below `dir`, by path arithmetic.
 *
 * A `startsWith` check accepts `…/luca-evil/x.mp3` as being inside `…/luca`.
 * `relative` answers the question the way the filesystem will: the candidate
 * is inside if the walk from `dir` to it never climbs (`..`) and never changes
 * root (an absolute result, which is what `relative` returns across drives).
 * The directory itself is not inside itself.
 *
 * Unreachable through {@link checkEntryName}, whose segments cannot climb, and
 * kept anyway: it is the one check that does not depend on the name rules
 * being complete, which is exactly the property a second line of defence has
 * to have.
 *
 * @internal Exported for testing
 */
export function isInsideDirectory(dir: string, candidate: string): boolean {
  const walk = relative(dir, candidate);

  return walk !== "" && !isAbsolute(walk) && walk !== ".." && !walk.startsWith(`..${sep}`);
}

/**
 * Wraps one of fflate's decoders so the extractor can see what it is fed.
 *
 * Two jobs, both forced by the synchronous inflater's shape. It counts the
 * compressed bytes pushed into the real decoder, which is the denominator of
 * the ratio cap — the header's `size` is not used for that, because the header
 * is the attacker's and is absent altogether for a streamed entry. And it
 * gives `terminate()` teeth: fflate's `UnzipFile.terminate()` only forwards to
 * a decoder that defines one, and `UnzipInflate` defines none, so without this
 * the call the extractor makes on a refused entry would do nothing at all.
 *
 * `current()` is read at construction. fflate constructs a decoder inside
 * `file.start()`, synchronously, so the extractor sets the entry it is about
 * to start immediately before calling `start()` and the decoder captures it
 * here. That is the only link between a decoder and its entry: the constructor
 * receives the name and the declared sizes, and neither identifies an entry
 * (names can repeat, and the sizes are the header's).
 *
 * @internal Exported for testing
 */
export function createCountingDecoder(
  Inner: UnzipDecoderConstructor,
  current: () => { compressed: number },
): UnzipDecoderConstructor {
  return class CountingDecoder implements UnzipDecoder {
    static compression = Inner.compression;
    ondata: AsyncFlateStreamHandler = () => {};
    private readonly inner: UnzipDecoder;
    private readonly counter: { compressed: number };
    private terminated = false;

    constructor(filename: string, size?: number, originalSize?: number) {
      this.counter = current();
      this.inner = new Inner(filename, size, originalSize);
      this.inner.ondata = (err, data, final) => this.ondata(err, data, final);
    }

    push(chunk: Uint8Array, final: boolean): void {
      if (this.terminated) return;

      this.counter.compressed += chunk.length;
      this.inner.push(chunk, final);
    }

    terminate = (): void => {
      this.terminated = true;
    };
  };
}

type Failure = { code: VoicePackArchiveFailureCode; reason: string };

/** One file entry from `start()` until its last chunk, or until it is abandoned. */
type OpenEntry = {
  /** As the archive spelled it, for messages. */
  name: string;
  /** POSIX path relative to the target — what `written` reports. */
  path: string;
  /** Absolute destination. */
  destination: string;
  /** Bytes handed to the decoder so far; the ratio's denominator. Written by {@link createCountingDecoder}. */
  compressed: number;
  /** Bytes the decoder has emitted so far; every cap's numerator. */
  produced: number;
  chunks: Uint8Array[];
  /** Set when the entry finished or was abandoned; no chunk after that is looked at. */
  closed: boolean;
};

type ExtractionState = {
  failure?: Failure;
  written: string[];
  /** Entries discovered, of any kind. */
  entries: number;
  /** Bytes produced across accepted entries. */
  totalBytes: number;
  /** Entries started and not yet closed — nonzero at the end means the archive ended inside one. */
  pending: number;
  /** Accepted file paths, lowercased: the target filesystem is case-insensitive. */
  seen: Set<string>;
  /** The entry about to be started, for the decoder wrapper to capture. */
  starting?: OpenEntry;
};

/**
 * A name as it may appear in a reason.
 *
 * The reason is rendered in the settings window and rides the deck host's
 * settings copy, and the name is the archive author's. Control and format
 * characters go — a newline would cost a banner row, a bidi override would
 * reverse how the rest of the sentence reads — and the name is cut to a length
 * a banner can hold.
 */
function describeEntry(name: string): string {
  const printable = name.replace(/[\p{Cc}\p{Cf}]/gu, "?");
  const clipped = printable.length > 80 ? `${printable.slice(0, 79)}…` : printable;

  return `"${clipped}"`;
}

function formatBytes(bytes: number): string {
  const unit = (value: number, suffix: string) => `${Number(value.toFixed(1))} ${suffix}`;

  if (bytes >= 1024 * 1024) return unit(bytes / (1024 * 1024), "MB");

  if (bytes >= 1024) return unit(bytes / 1024, "KB");

  return `${bytes} bytes`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Overrides are taken one by one and each must be a positive finite number.
 *
 * A cap is a comparison, and `produced > NaN`, `produced > undefined` and
 * `produced > Infinity` are all false for every `produced` — a caller's slip
 * would not loosen a cap, it would switch it off. Spreading the overrides
 * over the defaults has exactly that hole (an explicit `undefined` wins the
 * spread), so the merge is by hand.
 */
function resolveLimits(overrides: Partial<VoicePackArchiveLimits> | undefined): VoicePackArchiveLimits {
  const pick = (key: keyof VoicePackArchiveLimits): number => {
    const value = overrides?.[key];

    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : VOICE_PACK_ARCHIVE_LIMITS[key];
  };

  return {
    maxEntries: pick("maxEntries"),
    maxTotalBytes: pick("maxTotalBytes"),
    maxEntryBytes: pick("maxEntryBytes"),
    maxCompressionRatio: pick("maxCompressionRatio"),
    ratioGraceBytes: pick("ratioGraceBytes"),
  };
}

function concatChunks(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
}

/**
 * Extract `archive` into `targetDir`, refusing the whole archive at the first
 * entry that breaks a rule or a cap.
 *
 * Whole, not entry by entry: an archive that tries `../` once, or ships an
 * `.install.json`, or expands a thousandfold, is not one to keep installing
 * with the offending entry left out. Skipping would also hide a packer bug
 * from its author — a clip refused for an uppercase extension would simply be
 * absent from a pack that otherwise installed. The one thing skipped is a
 * directory entry with a benign name, which is structure rather than content.
 *
 * Resolves rather than rejects on every path, including a thrown parser: the
 * result is the only channel.
 */
export async function extractVoicePackArchive(
  options: ExtractVoicePackArchiveOptions,
): Promise<ExtractVoicePackArchiveResult> {
  const { archive, fs } = options;
  const limits = resolveLimits(options.limits);
  const state: ExtractionState = { written: [], entries: 0, totalBytes: 0, pending: 0, seen: new Set() };

  const fail = (code: VoicePackArchiveFailureCode, reason: string): void => {
    // The first refusal is the one that describes the archive; anything the
    // parser reports after it is a consequence of stopping.
    state.failure ??= { code, reason };
  };

  // A relative target would resolve against the process's working directory —
  // the plugin's own `bin/` under a deck host — and there is no archive whose
  // contents belong there.
  if (!isAbsolute(options.targetDir)) {
    return { ok: false, code: "write", reason: "target directory must be an absolute path", written: [] };
  }

  const target = resolve(options.targetDir);

  // The packer writes the first local header at offset 0, as does every zip
  // tool that is not producing a self-extractor. fflate's streaming reader
  // would happily scan past a prefix to find a header inside anything; that
  // is a tolerance, not a requirement, and it is not extended to a download.
  if (!startsWithLocalHeader(archive)) {
    return { ok: false, code: "malformed", reason: "not a zip archive", written: [] };
  }

  const abandon = (file: UnzipFile, entry: OpenEntry): void => {
    entry.closed = true;
    entry.chunks = [];
    state.pending -= 1;
    file.terminate();
  };

  const onData = (
    file: UnzipFile,
    entry: OpenEntry,
    err: FlateError | null,
    data: Uint8Array | null,
    final: boolean,
  ): void => {
    if (state.failure || entry.closed) return;

    if (err) {
      abandon(file, entry);
      fail("malformed", `entry ${describeEntry(entry.name)} could not be decompressed (${err.message})`);

      return;
    }

    if (data && data.length > 0) {
      entry.produced += data.length;
      state.totalBytes += data.length;

      // Ratio first: a bomb's first chunk crosses the per-entry cap as well,
      // and the message that names the attack is the useful one. All three
      // are judged on what came OUT, against what went IN — never on a size
      // a header declared.
      if (entry.produced > limits.ratioGraceBytes && entry.produced > limits.maxCompressionRatio * entry.compressed) {
        abandon(file, entry);
        fail(
          "compression-ratio",
          `entry ${describeEntry(entry.name)} expands more than ${limits.maxCompressionRatio}:1, which is the signature of a zip bomb`,
        );

        return;
      }

      if (entry.produced > limits.maxEntryBytes) {
        abandon(file, entry);
        fail(
          "entry-bytes",
          `entry ${describeEntry(entry.name)} expands to more than ${formatBytes(limits.maxEntryBytes)}`,
        );

        return;
      }

      if (state.totalBytes > limits.maxTotalBytes) {
        abandon(file, entry);
        fail("total-bytes", `archive expands to more than ${formatBytes(limits.maxTotalBytes)} in total`);

        return;
      }

      entry.chunks.push(data);
    }

    if (!final) return;

    entry.closed = true;
    state.pending -= 1;

    // A zero-byte manifest is not JSON and a zero-byte clip is not audio;
    // neither is an attack, but either is a packer that broke, and the scanner
    // downstream would report the pack as mute with the cause long gone.
    if (entry.produced === 0) {
      fail("malformed", `entry ${describeEntry(entry.name)} is empty`);

      return;
    }

    const made = fs.ensureDirectory(dirname(entry.destination));

    if (!made.ok) {
      fail("write", `could not create the folder for ${describeEntry(entry.name)} (${made.reason})`);

      return;
    }

    const wrote = fs.writeFile(entry.destination, concatChunks(entry.chunks, entry.produced));
    entry.chunks = [];

    if (!wrote.ok) {
      fail("write", `could not write ${describeEntry(entry.name)} (${wrote.reason})`);

      return;
    }

    state.written.push(entry.path);
  };

  const onEntry = (file: UnzipFile): void => {
    if (state.failure) return;

    // Counted at discovery, before any rule: the cap bounds the archive's
    // structure, and a hostile archive's structure is all it may cost.
    state.entries += 1;

    if (state.entries > limits.maxEntries) {
      fail("entry-count", `archive has more than ${limits.maxEntries} entries`);

      return;
    }

    const checked = checkEntryName(file.name);

    if (!checked.ok) {
      fail(checked.code, `entry ${describeEntry(file.name)} ${checked.problem}`);

      return;
    }

    if (checked.directory) return;

    const path = checked.segments.join("/");

    // Two entries for one name means whichever is written last wins, silently,
    // and on a case-insensitive disk `A.mp3` and `a.mp3` are one name.
    if (state.seen.has(path.toLowerCase())) {
      fail("path", `entry ${describeEntry(file.name)} appears more than once`);

      return;
    }

    state.seen.add(path.toLowerCase());

    const destination = resolve(target, ...checked.segments);

    if (!isInsideDirectory(target, destination)) {
      fail("path", `entry ${describeEntry(file.name)} resolves outside the pack folder`);

      return;
    }

    // Checked here rather than left to `start()`, which reports an unknown
    // method through `ondata` and then throws a TypeError constructing the
    // decoder it just said it did not have.
    if (file.compression !== METHOD_STORED && file.compression !== METHOD_DEFLATE) {
      fail(
        "malformed",
        `entry ${describeEntry(file.name)} uses compression method ${file.compression}, which iRaceDeck does not support`,
      );

      return;
    }

    // The declared size is used in ONE direction only. A header that claims
    // more than a cap allows is refused before a byte is inflated: if it is
    // telling the truth the counted check would refuse it later anyway, and
    // if it is lying upward the liar has only made their own archive fail
    // sooner. A header that claims LESS buys nothing — the counted checks in
    // `onData` are the ones that hold. Absent for a streamed entry.
    if (file.originalSize !== undefined) {
      if (file.originalSize > limits.maxEntryBytes) {
        fail(
          "entry-bytes",
          `entry ${describeEntry(file.name)} expands to more than ${formatBytes(limits.maxEntryBytes)}`,
        );

        return;
      }

      if (state.totalBytes + file.originalSize > limits.maxTotalBytes) {
        fail("total-bytes", `archive expands to more than ${formatBytes(limits.maxTotalBytes)} in total`);

        return;
      }
    }

    const entry: OpenEntry = {
      name: file.name,
      path,
      destination,
      compressed: 0,
      produced: 0,
      chunks: [],
      closed: false,
    };

    file.ondata = (err, data, final) => onData(file, entry, err, data, final);
    state.starting = entry;
    state.pending += 1;

    try {
      file.start();
    } catch (err) {
      fail("malformed", `entry ${describeEntry(file.name)} could not be read (${errorMessage(err)})`);
    } finally {
      state.starting = undefined;
    }
  };

  const unzip = new Unzip(onEntry);
  const counterFor = () => state.starting ?? { compressed: 0 };
  unzip.register(createCountingDecoder(UnzipPassThrough, counterFor));
  unzip.register(createCountingDecoder(UnzipInflate, counterFor));

  let slices = 0;

  try {
    for (let offset = 0; offset < archive.length && !state.failure; offset += VOICE_PACK_ARCHIVE_PUSH_BYTES) {
      const end = Math.min(offset + VOICE_PACK_ARCHIVE_PUSH_BYTES, archive.length);

      unzip.push(archive.subarray(offset, end), end === archive.length);
      slices += 1;

      if (slices % SLICES_PER_TURN === 0 && end < archive.length) await nextTurn();
    }
  } catch (err) {
    // fflate throws for a header it cannot finish parsing and for an archive
    // that ends inside an entry's declared length. Anything it throws after
    // a refusal is the refusal's own doing and is not reported over it.
    fail("malformed", `archive is damaged or truncated (${errorMessage(err)})`);
  }

  // A streamed entry ends only when the parser finds its descriptor or the
  // next header; an archive cut inside one never delivers `final`, and fflate
  // reports nothing about it.
  if (!state.failure && state.pending > 0) fail("malformed", "archive is damaged or truncated (an entry never ended)");

  if (!state.failure && state.written.length === 0) fail("empty", "archive contains no files");

  return state.failure
    ? { ok: false, code: state.failure.code, reason: state.failure.reason, written: state.written }
    : { ok: true, written: state.written };
}

function startsWithLocalHeader(archive: Uint8Array): boolean {
  if (archive.length < 4) return false;

  return (
    new DataView(archive.buffer, archive.byteOffset, archive.byteLength).getUint32(0, true) === LOCAL_HEADER_SIGNATURE
  );
}
