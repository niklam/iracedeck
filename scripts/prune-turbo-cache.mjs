#!/usr/bin/env node
/**
 * Prunes turbo's local cache to the entries this job's turbo runs used (#1492).
 *
 *   node scripts/prune-turbo-cache.mjs [--cache-dir <dir>] [--runs-dir <dir>]
 *
 * CI saves `.turbo/cache` with `actions/cache` after a push run, and PR runs
 * restore it. Turbo never evicts anything from its local cache, so a directory
 * restored and saved run after run would only grow — the developer cache in a
 * long-lived checkout reached 97 GB. Before the save, this deletes every entry
 * that no task of this job's runs hashed to, so a saved cache is one build's
 * outputs. A push run restores nothing today, so there it mostly checks: it is
 * what refuses when turbo wrote somewhere other than the path being saved.
 *
 * The hashes come from turbo's run summaries (`TURBO_RUN_SUMMARY=true` writes
 * `.turbo/runs/<id>.json`), whose `tasks[]` lists every task of the run with
 * its `hash` — hits and misses, dependency tasks included. Every summary in the
 * runs directory counts, so the set kept is their union; in CI that directory
 * holds only this job's runs, since the cache step restores `.turbo/cache`
 * alone. A summary of a FAILED run lists only the tasks turbo reached, which is
 * why the workflows run this only after a successful turbo step.
 *
 * It refuses — exit 1, and the workflow's save step does not run — rather than
 * delete on too little information: no runs directory, no summary in it, a
 * summary that is unreadable, has no tasks or a task without a hash, no cache
 * directory, or a cache directory in which none of the summaries' hashes has
 * an entry. On a run that restored nothing, that last one is what a cache
 * written somewhere else looks like (turbo's cache directory and the saved
 * path disagreeing), and what turbo renaming its entry files would look like;
 * saving then would store an empty cache unnoticed. On a run that restored a
 * cache it is weaker: restored entries for unchanged tasks still match.
 *
 * Defaults are what CI uses: the cache directory is `TURBO_CACHE_DIR` — the
 * variable turbo itself reads — or `.turbo/cache`, and the runs directory is
 * `.turbo/runs`, both relative to the working directory.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { parseArgs } from "node:util";

export const USAGE = "usage: node scripts/prune-turbo-cache.mjs [--cache-dir <dir>] [--runs-dir <dir>]";

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;

/**
 * One file of a local cache entry: `<hash>.tar.zst`, `<hash>-meta.json` or
 * `<hash>-manifest.json`. Any other name — a directory, a temporary file, a
 * format turbo adds later — is not ours to judge and is left alone.
 */
export const CACHE_ENTRY_FILE = /^([0-9a-f]+)(\.tar\.zst|-meta\.json|-manifest\.json)$/;

/** A refusal with the message the CLI prints. */
export class PruneRefusal extends Error {}

/**
 * Every task hash in a parsed run summary.
 *
 * @param {unknown} summary
 * @param {string} name The summary's file name, for the message.
 * @returns {string[]}
 */
export function summaryHashes(summary, name) {
  const tasks = summary && typeof summary === "object" ? summary.tasks : undefined;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new PruneRefusal(`run summary ${name} lists no tasks`);
  }

  return tasks.map((task, i) => {
    const hash = task && typeof task === "object" ? task.hash : undefined;
    if (typeof hash !== "string" || !/^[0-9a-f]+$/.test(hash)) {
      throw new PruneRefusal(`run summary ${name}: task ${i} (${task?.taskId ?? "unnamed"}) has no hash`);
    }

    return hash;
  });
}

/**
 * The union of the task hashes of every run summary in `runsDir`.
 *
 * @param {string} runsDir
 * @returns {{ hashes: Set<string>, summaries: number }}
 */
export function readRunHashes(runsDir) {
  if (!existsSync(runsDir)) {
    throw new PruneRefusal(
      `no run summaries: ${runsDir} does not exist (was the turbo step run with TURBO_RUN_SUMMARY=true?)`,
    );
  }
  const names = readdirSync(runsDir).filter((name) => name.endsWith(".json"));
  if (names.length === 0) {
    throw new PruneRefusal(`no run summaries in ${runsDir} (was the turbo step run with TURBO_RUN_SUMMARY=true?)`);
  }

  const hashes = new Set();
  for (const name of names) {
    let summary;
    try {
      summary = JSON.parse(readFileSync(path.join(runsDir, name), "utf8"));
    } catch (err) {
      throw new PruneRefusal(`run summary ${name} is unreadable: ${err.message}`);
    }
    for (const hash of summaryHashes(summary, name)) hashes.add(hash);
  }

  return { hashes, summaries: names.length };
}

