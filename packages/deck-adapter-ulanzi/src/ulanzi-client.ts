/**
 * Ulanzi Deck WebSocket Client
 *
 * Implements the UlanziStudio plugin WebSocket protocol directly in TypeScript.
 * Unlike VSD Craft (whose protocol mirrors Elgato's event names), Ulanzi uses a
 * flat envelope dispatched on a `cmd` field, synthesizes its context string
 * client-side, and carries settings in `param`. To keep the adapter layer
 * structurally identical to the proven Mirabox `VSDPlatformAdapter`, this client
 * NORMALIZES every Ulanzi frame into an Elgato-style {@link UlanziEvent} before
 * routing it.
 *
 * UlanziStudio passes connection parameters via process.argv:
 *   argv[2] = address (default 127.0.0.1)
 *   argv[3] = port    (default 3906)
 *   argv[4] = language
 */
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";
import { type WebSocket as WSType } from "ws";

/**
 * The iRaceDeck plugin UUID — shared verbatim with the Elgato and Mirabox
 * plugins. UlanziStudio only requires a main-service UUID to have four
 * dot-segments (it does not validate the prefix), so the plugin keeps the
 * canonical iRaceDeck UUID rather than adopting a Ulanzi-vendor namespace.
 * Because every action already exports `com.iracedeck.sd.core.<action>`, the
 * manifest declares those UUIDs directly and no remapping is needed.
 */
export const PLUGIN_UUID = "com.iracedeck.sd.core";

/**
 * Normalized, Elgato-style event the adapter consumes. The raw Ulanzi `cmd`
 * frame is translated into this shape by {@link normalizeFrame}.
 */
export interface UlanziEvent {
  event: string;
  action?: string;
  context?: string;
  payload?: {
    settings?: Record<string, unknown>;
    ticks?: number;
    /** Whether the dial button was held while rotating (rotate-while-pressed). */
    pressed?: boolean;
    controller?: string;
    [key: string]: unknown;
  };
}

/** Callback type for normalized Ulanzi event handlers. */
export type UlanziEventHandler = (data: UlanziEvent) => void | Promise<void>;

/**
 * Connection parameters for UlanziStudio (from process.argv). The plugin UUID is
 * a fixed identity, not a connection param — outbound frames use the
 * {@link PLUGIN_UUID} constant directly so it can never drift from the manifest.
 */
export interface UlanziConnectionParams {
  address: string;
  port: string;
  language: string;
}

/** Registration for a per-action event handler. */
interface ActionEventRegistration {
  uuid: string;
  event: string;
  handler: UlanziEventHandler;
}

/** WebSocket OPEN readyState constant. */
const WS_OPEN = 1;

/** Marker a Ulanzi PI bridge sends (via `sendToPlugin`) to signal it opened. */
const PI_APPEAR_MARKER = "propertyInspectorDidAppear";

/**
 * Marker the Ulanzi PI bridge sends (via `sendToPlugin`) to relay an external
 * link click. UlanziStudio ignores `openurl` sent on the PI socket but honours
 * it from the plugin socket, so the adapter re-sends the url from there (#845).
 */
const PI_OPEN_URL_MARKER = "openUrl";

/**
 * Marker the shared `ird-open-settings` PI button sends (via `sendToPlugin`)
 * to ask the plugin to open the dedicated settings window (#992). Surfaced as
 * a global `openSettings` event for the adapter's `onOpenSettingsRequest`.
 */
const PI_OPEN_SETTINGS_MARKER = "openSettings";

/** Parse UlanziStudio connection parameters from process.argv. */
export function parseConnectionParams(): UlanziConnectionParams {
  return {
    address: process.argv[2] ?? "127.0.0.1",
    port: process.argv[3] ?? "3906",
    language: process.argv[4] ?? "en",
  };
}

/** Build the Ulanzi context string for a key instance: `uuid___key___actionid`. */
export function encodeContext(uuid: string, key: string, actionid: string): string {
  return `${uuid}___${key}___${actionid}`;
}

/** Decode a Ulanzi context string back into its parts. */
export function decodeContext(context: string): { uuid: string; key: string; actionid: string } {
  const parts = context.split("___");

  return { uuid: parts[0] ?? "", key: parts[1] ?? "", actionid: parts[2] ?? "" };
}

