import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildEntryOptions, entryHash, resolveEntryRequestIds, type VoiceConfig } from "./config.ts";
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
  return { generated: 0, skipped: 0, failed: 0, refused: 0 };
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
    const relPathOf = (key: string): string => {
      const slash = key.indexOf("/");

      return clipRelPath(voiceName, key.slice(0, slash), key.slice(slash + 1));
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

      const prefix = dryRun ? "[dry-run] WOULD GENERATE" : "[generate]";

      log.info(`${prefix} ${relPath}  —  "${textPreview(entry.text)}"`);

      if (dryRun) {
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
        manifest.entries[relPath] = {
          hash,
          voiceId: voice.id,
          model: synthOptions.model_id,
          textPreview: textPreview(entry.text, 80),
          generatedAt: now().toISOString(),
          requestId,
        };
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

function describeCounts(counts: RunCounts, dryRun: boolean): string {
  const verb = dryRun ? "would be generated" : "generated";

  return (
    `${counts.generated} ${verb}, ${counts.skipped} skipped (cache hit), ` +
    `${counts.failed} failed, ${counts.refused} refused (pause marks or a stale dependency)`
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
