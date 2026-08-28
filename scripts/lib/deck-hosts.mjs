/**
 * Descriptors for the deck host applications a dev build can be linked into,
 * plus the pure resolvers that turn an environment into concrete paths (#1040).
 *
 * Elgato is deliberately absent: its linking goes through the `streamdeck` CLI
 * and its start/stop scripts hardcode the single install path — see the
 * `*:stream-deck` entries in the root `package.json`.
 *
 * Every path here is derived from environment variables rather than written out
 * literally, so the defaults follow a non-standard Windows install. The defaults
 * live ON each descriptor rather than in id-keyed maps beside it: a parallel map
 * lets a new or renamed host resolve to `undefined` and crash with a TypeError
 * instead of the fail-fast message, and only on Windows, so CI stays green.
 */
import { join } from "node:path";

/**
 * @typedef {object} DeckHost
 * @property {string} id             CLI name, e.g. `ulanzi`.
 * @property {string} label          Human name used in messages, e.g. `Ulanzi`.
 * @property {string} pluginsDirEnv  Env var overriding the plugins directory.
 * @property {string} appPathEnv     Env var overriding the host executable.
 * @property {string} linkScript     pnpm script that creates the link.
 * @property {string} unlinkScript   pnpm script that removes it.
 * @property {string} package        Directory under `packages/` holding the plugin.
 * @property {string} pluginFolder   Plugin folder name, also the link name.
 * @property {string} examplePluginsDir  Sample plugins dir shown when nothing resolves.
 * @property {string} exampleAppPath     Sample executable shown when nothing resolves.
 * @property {(env: Record<string, string | undefined>) => string | undefined} defaultPluginsDir
 * @property {(env: Record<string, string | undefined>) => string | undefined} defaultAppPath
 */

/** @type {Record<string, DeckHost>} */
export const DECK_HOSTS = {
  mirabox: {
    id: "mirabox",
    label: "Mirabox",
    pluginsDirEnv: "MIRABOX_PLUGINS_DIR",
    appPathEnv: "MIRABOX_APP_PATH",
    linkScript: "link:mirabox",
    unlinkScript: "unlink:mirabox",
    package: "iracing-plugin-mirabox",
    pluginFolder: "com.iracedeck.sd.core.sdPlugin",
    examplePluginsDir: String.raw`C:\Users\you\AppData\Roaming\HotSpot\StreamDock\plugins`,
    exampleAppPath: String.raw`C:\Program Files (x86)\StreamDock\StreamDock.exe`,
    // Standard HotSpot StreamDock install. Other Mirabox-compatible hosts
    // (VSD Craft) install elsewhere and need the env var.
    defaultPluginsDir: (env) => (env.APPDATA ? join(env.APPDATA, "HotSpot", "StreamDock", "plugins") : undefined),
    defaultAppPath: (env) =>
      env["ProgramFiles(x86)"] ? join(env["ProgramFiles(x86)"], "StreamDock", "StreamDock.exe") : undefined,
  },
  ulanzi: {
    id: "ulanzi",
    label: "Ulanzi",
    pluginsDirEnv: "ULANZI_PLUGINS_DIR",
    appPathEnv: "ULANZI_APP_PATH",
    linkScript: "link:ulanzi",
    unlinkScript: "unlink:ulanzi",
    package: "iracing-plugin-ulanzi",
    pluginFolder: "com.ulanzi.iracedeck.ulanziPlugin",
    examplePluginsDir: String.raw`C:\Users\you\AppData\Roaming\Ulanzi\UlanziDeck\Plugins`,
    exampleAppPath: String.raw`C:\Program Files (x86)\Ulanzi Studio\UlanziDeck.exe`,
    // Note the capitalisation: Ulanzi uses `Plugins`, StreamDock uses `plugins`.
    // Windows does not care, but a suggested value should still be right.
    defaultPluginsDir: (env) => (env.APPDATA ? join(env.APPDATA, "Ulanzi", "UlanziDeck", "Plugins") : undefined),
    defaultAppPath: (env) =>
      env["ProgramFiles(x86)"] ? join(env["ProgramFiles(x86)"], "Ulanzi Studio", "UlanziDeck.exe") : undefined,
  },
};

/**
 * Looks a host up by CLI name. Returns `undefined` for an unknown name rather
 * than exiting, so this module stays pure and testable — the caller owns how a
 * bad argument is reported.
 *
 * @param {string | undefined} id
 * @returns {DeckHost | undefined}
 */
export function findHost(id) {
  return id ? DECK_HOSTS[id] : undefined;
}

/** Comma-separated list of valid host names, for error messages. */
export function hostNames() {
  return Object.keys(DECK_HOSTS).join(", ");
}

/**
 * An env var counts as set only when it holds something non-blank. `FOO=` in
 * `.env.local` would otherwise pass `??` as `""`, suppressing the platform
 * default and then failing as though nothing were configured at all.
 */
function fromEnv(env, name) {
  const value = env[name];

  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Where a resolved path came from, so callers can word errors accurately —
 * blaming an env var the user never set sends them to the wrong place.
 *
 * @returns {{ path: string | undefined, source: "env" | "default" | "none" }}
 */
export function resolvePluginsDirSource(host, { env = process.env, platform = process.platform } = {}) {
  const configured = fromEnv(env, host.pluginsDirEnv);
  if (configured) return { path: configured, source: "env" };

  const derived = platform === "win32" ? host.defaultPluginsDir(env) : undefined;

  return derived ? { path: derived, source: "default" } : { path: undefined, source: "none" };
}

/** @see resolvePluginsDirSource */
export function resolveAppPathSource(host, { env = process.env, platform = process.platform } = {}) {
  const configured = fromEnv(env, host.appPathEnv);
  if (configured) return { path: configured, source: "env" };

  const derived = platform === "win32" ? host.defaultAppPath(env) : undefined;

  return derived ? { path: derived, source: "default" } : { path: undefined, source: "none" };
}

/**
 * The host's plugins directory: the env var if set, else the Windows default.
 * `undefined` when neither applies (non-Windows, or no `%APPDATA%`).
 *
 * @param {DeckHost} host
 */
export function resolvePluginsDir(host, options = {}) {
  return resolvePluginsDirSource(host, options).path;
}

/**
 * The host's executable: the env var if set, else the Windows default.
 *
 * @param {DeckHost} host
 */
export function resolveAppPath(host, options = {}) {
  return resolveAppPathSource(host, options).path;
}

/**
 * Absolute path to the built plugin folder that gets linked into the host.
 *
 * @param {DeckHost} host
 * @param {string} root Repo root.
 */
export function pluginSourceDir(host, root) {
  return join(root, "packages", host.package, host.pluginFolder);
}
