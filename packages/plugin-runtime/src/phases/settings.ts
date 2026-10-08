/**
 * Phase 7 (#1349): the plugin-owned settings and replay stores, the settings
 * window, the startup notices (first run, changelog), the global-settings
 * listener with its one-shot store-ready block, and the PI-appear re-pushes.
 */
import { SETTINGS_WINDOW_HTML, VOICE_PACK_DEV_BASE_URL_KEY } from "@iracedeck/app-constants";
import { getAudio } from "@iracedeck/audio-service";
import {
  createSettingsChannelPublisher,
  createSettingsWindowCommandHandler,
  createSettingsWindowController,
  createSettingsWindowWarningReporter,
  createUpdateCheckService,
  findChromiumBrowserOnThisMachine,
  getCpuProfileCapture,
  getPluginPlatform,
  getPluginVersion,
  getSimHub,
  initializeCpuProfileCapture,
  initializeReplaySessionStore,
  isSimHubReachable,
  openFolderInExplorer,
  parseSettingsWindowBounds,
  resolveReplayStoreDirectory,
  runVersionCheck,
  SETTINGS_WINDOW_BOUNDS_KEY,
  type SettingsWindowOpenOptions,
  shouldOpenChangelog,
  spawnAppWindow,
  VERSION_CHECK_STARTUP_GRACE_MS,
} from "@iracedeck/deck-core";
import { isIRacingActive, onIRacingTerminated } from "@iracedeck/deck-iracing";
import {
  applyStartupFeatureGates,
  createFileSettingsStore,
  createSettingsFileRejectionReporter,
  deleteGlobalSettings,
  FIRST_RUN_VERSION_KEY,
  getGlobalSettings,
  GETTING_STARTED_PANE,
  isSettingsStoreReady,
  migrateRaceEngineerVoiceId,
  migrateStartupPolicies,
  MIGRATION_PENDING_KEY,
  onGlobalSettingsChange,
  resolveSettingsStorePath,
  runFirstRunCheck,
  updateGlobalSettings,
} from "@iracedeck/settings";
import { resolveVoicePackCatalogUrl, VOICE_PACK_CATALOG_URL } from "@iracedeck/voice-packs";
import { join } from "node:path";

import { isAudioPreviewKind, migrateLfeIntensityBindingKeys, runAudioPreview } from "../actions.js";
import { profilesDirFor } from "../log-location.js";
import type { Audio, Core, Settings, VoicePacks } from "../types.js";

