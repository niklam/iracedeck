/**
 * The one switch behind `pnpm dev:voices on|off` (#1143).
 *
 * `on` writes the gitignored `dev.local.json` marker, rebuilds the three
 * plugins so the resolved path lands in each `bin/config.json` as
 * `devVoicePacksRoot`, and relinks whichever deck hosts point at THIS worktree;
 * `off` removes the marker and does the same. The rebuild is not optional in
 * either direction: the key lives in built output, so nothing changes in-game
 * until the plugin folder is rebuilt.
 *
 * Two decisions are load-bearing:
 *
 * - **A host linked to another worktree is reported and left alone.** The spec
 *   says testing the real download path must stay an explicit choice; silently
 *   relinking a host would switch someone's test environment underneath them.
 *   Only a host whose link already points at this worktree's plugin folder is
 *   relinked, and then only so the host restarts on the rebuilt config.
 * - **The marker is never overwritten.** An unknown key fails the run (the
 *   developer edited it on purpose, and `readDevLocal` would throw at build
 *   time anyway); a different `voicePacksRoot` is kept and reported, because
 *   picking a root by hand is exactly what the file is for.
 *
 * Everything impure is injected — `exec`, `log`, `links`, `platform` — and every
 * path returns an exit code rather than calling `process.exit`, the shape the
 * other `scripts/lib` helpers use.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_DEV_VOICE_PACKS_ROOT, DEV_LOCAL_FILE } from "./dev-local.mjs";
import { linkTargets, REAL_DIRECTORY } from "./plugin-links.mjs";

/**
 * Per deck host: the plugin folder a link must point at for it to be OURS, and
 * the pnpm script that relinks it. `host` matches the names `linkLocations`
 * reports — a test pins the two lists equal, so a renamed host fails there
 * rather than silently never being relinked.
 *
 * `restart` is set for the hosts that read their plugins directory at start
 * only; the Elgato CLI reloads the plugin as part of its own relink.
 */
export const HOST_RELINKS = [
  {
    host: "Stream Deck",
    pluginDir: "packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin",
    script: "relink:stream-deck",
    restart: undefined,
  },
  {
    host: "Mirabox",
    pluginDir: "packages/iracing-plugin-mirabox/com.iracedeck.sd.core.sdPlugin",
    script: "relink:mirabox",
    restart: "mirabox",
  },
  {
    host: "Ulanzi",
    pluginDir: "packages/iracing-plugin-ulanzi/com.ulanzi.iracedeck.ulanziPlugin",
    script: "relink:ulanzi",
    restart: "ulanzi",
  },
];

/** The three plugin builds, and only those — nothing else reads the marker. */
const BUILD_ARGS = [
  "exec",
  "turbo",
  "run",
  "build",
  "--filter=@iracedeck/iracing-plugin-stream-deck",
  "--filter=@iracedeck/iracing-plugin-mirabox",
  "--filter=@iracedeck/iracing-plugin-ulanzi",
];

const USAGE = "Usage: pnpm dev:voices <on|off>";

/**
 * `pnpm` is a `.cmd` shim on Windows and needs a shell there; on other
 * platforms spawning it directly keeps the arguments intact. Same rule as
 * `scripts/claude-hooks/lib.mjs` `run`.
 */
function spawnSyncShell(cmd, args, options) {
  return spawnSync(cmd, args, { shell: process.platform === "win32", stdio: "inherit", ...options });
}

/**
 * Turns the switch on or off for this worktree.
 *
 * @param {string | undefined} mode `"on"` or `"off"`.
 * @param {object} options
 * @param {string} options.root Repo root (the worktree).
 * @param {Record<string, string | undefined>} [options.env]
 * @param {{ log: Function, error: Function }} [options.log]
 * @param {(cmd: string, args: string[], options: object) => { status: number | null }} [options.exec]
 * @param {NodeJS.Platform} [options.platform]
 * @param {(env: Record<string, string | undefined>) => Array<{ host: string, link: string, target?: string }>} [options.links]
 * @returns {number} 0 done, 1 a step failed, 2 bad arguments.
 */
export function runDevVoices(
  mode,
  {
    root,
    env = process.env,
    log = console,
    exec = spawnSyncShell,
    platform = process.platform,
    links = (e) => linkTargets(e),
  } = {},
) {
  if (mode !== "on" && mode !== "off") {
    log.error(`Error: expected "on" or "off", got ${JSON.stringify(mode ?? "")}.`);
    log.error(USAGE);

    return 2;
  }

  const marker = mode === "on" ? turnOn(root, log) : turnOff(root, log);
  if (marker.code !== 0) return marker.code;

  // Both directions rebuild: `on` puts devVoicePacksRoot into each plugin's
  // bin/config.json, `off` is what takes it back out.
  log.log(
    mode === "on"
      ? "Rebuilding the three plugins so devVoicePacksRoot reaches every bin/config.json …"
      : "Rebuilding the three plugins so devVoicePacksRoot leaves every bin/config.json …",
  );
  if (exec("pnpm", BUILD_ARGS, { cwd: root }).status !== 0) {
    log.error("Error: the plugin build failed — nothing was relinked.");

    return 1;
  }

  const code = relinkHosts({ root, env, log, exec, platform, links });

  // Printed last on purpose: it is the one thing left for the developer to do,
  // and anything printed before a build scrolls past unread.
  if (mode === "on" && marker.stagingHintFor) reportStaging(marker.stagingHintFor, log);

  return code;
}

