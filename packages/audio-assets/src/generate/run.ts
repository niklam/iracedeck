import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  buildEntryLookup,
  buildEntryOptions,
  entryHash,
  isReference,
  resolveEntryRequestIds,
  type VoiceConfig,
} from "./config.ts";
import { describeDriverNameAlias, driverNameAliasOf } from "./driver-name-aliases.ts";
import type { SynthesizeOptions, SynthesizeResult } from "./elevenlabs.ts";
import { clipRelPath, type Conditioning, type Manifest } from "./manifest.ts";
import {
  type ApprovedPauseMarks,
  describePauseMarks,
  findEntryPauseMarks,
  type GrandfatheredPauseMarks,
  pauseMarkStanding,
} from "./pause-marks.ts";
import { entryReferences, type OrderedEntry, orderVoices, topologicalEntryOrder } from "./run-order.ts";
import type { Scope } from "./scope.ts";

/** One ElevenLabs request, the API key already bound. Injected so no test can reach the paid API. */
export type Synthesize = (options: Omit<SynthesizeOptions, "apiKey">) => Promise<SynthesizeResult>;

export interface RunLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RunOptions {
  voiceConfigs: Map<string, VoiceConfig>;
  /** `generate.manifest.json`, mutated in place on a live run. */
  manifest: Manifest;
  scope: Scope;
  dryRun: boolean;
  /** The package root: clips live at `<root>/voice/…`, the processed cache at `<root>/.cache`. */
  root: string;
  synthesize: Synthesize;
  /** Writes the manifest; called after every clip a live run writes, so a crash mid-run loses nothing. */
  persistManifest: (manifest: Manifest) => void;
  /** How a failed save is retried; `MANIFEST_SAVE_RETRY` when omitted. */
  manifestSaveRetry?: ManifestSaveRetry;
  /** voice id → `<group>/<name>` → the frozen text a pause mark is grandfathered for. */
  grandfathered?: GrandfatheredPauseMarks;
  /** voice id → `<group>/<name>` → the text Niklas approved a pause mark in (#1643). */
  approved?: ApprovedPauseMarks;
  now?: () => Date;
  log?: RunLog;
}

export interface RunCounts {
  /** Requested from ElevenLabs (or would be, in a dry run). */
  generated: number;
  /** Copied from another voice's take of the identical request (or would be, in a dry run). */
  copied: number;
  skipped: number;
  failed: number;
  /** A pause mark, or a dependency that is out of date and not cut in this run. */
  refused: number;
}

export interface RunResult {
  totals: RunCounts;
  /** Per voice, in the order the run visited them. */
  perVoice: Map<string, RunCounts>;
  /**
   * The clips written in this run whose manifest rows are not on disk: every
   * save failed, the final one included. Empty on success; anything here
   * fails the run, since the next run would pay to cut these clips again.
   */
  unsavedRows: string[];
}

/** What became of an entry this run; only entries in scope get one. */
type Outcome = "cut" | "skipped" | "failed" | "refused";

const consoleLog: RunLog = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export function emptyCounts(): RunCounts {
  return { generated: 0, copied: 0, skipped: 0, failed: 0, refused: 0 };
}

export function textPreview(text: string, max = 60): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/**
 * Drop the processed mp3 for `relPath` from every filter-hash subdir under
 * `<root>/.cache/`. No-op when `.cache/` doesn't exist yet (clean tree).
 *
 * This used to be the ONLY thing standing between a re-cut clip and a stale
 * processed copy: the build helper compared mtimes, which a git checkout or a
 * `cp -p` defeats by preserving an older source mtime on changed content.
 * Since #1143 the build keys on the source BYTES, so a re-cut clip invalidates
 * itself and this is belt-and-braces — kept because deleting what we know is
 * dead costs nothing. It leaves the entry's `.src.sha256` sidecar behind; with
 * the clip gone the cache reads as stale anyway, and the next build overwrites
 * both.
 */
export function invalidateProcessedCache(root: string, relPath: string): void {
  const cacheRoot = path.join(root, ".cache");

  if (!existsSync(cacheRoot)) return;

  for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    rmSync(path.join(cacheRoot, entry.name, relPath), { force: true });
  }
}

type ManifestRow = Manifest["entries"][string];

