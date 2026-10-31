/**
 * Phase 5 (#1349, #1104): the voice-pack block, as five steps under
 * `voice-packs/` (#1377), each handing the next what it built:
 *
 * 1. `buildVoicePackScan` — the mutable state, the logger and roots, the
 *    scanner port, the service, the run-scoped pushes and the
 *    missing-callout-script banner. The state is created before the service
 *    that calls back into it, so the old module scope's temporal-dead-zone
 *    hazard is gone by construction. Then the startup scan, here.
 * 2. `seedableBundledPacks` — which compiled-in catalog entries can be seeded.
 * 3. `buildVoicePackInstaller` — storage, catalog and installer.
 * 4. `buildVoicePackLaunch` — the launch step `startServices` starts.
 * 5. `buildVoicePackWindowCommands` — the settings window's voice-pack commands.
 */
// The bundled slice, not the authored manifest: this describes only what THIS
// plugin ships. `manifest.json` names every authored voice and is for tests,
// generators, and the harness (#1034 stage 3).
import audioAssetsManifest from "@iracedeck/audio-assets/manifest.bundled.json" with { type: "json" };
import { scanRaceEngineerVoices } from "@iracedeck/audio-scenarios";

import type { Audio, Core, VoicePacks } from "../types.js";
import { buildVoicePackInstaller } from "./voice-packs/installer.js";
import { buildVoicePackLaunch } from "./voice-packs/launch.js";
import { buildVoicePackScan } from "./voice-packs/scan.js";
import { COMPILED_IN_VOICE_PACK_ENTRIES, seedableBundledPacks } from "./voice-packs/seed.js";
import { buildVoicePackWindowCommands } from "./voice-packs/window-commands.js";

export function initVoicePacks(core: Core, audio: Audio): VoicePacks {
  const scan = buildVoicePackScan(core, audio);

  // The startup scan. It runs before the scenario engine and before
  // `initGlobalSettings`, so it only fills `state` — the Race Engineer phase
  // hands the engine its manifest and scripts — and publishes nothing: the
  // post-init call sites push it (see `onPacksChanged` in the scan step).
  scan.service.refresh();

  const bundled = seedableBundledPacks({
    entries: COMPILED_IN_VOICE_PACK_ENTRIES,
    // The voices the plugin itself bundles — fixed for the process, since they
    // come from the compiled-in manifest. Read by the seed and nothing else.
    bundledVoices: scanRaceEngineerVoices(audioAssetsManifest),
    audioDir: audio.rootDir,
    logger: scan.logger,
  });
  const installer = buildVoicePackInstaller(core, scan, bundled);
  const launch = buildVoicePackLaunch(scan, installer);
  const windowCommands = buildVoicePackWindowCommands({
    service: scan.service,
    launch,
    installer,
    logger: scan.logger,
    voicePacksRoot: scan.voicePacksRoot,
  });

  return {
    state: scan.state,
    logger: scan.logger,
    service: scan.service,
    installer,
    launch,
    push: scan.push,
    reassertVoiceScriptWarning: scan.reassertVoiceScriptWarning,
    windowCommands,
    // Every route that puts the settings window on screen goes through here and
    // asks the voice catalog on the way (#1100). The Race Engineer card answers
    // "what could I download?" from `_voicePackStatus`, and this is the moment
    // that answer is wanted — a user-initiated fetch beside the launch step's own
    // unprompted one (see the catalog's `isEnabled` in `voice-packs/installer.ts`
    // for why that gate is a constant even so, since #1034 stage 3). The service
    // caches the fetch for an hour, so reopening the window is not a second
    // request; the verdicts are recomputed either way. Fire-and-forget on
    // purpose: `refreshCatalog` never rejects, and the window must not wait on
    // the network to open.
    refreshCatalog: () => {
      void installer.refreshCatalog();
    },
  };
}
