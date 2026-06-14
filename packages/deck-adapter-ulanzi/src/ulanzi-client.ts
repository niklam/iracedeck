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

import { ULANZI_PLUGIN_UUID } from "./action-uuid.js";

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
    controller?: string;
    [key: string]: unknown;
  };
}

/** Callback type for normalized Ulanzi event handlers. */
export type UlanziEventHandler = (data: UlanziEvent) => void | Promise<void>;

/** Connection parameters for UlanziStudio. */
export interface UlanziConnectionParams {
  address: string;
  port: string;
  language: string;
  pluginUuid: string;
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

/** Parse UlanziStudio connection parameters from process.argv. */
export function parseConnectionParams(): UlanziConnectionParams {
  return {
    address: process.argv[2] ?? "127.0.0.1",
    port: process.argv[3] ?? "3906",
    language: process.argv[4] ?? "en",
    pluginUuid: ULANZI_PLUGIN_UUID,
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
 * Extract action settings from a frame. Ulanzi delivers settings in `param`
 * (`add` / `paramfromapp` / `paramfromplugin`); global-settings replies use
 * `settings`. Reading `param` first then `settings` covers both.
 */
function settingsOf(frame: Record<string, unknown>): Record<string, unknown> {
  return asRecord(frame.param) ?? asRecord(frame.settings) ?? {};
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
 * Normalize a raw Ulanzi wire frame (keyed by `cmd`) into zero or more
 * Elgato-style {@link UlanziEvent}s. Most frames map 1:1; `clear` fans out to
 * one disappear event per item in its `param` array; `sendToPlugin` is surfaced
 * only for the PI-appear marker; unused frames (`run`, `setactive`, command
 * acks) normalize to nothing.
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
        { event: "dialRotate", action, context, payload: { settings: {}, ticks: ticksFromRotate(frame.rotateEvent) } },
      ];
    case "didReceiveSettings":
    case "paramfromapp":
    case "paramfromplugin":
      return [{ event: "didReceiveSettings", action, context, payload: { settings: settingsOf(frame) } }];
    case "clear":
      return normalizeClear(frame);
    case "didReceiveGlobalSettings":
      return [{ event: "didReceiveGlobalSettings", payload: { settings: settingsOf(frame) } }];
    case "sendToPlugin":
      return asRecord(frame.payload)?.event === PI_APPEAR_MARKER
        ? [{ event: "propertyInspectorDidAppear", action, context }]
        : [];
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
    this.logger.debug(`WebSocket address: ${this.params.address}:${this.params.port}, UUID: ${this.params.pluginUuid}`);

    // Dynamic import to avoid bundling issues with the native CommonJS module
    const { WebSocket } = await import("ws");
    this.ws = new WebSocket(`ws://${this.params.address}:${this.params.port}`);

    this.ws.on("open", () => {
      this.logger.info("Connected to UlanziStudio");
      // Ulanzi handshake — no separate registration payload (the host already
      // parsed manifest.json from disk).
      this.send({ code: 0, cmd: "connected", uuid: this.params.pluginUuid });
      this.requestGlobalSettings();
    });

    this.ws.on("message", (raw: Buffer | string) => {
      try {
        this.handleFrame(JSON.parse(raw.toString()) as Record<string, unknown>);
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
   * `cmdType === "REQUEST"`); event frames omit `code`.
   */
  private handleFrame(frame: Record<string, unknown>): void {
    if (frame.code !== undefined && frame.cmdType !== "REQUEST") {
      return;
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

  requestGlobalSettings(): void {
    this.send({ cmd: "getGlobalSettings", uuid: this.params.pluginUuid, key: "", actionid: "" });
  }

  setGlobalSettings(settings: Record<string, unknown>): void {
    this.send({ cmd: "setGlobalSettings", uuid: this.params.pluginUuid, key: "", actionid: "", settings });
  }

  /**
   * Open a URL in the user's default browser. Best-effort: harmless if the
   * UlanziStudio host ignores the `openurl` command.
   */
  openUrl(url: string): void {
    this.send({ cmd: "openurl", url, local: false, param: "" });
  }
}
