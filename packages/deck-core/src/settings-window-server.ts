/**
 * Settings-window server (issue #992).
 *
 * A loopback HTTP + WebSocket server the plugin starts once and then keeps for
 * the rest of the plugin run: the plugin starts it at startup (#993 —
 * `SettingsWindowController.ensureStarted()`, so the `_settingsChannel`
 * port/token are known before any UI needs them), and a later "Open Settings"
 * starts it only if that startup start failed. `close()` releases the port and
 * is only called by tests / an explicit shutdown. The port is still ephemeral
 * (bound to `0`) and the per-server-start token still authenticates every
 * request — only the *lifetime* changed, not the auth model.
 *
 * Two roles:
 *  - HTTP: serve the settings page (and later its assets).
 *  - WebSocket `/ws`: the "fake deck host". sdpi-components on the page speaks
 *    the Elgato Property Inspector protocol to it exactly as it would to the
 *    real host, so every existing partial and `ird-*` component works
 *    unchanged. Only the global-settings subset is needed (every control on
 *    the settings page carries `global`): `getGlobalSettings` /
 *    `setGlobalSettings` / `didReceiveGlobalSettings`, plus `openUrl` and
 *    `logMessage`.
 *
 * Every HTTP request AND every WebSocket upgrade passes through
 * `authorizeSettingsRequest` (Origin first, then the per-server-start token).
 * No CORS header is ever emitted.
 *
 * Settings I/O goes through an injected `SettingsWindowHost` — the plugin binds
 * it to `getGlobalSettings` / `updateGlobalSettings` / `onGlobalSettingsChange`
 * — so this module never touches the global-settings singleton, and every
 * edit made here lands in the plugin-owned store like any other write (#993).
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, normalize, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";

import { sameValue } from "./global-settings.js";
import { stripRunScopedKeys } from "./run-scoped-settings.js";
import { authorizeSettingsRequest, type SettingsRequestDenial } from "./settings-window-guard.js";
import type { UpdateStatus } from "./update-check-service.js";

/** The plugin-side settings surface the fake host is bound to. */
export interface SettingsWindowHost {
  read(): Record<string, unknown>;
  write(partial: Record<string, unknown>): void;
  /** Subscribe to settings changes from ANY writer; returns an unsubscribe. */
  subscribe(listener: (settings: Record<string, unknown>) => void): () => void;
}

export interface SettingsWindowServerOptions {
  /**
   * Inline page HTML. Used for the placeholder page; when `assetsDir` is
   * given this is ignored and the page comes from `pageFile` instead.
   */
  page?: string;
  /**
   * Directory whose files are served by name (`/pi-components.js` etc.). The
   * plugin points this at its `ui/` folder so the compiled page's relative
   * `<script src>` tags resolve. Requests are confined to this directory.
   */
  assetsDir?: string;
  /** File inside `assetsDir` served at `/`. Read fresh on every request. */
  pageFile?: string;
  /** Settings I/O; when omitted the WebSocket host is not started (HTTP only). */
  settingsHost?: SettingsWindowHost;
  /** Opener for `openUrl` frames (external links on the page). http(s) only. */
  openUrl?: (url: string) => Promise<void>;
  /**
   * Receives the payload of any `sendToPlugin` frame the page sends — the
   * page's channel for things that are the plugin's to do (persist window
   * bounds, switch a deck's profile). Validation is the handler's job.
   */
  onSendToPlugin?: (payload: Record<string, unknown>) => void;
  /**
   * The plugin's SimHub view, served at `GET /simhub/roles` as
   * `{ reachable, roles }`. The page must NOT probe SimHub itself: from this
   * origin that is a cross-origin fetch SimHub answers with no CORS headers,
   * so it always looks unreachable. No host/port is taken from the page —
   * the plugin only ever talks to its configured SimHub, so no SSRF surface.
   */
  simHub?: { isReachable: () => boolean; getRoles: () => Promise<string[]> };
  /**
   * The plugin's upstream update check (#1016), served at
   * `GET /updates/status`. Same reason as `simHub` above: the window is a page
   * on this loopback origin, so fetching iracedeck.com from it is cross-origin
   * with no CORS. Nothing about the request reaches the outbound call — no
   * host, no path, no version — so there is no SSRF surface: the page asks for
   * a verdict, it does not say where to look for one.
   */
  updates?: { get(): Promise<UpdateStatus> };
  /**
   * Called for every WebSocket upgrade with the guard's decision and the
   * request's Origin (a PI page shows up as "null" or a host-served origin,
   * the window as the loopback origin). Diagnostics only — the controller logs
   * it at debug (#993 phase 2).
   */
  onUpgradeDecision?: (decision: {
    allowed: boolean;
    reason?: SettingsRequestDenial | "bad-path";
    origin: string | undefined;
  }) => void;
}

