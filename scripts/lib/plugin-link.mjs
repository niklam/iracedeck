/**
 * Shared link/unlink core for the deck hosts that have no CLI of their own
 * (Mirabox, Ulanzi). Extracted in #1040 so the two ecosystems are one
 * implementation plus a descriptor, rather than four near-identical scripts.
 *
 * Windows uses a **junction** rather than a symlink so linking needs neither
 * administrator rights nor developer mode. Verified 2026-08-28: UlanziStudio
 * loads a plugin through a junction, same as the Mirabox host.
 *
 * Every function returns a process exit code instead of calling `process.exit`,
 * so the behaviour is testable and the caller owns termination.
 */
import { existsSync, lstatSync, readdirSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pluginSourceDir, resolvePluginsDirSource } from "./deck-hosts.mjs";
import { loadEnvLocal } from "./env-local.mjs";

/** Log files the plugin's FileSink writes: `<YYYY.M.D>.log`, unpadded. */
const LOG_FILE_PATTERN = /^\d{4}\.\d{1,2}\.\d{1,2}\.log$/;

/**
 * Explains a filesystem failure in terms of the thing that actually causes it
 * here. A running host holds `bin/plugin.js` and its own log file open, and the
 * dev loop tells you to stop it first — so EBUSY/EPERM is the expected error,
 * not an exotic one, and deserves the fix rather than a stack trace.
 */
function describeFsError(error, host, verb) {
  if (error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES") {
    return `Error: could not ${verb} — the ${host.label} host is probably still running and holding files open.\n  Run \`pnpm stop:${host.id}\` first.\n  (${error.code}: ${error.message})`;
  }

  return `Error: could not ${verb}.\n  ${error.message}`;
}

/**
 * Junction-links the built plugin folder into the host's plugins directory.
 *
 * @param {import("./deck-hosts.mjs").DeckHost} host
 * @returns {number} 0 on success, 1 on any handled failure.
 */
export function linkPlugin(host, { root, env = process.env, platform = process.platform, log = console } = {}) {
  loadEnvLocal(root, env);

  const { path: dest, source } = resolvePluginsDirSource(host, { env, platform });
  if (!dest) {
    log.error(`Error: ${host.pluginsDirEnv} is not set and no default could be derived.`);
    log.error("Set it in your shell or in .env.local at the repo root, e.g.:");
    log.error(`  ${host.pluginsDirEnv}="${host.examplePluginsDir}"`);

    return 1;
  }

  const source_ = pluginSourceDir(host, root);
  // Build output — presence confirms the plugin has actually been built. The
  // plugin folder itself has manifest.json and icons checked in, so the folder
  // existing does not mean a build has run.
  const builtEntry = join(source_, "bin", "plugin.js");
  if (!existsSync(builtEntry)) {
    log.error(`Error: ${host.label} plugin is not built. Run \`pnpm build\` first.\n  Missing: ${builtEntry}`);

    return 1;
  }

  if (!existsSync(dest)) {
    // Naming the env var here would be wrong when the path came from the
    // platform default — the user never set anything to be at fault for.
    log.error(`Error: the ${host.label} plugins directory does not exist:\n  ${dest}`);
    log.error(
      source === "env"
        ? `  That path comes from ${host.pluginsDirEnv}. Check it points at your host's plugins folder.`
        : `  That is the default location. If your host is installed elsewhere, set ${host.pluginsDirEnv} in .env.local.`,
    );

    return 1;
  }

  const link = join(dest, host.pluginFolder);

  // lstat (not exists) so we also catch dangling symlinks/junctions whose
  // target has been deleted — `existsSync` follows the link and would report
  // false in that case, hiding the stale entry from the fails-fast guard.
  if (lstatSync(link, { throwIfNoEntry: false })) {
    log.error(`Error: a link or folder already exists at:\n  ${link}\nRun \`pnpm ${host.unlinkScript}\` first.`);

    return 1;
  }

  // Use "junction" on Windows to avoid requiring admin / developer mode.
  try {
    symlinkSync(source_, link, platform === "win32" ? "junction" : "dir");
  } catch (error) {
    log.error(describeFsError(error, host, `create the link at ${link}`));

    return 1;
  }

  log.log(`Linked ${source_}\n     -> ${link}`);

  return 0;
}

/**
 * Removes the link created by `linkPlugin`. A real directory (a packaged build
 * the host installed) is **moved aside, not deleted** — see `moveAside`.
 *
 * @param {import("./deck-hosts.mjs").DeckHost} host
 * @returns {number}
 */
export function unlinkPlugin(host, { root, env = process.env, platform = process.platform, log = console } = {}) {
  loadEnvLocal(root, env);

  const dest = resolvePluginsDirSource(host, { env, platform }).path;
  if (!dest) {
    log.log(`${host.pluginsDirEnv} not set — nothing to unlink.`);

    return 0;
  }

  const link = join(dest, host.pluginFolder);

  // lstat (not exists) so we also detect dangling symlinks/junctions whose
  // target has been deleted — `existsSync` follows the link and would hide
  // a stale entry that still occupies the filename.
  const stat = lstatSync(link, { throwIfNoEntry: false });
  if (!stat) {
    log.log(`No link at ${link} — nothing to unlink.`);

    return 0;
  }

  // Branch on entry type. A symlink/junction is unlinked directly: `rmSync`
  // with `recursive` on a Windows junction whose target is missing silently
  // no-ops (recurse fails, force swallows the error, the junction survives).
  if (stat.isSymbolicLink()) {
    try {
      unlinkSync(link);
    } catch (error) {
      log.error(describeFsError(error, host, `remove the link at ${link}`));

      return 1;
    }

    log.log(`Removed ${link}`);

    return 0;
  }

  return moveAside(host, link, log);
}

/**
 * Renames a real plugin directory out of the way instead of deleting it.
 *
 * The spec originally had this as `rmSync(recursive, force)`, announced in the
 * output. Two things argued it down: the folder holds the plugin's own `log/`
 * files, which are routinely the evidence someone is mid-diagnosis on and are
 * unrecoverable; and `relink` runs inside `switch-test-env`, where a printed
 * warning scrolls past thousands of build lines unread. A rename costs one
 * stale folder and removes the irreversible step entirely.
 *
 * The suffix deliberately breaks the host's scan pattern (`*.sdPlugin` /
 * `*.ulanziPlugin`), so the moved-aside copy is never loaded as a second plugin.
 */
function moveAside(host, link, log) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const aside = `${link}.replaced-${stamp}`;

  try {
    renameSync(link, aside);
  } catch (error) {
    log.error(describeFsError(error, host, `move aside the existing directory at ${link}`));

    return 1;
  }

  log.log(`${link}\n  was a real directory, not a link — moved aside rather than deleted:\n  -> ${aside}`);
  reportPreservedLogs(aside, log);

  return 0;
}

/**
 * Points at the plugin logs carried along by the move, so someone mid-diagnosis
 * knows where they went. Counts only the `<YYYY.M.D>.log` files the FileSink
 * actually writes — `readdirSync().length` would count subdirectories too and
 * report a number that does not mean what it says.
 */
function reportPreservedLogs(aside, log) {
  const logDir = join(aside, "log");
  if (!existsSync(logDir)) return;

  let count = 0;
  try {
    count = readdirSync(logDir).filter((name) => LOG_FILE_PATTERN.test(name)).length;
  } catch {
    return;
  }
  if (count === 0) return;

  log.log(`  ${count} plugin log file(s) preserved in that folder; delete it once you no longer need them.`);
}
