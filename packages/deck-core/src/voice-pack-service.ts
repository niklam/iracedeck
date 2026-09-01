import type { ILogger } from "@iracedeck/logger";

import {
  type InstalledVoicePack,
  scanVoicePacks,
  type VoicePackFileSystem,
  type VoicePackProblem,
} from "./voice-pack-scanner.js";

export interface VoicePackServiceDeps {
  /** The packs directory — see {@link resolveVoicePacksPath}. */
  root: string;
  fs: VoicePackFileSystem;
  logger: ILogger;
  /** The plugin's own `assets/audio` — always the first, highest-precedence root. */
  pluginAudioDir: string;
  /**
   * Voice ids the plugin's own bundled audio provides; a pack may not claim
   * one. See `reservedVoices` on `ScanVoicePacksOptions` for why.
   */
  reservedVoices: readonly string[];
  /**
   * Hand the ordered audio roots to the audio service.
   *
   * The plugin's own directory comes first and carries no `clips`, which means
   * unrestricted. Every pack root carries the clip list the scan admitted from
   * it, so a pack can only serve the files it was allowed to contribute — the
   * scanner enforces its collision rules by DROPPING files, not by removing
   * them from disk, so a resolver going on file presence alone would let a pack
   * serve another pack's voice, or a bundled clip the plugin does not ship,
   * simply by placing a file at the right relative path. Structurally typed
   * rather than imported: `deck-core` must not depend on `audio-service`.
   */
  applyRoots(roots: readonly { dir: string; clips?: readonly string[] }[]): void;
  /** Hand each pack's clip list to the scenario engine, as manifest fragments. */
  applyManifest(fragments: readonly (readonly string[])[]): void;
  /**
   * The scan finished and this service's read model changed. Carries nothing on
   * purpose: the plugin also republishes on Property Inspector appearance, when
   * there is no event to hand it, so both paths read {@link
   * VoicePackService.installed} and {@link VoicePackService.problems} and there
   * is only one way to build the payload.
   */
  onPacksChanged(): void;
}

export interface VoicePackService {
  /** Re-scan the packs directory and apply the result. Returns the installed packs. */
  refresh(): readonly InstalledVoicePack[];
  /** The most recent scan result. */
  installed(): readonly InstalledVoicePack[];
  /**
   * Why the most recent scan ignored what it ignored — a pack with no manifest,
   * an id that disagrees with its folder, a voice another pack or the bundle
   * already provides, or a declared voice with no clips under it.
   *
   * Surfaced beside the installed list rather than left in the log (#1034): a
   * hand-placed pack that does nothing, with no visible reason, is the single
   * most likely support question this feature has. Note that a pack can appear
   * in BOTH lists — an otherwise-loadable pack that declares one empty voice is
   * installed and reports a problem.
   */
  problems(): readonly VoicePackProblem[];
}

/**
 * Composition root for installed voice packs (issue #1034).
 *
 * `deck-core` must not import `audio-service` or `audio-scenarios`, so applying
 * a scan is expressed as injected callbacks rather than direct calls. That also
 * makes the ordering rule below an explicit, testable property of this module
 * instead of something implicit in each plugin's startup sequence.
 */
export function createVoicePackService(deps: VoicePackServiceDeps): VoicePackService {
  let packs: readonly InstalledVoicePack[] = [];
  let problems: readonly VoicePackProblem[] = [];

  return {
    // Never throws. This runs on two paths that both END THE PLUGIN PROCESS if
    // it does: module-scope startup, and the settings window's `sendToPlugin`
    // frame, whose `ws.on("message")` listener has no try/catch around the
    // command handler. It is also the widest of the window commands — a scan
    // reloads the engine manifest and writes global settings, which fans out
    // synchronously to every `onGlobalSettingsChange` subscriber in the plugin.
    refresh() {
      try {
        const { packs: scanned, problems: found } = scanVoicePacks({
          root: deps.root,
          fs: deps.fs,
          reservedVoices: deps.reservedVoices,
        });
        packs = scanned;
        problems = found;

        // Roots BEFORE the manifest. The manifest is what tells the engine a clip
        // exists; a clip must never be advertised before there is a root that can
        // resolve it, or a callout firing in that window would resolve to the
        // fallback root and fail to play.
        deps.applyRoots([
          { dir: deps.pluginAudioDir },
          ...scanned.map((pack) => ({ dir: pack.dir, clips: pack.clips })),
        ]);
        deps.applyManifest(scanned.map((pack) => pack.clips));
        deps.onPacksChanged();

        deps.logger.info("Voice packs scanned");
        deps.logger.debug(
          `Installed: ${scanned.map((pack) => `${pack.id}@${pack.version}`).join(", ") || "(none)"}; ` +
            `problems: ${problems.map((problem) => `${problem.pack} (${problem.reason})`).join(", ") || "(none)"}`,
        );

        // Warn per problem, not just in the debug summary: a sideloaded pack that
        // silently does nothing is the single most likely support question here,
        // and the reason is the answer to it.
        for (const problem of problems) {
          deps.logger.warn(`Voice pack "${problem.pack}" ignored: ${problem.reason}`);
        }

        return scanned;
      } catch (err) {
        deps.logger.error(`Voice pack scan failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);

        return packs;
      }
    },

    installed() {
      return packs;
    },

    problems() {
      return problems;
    },
  };
}
