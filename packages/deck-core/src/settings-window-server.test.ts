// ---------------------------------------------------------------------------
// Static assets: the page's <script src="sdpi-components.js"> etc. must resolve.
// ---------------------------------------------------------------------------
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// ---------------------------------------------------------------------------
// The WebSocket "fake host" — speaks the Elgato PI protocol to sdpi-components.
// ---------------------------------------------------------------------------
import { WebSocket } from "ws";

import { type SettingsWindowServer, startSettingsWindowServer } from "./settings-window-server.js";
import type { SettingsWindowHost } from "./settings-window-server.js";

const PAGE = "<!doctype html><title>t</title><p>settings</p>";

let server: SettingsWindowServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("startSettingsWindowServer", () => {
  it("binds an ephemeral loopback port and exposes a tokenised page URL", async () => {
    server = await startSettingsWindowServer({ page: PAGE });

    const url = new URL(server.url);
    expect(url.hostname).toBe("127.0.0.1");
    expect(Number(url.port)).toBeGreaterThan(0);
    expect(url.searchParams.get("t")).toMatch(/^[0-9a-f]{32,}$/);
  });

  it("serves the page to a request carrying the launch token", async () => {
    server = await startSettingsWindowServer({ page: PAGE });

    const res = await fetch(server.url);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PAGE);
  });

  it("refuses a request with no token", async () => {
    server = await startSettingsWindowServer({ page: PAGE });

    const res = await fetch(new URL(server.url).origin + "/");

    expect(res.status).toBe(403);
  });

  it("refuses a request with the wrong token", async () => {
    server = await startSettingsWindowServer({ page: PAGE });

    const res = await fetch(new URL(server.url).origin + "/?t=deadbeef");

    expect(res.status).toBe(403);
  });

  it("refuses a cross-site request even with the right token", async () => {
    server = await startSettingsWindowServer({ page: PAGE });

    const res = await fetch(server.url, { headers: { origin: "https://evil.example" } });

    expect(res.status).toBe(403);
  });

  it("never emits a CORS allow-origin header", async () => {
    server = await startSettingsWindowServer({ page: PAGE });

    const res = await fetch(server.url);

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("releases the port on close", async () => {
    server = await startSettingsWindowServer({ page: PAGE });
    const url = server.url;

    await server.close();
    server = undefined;

    await expect(fetch(url)).rejects.toThrow();
  });
});

function fakeSettingsHost(initial: Record<string, unknown> = {}): SettingsWindowHost & {
  written: Array<Record<string, unknown>>;
  emit: (settings: Record<string, unknown>) => void;
} {
  let current = { ...initial };
  const listeners = new Set<(s: Record<string, unknown>) => void>();
  const written: Array<Record<string, unknown>> = [];

  return {
    written,
    read: () => current,
    write: (partial) => {
      written.push(partial);
      current = { ...current, ...partial };

      for (const l of listeners) l(current);
    },
    subscribe: (l) => {
      listeners.add(l);

      return () => listeners.delete(l);
    },
    emit: (settings) => {
      current = settings;

      for (const l of listeners) l(current);
    },
  };
}

/** Open a ws client to the server's /ws endpoint with the given token; resolve on open. */
function connectWs(serverUrl: string, token: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  const u = new URL(serverUrl);
  const ws = new WebSocket(`ws://${u.host}/ws?t=${token}`, { headers });

  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** Wait for the next JSON message on a socket. */
function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (raw) => resolve(JSON.parse(String(raw)) as Record<string, unknown>));
  });
}

