/**
 * Settings-window controller (issue #992).
 *
 * Owns the lifecycle of the loopback settings server: one server per plugin
 * process, started lazily on the first open(), reused on subsequent opens
 * (so re-clicking "Open Settings" never binds a second port), and torn down
 * on close(). Every plugin wires one of these; the delegates keep it free of
 * host and platform specifics.
 */
import type { ILogger } from "@iracedeck/logger";

import {
  launchSettingsWindow,
  type SettingsWindowBounds,
  type SettingsWindowLaunch,
} from "./settings-window-launcher.js";
import {
  type SettingsWindowHost,
  type SettingsWindowServer,
  startSettingsWindowServer,
} from "./settings-window-server.js";

/**
 * File name of the compiled settings-window page inside each plugin's `ui/`
 * folder (built from `settings-window.ejs` by the shared PI template plugin,
 * with `settings-window-bridge.js` injected before `sdpi-components.js`).
 * The build side declares the same string in `@iracedeck/pi-components/build`;
 * a shared test guards that they never drift.
 */
export const SETTINGS_WINDOW_HTML = "settings-window.html";

export interface SettingsWindowControllerOptions {
  /**
   * Inline page HTML producer — the placeholder / test path. Ignored when
   * `assetsDir` is given.
   */
  renderPage?: () => string;
  /**
   * Directory served as static assets (the plugin's `ui/`), with `pageFile`
   * served at `/`. This is the real-page path.
   */
  assetsDir?: string;
  pageFile?: string;
  findBrowser: () => string | undefined;
  spawnApp: (browserPath: string, url: string, bounds?: SettingsWindowBounds) => void;
  /** Host URL opener — used both as the launch fallback and for the page's external links. */
  openUrl: (url: string) => Promise<void>;
  /** Settings I/O for the page's fake host; omit for an HTTP-only (placeholder) page. */
  settingsHost?: SettingsWindowHost;
  /** Where the user last left the window (persisted by the plugin), read at each open. */
  getWindowBounds?: () => SettingsWindowBounds | undefined;
  /** Receives page `sendToPlugin` payloads (window bounds, profile switches, …). */
  onSendToPlugin?: (payload: Record<string, unknown>) => void;
  /** The plugin's SimHub view for the page's `/simhub/roles` proxy. */
  simHub?: { isReachable: () => boolean; getRoles: () => Promise<string[]> };
  logger: ILogger;
}

export interface SettingsWindowController {
  /** Start the server if needed and open (or re-open) the window. */
  open(): Promise<SettingsWindowLaunch>;
  /** Stop the server and release the port. Idempotent. */
  close(): Promise<void>;
}

export function createSettingsWindowController(options: SettingsWindowControllerOptions): SettingsWindowController {
  let server: SettingsWindowServer | undefined;

  return {
    async open() {
      if (server === undefined) {
        server = await startSettingsWindowServer({
          page: options.renderPage?.(),
          assetsDir: options.assetsDir,
          pageFile: options.pageFile,
          settingsHost: options.settingsHost,
          openUrl: options.openUrl,
          onSendToPlugin: options.onSendToPlugin,
          simHub: options.simHub,
        });
        options.logger.info("Settings window server started");
        options.logger.debug(`Settings window URL: ${server.url}`);
      }

      const launch = await launchSettingsWindow({
        url: server.url,
        findBrowser: options.findBrowser,
        spawnApp: options.spawnApp,
        openUrl: options.openUrl,
        bounds: options.getWindowBounds?.(),
      });

      options.logger.info(`Settings window opened (${launch})`);

      return launch;
    },

    async close() {
      if (server === undefined) return;

      const closing = server;

      server = undefined;
      await closing.close();
      options.logger.info("Settings window server stopped");
    },
  };
}
