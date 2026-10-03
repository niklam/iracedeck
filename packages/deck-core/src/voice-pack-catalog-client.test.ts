import { describe, expect, it, vi } from "vitest";

import {
  fetchVoicePackCatalog,
  VOICE_PACK_CATALOG_MAX_BYTES,
  VOICE_PACK_CATALOG_URL,
} from "./voice-pack-catalog-client.js";
import { VOICE_PACK_CATALOG_MAX_PACKS } from "./voice-pack-catalog.js";

const SHA = "a".repeat(64);

const ENTRY = {
  id: "luca",
  label: "Luca",
  version: "1.2.0",
  voices: [{ id: "luca", label: "Luca" }],
  bytes: 13_107_200,
  sha256: SHA,
  url: "https://github.com/niklam/iRaceDeck/releases/download/voices-luca-1.2.0/luca-1.2.0.zip",
};

const BODY = { schema: 1, packs: [ENTRY] };

/**
 * A fetch double answering with a real `Response`, so the body is read as a
 * stream. `text` is sent verbatim; otherwise `body` is serialized. A 304 is a
 * null-body status, so it carries none.
 */
function respondWith(body: unknown, opts: { status?: number; etag?: string; text?: string } = {}): typeof fetch {
  const { status = 200, etag, text } = opts;

  return vi.fn(
    async () =>
      new Response(status === 304 ? null : (text ?? JSON.stringify(body)), {
        status,
        headers: etag === undefined ? undefined : { ETag: etag },
      }),
  ) as unknown as typeof fetch;
}

describe("fetchVoicePackCatalog", () => {
  it("returns the parsed entries and etag on a good response", async () => {
    const result = await fetchVoicePackCatalog({ fetchImpl: respondWith(BODY, { etag: '"v1"' }) });

    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.entries).toHaveLength(1);
    expect(result.status === "ok" && result.entries[0].id).toBe("luca");
    expect(result.status === "ok" && result.etag).toBe('"v1"');
  });

  it("reports an undefined etag when the server sends none", async () => {
    const result = await fetchVoicePackCatalog({ fetchImpl: respondWith(BODY) });

    expect(result.status === "ok" && result.etag).toBeUndefined();
  });

  it("requests the published catalog url by default", async () => {
    const fetchImpl = respondWith(BODY);
    await fetchVoicePackCatalog({ fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(VOICE_PACK_CATALOG_URL, expect.anything());
  });

  it("requests a caller-supplied url when given one", async () => {
    const fetchImpl = respondWith(BODY);
    await fetchVoicePackCatalog({ fetchImpl, url: "https://example.test/voice-catalog.json" });

    expect(fetchImpl).toHaveBeenCalledWith("https://example.test/voice-catalog.json", expect.anything());
  });

  it("sends the given etag as If-None-Match", async () => {
    const fetchImpl = respondWith(BODY);
    await fetchVoicePackCatalog({ fetchImpl, etag: '"abc123"' });

    const options = vi.mocked(fetchImpl).mock.calls[0][1] as RequestInit;
    expect(options.headers).toEqual({ "If-None-Match": '"abc123"' });
  });

  it("sends no conditional header when no etag is given", async () => {
    const fetchImpl = respondWith(BODY);
    await fetchVoicePackCatalog({ fetchImpl });

    const options = vi.mocked(fetchImpl).mock.calls[0][1] as RequestInit;
    expect(options.headers).toBeUndefined();
  });

  it("reports not-modified on a 304 without reading the body", async () => {
    const response = new Response(null, { status: 304 });
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;

    await expect(fetchVoicePackCatalog({ fetchImpl })).resolves.toEqual({ status: "not-modified" });
    expect(response.bodyUsed).toBe(false);
  });

  it("returns unknown on a non-OK, non-304 status", async () => {
    expect(await fetchVoicePackCatalog({ fetchImpl: respondWith(BODY, { status: 500 }) })).toEqual({
      status: "unknown",
    });
  });

  it("returns unknown when the request throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    expect(await fetchVoicePackCatalog({ fetchImpl })).toEqual({ status: "unknown" });
  });

  it("returns unknown when the body is not JSON", async () => {
    const fetchImpl = respondWith(undefined, { text: "<html>captive portal</html>" });

    expect(await fetchVoicePackCatalog({ fetchImpl })).toEqual({ status: "unknown" });
  });

  it("returns unknown when the body has the wrong shape", async () => {
    expect(await fetchVoicePackCatalog({ fetchImpl: respondWith({ nope: true }) })).toEqual({ status: "unknown" });
  });

  it("returns unknown when the body is over the byte cap", async () => {
    const text = JSON.stringify(BODY);

    // The same well-formed document, one byte too long for the cap.
    expect(
      await fetchVoicePackCatalog({ fetchImpl: respondWith(undefined, { text }), maxBytes: text.length - 1 }),
    ).toEqual({ status: "unknown" });
    expect(
      (await fetchVoicePackCatalog({ fetchImpl: respondWith(undefined, { text }), maxBytes: text.length })).status,
    ).toBe("ok");
  });

  it("returns unknown for a padded body over the default cap", async () => {
    // Valid JSON throughout, so only the cap can be what refuses it.
    const text = `{"schema":1,"packs":[]${" ".repeat(VOICE_PACK_CATALOG_MAX_BYTES)}}`;

    expect(await fetchVoicePackCatalog({ fetchImpl: respondWith(undefined, { text }) })).toEqual({ status: "unknown" });
  });

  it("returns unknown for a well-formed catalog listing more packs than the cap", async () => {
    // Small enough to pass the byte cap, so the length cap is what refuses it.
    const packs = (n: number) => ({ schema: 1, packs: Array.from({ length: n }, () => ({})) });

    expect(await fetchVoicePackCatalog({ fetchImpl: respondWith(packs(VOICE_PACK_CATALOG_MAX_PACKS + 1)) })).toEqual({
      status: "unknown",
    });
    expect((await fetchVoicePackCatalog({ fetchImpl: respondWith(packs(VOICE_PACK_CATALOG_MAX_PACKS)) })).status).toBe(
      "ok",
    );
  });
});