export interface SettingsWindowServer {
  /** Fully formed page URL, token included — hand this to the launcher. */
  readonly url: string;
  /**
   * The per-launch auth token, standalone — for callers (the plugin's
   * `_settingsChannel` publisher, #993) that need the token without parsing
   * it back out of `url`.
   */
  readonly token: string;
  /** Release the port. Safe to call more than once. */
  close(): Promise<void>;
}

const HOST = "127.0.0.1";
const WS_PATH = "/ws";

/** Frame shape sdpi-components sends. Everything else is ignored. */
interface PiFrame {
  event?: unknown;
  payload?: unknown;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

/**
 * Serve one file from `assetsDir`, confined to that directory (a normalized
 * resolved path that escapes it is a 404, never a read). Missing → 404.
 */
async function serveAsset(assetsDir: string, name: string, res: ServerResponse): Promise<void> {
  const root = resolve(assetsDir);
  const target = resolve(root, normalize(name));

  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(404);
    res.end();

    return;
  }

  try {
    const body = await readFile(target);

    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

/** The subset of `incoming` whose values differ from `current` (deck-core equality). */
function diffAgainst(current: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in current) || !sameValue(current[key], value)) changed[key] = value;
  }

  return changed;
}

/**
 * Parse the request target against `base`, or undefined when it is not a
 * valid URL. `new URL()` THROWS on targets like `//[` — and an exception that
 * escapes an `http` request/upgrade listener is an uncaught exception that
 * ends the plugin process. Any local process can send such a target to the
 * loopback port without a token, so parsing must never throw here.
 */
function requestUrl(req: IncomingMessage, base: string): URL | undefined {
  try {
    return new URL(req.url ?? "/", base);
  } catch {
    return undefined;
  }
}

/**
 * Session cookie carrying the launch token. The URL token authenticates only
 * the first navigation; the page's relative `<script src>` fetches and the
 * WebSocket upgrade carry no query string, so they authenticate by this cookie
 * instead. `SameSite=Strict` — never sent cross-site; `HttpOnly` — never
 * readable by page script; scoped to this loopback host, which a DNS-rebound
 * hostname is not.
 *
 * The name carries the PORT: cookies are host-scoped, not port-scoped, and
 * every plugin's window shares one browser profile (`--user-data-dir`), so
 * a second plugin's server (another port, another token) would otherwise
 * overwrite this window's cookie and its later cookie-authenticated fetches
 * (`/simhub/roles`) would start failing with 403.
 */
const SESSION_COOKIE_PREFIX = "ird_sw_";

function cookieOf(req: IncomingMessage, cookieName: string): string | undefined {
  const header = req.headers.cookie;

  if (!header) return undefined;

  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");

    if (name === cookieName) return rest.join("=");
  }

  return undefined;
}

/**
 * Answer one of the plugin-bound JSON endpoints the page cannot reach itself
 * (`/simhub/roles`, `/updates/status` — both cross-origin from the window, with
 * no CORS on the other side).
 *
 * `produce` runs on the plugin's side of the loopback; `fallback` is the body
 * sent if it throws, because a throwing delegate must become neither an
 * unhandled rejection (which would take the plugin process down) nor a request
 * that never ends (which would hang the pane waiting on it).
 */
function answerJson(res: ServerResponse, produce: () => Promise<unknown>, fallback: unknown): void {
  void (async () => {
    try {
      const body = await produce();

      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" });

      res.end(JSON.stringify(fallback));
    }
  })();
}

