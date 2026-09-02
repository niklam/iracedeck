import { describe, expect, it, vi } from "vitest";

import { fetchVoicePackCatalog, VOICE_PACK_CATALOG_URL } from "./voice-pack-catalog-client.js";

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

/** A fetch double that never calls `json()` — used to prove a 304 is not re-parsed. */
function explodingJson(): () => Promise<unknown> {
  return () => {
    throw new Error("json() must not be called on a 304");
  };
}

function respondWith(
  body: unknown,
  opts: { ok?: boolean; status?: number; etag?: string; json?: () => Promise<unknown> } = {},
): typeof fetch {
  const { status = 200, ok = status >= 200 && status < 300, etag, json } = opts;

  return vi.fn(async () => ({
    ok,
    status,
    json: json ?? (async () => body),
    headers: { get: (name: string) => (name.toLowerCase() === "etag" ? (etag ?? null) : null) },
  })) as unknown as typeof fetch;
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
    const fetchImpl = respondWith(undefined, { status: 304, ok: false, json: explodingJson() });

    await expect(fetchVoicePackCatalog({ fetchImpl })).resolves.toEqual({ status: "not-modified" });
  });

  it("returns unknown on a non-OK, non-304 status", async () => {
    expect(await fetchVoicePackCatalog({ fetchImpl: respondWith(BODY, { status: 500, ok: false }) })).toEqual({
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
    const fetchImpl = respondWith(undefined, {
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });

    expect(await fetchVoicePackCatalog({ fetchImpl })).toEqual({ status: "unknown" });
  });

  it("returns unknown when the body has the wrong shape", async () => {
    expect(await fetchVoicePackCatalog({ fetchImpl: respondWith({ nope: true }) })).toEqual({ status: "unknown" });
  });
});
