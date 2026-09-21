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
 * - {@link loadBundledVoiceScripts} reads each published voice's artifact
 *   straight from the `@iracedeck/audio-assets` source tree — the very file the
 *   plugin build copies (for the bundled subset) and the packer ships (for
 *   every published voice). Deliberately LOUD: the harness is a dev tool, and a
 *   published voice whose script is missing or malformed is a build that would
 *   ship a silent engineer, which should stop the boot with the file named
 *   rather than be logged past. (The plugins, which must never end the process
 *   over a pack, go through the never-throwing scanner instead.)
 * - {@link loadInstalledVoiceScripts} runs the plugins' own voice-pack service
 *   over a packs directory (`IRACEDECK_VOICE_PACKS_PATH`), with the real file
 *   system port, so a sideloaded or downloaded pack's clips AND script load
 *   as they do in a plugin — the service applies roots, then the manifest,
 *   then the scripts, in the order the plugins rely on. A pack's voices are
 *   its composite `<pack>::<voice>` ids (#1144) and the source tree's are
 *   bare, so a pack shipping one of the source tree's voice ids — a
 *   downloaded `default` under that directory, say — is a second voice
 *   (`default::default`) beside the source tree's `default`, each playing
 *   only its own clips, never one half-merged voice.
 *
 * And one re-loader, {@link reloadVoiceScripts}, for the UI's Reload and Wipe
 * cache buttons: the audio processor copies a regenerated `callouts.json`
 * beside the clips, but the engine keeps the map it compiled at boot until it
 * is handed the new one — which is what makes "regenerate, press Reload,
 * audition" work without a restart. Which of the two loaders it re-runs, and
 * therefore how a broken script surfaces, is the reloader's own note.
 */
import { audioAssetsPath, PUBLISHED_VOICE_IDS } from "@iracedeck/audio-assets/build";
import { type AudioAssetsManifest, mergeManifests } from "@iracedeck/audio-scenarios";
import {
  CALLOUT_SCRIPT_FILE,
  type CalloutScript,
  calloutScriptPath,
  parseCalloutScriptText,
} from "@iracedeck/callout-script";
import {
  createVoicePackFileSystem,
  createVoicePackService,
  readVoiceScript,
  type VoicePackService,
} from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type LoadBundledVoiceScriptsOptions = {
  /** The audio-assets tree to read from. Default: the workspace package. */
  root?: string;
  /** The voices to read. Default: every published voice. */
  voiceIds?: readonly string[];
};

/**
 * Each published voice's script, voice id → parsed script, read from
 * `<root>/voice/<voice-id>/callouts.json`.
 *
 * Throws — naming the file — when a voice has no readable artifact, when it is
 * not JSON, or when it fails the grammar. A published voice with no script is a
 * packaging bug, not a clips-only voice, and the harness exists to surface
 * exactly that kind of thing before a release does.
 */
export function loadBundledVoiceScripts(
  options: LoadBundledVoiceScriptsOptions = {},
): ReadonlyMap<string, CalloutScript> {
  const { root = audioAssetsPath, voiceIds = PUBLISHED_VOICE_IDS } = options;
  const scripts = new Map<string, CalloutScript>();

  for (const id of voiceIds) {
    scripts.set(id, readVoiceScriptOrThrow(join(root, calloutScriptPath(id)), id));
  }

  return scripts;
}

/**
 * The harness's reader is a thin wrapper over the grammar's one text stage —
 * `parseCalloutScriptText`, the very function the plugin's scanner and the
 * packer run over the same bytes — with the harness's own failure contract
 * around it: it THROWS, naming the file, where the scanner reports a problem.
 * A file that is not JSON is the grammar's first problem (`(document): not
 * valid JSON: …`), listed like any other.
 */
function readVoiceScriptOrThrow(file: string, voiceId: string): CalloutScript {
  let text: string;

  try {
    text = readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`Bundled voice "${voiceId}" has no readable callout script at ${file}: ${describe(err)}`);
  }

  const parsed = parseCalloutScriptText(text);

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
  /**
   * The bundled scripts (from {@link loadBundledVoiceScripts}), keyed by the
   * source tree's bare voice ids — which are also the voices whose scripts
   * are re-read from `pluginAudioDir` on every scan, so a regenerated copy
   * there is picked up by a Reload. These fill in for a processed root that
   * predates the script copy; where both exist they are the same bytes.
   */
  bundledScripts: ReadonlyMap<string, CalloutScript>;
  logger: ILogger;
  /** The ordered audio roots → the audio service (`setRoots`). */
  applyRoots(
    roots: readonly { dir: string; clips?: readonly string[]; voices?: Readonly<Record<string, string>> }[],
  ): void;
  /** The MERGED manifest — bundled plus every pack's clips — → the engine and the voice list. */
  applyManifest(manifest: AudioAssetsManifest): void;
  /** Bundled scripts with every installed voice's script beside them → the engine. */
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
  const fs = createVoicePackFileSystem(deps.logger);

  /**
   * The bundled voices' scripts as the processed root holds them now, through
   * the reader the scanner runs over a pack. The plugins bundle no voice, so
   * this is the harness's own read (it was the service's until #1144 dropped
   * the bundle from it). Never a throw — it runs inside the service's refresh,
   * which must not end the harness over a script: a voice whose copy is
   * missing or broken is warned about and keeps the script it was booted with.
   */
  function readProcessedScripts(): Map<string, CalloutScript> {
    const scripts = new Map(deps.bundledScripts);

    for (const id of deps.bundledScripts.keys()) {
      const read = readVoiceScript(fs, deps.pluginAudioDir, id);

      if (read.ok && read.script !== null) {
        scripts.set(id, read.script);
        continue;
      }

      deps.logger.warn(
        `Bundled voice "${id}" has no usable script: ${read.ok ? `it has no ${CALLOUT_SCRIPT_FILE}` : read.reason}`,
      );
    }

    return scripts;
  }

  const service = createVoicePackService({
    root: deps.root,
    fs,
    logger: deps.logger,
    pluginAudioDir: deps.pluginAudioDir,
    applyRoots: (roots) => deps.applyRoots(roots),
    applyManifest: (fragments) => deps.applyManifest(mergeManifests(deps.bundledManifest, fragments)),
    // Bundled beside installed: the source tree's voices are bare ids and a
    // pack's are composite (#1144), so the two key sets cannot overlap and
    // this is a union, not a precedence rule.
    applyScripts: (scripts) => deps.applyScripts(new Map([...readProcessedScripts(), ...scripts])),
    onPacksChanged: () => {},
  });

  service.refresh();

  return service;
}

