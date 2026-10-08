/**
 * Phase 5 (#1349, #1104): the voice-pack block — scanner, storage, catalog,
 * installer, launch step, the run-scoped pushes and the settings window's
 * voice-pack commands. Its mutable state is created before the service that
 * calls back into it, so the old module scope's temporal-dead-zone hazard is
 * gone by construction.
 */
import {
  VOICE_LABELS_KEY,
  VOICE_PACK_DEV_BASE_URL_KEY,
  VOICE_PACK_STATUS_KEY,
  VOICE_PACKS_KEY,
} from "@iracedeck/app-constants";
import defaultVoicePackCatalogEntry from "@iracedeck/audio-assets/catalog/default.json" with { type: "json" };
// The bundled slice, not the authored manifest: this describes only what THIS
// plugin ships. `manifest.json` names every authored voice and is for tests,
// generators, and the harness (#1034 stage 3).
import audioAssetsManifest from "@iracedeck/audio-assets/manifest.bundled.json" with { type: "json" };
import {
  getScenarioEngine,
  isAudioScenariosInitialized,
  mergeManifests,
  scanDriverNames,
  scanRaceEngineerVoices,
} from "@iracedeck/audio-scenarios";
import { getAudio } from "@iracedeck/audio-service";
import { getDevVoicePacksRoot, getPluginVersion, openDirectoryInExplorer } from "@iracedeck/deck-core";
import {
  clearWarning,
  getGlobalSettings,
  isGlobalSettingsInitialized,
  migrateRaceEngineerVoiceId,
  onGlobalSettingsChange,
  resolveActiveRaceEngineerVoice,
  setWarning,
  updateGlobalSettings,
  whenSettingsStoreSettled,
} from "@iracedeck/settings";
import {
  type BundledVoicePack,
  createVoicePackArchiveFileSystem,
  createVoicePackCatalogService,
  createVoicePackFileSystem,
  createVoicePackInstaller,
  createVoicePackInstallerFileSystem,
  createVoicePackLaunchStep,
  createVoicePackService,
  createVoicePackStorage,
  createVoicePackStorageFileSystem,
  createVoiceScriptWarningReporter,
  isManagedVoicePack,
  orderRaceEngineerVoices,
  readInstalledVoicePackSha,
  resolveVoicePacksPath,
  voiceDisplayLabels,
  VoicePackCatalogEntrySchema,
} from "@iracedeck/voice-packs";

import { stopRaceEngineerPlayback } from "../actions.js";
import type { Audio, Core, VoicePacks, VoicePackState } from "../types.js";

