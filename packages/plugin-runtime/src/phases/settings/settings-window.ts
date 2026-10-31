/**
 * The settings phase's window step (#1377): the settings channel publisher,
 * the CPU profile capture, the upstream update check, the settings-window
 * controller with its command handler, and `openSettingsWindow`, which asks
 * the voice-pack catalog first. In that order: the logger scopes and the
 * recorded startup order both follow it.
 *
 * Settings window (#992): the plugin serves ui/settings-window.html (compiled
 * from settings-window.ejs, with settings-window-bridge.js injected before
 * sdpi-components.js) over a loopback server started at plugin startup (#993 —
 * see the store-ready block's ensureStarted() call) and opens it as a
 * chromeless app window. The page's sdpi-components talks to the server's fake
 * host, which is bound here to the real global-settings singleton — so every
 * write goes through updateGlobalSettings and lands in the plugin-owned
 * settings store (#993), the one persistent copy. The phase builds this before
 * the global-settings listener and hands the result to its store-ready block,
 * which starts the server (ensureStarted()) and publishes the channel.
 */
import { SETTINGS_WINDOW_HTML } from "@iracedeck/app-constants";
import { createUpdateCheckService } from "@iracedeck/app-updates";
import { getPluginVersion, getSimHub, isSimHubReachable } from "@iracedeck/deck-core";
import { getCpuProfileCapture, initializeCpuProfileCapture } from "@iracedeck/diagnostics";
import {
  getGlobalSettings,
  onGlobalSettingsChange,
  type SettingsStore,
  updateGlobalSettings,
} from "@iracedeck/settings";
import {
  createSettingsChannelPublisher,
  createSettingsWindowCommandHandler,
  createSettingsWindowController,
  createSettingsWindowWarningReporter,
  findChromiumBrowserOnThisMachine,
  openFolderInExplorer,
  parseSettingsWindowBounds,
  SETTINGS_WINDOW_BOUNDS_KEY,
  type SettingsChannelPublisher,
  type SettingsWindowController,
  type SettingsWindowOpenOptions,
  spawnAppWindow,
} from "@iracedeck/settings-window";
import { join } from "node:path";

import { isAudioPreviewKind, runAudioPreview } from "../../actions.js";
import { profilesDirFor } from "../../log-location.js";
import type { Core, VoicePacks } from "../../types.js";

export interface SettingsWindowDeps {
  readonly core: Core;
  /** Built by the store step first: the command handler reads its `path` eagerly. */
  readonly store: Pick<SettingsStore, "path">;
  readonly voicePacks: VoicePacks;
}

export interface SettingsWindowStep {
  readonly controller: SettingsWindowController;
  /** Mirrors the store + the loopback channel to the deck host; the store-ready block publishes through it too. */
  readonly channel: SettingsChannelPublisher;
  /** Every route that opens the window goes through this one. */
  openSettingsWindow(options?: SettingsWindowOpenOptions): ReturnType<SettingsWindowController["open"]>;
}

export function initSettingsWindow({ core, store, voicePacks }: SettingsWindowDeps): SettingsWindowStep {
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
      storePath: store.path,
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
    onStatus: createSettingsWindowWarningReporter({ getStorePath: () => store.path }),
    logger: settingsWindowLogger,
  });

  return {
    controller: settingsWindow,
    channel: settingsChannel,
    // Every route that opens the window asks the catalog first (#1100).
    openSettingsWindow(options) {
      voicePacks.refreshCatalog();

      return settingsWindow.open(options);
    },
  };
}