/** Narrow an unknown value to a plain record (not an array). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Extract action settings from a frame. Ulanzi delivers action settings in
 * `param` (`add` / `paramfromapp` / `paramfromplugin`); reading `param` first
 * then `settings` covers frames that fall back to the SDK-doc field name.
 */
function settingsOf(frame: Record<string, unknown>): Record<string, unknown> {
  return asRecord(frame.param) ?? asRecord(frame.settings) ?? {};
}

/**
 * Extract global settings from a `didReceiveGlobalSettings` frame. Per the
 * Ulanzi SDK, global replies carry the payload in `settings` — read it first so
 * a reply that also carries an (empty) `param` record cannot shadow the actual
 * settings (#868). `param` stays as the fallback for host variants that use it.
 */
function globalSettingsOf(frame: Record<string, unknown>): Record<string, unknown> {
  return asRecord(frame.settings) ?? asRecord(frame.param) ?? {};
}

/** Build the context string from a frame's `uuid` / `key` / `actionid`. */
function frameContext(frame: Record<string, unknown>): string {
  return encodeContext(String(frame.uuid ?? ""), String(frame.key ?? ""), String(frame.actionid ?? ""));
}

/**
 * Convert a Ulanzi `rotateEvent` into a tick count. Ulanzi reports a discrete
 * direction (`left` / `right` / `hold-left` / `hold-right`) rather than a count,
 * so one rotate maps to ±1 — the sign is all iRaceDeck dial actions read.
 */
function ticksFromRotate(rotateEvent: unknown): number {
  return rotateEvent === "left" || rotateEvent === "hold-left" ? -1 : 1;
}

/**
 * Whether a Ulanzi `rotateEvent` is a rotation with the dial button held. The
 * wire encodes the held state as `hold-left` / `hold-right`; surfacing it as
 * `pressed` lets dial actions implement Push + Turn gestures (the adapter and
 * the deck-core payload already carry `pressed`, but the bare-rotate variants
 * leave it false).
 */
function pressedFromRotate(rotateEvent: unknown): boolean {
  return rotateEvent === "hold-left" || rotateEvent === "hold-right";
}

/**
 * Normalize a raw Ulanzi wire frame (keyed by `cmd`) into zero or more
 * Elgato-style {@link UlanziEvent}s. Most frames map 1:1; `clear` fans out to
 * one disappear event per item in its `param` array; `sendToPlugin` is surfaced
 * only for the known PI markers (PI-appear, openUrl); unused frames (`run`,
 * `setactive`, command acks) normalize to nothing.
 *
 * Pure and side-effect-free: settings backfill for press/dial events (which
 * carry no `param` on the wire) is the stateful client's responsibility.
 */
export function normalizeFrame(frame: Record<string, unknown>): UlanziEvent[] {
  const action = String(frame.uuid ?? "");
  const context = frameContext(frame);

  switch (frame.cmd) {
    case "add":
      return [{ event: "willAppear", action, context, payload: { settings: settingsOf(frame) } }];
    case "keydown":
      return [{ event: "keyDown", action, context, payload: { settings: {} } }];
    case "keyup":
      return [{ event: "keyUp", action, context, payload: { settings: {} } }];
    case "dialdown":
      return [{ event: "dialDown", action, context, payload: { settings: {} } }];
    case "dialup":
      return [{ event: "dialUp", action, context, payload: { settings: {} } }];
    case "dialrotate":
      return [
        {
          event: "dialRotate",
          action,
          context,
          payload: {
            settings: {},
            ticks: ticksFromRotate(frame.rotateEvent),
            pressed: pressedFromRotate(frame.rotateEvent),
          },
        },
      ];
    case "didReceiveSettings":
    case "paramfromapp":
    case "paramfromplugin":
      return [{ event: "didReceiveSettings", action, context, payload: { settings: settingsOf(frame) } }];
    case "clear":
      return normalizeClear(frame);
    case "didReceiveGlobalSettings":
      // The reply's scope uuid travels as `action` so the adapter can tell
      // plugin-scoped replies from action-scoped bootstrap fallbacks (#868).
      // Deliberately no `context`: the per-context settings cache in
      // handleFrame must not backfill global frames.
      return [{ event: "didReceiveGlobalSettings", action, payload: { settings: globalSettingsOf(frame) } }];
    case "sendToPlugin": {
      const payload = asRecord(frame.payload);

      if (payload?.event === PI_APPEAR_MARKER) return [{ event: "propertyInspectorDidAppear", action, context }];

      // Pass the url through only when it is already a string — no coercion, so
      // a malformed marker normalizes to nothing (the adapter validates further).
      if (payload?.event === PI_OPEN_URL_MARKER && typeof payload.url === "string") {
        return [{ event: "openUrl", action, context, payload: { url: payload.url } }];
      }

      if (payload?.event === PI_OPEN_SETTINGS_MARKER) return [{ event: "openSettings", action, context }];

      return [];
    }
    default:
      return [];
  }
}

