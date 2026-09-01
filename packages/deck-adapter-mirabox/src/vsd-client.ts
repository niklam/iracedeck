/**
 * VSDinside WebSocket Client
 *
 * Implements the VSD Craft plugin WebSocket protocol directly in TypeScript.
 * The VSD protocol is similar to Elgato's: connect to ws://127.0.0.1:{port},
 * send a registration message, then exchange JSON events.
 *
 * VSD Craft passes connection parameters via process.argv:
 *   argv[3] = port
 *   argv[5] = plugin UUID
 *   argv[7] = register event name
 *   argv[9] = JSON info (includes application.language)
 */
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";
import { type WebSocket as WSType } from "ws";

/**
 * Event data received from VSD Craft via WebSocket.
 */
export interface VSDEvent {
  event: string;
  action?: string;
  context?: string;
  payload?: {
    settings?: Record<string, unknown>;
    ticks?: number;
    /** Whether the dial button was held while rotating (rotate-while-pressed). */
    pressed?: boolean;
    coordinates?: { column: number; row: number };
    controller?: string;
    [key: string]: unknown;
  };
}

/**
 * Callback type for VSD event handlers.
 */
export type VSDEventHandler = (data: VSDEvent) => void | Promise<void>;

/**
 * Connection parameters for VSD Craft.
 */
export interface VSDConnectionParams {
  port: string;
  pluginUuid: string;
  registerEvent: string;
}

/**
 * Registration for a per-action event handler.
 */
interface ActionEventRegistration {
  uuid: string;
  event: string;
  handler: VSDEventHandler;
}

/** WebSocket OPEN readyState constant */
const WS_OPEN = 1;

/**
 * Parse VSD Craft connection parameters from process.argv.
 */
export function parseConnectionParams(): VSDConnectionParams {
  return {
    port: process.argv[3] ?? "",
    pluginUuid: process.argv[5] ?? "",
    registerEvent: process.argv[7] ?? "",
  };
}

/**
 * Low-level WebSocket client for the VSD Craft plugin protocol.
 * Handles connection, registration, event routing, and outbound commands.
 */
export class VSDClient {
  private ws: WSType | null = null;
  private readonly params: VSDConnectionParams;
  private readonly actionHandlers: ActionEventRegistration[] = [];
  private readonly globalHandlers = new Map<string, VSDEventHandler[]>();
  private readonly logger: ILogger;
  private readonly onClose: () => void;

  /**
   * The most recent `setGlobalSettings` call made while the host socket wasn't
   * open yet, held until `open` fires. Only the latest payload matters — every
   * caller sends the whole settings object, so an earlier stashed call is
   * always superseded rather than queued (#993).
   */
  private pendingGlobalSettings: Record<string, unknown> | null = null;

  /**
   * Subscribers waiting for the host socket to be usable (#1056). deck-core
   * uses this to restart the settings-migration deadline from the point its
   * read can actually be answered, rather than from the point it was issued
   * into a socket that was still closed.
   */
  private readonly hostReadyCallbacks: Array<() => void> = [];

  constructor(
    params: VSDConnectionParams,
    logger: ILogger = silentLogger,
    onClose: () => void = () => process.exit(0),
  ) {
    this.params = params;
    this.logger = logger;
    this.onClose = onClose;
  }

  /**
   * Register a handler for a specific action UUID and event type.
   */
  onActionEvent(uuid: string, event: string, handler: VSDEventHandler): void {
    this.actionHandlers.push({ uuid, event, handler });
  }

  /**
   * Register a handler for a global (non-action) event.
   */
  onGlobalEvent(event: string, handler: VSDEventHandler): void {
    const handlers = this.globalHandlers.get(event) ?? [];
    handlers.push(handler);
    this.globalHandlers.set(event, handlers);
  }

