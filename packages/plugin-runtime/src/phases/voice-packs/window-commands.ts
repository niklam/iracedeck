/**
 * Phase 5, step 5 (#1377): the settings window's voice-pack commands — Rescan,
 * Install, Remove and Open folder — over the service, the launch step, the
 * installer, the logger and the packs folder the scan named.
 */
import type { ILogger } from "@iracedeck/logger";
import { openDirectoryInExplorer } from "@iracedeck/settings-window";
import {
  isManagedVoicePack,
  type VoicePackInstaller,
  type VoicePackLaunchStep,
  type VoicePackService,
} from "@iracedeck/voice-packs";

import type { VoicePacks } from "../../types.js";

/** What the window commands call: each collaborator narrowed to the members they use. */
export interface VoicePackWindowCommandDeps {
  readonly service: Pick<VoicePackService, "refresh">;
  readonly launch: Pick<VoicePackLaunchStep, "poke">;
  readonly installer: Pick<VoicePackInstaller, "install" | "remove">;
  readonly logger: ILogger;
  /** The packs folder the scan reads (`VoicePackScan.voicePacksRoot`). */
  readonly voicePacksRoot: string;
}

export function buildVoicePackWindowCommands({
  service,
  launch: voicePackLaunch,
  installer: voicePackInstaller,
  logger: voicePacksLogger,
  voicePacksRoot,
}: VoicePackWindowCommandDeps): VoicePacks["windowCommands"] {
  return {
    // Race Engineer card's Rescan voices button (#1034). Like Open folder, the
    // page names no directory — which one is scanned is the plugin's decision.
    // Since #1100 a rescan re-asks the catalog too, so the card's Install /
    // Update / Installed verdicts follow a pack the user added or deleted by
    // hand. Since stage 3 that re-ask is the launch step's rather than a
    // `refreshCatalog` call of this handler's own, so one press cannot ask
    // twice. It stays conditional on the cached ETag, so an unchanged catalog
    // costs a 304 and no body.
    refreshVoicePacks: () => {
      service.refresh();
      // The launch step re-asks the catalog (bypassing the TTLs, as before) and
      // installs or updates whatever it is responsible for — a Rescan after a
      // fixed connection is exactly the retry a user is asking for (#1034 stage 3).
      voicePackLaunch.poke();
    },
    // Install / Remove by pack id (#1100). The handler has validated the id
    // against the manifest's kebab-case rule before it gets here; everything
    // else — the catalog it is looked up in, the URL, the destination — is the
    // plugin's. Neither ever rejects. An install's outcome reaches the card as
    // `_voicePackStatus` — every refusal included, so a press that does
    // nothing is explained on the row it was pressed on; a removal's reaches
    // it as a `_warnings` banner (see `warnings` on the installer, in
    // `installer.ts`). The results are therefore not read here: the installer
    // has already put each one where the user can see it and logged it.
    installVoicePack: (id) => {
      void voicePackInstaller.install(id);
    },
    removeVoicePack: (id) => {
      // The page never offers Remove for the managed pack; the refusal here is
      // the second lock on the same door — a removed `default` would only be
      // reinstalled at the next launch (#1034 stage 3).
      if (isManagedVoicePack(id)) {
        voicePacksLogger.warn(`Refused to remove the managed voice pack "${id}"`);

        return;
      }

      void voicePackInstaller.remove(id);
    },
    // Same rule again for the Voices card's Open folder button (#1100). A
    // DIRECTORY opener, not the file-revealing one the Storage card uses:
    // `/select` would show the packs folder's parent with `Voices` merely
    // highlighted, one level above where the text beside the button says to
    // drop a pack.
    openDirectory: openDirectoryInExplorer,
    voicePacksPath: voicePacksRoot,
  };
}
