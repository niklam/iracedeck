/**
 * Phase 5, step 1 (#1377): the scan — the voice-pack phase's mutable state, its
 * logger and roots, the scanner port, the voice-pack service, the three deduped
 * run-scoped pushes and the missing-callout-script banner. The service calls
 * back into the pushes and the pushes read the service, so they are one step;
 * everything after it takes what it needs from the returned `VoicePackScan`.
 * Building the scan does not run it: the phase body calls
 * `service.refresh()` for the startup scan itself.
 */
import { VOICE_LABELS_KEY, VOICE_PACKS_KEY } from "@iracedeck/app-constants";
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
import { getDevVoicePacksRoot } from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";
import {
  clearWarning,
  isGlobalSettingsInitialized,
  migrateRaceEngineerVoiceId,
  resolveActiveRaceEngineerVoice,
  setWarning,
  updateGlobalSettings,
} from "@iracedeck/settings";
import {
  createVoicePackFileSystem,
  createVoicePackService,
  createVoiceScriptWarningReporter,
  isManagedVoicePack,
  orderRaceEngineerVoices,
  resolveVoicePacksPath,
  voiceDisplayLabels,
  type VoicePackFileSystem,
  type VoicePackService,
} from "@iracedeck/voice-packs";

import type { Audio, Core, VoicePacks, VoicePackState } from "../../types.js";

/** The scan step's handoff to the rest of the phase. */
export interface VoicePackScan {
  readonly state: VoicePackState;
  readonly logger: ILogger;
  /** The packs folder: scanned here, installed into by the installer, revealed by the settings window. */
  readonly voicePacksRoot: string;
  /** A development build's staged packs (#1143); `undefined` on an ordinary installation. */
  readonly devVoicePacksRoot: string | undefined;
  /** The scanner port, shared with the installer (#1100). */
  readonly fs: VoicePackFileSystem;
  readonly service: VoicePackService;
  readonly push: VoicePacks["push"];
  reassertVoiceScriptWarning(): void;
}

export function buildVoicePackScan(core: Pick<Core, "adapter">, audio: Pick<Audio, "rootDir">): VoicePackScan {
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

  return {
    state,
    logger: voicePacksLogger,
    voicePacksRoot,
    devVoicePacksRoot,
    fs: voicePackFs,
    service,
    push: {
      raceEngineerVoices: pushRaceEngineerVoicesIfChanged,
      driverNames: pushDriverNamesIfChanged,
      packList: pushVoicePackListIfChanged,
    },
    reassertVoiceScriptWarning,
  };
}