export async function startSettingsWindowServer(options: SettingsWindowServerOptions): Promise<SettingsWindowServer> {
  const token = randomBytes(24).toString("hex");
  // Set once the port is known; the guard needs it and requests can't arrive
  // before listen() resolves.
  let origin = "";
  let cookieName = SESSION_COOKIE_PREFIX;

  const authorize = (req: IncomingMessage, url: URL | undefined) =>
    authorizeSettingsRequest({
      origin: req.headers.origin,
      expectedOrigin: origin,
      token: url?.searchParams.get("t") ?? undefined,
      expectedToken: token,
      cookie: cookieOf(req, cookieName),
    });

  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const url = requestUrl(req, origin);

    if (url === undefined) {
      res.writeHead(400);
      res.end();

      return;
    }

    if (!authorize(req, url).allowed) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");

      return;
    }

    const pathname = url.pathname;

    // The page load is the one request that carries the URL token; hand back
    // the session cookie so every subsequent same-origin request can skip it.
    if (pathname === "/") {
      res.setHeader("set-cookie", `${cookieName}=${token}; Path=/; SameSite=Strict; HttpOnly`);
    }

    if (pathname === "/simhub/roles" && options.simHub) {
      const simHub = options.simHub;

      answerJson(
        res,
        async () => {
          const reachable = simHub.isReachable();

          return { reachable, roles: reachable ? await simHub.getRoles().catch(() => []) : [] };
        },
        { reachable: false, roles: [] },
      );

      return;
    }

    if (pathname === "/updates/status" && options.updates) {
      const updates = options.updates;

      answerJson(res, () => updates.get(), { state: "unavailable", installedVersion: "" });

      return;
    }

    if (options.assetsDir) {
      let name: string;

      try {
        // Throws on a malformed percent-escape (`/%E0`) — a 404, not a crash.
        name = pathname === "/" ? (options.pageFile ?? "index.html") : decodeURIComponent(pathname.slice(1));
      } catch {
        res.writeHead(404);
        res.end();

        return;
      }

      void serveAsset(options.assetsDir, name, res);

      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(options.page ?? "");
  };

  const server: Server = createServer((req, res) => {
    // Belt and braces: nothing thrown while handling a request may escape the
    // listener — that would take the whole plugin process down.
    try {
      handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500);

      res.end();
    }
  });

  const fakeHost = options.settingsHost
    ? attachFakeHost(
        server,
        options.settingsHost,
        options.openUrl,
        options.onSendToPlugin,
        authorize,
        options.onUpgradeDecision,
      )
    : undefined;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Settings window server did not bind a TCP port");
  }

  origin = `http://${HOST}:${address.port}`;
  cookieName = `${SESSION_COOKIE_PREFIX}${address.port}`;

  return {
    url: `${origin}/?t=${token}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        fakeHost?.close();
        server.close(() => resolve());
      }),
  };
}

/**
 * Wire the WebSocket fake host onto the HTTP server. Returns a closer that
 * unsubscribes from settings changes and terminates every socket.
 */
function attachFakeHost(
  server: Server,
  host: SettingsWindowHost,
  openUrl: ((url: string) => Promise<void>) | undefined,
  onSendToPlugin: ((payload: Record<string, unknown>) => void) | undefined,
  authorize: (req: IncomingMessage, url: URL | undefined) => ReturnType<typeof authorizeSettingsRequest>,
  onUpgradeDecision: SettingsWindowServerOptions["onUpgradeDecision"],
): { close: () => void } {
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  /** Last `didReceiveGlobalSettings` body sent per socket — identical pushes are skipped. */
  const lastPushed = new WeakMap<WebSocket, string>();
  /**
   * The socket whose `setGlobalSettings` is being written right now. The real
   * host never echoes a writer's own `setGlobalSettings` back to it (only the
   * OTHER side sees a `didReceiveGlobalSettings`), and neither may we: the
   * echo carries the PARSED cache, so a field the user just cleared (`""` →
   * schema default, e.g. SimHub host → 127.0.0.1) would refill under the
   * cursor and swallow the next keystrokes. `host.write` notifies listeners
   * synchronously, so a plain variable is enough to recognise the echo.
   */
  let writingFrom: WebSocket | undefined;

  const bodyOf = (settings: Record<string, unknown>): string =>
    JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings } });

  const push = (ws: WebSocket, settings: Record<string, unknown>, force = false): void => {
    if (ws.readyState !== ws.OPEN) return;

    const body = bodyOf(settings);

    // A payload the page already holds is a no-op for it — except that sdpi
    // re-applies every control's value on receipt, which discards keystrokes
    // still inside a text field's save debounce. Don't send what it has.
    if (!force && lastPushed.get(ws) === body) return;

    lastPushed.set(ws, body);
    ws.send(body);
  };

  // Any writer anywhere in the plugin (a PI, an action, a migration) updates
  // the window live — the same push the real host performs to the OTHER side.
  const unsubscribe = host.subscribe((settings) => {
    for (const ws of sockets) {
      if (ws === writingFrom) {
        // No echo to the writer — but remember the state it produced, so a
        // later identical fan-out (a host echo of this same write) is a no-op.
        lastPushed.set(ws, bodyOf(settings));
        continue;
      }

      push(ws, settings);
    }
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Same rule as the request listener: an exception here kills the process.
    const url = requestUrl(req, "http://x");
    const onPath = url?.pathname === WS_PATH;
    const decision = authorize(req, url);

    onUpgradeDecision?.({
      allowed: onPath && decision.allowed,
      reason: !decision.allowed ? decision.reason : onPath ? undefined : "bad-path",
      origin: req.headers.origin,
    });

    if (!onPath || !decision.allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();

      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
      // `ws` emits 'error' on a protocol violation (malformed frame, bad UTF-8);
      // an EventEmitter 'error' with no listener is thrown — and would end the
      // plugin process. Drop the peer instead.
      ws.on("error", () => ws.terminate());

      ws.on("message", (raw) => {
        let frame: PiFrame;

        try {
          frame = JSON.parse(String(raw)) as PiFrame;
        } catch {
          return;
        }

        switch (frame.event) {
          case "getGlobalSettings":
            // An explicit request is always answered, even with an unchanged payload.
            push(ws, host.read(), true);
            break;

          case "setGlobalSettings":
            if (frame.payload !== null && typeof frame.payload === "object" && !Array.isArray(frame.payload)) {
              // sdpi-components saves its WHOLE snapshot on every change. Hand
              // deck-core only the keys that actually differ from the current
              // cache — an optimisation, not a correctness guard (the plugin
              // is the single writer since #993): a full-snapshot write would
              // re-parse, re-notify every subscriber and re-save the file on
              // every keystroke-sized change. `sameValue` is deck-core's own
              // equality, so a value the PI persisted as a string ("80") does
              // not read as a change against the parsed cache value (80).
              //
              // Run-scoped keys are dropped first (#1014): no UI is ever the
              // producer of an observation about this run, and a page's
              // snapshot can be OLDER than the cache — a Property Inspector
              // that bootstrapped off the deck-host mirror is holding the
              // PREVIOUS run's `_warnings` until the first loopback push
              // replaces it, and any control the user touches in that window
              // would write that array straight back into the live cache,
              // resurrecting the very banner run-scoping exists to retire.
              const changed = diffAgainst(host.read(), stripRunScopedKeys(frame.payload as Record<string, unknown>));

              if (Object.keys(changed).length > 0) {
                // The subscribe() listener pushes the result to every OTHER
                // socket — the writer itself gets no echo, same as the real host.
                writingFrom = ws;

                try {
                  host.write(changed);
                } finally {
                  writingFrom = undefined;
                }
              }
            }

            break;

          case "openUrl": {
            const url = (frame.payload as { url?: unknown } | undefined)?.url;

            if (typeof url === "string" && /^https?:\/\//i.test(url) && openUrl) {
              void openUrl(url).catch(() => {});
            }

            break;
          }

          case "sendToPlugin":
            if (
              onSendToPlugin &&
              frame.payload !== null &&
              typeof frame.payload === "object" &&
              !Array.isArray(frame.payload)
            ) {
              onSendToPlugin(frame.payload as Record<string, unknown>);
            }

            break;

          // registerPropertyInspector, logMessage, and anything else: nothing to do.
          default:
            break;
        }
      });
    });
  });

  return {
    close: () => {
      unsubscribe();

      for (const ws of sockets) ws.terminate();

      wss.close();
    },
  };
}
