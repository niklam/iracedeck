import { type CalloutScript, qualifyClipPath } from "@iracedeck/callout-script";
import type { ILogger } from "@iracedeck/logger";
import { resolve } from "node:path";

import {
  type InstalledVoicePack,
  scanVoicePacks,
  type VoicePackFileSystem,
  type VoicePackProblem,
} from "./voice-pack-scanner.js";

export interface VoicePackServiceDeps {
  /** The packs directory — see {@link resolveVoicePacksPath}. */
  root: string;
  /**
   * The development voice root this build carries (#1143), scanned BEFORE
   * {@link root} so a staged pack shadows the same pack id in AppData — see
   * `devRoot` on `ScanVoicePacksOptions` for the rule and why `development`
   * provenance is decided by where a pack was found.
   *
   * `undefined` in every release build: the path comes from a gitignored file
   * the plugin's Rollup config bakes into `bin/config.json`. A path that does
   * not exist is NOT an error — it is warned about once and scanned as empty,
   * because a developer who has not staged a pack yet is the ordinary case and
   * everything else about the plugin must still work.
   *
   * Two shapes are reported rather than obeyed, both because their failure is
   * otherwise silent (#1143): a value resolving to {@link root} itself is
   * REFUSED (see `effectiveDevRoot` — scanning one directory twice makes every
   * row a development row and drops the whole packs folder out of the launch
   * ensure), and a root with folders in it that yields no listed development
   * pack is warned about on every scan, because the AppData copy then wins in
   * silence and looks exactly like an edit that did nothing.
   */
  devRoot?: string;
  fs: VoicePackFileSystem;
  logger: ILogger;
  /** The plugin's own `assets/audio` — the sfx tree, and the one unrestricted root. */
  pluginAudioDir: string;
  /**
   * Hand the ordered audio roots to the audio service.
   *
   * The plugin's own directory comes first and carries neither `clips` nor
   * `voices`, which means unrestricted. Every pack root carries the clip list
   * the scan admitted from it, so a pack can only serve the files it was
   * allowed to contribute — the scanner admits a pack's own voices by DROPPING
   * every other file from its list, not by removing them from disk, so a
   * resolver going on file presence alone would let a pack serve a clip under
   * any path simply by placing a file there. It also carries `voices`, the
   * composite-to-bare binding (#1144): the engine addresses this pack's voice
   * as `voice/<pack>::<voice>/…`, its files sit under `voice/<voice>/…`, and
   * the audio service resolves the former only in this root, as the latter.
   * Structurally typed rather than imported: `deck-core` must not depend on
   * `audio-service`.
   */
  applyRoots(
    roots: readonly { dir: string; clips?: readonly string[]; voices?: Readonly<Record<string, string>> }[],
  ): void;
  /**
   * Hand each pack's clip list to the scenario engine, as manifest fragments —
   * each clip rewritten to its logical path, `voice/<pack>::<voice>/…`
   * (#1144), so the manifest's voice list, the `{voice}` substitution and the
   * driver-name union all carry composite ids with no engine change, and two
   * packs' `matt` clips can never merge into one pool.
   */
  applyManifest(fragments: readonly (readonly string[])[]): void;
  /**
   * Hand every voice's callout script to the scenario engine (#1064),
   * composite voice id → parsed script, replacing whatever it held; a
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
   * an id that disagrees with its folder, a voice declared twice, or a
   * declared voice with no clips under it.
   *
   * Surfaced beside the installed list rather than left in the log (#1034): a
   * hand-placed pack that does nothing, with no visible reason, is the single
   * most likely support question this feature has. Note that a pack can appear
   * in BOTH lists — an otherwise-loadable pack that declares one empty voice is
   * installed and reports a problem.
   */
  problems(): readonly VoicePackProblem[];
  /**
   * Composite voice id → parsed script for the most recent APPLIED scan —
   * every installed voice that has one — and the very object `applyScripts`
   * was handed. Empty before the first refresh. Assigned together with
   * `installed()` and `problems()`, and only once every `apply*` call has
   * returned, so a consumer deciding whether the active voice has a script
   * (the #1064 banner) can never pair a pack list from this scan with a script
   * map from the last, and never reads a map the engine was not handed.
   */
  scripts(): ReadonlyMap<string, CalloutScript>;
  /**
   * Does the development root provide this pack? Takes a PACK id, not a voice
   * id — it answers about the thing an install targets.
   *
   * The launch step asks before installing a catalog pack (#1143): a pack the
   * developer has staged under the dev root must not be replaced by the copy
   * the catalog would fetch. It drops that one target rather than skipping the
   * whole ensure, so a second catalog pack still updates — which is what a
   * developer testing an update path wants to see. `false` before the first
   * refresh, and for every pack the packs root provides.
   *
   * "Provides" means the pack contributed at least one voice, not merely that
   * a folder was listed. The two conditions cannot come apart today — the
   * scanner lists no pack without a voice — so the voice count states what the
   * answer MEANS rather than guarding a live case: a pack that provides
   * nothing is not a reason to withhold the real one.
   */
  isProvidedByDevRoot(id: string): boolean;
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
  /** {@link VoicePackServiceDeps.devRoot} — the empty-root warning is once per run, see `refresh`. */
  let devRootWarned = false;
  /** The same, for the development root that IS the packs root — see {@link effectiveDevRoot}. */
  let devRootIsPacksRootWarned = false;

