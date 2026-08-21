import { describe, expect, it, vi } from "vitest";

import { fetchPublishedChangelog, PUBLISHED_CHANGELOG_URL } from "./changelog-feed-client.js";

const BODY = {
  releases: [{ version: "2.6.0", date: "2026-08-14", categories: [{ title: "Features", items: ["A thing."] }] }],
};

function respondWith(body: unknown, ok = true): typeof fetch {
  return vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

describe("fetchPublishedChangelog", () => {
  it("returns the parsed releases on a good response", async () => {
    const releases = await fetchPublishedChangelog({ fetchImpl: respondWith(BODY) });

    expect(releases).toHaveLength(1);
    expect(releases?.[0].version).toBe("2.6.0");
  });

  it("requests the published artifact by default", async () => {
    const fetchImpl = respondWith(BODY);
    await fetchPublishedChangelog({ fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(PUBLISHED_CHANGELOG_URL, expect.anything());
  });

  it("requests a caller-supplied url when given one", async () => {
    const fetchImpl = respondWith(BODY);
    await fetchPublishedChangelog({ fetchImpl, url: "https://example.test/c.json" });

    expect(fetchImpl).toHaveBeenCalledWith("https://example.test/c.json", expect.anything());
  });

  it("returns undefined on a non-OK status", async () => {
    expect(await fetchPublishedChangelog({ fetchImpl: respondWith(BODY, false) })).toBeUndefined();
  });

  it("returns undefined when the request throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    expect(await fetchPublishedChangelog({ fetchImpl })).toBeUndefined();
  });

  it("returns undefined when the body is not JSON", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    })) as unknown as typeof fetch;

    expect(await fetchPublishedChangelog({ fetchImpl })).toBeUndefined();
  });

  it("returns undefined when the body has the wrong shape", async () => {
    expect(await fetchPublishedChangelog({ fetchImpl: respondWith({ nope: true }) })).toBeUndefined();
  });
});