/** Fan a `clear` frame's `param` array out to one disappear event per item. */
function normalizeClear(frame: Record<string, unknown>): UlanziEvent[] {
  const items = Array.isArray(frame.param) ? (frame.param as Array<Record<string, unknown>>) : [];

  return items.map((item) => ({
    event: "willDisappear",
    action: String(item.uuid ?? ""),
    context: encodeContext(String(item.uuid ?? ""), String(item.key ?? ""), String(item.actionid ?? "")),
    payload: { settings: {} },
  }));
}

/**
 * Low-level WebSocket client for the UlanziStudio plugin protocol. Handles
 * connection, the `connected` handshake, frame normalization + routing, a
 * per-context settings cache (Ulanzi omits settings from press/dial frames), and
 * outbound commands.
 */
export class UlanziClient {
  private ws: WSType | null = null;
  private readonly params: UlanziConnectionParams;
  private readonly actionHandlers: ActionEventRegistration[] = [];
  private readonly globalHandlers = new Map<string, UlanziEventHandler[]>();
  private readonly logger: ILogger;
  private readonly onClose: () => void;

  /**
   * Latest settings per context. Ulanzi only carries settings on `add` /
   * `paramfromapp`; `keydown` / `keyup` / `dial*` / `clear` frames omit them, so
   * the client backfills these events from this cache before routing — otherwise
   * actions would fire with empty settings.
   */
  private readonly contextSettings = new Map<string, Record<string, unknown>>();

  constructor(
    params: UlanziConnectionParams,
    logger: ILogger = silentLogger,
    onClose: () => void = () => process.exit(0),
  ) {
    this.params = params;
    this.logger = logger;
    this.onClose = onClose;
  }

  /** Register a handler for a specific action UUID and normalized event type. */
  onActionEvent(uuid: string, event: string, handler: UlanziEventHandler): void {
    this.actionHandlers.push({ uuid, event, handler });
  }

  /** Register a handler for a global (non-action) normalized event. */
  onGlobalEvent(event: string, handler: UlanziEventHandler): void {
    const handlers = this.globalHandlers.get(event) ?? [];
    handlers.push(handler);
    this.globalHandlers.set(event, handlers);
  }

  /** Connect to UlanziStudio and start receiving events. */
  async connect(): Promise<void> {
    if (!this.params.port) {
      this.logger.error("No port provided — cannot connect to UlanziStudio");

      return;
    }

    this.logger.info("Connecting to UlanziStudio");
    this.logger.debug(`WebSocket address: ${this.params.address}:${this.params.port}, UUID: ${PLUGIN_UUID}`);

    // Dynamic import to avoid bundling issues with the native CommonJS module
    const { WebSocket } = await import("ws");
    this.ws = new WebSocket(`ws://${this.params.address}:${this.params.port}`);

    this.ws.on("open", () => {
      this.logger.info("Connected to UlanziStudio");
      // Ulanzi handshake — no separate registration payload (the host already
      // parsed manifest.json from disk).
      this.send({ code: 0, cmd: "connected", uuid: PLUGIN_UUID });
      this.requestGlobalSettings();
    });

    this.ws.on("message", (raw: Buffer | string) => {
      const text = raw.toString();

      // Wire-level frame log (debug level = the PI "Enable debug logging"
      // toggle): global-settings reply shape and routing vary across
      // UlanziStudio versions, so support logs must show exactly what
      // arrived (#868). Truncated to keep oversized frames from flooding
      // the per-day log file.
      this.logger.debug(`Received frame: ${text.length > 2000 ? `${text.slice(0, 2000)}…` : text}`);

      try {
        this.handleFrame(JSON.parse(text) as Record<string, unknown>);
      } catch (error) {
        this.logger.error(`Failed to parse WebSocket message: ${error}`);
      }
    });

    this.ws.on("close", () => {
      this.logger.info("Disconnected from UlanziStudio");
      this.onClose();
    });

    this.ws.on("error", (error: Error) => {
      this.logger.error(`WebSocket error: ${error.message}`);
    });
  }