/** How a failed manifest save is retried: `attempts` writes in all, `delayMs` apart. */
export interface ManifestSaveRetry {
  attempts: number;
  delayMs: number;
  /** Blocks for `ms`; a test's seam. Defaults to a synchronous wait. */
  sleep?: (ms: number) => void;
}

/**
 * Three attempts a quarter of a second apart: long enough to outlast the
 * brief lock Windows takes on a file another process (an indexer, a virus
 * scanner, an editor) has just opened, which is what failed a real save on
 * #1643 ("UNKNOWN: unknown error, open …generate.manifest.json").
 */
export const MANIFEST_SAVE_RETRY: ManifestSaveRetry = { attempts: 3, delayMs: 250 };

function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let tempFileCounter = 0;

/**
 * Put a clip at `absPath` all at once (#1643): `write` fills a temp file
 * beside it, under a name unique to this process and call, which is then
 * renamed onto `absPath`. A write that fails part-way (a full disk) leaves
 * the temp file, which is removed, never a partial mp3 at `absPath` that a
 * matching manifest row would read as a cache hit or a copy would reuse.
 * Throws whatever `write` or the rename threw; the previous clip, if any, is
 * then untouched.
 */
export function placeFileAtomically(absPath: string, write: (tempPath: string) => void): void {
  mkdirSync(path.dirname(absPath), { recursive: true });

  const tempPath = `${absPath}.${process.pid}.${tempFileCounter++}.tmp`;

  try {
    write(tempPath);
    renameSync(tempPath, absPath);
  } catch (err) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // The original failure is the one worth reporting.
    }

    throw err;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The manifest's writer for a run or an import (#1643). A clip that is on
 * disk with its row set in memory is done, whatever the save does: a failed
 * save must never mark it failed, fail its dependents, or lose its row.
 *
 * `save` writes after each clip, retrying a failure `retry.attempts` times
 * in all. Still failing, it warns and keeps the clip in its unsaved set; the
 * next successful save writes the whole manifest, that row included, and
 * clears the set. `flush` is the run's last attempt: when anything is
 * unsaved it saves once more (retried alike) and returns the clips whose
 * rows are still not on disk, naming them in an error.
 */
export class ManifestSaver {
  private readonly unsaved = new Set<string>();
  private readonly manifest: Manifest;
  private readonly persist: (manifest: Manifest) => void;
  private readonly log: RunLog;
  private readonly tag: string;
  private readonly retry: ManifestSaveRetry;

  /** `tag` is the log prefix: `generate` or `import`. */
  constructor(
    manifest: Manifest,
    persist: (manifest: Manifest) => void,
    log: RunLog,
    tag: string,
    retry: ManifestSaveRetry = MANIFEST_SAVE_RETRY,
  ) {
    this.manifest = manifest;
    this.persist = persist;
    this.log = log;
    this.tag = tag;
    this.retry = retry;
  }

  /** Save after `relPath`'s row was set. Never throws. */
  save(relPath: string): void {
    this.unsaved.add(relPath);

    const err = this.attempt();

    if (err === null) return;

    this.log.warn(
      `[${this.tag}] ${relPath}  —  manifest save failed after ${this.retry.attempts} attempt(s): ${errorMessage(err)}. ` +
        "The clip and its row are kept; the manifest is saved again before the run ends.",
    );
  }

  /**
   * Drop `relPath`'s row and save the manifest without it, retried as `save`
   * is, BEFORE new bytes go to that path: a row must never vouch for bytes it
   * does not describe, which it would if the bytes were replaced and every
   * later save failed. Returns null once the removal is on disk. On failure
   * the row is put back in memory, since the bytes it describes have not
   * moved, and the error is returned: the caller must not place the file.
   * Never throws.
   */
  invalidate(relPath: string): unknown {
    const row = this.manifest.entries[relPath];

    if (row === undefined) return null;

    delete this.manifest.entries[relPath];

    const err = this.attempt();

    if (err !== null) this.manifest.entries[relPath] = row;

    return err;
  }