/**
 * Writes the marker unless one is already there. Returns the resolved voice
 * root when the staging hint should be considered for it.
 */
function turnOn(root, log) {
  const file = path.join(root, DEV_LOCAL_FILE);
  const resolve = (value) => path.resolve(root, value);

  if (existsSync(file)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf-8"));
    } catch (error) {
      log.error(`Error: ${DEV_LOCAL_FILE} is not valid JSON (${error.message}). Nothing written — fix or delete it.`);

      return { code: 1 };
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      log.error(`Error: ${DEV_LOCAL_FILE} does not hold an object. Nothing written — fix or delete it.`);

      return { code: 1 };
    }

    const unknown = Object.keys(parsed).filter((key) => key !== "voicePacksRoot");
    if (unknown.length > 0) {
      log.error(
        `Error: ${DEV_LOCAL_FILE} carries other key(s): ${unknown.join(", ")}. Nothing written — edit or delete the file yourself.`,
      );

      return { code: 1 };
    }

    const existing = typeof parsed.voicePacksRoot === "string" ? parsed.voicePacksRoot : undefined;
    if (existing === undefined) {
      log.error(`Error: ${DEV_LOCAL_FILE} has no voicePacksRoot. Nothing written — fix or delete it.`);

      return { code: 1 };
    }

    log.log(
      existing === DEFAULT_DEV_VOICE_PACKS_ROOT
        ? `${DEV_LOCAL_FILE} already points at ${existing} — left as is.`
        : `${DEV_LOCAL_FILE} already points at ${existing} — kept (delete the file to go back to the default).`,
    );

    return { code: 0, stagingHintFor: resolve(existing) };
  }

  writeFileSync(file, `${JSON.stringify({ voicePacksRoot: DEFAULT_DEV_VOICE_PACKS_ROOT }, null, 2)}\n`);
  log.log(`Wrote ${DEV_LOCAL_FILE}: voicePacksRoot = ${DEFAULT_DEV_VOICE_PACKS_ROOT}`);

  return { code: 0, stagingHintFor: resolve(DEFAULT_DEV_VOICE_PACKS_ROOT) };
}

/** Removes the marker. A missing one is a success — the rebuild still runs. */
function turnOff(root, log) {
  const file = path.join(root, DEV_LOCAL_FILE);
  if (!existsSync(file)) {
    log.log(`No ${DEV_LOCAL_FILE} — the development voice root was already off.`);

    return { code: 0 };
  }

  rmSync(file);
  log.log(`Removed ${DEV_LOCAL_FILE}.`);

  return { code: 0 };
}

/** Says how to stage a pack when the dev root has nothing in it yet. */
function reportStaging(voiceRoot, log) {
  let entries;
  try {
    entries = readdirSync(voiceRoot);
  } catch {
    entries = [];
  }
  if (entries.length > 0) return;

  log.log(
    `No staged pack under ${voiceRoot} yet — run: pnpm --filter @iracedeck/audio-assets pack:voice default --no-catalog, then press Rescan voices.`,
  );
}

/** Relinks the hosts pointing at this worktree; reports every other host. */
function relinkHosts({ root, env, log, exec, platform, links }) {
  const norm = (p) => {
    const s = path.resolve(p).replace(/[\\/]+$/, "");

    return platform === "win32" ? s.toLowerCase() : s;
  };

  const targets = links(env);
  let code = 0;

  for (const { host, pluginDir, script, restart } of HOST_RELINKS) {
    const entry = targets.find((t) => t.host === host);
    if (!entry || entry.target === undefined) {
      log.log(`${host}: not linked — nothing to relink.`);
      continue;
    }

    if (entry.target === REAL_DIRECTORY) {
      log.log(`${host}: a real directory, not a link, at ${entry.link} — left alone.`);
      continue;
    }

    if (norm(entry.target) !== norm(path.join(root, pluginDir))) {
      log.log(
        `${host}: linked elsewhere (${entry.target}) — left alone. Relinking it would switch that test environment.`,
      );
      continue;
    }

    log.log(`${host}: linked to this worktree — running pnpm ${script}`);
    if (exec("pnpm", [script], { cwd: root }).status !== 0) {
      log.error(`Error: pnpm ${script} failed for ${host}.`);
      code = 1;
      continue;
    }

    // Mirabox and Ulanzi read their plugins directory at start only, so the
    // relink alone changes nothing until the host restarts.
    if (restart)
      log.log(`  ${host} loads plugins at start only — restart it: pnpm stop:${restart} && pnpm start:${restart}`);
  }

  return code;
}
