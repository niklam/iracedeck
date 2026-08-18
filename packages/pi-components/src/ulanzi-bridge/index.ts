/**
 * Ulanzi Property Inspector bridge.
 *
 * iRaceDeck PIs use the vendored Elgato `sdpi-components.js`, whose only
 * integration seam is the global `window.connectElgatoStreamDeckSocket(...)`: it
 * then opens its OWN WebSocket to `ws://localhost:{port}` and speaks the Elgato
 * wire protocol, with no hook to inject a transport. UlanziStudio neither calls
 * that global nor speaks the Elgato protocol — its PI reads connection params
 * from the page URL and speaks the flat `cmd` protocol.
 *
 * This shim bridges the two: it monkeypatches `window.WebSocket` with a class
 * that opens the REAL Ulanzi socket and translates frames both ways (see
 * ./translate) — EXCEPT global-settings frames (`getGlobalSettings` /
 * `setGlobalSettings` / `didReceiveGlobalSettings`), which the shared
 * settings-channel router (../settings-channel/router.ts) redirects to the
 * plugin's loopback settings server once it has read `_settingsChannel` from
 * the host's copy; until then — and if no channel is ever offered — they keep
 * going through the Ulanzi host exactly as before (issue #993, phase 2). It
 * then calls `connectElgatoStreamDeckSocket` with synthesized Elgato-shape
 * args. Everything downstream — sdpi-components and every `ird-*` component —
 * then works unchanged.
 *
 * The Ulanzi plugin's rollup build injects `<script src="ulanzi-pi-bridge.js">`
 * before `sdpi-components.js` into each generated PI HTML.
 */
import { openLoopbackSocket } from "../settings-channel/loopback.js";
import { createSettingsChannelRouter, type PiFrame, type SettingsChannelRouter } from "../settings-channel/router.js";
import { type BridgeIdentity, elgatoToUlanzi, encodeContext, PLUGIN_UUID, ulanziToElgato } from "./translate.js";

const WS_OPEN = 1;
const WS_CLOSED = 3;

/** Read the PI instance identity from a URL query string (`location.search`). */
export function readIdentity(search: string): BridgeIdentity {
  const p = new URLSearchParams(search);

  return {
    address: p.get("address") || "127.0.0.1",
    port: p.get("port") || "3906",
    uuid: p.get("uuid") || "",
    key: p.get("key") || "",
    actionid: p.get("actionid") || "",
    device: p.get("device") || "",
    language: p.get("language") || "en",
    controller: p.get("controller") || "Keypad",
  };
}

export interface UlanziBridgeOptions {
  warn?: (message: string) => void;
  /** Test hook; production uses the router's BOOTSTRAP_TIMEOUT_MS. */
  bootstrapTimeoutMs?: number;
}

/**
 * A WebSocket stand-in handed to sdpi-components. It mimics the WebSocket API
 * sdpi uses (`onopen` / `onmessage` / `send` / `readyState`) but internally opens
 * the REAL Ulanzi socket and translates every frame both ways — except
 * global-settings frames, which the settings-channel router may redirect to
 * the plugin's loopback server (see the module doc above).
 */
export class UlanziBridgeSocket {
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  readyState = 0;

  private readonly real: WebSocket;
  private readonly router: SettingsChannelRouter;

  constructor(identity: BridgeIdentity, Native: typeof WebSocket, options: UlanziBridgeOptions = {}) {
    this.real = new Native(`ws://${identity.address}:${identity.port}`);
    this.router = createSettingsChannelRouter({
      identity: { context: encodeContext(identity.uuid, identity.key, identity.actionid), action: identity.uuid },
      // sdpi never sends before its own onopen fires (after our onopen forwards
      // it, below), and a native WebSocket.send only throws while CONNECTING —
      // but guard on readyState anyway rather than relying on that ordering.
      toHost: (frame) => {
        const ulanzi = elgatoToUlanzi(frame, identity);

        if (ulanzi && this.readyState === WS_OPEN) this.real.send(JSON.stringify(ulanzi));
      },
      toPi: (frame) => this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent),
      openLoopback: (channel, handlers) => openLoopbackSocket(channel, handlers, Native),
      warn: options.warn ?? ((m: string) => console.warn(m)),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      bootstrapTimeoutMs: options.bootstrapTimeoutMs,
    });