  /** The final save when a row is unsaved; returns the clips whose rows are still not on disk. */
  flush(): string[] {
    if (this.unsaved.size === 0) return [];

    const pending = [...this.unsaved];
    const err = this.attempt();

    if (err === null) {
      this.log.info(`[${this.tag}] manifest saved on the final attempt, with the rows of ${pending.join(", ")}`);

      return [];
    }

    this.log.error(
      `[${this.tag}] FAILED to save the manifest: ${errorMessage(err)}. These clips are on disk without their ` +
        `rows, and the next run would cut them again: ${pending.join(", ")}`,
    );

    return pending;
  }

  /** One retried save: null when it landed, else the last error. Clears the unsaved set on success. */
  private attempt(): unknown {
    const attempts = Math.max(1, this.retry.attempts);
    const sleep = this.retry.sleep ?? sleepSync;
    let last: unknown = null;

    for (let i = 0; i < attempts; i++) {
      if (i > 0) sleep(this.retry.delayMs);

      try {
        this.persist(this.manifest);
        this.unsaved.clear();

        return null;
      } catch (err) {
        last = err ?? new Error("unknown error");
      }
    }

    return last;
  }
}

/**
 * A take another voice may copy: a clip with its manifest row, or — in a dry
 * run only — one this run would write (`row` null), so the dry run reports
 * the copies the live run will make.
 */
export interface TakeSource {
  relPath: string;
  voiceName: string;
  /** `<group>/<entry-name>` */
  key: string;
  row: ManifestRow | null;
}

const CLIP_REL_PATH = /^voice\/([^/]+)\/([^/]+)\/([^/]+)\.mp3$/;

/** `voice/<voice>/<group>/<name>.mp3` → its voice and `<group>/<name>` key, or null for any other path. */
export function parseClipRelPath(relPath: string): { voiceName: string; key: string } | null {
  const match = CLIP_REL_PATH.exec(relPath);

  return match ? { voiceName: match[1]!, key: `${match[2]}/${match[3]}` } : null;
}

/**
 * Every take the run knows of, by the hash of the request that cut it: the
 * manifest's rows at the start, and each clip the run writes (or would
 * write) as it goes, replacing that path's previous row so a superseded
 * take is never offered.
 */
class TakeIndex {
  private readonly byHash = new Map<string, Map<string, TakeSource>>();
  private readonly hashByRelPath = new Map<string, string>();

  constructor(manifest: Manifest) {
    for (const [relPath, row] of Object.entries(manifest.entries)) {
      const parsed = parseClipRelPath(relPath);

      if (parsed) this.set(row.hash, { relPath, ...parsed, row });
    }
  }

  set(hash: string, source: TakeSource): void {
    const previous = this.hashByRelPath.get(source.relPath);

    if (previous !== undefined) this.byHash.get(previous)?.delete(source.relPath);

    this.hashByRelPath.set(source.relPath, hash);

    let sources = this.byHash.get(hash);

    if (!sources) {
      sources = new Map();
      this.byHash.set(hash, sources);
    }

    sources.set(source.relPath, source);
  }

  sources(hash: string): TakeSource[] {
    return Array.from(this.byHash.get(hash)?.values() ?? []);
  }
}

/** The row fields a dry run's planned clip stands on in `resolutionView`; only its request id is read. */
const PLANNED_ROW: ManifestRow = { hash: "", voiceId: "", model: "", textPreview: "", generatedAt: "" };

/** `voice/<voice>/<group>/<name>.mp3` for a `<group>/<name>` key. */
function relPathFor(voiceName: string, key: string): string {
  const slash = key.indexOf("/");

  return clipRelPath(voiceName, key.slice(0, slash), key.slice(slash + 1));
}

/** The `--voice/--group/--entry` flags that would cut exactly one entry. */
export function scopeFlagsFor(voiceName: string, key: string): string {
  const slash = key.indexOf("/");

  return `--voice ${voiceName} --group ${key.slice(0, slash)} --entry ${key.slice(slash + 1)}`;
}

/**
 * The conditioning a request sends, or undefined when it sends no request
 * ids at all; a list the request leaves out is left out here too.
 */
export function conditioningOf(previous: string[] | undefined, next: string[] | undefined): Conditioning | undefined {
  if (previous === undefined && next === undefined) return undefined;

  return { ...(previous !== undefined ? { previous } : {}), ...(next !== undefined ? { next } : {}) };
}