  /**
   * The development root this scan should actually use (#1143), or `undefined`.
   *
   * A `devRoot` that resolves to the packs folder itself is refused. Nothing
   * else rejects it, and the damage is quiet and total: every pack is scanned
   * twice, the second copy loses every voice to the first, so each row reads
   * `development`, loses its Remove button and drops out of the launch step's
   * ensure — `default` included, which stops being kept current. A developer
   * would read that as the dev root working.
   *
   * Compared lower-cased, unconditionally. The plugin ships Windows-only
   * (#994), where the filesystem is case-insensitive and `resolve` already
   * applies Windows semantics; the only thing lower-casing costs on a POSIX
   * dev machine is refusing a dev root that differs from the packs root by
   * case alone, which is the safe direction to be wrong in — ignoring a dev
   * root leaves the plugin fully working, while scanning one root twice does
   * not.
   */
  function effectiveDevRoot(): string | undefined {
    if (deps.devRoot === undefined) return undefined;

    if (resolve(deps.devRoot).toLowerCase() === resolve(deps.root).toLowerCase()) {
      // Once per run, like the empty-root warning below and for the same
      // reason: Rescan is the loop, and this is a build-time value that cannot
      // change between two presses.
      if (!devRootIsPacksRootWarned) {
        devRootIsPacksRootWarned = true;
        deps.logger.warn("Voice packs: the development root is the packs folder itself; ignoring it");
        deps.logger.debug(`Voice packs: development root ${deps.devRoot} resolves to the packs root ${deps.root}`);
      }

      return undefined;
    }

    return deps.devRoot;
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
        // A development root with nothing under it (#1143) — the path is gone,
        // or the developer has not staged a pack into it yet. Said ONCE per
        // run, not per scan: **Rescan voices** is the main loop of that
        // workflow, and a root that is still empty on the fifth press is not
        // five pieces of news. Missing and empty share one message because
        // `listDirectories` answers both with `[]` — the port has no existence
        // check by design — and because the remedy is the same either way.
        // Warn rather than error: the scan continues, the packs root is read as
        // normal, and the plugin is fully usable with an absent dev root.
        const devRoot = effectiveDevRoot();
        // Listed once and reused below: the same answer decides the empty-root
        // warning before the scan and, after it, which problems belong to the
        // development root.
        const devFolders = devRoot === undefined ? [] : deps.fs.listDirectories(devRoot);

        if (devRoot !== undefined && !devRootWarned && devFolders.length === 0) {
          devRootWarned = true;
          deps.logger.warn("Voice packs: the development root is missing or empty");
          deps.logger.debug(`Voice packs: development root ${devRoot} — run pack:voice --no-catalog to stage a pack`);
        }

        const { packs: scanned, problems: found } = scanVoicePacks({
          root: deps.root,
          ...(devRoot === undefined ? {} : { devRoot }),
          fs: deps.fs,
        });
        // Keyed by the composite id (#1144): two packs' scripts for the same
        // bare voice are two entries, as their voices are two voices.
        const next = new Map<string, CalloutScript>();

        for (const pack of scanned) {
          for (const voice of pack.voices) if (voice.script !== null) next.set(voice.id, voice.script);
        }

        // Roots BEFORE the manifest. The manifest is what tells the engine a clip
        // exists; a clip must never be advertised before there is a root that can
        // resolve it, or a callout firing in that window would resolve to the
        // fallback root and fail to play.
        //
        // The root keeps the pack's own clip spelling and binds each composite
        // id to the bare folder it names; the manifest fragment carries the
        // logical, qualified spelling the engine will ask for (#1144). The
        // binding is what joins the two back up at resolve time.
        deps.applyRoots([
          { dir: deps.pluginAudioDir },
          ...scanned.map((pack) => ({
            dir: pack.dir,
            clips: pack.clips,
            voices: Object.fromEntries(pack.voices.map((voice) => [voice.id, voice.packVoiceId])),
          })),
        ]);
        deps.applyManifest(scanned.map((pack) => pack.clips.map((clip) => qualifyClipPath(pack.id, clip))));
        // Scripts AFTER the manifest, for the reason roots come before it: a
        // script draws its pool clips from the manifest, so it must not be live
        // before the clips it names are advertised.
        deps.applyScripts(next);

        // One snapshot, taken only now: the three read-model views describe
        // the SAME scan, so a consumer reading the active voice off
        // `installed()` and its script off `scripts()` can never see one from
        // this scan and the other from the last — and they describe a scan
        // the engine has been HANDED. An `apply*` that throws above leaves all
        // three at the previous scan, the one the engine still runs on, rather
        // than reporting scripts it never received.
        packs = scanned;
        problems = found;
        scripts = next;

        deps.onPacksChanged();

        deps.logger.info("Voice packs scanned");
        deps.logger.debug(
          `Installed: ${scanned.map((pack) => `${pack.id}@${pack.version}`).join(", ") || "(none)"}; ` +
            `problems: ${found.map((problem) => `${problem.pack} (${problem.reason})`).join(", ") || "(none)"}; ` +
            `scripts: ${[...next.keys()].join(", ") || "(none)"}`,
        );

        // Warn per problem, not just in the debug summary: a sideloaded pack that
        // silently does nothing is the single most likely support question here,
        // and the reason is the answer to it.
        for (const problem of found) {
          deps.logger.warn(`Voice pack "${problem.pack}" ignored: ${problem.reason}`);
        }

        // The development root has folders in it and not one of them became a
        // pack (#1143) — a `callouts.json` that no longer parses after a
        // regeneration is the likely cause. The AppData copy then wins in
        // silence and the Installed Voices row flips back to Downloaded, which
        // is indistinguishable from the edit having had no effect. Every reason
        // is already a `problems` row, but a developer reading a settings
        // window looks at the row, not at the reasons underneath it.
        //
        // Deliberately NOT once-guarded, unlike the two warnings above: those
        // report a build-time value that cannot change between two presses,
        // while this reports what is on disk right now — and a Rescan is
        // precisely the moment the developer is looking.
        if (devRoot !== undefined && devFolders.length > 0 && !scanned.some((p) => p.provenance === "development")) {
          deps.logger.warn("Voice packs: the development root provides no usable pack");
          // Attributed by folder name, which is what a `problem.pack` is. A
          // packs-root folder of the same name could be caught by this too —
          // but only when the dev copy was NOT listed, which is exactly the
          // case being reported, so the extra line is about the same pack.
          const blamed = found.filter((problem) => devFolders.includes(problem.pack));
          deps.logger.debug(
            `Voice packs: development root ${devRoot} — ` +
              `${blamed.map((problem) => `${problem.pack} (${problem.reason})`).join(", ") || "(no reason recorded)"}`,
          );
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

    isProvidedByDevRoot(id) {
      // Read off the last scan rather than off `deps.devRoot`, so the answer is
      // about a pack that is actually THERE — a configured dev root the
      // developer emptied provides nothing, and the ensure must resume.
      return packs.some((pack) => pack.id === id && pack.provenance === "development" && pack.voices.length > 0);
    },
  };
}
