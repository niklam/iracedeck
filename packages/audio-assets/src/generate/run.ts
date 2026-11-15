import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildEntryOptions, entryHash, resolveEntryRequestIds, type VoiceConfig } from "./config.ts";
import { describeDriverNameAlias, driverNameAliasOf } from "./driver-name-aliases.ts";
import type { SynthesizeOptions, SynthesizeResult } from "./elevenlabs.ts";
import { clipRelPath, type Manifest } from "./manifest.ts";
import {
  describePauseMarks,
  findEntryPauseMarks,
  type GrandfatheredPauseMarks,
  isGrandfathered,
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
  /** voice id → `<group>/<name>` → the frozen text a pause mark is grandfathered for. */
  grandfathered?: GrandfatheredPauseMarks;
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
 *   never paid again. Identical means the same hash AND every
 *   `<group>/<entry-name>` reference resolving to the same provider request
 *   id in both voices (`pickCopySource`). Default runs first, so the verbatim
 *   entries of Short callouts find the fresh Default takes.
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
  const now = options.now ?? (() => new Date());
  const log = options.log ?? consoleLog;

  const totals = emptyCounts();
  const perVoice = new Map<string, RunCounts>();
  const clipExists = (relPath: string): boolean => existsSync(path.join(root, relPath));
  const takes = new TakeIndex(manifest);
  // relPath → the request id that clip holds now in this run: what this run
  // wrote, or (dry run) would write. Absent → the manifest's row.
  const planned = new Map<string, string | null>();
  const requestIdAt = (relPath: string): string | null =>
    planned.has(relPath) ? planned.get(relPath)! : (manifest.entries[relPath]?.requestId ?? null);

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
    ): void => {
      const previous = requestIdAt(relPath);

      if (previous && heldRequestIds.get(previous) === relPath) heldRequestIds.delete(previous);

      if (requestId) heldRequestIds.set(requestId, relPath);

      planned.set(relPath, requestId);
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
      // it — but said so.
      const pauseMarks = findEntryPauseMarks(entry);
      const allowed = pauseMarks.length === 0 || isGrandfathered(entry, grandfathered[voiceName]?.[key]);

      if (!allowed) {
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

      if (pauseMarks.length > 0) {
        log.warn(`[generate] ${relPath}  —  grandfathered text: ${describePauseMarks(pauseMarks)}`);
      }

      // A request already paid for is never paid again (#1643). The hash
      // covers the ElevenLabs voice id, the model, every audio-affecting
      // option and the RAW reference strings — but a reference resolves per
      // voice, to that voice's own take of the entry it names. So a take is
      // the same request only when the hash matches AND every reference
      // resolves to the same provider request id in the source's voice as in
      // this one; then copy its bytes and its request id instead of a call.
      // Otherwise this voice's seam differs, and the entry is cut.
      const references = entryReferences(entry);
      const source = pickCopySource(takes.sources(hash), {
        voiceName,
        key,
        relPath,
        clipExists,
        requestIdOf: requestIdAt,
        heldRequestIds,
        copiedFrom,
        resolvesAlike: (candidate) =>
          references.every((ref) => {
            const here = requestIdAt(relPathOf(ref));

            return here !== null && here === requestIdAt(relPathFor(candidate.voiceName, ref));
          }),
      });

      if (source) {
        log.info(`${dryRun ? "[dry-run] WOULD COPY" : "[copy]"} ${relPath} from ${source.relPath}`);

        if (dryRun) {
          copiedFrom.add(source.relPath);
          recordTake(key, relPath, hash, null, requestIdAt(source.relPath));
          outcomes.set(key, "cut");
          count("copied");
          continue;
        }

        try {
          const sourceRow = source.row!;

          mkdirSync(path.dirname(absPath), { recursive: true });
          copyFileSync(path.join(root, source.relPath), absPath);
          invalidateProcessedCache(root, relPath);

          const row: ManifestRow = {
            hash,
            voiceId: voice.id,
            model: sourceRow.model,
            textPreview: sourceRow.textPreview,
            generatedAt: now().toISOString(),
            requestId: sourceRow.requestId,
          };

          recordTake(key, relPath, hash, row, row.requestId ?? null);
          manifest.entries[relPath] = row;
          persistManifest(manifest);
          copiedFrom.add(source.relPath);
          outcomes.set(key, "cut");
          count("copied");
        } catch (err) {
          log.error(`[copy] ${relPath}  —  FAILED: ${err instanceof Error ? err.message : String(err)}`);
          outcomes.set(key, "failed");
          count("failed");
        }

        continue;
      }

      const prefix = dryRun ? "[dry-run] WOULD GENERATE" : "[generate]";

      log.info(`${prefix} ${relPath}  —  "${textPreview(entry.text)}"`);

      if (dryRun) {
        // A placeholder no provider id can equal, unique to this clip: a
        // fresh take matches nothing but itself and its copies.
        recordTake(key, relPath, hash, null, `planned:${relPath}`);
        outcomes.set(key, "cut");
        count("generated");
        continue;
      }

      let synthOptions: Omit<SynthesizeOptions, "apiKey">;

      try {
        // Resolve `<group>/<entry-name>` references to the provider request
        // IDs of the dependencies' current takes — rows the checks above
        // proved current, or wrote earlier in this run.
        synthOptions = resolveEntryRequestIds(buildEntryOptions(entry, voice), voiceName, manifest);
      } catch (err) {
        log.error(`[generate] ${relPath}  —  FAILED: ${err instanceof Error ? err.message : String(err)}`);
        outcomes.set(key, "failed");
        count("failed");
        continue;
      }

      try {
        const { mp3, requestId } = await synthesize(synthOptions);

        mkdirSync(path.dirname(absPath), { recursive: true });
        writeFileSync(absPath, mp3);
        invalidateProcessedCache(root, relPath);

        const row: ManifestRow = {
          hash,
          voiceId: voice.id,
          model: synthOptions.model_id,
          textPreview: textPreview(entry.text, 80),
          generatedAt: now().toISOString(),
          requestId,
        };

        recordTake(key, relPath, hash, row, requestId);
        manifest.entries[relPath] = row;
        // Persist after every success so a partial failure mid-run doesn't
        // lose progress / force re-fetches on the next invocation.
        persistManifest(manifest);
        outcomes.set(key, "cut");
        count("generated");
      } catch (err) {
        log.error(`[generate] ${relPath}  —  FAILED: ${err instanceof Error ? err.message : String(err)}`);
        outcomes.set(key, "failed");
        count("failed");
      }
    }
  }

  return { totals, perVoice };
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
 * And only a take whose request really was this one: `resolvesAlike` holds
 * when every reference of the entry resolves, in the source's voice, to the
 * same provider request id it resolves to in this one. A voice whose
 * dependency is a different take (different text, or cut separately) gets
 * its own take, conditioned on its own dependency.
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
    resolvesAlike: (source: TakeSource) => boolean;
  },
): TakeSource | null {
  const eligible = candidates.filter((source) => {
    if (source.voiceName === target.voiceName) return false;

    if (target.copiedFrom.has(source.relPath)) return false;

    const requestId = target.requestIdOf(source.relPath);
    const holder = requestId ? target.heldRequestIds.get(requestId) : undefined;

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

/** The closing summary: the totals line, then one line per voice when more than one ran. */
export function formatRunSummary(result: RunResult, dryRun: boolean): string[] {
  const lines = [`Done. ${describeCounts(result.totals, dryRun)}`];

  if (result.perVoice.size > 1) {
    for (const [voiceName, counts] of result.perVoice) lines.push(`  ${voiceName}: ${describeCounts(counts, dryRun)}`);
  }

  return lines;
}