/** Whether `here` (this voice's resolution, `null` for an unresolvable reference) is exactly `recorded`, in order. */
function sameIds(here: readonly (string | null)[] | undefined, recorded: readonly string[] | undefined): boolean {
  const a = here ?? [];
  const b = recorded ?? [];

  return a.length === b.length && a.every((id, i) => id !== null && id === b[i]);
}

/**
 * The generator's run: every voice in scope (Default first), each voice's
 * entries in scope dependencies-first, each one skipped, refused, or cut.
 *
 * - **Cache hit** — the manifest row's hash equals the entry's current hash
 *   and the clip exists: skipped. A cached entry is never re-cut because a
 *   dependency changed (#1643, see `entryHash`).
 * - **Refused for a stale dependency** — an entry about to be cut whose
 *   referenced entry is out of date (no row, a row whose hash differs from
 *   that entry's config, or a missing clip) and is not cut earlier in this
 *   run. Cutting it would condition a new take on a superseded one — on the
 *   model change, a v4 take on a Flash take. The refusal names the
 *   dependency and the scope that cuts it; the dry run reports the same.
 * - **Failed with its dependency** — a dependency in scope that failed or was
 *   refused in this run fails every entry conditioned on it, naming it. It
 *   never falls back to the request id the manifest held before.
 * - **Copied** — an entry whose request is identical to a take another
 *   voice already holds (or cut earlier in this run) gets that take's bytes
 *   and request id instead of a new API call: a request already paid for is
 *   never paid again. Identical means the same hash, a source row that is
 *   current in its own voice and has a request id, AND the request ids this
 *   voice would send equal to the ones the source take was conditioned on:
 *   its row's `conditionedOn`. A row without one (written before it was
 *   recorded, or `--import`ed) is copied only into an entry that references
 *   nothing, since nothing proves what it was conditioned on
 *   (`pickCopySource`). Default runs first, so the verbatim entries of Short
 *   callouts find the fresh Default takes.
 *
 * A dry run decides exactly as a live run would. It keeps the request id
 * each clip would hold by the end of the run in `planned`: a would-generate
 * clip gets a placeholder unique to it, a would-copy clip its source's id,
 * so a copy decision downstream of either resolves the same way it will
 * live, and the dry run's counts are the live run's.
 *
 * Returns the counts; the caller decides the exit code.
 */