  /**
   * Connect to VSD Craft and start receiving events.
   */
  async connect(): Promise<void> {
    if (!this.params.port) {
      this.logger.error("No port provided — cannot connect to VSD Craft");

      return;
    }

    this.logger.info("Connecting to VSD Craft");
    this.logger.debug(`WebSocket port: ${this.params.port}, UUID: ${this.params.pluginUuid}`);

    // Dynamic import to avoid bundling issues with native CommonJS module
    const { WebSocket } = await import("ws");
    this.ws = new WebSocket(`ws://127.0.0.1:${this.params.port}`);

    this.ws.on("open", () => {
      try {
        this.logger.info("Connected to VSD Craft");
        this.send({ uuid: this.params.pluginUuid, event: this.params.registerEvent });
        this.requestGlobalSettings();

        if (this.pendingGlobalSettings) {
          const settings = this.pendingGlobalSettings;

          this.pendingGlobalSettings = null;
          this.setGlobalSettings(settings);
          this.logger.debug("Flushed the deferred setGlobalSettings");
        }
      } finally {
        // Last, so a subscriber hears "the host is reachable" only once the
        // connect-time read above is actually on the wire (#1056) — but in a
        // `finally`, because a throw anywhere above (a `JSON.stringify` on the
        // mirror payload, a failing log sink) would otherwise skip the notify
        // and silently reinstate the very bug #1056 fixes: deck-core would keep
        // the deadline it measured from the closed-socket read.
        this.notifyHostReady();
      }
    });

    this.ws.on("message", (raw: Buffer | string) => {
      try {
        const data = JSON.parse(raw.toString()) as VSDEvent;
        this.routeEvent(data);
      } catch (error) {
        this.logger.error(`Failed to parse WebSocket message: ${error}`);
      }
    });

    this.ws.on("close", () => {
      this.logger.info("Disconnected from VSD Craft");
      this.onClose();
    });

    this.ws.on("error", (error: Error) => {
      this.logger.error(`WebSocket error: ${error.message}`);
    });
  }

  /**
   * Route an incoming event to the appropriate handler(s).
   */
  private async routeEvent(data: VSDEvent): Promise<void> {
    const { event, action } = data;

    // Route to action-specific handlers
    if (action) {
      for (const reg of this.actionHandlers) {
        if (reg.uuid === action && reg.event === event) {
          try {
            await reg.handler(data);
          } catch (error) {
            this.logger.error(`Error dispatching ${event} for ${action}: ${error}`);
          }
        }
      }
    }

    // Route to global event handlers
    const globalHandlers = this.globalHandlers.get(event);

    if (globalHandlers) {
      for (const handler of globalHandlers) {
        try {
          await handler(data);
        } catch (error) {
          this.logger.error(`Error dispatching global ${event}: ${error}`);
        }
      }
    }
  }

  /**
   * Subscribe to the host socket becoming usable (#1056) — fired from the
   * `open` handler, or immediately when the socket is already open.
   *
   * Fires a given subscriber exactly ONCE, which is the contract
   * `IDeckPlatformAdapter.onHostReady` publishes: the list is cleared as it is
   * fired, so a second `open` (a reconnect, or a second `connect()` in a test
   * or the harness, where `onClose` does not end the process) cannot re-notify
   * a subscriber that already ran. deck-core guards its own re-arm as well, but
   * a consumer should not have to read this file to learn that it must.
   *
   * KEEP IN SYNC with `UlanziClient.onHostReady` / `notifyHostReady`, which are
   * deliberate near-duplicates of these — like the two `FileSink`s.
   */
  onHostReady(callback: () => void): void {
    if (this.ws?.readyState === WS_OPEN) {
      // Same isolation as the `open` path: a throw here would otherwise escape
      // into deck-core's settings load and be misreported as a settings-file
      // failure.
      this.fireHostReady(callback);

      return;
    }

    this.hostReadyCallbacks.push(callback);
  }

  /** Fire the host-ready subscribers exactly once each, isolating a throwing one. */
  private notifyHostReady(): void {
    // Splice rather than iterate-then-clear: a subscriber that re-subscribes
    // while running must land in the NEXT batch, not this one.
    const callbacks = this.hostReadyCallbacks.splice(0, this.hostReadyCallbacks.length);

    for (const callback of callbacks) this.fireHostReady(callback);
  }

