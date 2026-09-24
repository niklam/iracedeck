/**
 * The development voice root: where the built plugins scan for voice packs
 * instead of the managed download (#1143), and the machine-wide opt-in that
 * turns it on for every worktree (#1214).
 *
 * Two inputs decide it, and `resolveDevVoicePacksRoot` is the ONE place they
 * are combined — each plugin's Rollup config and the `stage:dev-voices` turbo
 * task both ask it, so the build cannot stage without pointing the plugin at
 * the stage, or the reverse:
 *
 * - `dev.local.json`, the gitignored per-worktree marker. Shape:
 *   `{ "voicePacksRoot": "<path>" }` turns development mode on at that path;
 *   `{ "voicePacksRoot": false }` turns it off for this worktree whatever the
 *   machine says; an absent file (or `{}`) follows the machine setting.
 * - `IRACEDECK_DEV_VOICES`, the machine-wide opt-in in the developer's user
 *   environment: `1` is on (at `DEFAULT_DEV_VOICE_PACKS_ROOT` inside the
 *   worktree being built), `0` or unset is off.
 *
 * The marker wins when it says anything; the variable decides only when the
 * marker is silent. The plugin carries the resolved absolute path in
 * `bin/config.json` as `devVoicePacksRoot`. A release build cannot carry the
 * mechanism, because the marker is never in git and CI never sets the variable
 * (`scripts/dev-voice-root-guard.test.mjs` pins both).
 *
 * Both readers are strict. Unlike `feature-flags.local.json` — which warns
 * about an unknown key and ignores it — the marker has exactly one key, so a
 * typo throws; and the variable accepts exactly `1` and `0`, so `true`, `yes`
 * or a stray space throw naming the variable. Silently building with
 * development mode off is the failure a developer would chase in-game instead
 * of in the build log, and a machine-wide opt-in that silently failed to take
 * would be the same failure with a longer search.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DEV_LOCAL_FILE = "dev.local.json";
export const DEFAULT_DEV_VOICE_PACKS_ROOT = "packages/audio-assets/dist/voice-packs";
export const DEV_VOICES_ENV = "IRACEDECK_DEV_VOICES";

const KNOWN_KEYS = ["voicePacksRoot"];

/**
 * @typedef {{ existsSync: (p: string) => boolean, readFileSync: (p: string, enc: string) => string }} DevLocalFs
 */

/**
 * Reads the marker alone — no environment involved. Most callers want
 * {@link resolveDevVoicePacksRoot}; this is for the switch (`dev-voices.mjs`),
 * which needs to know what the FILE says before deciding whether to rewrite it.
 *
 * @param {string} root Repo root.
 * @param {{ fs?: DevLocalFs }} [options]
 * @returns {{ voicePacksRoot?: string | false }} `voicePacksRoot` absolute, resolved from `root`,
 *   or `false` for the explicit per-worktree off; `{}` when the file is absent or claims nothing.
 */
export function readDevLocal(root, { fs = { existsSync, readFileSync } } = {}) {
  const file = path.join(root, DEV_LOCAL_FILE);
  if (!fs.existsSync(file)) return {};

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`${DEV_LOCAL_FILE}: not valid JSON (${err.message})`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${DEV_LOCAL_FILE}: expected an object`);
  }

  const unknown = Object.keys(parsed).filter((key) => !KNOWN_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${DEV_LOCAL_FILE}: unknown key(s) ${unknown.join(", ")} — known: ${KNOWN_KEYS.join(", ")}`);
  }

  const out = {};
  if ("voicePacksRoot" in parsed) {
    const value = parsed.voicePacksRoot;
    if (value === false) {
      out.voicePacksRoot = false;
    } else if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `${DEV_LOCAL_FILE}: voicePacksRoot must be a non-empty string, or false to turn development mode off`,
      );
    } else {
      out.voicePacksRoot = path.resolve(root, value);
    }
  }
  return out;
}

/**
 * The machine-wide opt-in, read strictly: `1` → true, `0` or unset → false,
 * anything else throws naming the variable. Exported for the callers that
 * report the machine setting on its own (the switch does); the resolver below
 * is what decides the build.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function readDevVoicesEnv(env = process.env) {
  const value = env[DEV_VOICES_ENV];
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;

  throw new Error(`${DEV_VOICES_ENV}: expected "1" or "0", got ${JSON.stringify(value)}`);
}

/**
 * Whether two absolute paths name the same directory, as the platform sees it:
 * case-insensitively on Windows, whose file system is, and exactly elsewhere.
 * Both are `path.resolve`d first, so separators and a trailing slash never
 * matter. Exported for every caller that asks "is this the default root?" —
 * one answer, so the resolver, the stage task and the switch cannot disagree.
 *
 * @param {string} a
 * @param {string} b
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function isSamePath(a, b, platform = process.platform) {
  const ra = path.resolve(a);
  const rb = path.resolve(b);

  return platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * Decides the development voice root for a build of `root`. First match wins:
 *
 * | `dev.local.json`           | `IRACEDECK_DEV_VOICES` | Result                                          |
 * | -------------------------- | ---------------------- | ----------------------------------------------- |
 * | `voicePacksRoot: "<path>"` | any                    | on, at that path — source `dev.local.json`      |
 * | `voicePacksRoot: false`    | any                    | off — source `dev.local.json`                   |
 * | absent (or `{}`)           | `1`                    | on, at the default root — source the variable   |
 * | absent (or `{}`)           | `0` / unset            | off — no source                                 |
 *
 * The variable is validated on EVERY call, including the rows the marker
 * decides: a garbage value is a typo in someone's user environment, and the
 * worktree that happens to carry a marker is the wrong place for it to pass
 * unnoticed.
 *
 * `isDefaultRoot` says whether the resolved root is this worktree's own
 * `DEFAULT_DEV_VOICE_PACKS_ROOT` — the one directory the build stages into. A
 * hand-picked path belongs to whoever picked it, and the stage task leaves it
 * alone (#1214 §3). The comparison is {@link isSamePath}'s, so on Windows a
 * marker spelling the default root in another case still counts as it.
 *
 * @param {string} root Repo root — the worktree being built.
 * @param {{ env?: Record<string, string | undefined>, fs?: DevLocalFs, platform?: NodeJS.Platform }} [options]
 * @returns {{ voicePacksRoot: string | undefined, source: "dev.local.json" | "IRACEDECK_DEV_VOICES" | undefined, isDefaultRoot: boolean }}
 */
export function resolveDevVoicePacksRoot(root, { env = process.env, fs, platform = process.platform } = {}) {
  const marker = readDevLocal(root, fs === undefined ? {} : { fs });
  const machineOn = readDevVoicesEnv(env);
  const defaultRoot = path.resolve(root, DEFAULT_DEV_VOICE_PACKS_ROOT);

  if (marker.voicePacksRoot === false) {
    return { voicePacksRoot: undefined, source: DEV_LOCAL_FILE, isDefaultRoot: false };
  }
  if (marker.voicePacksRoot !== undefined) {
    return {
      voicePacksRoot: marker.voicePacksRoot,
      source: DEV_LOCAL_FILE,
      isDefaultRoot: isSamePath(marker.voicePacksRoot, defaultRoot, platform),
    };
  }
  if (machineOn) {
    return { voicePacksRoot: defaultRoot, source: DEV_VOICES_ENV, isDefaultRoot: true };
  }

  return { voicePacksRoot: undefined, source: undefined, isDefaultRoot: false };
}