export async function runGeneration(options: RunOptions): Promise<RunResult> {
  const { voiceConfigs, manifest, scope, dryRun, root, synthesize, persistManifest } = options;
  const grandfathered = options.grandfathered ?? {};
  const approved = options.approved ?? {};
  const now = options.now ?? (() => new Date());
  const log = options.log ?? consoleLog;
  const saver = new ManifestSaver(manifest, persistManifest, log, "generate", options.manifestSaveRetry);
  // Belt-and-braces (see `invalidateProcessedCache`), so a failure here only
  // warns: the clip and its row are already in place.
  const dropProcessed = (relPath: string): void => {
    try {
      invalidateProcessedCache(root, relPath);
    } catch (err) {
      log.warn(`[generate] ${relPath}  —  could not drop its processed copies: ${errorMessage(err)}`);
    }
  };

  const totals = emptyCounts();
  const perVoice = new Map<string, RunCounts>();
  const clipExists = (relPath: string): boolean => existsSync(path.join(root, relPath));
  const takes = new TakeIndex(manifest);
  // relPath → the request id that clip holds now in this run: what this run
  // wrote, or (dry run) would write. Absent → the manifest's row.
  const planned = new Map<string, string | null>();
  const requestIdAt = (relPath: string): string | null =>
    planned.has(relPath) ? planned.get(relPath)! : (manifest.entries[relPath]?.requestId ?? null);
  // relPath → what the take that clip holds now in this run was conditioned
  // on (would be, in a dry run). Absent → the manifest's row.
  const plannedConditioning = new Map<string, Conditioning | undefined>();
  const conditioningAt = (relPath: string): Conditioning | undefined =>
    plannedConditioning.has(relPath) ? plannedConditioning.get(relPath) : manifest.entries[relPath]?.conditionedOn;
  // voice name → `<group>/<name>` → the entry's current hash in its config.
  const currentHashes = new Map<string, Map<string, string>>();
  const currentHashOf = (voiceName: string, key: string): string | null => {
    let hashes = currentHashes.get(voiceName);

    if (!hashes) {
      const voice = voiceConfigs.get(voiceName);

      hashes = new Map();

      if (voice) for (const [ref, { entry }] of buildEntryLookup(voice)) hashes.set(ref, entryHash(entry, voice));

      currentHashes.set(voiceName, hashes);
    }

    return hashes.get(key) ?? null;
  };

  for (const voiceName of orderVoices(voiceConfigs.keys())) {
    if (scope.voices && !scope.voices.includes(voiceName)) continue;

    const voice = voiceConfigs.get(voiceName)!;
    const counts = emptyCounts();
    const count = (field: keyof RunCounts): void => {
      counts[field]++;
      totals[field]++;
    };

    perVoice.set(voiceName, counts);

    const order = topologicalEntryOrder(voice);
    const hashes = new Map(order.map((node) => [node.key, entryHash(node.entry, voice)]));
    const outcomes = new Map<string, Outcome>();
    const relPathOf = (key: string): string => relPathFor(voiceName, key);
    /** The ids `ids` resolve to in this voice now (planned, in a dry run); `null` where a reference has none. */
    const resolveHere = (ids: readonly string[] | undefined): (string | null)[] | undefined =>
      ids?.map((id) => (isReference(id) ? requestIdAt(relPathOf(id)) : id));
    /**
     * The rows `resolveEntryRequestIds` reads for `references`, as this run
     * holds them: the manifest's, with the request id each clip holds now in
     * the run (in a dry run, the planned one) laid over it.
     */
    const resolutionView = (references: readonly string[]): Manifest => {
      const entries: Manifest["entries"] = {};

      for (const ref of references) {
        const relPath = relPathOf(ref);
        const row = manifest.entries[relPath];

        if (planned.has(relPath)) {
          entries[relPath] = { ...(row ?? PLANNED_ROW), requestId: planned.get(relPath) ?? null };
        } else if (row) {
          entries[relPath] = row;
        }
      }

      return { version: 1, entries };
    };

    /** Why the clip `key` names is out of date, or null when its row and file match its config. */
    const staleness = (key: string): string | null => {
      const relPath = relPathOf(key);
      const row = manifest.entries[relPath];

      if (!row) return "it has no manifest row";

      if (row.hash !== hashes.get(key)) return "its manifest row was cut from a different config";

      if (!clipExists(relPath)) return "its clip is missing";

      return null;
    };

    // Request id → the clip of THIS voice holding that take, and the sources
    // this voice has copied from in this run: one take is never copied into
    // two clips of the same voice (see `pickCopySource`).
    const heldRequestIds = new Map<string, string>();

    for (const relPath of Object.keys(manifest.entries)) {
      const requestId = requestIdAt(relPath);

      if (requestId && parseClipRelPath(relPath)?.voiceName === voiceName) heldRequestIds.set(requestId, relPath);
    }

    const copiedFrom = new Set<string>();

    /**
     * Record a clip this voice now holds — or would hold, in a dry run, with
     * `row` null and `requestId` its planned id — so later lookups see it.
     */
    const recordTake = (
      key: string,
      relPath: string,
      hash: string,
      row: ManifestRow | null,
      requestId: string | null,
      conditionedOn: Conditioning | undefined,
    ): void => {
      const previous = requestIdAt(relPath);

      if (previous && heldRequestIds.get(previous) === relPath) heldRequestIds.delete(previous);

      if (requestId) heldRequestIds.set(requestId, relPath);

      planned.set(relPath, requestId);
      plannedConditioning.set(relPath, conditionedOn);
      takes.set(hash, { relPath, voiceName, key, row });
    };

    const inScope = (node: OrderedEntry): boolean =>
      (!scope.groups || scope.groups.includes(node.groupName)) &&
      (!scope.entries || scope.entries.includes(node.entry.name));

    for (const node of order) {
      if (!inScope(node)) continue;

      const { key, groupName, entry } = node;
      const relPath = clipRelPath(voiceName, groupName, entry.name);
      const absPath = path.join(root, relPath);
      const hash = hashes.get(key)!;
      const manifestEntry = manifest.entries[relPath];
      const cached = manifestEntry?.hash === hash && clipExists(relPath);

      // A driver-name alias (#1580) plays its canonical's clips, so an entry
      // recording one in a name group is refused, dry run included — a batch
      // that re-adds `geoff` fails before it is paid for. Ahead of the cache
      // hit, like the pause-mark refusal below.
      const aliasOf = driverNameAliasOf(groupName, entry.name);

      if (aliasOf !== null) {
        log.error(`[generate] ${relPath}  —  REFUSED: ${describeDriverNameAlias(entry.name, aliasOf)}`);
        outcomes.set(key, "refused");
        count("refused");
        continue;
      }

      // Refused in a dry run alike, so an author sees it before spending
      // credit (#1518), and ahead of the cache hit, so a marked clip copied
      // in with its manifest row is refused too. A grandfathered entry whose
      // text is unchanged is re-cut as before — a voice-wide setting reaches
      // it — but said so; an approved one (#1643) is cut quietly.
      const pauseMarks = findEntryPauseMarks(entry);
      const standing = pauseMarkStanding(entry, {
        grandfathered: grandfathered[voiceName]?.[key],
        approved: approved[voiceName]?.[key],
      });

      if (standing === "refused") {
        log.error(`[generate] ${relPath}  —  REFUSED: ${describePauseMarks(pauseMarks)}`);
        outcomes.set(key, "refused");
        count("refused");
        continue;
      }

      if (cached) {
        outcomes.set(key, "skipped");
        count("skipped");
        continue;
      }

      // Never cut against a stale dependency (#1643). A dependency cut
      // earlier in this run (topological order puts it first) is current by
      // construction; one this run failed or refused takes its dependents
      // down with it; any other must already be current on disk.
      const failedDeps: string[] = [];
      const staleDeps: string[] = [];

      for (const ref of entryReferences(entry)) {
        const outcome = outcomes.get(ref);

        if (outcome === "cut") continue;

        if (outcome === "failed" || outcome === "refused") {
          failedDeps.push(`dependency "${ref}" ${outcome === "failed" ? "failed" : "was refused"} in this run`);
          continue;
        }

        const why = staleness(ref);

        if (why !== null) {
          staleDeps.push(
            `dependency "${ref}" is out of date (${why}) and is not cut in this run; ` +
              `cut it first with ${scopeFlagsFor(voiceName, ref)}`,
          );
        }
      }

      if (failedDeps.length > 0) {
        log.error(`[generate] ${relPath}  —  FAILED: ${failedDeps.join("; ")}`);
        outcomes.set(key, "failed");
        count("failed");
        continue;
      }

      if (staleDeps.length > 0) {
        log.error(`[generate] ${relPath}  —  REFUSED: ${staleDeps.join("; ")}`);
        outcomes.set(key, "refused");
        count("refused");
        continue;
      }

      if (standing === "grandfathered") {
        log.warn(`[generate] ${relPath}  —  grandfathered text: ${describePauseMarks(pauseMarks)}`);
      }

      // A request already paid for is never paid again (#1643). The hash
      // covers the ElevenLabs voice id, the model, every audio-affecting
      // option and the RAW reference strings — but a reference resolves per
      // voice, to that voice's own take of the entry it names. So a take is
      // the same request only when the hash matches AND the request ids this
      // voice would send are the ones the take was conditioned on; then copy
      // its bytes and its request id instead of a call. Otherwise this
      // voice's seam differs, and the entry is cut.
      const references = entryReferences(entry);
      const here = { previous: resolveHere(entry.previous_request_ids), next: resolveHere(entry.next_request_ids) };
      const source = pickCopySource(takes.sources(hash), {
        voiceName,
        key,
        relPath,
        clipExists,
        requestIdOf: requestIdAt,
        heldRequestIds,
        copiedFrom,
        // A row is trusted only while it is current in its own voice: a clip
        // re-cut there whose row never reached disk (every save failed, or
        // the process died between the write and the save) still carries
        // its OLD hash beside NEW bytes. A pending take (dry run) is current
        // by construction.
        isCurrent: (candidate) =>
          candidate.row === null || currentHashOf(candidate.voiceName, candidate.key) === candidate.row.hash,
        resolvesAlike: (candidate) => {
          const recorded = conditioningAt(candidate.relPath);

          // What the take was really conditioned on, when its row says.
          if (recorded !== undefined) {
            return sameIds(here.previous, recorded.previous) && sameIds(here.next, recorded.next);
          }

          // A row with no record of its conditioning (written before it was
          // recorded, or `--import`ed) proves nothing about it: what its
          // references resolve to today may not be what it was cut against,
          // since a dependency may have been re-cut in both voices since.
          // Only an entry that references nothing can be copied from it.
          return references.length === 0;
        },
      });

      if (source) {
        log.info(`${dryRun ? "[dry-run] WOULD COPY" : "[copy]"} ${relPath} from ${source.relPath}`);

        if (dryRun) {
          copiedFrom.add(source.relPath);
          recordTake(key, relPath, hash, null, requestIdAt(source.relPath), conditioningAt(source.relPath));
          outcomes.set(key, "cut");
          count("copied");
          continue;
        }

        try {
          placeFileAtomically(absPath, (tempPath) => copyFileSync(path.join(root, source.relPath), tempPath));
        } catch (err) {
          log.error(`[copy] ${relPath}  —  FAILED: ${errorMessage(err)}`);
          outcomes.set(key, "failed");
          count("failed");
          continue;
        }

        // The clip is on disk: from here it is cut, whatever the save does.
        // The take's own conditioning travels with it.
        const sourceRow = source.row!;
        const row: ManifestRow = {
          hash,
          voiceId: voice.id,
          model: sourceRow.model,
          textPreview: sourceRow.textPreview,
          generatedAt: now().toISOString(),
          requestId: sourceRow.requestId,
          ...(sourceRow.conditionedOn !== undefined ? { conditionedOn: sourceRow.conditionedOn } : {}),
        };

        recordTake(key, relPath, hash, row, row.requestId ?? null, row.conditionedOn);
        manifest.entries[relPath] = row;
        copiedFrom.add(source.relPath);
        outcomes.set(key, "cut");
        count("copied");
        dropProcessed(relPath);
        saver.save(relPath);
        continue;
      }

      let synthOptions: Omit<SynthesizeOptions, "apiKey">;

      try {
        // Resolve `<group>/<entry-name>` references to the provider request
        // IDs of the dependencies' current takes — rows the checks above
        // proved current, or wrote (would write) earlier in this run. One
        // resolution for both modes, through `resolutionView`, so a dry run
        // fails exactly what the live run fails (a dependency row with no
        // request id), with the same message, and its dependents with it.
        synthOptions = resolveEntryRequestIds(buildEntryOptions(entry, voice), voiceName, resolutionView(references));
      } catch (err) {
        log.error(`[generate] ${relPath}  —  FAILED: ${errorMessage(err)}`);
        outcomes.set(key, "failed");
        count("failed");
        continue;
      }

      const prefix = dryRun ? "[dry-run] WOULD GENERATE" : "[generate]";

      log.info(`${prefix} ${relPath}  —  "${textPreview(entry.text)}"`);

      if (dryRun) {
        // A placeholder no provider id can equal, unique to this clip: a
        // fresh take matches nothing but itself and its copies. It would be
        // conditioned on the ids just resolved, planned ones included.
        recordTake(
          key,
          relPath,
          hash,
          null,
          `planned:${relPath}`,
          conditioningOf(synthOptions.previous_request_ids, synthOptions.next_request_ids),
        );
        outcomes.set(key, "cut");
        count("generated");
        continue;
      }

      let requestId: SynthesizeResult["requestId"];

      try {
        const take = await synthesize(synthOptions);

        requestId = take.requestId;
        placeFileAtomically(absPath, (tempPath) => writeFileSync(tempPath, take.mp3));
      } catch (err) {
        log.error(`[generate] ${relPath}  —  FAILED: ${errorMessage(err)}`);
        outcomes.set(key, "failed");
        count("failed");
        continue;
      }

      // The paid take is on disk: from here it is cut, whatever the save
      // does. A failed save is retried, and the run saves once more before
      // it returns (`ManifestSaver`), so the row is never lost silently.
      const conditionedOn = conditioningOf(synthOptions.previous_request_ids, synthOptions.next_request_ids);
      const row: ManifestRow = {
        hash,
        voiceId: voice.id,
        model: synthOptions.model_id,
        textPreview: textPreview(entry.text, 80),
        generatedAt: now().toISOString(),
        requestId,
        ...(conditionedOn !== undefined ? { conditionedOn } : {}),
      };

      recordTake(key, relPath, hash, row, requestId, conditionedOn);
      manifest.entries[relPath] = row;
      outcomes.set(key, "cut");
      count("generated");
      dropProcessed(relPath);
      // Persist after every clip so a crash mid-run doesn't lose progress
      // or force re-fetches on the next invocation.
      saver.save(relPath);
    }
  }

  return { totals, perVoice, unsavedRows: saver.flush() };
}

