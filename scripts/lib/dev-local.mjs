/**
 * The gitignored per-worktree developer marker (#1143).
 *
 * Shape: `{ "voicePacksRoot": "<path>" }`. Each plugin's Rollup config reads it
 * the way it reads `feature-flags.local.json` and carries the resolved absolute
 * path into `bin/config.json` as `devVoicePacksRoot`. A release build cannot
 * carry the mechanism, because the file is never in git.
 *
 * Unlike `feature-flags.local.json` — which warns about an unknown key and
 * ignores it — this file has exactly one key, so a typo throws: silently
 * building with development mode off is the failure a developer would chase
 * in-game instead of in the build log.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DEV_LOCAL_FILE = "dev.local.json";
export const DEFAULT_DEV_VOICE_PACKS_ROOT = "packages/audio-assets/dist/voice-packs";

const KNOWN_KEYS = ["voicePacksRoot"];

/**
 * @param {string} root Repo root.
 * @param {{ fs?: { existsSync: (p: string) => boolean, readFileSync: (p: string, enc: string) => string } }} [options]
 * @returns {{ voicePacksRoot?: string }} `voicePacksRoot` absolute, resolved from `root`; `{}` when the file is absent.
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
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${DEV_LOCAL_FILE}: voicePacksRoot must be a non-empty string`);
    }
    out.voicePacksRoot = path.resolve(root, value);
  }
  return out;
}
