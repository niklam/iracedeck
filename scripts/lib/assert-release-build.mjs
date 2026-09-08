/**
 * "This built plugin folder carries no development voice root" (#1143).
 *
 * `dev-voice-root-guard.test.mjs` proves the SOURCE cannot emit
 * `devVoicePacksRoot` unconditionally — the marker is gitignored, and every
 * plugin's Rollup config spreads the key in conditionally. That is what makes
 * a build from a clean clone or a tag safe, and it is not the same question as
 * whether the ARTIFACT ABOUT TO BE PACKED is clean: `pnpm pack:plugin` packs
 * whatever is on disk in the plugin folder, and on a maintainer's machine that
 * folder is routinely a build made with `dev:voices on` in effect. The spec's
 * *Failure modes* row promises "a packed plugin carries no `devVoicePacksRoot`";
 * this is the step that keeps the promise, wired as the first thing every
 * `pack:plugin` script does.
 *
 * PRESENCE of the key is the property, never its value. It reaches the config
 * through a conditional spread, so a key that is there at all means the marker
 * was read at build time — a blank or `null` value would still be a
 * development build, and one whose `devVoicePacksRoot` a hand edit had emptied
 * is not a release build that happens to look tidy.
 *
 * Everything impure is injected and an exit code is RETURNED rather than
 * `process.exit` called — the shape every `scripts/lib` helper uses, and what
 * makes the failure paths testable without a built plugin.
 */
import { existsSync, readFileSync } from "node:fs";

/** The key a development build carries. Mirrors `PluginConfig.devVoicePacksRoot`. */
export const DEV_VOICE_PACKS_ROOT_KEY = "devVoicePacksRoot";

export const USAGE = "usage: node scripts/assert-release-build.mjs <path to bin/config.json>";

export const EXIT_CLEAN = 0;
export const EXIT_PROBLEM = 1;
export const EXIT_USAGE = 2;

/**
 * @param {string | undefined} configPath Path to a plugin's built `bin/config.json`.
 * @param {{ fs?: { existsSync: (p: string) => boolean, readFileSync: (p: string, enc: string) => string }, log?: { log: Function, error: Function } }} [options]
 * @returns {number} 0 clean, 1 the artifact must not be packed, 2 bad arguments.
 */
export function assertReleaseBuild(configPath, { fs = { existsSync, readFileSync }, log = console } = {}) {
  if (typeof configPath !== "string" || configPath.trim() === "") {
    log.error(USAGE);

    return EXIT_USAGE;
  }

  // A missing config is a failure rather than a pass. The only reason to ask
  // this question is that a plugin folder is about to be packed, and a folder
  // with no `bin/config.json` has not been built — packing it would produce a
  // distributable with no plugin config at all, which this guard is in exactly
  // the right place to catch.
  if (!fs.existsSync(configPath)) {
    log.error(`Error: ${configPath} does not exist — the plugin is not built. Run pnpm build first.`);

    return EXIT_PROBLEM;
  }

  let parsed;

  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (error) {
    // Unreadable and unparseable share this branch: either way the question
    // cannot be answered, and packing on an unanswered question is the failure
    // the guard exists to prevent.
    log.error(`Error: ${configPath} could not be read (${error.message}). Refusing to pack.`);

    return EXIT_PROBLEM;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.error(`Error: ${configPath} does not hold an object. Refusing to pack.`);

    return EXIT_PROBLEM;
  }

  if (DEV_VOICE_PACKS_ROOT_KEY in parsed) {
    log.error(
      `Error: ${configPath} carries ${DEV_VOICE_PACKS_ROOT_KEY} — this is a DEVELOPMENT build and must not be ` +
        "packed or published. Run `pnpm dev:voices off` (it removes dev.local.json and rebuilds the three plugins), " +
        "then pack again.",
    );

    return EXIT_PROBLEM;
  }

  return EXIT_CLEAN;
}
