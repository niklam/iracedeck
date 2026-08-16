/**
 * Settings-window server (issue #992).
 *
 * A loopback HTTP server the plugin process starts ON DEMAND — when the user
 * opens the settings window — and tears down when the window closes. Binding
 * at open-time rather than plugin startup keeps the surface alive only while
 * it is actually in use.
 *
 * Every request passes through `authorizeSettingsRequest` (Origin first, then
 * the per-launch token). No CORS header is ever emitted.
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import { authorizeSettingsRequest } from "./settings-window-guard.js";

export interface SettingsWindowServerOptions {
  /** The fully rendered settings page HTML. */
  page: string;
}

export interface SettingsWindowServer {
  /** Fully formed page URL, token included — hand this to the launcher. */
  readonly url: string;
  /** Release the port. Safe to call more than once. */
  close(): Promise<void>;
}

const HOST = "127.0.0.1";

export async function startSettingsWindowServer(options: SettingsWindowServerOptions): Promise<SettingsWindowServer> {
  const token = randomBytes(24).toString("hex");
  // Set once the port is known; the guard needs it and requests can't arrive
  // before listen() resolves.
  let origin = "";

  const server: Server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", origin);
    const decision = authorizeSettingsRequest({
      origin: req.headers.origin,
      expectedOrigin: origin,
      token: requestUrl.searchParams.get("t") ?? undefined,
      expectedToken: token,
    });

    if (!decision.allowed) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");

      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(options.page);
  });

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
        server.close(() => resolve());
      }),
  };
}
