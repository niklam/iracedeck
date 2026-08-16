/// <reference lib="dom" />
/**
 * Property-Inspector settings bridge for the Elgato and Mirabox hosts
 * (issue #993, phase 2).
 *
 * Both hosts speak the Elgato PI protocol: after the page loads they call
 * `connectElgatoStreamDeckSocket(port, uuid, registerEvent, info, actionInfo)`
 * and sdpi-components opens ONE `ws://localhost:<port>` socket synchronously
 * inside that call. sdpi wraps any PRIOR definition of that global and calls it
 * first — so this script, injected before `sdpi-components.js`, pre-defines it:
 * when the host calls, our hook records the PI identity and arms a one-shot
 * `WebSocket` interceptor for the host URL; the interceptor hands sdpi a
 * `PiSettingsBridgeSocket` and restores the native constructor immediately.
 *
 * The bridged socket passes everything through to the deck host EXCEPT the
 * global-settings frames, which the shared settings-channel router redirects
 * to the plugin's loopback settings server once it has read `_settingsChannel`
 * from the host copy (see ../settings-channel/router.ts for the state machine
 * and its fallback rule). Never injected into settings-window.html — that page
 * has its own bridge; two bridges must never share a page.
 */
import { openLoopbackSocket } from "../settings-channel/loopback.js";
import { createSettingsChannelRouter, type PiFrame, type SettingsChannelRouter } from "../settings-channel/router.js";

const WS_OPEN = 1;
const WS_CLOSED = 3;

export interface PiSettingsBridgeOptions {
  warn?: (message: string) => void;
  /** Test hook; production uses the router's BOOTSTRAP_TIMEOUT_MS. */
  bootstrapTimeoutMs?: number;
}

/** The WebSocket sdpi-components gets on Elgato/Mirabox: the real host socket plus the settings-channel router. */
export class PiSettingsBridgeSocket {
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  readyState = 0;

  private readonly host: WebSocket;
  private readonly router: SettingsChannelRouter;

  constructor(
    hostUrl: string,
    identity: { context: string; action: string },
    Native: typeof WebSocket,
    options: PiSettingsBridgeOptions = {},
  ) {
    const warn = options.warn ?? ((m: string) => console.warn(m));

    this.host = new Native(hostUrl);
    this.router = createSettingsChannelRouter({
      identity,
      // sdpi never sends before its own onopen fires (after our onopen forwards
      // it, below), and a native WebSocket.send only throws while CONNECTING —
      // but guard on readyState anyway rather than relying on that ordering.
      toHost: (frame) => {
        if (this.readyState === WS_OPEN) this.host.send(JSON.stringify(frame));
      },
      toPi: (frame) => this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent),
      openLoopback: (channel, handlers) => openLoopbackSocket(channel, handlers, Native),
      warn,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      bootstrapTimeoutMs: options.bootstrapTimeoutMs,
    });

    this.host.onopen = (ev): void => {
      this.readyState = WS_OPEN;
      // sdpi's onopen sends the register frame (through our send); bootstrap after it.
      this.onopen?.(ev);
      this.router.onHostOpen();
    };

    this.host.onmessage = (ev: MessageEvent): void => {
      let frame: PiFrame;

      try {
        frame = JSON.parse(String(ev.data)) as PiFrame;
      } catch {
        this.onmessage?.(ev);

        return;
      }

      this.router.onHostMessage(frame);
    };

    this.host.onclose = (ev): void => {
      this.readyState = WS_CLOSED;
      this.router.onHostClose();
      this.onclose?.(ev as CloseEvent);
    };

    this.host.onerror = (ev): void => this.onerror?.(ev);
  }

  send(data: string): void {
    let frame: PiFrame;

    try {
      frame = JSON.parse(data) as PiFrame;
    } catch {
      this.host.send(data);

      return;
    }

    this.router.onPiSend(frame);
  }

  close(): void {
    this.router.onHostClose();
    this.host.close();
  }
}

function readAction(actionInfo: unknown): string {
  try {
    const parsed = JSON.parse(String(actionInfo)) as { action?: unknown };

    return typeof parsed.action === "string" ? parsed.action : "";
  } catch {
    return "";
  }
}

/**
 * Pre-define `connectElgatoStreamDeckSocket` so it runs first inside sdpi's
 * wrapper when the host connects the PI; exposed with an injectable `win` for
 * tests.
 */
export function installPiSettingsBridge(win: Window & typeof globalThis = window): void {
  const w = win as unknown as {
    WebSocket: typeof WebSocket;
    connectElgatoStreamDeckSocket?: (...args: unknown[]) => void;
    setTimeout: typeof setTimeout;
  };
  const prior = w.connectElgatoStreamDeckSocket;

  w.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, info, actionInfo) => {
    prior?.(port, uuid, registerEvent, info, actionInfo);

    const identity = { context: String(uuid), action: readAction(actionInfo) };
    const Native = w.WebSocket;
    const hostUrls = new Set([`ws://localhost:${String(port)}`, `ws://127.0.0.1:${String(port)}`]);
    let armed = true;

    const restore = (): void => {
      if (armed) {
        armed = false;
        w.WebSocket = Native;
      }
    };

    w.WebSocket = function interceptingWebSocket(url: string | URL, protocols?: string | string[]): WebSocket {
      if (armed && hostUrls.has(String(url))) {
        restore();

        return new PiSettingsBridgeSocket(String(url), identity, Native) as unknown as WebSocket;
      }

      return new Native(url, protocols);
    } as unknown as typeof WebSocket;

    // sdpi connects synchronously right after this hook returns; if it never
    // does (unexpected), do not leave the interceptor installed.
    w.setTimeout(restore, 0);
  };
}

if (typeof window !== "undefined") {
  installPiSettingsBridge(window);
}
