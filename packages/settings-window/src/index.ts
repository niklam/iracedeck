// @iracedeck/settings-window: the loopback-served, chromeless-app-window settings UI
// (issue #992), moved out of deck-core (issue #1367).
export {
  appWindowArgs,
  findChromiumBrowser,
  findChromiumBrowserOnThisMachine,
  queryWindowsAppPath,
  SETTINGS_WINDOW_SIZE,
  spawnAppWindow,
  type ChromiumLookupDeps,
} from "./chromium-browser.js";
export {
  authorizeSettingsRequest,
  type SettingsRequestDecision,
  type SettingsRequestDenial,
  type SettingsRequestInput,
} from "./settings-window-guard.js";
export {
  launchSettingsWindow,
  type SettingsWindowBounds,
  type SettingsWindowLaunch,
  type SettingsWindowLaunchInput,
} from "./settings-window-launcher.js";
export {
  createSettingsWindowCommandHandler,
  enableFeatureWrites,
  parseSettingsWindowBounds,
  SETTINGS_WINDOW_BOUNDS_KEY,
  type SettingsWindowCommandDeps,
} from "./settings-window-commands.js";
export {
  startSettingsWindowServer,
  type SettingsWindowHost,
  type SettingsWindowServer,
  type SettingsWindowServerOptions,
} from "./settings-window-server.js";
export {
  createSettingsWindowController,
  type SettingsWindowController,
  type SettingsWindowOpenOptions,
  type SettingsWindowControllerOptions,
  type SettingsWindowStatus,
} from "./settings-window.js";

// Settings-window failure banner: the controller's lifecycle outcomes surfaced
// as a PI warning, so an unreachable settings window is diagnosable rather than
// a dead button (issue #1005)
export {
  evaluateSettingsWindowWarnings,
  SETTINGS_WINDOW_OPEN_BLOCKED_MESSAGE,
  SETTINGS_WINDOW_OPEN_FAILURE_MESSAGE,
  SETTINGS_WINDOW_SERVER_FAILURE_MESSAGE,
  settingsWindowWarningScope,
  type SettingsWindowWarningContext,
} from "./settings-window-warning.js";
export {
  createSettingsWindowWarningReporter,
  type SettingsWindowWarningReporterOptions,
} from "./settings-window-warning-reporter.js";

// Reveal the settings file in Explorer (issue #993)
export { explorerSelectArgs, openDirectoryInExplorer, openFolderInExplorer } from "./open-folder.js";

// Settings-channel publisher: store write + the one host mirror per start (issue #993 phase 2)
export {
  createSettingsChannelPublisher,
  type SettingsChannel,
  type SettingsChannelPublisher,
  type SettingsChannelPublisherDeps,
} from "./settings-channel-publisher.js";
