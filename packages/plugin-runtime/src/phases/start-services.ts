/**
 * Phase 10 (#1349; 9 until #1467): the global settings listener and what
 * waits on it — the voice-pack launch step, the two binding migrations, the
 * host's extension, the settings-window request, SimHub, the binding
 * dispatcher, the app monitor, the audio session hold, and the two SDK
 * subscribers. Everything here is registered before `startPlugin` connects
 * the adapter.
 */
import { getAudio } from "@iracedeck/audio-service";
import { getPluginVersion, initializeBindingDispatcher, initializeSimHub } from "@iracedeck/deck-core";
import {
  createElevationCheckSubscriber,
  createReplaySessionSubscriber,
  initAppMonitor,
  isIRacingActive,
  onIRacingStarted,
  onIRacingTerminated,
} from "@iracedeck/deck-iracing";
import {
  initGlobalSettings,
  migrateGlobalSettingsKeys,
  onGlobalSettingsChange,
  seedBindingDefaultsIfAbsent,
} from "@iracedeck/settings";

import {
  CAR_CYCLE_BINDING_DEFAULTS,
  isRaceEngineerEnabled,
  isRadarEnabled,
  SETUP_CHASSIS_BINDING_KEY_RENAMES,
  startAudioSessionHold,
} from "../actions.js";
import type { Core, Input, Settings, VoicePacks } from "../types.js";

export function startServices(core: Core, input: Input, settings: Settings, voicePacks: VoicePacks): void {
  // Initialize global settings listener BEFORE connect - handlers must be registered first.
  // The settings store comes from the settings phase, which built it above the
  // settings-window controller. The running version lets an abandoned migration
  // be re-asked once after an upgrade (#1047). Injected because
  // `@iracedeck/settings` sits below deck-core and cannot import
  // `getPluginVersion`; injecting it also keeps the settings layer from
  // depending on initPluginConfig() having run.
  initGlobalSettings(core.adapter, core.adapter.createLogger("GlobalSettings"), settings.store, {
    pluginVersion: getPluginVersion(),
  });

  // The voice-pack launch step starts here, after `initGlobalSettings` has armed
  // the settle signal it waits on, and here rather than inside the store-ready
  // block (#1034 stage 3, ruling 2).
  void voicePacks.launch.start();

  // Migrate the pre-#953 spring binding keys (Left/Right -> LR/RR) once real settings arrive
  migrateGlobalSettingsKeys(SETUP_CHASSIS_BINDING_KEY_RENAMES, core.adapter.createLogger("SettingsMigration"));

  // Seed iRacing's Next / Previous Car bindings for anyone who has never stored
  // them (#1277): Cycle by Track Order now taps them, and before that nothing but
  // a Replay Control panel ever wrote them. Every start, once the stored settings
  // are in; a stored value, cleared ones included, is never touched.
  seedBindingDefaultsIfAbsent(CAR_CYCLE_BINDING_DEFAULTS, core.adapter.createLogger("SettingsMigration"));

  // What only this host has (#1349) — on Stream Deck: the profile switcher for
  // the Switch Profile action and the "Stream Deck Profiles" buttons (#736),
  // and the connected-deck list for the settings window's device picker.
  core.host.extension?.start();

  core.adapter.onOpenSettingsRequest(() => {
    core.host.extension?.refreshDevices();
    // Logged and surfaced as a PI warning banner by the controller itself
    // (#1005); observed here only so Node never sees an unobserved rejection.
    void settings.openSettingsWindow().catch(() => undefined);
  });

  // Initialize SimHub AFTER global settings so health check uses configured host/port
  initializeSimHub(core.adapter.createLogger("SimHub"));

  // Initialize binding dispatcher AFTER SimHub so isReady can check reachability
  initializeBindingDispatcher(core.adapter.createLogger("BindingDispatcher"));

  // Initialize app monitor for iRacing process detection
  initAppMonitor(core.adapter, core.adapter.createLogger("AppMonitor"));

  // Keep the audio device open while iRacing runs and the Race Engineer or the
  // Radar is on, instead of opening it once per burst of callouts (#1347). The
  // controller decides when; the audio service owns the hold itself. AFTER the
  // app monitor because it follows that monitor's started and terminated
  // edges and is seeded from its view of an iRacing that was already running,
  // and before `adapter.connect()` like everything in this phase: a host
  // reports an already-running iRacing as a launch event right after
  // connecting, and that edge is the one that takes the hold.
  startAudioSessionHold({
    audio: getAudio(),
    onIRacingStarted,
    onIRacingTerminated,
    isIRacingActive,
    isRaceEngineerEnabled,
    isRadarEnabled,
    onGlobalSettingsChange,
    logger: core.adapter.createLogger("AudioSessionHold"),
  });

  // Detect an Administrator/integrity mismatch with iRacing and surface it as a
  // PI warning banner (issue #610). Both outcomes are logged at the default log
  // level so support logs always capture whether the check ran and what it found
  // (issue #902) — see createElevationCheckSubscriber in deck-iracing.
  core.controller.subscribe(
    "elevation-check",
    createElevationCheckSubscriber({
      getStatus: () => input.native.getElevationStatus(),
      logger: core.adapter.createLogger("Elevation"),
    }),
  );

  // Follow the session the SDK is connected to into the replay session store
  // (#1162): open session_<SubSessionID>.json when the id appears or changes —
  // live or in a replay, so a .rpy opened days later finds its markers — and
  // close it on disconnect.
  core.controller.subscribe(
    "replay-session",
    createReplaySessionSubscriber({
      store: settings.replayStore,
      getSessionInfo: () => core.controller.getSessionInfo(),
      logger: core.adapter.createLogger("ReplaySession"),
    }),
  );
}