  /** Run one host-ready subscriber, keeping its failure to itself. */
  private fireHostReady(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.logger.error(`Host-ready subscriber failed: ${error}`);
    }
  }

  /**
   * Send a JSON message to VSD Craft.
   */
  private send(message: Record<string, unknown>): void {
    if (this.ws?.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  // --- Outbound commands ---

  setImage(context: string, dataUri: string): void {
    this.send({
      event: "setImage",
      context,
      payload: { target: 0, image: dataUri },
    });
  }

  setTitle(context: string, title: string): void {
    this.send({
      event: "setTitle",
      context,
      payload: { target: 0, title },
    });
  }

  /**
   * Read the deck host's global settings.
   *
   * deck-core issues this once per start for the one-time settings migration,
   * as soon as it finds no settings file. `initGlobalSettings` runs before
   * `adapter.connect()` and the read fires when the store's file load resolves
   * — an `ENOENT` a tick or two later — so it usually arrives here before the
   * socket is open, and `send()` discards anything written while it is not.
   *
   * Nothing misbehaves: the `open` handler in {@link connect} reissues this
   * same read. What was missing is any trace that a read had been attempted at
   * all — no frame, no line — which on the migration path is an hour of a
   * support thread before anyone thinks to check (#1046). Unlike Ulanzi there
   * is no addressing hazard alongside it: the VSD protocol's
   * `getGlobalSettings` carries only `context`, so there is no scope to get
   * wrong (#1041 was Ulanzi-only).
   */
  requestGlobalSettings(): void {
    if (this.ws?.readyState !== WS_OPEN) {
      // Say so rather than dropping the frame silently, which is what left a
      // Mirabox support log with no evidence either way — and at INFO, not
      // debug. `debugLogging` is applied from the schema-DEFAULT
      // cache at startup and the persisted value only arrives once the store
      // is ready — strictly after this read — so a debug line would be
      // suppressed for exactly the user whose log we would need. That is the
      // only observable difference between this guard and the readyState check
      // inside `send()`, and it is the whole point of the change.
      //
      // No stash, unlike `setGlobalSettings` below: the `open` handler issues
      // this same read unconditionally, so it asks the question this call could
      // not, and stashing would only put a duplicate frame on the wire. Note
      // the OTHER ordering — deck-core ignores any payload arriving before it
      // asked (`!migrationRequested`), so when the socket opens first the
      // connect-time reply is discarded and the migration completes on
      // deck-core's own read, sent moments later with the socket already open.
      // Both reads are load-bearing, one per ordering; do not de-duplicate
      // them.
      //
      // This explanation is only true while the `open` handler is what covers
      // the dropped read. A change to who issues the migration read, or to when
      // it is issued, must revisit this comment rather than leave a confident
      // wrong one behind.
      this.logger.info(
        "Global-settings read requested while the host socket was not open; the connect-time read will ask in its place",
      );

      return;
    }

    this.send({
      event: "getGlobalSettings",
      context: this.params.pluginUuid,
    });
  }

  setSettings(context: string, settings: Record<string, unknown>): void {
    this.send({
      event: "setSettings",
      context,
      payload: settings,
    });
  }

  /**
   * Persist global settings on the deck host.
   *
   * Each plugin sends exactly one host-mirror `setGlobalSettings` write per
   * start, right after the settings server's `ensureStarted()` resolves — and
   * that write can race the host connect. On Mirabox the log showed the mirror
   * leaving ~3s before `VSDClient` logged "Connected to VSD Craft"; `send()`
   * silently drops any frame while the socket isn't open, so the race quietly
   * ate the write and every Property Inspector bootstrapped against a
   * channel-less host copy (#993). Elgato never hits this — its SDK's own
   * `setGlobalSettings` awaits the connection internally.
   *
   * Defer instead: if the socket isn't open yet, stash the settings and flush
   * them once `open` fires. Only the latest call is kept — every caller
   * replaces the whole settings object, so an earlier stashed call is already
   * stale.
   */
  setGlobalSettings(settings: Record<string, unknown>): void {
    if (this.ws?.readyState === WS_OPEN) {
      this.send({
        event: "setGlobalSettings",
        context: this.params.pluginUuid,
        payload: settings,
      });

      return;
    }

    this.pendingGlobalSettings = settings;
    this.logger.debug("Deferring setGlobalSettings until the host socket is open");
  }

  /**
   * Open a URL in the user's default browser. Best-effort: the VSD Craft protocol
   * mirrors Elgato's event names, so this is harmless if the Stream Dock host
   * ignores the `openUrl` event.
   */
  openUrl(url: string): void {
    this.send({
      event: "openUrl",
      context: this.params.pluginUuid,
      payload: { url },
    });
  }
}