  /**
   * Normalize a raw frame, maintain the per-context settings cache, and route
   * each resulting event. The SDK ignores ack/response frames (`code` set unless
   * `cmdType === "REQUEST"`) — except a `didReceiveGlobalSettings` that carries
   * settings, which is a request reply the client must keep (#868); event
   * frames omit `code`.
   */
  private handleFrame(frame: Record<string, unknown>): void {
    if (frame.code !== undefined && frame.cmdType !== "REQUEST") {
      // Ack/response frames drop — with one exception: the host may reply to
      // an explicit `getGlobalSettings` request with an ack-shaped frame
      // (`code` set) that carries the settings payload. Dropping it would
      // lose the boot-time settings restore (#868). Data-less global-settings
      // acks (plain write confirmations) still drop.
      const carriesGlobalSettings =
        frame.cmd === "didReceiveGlobalSettings" && Object.keys(globalSettingsOf(frame)).length > 0;

      if (!carriesGlobalSettings) {
        return;
      }
    }

    for (const ev of normalizeFrame(frame)) {
      const ctx = ev.context;

      if (ctx && ev.payload) {
        if (ev.event === "willAppear" || ev.event === "didReceiveSettings") {
          // These frames carry fresh settings — cache them.
          this.contextSettings.set(ctx, ev.payload.settings ?? {});
        } else {
          // Press / dial / disappear frames omit settings — backfill from cache.
          ev.payload.settings = this.contextSettings.get(ctx) ?? ev.payload.settings ?? {};
        }
      }

      void this.routeEvent(ev);

      if (ev.event === "willDisappear" && ctx) {
        this.contextSettings.delete(ctx);
      }
    }
  }

  /** Route a normalized event to the appropriate handler(s). */
  private async routeEvent(data: UlanziEvent): Promise<void> {
    const { event, action } = data;

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

  /** Send a JSON message to UlanziStudio. */
  private send(message: Record<string, unknown>): void {
    if (this.ws?.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  // --- Outbound commands ---

  /**
   * Set a key/dial image. iRaceDeck icons are `data:image/svg+xml,...` URIs with
   * the title already baked in, so the single `state` frame carries the data URI
   * as base64-data-type (`type:1`) and sets `showtext:false` — Ulanzi must not
   * draw its own duplicate label.
   */
  setImage(context: string, dataUri: string): void {
    const { uuid, key, actionid } = decodeContext(context);

    this.send({
      cmd: "state",
      uuid,
      key,
      actionid,
      param: {
        statelist: [{ uuid, key, actionid, type: 1, data: dataUri, textData: "", showtext: false }],
      },
    });
  }

  setSettings(context: string, settings: Record<string, unknown>): void {
    const { uuid, key, actionid } = decodeContext(context);

    this.send({ cmd: "setSettings", uuid, key, actionid, settings });
  }

  /**
   * Request global settings. Plugin scope by default; pass an action context
   * for the adapter's boot-time bootstrap read — the Ulanzi SDK documents that
   * a main-service `getGlobalSettings` must carry an action context to be
   * answered (#868). Writes never take a context: they must always land in the
   * plugin-scope bucket (see {@link setGlobalSettings}).
   */
  requestGlobalSettings(context?: string): void {
    const scope = context ? decodeContext(context) : { uuid: PLUGIN_UUID, key: "", actionid: "" };

    this.send({ cmd: "getGlobalSettings", ...scope });
  }

  /**
   * Persist global settings. Always plugin-scoped: UlanziStudio buckets the
   * store by the frame's `uuid`, and the boot-time restore reads the plugin
   * bucket — a write scoped any other way would be invisible after a restart
   * (#868, the original key-bindings-lost bug).
   */
  setGlobalSettings(settings: Record<string, unknown>): void {
    this.send({ cmd: "setGlobalSettings", uuid: PLUGIN_UUID, key: "", actionid: "", settings });
  }

  /**
   * Open a URL in the user's default browser. Best-effort: harmless if the
   * UlanziStudio host ignores the `openurl` command.
   */
  openUrl(url: string): void {
    this.send({ cmd: "openurl", url, local: false, param: "" });
  }
}
