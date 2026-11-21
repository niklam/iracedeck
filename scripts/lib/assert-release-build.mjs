/**
 * "This built plugin folder carries no development voice root" (#1143).
 *
 * `dev-voice-root-guard.test.mjs` proves the SOURCE cannot emit
 * `devVoicePacksRoot` unconditionally — the marker is gitignored, and every
 * plugin's Rollup config spreads the key in conditionally. That is what makes
 * a build from a clean clone or a tag safe, and it is not the same question as
 * whether the ARTIFACT ABOUT TO BE PACKED is clean: `pnpm pack:plugin` packs
 * whatever is on disk in the plugin folder, and on a maintainer's machine that
 * folder is routinely a development build (`dev:voices on`, or the machine-wide
 * `IRACEDECK_DEV_VOICES=1` opt-in). The spec's
 * *Failure modes* row promises "a packed plugin carries no `devVoicePacksRoot`";
 * this is the step that keeps the promise, wired as the first thing every
 * `pack:plugin` script does.
 *
 * PRESENCE of the key is the property, never its value. It reaches the config
 * through a conditional spread, so a key that is there at all means the build
 * resolved development mode on — from the marker or, since #1214, from
 * `IRACEDECK_DEV_VOICES` — a blank or `null` value would still be a
 * development build, and one whose `devVoicePacksRoot` a hand edit had emptied
 * is not a release build that happens to look tidy.
 *
 * Since #1338 the same step also refuses a plugin folder whose `manifest.json`
 * carries a `Debug` key under `Nodejs` — what the inspector switch
 * `pnpm debug:plugin on` writes on a developer's machine.
 *
 * Since #1113 it refuses a config that turns on a DEVELOPMENT flag: one no
 * plugin's committed `platform-features.json` ships on (`readReleaseFlags`),
 * such as `trafficRejoin`, which a developer turns on in
 * `feature-flags.local.json` and the build merges into `featureFlags`. Here
 * the VALUE is the property, as the plugin reads it (`=== true`): every build
 * carries the key, `false` from the committed files.
 *
 * Everything impure is injected and an exit code is RETURNED rather than
 * `process.exit` called — the shape every `scripts/lib` helper uses, and what
 * makes the failure paths testable without a built plugin.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { DEBUG_VALUE, manifestDebug } from "./debug-plugin.mjs";
import { readReleaseFlags as readCommittedReleaseFlags } from "./release-flags.mjs";

/** The key a development build carries. Mirrors `PluginConfig.devVoicePacksRoot`. */
export const DEV_VOICE_PACKS_ROOT_KEY = "devVoicePacksRoot";

export const USAGE = "usage: node scripts/assert-release-build.mjs <path to bin/config.json>";

export const EXIT_CLEAN = 0;
export const EXIT_PROBLEM = 1;
export const EXIT_USAGE = 2;

/**
 * @param {string | undefined} configPath Path to a plugin's built `bin/config.json`.
 * @param {{ fs?: { existsSync: (p: string) => boolean, readFileSync: (p: string, enc: string) => string }, log?: { log: Function, error: Function }, readReleaseFlags?: () => ReadonlyMap<string, boolean> }} [options]
 *   `readReleaseFlags` answers which flags a release build ships on; the committed files by default.
 * @returns {number} 0 clean, 1 the artifact must not be packed, 2 bad arguments.
 */
export function assertReleaseBuild(
  configPath,
  { fs = { existsSync, readFileSync }, log = console, readReleaseFlags = readCommittedReleaseFlags } = {},
) {
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
        "packed or published. Development mode comes from dev.local.json or from IRACEDECK_DEV_VOICES=1 in your " +
        "environment. Run `pnpm dev:voices off` (it writes `voicePacksRoot: false` to dev.local.json, which wins " +
        "over the variable, and rebuilds the three plugins), then pack again.",
    );

    return EXIT_PROBLEM;
  }

  let releaseFlags;

  try {
    releaseFlags = readReleaseFlags();
  } catch (error) {
    log.error(
      `Error: the committed platform-features.json files could not be read (${error.message}), so the ` +
        `development flags in ${configPath} cannot be checked. Refusing to pack.`,
    );

    return EXIT_PROBLEM;
  }

  const developmentOn = developmentFlagsOn(parsed, releaseFlags);

  if (developmentOn.length > 0) {
    log.error(
      `Error: ${configPath} turns on ${developmentOn.map((flag) => `"${flag}"`).join(", ")}, which no plugin's ` +
        "committed platform-features.json ships on — this is a DEVELOPMENT build and must not be packed or " +
        "published. The flag came from feature-flags.local.json at the repository root: set it false there (or " +
        "delete the file), rebuild the plugins, then pack again.",
    );

    return EXIT_PROBLEM;
  }

  return assertNoDebugKey(configPath, { fs, log });
}

/**
 * The flags the built config's merged `featureFlags.features` turns on (`=== true`,
 * as the plugin reads a runtime flag) that no committed file ships on — a flag
 * the committed files do not declare included — sorted. A config with no
 * features object turns nothing on.
 *
 * @param {Record<string, unknown>} config
 * @param {ReadonlyMap<string, boolean>} releaseFlags
 * @returns {string[]}
 */
function developmentFlagsOn(config, releaseFlags) {
  const featureFlags = config.featureFlags;
  const features =
    featureFlags !== null && typeof featureFlags === "object" && !Array.isArray(featureFlags)
      ? /** @type {Record<string, unknown>} */ (featureFlags).features
      : undefined;

  if (features === null || typeof features !== "object" || Array.isArray(features)) return [];

  return Object.entries(features)
    .filter(([flag, value]) => value === true && releaseFlags.get(flag) !== true)
    .map(([flag]) => flag)
    .sort();
}

/**
 * The plugin folder's `manifest.json` must carry no `Debug` key in its
 * `Nodejs` block (#1338). `pnpm debug:plugin on` puts one there on a
 * developer's machine, and a packed plugin carrying it would start with an
 * inspector port for anyone running Stream Deck in developer mode.
 *
 * The manifest is found from the config path — `<plugin folder>/bin/config.json`
 * — so every `pack:plugin` keeps its one argument. Only Elgato manifests are
 * read by a host for the key, but the check is the same for all three: a
 * manifest without the key passes, and a folder with no `manifest.json` is left
 * to the packer, which refuses it on its own.
 */
function assertNoDebugKey(configPath, { fs, log }) {
  const manifestPath = path.join(path.dirname(path.dirname(configPath)), "manifest.json");
  if (!fs.existsSync(manifestPath)) return EXIT_CLEAN;

  let text;
  try {
    text = fs.readFileSync(manifestPath, "utf-8");
  } catch (error) {
    log.error(`Error: ${manifestPath} could not be read (${error.message}). Refusing to pack.`);

    return EXIT_PROBLEM;
  }

  const state = manifestDebug(text);
  if (!state.ok) {
    log.error(`Error: ${manifestPath} could not be parsed (${state.error}). Refusing to pack.`);

    return EXIT_PROBLEM;
  }
  if (state.present) {
    log.error(
      `Error: ${manifestPath} carries "Debug": ${JSON.stringify(state.value)} in its Nodejs block — the plugin would ` +
        "start with an inspector port, and must not be packed or published. " +
        (state.value === DEBUG_VALUE
          ? "Run `pnpm debug:plugin off`, then pack again."
          : "The switch did not set this value; remove the line by hand, then pack again."),
    );

    return EXIT_PROBLEM;
  }

  return EXIT_CLEAN;
}
