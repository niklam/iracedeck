import { describe, expect, it, vi } from "vitest";

import { CHANGELOG_MAX_BYTES, fetchPublishedChangelog, PUBLISHED_CHANGELOG_URL } from "./changelog-feed-client.js";

const BODY = {
  releases: [{ version: "2.6.0", date: "2026-08-14", categories: [{ title: "Features", items: ["A thing."] }] }],
};

/** A fetch double answering with a real `Response`, so the body is read as a stream. */
function respondWithText(text: string, status = 200): typeof fetch {
  return vi.fn(async () => new Response(text, { status })) as unknown as typeof fetch;
}

function respondWith(body: unknown, status = 200): typeof fetch {
  return respondWithText(JSON.stringify(body), status);
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
    expect(await fetchPublishedChangelog({ fetchImpl: respondWith(BODY, 500) })).toBeUndefined();
  });

  it("returns undefined when the request throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    expect(await fetchPublishedChangelog({ fetchImpl })).toBeUndefined();
  });

  it("returns undefined when the body is not JSON", async () => {
    expect(
      await fetchPublishedChangelog({ fetchImpl: respondWithText("<html>captive portal</html>") }),
    ).toBeUndefined();
  });

  it("returns undefined when the body has the wrong shape", async () => {
    expect(await fetchPublishedChangelog({ fetchImpl: respondWith({ nope: true }) })).toBeUndefined();
  });

  it("returns undefined when the body is over the byte cap", async () => {
    const text = JSON.stringify(BODY);

    // The same well-formed document, one byte too long for the cap.
    expect(
      await fetchPublishedChangelog({ fetchImpl: respondWithText(text), maxBytes: text.length - 1 }),
    ).toBeUndefined();
    expect(await fetchPublishedChangelog({ fetchImpl: respondWithText(text), maxBytes: text.length })).toHaveLength(1);
  });

  it("returns undefined for a padded body over the default cap", async () => {
    // Valid JSON throughout — whitespace is legal between tokens — so only the
    // cap can be what refuses it.
    const padded = `{"releases":[]${" ".repeat(CHANGELOG_MAX_BYTES)}}`;

    expect(await fetchPublishedChangelog({ fetchImpl: respondWithText(padded) })).toBeUndefined();
    expect(await fetchPublishedChangelog({ fetchImpl: respondWithText(padded), maxBytes: padded.length })).toEqual([]);
  });
});
