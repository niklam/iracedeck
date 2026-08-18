/**
 * Settings-window controller (issue #992).
 *
 * Owns the lifecycle of the loopback settings server: one server per plugin
 * process, started the first time either `ensureStarted()` or `open()` is
 * called — the plugin calls `ensureStarted()` at startup (#993) so the
 * `_settingsChannel` port/token exist before any UI needs them, well before
 * the user ever opens the window — and reused on every later call, so
 * re-clicking "Open Settings" never binds a second port and the port and its
 * token live for the rest of the plugin run. close() releases it; it exists
 * for tests and an explicit shutdown, no plugin calls it today. Every plugin
 * wires one of these; the delegates keep it free of host and platform
 * specifics.
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
  type SettingsWindowServerOptions,
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
  /** Spawns the app window; a rejection (or throw) falls back to `openUrl`. */
  spawnApp: (browserPath: string, url: string, bounds?: SettingsWindowBounds) => void | Promise<void>;
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
  /**
   * Test seam (#993): overrides the server-start function. Defaults to
   * `startSettingsWindowServer`. Lets tests inject a controllable start
   * (delayed, or rejecting once) to exercise the concurrent-caller dedup and
   * retry-after-failure paths in `ensureServer()` without standing up a real
   * race against the OS network stack's own timing.
   */
  startServer?: (serverOptions: SettingsWindowServerOptions) => Promise<SettingsWindowServer>;
  /**
   * Fired once per actual server start — whichever caller triggered it,
   * `ensureStarted()` at plugin startup or a later `open()` (after a failed
   * startup start, say) — with the channel PIs need (#993). The plugins hand
   * it to `createSettingsChannelPublisher(...).publish`, so a server that
   * came up late is still published and mirrored, not just the startup one.
   */
  onStarted?: (channel: { port: number; token: string }) => void;
  logger: ILogger;
}

export interface SettingsWindowController {
  /**
   * Start the server (idempotent) without opening a window; the PI bridge
   * needs the channel (#993).
   */
  ensureStarted(): Promise<{ port: number; token: string }>;
  /** Start the server if needed and open (or re-open) the window. */
  open(): Promise<SettingsWindowLaunch>;
  /** Stop the server and release the port. Idempotent. */
  close(): Promise<void>;
}

export function createSettingsWindowController(options: SettingsWindowControllerOptions): SettingsWindowController {
  const startServer = options.startServer ?? startSettingsWindowServer;
  const channelOf = (started: SettingsWindowServer): { port: number; token: string } => ({
    port: Number(new URL(started.url).port),
    token: started.token,
  });
  let server: SettingsWindowServer | undefined;
  // In-flight start, so concurrent first-callers (a startup ensureStarted()
  // racing an immediate open(), or two overlapping open() calls) share ONE
  // server instead of each binding a port — the loser would leak: its port,
  // WebSocketServer and settings subscription are only reachable through the
  // handle the second assignment overwrote. Cleared on settle, so a failed
  // start is retried by the next caller.
  let starting: Promise<SettingsWindowServer> | undefined;

  async function ensureServer(): Promise<SettingsWindowServer> {
    if (server !== undefined) return server;

    starting ??= startServer({
      page: options.renderPage?.(),
      assetsDir: options.assetsDir,
      pageFile: options.pageFile,
      settingsHost: options.settingsHost,
      openUrl: options.openUrl,
      onSendToPlugin: options.onSendToPlugin,
      simHub: options.simHub,
      onUpgradeDecision: (d) =>
        options.logger.debug(
          d.allowed
            ? `Settings socket accepted (origin: ${d.origin ?? "none"})`
            : `Settings socket rejected: ${d.reason} (origin: ${d.origin ?? "none"})`,
        ),
    }).then((started) => {
      server = started;
      options.logger.info("Settings window server started");
      // Origin only — the URL carries the auth token, and debug logs get
      // attached to support requests.
      options.logger.debug(`Settings window origin: ${new URL(started.url).origin}`);

      // A hook fault must not turn a started server into a rejected start
      // (every awaiting caller would see a failure for a server that is up).
      try {
        options.onStarted?.(channelOf(started));
      } catch (error: unknown) {
        options.logger.error("Settings window onStarted hook failed");
        options.logger.debug(String(error));
      }

      return started;
    });

    try {
      return await starting;
    } finally {
      starting = undefined;
    }
  }

  return {
    async ensureStarted() {
      return channelOf(await ensureServer());
    },

    async open() {
      const started = await ensureServer();

      const launch = await launchSettingsWindow({
        url: started.url,
        findBrowser: options.findBrowser,
        spawnApp: options.spawnApp,
        openUrl: options.openUrl,
        bounds: options.getWindowBounds?.(),
      });

      options.logger.info("Settings window opened");
      options.logger.debug(`Settings window launch: ${launch}`);

      return launch;
    },

    async close() {
      // A start already in flight (ensureStarted()/open() raced ahead of
      // this close()) must finish before we can close it — otherwise the
      // in-flight start's `server = started` assignment lands AFTER this
      // returns, leaking a running server nothing ever stops (#993). The
      // capture-then-await is synchronous with the `starting` read, so a
      // finally clearing it later can't race this check.
      const pendingStart = starting;

      if (pendingStart !== undefined) {
        await pendingStart.catch(() => undefined);
      }

      if (server === undefined) return;

      const closing = server;

      server = undefined;
      await closing.close();
      options.logger.info("Settings window server stopped");
    },
  };
}
