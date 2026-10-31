/**
 * Phase 5, step 3 (#1377): the download side — storage, the catalog service and
 * the installer, built over the scan's root, scanner port, service and state,
 * and the seedable packs the phase computed. Returns the installer, the one
 * product the rest of the phase and the later phases use.
 */
import { VOICE_PACK_DEV_BASE_URL_KEY, VOICE_PACK_STATUS_KEY } from "@iracedeck/app-constants";
import { getPluginVersion } from "@iracedeck/deck-core";
import { clearWarning, getGlobalSettings, setWarning, updateGlobalSettings } from "@iracedeck/settings";
import {
  type BundledVoicePack,
  createVoicePackArchiveFileSystem,
  createVoicePackCatalogService,
  createVoicePackInstaller,
  createVoicePackInstallerFileSystem,
  createVoicePackStorage,
  createVoicePackStorageFileSystem,
  readInstalledVoicePackSha,
  type VoicePackInstaller,
  type VoicePackService,
} from "@iracedeck/voice-packs";

import { stopRaceEngineerPlayback } from "../../actions.js";
import type { Core, VoicePackState } from "../../types.js";
import type { VoicePackScan } from "./scan.js";

/** What the installer step reads from the scan: the root, the port, the logger, the status marker, and two service calls. */
export type InstallerScanView = Pick<VoicePackScan, "logger" | "voicePacksRoot" | "fs"> & {
  readonly state: Pick<VoicePackState, "lastPublished">;
  readonly service: Pick<VoicePackService, "isProvidedByDevRoot" | "refresh">;
};

export function buildVoicePackInstaller(
  core: Pick<Core, "adapter">,
  scan: InstallerScanView,
  bundled: readonly BundledVoicePack[],
): VoicePackInstaller {
  const { state, logger: voicePacksLogger, voicePacksRoot, fs: voicePackFs, service } = scan;

  // Downloadable voice packs (#1100). The pipeline itself — decide, lock,
  // download while hashing, verify, extract, validate, stop playback, swap,
  // refresh — lives in voice-packs (`createVoicePackInstaller`); this is its
  // composition root, and everything platform-shaped is injected here in the
  // shape the scan step's `service` established. Every disk port is rooted at
  // the SAME `voicePacksRoot` the scanner reads and the settings window reveals.
  const voicePackStorage = createVoicePackStorage({
    root: voicePacksRoot,
    fs: createVoicePackStorageFileSystem(voicePacksLogger),
    logger: voicePacksLogger,
  });

  const voicePackCatalog = createVoicePackCatalogService({
    // Constant TRUE, and settled that way for stage 3 as well (Niklas,
    // 2026-09-06): no setting gates the catalog. Since stage 3 the plugin asks
    // it at launch, unprompted — the bundled voice is gone, so a fresh install
    // has no engineer until `default` is fetched — and the domain is
    // iracedeck.com, which the update check already talks to. A switch can be
    // added the day a user asks for one; do not add one by default.
    isEnabled: () => true,
    getPluginVersion,
    // ONE implementation of "which digest is installed?", shared with the
    // installer's own decision. This verdict is what puts Install / Update /
    // Installed on the card, and the installer's copy of the same read decides
    // whether pressing it downloads anything; two implementations would
    // eventually disagree silently.
    getInstalledSha: (id) => readInstalledVoicePackSha(voicePackFs, voicePackStorage.packDir(id), id),
    // A pack the development root provides reads as installed (#1143), the way a
    // bundled one does: the scanner shadows the packs-root copy whole, so an
    // Install here would download megabytes the next scan ignores while the
    // staged pack goes on playing. Read live off the last scan, so emptying the
    // dev root and pressing Rescan brings the offer back.
    isProvidedByDevRoot: (id) => service.isProvidedByDevRoot(id),
    // The development override (#1100), read fresh on every fetch rather than
    // captured at construction, so there is no second copy of the value to go
    // stale. That is a SHAPE, not a live reload: the settings file is read once
    // at startup (`store.load()`, one call, no watcher) and no page writes this
    // key, so a hand edit needs a plugin restart before anything sees it. Which
    // is also precisely what lets the once-per-start warning in the settings
    // phase be trusted for the whole run. Absent on every ordinary installation,
    // and when absent the URL is byte-identical to the published constant. The
    // value is validated where it is used, never in the schema — a malformed one
    // must cost this feature alone rather than stalling the whole settings parse.
    getDevBaseUrl: () => {
      const raw = (getGlobalSettings() as Record<string, unknown>)[VOICE_PACK_DEV_BASE_URL_KEY];

      return typeof raw === "string" ? raw : undefined;
    },
    logger: core.adapter.createLogger("VoicePackCatalog"),
  });

  return createVoicePackInstaller({
    storage: voicePackStorage,
    packFs: voicePackFs,
    archiveFs: createVoicePackArchiveFileSystem(voicePacksLogger),
    fs: createVoicePackInstallerFileSystem(voicePacksLogger),
    catalog: voicePackCatalog,
    bundled,
    getPluginVersion,
    // Called immediately before a swap or a removal, and only then: on Windows a
    // directory with an open file inside cannot be renamed, and a callout may be
    // holding one of the pack's clips open. Two layers, because a voice reaches
    // the Voice channel by two routes. The scenario engine — a callout
    // mid-sequence, whose pause timer would otherwise play its NEXT clip straight
    // into the swap, plus its looping ambient bed — is stopped through the same
    // call the Race Engineer master gate uses. The audio service's own channel
    // stop then covers anything on the Voice channel that never went through the
    // engine: the settings window's voice Test plays clip by clip via
    // `playOnChannel`, and `stopChannel` also cancels a native voice sequence.
    // One call: stopping the engineer is three coupled facts about audio state,
    // and it lives with that state rather than being restated in three plugins.
    stopPlayback: stopRaceEngineerPlayback,
    // `_voicePackStatus` is run-scoped (#1014). Deduped by content like the
    // scan step's sibling pushes, so the re-assertion on every Property Inspector
    // appearance costs a write only when the payload actually moved — the cache
    // holds the last published value for the whole run either way.
    publishStatus: (status) => {
      const json = JSON.stringify(status);

      if (json === state.lastPublished.status) return;

      state.lastPublished.status = json;
      updateGlobalSettings({ [VOICE_PACK_STATUS_KEY]: json });
    },
    // Where a Remove's outcome goes: the `_warnings` banner, keyed per pack.
    // The Installed Voices list renders `_voicePacks` and nothing else, so a
    // removal that fails has no row to report on — the banner is the surface
    // the same page already renders, and needs no new key.
    warnings: { set: setWarning, clear: clearWarning },
    refreshPacks: () => service.refresh(),
    logger: voicePacksLogger,
  });
}
