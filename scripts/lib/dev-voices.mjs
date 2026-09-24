/**
 * The one switch behind `pnpm dev:voices on|off|auto` (#1143, #1214).
 *
 * All three verbs edit the gitignored `dev.local.json` marker, rebuild the
 * three plugins so the resolved root lands in each `bin/config.json` as
 * `devVoicePacksRoot` (the build also stages the packs into the default root
 * while development mode is on — `@iracedeck/audio-assets#stage:dev-voices`,
 * which every plugin build depends on), and relink whichever deck hosts point
 * at THIS worktree. The rebuild is not optional in any direction: the key
 * lives in built output, so nothing changes in-game until the plugin folder is
 * rebuilt.
 *
 * - `on` writes the default root.
 * - `off` writes `voicePacksRoot: false`, the explicit per-worktree off. Before
 *   #1214 it deleted the file, which under the machine-wide
 *   `IRACEDECK_DEV_VOICES=1` opt-in would turn development mode back ON.
 * - `auto` removes the marker, so the worktree follows the machine setting.
 *
 * Two decisions are load-bearing:
 *
 * - **A host linked to another worktree is reported and left alone.** The spec
 *   says testing the real download path must stay an explicit choice; silently
 *   relinking a host would switch someone's test environment underneath them.
 *   Only a host whose link already points at this worktree's plugin folder is
 *   relinked, and then only so the host restarts on the rebuilt config.
 * - **A hand-picked root is never overwritten.** An unknown key fails the run
 *   (the developer edited it on purpose, and the resolver would throw at build
 *   time anyway); `on` keeps a different `voicePacksRoot` and reports it, and
 *   `off` refuses outright — picking a root by hand is exactly what the file is
 *   for, and only `auto` (whose whole meaning is "forget the marker") removes
 *   one, naming what it held. A marker saying `false` or nothing carries no
 *   choice worth keeping, so `on` and `off` overwrite those freely.
 *
 * Everything impure is injected — `exec`, `log`, `links`, `platform`, `env` —
 * and every path returns an exit code rather than calling `process.exit`, the
 * shape the other `scripts/lib` helpers use.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_DEV_VOICE_PACKS_ROOT,
  DEV_LOCAL_FILE,
  DEV_VOICES_ENV,
  readDevLocal,
  readDevVoicesEnv,
  resolveDevVoicePacksRoot,
} from "./dev-local.mjs";
import { loadEnvLocal } from "./env-local.mjs";
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

/**
 * The three plugin builds, and only those — nothing else reads the marker.
 * The stage task runs as their dependency, so this one command also fills the
 * default root while development mode is on.
 */
const BUILD_ARGS = [
  "exec",
  "turbo",
  "run",
  "build",
  "--filter=@iracedeck/iracing-plugin-stream-deck",
  "--filter=@iracedeck/iracing-plugin-mirabox",
  "--filter=@iracedeck/iracing-plugin-ulanzi",
];

const VERBS = ["on", "off", "auto"];
const USAGE = `Usage: pnpm dev:voices <${VERBS.join("|")}>`;

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
 * Loads `.env.local` into `env` for the switch — every variable EXCEPT
 * `IRACEDECK_DEV_VOICES`.
 *
 * The switch reads `.env.local` for the deck hosts' plugin directories, as the
 * link scripts do. Letting it supply the machine-wide opt-in too would make
 * `dev:voices` (and the turbo build it spawns, which inherits this process's
 * environment) honour a value that a plain `pnpm build` never sees, so the two
 * would build different plugins from the same worktree. The opt-in belongs in
 * the user environment; a definition in `.env.local` is ignored with a warning
 * saying so. The shell still wins for every other variable, exactly as
 * `loadEnvLocal` has it.
 *
 * @param {string} root Repo root containing `.env.local`.
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(message: string) => void} [options.warn]
 * @param {(root: string, env: Record<string, string | undefined>) => void} [options.load]
 */
export function loadEnvLocalForDevVoices(
  root,
  { env = process.env, warn = (message) => console.warn(message), load = loadEnvLocal } = {},
) {
  /** @type {Record<string, string | undefined>} */
  const fromFile = {};
  load(root, fromFile);

  for (const [key, value] of Object.entries(fromFile)) {
    if (key === DEV_VOICES_ENV) {
      warn(
        `Warning: .env.local sets ${DEV_VOICES_ENV} — ignored. Set it in your user environment instead, so a ` +
          "plain pnpm build sees the same value this command does.",
      );
      continue;
    }
    if (env[key] === undefined) env[key] = value;
  }
}

