/**
 * Shared link/unlink core for the deck hosts that have no CLI of their own
 * (Mirabox, Ulanzi). Extracted in #1040 so the two ecosystems are one
 * implementation plus a descriptor, rather than four near-identical scripts.
 *
 * Windows uses a **junction** rather than a symlink so linking needs neither
 * administrator rights nor developer mode. Verified 2026-08-28: UlanziStudio
 * loads a plugin through a junction, same as the Mirabox host.
 */
import { existsSync, lstatSync, readdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pluginSourceDir, resolvePluginsDir } from "./deck-hosts.mjs";
import { loadEnvLocal } from "./env-local.mjs";

/**
 * Junction-links the built plugin folder into the host's plugins directory.
 *
 * Fails fast, and returns a process exit code rather than calling `process.exit`
 * so the behaviour is testable.
 *
 * @param {import("./deck-hosts.mjs").DeckHost} host
 * @returns {number} 0 on success, 1 on any handled failure.
 */
export function linkPlugin(host, { root, env = process.env, platform = process.platform, log = console } = {}) {
  loadEnvLocal(root, env);

  const dest = resolvePluginsDir(host, { env, platform });
  if (!dest) {
    log.error(`Error: ${host.pluginsDirEnv} is not set and no default could be derived.`);
    log.error("Set it in your shell or in .env.local at the repo root, e.g.:");
    log.error(`  ${host.pluginsDirEnv}="${host.examplePluginsDir}"`);

    return 1;
  }

  const source = pluginSourceDir(host, root);
  // Build output — presence confirms the plugin has actually been built. The
  // plugin folder itself has manifest.json and icons checked in, so the folder
  // existing does not mean a build has run.
  const builtEntry = join(source, "bin", "plugin.js");
  if (!existsSync(builtEntry)) {
    log.error(`Error: ${host.label} plugin is not built. Run \`pnpm build\` first.\n  Missing: ${builtEntry}`);

    return 1;
  }

  if (!existsSync(dest)) {
    log.error(`Error: ${host.pluginsDirEnv} does not exist:\n  ${dest}`);

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
  const type = platform === "win32" ? "junction" : "dir";
  symlinkSync(source, link, type);
  log.log(`Linked ${source}\n     -> ${link}`);

  return 0;
}

/**
 * Removes the link created by `linkPlugin`, or a real plugin directory the host
 * installed from a packaged build. Tolerates the not-linked state.
 *
 * @param {import("./deck-hosts.mjs").DeckHost} host
 * @returns {number}
 */
export function unlinkPlugin(host, { root, env = process.env, platform = process.platform, log = console } = {}) {
  loadEnvLocal(root, env);

  const dest = resolvePluginsDir(host, { env, platform });
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

  // Branch on entry type. `rmSync(..., { recursive, force })` on a Windows
  // junction with a missing target silently no-ops (recurse fails, force
  // swallows the error, the junction itself is never unlinked). So unlink
  // symlinks/junctions explicitly; only recursively remove real directories.
  if (stat.isSymbolicLink()) {
    unlinkSync(link);
  } else {
    // A real directory: a packaged build the host installed, or a hand-made
    // copy. This deletes real files, so say so rather than doing it silently.
    log.log(`${link}\n  is a real directory, not a link — deleting it and everything inside it.`);
    warnAboutLogs(link, log);
    rmSync(link, { recursive: true, force: true });
  }

  log.log(`Removed ${link}`);

  return 0;
}

/**
 * The plugin writes its per-day logs inside its own folder, so a real-directory
 * removal takes them with it — and those logs are often the evidence someone is
 * mid-diagnosis on. Once linked, logs land in the worktree instead.
 */
function warnAboutLogs(link, log) {
  const logDir = join(link, "log");
  if (!existsSync(logDir)) return;

  let count;
  try {
    count = readdirSync(logDir).length;
  } catch {
    return;
  }
  if (count === 0) return;

  log.log(`  note: ${count} plugin log file(s) in log\\ go with it — copy them out first if you need them.`);
}