    this.real.onopen = (ev): void => {
      this.readyState = WS_OPEN;
      const base = { uuid: identity.uuid, key: identity.key, actionid: identity.actionid };
      // Ulanzi handshake — the host expects `connected`, not Elgato's register frame.
      this.real.send(JSON.stringify({ code: 0, cmd: "connected", ...base }));
      // Tell the plugin a PI opened so it can refresh dynamic PI state (e.g. audio devices).
      this.real.send(
        JSON.stringify({ cmd: "sendToPlugin", ...base, payload: { event: "propertyInspectorDidAppear" } }),
      );
      this.onopen?.(ev);
      // Bootstrap read of the host's global-settings copy (plugin scope) — the
      // router decides from here whether global settings stay on the host path
      // or switch to the plugin's loopback server.
      this.router.onHostOpen();
    };

    this.real.onmessage = (ev: MessageEvent): void => {
      let frame: Record<string, unknown>;

      try {
        frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }

      const elgato = ulanziToElgato(frame, identity);

      if (elgato) this.router.onHostMessage(elgato as PiFrame);
    };

    this.real.onclose = (ev): void => {
      this.readyState = WS_CLOSED;
      this.router.onHostClose();
      this.onclose?.(ev as CloseEvent);
    };

    this.real.onerror = (ev): void => this.onerror?.(ev);
  }

  send(data: string): void {
    let frame: PiFrame;

    try {
      frame = JSON.parse(data) as PiFrame;
    } catch {
      return;
    }

    this.router.onPiSend(frame);
  }

  close(): void {
    this.readyState = WS_CLOSED;
    this.router.onHostClose();
    this.real.close();
  }
}

/**
 * Install the bridge on `win`: monkeypatch `WebSocket`, then drive sdpi's
 * `connectElgatoStreamDeckSocket` with synthesized Elgato-shape args. Exposed
 * (with an injectable `win`) so it can be unit-tested without a real DOM.
 */
export function installUlanziBridge(win: Window & typeof globalThis = window): void {
  const identity = readIdentity(win.location.search);
  const Native = win.WebSocket;

  // sdpi opens `new WebSocket("ws://localhost:{port}")`; hand it our bridge instead.
  (win as unknown as { WebSocket: unknown }).WebSocket = function ulanziWebSocket(): UlanziBridgeSocket {
    return new UlanziBridgeSocket(identity, Native);
  } as unknown as typeof WebSocket;

  const context = encodeContext(identity.uuid, identity.key, identity.actionid);
  const info = JSON.stringify({
    application: { language: identity.language, platform: "windows", version: "" },
    plugin: { uuid: PLUGIN_UUID, version: "" },
    devicePixelRatio: 1,
    colors: {},
  });
  const actionInfo = JSON.stringify({
    action: identity.uuid,
    context,
    device: identity.device,
    payload: { settings: {} },
  });

  const connect = (win as unknown as { connectElgatoStreamDeckSocket?: (...args: unknown[]) => void })
    .connectElgatoStreamDeckSocket;

  try {
    if (typeof connect === "function") {
      connect(identity.port, context, "registerPropertyInspector", info, actionInfo);
    }
  } finally {
    // Restore the native WebSocket even if connect throws: sdpi created its
    // (bridged) socket synchronously inside connect, so nothing else should be bridged.
    (win as unknown as { WebSocket: unknown }).WebSocket = Native;
  }
}

// Bootstrap once the DOM — and the synchronous sdpi-components.js script that
// redefines connectElgatoStreamDeckSocket — is ready. Guarded by a window check
// so importing this module under Node (tests) does not auto-run.
if (typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => installUlanziBridge());
  } else {
    installUlanziBridge();
  }
}
