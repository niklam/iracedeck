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

import { DEFAULT_DEV_VOICE_PACKS_ROOT, DEV_LOCAL_FILE, readDevLocal } from "./dev-local.mjs";
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
 * Joins a command and its arguments into ONE shell command line, quoting any
 * argument that contains whitespace or a double quote (escaping an inner `"`
 * as `\"`). Pure — exported so the quoting can be tested without spawning
 * anything.
 */
export function shellCommandLine(cmd, args) {
  return [cmd, ...args].map((arg) => quoteShellArg(String(arg))).join(" ");
}

function quoteShellArg(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/**
 * `pnpm` is a `.cmd` shim on Windows and needs a shell there — Node refuses to
 * spawn a `.cmd` without one (the CVE-2024-27980 hardening) — but Node 24
 * deprecates (DEP0190) passing an args ARRAY alongside `shell: true`, and that
 * deprecation is slated to become a hard error. So on Windows the shell stays
 * and the args array goes: `cmd`/`args` are joined into one string via
 * {@link shellCommandLine} and handed to `spawnSync` with no `args` array.
 * Every argument this module passes through here is a fixed literal ("exec",
 * "turbo", "run", "build", "--filter=…", "relink:…") — nothing user-supplied
 * ever reaches the shell, so the join is safe. On other platforms spawning
 * `cmd`/`args` directly (no shell) keeps the arguments intact.
 */
export function spawnSyncShell(cmd, args, options) {
  return process.platform === "win32"
    ? spawnSync(shellCommandLine(cmd, args), { shell: true, stdio: "inherit", ...options })
    : spawnSync(cmd, args, { stdio: "inherit", ...options });
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

  // Captured BEFORE anything is written, so a failed build can put the file
  // back exactly as it was — see `restoreMarker`.
  const previous = readMarker(root);

  const marker = mode === "on" ? turnOn(root, log) : turnOff(root, log);
  if (marker.code !== 0) return marker.code;

  // Read once and shared by the hint and the relink step: both ask the same
  // question of the same junctions, and a second `readlinkSync` sweep between
  // them could answer differently.
  const targets = links(env);
  const ours = hostsLinkedHere(targets, { root, platform });

  // Ahead of the build, because the build is what these hosts break. A running
  // host holds `iracing_native.node` open and the build dies with EPERM —
  // which is the failure the transaction below exists for, and the one line
  // that lets a developer avoid it entirely.
  if (ours.length > 0) {
    log.log(
      `Linked to this worktree: ${ours.map(({ host }) => host).join(", ")} — they must not be RUNNING during the ` +
        "build (a running deck host locks the native addon and the build fails with EPERM).",
    );
  }

  // Both directions rebuild: `on` puts devVoicePacksRoot into each plugin's
  // bin/config.json, `off` is what takes it back out.
  log.log(
    mode === "on"
      ? "Rebuilding the three plugins so devVoicePacksRoot reaches every bin/config.json …"
      : "Rebuilding the three plugins so devVoicePacksRoot leaves every bin/config.json …",
  );
  if (exec("pnpm", BUILD_ARGS, { cwd: root }).status !== 0) {
    // The marker goes back. It is the build that carries the marker into every
    // `bin/config.json`, so a marker left changed after a failed build claims a
    // mode none of the three plugin folders is in — and nothing in the plugin,
    // the settings window or the log can report that disagreement, because
    // every one of them reads the BUILT config. Restoring is the only way the
    // two can still be saying the same thing when the command exits non-zero.
    restoreMarker(root, previous);
    log.error(
      `Error: the plugin build failed — ${DEV_LOCAL_FILE} restored to its previous state; nothing was relinked. ` +
        "Stop the deck hosts linked to this worktree (pnpm stop:mirabox / stop:ulanzi, quit Stream Deck) and run " +
        "the command again.",
    );

    return 1;
  }

  const code = relinkHosts({ root, log, exec, targets, ours });

  // Printed last on purpose: it is the one thing left for the developer to do,
  // and anything printed before a build scrolls past unread.
  if (mode === "on" && marker.stagingHintFor) reportStaging(marker.stagingHintFor, log);

  return code;
}

/**
 * The marker's exact current bytes, or `undefined` when there is no file.
 *
 * A Buffer rather than text: the transaction promises the file comes back as it
 * was, and a hand-written marker may carry a BOM, CRLF line endings or a
 * trailing blank line that a decode-and-re-encode round trip would quietly
 * normalise away.
 */
function readMarker(root) {
  const file = path.join(root, DEV_LOCAL_FILE);

  try {
    return readFileSync(file);
  } catch {
    // Absent is the ordinary case, and an unreadable marker is treated the same
    // way on purpose: this value is only ever used to UNDO a change, and a file
    // we could not read is one `turnOn` will refuse a moment later anyway.
    return undefined;
  }
}

/** Puts the marker back the way {@link readMarker} found it. Never throws. */
function restoreMarker(root, previous) {
  const file = path.join(root, DEV_LOCAL_FILE);

  try {
    if (previous === undefined) rmSync(file, { force: true });
    else writeFileSync(file, previous);
  } catch {
    // Nothing useful to do: the caller is already reporting a failed build, and
    // a throw here would replace that message with a stack trace about the
    // cleanup rather than about the thing that actually went wrong.
  }
}

/**
 * Writes the marker unless one is already there. Returns the resolved voice
 * root when the staging hint should be considered for it.
 *
 * Validation is `readDevLocal`'s and nothing else's (#1143 review): this
 * function used to re-implement it — parse, shape-check, hardcode the key list
 * — and the copy had already drifted, accepting a blank `voicePacksRoot` that
 * the build then resolved to the repo root. There is exactly one answer to
 * "is this marker usable?", and it is the reader every plugin's Rollup config
 * already asks. What stays here is only the exists / kept decision, which the
 * reader has no opinion about.
 */
function turnOn(root, log) {
  const file = path.join(root, DEV_LOCAL_FILE);

  if (existsSync(file)) {
    let existing;

    try {
      // Absolute, resolved from `root` — so the line below names the directory
      // that will actually be scanned rather than the text in the file, which
      // is what a developer wondering where their pack went needs to read.
      existing = readDevLocal(root).voicePacksRoot;
    } catch (error) {
      log.error(`Error: ${error.message}. Nothing written — fix or delete the file.`);

      return { code: 1 };
    }

    // The reader is content with `{}` — the key is optional to it, because a
    // marker with no root is simply development mode off. Here it is a file
    // the developer meant something by, so it is refused rather than
    // overwritten: `on` never replaces a marker's contents.
    if (existing === undefined) {
      log.error(`Error: ${DEV_LOCAL_FILE} has no voicePacksRoot. Nothing written — fix or delete the file.`);

      return { code: 1 };
    }

    log.log(
      existing === path.resolve(root, DEFAULT_DEV_VOICE_PACKS_ROOT)
        ? `${DEV_LOCAL_FILE} already points at ${existing} — left as is.`
        : `${DEV_LOCAL_FILE} already points at ${existing} — kept (delete the file to go back to the default).`,
    );

    return { code: 0, stagingHintFor: existing };
  }

  writeFileSync(
    file,
    `${JSON.stringify({ voicePacksRoot: DEFAULT_DEV_VOICE_PACKS_ROOT }, null, 2)}
`,
  );
  log.log(`Wrote ${DEV_LOCAL_FILE}: voicePacksRoot = ${DEFAULT_DEV_VOICE_PACKS_ROOT}`);

  return { code: 0, stagingHintFor: path.resolve(root, DEFAULT_DEV_VOICE_PACKS_ROOT) };
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

/**
 * Says how to stage a pack when the dev root has nothing in it yet.
 *
 * DIRECTORIES only, because that is what the scanner lists: `pack:voice` leaves
 * an `<id>-<version>.zip` beside the staged folder, so counting files let a
 * leftover zip suppress this hint while the plugin still warned the root was
 * empty — the switch and the plugin disagreeing about the same directory.
 */
function reportStaging(voiceRoot, log) {
  let entries;
  try {
    entries = readdirSync(voiceRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    entries = [];
  }
  if (entries.length > 0) return;

  log.log(
    `No staged pack under ${voiceRoot} yet — run: pnpm --filter @iracedeck/audio-assets pack:voice default --no-catalog, then press Rescan voices.`,
  );
}

/**
 * Which of {@link HOST_RELINKS} currently point at THIS worktree's plugin
 * folder — the hosts whose link the switch may relink, and the hosts that must
 * not be running during the build. One answer, used by both.
 */
function hostsLinkedHere(targets, { root, platform }) {
  const norm = (p) => {
    const s = path.resolve(p).replace(/[\\/]+$/, "");

    return platform === "win32" ? s.toLowerCase() : s;
  };

  return HOST_RELINKS.filter(({ host, pluginDir }) => {
    const entry = targets.find((t) => t.host === host);

    // `REAL_DIRECTORY` is deliberately not a path, so it can never normalise
    // into a match — it is a packaged build the host installed itself.
    if (!entry || entry.target === undefined || entry.target === REAL_DIRECTORY) return false;

    return norm(entry.target) === norm(path.join(root, pluginDir));
  });
}

/** Relinks the hosts pointing at this worktree; reports every other host. */
function relinkHosts({ root, log, exec, targets, ours }) {
  let code = 0;

  for (const descriptor of HOST_RELINKS) {
    const { host, script, restart } = descriptor;
    const entry = targets.find((t) => t.host === host);

    if (!entry || entry.target === undefined) {
      log.log(`${host}: not linked — nothing to relink.`);
      continue;
    }

    if (entry.target === REAL_DIRECTORY) {
      log.log(`${host}: a real directory, not a link, at ${entry.link} — left alone.`);
      continue;
    }

    if (!ours.includes(descriptor)) {
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