describe("settings-window WebSocket host", () => {
  it("accepts a WebSocket upgrade that carries the launch token", async () => {
    server = await startSettingsWindowServer({ page: PAGE, settingsHost: fakeSettingsHost() });
    const token = new URL(server.url).searchParams.get("t") ?? "";

    const ws = await connectWs(server.url, token);

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("accepts a WebSocket upgrade authenticated by the session cookie alone", async () => {
    server = await startSettingsWindowServer({ page: PAGE, settingsHost: fakeSettingsHost() });
    const cookie = (await fetch(server.url)).headers.get("set-cookie")?.split(";")[0] ?? "";
    const u = new URL(server.url);
    const ws = new WebSocket(`ws://${u.host}/ws`, { headers: { cookie } });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("refuses a WebSocket upgrade with the wrong token", async () => {
    server = await startSettingsWindowServer({ page: PAGE, settingsHost: fakeSettingsHost() });

    await expect(connectWs(server.url, "deadbeef")).rejects.toThrow();
  });

  it("refuses a WebSocket upgrade from a hostile Origin even with the right token", async () => {
    server = await startSettingsWindowServer({ page: PAGE, settingsHost: fakeSettingsHost() });
    const token = new URL(server.url).searchParams.get("t") ?? "";

    await expect(connectWs(server.url, token, { origin: "https://evil.example" })).rejects.toThrow();
  });

  it("answers getGlobalSettings with a didReceiveGlobalSettings carrying the current settings", async () => {
    const host = fakeSettingsHost({ focusIRacingWindow: true, titleFontSize: 9 });
    server = await startSettingsWindowServer({ page: PAGE, settingsHost: host });
    const token = new URL(server.url).searchParams.get("t") ?? "";
    const ws = await connectWs(server.url, token);

    ws.send(JSON.stringify({ event: "getGlobalSettings", context: "settings-window" }));
    const reply = await nextMessage(ws);

    expect(reply).toEqual({
      event: "didReceiveGlobalSettings",
      payload: { settings: { focusIRacingWindow: true, titleFontSize: 9 } },
    });
    ws.close();
  });

  it("routes setGlobalSettings through the injected host write, never a parallel store", async () => {
    const host = fakeSettingsHost({ focusIRacingWindow: true });
    server = await startSettingsWindowServer({ page: PAGE, settingsHost: host });
    const token = new URL(server.url).searchParams.get("t") ?? "";
    const ws = await connectWs(server.url, token);

    ws.send(
      JSON.stringify({
        event: "setGlobalSettings",
        context: "settings-window",
        payload: { focusIRacingWindow: false, titleBold: "true" },
      }),
    );
    // The write echoes back as a didReceiveGlobalSettings, exactly like the real host.
    const echo = await nextMessage(ws);

    expect(host.written).toEqual([{ focusIRacingWindow: false, titleBold: "true" }]);
    expect(echo).toMatchObject({ event: "didReceiveGlobalSettings" });
    ws.close();
  });

  it("pushes didReceiveGlobalSettings to the window when settings change elsewhere in the plugin", async () => {
    const host = fakeSettingsHost({ debugLogging: false });
    server = await startSettingsWindowServer({ page: PAGE, settingsHost: host });
    const token = new URL(server.url).searchParams.get("t") ?? "";
    const ws = await connectWs(server.url, token);
    const pushed = nextMessage(ws);

    host.emit({ debugLogging: true });

    expect(await pushed).toEqual({ event: "didReceiveGlobalSettings", payload: { settings: { debugLogging: true } } });
    ws.close();
  });

  it("forwards openUrl to the injected opener and ignores logMessage", async () => {
    const opened: string[] = [];
    server = await startSettingsWindowServer({
      page: PAGE,
      settingsHost: fakeSettingsHost(),
      openUrl: async (url) => {
        opened.push(url);
      },
    });
    const token = new URL(server.url).searchParams.get("t") ?? "";
    const ws = await connectWs(server.url, token);

    ws.send(JSON.stringify({ event: "logMessage", payload: { message: "hi" } }));
    ws.send(JSON.stringify({ event: "openUrl", payload: { url: "https://iracedeck.com/docs/" } }));
    // Give the server a tick to process both frames.
    await new Promise((r) => setTimeout(r, 50));

    expect(opened).toEqual(["https://iracedeck.com/docs/"]);
    ws.close();
  });

  it("refuses openUrl for non-http(s) schemes", async () => {
    const opened: string[] = [];
    server = await startSettingsWindowServer({
      page: PAGE,
      settingsHost: fakeSettingsHost(),
      openUrl: async (url) => {
        opened.push(url);
      },
    });
    const token = new URL(server.url).searchParams.get("t") ?? "";
    const ws = await connectWs(server.url, token);

    ws.send(JSON.stringify({ event: "openUrl", payload: { url: "file:///C:/Windows/system32/calc.exe" } }));
    await new Promise((r) => setTimeout(r, 50));

    expect(opened).toEqual([]);
    ws.close();
  });
});

describe("settings-window static assets", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function assetsDir(): string {
    dir = mkdtempSync(join(tmpdir(), "ird-sw-assets-"));
    writeFileSync(join(dir, "pi-components.js"), "console.log('pi');", "utf-8");
    writeFileSync(join(dir, "settings-window.html"), "<!doctype html><title>real</title>", "utf-8");

    return dir;
  }

  it("sets a SameSite=Strict HttpOnly session cookie on the tokenised page load", async () => {
    server = await startSettingsWindowServer({ assetsDir: assetsDir(), pageFile: "settings-window.html" });

    const res = await fetch(server.url);
    const setCookie = res.headers.get("set-cookie") ?? "";

    expect(res.status).toBe(200);
    expect(setCookie).toMatch(/^ird_sw=[0-9a-f]{32,};/);
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/");
  });

  it("serves a JS asset requested the way a browser does — relative src, cookie, NO token", async () => {
    server = await startSettingsWindowServer({ assetsDir: assetsDir(), pageFile: "settings-window.html" });
    const u = new URL(server.url);
    const cookie = (await fetch(server.url)).headers.get("set-cookie")?.split(";")[0] ?? "";

    const res = await fetch(`${u.origin}/pi-components.js`, { headers: { cookie } });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toBe("console.log('pi');");
  });

  it("refuses an asset request with neither token nor cookie", async () => {
    server = await startSettingsWindowServer({ assetsDir: assetsDir(), pageFile: "settings-window.html" });
    const u = new URL(server.url);

    const res = await fetch(`${u.origin}/pi-components.js`);

    expect(res.status).toBe(403);
  });

  it("serves the page file at / and reads it fresh on each request", async () => {
    server = await startSettingsWindowServer({ assetsDir: assetsDir(), pageFile: "settings-window.html" });

    expect(await (await fetch(server.url)).text()).toBe("<!doctype html><title>real</title>");
  });

  it("refuses path traversal out of the assets dir", async () => {
    server = await startSettingsWindowServer({ assetsDir: assetsDir(), pageFile: "settings-window.html" });
    const u = new URL(server.url);

    const res = await fetch(`${u.origin}/..%2F..%2Fpackage.json?t=${u.searchParams.get("t")}`);

    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown asset", async () => {
    server = await startSettingsWindowServer({ assetsDir: assetsDir(), pageFile: "settings-window.html" });
    const u = new URL(server.url);

    const res = await fetch(`${u.origin}/nope.js?t=${u.searchParams.get("t")}`);

    expect(res.status).toBe(404);
  });
});