/**
 * The take an entry copies instead of a new request, or null to request one.
 *
 * Eligible: a take of the same hash under ANOTHER voice whose clip exists (or,
 * in a dry run, one this run would write). Never one of the entry's own
 * voice: pool variants (`blue-01`, `blue-02`) share text and, with every seed
 * at 1, a hash; they are distinct takes on purpose, and copying one into the
 * other would collapse the pool. For the same reason a take is never copied
 * into two clips of one voice: a source this voice copied from earlier in the
 * run, or whose request id another of its clips already holds, is passed over.
 * Of the rest, the take under the same `<group>/<entry-name>` wins, so each
 * variant copies its own counterpart; otherwise the first known.
 *
 * Never a take that cannot be proven to be this request: one whose row is
 * not current in its own voice (`isCurrent`: its entry is gone, or its row's
 * hash is not that entry's hash today; a clip re-cut there whose row never
 * reached disk carries its old hash beside new bytes), and never one with no
 * request id, which no dependent could be conditioned on either and which
 * the held-id guard above cannot see, so a pool could collapse through it.
 *
 * And only a take whose request really was this one: `resolvesAlike` holds
 * when the request ids this entry would send are the ones the take was
 * conditioned on. A voice whose dependency is a different take (different
 * text, cut separately, or re-cut since the take was made) gets its own
 * take, conditioned on its own dependency.
 */