/**
 * Applies one verb to this worktree.
 *
 * @param {string | undefined} mode `"on"`, `"off"` or `"auto"`.
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
  if (!VERBS.includes(mode)) {
    log.error(`Error: expected one of ${VERBS.join(", ")}, got ${JSON.stringify(mode ?? "")}.`);
    log.error(USAGE);

    return 2;
  }

  // The machine setting is validated BEFORE anything is written: the build
  // would refuse a garbage value anyway, but that refusal would come after the
  // marker changed, and the transaction below exists to avoid exactly that.
  try {
    readDevVoicesEnv(env);
  } catch (error) {
    log.error(`Error: ${error.message}. Nothing written — fix the variable in your user environment.`);

    return 1;
  }

  // Captured BEFORE anything is written, so a failed build can put the file
  // back exactly as it was — see `restoreMarker`.
  const previous = readMarker(root);

  const marker = VERB_STEPS[mode](root, log);
  if (marker.code !== 0) return marker.code;

  // What the build about to run will decide — the same resolver the rollup
  // configs and the stage task ask, so this line and the build agree.
  const resolved = resolveDevVoicePacksRoot(root, { env });
  log.log(describeResolution(resolved, env));

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

  // Every verb rebuilds: the build is what carries the resolved root into each
  // plugin's bin/config.json — or takes it back out — and what stages the packs.
  log.log(
    resolved.voicePacksRoot === undefined
      ? "Rebuilding the three plugins so devVoicePacksRoot leaves every bin/config.json …"
      : "Rebuilding the three plugins so devVoicePacksRoot reaches every bin/config.json (staging the packs on the way) …",
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
  if (resolved.voicePacksRoot !== undefined) reportStaging(resolved, log);

  return code;
}

/**
 * One line saying what the build will decide, and why — the switch's answer to
 * "which mode am I in now?", which under a machine-wide opt-in is no longer
 * readable off the marker alone.
 */
