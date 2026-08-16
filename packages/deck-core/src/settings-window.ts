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

import { launchSettingsWindow, type SettingsWindowLaunch } from "./settings-window-launcher.js";
import { type SettingsWindowServer, startSettingsWindowServer } from "./settings-window-server.js";

export interface SettingsWindowControllerOptions {
  /** Produces the settings page HTML at open-time (so it can reflect live state). */
  renderPage: () => string;
  findBrowser: () => string | undefined;
  spawnApp: (browserPath: string, url: string) => void;
  openUrl: (url: string) => Promise<void>;
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
        server = await startSettingsWindowServer({ page: options.renderPage() });
        options.logger.info("Settings window server started");
        options.logger.debug(`Settings window URL: ${server.url}`);
      }

      const launch = await launchSettingsWindow({
        url: server.url,
        findBrowser: options.findBrowser,
        spawnApp: options.spawnApp,
        openUrl: options.openUrl,
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
