/**
 * The callout scripts the harness auditions (issue #1064).
 *
 * Since #1064 a Race Engineer voice's callouts are data the voice ships —
 * `voice/<voice-id>/callouts.json`, compiled by the scenario engine against the
 * contracts the catalog registers in code. A voice with no script is silent
 * for every contract, so a harness that never handed the engine a script would
 * boot, register every family, and play nothing for the migrated ones.
 *
 * Two loaders, for the two places a script can come from:
 *
 * - {@link loadBundledVoiceScripts} reads each bundled voice's artifact straight
 *   from the `@iracedeck/audio-assets` source tree — the very file the plugin
 *   build copies and the packer ships. Deliberately LOUD: the harness is a dev
 *   tool, and a bundled voice whose script is missing or malformed is a build
 *   that would ship a silent engineer, which should stop the boot with the file
 *   named rather than be logged past. (The plugins, which must never end the
 *   process over a pack, go through the never-throwing scanner instead.)
 * - {@link loadInstalledVoiceScripts} runs the plugins' own voice-pack service
 *   over a packs directory (`IRACEDECK_VOICE_PACKS_PATH`), with the real file
 *   system port, so a sideloaded or downloaded pack's clips AND script load
 *   exactly as they do in a plugin — the service applies roots, then the
 *   manifest, then the scripts, in the order the plugins rely on.
 */
import { audioAssetsPath, BUNDLED_VOICE_IDS } from "@iracedeck/audio-assets/build";
import { type AudioAssetsManifest, mergeManifests } from "@iracedeck/audio-scenarios";
import { type CalloutScript, calloutScriptPath, parseCalloutScript } from "@iracedeck/callout-script";
import { createVoicePackFileSystem, createVoicePackService, type VoicePackService } from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type LoadBundledVoiceScriptsOptions = {
  /** The audio-assets tree to read from. Default: the workspace package. */
  root?: string;
  /** The voices to read. Default: every bundled voice. */
  voiceIds?: readonly string[];
};

/**
 * Every bundled voice's script, voice id → parsed script, read from
 * `<root>/voice/<voice-id>/callouts.json`.
 *
 * Throws — naming the file — when a voice has no readable artifact, when it is
 * not JSON, or when it fails the grammar. A bundled voice with no script is a
 * packaging bug, not a clips-only voice, and the harness exists to surface
 * exactly that kind of thing before a release does.
 */
export function loadBundledVoiceScripts(
  options: LoadBundledVoiceScriptsOptions = {},
): ReadonlyMap<string, CalloutScript> {
  const { root = audioAssetsPath, voiceIds = BUNDLED_VOICE_IDS } = options;
  const scripts = new Map<string, CalloutScript>();

  for (const id of voiceIds) {
    scripts.set(id, readVoiceScriptOrThrow(join(root, calloutScriptPath(id)), id));
  }

  return scripts;
}

function readVoiceScriptOrThrow(file: string, voiceId: string): CalloutScript {
  let text: string;

  try {
    text = readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`Bundled voice "${voiceId}" has no readable callout script at ${file}: ${describe(err)}`);
  }

  let json: unknown;

  try {
    // A leading BOM is stripped exactly as the scanner strips it, so the harness
    // accepts the same bytes the plugin would.
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw new Error(`Bundled voice "${voiceId}": ${file} is not valid JSON: ${describe(err)}`);
  }

  const parsed = parseCalloutScript(json);

  if (!parsed.ok) {
    throw new Error(`Bundled voice "${voiceId}": ${file} is not a valid callout script: ${parsed.problems.join("; ")}`);
  }

  return parsed.script;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type LoadInstalledVoiceScriptsDeps = {
  /** The packs directory — `IRACEDECK_VOICE_PACKS_PATH`. */
  root: string;
  /**
   * The harness's own audio root: the processed bundled clips, with each
   * bundled voice's `callouts.json` copied beside them. Always the first,
   * highest-precedence root, exactly as a plugin's `assets/audio` is.
   */
  pluginAudioDir: string;
  /** The compiled-in manifest the packs' clip lists are merged over. */
  bundledManifest: AudioAssetsManifest;
  /** Voice ids the bundle provides; a pack may not claim one (#1034). */
  bundledVoices: readonly string[];
  /**
   * The bundled scripts (from {@link loadBundledVoiceScripts}). The service
   * reads the bundled voices' scripts from `pluginAudioDir` itself, so these
   * only fill in for a processed root that predates the script copy; where
   * both exist they are the same bytes.
   */
  bundledScripts: ReadonlyMap<string, CalloutScript>;
  logger: ILogger;
  /** The ordered audio roots → the audio service (`setRoots`). */
  applyRoots(roots: readonly { dir: string; clips?: readonly string[] }[]): void;
  /** The MERGED manifest — bundled plus every pack's clips — → the engine and the voice list. */
  applyManifest(manifest: AudioAssetsManifest): void;
  /** Bundled scripts with every installed voice's script over them → the engine. */
  applyScripts(scripts: ReadonlyMap<string, CalloutScript>): void;
};

/**
 * Scan a packs directory once, through the plugins' own voice-pack service and
 * file-system port, and hand the result over in the plugins' order: roots,
 * then the merged manifest, then the merged script map. Returns the service so
 * the caller can read `installed()` (for the voice labels) and `problems()`.
 *
 * The service never throws: a broken pack is a logged problem and a missing
 * directory an empty scan, both of which are what a plugin would do — the
 * loud failure mode is reserved for the bundled script above.
 */
export function loadInstalledVoiceScripts(deps: LoadInstalledVoiceScriptsDeps): VoicePackService {
  const service = createVoicePackService({
    root: deps.root,
    fs: createVoicePackFileSystem(deps.logger),
    logger: deps.logger,
    pluginAudioDir: deps.pluginAudioDir,
    reservedVoices: deps.bundledVoices,
    applyRoots: (roots) => deps.applyRoots(roots),
    applyManifest: (fragments) => deps.applyManifest(mergeManifests(deps.bundledManifest, fragments)),
    // Installed over bundled: the two sets cannot overlap (the scanner refuses a
    // pack's claim on a bundled id), so this is a union, not a precedence rule.
    applyScripts: (scripts) => deps.applyScripts(new Map([...deps.bundledScripts, ...scripts])),
    onPacksChanged: () => {},
  });

  service.refresh();

  return service;
}
