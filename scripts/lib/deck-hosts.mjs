/**
 * Descriptors for the deck host applications a dev build can be linked into,
 * plus the pure resolvers that turn an environment into concrete paths (#1040).
 *
 * Elgato is deliberately absent: its linking goes through the `streamdeck` CLI
 * and its start/stop scripts hardcode the single install path — see the
 * `*:stream-deck` entries in the root `package.json`.
 *
 * Every path here is derived from environment variables rather than written out
 * literally, so the defaults follow a non-standard Windows install.
 */
import { join } from "node:path";

/**
 * @typedef {object} DeckHost
 * @property {string} id             CLI name, e.g. `ulanzi`.
 * @property {string} label          Human name used in messages, e.g. `Ulanzi`.
 * @property {string} pluginsDirEnv  Env var overriding the plugins directory.
 * @property {string} appPathEnv     Env var overriding the host executable.
 * @property {string} unlinkScript   pnpm script named in the "already exists" error.
 * @property {string} package        Directory under `packages/` holding the plugin.
 * @property {string} pluginFolder   Plugin folder name, also the link name.
 * @property {string} examplePluginsDir  Sample value shown when nothing resolves.
 */

/** @type {Record<string, DeckHost>} */
export const DECK_HOSTS = {
  mirabox: {
    id: "mirabox",
    label: "Mirabox",
    pluginsDirEnv: "MIRABOX_PLUGINS_DIR",
    appPathEnv: "MIRABOX_APP_PATH",
    unlinkScript: "unlink:mirabox",
    package: "iracing-plugin-mirabox",
    pluginFolder: "com.iracedeck.sd.core.sdPlugin",
    examplePluginsDir: String.raw`C:\Users\you\AppData\Roaming\HotSpot\StreamDock\plugins`,
    exampleAppPath: String.raw`C:\Program Files (x86)\StreamDock\StreamDock.exe`,
  },
  ulanzi: {
    id: "ulanzi",
    label: "Ulanzi",
    pluginsDirEnv: "ULANZI_PLUGINS_DIR",
    appPathEnv: "ULANZI_APP_PATH",
    unlinkScript: "unlink:ulanzi",
    package: "iracing-plugin-ulanzi",
    pluginFolder: "com.ulanzi.iracedeck.ulanziPlugin",
    examplePluginsDir: String.raw`C:\Users\you\AppData\Roaming\Ulanzi\UlanziDeck\Plugins`,
    exampleAppPath: String.raw`C:\Program Files (x86)\Ulanzi Studio\UlanziDeck.exe`,
  },
};

/**
 * Windows default plugins directory per host, derived from `%APPDATA%`.
 *
 * Mirabox defaults to the standard HotSpot StreamDock install; other
 * Mirabox-compatible hosts (VSD Craft) install elsewhere and need the env var.
 * Note the capitalisation difference — Ulanzi uses `Plugins`, StreamDock uses
 * `plugins`. Windows does not care, but the suggested value should be right.
 */
const DEFAULT_PLUGINS_DIR = {
  mirabox: (env) => (env.APPDATA ? join(env.APPDATA, "HotSpot", "StreamDock", "plugins") : undefined),
  ulanzi: (env) => (env.APPDATA ? join(env.APPDATA, "Ulanzi", "UlanziDeck", "Plugins") : undefined),
};

/** Windows default host executable per host, derived from `%ProgramFiles(x86)%`. */
const DEFAULT_APP_PATH = {
  mirabox: (env) => {
    const programFiles = env["ProgramFiles(x86)"];

    return programFiles ? join(programFiles, "StreamDock", "StreamDock.exe") : undefined;
  },
  ulanzi: (env) => {
    const programFiles = env["ProgramFiles(x86)"];

    return programFiles ? join(programFiles, "Ulanzi Studio", "UlanziDeck.exe") : undefined;
  },
};

/**
 * Resolves a host by its CLI name, or exits with the list of valid names.
 *
 * @param {string | undefined} id
 * @returns {DeckHost}
 */
export function requireHost(id) {
  const host = id ? DECK_HOSTS[id] : undefined;
  if (!host) {
    const names = Object.keys(DECK_HOSTS).join(", ");
    console.error(`Error: unknown host ${JSON.stringify(id ?? "")}. Expected one of: ${names}`);
    process.exit(1);
  }

  return host;
}

/**
 * The host's plugins directory: the env var if set, else the Windows default.
 * Returns `undefined` when neither applies (non-Windows, or no `%APPDATA%`).
 *
 * @param {DeckHost} host
 */
export function resolvePluginsDir(host, { env = process.env, platform = process.platform } = {}) {
  return env[host.pluginsDirEnv] ?? (platform === "win32" ? DEFAULT_PLUGINS_DIR[host.id](env) : undefined);
}

/**
 * The host's executable: the env var if set, else the Windows default.
 * Returns `undefined` when neither applies.
 *
 * @param {DeckHost} host
 */
export function resolveAppPath(host, { env = process.env, platform = process.platform } = {}) {
  return env[host.appPathEnv] ?? (platform === "win32" ? DEFAULT_APP_PATH[host.id](env) : undefined);
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
