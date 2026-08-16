// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSimHubReachable, fetchSimHubRoles, SETTINGS_WINDOW_FLAG } from "./simhub-probe.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>)[SETTINGS_WINDOW_FLAG];
});

describe("SimHub probe", () => {
  it("probes SimHub directly at host:port from a Property Inspector", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ["A"] }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchSimHubReachable("127.0.0.1", 8888)).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8888/api/ControlMapper/GetRoles/");
  });

  it("asks the plugin's same-origin proxy instead when running inside the settings window (#992)", async () => {
    // From the window's origin a direct fetch is cross-origin and SimHub sends
    // no CORS headers, so it always looks unreachable. The bridge sets this flag.
    (window as unknown as Record<string, unknown>)[SETTINGS_WINDOW_FLAG] = true;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ reachable: true, roles: ["Pit", "Wipers"] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchSimHubReachable("127.0.0.1", 8888)).toBe(true);
    expect(await fetchSimHubRoles("127.0.0.1", 8888)).toEqual(["Pit", "Wipers"]);

    for (const call of fetchMock.mock.calls) expect(call[0]).toBe("/simhub/roles");
  });

  it("reports unreachable and no roles when the proxy says SimHub is down", async () => {
    (window as unknown as Record<string, unknown>)[SETTINGS_WINDOW_FLAG] = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ reachable: false, roles: [] }) })),
    );

    expect(await fetchSimHubReachable("127.0.0.1", 8888)).toBe(false);
    expect(await fetchSimHubRoles("127.0.0.1", 8888)).toEqual([]);
  });

  it("never throws — a failed fetch is simply unreachable / no roles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("refused");
      }),
    );

    expect(await fetchSimHubReachable("127.0.0.1", 8888)).toBe(false);
    expect(await fetchSimHubRoles("127.0.0.1", 8888)).toEqual([]);
  });
});

describe("single SimHub fetch path", () => {
  it("key-binding-input fetches roles through simhub-probe, not its own fetch (#992: the window-mode proxy must apply everywhere)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    // jsdom's import.meta.url is not a file: URL; vitest runs from the repo root.
    const source = readFileSync(
      join(process.cwd(), "packages/pi-components/src/components/key-binding-input.ts"),
      "utf-8",
    );

    expect(source).toContain('from "./simhub-probe.js"');
    expect(source).not.toContain("/api/ControlMapper/GetRoles/");
  });
});