export function initVoicePacks(core: Core, audio: Audio): VoicePacks {
  // The available Race Engineer voices and driver-name keys, derived from the
  // ACTIVE manifest. Installed voice packs (issue #1034) make that manifest
  // dynamic: the compiled-in one is the built-in half — sfx plus any bundled
  // voice — and each installed pack contributes its own audio root and its own
  // clips on top, its voices under their composite `<pack>::<voice>` ids
  // (#1144), so two packs that both ship a `matt` list two voices. Rescanned on
  // demand, so a hand-placed pack needs a button press in Settings rather than
  // a restart.
  //
  // Every voice's callout script, composite voice id → parsed script (#1064,
  // #1144): what the voice-pack service hands over on each scan, held here for
  // the same reason `activeManifest` lives on `state` — the startup scan runs
  // BEFORE the scenario engine exists. The engine takes this map right after
  // `registerPitCrew` in the Race Engineer phase; every later rescan hands its
  // map to the engine directly from `applyScripts`.
  //
  // Everything a scan or a push mutates, created before the service that calls
  // back into it — so no callback can reach an uninitialised binding (the
  // temporal-dead-zone hazard of the old module scope, #1349).
  const state: VoicePackState = {
    activeManifest: audioAssetsManifest,
    raceEngineerVoices: scanRaceEngineerVoices(audioAssetsManifest),
    driverNames: scanDriverNames(audioAssetsManifest),
    activeScripts: new Map(),
    lastPublished: { voiceList: "", voiceLabels: "", driverNames: "", packList: "", status: "" },
  };

  // The voices the plugin itself bundles — fixed for the process, since they come
  // from the compiled-in manifest. Read by the seed below and nothing else.
  const bundledVoices = scanRaceEngineerVoices(audioAssetsManifest);

  // The missing-callout-script banner (#1064). State-driven, so it is re-asserted
  // wherever either input can change: after every voice-pack scan
  // (`onPacksChanged` below) and on every settings arrival, since the active
  // voice is a setting (`reassertVoiceScriptWarning`, further down). `_warnings`
  // is run-scoped (#1014) and asks exactly that of every producer.
  const reportVoiceScriptWarning = createVoiceScriptWarningReporter({ set: setWarning, clear: clearWarning });

  const voicePacksLogger = core.adapter.createLogger("VoicePacks");
  // Named once: the scanner reads this directory and the settings window's
  // "Open folder" button reveals it, and those must be the same place. The page
  // supplies no path for either (#1100).
  const voicePacksRoot = resolveVoicePacksPath({ env: process.env });
  // A development build carries a second root (#1143): the packer's staged
  // output, scanned ahead of the AppData folder and never installed over.
  const devVoicePacksRoot = getDevVoicePacksRoot();
  // One scanner port for the scan AND the installer (#1100): the installer reads
  // `.install.json`, a staged manifest and the bundled clip tree through it.
  const voicePackFs = createVoicePackFileSystem(voicePacksLogger);

  // The run-scoped pushes and the banner re-assertion. They read `service`,
  // declared below, and that is safe: every call path into them goes through
  // the service (its `onPacksChanged`) or through a later phase, and the
  // service exists before it can call back.

  // Push the Race Engineer voices + names lists to global settings. Both
  // payloads are derived from the ACTIVE manifest, which changes whenever voice
  // packs are rescanned (issue #1034), so each list is stringified per call
  // rather than once at module scope. Re-pushed on every PI appear too (cheap;
  // deduped below) so a PI opened before the first global-settings echo still
  // gets populated.

  // The voice LIST and the voice LABELS go out in one write, always. The list is
  // what exists — derived from the merged manifest's clip paths, and what
  // `resolveActiveRaceEngineerVoice` consumes; the labels are what a pack chose to
  // call those voices, and nothing resolves or persists them. Publishing them
  // together is what stops a dropdown ever pairing one scan's voices with another
  // scan's names.
  function pushRaceEngineerVoicesIfChanged(): void {
    // Already ordered where each scan lands (`onPacksChanged`, #999), so the
    // dropdown — which renders the list in the order it arrives — shows the very
    // order the engine resolves its fallback against.
    const json = JSON.stringify(state.raceEngineerVoices);
    const labelsJson = JSON.stringify(voiceLabels());

    if (json === state.lastPublished.voiceList && labelsJson === state.lastPublished.voiceLabels) return;

    state.lastPublished.voiceList = json;
    state.lastPublished.voiceLabels = labelsJson;
    updateGlobalSettings({ _raceEngineerVoices: json, [VOICE_LABELS_KEY]: labelsJson });
  }

  /**
   * Composite voice id -> what the dropdown should call it (#1144). The rule
   * lives in voice-packs (`voiceDisplayLabels`) so all three plugins share one
   * implementation and it is tested once. Only voices a pack provides appear;
   * any other voice has no manifest to name it, and the dropdown falls back to
   * its title-cased voice id.
   */
  function voiceLabels(): Record<string, string> {
    return voiceDisplayLabels(service.installed());
  }

  function pushDriverNamesIfChanged(): void {
    const json = JSON.stringify(state.driverNames);

    if (json === state.lastPublished.driverNames) return;

    state.lastPublished.driverNames = json;
    updateGlobalSettings({ _driverNames: json });
  }

  // One payload for the whole scan result, installed packs AND the reasons the
  // rest were ignored (#1034). A hand-placed pack that silently does nothing is
  // this feature's most likely support question, and the reason is the answer —
  // so it belongs beside the list rather than only in the plugin log. Both halves
  // travel in one key so they can never be published out of step, and a scan
  // stays one global-settings write.
  function pushVoicePackListIfChanged(): void {
    const json = JSON.stringify({
      packs: service.installed().map((pack) => ({
        id: pack.id,
        label: pack.label,
        version: pack.version,
        // Id and label only (#1064): a voice also carries its parsed callout
        // script, which is the engine's input rather than anything a list row
        // renders — and it would ride this run-scoped key into every Property
        // Inspector on every push.
        voices: pack.voices.map(({ id, label }) => ({ id, label })),
        // Only on a development row (#1143), which is the only row that renders
        // it — the same rule the `voices` comment above states, for the same
        // reason: this key rides a run-scoped global into every Property
        // Inspector and the deck-host mirror on every push, so an absolute path
        // nothing displays is payload with no reader.
        ...(pack.provenance === "development" ? { dir: pack.dir } : {}),
        // Where it came from, for the settings window's provenance badge
        // (#1100). Since #999 provenance also decides first-party labelling and
        // order (`isFirstPartyVoicePack`); it withholds no control — the managed
        // pack's Remove button keys off `managed` below, never provenance.
        provenance: pack.provenance,
        // The managed pack is the one the launch step keeps current — which it does
        // not while the development root provides it, so the row must not claim so.
        managed: isManagedVoicePack(pack.id) && pack.provenance !== "development",
      })),
      problems: service.problems().map((problem) => ({ pack: problem.pack, reason: problem.reason })),
    });

    if (json === state.lastPublished.packList) return;

    state.lastPublished.packList = json;
    updateGlobalSettings({ [VOICE_PACKS_KEY]: json });
  }

  /**
   * Re-evaluate the missing-callout-script banner (#1064) against the voice the
   * engineer would speak with right now and the voices the last scan found a
   * script for. Cheap and idempotent — `setWarning` / `clearWarning` skip the
   * write when nothing changed — so it runs on every settings arrival and every
   * scan rather than trying to detect a change of either input.
   */
  function reassertVoiceScriptWarning(): void {
    reportVoiceScriptWarning({
      activeVoice: resolveActiveRaceEngineerVoice(state.raceEngineerVoices),
      scriptedVoices: new Set(service.scripts().keys()),
      // The banner names the voice as the dropdown does, never by its composite id.
      labels: voiceLabels(),
    });
  }

  const service = createVoicePackService({
    root: voicePacksRoot,
    ...(devVoicePacksRoot === undefined ? {} : { devRoot: devVoicePacksRoot }),
    fs: voicePackFs,
    logger: voicePacksLogger,
    pluginAudioDir: audio.rootDir,
    applyRoots: (roots) => getAudio().setRoots(roots),
    applyManifest: (fragments) => {
      state.activeManifest = mergeManifests(audioAssetsManifest, fragments);
      state.raceEngineerVoices = scanRaceEngineerVoices(state.activeManifest);
      state.driverNames = scanDriverNames(state.activeManifest);

      // Guarded because the first scan runs BEFORE the engine is constructed, so
      // startup needs no reload — every later refresh does.
      if (isAudioScenariosInitialized()) getScenarioEngine().setManifest(state.activeManifest);
    },
    applyScripts: (scripts) => {
      state.activeScripts = scripts;

      // Guarded like `applyManifest`: the startup scan precedes the engine, which
      // takes `activeScripts` after `registerPitCrew`; every rescan reloads here.
      if (isAudioScenariosInitialized()) getScenarioEngine().setScripts(scripts);
    },
    onPacksChanged: () => {
      // Order the voice list ONCE, here, so the engine's fallback
      // (`resolveActiveRaceEngineerVoice`), the published `_raceEngineerVoices`
      // and every action reading it share one order (#999): iRaceDeck's own
      // voices first, the managed pack at the top. Not in `applyManifest`: there
      // `service.installed()` still answers for the PREVIOUS scan — the
      // service snapshots a scan only after every `apply*` has returned — so this
      // is the first point where the new voices and their packs' provenance and
      // labels are both readable. Ahead of the settings guard below, so the
      // startup scan is ordered too.
      state.raceEngineerVoices = orderRaceEngineerVoices(state.raceEngineerVoices, service.installed(), voiceLabels());

      // The first scan runs long before `initGlobalSettings`, and a write made
      // then would set the dedupe markers while reaching nothing — which would
      // suppress the real push forever. The post-init call sites publish the
      // startup scan; every later refresh publishes itself. (The markers live on
      // `state`, created before this service, so reaching them early would be a
      // wasted write, never a temporal-dead-zone error — #1349.)
      if (!isGlobalSettingsInitialized()) return;

      pushRaceEngineerVoicesIfChanged();
      pushDriverNamesIfChanged();
      pushVoicePackListIfChanged();
      // Before the banner, so it evaluates the qualified value: a scan can bring
      // the pack a stored bare voice id belongs to (#1144).
      migrateRaceEngineerVoiceId(state.raceEngineerVoices, voicePacksLogger);
      reassertVoiceScriptWarning();
    },
  });

  service.refresh();

  // Downloadable voice packs (#1100). The pipeline itself — decide, lock,
  // download while hashing, verify, extract, validate, stop playback, swap,
  // refresh — lives in voice-packs (`createVoicePackInstaller`); this is its
  // composition root, and everything platform-shaped is injected here in the
  // shape `service` above established. Every disk port is rooted at the SAME
  // `voicePacksRoot` the scanner reads and the settings window reveals.
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

  // The catalog entries compiled into this build, so a pack the plugin still
  // ships can be SEEDED — copied into an empty packs folder with the catalog's
  // own `sha256` as its provenance, which is what makes the first catalog check
  // after a seed answer "installed" rather than re-download what was just
  // copied. Since 3.3.0 no plugin ships a voice, so this is inert: the loop
  // below matches nothing and the plugin fetches `default` at launch instead.
  // It stays as the rule for seeding — set `bundled: true` on an entry in
  // `voice-packs.mjs` and that pack is seeded again, here (an offline installer
  // variant is what would want that). Since #1144 nothing hides the bundled
  // copy behind the seeded one, though: the bundle's bare `default` would list
  // beside the pack's `default::default`, so re-bundling needs that settled.
  //
  // Importing an entry does NOT decide that its pack is bundled. That is decided
  // once, in `@iracedeck/audio-assets`'s `voice-packs.mjs`, and reaches this
  // process as the clips the build copied into `assets/audio` and the manifest
  // it compiled in — `bundledVoices` above, bare ids like a catalog entry's.
  // An entry whose voices that set does not cover is a published pack this
  // build does not carry, and is simply not seeded. That is why the stage 3 flip
  // needed no edit here: the import went stale and inert, nothing more.
  const compiledInVoicePackEntries: readonly unknown[] = [defaultVoicePackCatalogEntry];
  const bundledVoicePacks: BundledVoicePack[] = [];

  for (const candidate of compiledInVoicePackEntries) {
    // safeParse, never parse: this runs at startup, and a malformed
    // committed entry must cost the seed, not the plugin process.
    const parsed = VoicePackCatalogEntrySchema.safeParse(candidate);

    if (!parsed.success) {
      voicePacksLogger.warn("A compiled-in voice pack catalog entry is invalid; that pack will not be seeded");
      voicePacksLogger.debug(parsed.error.message);
      continue;
    }

    if (!parsed.data.voices.every((voice) => bundledVoices.includes(voice.id))) {
      voicePacksLogger.debug(`Voice pack "${parsed.data.id}" is published, not bundled; not seeded`);
      continue;
    }

    bundledVoicePacks.push({ entry: parsed.data, audioDir: audio.rootDir });
  }

  const voicePackInstaller = createVoicePackInstaller({
    storage: voicePackStorage,
    packFs: voicePackFs,
    archiveFs: createVoicePackArchiveFileSystem(voicePacksLogger),
    fs: createVoicePackInstallerFileSystem(voicePacksLogger),
    catalog: voicePackCatalog,
    bundled: bundledVoicePacks,
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
    // sibling pushes above, so the re-assertion on every Property Inspector
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

  // The launch step (#1034 stage 3): sweep, seed, then — once the settings load
  // has settled, so the catalog dev override is readable — ensure `default` and
  // update every catalog-installed pack, retrying on its own schedule. Started
  // by `startServices`, after `initGlobalSettings`: nothing in it depends on the
  // settings store being READY (ruling 2 — the fail-closed settings path must
  // not cost the voice), and it opens no window (the structural test holds it
  // to that).
  const voicePackLaunch = createVoicePackLaunchStep({
    installer: voicePackInstaller,
    // A thunk: `initGlobalSettings` (in `startServices`) re-arms the settle
    // signal, so the promise must be taken inside `start()`, which runs after it.
    settled: () => whenSettingsStoreSettled(),
    // What is on disk now, as against the record's digest: the scanner's last
    // result listing the pack with a voice. A managed pack whose record
    // survived but whose clips did not is reinstalled by force off this.
    isPackUsable: (id) => service.installed().some((pack) => pack.id === id && pack.voices.length > 0),
    // The development root provides `id` right now, so the launch step must
    // never install or update it over that root's own copy (#1143).
    isProvidedByDevRoot: (id) => service.isProvidedByDevRoot(id),
    ...(devVoicePacksRoot === undefined ? {} : { devRoot: devVoicePacksRoot }),
    isRaceEngineerEnabled: () => (getGlobalSettings() as Record<string, unknown>).pitCrewRaceEngineerEnabled === true,
    // The step watches the Race Engineer gate itself and re-runs the ensure on
    // the false→true edge — the moment a missing or stale voice starts to matter.
    onSettingsChange: onGlobalSettingsChange,
    logger: voicePacksLogger,
  });

  const windowCommands: VoicePacks["windowCommands"] = {
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
    // it as a `_warnings` banner (see `warnings` on the installer above). The
    // results are therefore not read here: the installer has already put
    // each one where the user can see it and logged it.
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

  return {
    state,
    logger: voicePacksLogger,
    service,
    installer: voicePackInstaller,
    launch: voicePackLaunch,
    push: {
      raceEngineerVoices: pushRaceEngineerVoicesIfChanged,
      driverNames: pushDriverNamesIfChanged,
      packList: pushVoicePackListIfChanged,
    },
    reassertVoiceScriptWarning,
    windowCommands,
    // Every route that puts the settings window on screen goes through here and
    // asks the voice catalog on the way (#1100). The Race Engineer card answers
    // "what could I download?" from `_voicePackStatus`, and this is the moment
    // that answer is wanted — a user-initiated fetch beside the launch step's own
    // unprompted one (see `voicePackCatalog` for why that gate is a constant even
    // so, since #1034 stage 3). The service caches the fetch for an hour, so
    // reopening the window is not a second request; the verdicts are recomputed
    // either way. Fire-and-forget on purpose: `refreshCatalog` never rejects, and
    // the window must not wait on the network to open.
    refreshCatalog: () => {
      void voicePackInstaller.refreshCatalog();
    },
  };
}