export function initSettings(core: Core, audio: Audio, voicePacks: VoicePacks): Settings {
  // Publish audio device list and apply saved device selection.
  //
  // `audioOutputDevice` is persisted as the platform-stable `ma_device_id`
  // (hex-encoded) — empty string means System Default. The enumeration index
  // is volatile across replug / driver reset / OS audio-preference change, so
  // we re-resolve by id every session.
  //
  // Legacy values from pre-#427 builds (numeric index strings, the literal
  // "-1", malformed entries) are treated as unknown and silently fall back
  // to System Default. The project is pre-v1 with a single user; no
  // migration code is needed.
  //
  // `currentAudioDeviceId` starts as `""` (System Default) because
  // `getAudio().init()` leaves the remembered selection at System Default
  // without creating an engine/device (#849) — without this seed, the
  // first arrival of `audioOutputDevice = ""` would look like a transition
  // and fire a redundant `setAudioDevice(-1)`.
  let initialDevicePushDone = false;
  let startupDefaultsApplied = false;
  let currentAudioDeviceId: string = "";
  // Cache the last pushed payload so identical re-enumerations (the common
  // case on repeated PI re-opens with no hardware change) don't churn the
  // sdpi-components data source and force a full dropdown re-render.
  let lastPushedDeviceListJson = "";

  function pushAudioDevicesIfChanged(): void {
    const devices = getAudio().getAudioDevices();
    const json = JSON.stringify(devices);

    if (json === lastPushedDeviceListJson) return;

    lastPushedDeviceListJson = json;
    updateGlobalSettings({ _audioDeviceList: json });
  }

  const versionCheckLogger = core.adapter.createLogger("VersionCheck");

  // Changelog version check (issues #680, #742, #870). Builds its inputs from
  // the LIVE settings cache on every call, because it runs at two different
  // moments: once ~15 s after the first global-settings arrival (the #870
  // startup grace that lets the sim-running signals settle), and again whenever
  // iRacing exits — a due changelog is never opened over a live session, it
  // defers (nothing persisted) and stays pending until the sim is gone.
  // `runVersionCheck` is naturally idempotent across these calls: once a
  // version is persisted, later calls decide `skip`.
  let startupNoticesInFlight: Promise<void> | undefined;

  /**
   * Serialises the two entry points below. `runFirstRunCheck` persists only once
   * the window has opened, so its own "already resolved" guard is blind for the
   * whole browser-spawn duration — long enough for the startup-grace timer and an
   * iRacing exit to both decide "open" and spawn two windows.
   */
  function runStartupNotices(): Promise<void> {
    startupNoticesInFlight ??= startupNotices().finally(() => {
      startupNoticesInFlight = undefined;
    });

    return startupNoticesInFlight;
  }

  async function startupNotices(): Promise<void> {
    // Nothing meaningful to compare before the first settings arrival.
    if (!startupDefaultsApplied) return;

    const settings = getGlobalSettings();
    const s = settings as Record<string, unknown>;

    // Reads the last-seen version from the passthrough `_lastSeenVersion` key
    // and persists the running version. No-op for pre-release builds and
    // same/older versions. `type` is the connected deck's type id where the
    // host extension reports one (Stream Deck), omitted otherwise (Mirabox,
    // Ulanzi expose none); the browser opens through the adapter's `openUrl`.
    // On Mirabox that is best-effort: harmless if the Stream Dock host ignores it.
    // The `changelogNotification` preference (issue #742)
    // decides whether a due changelog opens, is recorded silently, or stays
    // pending (monthly window, anchored on the passthrough
    // `_lastChangelogOpenedAt` key).
    // The first-run check runs FIRST and may consume the start (#1061). That
    // ordering is load-bearing rather than tidy: its evidence for "some build has
    // already started against this store" is the absence of `_lastSeenVersion`,
    // and the changelog check below is precisely what writes that key. It also
    // consumes the start while the settings migration is still pending, so the
    // key stays pristine until the store has settled.
    if (
      await runFirstRunCheck({
        currentVersion: getPluginVersion(),
        firstRunVersion: s[FIRST_RUN_VERSION_KEY],
        lastSeenVersion: s._lastSeenVersion,
        migrationPending: s[MIGRATION_PENDING_KEY],
        isSimRunning: isIRacingActive,
        persist: (partial) => updateGlobalSettings(partial),
        openGettingStarted: () => openSettingsWindow({ pane: GETTING_STARTED_PANE }),
        logger: versionCheckLogger,
      })
    ) {
      return;
    }

    await runVersionCheck({
      currentVersion: getPluginVersion(),
      lastSeenVersion: typeof s._lastSeenVersion === "string" ? s._lastSeenVersion : undefined,
      policy: settings.changelogNotification,
      lastOpenedAt: typeof s._lastChangelogOpenedAt === "number" ? s._lastChangelogOpenedAt : undefined,
      ecosystem: getPluginPlatform(),
      deviceType: core.host.extension?.getConnectedDeviceType(),
      isSimRunning: isIRacingActive,
      persist: (version) => updateGlobalSettings({ _lastSeenVersion: version }),
      persistOpenedAt: (timestamp) => updateGlobalSettings({ _lastChangelogOpenedAt: timestamp }),
      openUrl: (url) => core.adapter.openUrl(url),
      logger: versionCheckLogger,
    });
  }

  // Re-run the check when iRacing exits so a changelog deferred mid-session
  // opens right after the session ends (issue #870) — on hosts without
  // app-monitoring events, via the app monitor's SDK-disconnect fallback. The
  // app monitor notifies after the running flag and the SDK connection are
  // already down, so the isSimRunning gate reads false here. Gated on an open
  // actually being pending: once the version is persisted (or on a pre-release
  // build) every later sim exit would otherwise re-run a dead check and log
  // "Version up to date" for the whole process lifetime.
  onIRacingTerminated(() => {
    const s = getGlobalSettings() as Record<string, unknown>;
    const lastSeen = typeof s._lastSeenVersion === "string" ? s._lastSeenVersion : undefined;

    // Also re-run while the Getting Started page is still unresolved (#1061):
    // on a pre-release build `shouldOpenChangelog` is always false, so without
    // this a first-run open deferred by the sim gate would never be retried.
    if (!s[FIRST_RUN_VERSION_KEY]) {
      void runStartupNotices();

      return;
    }

    if (!shouldOpenChangelog(getPluginVersion(), lastSeen)) return;

    void runStartupNotices();
  });

  // Plugin-owned global-settings store (issue #993). Declared here — above the
  // settings-window controller below, whose command-handler deps read
  // settingsStore.path eagerly (not from inside a deferred callback) — so it is
  // already initialized wherever it's referenced.
  const settingsStore = createFileSettingsStore({
    path: resolveSettingsStorePath({ platform: getPluginPlatform(), env: process.env }),
    logger: core.adapter.createLogger("SettingsStore"),
    // A file rejected as invalid JSON is moved aside and the settings restored
    // from the deck host's copy; this banner is how the user learns that (#1036).
    onRejected: createSettingsFileRejectionReporter(),
  });

  // Land the last debounced save on the way out. Node runs "exit" handlers
  // synchronously, which is exactly why the store has a SYNCHRONOUS flush — the
  // async flush() would never get an event-loop turn here. This covers every
  // orderly exit, including the Mirabox/Ulanzi clients' outright process.exit(0)
  // when their host socket closes. A hard kill by the host can't be caught by
  // anything, so a <=250 ms window remains there by construction.
  process.on("exit", () => settingsStore.flushSync());

  // The per-session replay store (#1162, #1203): one file per SubSessionID under
  // %LOCALAPPDATA%\iRaceDeck\Replay\<ecosystem>, holding the replay markers and the lap
  // record. Fed the active session by the subscriber wired beside the elevation
  // check below; the actions read it synchronously through getReplaySessionStore().
  // Its writes are debounced like the settings store's, so it gets the same
  // synchronous flush on the way out.
  const replaySessionStore = initializeReplaySessionStore({
    directory: resolveReplayStoreDirectory({ platform: getPluginPlatform(), env: process.env }),
    logger: core.adapter.createLogger("ReplaySessionStore"),
  });

  process.on("exit", () => replaySessionStore.flushSync());

  // The translator's lap recorder (#1203) publishes each live lap start and lap
  // time; the store keeps them in the session's replay file for the fastest-lap
  // lookup. The store ignores an event whose subSessionId is not the open one.
  core.bus.subscribe("replay.lapStarted", (ev) => {
    replaySessionStore.laps.recordLapStart(ev.data);
  });
  core.bus.subscribe("replay.lapTimed", (ev) => {
    replaySessionStore.laps.recordLapTime(ev.data);
  });

  // Settings window (#992): the plugin serves ui/settings-window.html (compiled
  // from settings-window.ejs, with settings-window-bridge.js injected before
  // sdpi-components.js) over a loopback server started at plugin startup (#993 —
  // see the ensureStarted() call below) and opens it as a chromeless app window.
  // The page's sdpi-components talks to the server's fake host, which is bound
  // here to the real global-settings singleton — so every write goes through
  // updateGlobalSettings and lands in the plugin-owned settings store (#993),
  // the one persistent copy. Declared here, above the onGlobalSettingsChange
  // listener below, because that listener's store-ready block starts the server
  // (ensureStarted()).
  const settingsWindowLogger = core.adapter.createLogger("SettingsWindow");
  // Mirrors the store + the loopback channel to the deck host once per start
  // (#993 phase 2; the channel is never persisted in the store — a stale copy an
  // older build left there is removed) — from wherever the server actually
  // started (see the onStarted hook below and the store-ready block).
  const settingsChannel = createSettingsChannelPublisher({ adapter: core.adapter, logger: settingsWindowLogger });
  // Capture CPU profile (#1338): the files go to `profiles` beside the log the
  // host writes — `<cwd>/logs/profiles` on Stream Deck, `<plugin>/log/profiles`
  // on Mirabox and Ulanzi — the folder a user already sends from.
  const profilesDir = profilesDirFor(core.logLocation);
  // One shared service (#1338): the settings window's button and the Telemetry
  // Control key's Capture Profile mode reach it through getCpuProfileCapture().
  initializeCpuProfileCapture({
    profilesDir,
    logger: core.adapter.createLogger("CpuProfile"),
    // The run-scoped `_profileCaptureStatus` the Diagnostics card renders.
    writeSettings: (partial) => updateGlobalSettings(partial),
  });

  // Upstream update check (#1016). Asked only by the settings window's What's New
  // tab, cached for an hour, and gated on the `updateCheck` setting read live —
  // so a user who never opens the window, or who switches the setting off, makes
  // no outbound request at all.
  const updateCheck = createUpdateCheckService({
    isEnabled: () => getGlobalSettings().updateCheck !== false,
    getInstalledVersion: getPluginVersion,
    logger: core.adapter.createLogger("UpdateCheck"),
  });

  const settingsWindow = createSettingsWindowController({
    assetsDir: join(core.binDir, "..", "ui"),
    pageFile: SETTINGS_WINDOW_HTML,
    settingsHost: {
      read: () => getGlobalSettings() as Record<string, unknown>,
      write: (partial) => updateGlobalSettings(partial),
      subscribe: (listener) => onGlobalSettingsChange((s) => listener(s as Record<string, unknown>)),
    },
    findBrowser: findChromiumBrowserOnThisMachine,
    spawnApp: spawnAppWindow,
    openUrl: (url) => core.adapter.openUrl(url),
    // Reopen where the user left it (the page reports bounds on resize).
    getWindowBounds: () =>
      parseSettingsWindowBounds((getGlobalSettings() as Record<string, unknown>)[SETTINGS_WINDOW_BOUNDS_KEY]),
    onSendToPlugin: createSettingsWindowCommandHandler({
      writeSettings: (partial) => updateGlobalSettings(partial),
      // The Getting Started focus opt-in refuses to escalate a mode already on (#977).
      readSettings: () => getGlobalSettings() as Record<string, unknown>,
      // The window's Race Engineer Test buttons — same runner as the Pit Crew action.
      previewAudio: (kind) => {
        if (isAudioPreviewKind(kind)) runAudioPreview(kind, core.adapter.createLogger("AudioPreview"));
      },
      // Unlike a PI, the window has no implicit device: it names one. Same
      // dispatch as the PI's accordion buttons (suffix per #753, history per #762).
      // Only a host with profiles passes it (#736); without one the key is absent.
      ...(core.host.extension ? { switchProfile: core.host.extension.switchProfile } : {}),
      // Storage card's Open folder button (#993) — the path is always the plugin's own.
      openFolder: openFolderInExplorer,
      storePath: settingsStore.path,
      // The voice-pack phase's Rescan, Install, Remove and Open folder commands
      // (#1034, #1100), with the comments that explain them.
      ...voicePacks.windowCommands,
      // Diagnostics' Capture CPU profile and its Open folder (#1338). Neither takes
      // anything from the page: the duration is the service's, the folder is ours.
      // A press during a capture is refused by the service itself.
      captureCpuProfile: () => {
        void getCpuProfileCapture().capture();
      },
      profilesPath: profilesDir,
    }),
    // The page can't probe SimHub itself (cross-origin, no CORS) — answer from the plugin's own view.
    simHub: { isReachable: isSimHubReachable, getRoles: () => getSimHub().getRoles() },
    // The page can't reach iracedeck.com itself (cross-origin, no CORS) — answer from the plugin's own check.
    updates: updateCheck,
    onStarted: (channel) => settingsChannel.publish(channel),
    // Surface a settings window the user cannot reach as a PI warning banner
    // instead of leaving them with a button that does nothing (#1005). The
    // controller is the only place that knows WHICH stage failed — a settings
    // service that never bound (error) vs. a machine where no browser would
    // open the page (warning) — and the banner clears as soon as one succeeds.
    onStatus: createSettingsWindowWarningReporter({ getStorePath: () => settingsStore.path }),
    logger: settingsWindowLogger,
  });

  // Every route that opens the window asks the catalog first (#1100).
  function openSettingsWindow(options?: SettingsWindowOpenOptions): ReturnType<typeof settingsWindow.open> {
    voicePacks.refreshCatalog();

    return settingsWindow.open(options);
  }

  onGlobalSettingsChange((settings) => {
    const s = settings as Record<string, unknown>;

    // First time settings arrive, seed the device list so the PI sees the
    // initial enumeration without needing to be opened first. After this
    // the PI-appear hook drives refreshes — `initialDevicePushDone` is just
    // a one-shot gate, not a "never refresh" latch.
    if (!initialDevicePushDone) {
      initialDevicePushDone = true;
      pushAudioDevicesIfChanged();
    }

    // One-shot startup migrations and the per-feature startup policies
    // (issue #1007, replacing the "On startup" defaults of #482 — a policy of
    // `remember-last` now leaves the previous session's gate alone instead of
    // overriding it). The Pit Crew action's own onGlobalSettingsChange listener
    // picks up the echoed runtime keys and re-applies them to the audio buses /
    // radar engine, so no further wiring is needed here.
    //
    // First step is the issue #515 migration: drop the four pre-rename Pit
    // Crew enable keys from persisted storage. Idempotent — once they're
    // gone, subsequent startups skip the write. Runs BEFORE the on-startup
    // defaults below so the renamed `pitCrew*Enabled` keys take their
    // schema defaults (`false`) for everyone, regardless of what the
    // pre-rename keys held.
    // Also gate on the settings store: a write made before it has loaded still
    // notifies listeners (read-your-writes), and running the startup defaults
    // against schema defaults would layer those computed values over the
    // loaded/migrated settings (#993).
    if (!startupDefaultsApplied && isSettingsStoreReady()) {
      startupDefaultsApplied = true;

      deleteGlobalSettings([
        "raceEngineerEnabled",
        "radarEnabled",
        "raceEngineerEnabledOnStartup",
        "radarEnabledOnStartup",
      ]);

      // Issue #657 rename cleanup: the per-callout opt-in
      // `calloutEnabledFlagOneLapToGreen` was renamed to
      // `calloutEnabledFlagOnePaceLapToGo`. Drop the orphaned old key so the new
      // key takes its schema default (on) for everyone — the same "reset to
      // schema default on rename" convention as the #515 keys above. The cue was
      // also re-triggered and re-recorded (effectively new behaviour), so it
      // should default on per the Race Engineer "new functionality defaults on"
      // principle rather than inherit a disable of the old, broken cue.
      deleteGlobalSettings(["calloutEnabledFlagOneLapToGreen"]);

      // Issue #848: the Force Feedback LFE "intensity" modes were retired as
      // duplicates of Wheel/BassShaker LFE (iRacing has one control pair per
      // LFE device, labeled differently across its settings pages). Carry any
      // bindings stored under the retired keys over to the canonical
      // louder/quieter keys (never overwriting a configured one), then drop
      // the retired keys. Idempotent.
      migrateLfeIntensityBindingKeys();

      // Issue #1007: the retired `…EnabledOnStartup` booleans became startup
      // policies. Migrate first so the policies below are the user's real
      // choice, apply them to the live gates, then arm the gate sync — in that
      // order, because arming records the post-write values as already applied
      // and a startup write must never sound like a user toggle.
      migrateStartupPolicies(audio.featureGateLogger);
      applyStartupFeatureGates(audio.featureGateLogger);
      audio.armFeatureGateSync();

      // Open the website changelog once when a newer stable version is
      // detected (issue #680) — via runStartupNotices above,
      // delayed by the #870 startup grace so a mid-session plugin restart (the
      // deck-host auto-update case) can't run the check before the sim-running
      // signals are up and open the page over a live session.
      setTimeout(() => void runStartupNotices(), VERSION_CHECK_STARTUP_GRACE_MS);

      // #993: the Diagnostics "Storage" card's path is known synchronously (no
      // I/O at construction) — publish it unconditionally here, NOT inside the
      // ensureStarted().then() below, so a bind/firewall failure that rejects
      // the settings server still leaves the path visible for the rest of the
      // process life. That's exactly when a diagnostic aid matters most.
      updateGlobalSettings({ _settingsStorePath: settingsStore.path });

      // #993: the settings server is the channel every UI uses; publish where it
      // is (the ONE host mirror per start — full store + `_settingsChannel` —
      // that the PI bridge bootstraps from; the channel itself is never persisted
      // in the store — see createSettingsChannelPublisher). The
      // controller's onStarted hook publishes a server that starts LATER too (a
      // failed startup bind followed by a successful "Open Settings"), and the
      // publisher is idempotent, so calling it here as well only ensures a
      // server that came up before the store was ready still gets mirrored.
      // Two-arg then: a bind/firewall failure must not crash the plugin process
      // (Node throws on an unobserved rejection). The controller logs it and
      // raises the PI warning banner itself (#1005), so there is nothing left
      // to do here but observe it; publish() logs its own faults and never throws.
      void settingsWindow.ensureStarted().then(
        (channel) => settingsChannel.publish(channel),
        // Mirror the store to the host WITHOUT a channel (#1005). With no server
        // there is nothing for a Property Inspector to connect to, so every PI
        // falls back to reading the deck host's copy — and this is the only write
        // the plugin makes to it. Without this the warning banner the controller
        // just raised would never leave the plugin's own settings file.
        () => settingsChannel.publishUnavailable(),
      );

      // An override must never be silently active (#1100). WARN rather than
      // info, and on every start rather than only when it changes, because the
      // person who needs this line is future-me reading a support log and
      // wondering why the catalog is not what the site serves. It names the
      // EFFECTIVE url, never the raw setting, and it claims the override is
      // ACTIVE only when that url actually differs from the published one: a
      // rejected value resolves back to the published catalog, and calling that
      // "active" would contradict the url printed in the same sentence.
      {
        const rawDevBase = (getGlobalSettings() as Record<string, unknown>)[VOICE_PACK_DEV_BASE_URL_KEY];

        if (typeof rawDevBase === "string" && rawDevBase.trim() !== "") {
          const effective = resolveVoicePackCatalogUrl({ base: rawDevBase, logger: voicePacks.logger });

          voicePacks.logger.warn(
            effective === VOICE_PACK_CATALOG_URL
              ? "Voice pack catalog override is set but has no effect; using the published catalog"
              : `Voice pack catalog override active: ${effective}`,
          );
        }
      }
    }

    voicePacks.push.raceEngineerVoices();
    voicePacks.push.driverNames();
    voicePacks.push.packList();
    // A stored bare voice id is qualified with its pack (#1144) — here once the
    // store is ready, and again after any scan that brings its pack.
    migrateRaceEngineerVoiceId(voicePacks.state.raceEngineerVoices, voicePacks.logger);
    // The active voice is a setting, so its banner is re-evaluated here (#1064).
    voicePacks.reassertVoiceScriptWarning();

    // Apply audio output device (on startup and when changed from PI)
    const saved = s.audioOutputDevice;
    const deviceId = typeof saved === "string" ? saved : "";

    if (deviceId === currentAudioDeviceId) return;

    currentAudioDeviceId = deviceId;

    if (deviceId === "") {
      getAudio().setAudioDevice(-1);
    } else {
      const ok = getAudio().setAudioDeviceById(deviceId);

      // Stale or unknown id (legacy index, unplugged device): fall back to
      // System Default. We do NOT rewrite the persisted setting — the user
      // may replug their device next session and we want it to re-bind
      // automatically when the id reappears in the enumeration.
      if (!ok) {
        getAudio().setAudioDevice(-1);
      }
    }
  });

  // Re-enumerate audio devices on every PI open so a headset plugged in
  // after the deck host booted appears without a full restart. The
  // `pushAudioDevicesIfChanged` guard short-circuits the common case (PI
  // reopened, no hardware changed) so the sdpi-components data source
  // doesn't churn.
  core.adapter.onPropertyInspectorDidAppear(() => {
    pushAudioDevicesIfChanged();
    voicePacks.push.raceEngineerVoices();
    voicePacks.push.driverNames();
    voicePacks.push.packList();
    // `_voicePackStatus` is run-scoped too, and owes the same re-assertion
    // (#1100). Deduped in publishStatus, so this is free when nothing moved.
    voicePacks.installer.republishStatus();
  });

  return { store: settingsStore, replayStore: replaySessionStore, openSettingsWindow };
}
