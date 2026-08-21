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

  it("allows a cross-site request that carries the right token — PIs are file:// or host-served pages (#993 phase 2)", async () => {
    server = await startSettingsWindowServer({ page: PAGE });

    const res = await fetch(server.url, { headers: { origin: "https://evil.example" } });

    expect(res.status).toBe(200);
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

/** Poll until `predicate` holds (the writer gets no echo to await, so tests wait on the host instead). */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");

    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("settings-window WebSocket host", () => {
  it("accepts a WebSocket upgrade that carries the launch token", async () => {
    server = await startSettingsWindowServer({ page: PAGE, settingsHost: fakeSettingsHost() });
    const token = new URL(server.url).searchParams.get("t") ?? "";

    const ws = await connectWs(server.url, token);

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("accepts a token-only upgrade from a foreign Origin (a PI page) and reports the decision", async () => {
    const decisions: Array<{ allowed: boolean; origin: string | undefined }> = [];
    server = await startSettingsWindowServer({
      page: PAGE,
      settingsHost: fakeSettingsHost(),
      onUpgradeDecision: (d) => decisions.push({ allowed: d.allowed, origin: d.origin }),
    });
    const token = new URL(server.url).searchParams.get("t") ?? "";

    const ws = await connectWs(server.url, token, { origin: "null" });

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    expect(decisions.at(-1)).toEqual({ allowed: true, origin: "null" });
  });

  it("still rejects a cookie-only upgrade from a foreign Origin", async () => {
    const decisions: Array<{ allowed: boolean; reason?: string; origin: string | undefined }> = [];
    server = await startSettingsWindowServer({
      page: PAGE,
      settingsHost: fakeSettingsHost(),
      onUpgradeDecision: (d) => decisions.push({ allowed: d.allowed, reason: d.reason, origin: d.origin }),
    });
    const u = new URL(server.url);
    const ws = new WebSocket(`ws://${u.host}/ws`, {
      headers: { origin: "https://evil.example", cookie: `ird_sw_${u.port}=${server.token}` },
    });
    const status = await new Promise<number>((resolve) => {
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("error", () => resolve(403));
    });

    expect(status).toBe(403);
    expect(decisions.at(-1)).toEqual({ allowed: false, reason: "bad-origin", origin: "https://evil.example" });
  });

  it("reports a distinct reason when a well-authenticated upgrade targets the wrong path", async () => {
    const decisions: Array<{ allowed: boolean; reason?: string }> = [];
    server = await startSettingsWindowServer({
      page: PAGE,
      settingsHost: fakeSettingsHost(),
      onUpgradeDecision: (d) => decisions.push({ allowed: d.allowed, reason: d.reason }),
    });
    const port = new URL(server.url).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/not-ws?t=${server.token}`);
    const status = await new Promise<number>((resolve) => {
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("error", () => resolve(403));
    });

    expect(status).toBe(403);
    expect(decisions.at(-1)).toEqual({ allowed: false, reason: "bad-path" });
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

  it("accepts a WebSocket upgrade from a hostile Origin when it carries the right token (#993 phase 2)", async () => {
    server = await startSettingsWindowServer({ page: PAGE, settingsHost: fakeSettingsHost() });
    const token = new URL(server.url).searchParams.get("t") ?? "";

    const ws = await connectWs(server.url, token, { origin: "https://evil.example" });

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
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

    // A second window (or a second socket) is the OTHER side: it gets the push.
    const other = await connectWs(server.url, token);
    const pushedToOther = nextMessage(other);
    const echoedToWriter: unknown[] = [];

    ws.on("message", (raw) => echoedToWriter.push(JSON.parse(String(raw))));
    ws.send(
      JSON.stringify({
        event: "setGlobalSettings",
        context: "settings-window",
        payload: { focusIRacingWindow: false, titleBold: "true" },
      }),
    );

    expect(await pushedToOther).toMatchObject({ event: "didReceiveGlobalSettings" });
    expect(host.written).toEqual([{ focusIRacingWindow: false, titleBold: "true" }]);
    // The writer itself gets NO echo — exactly like the real host, and because
    // the echo carries the PARSED cache: a field the user just cleared ("" ->
    // schema default) would otherwise refill under the cursor.
    await new Promise((r) => setTimeout(r, 50));
    expect(echoedToWriter).toEqual([]);
    ws.close();
    other.close();
  });

  it("writes only the keys that actually CHANGED — sdpi sends its whole snapshot, and a full-object write would mark every key pending (#896 rollback of the other surface's edits)", async () => {
    // Real symptom (16 Aug): the window saved a 310-key snapshot; deck-core marked
    // driverName pending with the previous value as "superseded"; the PI then set
    // driverName BACK to that previous value; deck-core read the host echo as a
    // stale echo and rolled the PI's edit back to the window's value.
    const host = fakeSettingsHost({ driverName: "niklas", focusIRacingWindow: true, titleBold: "false" });
    server = await startSettingsWindowServer({ page: PAGE, settingsHost: host });
    const token = new URL(server.url).searchParams.get("t") ?? "";
    const ws = await connectWs(server.url, token);

    ws.send(
      JSON.stringify({
        event: "setGlobalSettings",
        payload: { driverName: "nick", focusIRacingWindow: true, titleBold: "false" }, // only driverName differs
      }),
    );
    await waitFor(() => host.written.length > 0);

    expect(host.written).toEqual([{ driverName: "nick" }]);
    ws.close();
  });

  it("treats the PI's string forms as equal to the cache's parsed values when diffing ('true' == true, '80' == 80)", async () => {
    const host = fakeSettingsHost({ debugLogging: true, titleFontSize: 80, driverName: "niklas" });
    server = await startSettingsWindowServer({ page: PAGE, settingsHost: host });
    const token = new URL(server.url).searchParams.get("t") ?? "";
    const ws = await connectWs(server.url, token);

    ws.send(
      JSON.stringify({
        event: "setGlobalSettings",
        payload: { debugLogging: "true", titleFontSize: "80", driverName: "nick" },
      }),
    );
    await waitFor(() => host.written.length > 0);

    expect(host.written).toEqual([{ driverName: "nick" }]);
    ws.close();
  });

  it("never writes a run-scoped key a page sends back, however stale its snapshot is (#1014)", async () => {
    // A Property Inspector that bootstrapped off the deck-host mirror holds the
    // PREVIOUS run's `_warnings` until the first loopback push replaces it.
    // Touching any control in that window sends the whole snapshot — and
    // writing that array back would resurrect the banner run-scoping retires.
    const host = fakeSettingsHost({ driverName: "niklas" });

    server = await startSettingsWindowServer({ page: PAGE, settingsHost: host });

    const token = new URL(server.url).searchParams.get("t") ?? "";
    const ws = await connectWs(server.url, token);

    ws.send(
      JSON.stringify({
        event: "setGlobalSettings",
        payload: {
          driverName: "nick",
          _warnings: JSON.stringify([{ id: "elevation-mismatch", level: "warning", message: "from an earlier run" }]),
        },
      }),
    );
    await waitFor(() => host.written.length > 0);

    expect(host.written).toEqual([{ driverName: "nick" }]);
    ws.close();
  });

  it("does not write at all when nothing changed", async () => {
    const host = fakeSettingsHost({ driverName: "niklas" });
    server = await startSettingsWindowServer({ page: PAGE, settingsHost: host });
    const token = new URL(server.url).searchParams.get("t") ?? "";
    const ws = await connectWs(server.url, token);

    ws.send(JSON.stringify({ event: "setGlobalSettings", payload: { driverName: "niklas" } }));
    await new Promise((r) => setTimeout(r, 50));

    expect(host.written).toEqual([]);
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

  it("does not re-push a payload the window already holds (identical fan-outs are no-ops for the page)", async () => {
    const host = fakeSettingsHost({ debugLogging: false });
    server = await startSettingsWindowServer({ page: PAGE, settingsHost: host });
    const token = new URL(server.url).searchParams.get("t") ?? "";
    const ws = await connectWs(server.url, token);
    const received: unknown[] = [];

    ws.on("message", (raw) => received.push(JSON.parse(String(raw))));
    host.emit({ debugLogging: true });
    host.emit({ debugLogging: true }); // e.g. the deck host's echo of the same state
    host.emit({ debugLogging: false });
    await waitFor(() => received.length >= 2);
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual([
      { event: "didReceiveGlobalSettings", payload: { settings: { debugLogging: true } } },
      { event: "didReceiveGlobalSettings", payload: { settings: { debugLogging: false } } },
    ]);
    ws.close();
  });

  it("always answers an explicit getGlobalSettings, even when nothing changed since the last push", async () => {
    const host = fakeSettingsHost({ debugLogging: false });
    server = await startSettingsWindowServer({ page: PAGE, settingsHost: host });
    const token = new URL(server.url).searchParams.get("t") ?? "";
    const ws = await connectWs(server.url, token);

    ws.send(JSON.stringify({ event: "getGlobalSettings" }));
    await nextMessage(ws);
    ws.send(JSON.stringify({ event: "getGlobalSettings" }));

    expect(await nextMessage(ws)).toEqual({
      event: "didReceiveGlobalSettings",
      payload: { settings: { debugLogging: false } },
    });
    ws.close();
  });

  it("survives a malformed request target and a malformed WebSocket frame (never an uncaught exception)", async () => {
    const host = fakeSettingsHost({ debugLogging: false });
    server = await startSettingsWindowServer({ page: PAGE, settingsHost: host });
    const token = new URL(server.url).searchParams.get("t") ?? "";
    const u = new URL(server.url);

    // `new URL("//[", origin)` throws — must be a 400, not a crash, and it needs no token.
    const { connect } = await import("node:net");
    const status = await new Promise<string>((resolve) => {
      const s = connect(Number(u.port), u.hostname, () => s.write("GET //[ HTTP/1.1\r\nHost: x\r\n\r\n"));

      s.once("data", (d) => {
        resolve(String(d).split("\r\n")[0] ?? "");
        s.end();
      });
    });

    expect(status).toContain("400");

    // A protocol-violating frame drops the peer; the server keeps serving.
    const ws = await connectWs(server.url, token);
    const closed = new Promise<void>((r) => ws.once("close", () => r()));

    // Bypass ws' own validation: write raw bytes with the RSV1 bit set (no extension negotiated).
    (ws as unknown as { _socket: { write: (b: Buffer) => void } })._socket.write(Buffer.from([0xc1, 0x80, 0, 0, 0, 0]));
    await closed;

    expect((await fetch(server.url)).status).toBe(200);
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
    // The valid one lands (event-driven); the invalid one must NOT — settle briefly for that half.
    await waitFor(() => opened.length >= 1);
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
    // Port-scoped name: cookies are host- not port-scoped, and every plugin's
    // window shares one browser profile — a second plugin's server must not
    // overwrite this one's cookie.
    expect(setCookie).toMatch(new RegExp(`^ird_sw_${new URL(server.url).port}=[0-9a-f]{32,};`));
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

  it("returns 404 (not a crash) for a malformed percent-escape in an asset path", async () => {
    server = await startSettingsWindowServer({ assetsDir: assetsDir(), pageFile: "settings-window.html" });
    const u = new URL(server.url);

    // decodeURIComponent("%E0%A4%A") throws URIError; the request listener must not.
    expect((await fetch(`${u.origin}/%E0%A4%A?t=${u.searchParams.get("t")}`)).status).toBe(404);
    expect((await fetch(server.url)).status).toBe(200);
  });

  it("returns 404 for an unknown asset", async () => {
    server = await startSettingsWindowServer({ assetsDir: assetsDir(), pageFile: "settings-window.html" });
    const u = new URL(server.url);

    const res = await fetch(`${u.origin}/nope.js?t=${u.searchParams.get("t")}`);

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Plugin-bound extras the page needs and cannot reach itself.
// ---------------------------------------------------------------------------
describe("settings-window sendToPlugin + plugin-bound proxies", () => {
  it("forwards a sendToPlugin frame's payload to the injected handler", async () => {
    const received: unknown[] = [];
    server = await startSettingsWindowServer({
      page: PAGE,
      settingsHost: fakeSettingsHost(),
      onSendToPlugin: (payload) => {
        received.push(payload);
      },
    });
    const token = new URL(server.url).searchParams.get("t") ?? "";
    const ws = await connectWs(server.url, token);

    ws.send(JSON.stringify({ event: "sendToPlugin", payload: { event: "windowBounds", width: 1200, height: 800 } }));
    await waitFor(() => received.length >= 1);

    expect(received).toEqual([{ event: "windowBounds", width: 1200, height: 800 }]);
    ws.close();
  });

  it("answers /simhub/roles from the plugin's own SimHub service — the page never talks to SimHub (CORS)", async () => {
    server = await startSettingsWindowServer({
      page: PAGE,
      simHub: { isReachable: () => true, getRoles: async () => ["Pit Limiter", "Wipers"] },
    });
    const cookie = (await fetch(server.url)).headers.get("set-cookie")?.split(";")[0] ?? "";
    const u = new URL(server.url);

    const res = await fetch(`${u.origin}/simhub/roles`, { headers: { cookie } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reachable: true, roles: ["Pit Limiter", "Wipers"] });
  });

  it("reports unreachable with no roles when the SimHub service says so", async () => {
    server = await startSettingsWindowServer({
      page: PAGE,
      simHub: { isReachable: () => false, getRoles: async () => [] },
    });
    const cookie = (await fetch(server.url)).headers.get("set-cookie")?.split(";")[0] ?? "";
    const u = new URL(server.url);

    expect(await (await fetch(`${u.origin}/simhub/roles`, { headers: { cookie } })).json()).toEqual({
      reachable: false,
      roles: [],
    });
  });

  it("answers 500 (and never hangs or throws) when the SimHub delegate itself throws", async () => {
    server = await startSettingsWindowServer({
      page: PAGE,
      simHub: {
        isReachable: () => {
          throw new Error("simhub service exploded");
        },
        getRoles: async () => [],
      },
    });
    const cookie = (await fetch(server.url)).headers.get("set-cookie")?.split(";")[0] ?? "";
    const u = new URL(server.url);

    const res = await fetch(`${u.origin}/simhub/roles`, { headers: { cookie } });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ reachable: false, roles: [] });
  });

  it("still requires authorization on /simhub/roles", async () => {
    server = await startSettingsWindowServer({
      page: PAGE,
      simHub: { isReachable: () => true, getRoles: async () => ["x"] },
    });
    const u = new URL(server.url);

    expect((await fetch(`${u.origin}/simhub/roles`)).status).toBe(403);
  });

  it("answers /updates/status from the plugin's own update service — the page never reaches the website (CORS)", async () => {
    const status = {
      state: "ok",
      installedVersion: "2.4.0",
      latestVersion: "2.6.0",
      releases: [{ version: "2.6.0", date: "2026-08-14", categories: [] }],
      checkedAt: 1,
    };
    server = await startSettingsWindowServer({ page: PAGE, updates: { get: async () => status } });
    const cookie = (await fetch(server.url)).headers.get("set-cookie")?.split(";")[0] ?? "";
    const u = new URL(server.url);

    const res = await fetch(`${u.origin}/updates/status`, { headers: { cookie } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
  });

  it("404s /updates/status when no update service is wired", async () => {
    // Served from a real assets dir, as in production: an unhandled path is a
    // 404 there, where the inline-page path would answer every path with the
    // page itself and hide whether the route exists at all.
    const dir = mkdtempSync(join(tmpdir(), "ird-sw-updates-"));
    writeFileSync(join(dir, "settings-window.html"), "<!doctype html><title>real</title>", "utf-8");

    try {
      server = await startSettingsWindowServer({ assetsDir: dir, pageFile: "settings-window.html" });
      const cookie = (await fetch(server.url)).headers.get("set-cookie")?.split(";")[0] ?? "";
      const u = new URL(server.url);

      expect((await fetch(`${u.origin}/updates/status`, { headers: { cookie } })).status).toBe(404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers 500 (and never hangs or throws) when the update service itself throws", async () => {
    server = await startSettingsWindowServer({
      page: PAGE,
      updates: {
        get: async () => {
          throw new Error("update service exploded");
        },
      },
    });
    const cookie = (await fetch(server.url)).headers.get("set-cookie")?.split(";")[0] ?? "";
    const u = new URL(server.url);

    const res = await fetch(`${u.origin}/updates/status`, { headers: { cookie } });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ state: "unavailable", installedVersion: "" });
  });

  it("still requires authorization on /updates/status", async () => {
    server = await startSettingsWindowServer({
      page: PAGE,
      updates: { get: async () => ({ state: "disabled", installedVersion: "2.4.0" }) },
    });
    const u = new URL(server.url);

    expect((await fetch(`${u.origin}/updates/status`)).status).toBe(403);
  });
});