export type ReloadVoiceScriptsDeps = {
  /**
   * The pack service {@link loadInstalledVoiceScripts} returned, or `null`
   * when no packs directory was named. With a service the reload is ITS
   * refresh — it re-reads the bundled scripts from the processed root the
   * processor just refreshed, plus every installed pack, and applies roots,
   * manifest and scripts in the plugins' order through its own deps.
   */
  voicePacks: VoicePackService | null;
  /** Without a service: the re-read bundled scripts → the engine. */
  applyScripts(scripts: ReadonlyMap<string, CalloutScript>): void;
  /** Where the bundled scripts are re-read from without a service. Default: the workspace package, every published voice. */
  bundled?: LoadBundledVoiceScriptsOptions;
};

/**
 * Re-read the callout scripts and hand them to the engine again — the script
 * half of the UI's Reload (#1064).
 *
 * How a broken regenerated script surfaces depends on the path. Without a
 * packs directory the bundled loader THROWS, naming the file, and the Reload
 * request fails loudly rather than leaving the engine on the old map in
 * silence. With one, the reload is the plugins' own pack service's refresh,
 * which never throws over a script, and neither does the bundled read inside
 * it: it WARNS per bundled voice with no usable script (`Bundled voice "<id>"
 * has no usable script: …`) and that voice keeps the script it was booted
 * with — the request succeeds and the OLD script stays live. Read the harness
 * log after a Reload on that path.
 */
export function reloadVoiceScripts(deps: ReloadVoiceScriptsDeps): void {
  if (deps.voicePacks !== null) {
    deps.voicePacks.refresh();

    return;
  }

  deps.applyScripts(loadBundledVoiceScripts(deps.bundled));
}
