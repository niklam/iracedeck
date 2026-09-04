import { CALLOUT_SCRIPT_FILE, type CalloutScript } from "@iracedeck/callout-script";
import type { ILogger } from "@iracedeck/logger";

import {
  type InstalledVoicePack,
  readVoiceScript,
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
   * Hand every voice's callout script to the scenario engine (#1064), voice id
   * → parsed script, replacing whatever it held. The bundled voices first, read
   * from `pluginAudioDir`, then each installed voice that has one; a
   * clips-only voice is simply absent. Called AFTER `applyManifest` — a script
   * draws its pool clips from what the manifest advertises, so a script must
   * never be live before its clips are, or a callout firing in that window
   * would find empty pools — and BEFORE `onPacksChanged`, so the read model
   * never describes scripts the engine has not been handed.
   */
  applyScripts(scripts: ReadonlyMap<string, CalloutScript>): void;
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
  /**
   * Voice id → parsed script for the most recent scan — bundled voices first,
   * then installed voices with one — and the very object `applyScripts` was
   * handed. Empty before the first refresh. Assigned together with
   * `installed()` and `problems()`, so a consumer deciding whether the active
   * voice has a script (the #1064 banner) can never pair a pack list from this
   * scan with a script map from the last.
   */
  scripts(): ReadonlyMap<string, CalloutScript>;
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
  let scripts: ReadonlyMap<string, CalloutScript> = new Map();

  /**
   * Every bundled voice's script, read from the plugin's own audio root through
   * the SAME reader the scanner runs over a pack (#1064) — so that when #1034
   * stage 3 drops the bundle, only the roots list changes.
   *
   * A bundled voice is the one case where "no script" is not a clips-only
   * voice but a bug: the build copies the artifact beside the clips, and a
   * missing or malformed one means the plugin shipped wrong, not that a pack
   * author chose silence. It is said at `warn`, once per voice per refresh,
   * naming the voice and the reason — and the voice is simply absent from the
   * map, which the engine treats as every callout skipped. Never a throw: the
   * refresh runs where a throw ends the process.
   */
  function readBundledScripts(): Map<string, CalloutScript> {
    const bundled = new Map<string, CalloutScript>();

    for (const id of deps.reservedVoices) {
      const read = readVoiceScript(deps.fs, deps.pluginAudioDir, id);

      if (read.ok && read.script !== null) {
        bundled.set(id, read.script);
        continue;
      }

      const reason = read.ok ? `it has no ${CALLOUT_SCRIPT_FILE} — every callout is skipped` : read.reason;

      deps.logger.warn(`Bundled voice "${id}" has no usable script: ${reason}`);
    }

    return bundled;
  }

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
        // Bundled first, then installed. The two sets cannot overlap — the
        // scanner refuses a pack's claim on a reserved id — so the order is a
        // reading order rather than a precedence rule.
        const next = readBundledScripts();

        for (const pack of scanned) {
          for (const voice of pack.voices) if (voice.script !== null) next.set(voice.id, voice.script);
        }

        // One snapshot: the three read-model views describe the SAME scan, so
        // a consumer reading the active voice off `installed()` and its script
        // off `scripts()` can never see one from this scan and the other from
        // the last. A scan that throws above keeps all three.
        packs = scanned;
        problems = found;
        scripts = next;

        // Roots BEFORE the manifest. The manifest is what tells the engine a clip
        // exists; a clip must never be advertised before there is a root that can
        // resolve it, or a callout firing in that window would resolve to the
        // fallback root and fail to play.
        deps.applyRoots([
          { dir: deps.pluginAudioDir },
          ...scanned.map((pack) => ({ dir: pack.dir, clips: pack.clips })),
        ]);
        deps.applyManifest(scanned.map((pack) => pack.clips));
        // Scripts AFTER the manifest, for the reason roots come before it: a
        // script draws its pool clips from the manifest, so it must not be live
        // before the clips it names are advertised.
        deps.applyScripts(next);
        deps.onPacksChanged();

        deps.logger.info("Voice packs scanned");
        deps.logger.debug(
          `Installed: ${scanned.map((pack) => `${pack.id}@${pack.version}`).join(", ") || "(none)"}; ` +
            `problems: ${problems.map((problem) => `${problem.pack} (${problem.reason})`).join(", ") || "(none)"}; ` +
            `scripts: ${[...next.keys()].join(", ") || "(none)"}`,
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

    scripts() {
      return scripts;
    },
  };
}
