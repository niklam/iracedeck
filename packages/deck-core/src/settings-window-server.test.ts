import { afterEach, describe, expect, it } from "vitest";

import { type SettingsWindowServer, startSettingsWindowServer } from "./settings-window-server.js";

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