function describeResolution(resolved, env) {
  const machine =
    env[DEV_VOICES_ENV] === undefined ? `${DEV_VOICES_ENV} unset` : `${DEV_VOICES_ENV}=${env[DEV_VOICES_ENV]}`;

  if (resolved.voicePacksRoot !== undefined) {
    return resolved.source === DEV_LOCAL_FILE
      ? `Development voices: on via ${DEV_LOCAL_FILE} — ${resolved.voicePacksRoot}`
      : `Development voices: on via ${machine} — ${resolved.voicePacksRoot}`;
  }

  return resolved.source === DEV_LOCAL_FILE
    ? `Development voices: off for this worktree via ${DEV_LOCAL_FILE} (${machine}).`
    : `Development voices: off (${machine}, no ${DEV_LOCAL_FILE}).`;
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
    // we could not read is one the verb will refuse a moment later anyway.
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
 * What the marker currently says, for the verbs to decide against.
 *
 * Validation is `readDevLocal`'s and nothing else's (#1143 review): this used
 * to be re-implemented here — parse, shape-check, hardcode the key list — and
 * the copy had already drifted, accepting a blank `voicePacksRoot` that the
 * build then resolved to the repo root. There is exactly one answer to "is
 * this marker usable?", and it is the reader every plugin's Rollup config
 * already asks. What stays here is only the absent / off / empty / default /
 * hand-picked classification, which the reader has no opinion about.
 *
 * @returns {{ state: "absent" | "off" | "empty" | "default" | "custom", root?: string } | { error: string }}
 */
function classifyMarker(root) {
  const file = path.join(root, DEV_LOCAL_FILE);
  if (!existsSync(file)) return { state: "absent" };

  let value;
  try {
    // Absolute, resolved from `root` — so a message names the directory that
    // will actually be scanned rather than the text in the file, which is what
    // a developer wondering where their pack went needs to read.
    value = readDevLocal(root).voicePacksRoot;
  } catch (error) {
    return { error: error.message };
  }

  if (value === false) return { state: "off" };
  if (value === undefined) return { state: "empty" };
  if (value === path.resolve(root, DEFAULT_DEV_VOICE_PACKS_ROOT)) return { state: "default", root: value };

  return { state: "custom", root: value };
}

function writeMarker(root, voicePacksRoot) {
  writeFileSync(
    path.join(root, DEV_LOCAL_FILE),
    `${JSON.stringify({ voicePacksRoot }, null, 2)}
`,
  );
}

/** `on`: writes the default root unless the marker already holds a path. */
function turnOn(root, log) {
  const marker = classifyMarker(root);
  if (marker.error !== undefined) {
    log.error(`Error: ${marker.error}. Nothing written — fix or delete the file.`);

    return { code: 1 };
  }

  switch (marker.state) {
    case "default":
      log.log(`${DEV_LOCAL_FILE} already points at ${marker.root} — left as is.`);

      return { code: 0 };
    case "custom":
      log.log(
        `${DEV_LOCAL_FILE} already points at ${marker.root} — kept (pnpm dev:voices auto removes the file if you want the default back).`,
      );

      return { code: 0 };
    default:
      // Absent, `false` or `{}`: none of these holds a choice worth keeping.
      writeMarker(root, DEFAULT_DEV_VOICE_PACKS_ROOT);
      log.log(`Wrote ${DEV_LOCAL_FILE}: voicePacksRoot = ${DEFAULT_DEV_VOICE_PACKS_ROOT}`);

      return { code: 0 };
  }
}

/** `off`: writes `false` — never deletes, because absent now means "follow the machine". */
function turnOff(root, log) {
  const marker = classifyMarker(root);
  if (marker.error !== undefined) {
    log.error(`Error: ${marker.error}. Nothing written — fix or delete the file.`);

    return { code: 1 };
  }

  switch (marker.state) {
    case "off":
      log.log(`${DEV_LOCAL_FILE} already says voicePacksRoot = false — left as is.`);

      return { code: 0 };
    case "custom":
      // A hand-picked root is the developer's, and `off` would erase it. They
      // can delete the file (or run `auto`) and come back; the switch does not
      // decide for them.
      log.error(
        `Error: ${DEV_LOCAL_FILE} points at a hand-picked root, ${marker.root} — not overwritten. ` +
          `Edit the file to "voicePacksRoot": false yourself, or run pnpm dev:voices auto and then off.`,
      );

      return { code: 1 };
    default:
      writeMarker(root, false);
      log.log(`Wrote ${DEV_LOCAL_FILE}: voicePacksRoot = false (development mode off for this worktree).`);

      return { code: 0 };
  }
}

/** `auto`: removes the marker so the worktree follows `IRACEDECK_DEV_VOICES`. */
function turnAuto(root, log) {
  const marker = classifyMarker(root);
  if (marker.error !== undefined) {
    log.error(`Error: ${marker.error}. Nothing removed — fix the file, or delete it by hand.`);

    return { code: 1 };
  }

  if (marker.state === "absent") {
    log.log(`No ${DEV_LOCAL_FILE} — this worktree already follows ${DEV_VOICES_ENV}.`);

    return { code: 0 };
  }

  rmSync(path.join(root, DEV_LOCAL_FILE));
  // What it held is named so a hand-picked root is not lost silently.
  const held =
    marker.state === "off" ? "voicePacksRoot = false" : marker.state === "empty" ? "no voicePacksRoot" : marker.root;
  log.log(`Removed ${DEV_LOCAL_FILE} (it held ${held}) — this worktree now follows ${DEV_VOICES_ENV}.`);

  return { code: 0 };
}

const VERB_STEPS = { on: turnOn, off: turnOff, auto: turnAuto };

/**
 * Says when the resolved root holds no pack after the build.
 *
 * For the default root that is a failure signal — the build's stage task should
 * have filled it — so the line names the task to run by hand. For a hand-picked
 * root it is information: the build stages only the default root, and the
 * developer who picked a directory fills it themselves.
 *
 * DIRECTORIES only, because that is what the scanner lists: `pack:voice` leaves
 * an `<id>-<version>.zip` beside the staged folder, so counting files let a
 * leftover zip suppress this hint while the plugin still warned the root was
 * empty — the switch and the plugin disagreeing about the same directory.
 */
function reportStaging({ voicePacksRoot, isDefaultRoot }, log) {
  let entries;
  try {
    entries = readdirSync(voicePacksRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    entries = [];
  }
  if (entries.length > 0) return;

  log.log(
    isDefaultRoot
      ? `No staged pack under ${voicePacksRoot} after the build — the build's stage task should have filled it; run it by hand: pnpm --filter @iracedeck/audio-assets stage:dev-voices`
      : `No pack under ${voicePacksRoot} yet — the build stages only the default root, so a hand-picked root is filled by hand.`,
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