/**
 * Which files of the cache directory to keep and remove. Pure.
 *
 * @param {{ name: string, size: number }[]} files The cache directory's entries.
 * @param {Set<string>} keepHashes
 * @returns {{ keep: Map<string, { files: string[], bytes: number }>, remove: Map<string, { files: string[], bytes: number }>, unknown: string[] }}
 */
export function planPrune(files, keepHashes) {
  const keep = new Map();
  const remove = new Map();
  const unknown = [];
  for (const { name, size } of files) {
    const match = CACHE_ENTRY_FILE.exec(name);
    if (!match) {
      unknown.push(name);
      continue;
    }
    const target = keepHashes.has(match[1]) ? keep : remove;
    const entry = target.get(match[1]) ?? { files: [], bytes: 0 };
    entry.files.push(name);
    entry.bytes += size;
    target.set(match[1], entry);
  }

  return { keep, remove, unknown };
}

/** `12.3 MB`, for the summary line. */
export function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function totalBytes(entries) {
  let sum = 0;
  for (const { bytes } of entries.values()) sum += bytes;

  return sum;
}

/**
 * Prunes `cacheDir` to the hashes in `runsDir`'s summaries.
 *
 * @param {{ cacheDir: string, runsDir: string, log?: { log: Function, error: Function } }} options
 * @returns {number} 0 pruned, 1 refused (nothing deleted).
 */
export function pruneTurboCache({ cacheDir, runsDir, log = console }) {
  try {
    const { hashes, summaries } = readRunHashes(runsDir);
    if (!existsSync(cacheDir) || !statSync(cacheDir).isDirectory()) {
      throw new PruneRefusal(`no turbo cache at ${cacheDir}`);
    }
    const files = readdirSync(cacheDir, { withFileTypes: true }).map((dirent) => ({
      name: dirent.name,
      size: dirent.isFile() ? statSync(path.join(cacheDir, dirent.name)).size : 0,
    }));
    const { keep, remove, unknown } = planPrune(files, hashes);
    if (keep.size === 0) {
      throw new PruneRefusal(
        `none of the ${hashes.size} task hashes in ${summaries} run summar${summaries === 1 ? "y" : "ies"} has an entry in ${cacheDir}; ` +
          "turbo wrote its cache somewhere else (is TURBO_CACHE_DIR the restored path?) or its entry file names changed",
      );
    }

    for (const { files: names } of remove.values()) {
      for (const name of names) rmSync(path.join(cacheDir, name));
    }

    log.log(
      `turbo cache ${cacheDir}: kept ${keep.size} entries (${formatBytes(totalBytes(keep))}), ` +
        `removed ${remove.size} (${formatBytes(totalBytes(remove))}), ` +
        `${hashes.size} task hashes from ${summaries} run summar${summaries === 1 ? "y" : "ies"}` +
        (unknown.length ? `; left ${unknown.length} unrecognised file(s) alone: ${unknown.join(", ")}` : ""),
    );

    return EXIT_OK;
  } catch (err) {
    if (!(err instanceof PruneRefusal)) throw err;
    log.error(`prune-turbo-cache: refusing to prune, nothing deleted: ${err.message}`);

    return EXIT_REFUSED;
  }
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ cacheDir: string, runsDir: string } | null} null on bad arguments.
 */
export function parseCliArgs(argv, env) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { "cache-dir": { type: "string" }, "runs-dir": { type: "string" } },
      strict: true,
      allowPositionals: false,
    });

    return {
      cacheDir: values["cache-dir"] || env.TURBO_CACHE_DIR || path.join(".turbo", "cache"),
      runsDir: values["runs-dir"] || path.join(".turbo", "runs"),
    };
  } catch {
    return null;
  }
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
  const options = parseCliArgs(process.argv.slice(2), process.env);
  if (!options) {
    console.error(USAGE);
    process.exitCode = EXIT_USAGE;
  } else {
    // `process.exitCode` rather than `process.exit`, so the summary line is
    // flushed before the process ends.
    process.exitCode = pruneTurboCache(options);
  }
}