export function pickCopySource(
  candidates: readonly TakeSource[],
  target: {
    voiceName: string;
    key: string;
    relPath: string;
    clipExists: (relPath: string) => boolean;
    /** The request id a clip holds at this point of the run (planned, in a dry run). */
    requestIdOf: (relPath: string) => string | null;
    heldRequestIds: ReadonlyMap<string, string>;
    copiedFrom: ReadonlySet<string>;
    /** Whether the source's row is current in its own voice's config. */
    isCurrent: (source: TakeSource) => boolean;
    resolvesAlike: (source: TakeSource) => boolean;
  },
): TakeSource | null {
  const eligible = candidates.filter((source) => {
    if (source.voiceName === target.voiceName) return false;

    if (target.copiedFrom.has(source.relPath)) return false;

    if (!target.isCurrent(source)) return false;

    const requestId = target.requestIdOf(source.relPath);

    if (requestId === null) return false;

    const holder = target.heldRequestIds.get(requestId);

    if (holder !== undefined && holder !== target.relPath) return false;

    // A pending source (dry run) has no clip yet; a real one must have its clip.
    if (source.row !== null && !target.clipExists(source.relPath)) return false;

    return target.resolvesAlike(source);
  });

  return eligible.find((source) => source.key === target.key) ?? eligible[0] ?? null;
}

function describeCounts(counts: RunCounts, dryRun: boolean): string {
  const would = dryRun ? "would be " : "";

  return (
    `${counts.generated} ${would}generated, ${counts.copied} ${would}copied, ${counts.skipped} skipped (cache hit), ` +
    `${counts.failed} failed, ${counts.refused} refused (pause marks, driver-name aliases or a stale dependency)`
  );
}

/**
 * The closing summary: the totals line, then one line per voice when more
 * than one ran, then the clips whose manifest rows could not be saved.
 */
export function formatRunSummary(result: RunResult, dryRun: boolean): string[] {
  const lines = [`Done. ${describeCounts(result.totals, dryRun)}`];

  if (result.perVoice.size > 1) {
    for (const [voiceName, counts] of result.perVoice) lines.push(`  ${voiceName}: ${describeCounts(counts, dryRun)}`);
  }

  if (result.unsavedRows.length > 0) {
    lines.push(
      `Manifest NOT saved: ${result.unsavedRows.length} clip(s) on disk have no row in generate.manifest.json, ` +
        `and the next run would cut them again: ${result.unsavedRows.join(", ")}`,
    );
  }

  return lines;
}
