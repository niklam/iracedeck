/**
 * Settings-window server (issue #992).
 *
 * A loopback HTTP + WebSocket server the plugin process starts ON DEMAND —
 * when the user opens the settings window — and tears down when the window
 * closes. Binding at open-time rather than plugin startup keeps the surface
 * alive only while it is actually in use.
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
 * `authorizeSettingsRequest` (Origin first, then the per-launch token). No
 * CORS header is ever emitted.
 *
 * Settings I/O goes through an injected `SettingsWindowHost` — the plugin binds
 * it to `getGlobalSettings` / `updateGlobalSettings` / `onGlobalSettingsChange`
 * — so this module never touches the global-settings singleton and the #896
 * single-writer guarantees hold by construction.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, normalize, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";

import { sameValue } from "./global-settings.js";
import { authorizeSettingsRequest } from "./settings-window-guard.js";

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
}

export interface SettingsWindowServer {
  /** Fully formed page URL, token included — hand this to the launcher. */
  readonly url: string;
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

function tokenOf(req: IncomingMessage, origin: string): string | undefined {
  return new URL(req.url ?? "/", origin).searchParams.get("t") ?? undefined;
}

/**
 * Session cookie carrying the launch token. The URL token authenticates only
 * the first navigation; the page's relative `<script src>` fetches and the
 * WebSocket upgrade carry no query string, so they authenticate by this cookie
 * instead. `SameSite=Strict` — never sent cross-site; `HttpOnly` — never
 * readable by page script; scoped to this loopback host, which a DNS-rebound
 * hostname is not.
 */
const SESSION_COOKIE = "ird_sw";

function cookieOf(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;

  if (!header) return undefined;

  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");

    if (name === SESSION_COOKIE) return rest.join("=");
  }

  return undefined;
}

export async function startSettingsWindowServer(options: SettingsWindowServerOptions): Promise<SettingsWindowServer> {
  const token = randomBytes(24).toString("hex");
  // Set once the port is known; the guard needs it and requests can't arrive
  // before listen() resolves.
  let origin = "";

  const authorize = (req: IncomingMessage) =>
    authorizeSettingsRequest({
      origin: req.headers.origin,
      expectedOrigin: origin,
      token: tokenOf(req, origin),
      expectedToken: token,
      cookie: cookieOf(req),
    });

  const server: Server = createServer((req, res) => {
    if (!authorize(req).allowed) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");

      return;
    }

    const pathname = new URL(req.url ?? "/", origin).pathname;

    // The page load is the one request that carries the URL token; hand back
    // the session cookie so every subsequent same-origin request can skip it.
    if (pathname === "/") {
      res.setHeader("set-cookie", `${SESSION_COOKIE}=${token}; Path=/; SameSite=Strict; HttpOnly`);
    }

    if (pathname === "/simhub/roles" && options.simHub) {
      const simHub = options.simHub;

      void (async () => {
        const reachable = simHub.isReachable();
        const roles = reachable ? await simHub.getRoles().catch(() => []) : [];

        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ reachable, roles }));
      })();

      return;
    }

    if (options.assetsDir) {
      const name = pathname === "/" ? (options.pageFile ?? "index.html") : decodeURIComponent(pathname.slice(1));

      void serveAsset(options.assetsDir, name, res);

      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(options.page ?? "");
  });

  const wss = options.settingsHost
    ? attachFakeHost(server, options.settingsHost, options.openUrl, options.onSendToPlugin, authorize)
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

  return {
    url: `${origin}/?t=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        wss?.close();
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
  authorize: (req: IncomingMessage) => { allowed: boolean },
): { close: () => void } {
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  const push = (ws: WebSocket, settings: Record<string, unknown>): void => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings } }));
    }
  };

  // Any writer anywhere in the plugin (a PI, an action, a migration) updates
  // the window live — the same push the real host performs.
  const unsubscribe = host.subscribe((settings) => {
    for (const ws of sockets) push(ws, settings);
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== WS_PATH || !authorize(req).allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();

      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));

      ws.on("message", (raw) => {
        let frame: PiFrame;

        try {
          frame = JSON.parse(String(raw)) as PiFrame;
        } catch {
          return;
        }

        switch (frame.event) {
          case "getGlobalSettings":
            push(ws, host.read());
            break;

          case "setGlobalSettings":
            if (frame.payload !== null && typeof frame.payload === "object" && !Array.isArray(frame.payload)) {
              // sdpi-components saves its WHOLE snapshot on every change. Hand
              // deck-core only the keys that actually differ from the current
              // cache: a full-object write marks every key pending with its
              // previous value as "superseded", and a later foreign write (a PI
              // setting a key BACK to that previous value) is then misread as a
              // stale echo and rolled back (#896 — observed with driverName).
              // `sameValue` is deck-core's own equality (string forms match
              // parsed values), so the diff can't disagree with the overlay.
              const changed = diffAgainst(host.read(), frame.payload as Record<string, unknown>);

              // The subscribe() listener echoes the result back — same as the real host.
              if (Object.keys(changed).length > 0) host.write(changed);
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
