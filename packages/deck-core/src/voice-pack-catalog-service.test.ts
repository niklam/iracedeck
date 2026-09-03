import { describe, expect, it, vi } from "vitest";

import { VOICE_PACK_CATALOG_URL } from "./voice-pack-catalog-client.js";
import {
  createVoicePackCatalogService,
  VOICE_PACK_CATALOG_FAILURE_TTL_MS,
  VOICE_PACK_CATALOG_SUCCESS_TTL_MS,
  type VoicePackCatalogServiceDeps,
} from "./voice-pack-catalog-service.js";
import type { VoicePackCatalogEntry } from "./voice-pack-catalog.js";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as VoicePackCatalogServiceDeps["logger"];

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function pack(id: string, overrides: Partial<VoicePackCatalogEntry> = {}): VoicePackCatalogEntry {
  return {
    id,
    label: id,
    version: "1.0.0",
    voices: [{ id, label: id }],
    bytes: 1000,
    sha256: SHA_A,
    url: `https://github.com/niklam/iRaceDeck/releases/download/voices-${id}-1.0.0/${id}-1.0.0.zip`,
    ...overrides,
  };
}

/** A fetch double answering with the given entries, optionally carrying an ETag. */
function catalogResponse(entries: VoicePackCatalogEntry[], opts: { etag?: string } = {}): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ schema: 1, packs: entries }),
    headers: { get: (name: string) => (name.toLowerCase() === "etag" ? (opts.etag ?? null) : null) },
  })) as unknown as typeof fetch;
}

/** A fetch double answering 304, whose `json()` throws if ever called. */
function notModifiedResponse(): typeof fetch {
  return vi.fn(async () => ({
    ok: false,
    status: 304,
    json: async () => {
      throw new Error("json() must not be called on a 304");
    },
    headers: { get: () => null },
  })) as unknown as typeof fetch;
}

function service(overrides: Partial<VoicePackCatalogServiceDeps> = {}) {
  return createVoicePackCatalogService({
    isEnabled: () => true,
    getPluginVersion: () => "3.2.0",
    getInstalledSha: () => undefined,
    bundledVoices: [],
    fetchImpl: catalogResponse([pack("luca")]),
    now: () => 1_000,
    logger,
    ...overrides,
  });
}

/** A fetch double that fails at the transport, like a dropped connection. */
function offlineResponse(): typeof fetch {
  return vi.fn(async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
}

/** A fetch double answering each call from the next entry of `responses`, in order. */
function sequence(responses: readonly (typeof fetch)[]): typeof fetch {
  let call = 0;

  return vi.fn((...args: Parameters<typeof fetch>) => {
    const next = responses[Math.min(call, responses.length - 1)] as typeof fetch;
    call += 1;

    return next(...args);
  }) as unknown as typeof fetch;
}

describe("createVoicePackCatalogService", () => {
  describe("verdicts", () => {
    it("offers install for a pack with nothing installed", async () => {
      const status = await service({
        fetchImpl: catalogResponse([pack("luca", { sha256: SHA_A })]),
        getInstalledSha: () => undefined,
      }).get();

      expect(status).toMatchObject({ state: "ok", packs: [{ id: "luca", verdict: "install" }] });
    });

    it("offers update for a pack installed at a different hash", async () => {
      const status = await service({
        fetchImpl: catalogResponse([pack("luca", { sha256: SHA_A })]),
        getInstalledSha: () => SHA_B,
      }).get();

      expect(status).toMatchObject({ state: "ok", packs: [{ id: "luca", verdict: "update" }] });
    });

    it("offers installed for a pack installed at the same hash", async () => {
      const status = await service({
        fetchImpl: catalogResponse([pack("luca", { sha256: SHA_A })]),
        getInstalledSha: () => SHA_A,
      }).get();

      expect(status).toMatchObject({ state: "ok", packs: [{ id: "luca", verdict: "installed" }] });
    });

    it("lists a pack needing a newer plugin as unsupported instead of hiding it", async () => {
      const status = await service({
        fetchImpl: catalogResponse([pack("luca", { minPluginVersion: "9.9.9" })]),
        getPluginVersion: () => "3.2.0",
        getInstalledSha: () => undefined,
      }).get();

      expect(status).toMatchObject({
        state: "ok",
        packs: [{ id: "luca", verdict: "unsupported", minPluginVersion: "9.9.9" }],
      });
    });

    it("calls a pack unsupported even when a hash comparison alone would call it an update", async () => {
      // An installed pack whose newest catalog version needs a newer plugin
      // than this one: pressing "update" would not work, so it must not be
      // offered as one.
      const status = await service({
        fetchImpl: catalogResponse([pack("luca", { sha256: SHA_A, minPluginVersion: "9.9.9" })]),
        getPluginVersion: () => "3.2.0",
        getInstalledSha: () => SHA_B,
      }).get();

      expect(status).toMatchObject({ state: "ok", packs: [{ id: "luca", verdict: "unsupported" }] });
    });

    it("recomputes verdicts on every call, not just when the catalog is re-fetched", async () => {
      let installedSha: string | undefined;
      const svc = service({
        fetchImpl: catalogResponse([pack("luca", { sha256: SHA_A })]),
        getInstalledSha: () => installedSha,
      });

      const before = await svc.get();
      expect(before).toMatchObject({ packs: [{ verdict: "install" }] });

      installedSha = SHA_A;
      const after = await svc.get();
      expect(after).toMatchObject({ packs: [{ verdict: "installed" }] });
    });

    describe("a pack the plugin itself bundles", () => {
      // The release that publishes `default` to the catalog still ships it
      // inside the plugin. Nothing in the packs folder can add to a voice the
      // bundle already provides, and a downloaded copy is reported by the
      // scanner as a broken pack — so it must never be offered.
      it("is reported installed, not offered, when nothing is in the packs folder", async () => {
        const status = await service({
          fetchImpl: catalogResponse([pack("default")]),
          getInstalledSha: () => undefined,
          bundledVoices: ["default"],
        }).get();

        expect(status).toMatchObject({ state: "ok", packs: [{ id: "default", verdict: "installed" }] });
      });

      it("is reported installed even when the catalog's archive differs from the seeded copy", async () => {
        // A newer catalog archive of a bundled voice changes nothing the user
        // can hear — the bundle wins every clip — so "update" would download
        // for no effect.
        const status = await service({
          fetchImpl: catalogResponse([pack("default", { sha256: SHA_A })]),
          getInstalledSha: () => SHA_B,
          bundledVoices: ["default"],
        }).get();

        expect(status).toMatchObject({ packs: [{ id: "default", verdict: "installed" }] });
      });

      it("is reported installed ahead of a version floor this plugin does not meet", async () => {
        // The voice plays on this plugin today; a floor on the ARCHIVE cannot
        // make that false, and "needs a newer iRaceDeck" would.
        const status = await service({
          fetchImpl: catalogResponse([pack("default", { minPluginVersion: "9.9.9" })]),
          getPluginVersion: () => "3.2.0",
          bundledVoices: ["default"],
        }).get();

        expect(status).toMatchObject({ packs: [{ id: "default", verdict: "installed" }] });
      });

      it("is still offered when only SOME of its voices are bundled", async () => {
        // The scanner drops the colliding voice and keeps the rest, so the
        // pack contributes something and the install is worth its download.
        const status = await service({
          fetchImpl: catalogResponse([
            pack("duo", {
              voices: [
                { id: "default", label: "Default" },
                { id: "luca", label: "Luca" },
              ],
            }),
          ]),
          bundledVoices: ["default"],
        }).get();

        expect(status).toMatchObject({ packs: [{ id: "duo", verdict: "install" }] });
      });

      it("goes inert when nothing is bundled — the stage-3 release needs no edit here", async () => {
        const status = await service({
          fetchImpl: catalogResponse([pack("default")]),
          bundledVoices: [],
        }).get();

        expect(status).toMatchObject({ packs: [{ id: "default", verdict: "install" }] });
      });
    });
  });

  it("requests the published catalog url by default", async () => {
    const fetchImpl = catalogResponse([pack("luca")]);
    await service({ fetchImpl }).get();

    expect(fetchImpl).toHaveBeenCalledWith(VOICE_PACK_CATALOG_URL, expect.anything());
  });

  it("reports unknown on a non-OK status", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      headers: { get: () => null },
    })) as unknown as typeof fetch;

    expect(await service({ fetchImpl }).get()).toEqual({ state: "unknown" });
  });

  it("reports unknown when the request throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    expect(await service({ fetchImpl }).get()).toEqual({ state: "unknown" });
  });

  it("reports unknown when the body is not JSON", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
      headers: { get: () => null },
    })) as unknown as typeof fetch;

    expect(await service({ fetchImpl }).get()).toEqual({ state: "unknown" });
  });

  it("reports unknown when the body has the wrong shape", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ nope: true }),
      headers: { get: () => null },
    })) as unknown as typeof fetch;

    expect(await service({ fetchImpl }).get()).toEqual({ state: "unknown" });
  });

  it("does not fetch at all when the feed is switched off", async () => {
    const fetchImpl = catalogResponse([pack("luca")]);
    const status = await service({ isEnabled: () => false, fetchImpl }).get();

    expect(status).toEqual({ state: "unknown" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-reads the enable gate on every call, so a toggle needs no restart", async () => {
    let enabled = false;
    const svc = service({ isEnabled: () => enabled });

    expect((await svc.get()).state).toBe("unknown");
    enabled = true;
    expect((await svc.get()).state).toBe("ok");
  });

  it("serves a second call from the cache inside the TTL", async () => {
    const fetchImpl = catalogResponse([pack("luca")]);
    const svc = service({ fetchImpl });

    await svc.get();
    await svc.get();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fetches again once the success TTL has passed", async () => {
    const fetchImpl = catalogResponse([pack("luca")]);
    let clock = 1_000;
    const svc = service({ fetchImpl, now: () => clock });

    await svc.get();
    clock += VOICE_PACK_CATALOG_SUCCESS_TTL_MS + 1;
    await svc.get();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries sooner after a failure than after a success", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    let clock = 1_000;
    const svc = service({ fetchImpl, now: () => clock });

    await svc.get();
    clock += VOICE_PACK_CATALOG_FAILURE_TTL_MS + 1;
    await svc.get();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(VOICE_PACK_CATALOG_FAILURE_TTL_MS).toBeLessThan(VOICE_PACK_CATALOG_SUCCESS_TTL_MS);
  });

  describe("a failed re-check", () => {
    // One dropped packet while the window is open must not replace a good
    // list with "could not check" — least of all right after an install,
    // which ends in exactly such a re-check.
    it("keeps the entries the last successful fetch delivered", async () => {
      let clock = 1_000;
      const fetchImpl = sequence([catalogResponse([pack("luca")]), offlineResponse()]);
      const svc = service({ fetchImpl, now: () => clock });

      expect(await svc.get()).toMatchObject({ state: "ok", packs: [{ id: "luca" }] });

      clock += VOICE_PACK_CATALOG_SUCCESS_TTL_MS + 1;
      const afterFailure = await svc.get();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(afterFailure).toMatchObject({ state: "ok", packs: [{ id: "luca" }] });
    });

    it("does not pass the kept entries off as fresh: checkedAt stays at the last success", async () => {
      let clock = 1_000;
      const fetchImpl = sequence([catalogResponse([pack("luca")]), offlineResponse()]);
      const svc = service({ fetchImpl, now: () => clock });

      await svc.get();
      clock += VOICE_PACK_CATALOG_SUCCESS_TTL_MS + 1;
      const afterFailure = await svc.get();

      expect(afterFailure.state === "ok" && afterFailure.checkedAt).toBe(1_000);
    });

    it("keeps the ETag too, so the retry after it is still conditional", async () => {
      let clock = 1_000;
      const first = catalogResponse([pack("luca")], { etag: '"v1"' });
      const retry = notModifiedResponse();
      const fetchImpl = sequence([first, offlineResponse(), retry]);
      const svc = service({ fetchImpl, now: () => clock });

      await svc.get();
      clock += VOICE_PACK_CATALOG_SUCCESS_TTL_MS + 1;
      await svc.get();
      clock += VOICE_PACK_CATALOG_FAILURE_TTL_MS + 1;
      const confirmed = await svc.get();

      const retryOptions = vi.mocked(retry).mock.calls[0]?.[1] as RequestInit;
      expect(retryOptions.headers).toEqual({ "If-None-Match": '"v1"' });
      // And the 304 confirms the kept entries: served again, now freshly dated.
      expect(confirmed).toMatchObject({ state: "ok", checkedAt: clock, packs: [{ id: "luca" }] });
    });

    it("still keeps the good entries through the failure TTL rather than re-asking every call", async () => {
      let clock = 1_000;
      const fetchImpl = sequence([catalogResponse([pack("luca")]), offlineResponse()]);
      const svc = service({ fetchImpl, now: () => clock });

      await svc.get();
      clock += VOICE_PACK_CATALOG_SUCCESS_TTL_MS + 1;
      await svc.get();
      clock += 1_000;
      expect(await svc.get()).toMatchObject({ state: "ok" });

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("hands the installer the kept entry as well", async () => {
      let clock = 1_000;
      const fetchImpl = sequence([catalogResponse([pack("luca")]), offlineResponse()]);
      const svc = service({ fetchImpl, now: () => clock });

      await svc.get();
      clock += VOICE_PACK_CATALOG_SUCCESS_TTL_MS + 1;
      await svc.get();

      expect((await svc.entry("luca"))?.id).toBe("luca");
    });
  });

  describe("a user-initiated refresh", () => {
    it("asks again inside the failure TTL when told to bypass it", async () => {
      // Rescan is the button a user reaches for after fixing their
      // connection; refusing it for five minutes made it do nothing.
      let clock = 1_000;
      const fetchImpl = sequence([offlineResponse(), catalogResponse([pack("luca")])]);
      const svc = service({ fetchImpl, now: () => clock });

      expect(await svc.get()).toEqual({ state: "unknown" });
      clock += 1_000;

      expect(await svc.get({ bypassTtl: true })).toMatchObject({ state: "ok", packs: [{ id: "luca" }] });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("asks again inside the success TTL too, conditionally", async () => {
      let clock = 1_000;
      const first = catalogResponse([pack("luca")], { etag: '"v1"' });
      const again = notModifiedResponse();
      const fetchImpl = sequence([first, again]);
      const svc = service({ fetchImpl, now: () => clock });

      await svc.get();
      clock += 1_000;
      const refreshed = await svc.get({ bypassTtl: true });

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect((vi.mocked(again).mock.calls[0]?.[1] as RequestInit).headers).toEqual({ "If-None-Match": '"v1"' });
      expect(refreshed).toMatchObject({ state: "ok", checkedAt: clock });
    });

    it("cannot force a request past the gate", async () => {
      const fetchImpl = catalogResponse([pack("luca")]);
      const status = await service({ isEnabled: () => false, fetchImpl }).get({ bypassTtl: true });

      expect(status).toEqual({ state: "unknown" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("joins a request already in flight rather than starting a second one", async () => {
      const fetchImpl = catalogResponse([pack("luca")]);
      const svc = service({ fetchImpl });

      await Promise.all([svc.get(), svc.get({ bypassTtl: true })]);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  it("shares one request between concurrent callers", async () => {
    const fetchImpl = catalogResponse([pack("luca")]);
    const svc = service({ fetchImpl });

    await Promise.all([svc.get(), svc.get(), svc.get()]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("is not poisoned when something inside the fetch path throws", async () => {
    // The single-flight slot must be released on EVERY outcome. Left set by a
    // throw, it would pin one failed promise there: every later call would
    // re-await the same failure and only a plugin restart could clear it.
    let clock = 1_000;
    let explode = true;
    const throwingLogger = {
      trace: vi.fn(),
      debug: vi.fn(() => {
        if (!explode) return;

        explode = false;
        throw new Error("logger exploded");
      }),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as VoicePackCatalogServiceDeps["logger"];
    const fetchImpl = catalogResponse([pack("luca")]);
    const svc = service({ fetchImpl, now: () => clock, logger: throwingLogger });

    // The logger blew up AFTER the entries were cached, so they are served —
    // and the attempt still counts as failed, so the retry clock is the short
    // one. What matters here: the second call gets to make a second request.
    expect((await svc.get()).state).toBe("ok");
    clock += VOICE_PACK_CATALOG_FAILURE_TTL_MS + 1;

    expect((await svc.get()).state).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never rejects, even when the enable delegate throws", async () => {
    const svc = service({
      isEnabled: () => {
        throw new Error("settings exploded");
      },
    });

    expect((await svc.get()).state).toBe("unknown");
  });

  it("never rejects, even when the installed-hash lookup throws", async () => {
    const svc = service({
      fetchImpl: catalogResponse([pack("luca")]),
      getInstalledSha: () => {
        throw new Error("provenance read exploded");
      },
    });

    expect((await svc.get()).state).toBe("unknown");
  });

  it("reports when the answer was fetched, not when it was asked for", async () => {
    let clock = 1_000;
    const svc = service({ fetchImpl: catalogResponse([pack("luca")]), now: () => clock });

    await svc.get();
    clock += 60_000;
    const status = await svc.get();

    expect(status.state === "ok" && status.checkedAt).toBe(1_000);
  });

  describe("ETag conditional requests", () => {
    it("sends the previous ETag as If-None-Match once the TTL has expired", async () => {
      let clock = 1_000;
      let call = 0;
      const responses = [
        catalogResponse([pack("luca")], { etag: '"v1"' }),
        catalogResponse([pack("luca")], { etag: '"v1"' }),
      ];
      const fetchImpl = vi.fn((...args: Parameters<typeof fetch>) =>
        responses[call++](...args),
      ) as unknown as typeof fetch;
      const svc = service({ fetchImpl, now: () => clock });

      await svc.get();
      clock += VOICE_PACK_CATALOG_SUCCESS_TTL_MS + 1;
      await svc.get();

      const secondCallOptions = vi.mocked(responses[1]).mock.calls[0][1] as RequestInit;
      expect(secondCallOptions.headers).toEqual({ "If-None-Match": '"v1"' });
    });

    it("serves the cached entries on a 304 without re-parsing, and refreshes checkedAt", async () => {
      let clock = 1_000;
      let call = 0;
      const okResponse = catalogResponse([pack("luca", { sha256: SHA_A })], { etag: '"v1"' });
      // Throws on json() if ever reached — proves the second fetch never re-parses a body.
      const notModified = notModifiedResponse();
      const fetchImpl = vi.fn((...args: Parameters<typeof fetch>) =>
        (call++ === 0 ? okResponse : notModified)(...args),
      ) as unknown as typeof fetch;
      const svc = service({ fetchImpl, now: () => clock, getInstalledSha: () => undefined });

      const firstResult = await svc.get();
      expect(firstResult).toMatchObject({
        state: "ok",
        checkedAt: 1_000,
        packs: [{ id: "luca", verdict: "install" }],
      });

      clock += VOICE_PACK_CATALOG_SUCCESS_TTL_MS + 1;
      const secondResult = await svc.get();

      // Same entries served again (the verdict is still computable, which it
      // could not be from an empty cache), and the timestamp moved forward —
      // "refresh the cache timestamp WITHOUT re-parsing", proven by
      // `notModified`'s json() never having thrown.
      expect(secondResult).toMatchObject({
        state: "ok",
        checkedAt: clock,
        packs: [{ id: "luca", verdict: "install" }],
      });
      expect(notModified).toHaveBeenCalledTimes(1);
    });

    it("treats a 304 with nothing cached as a failure rather than inventing an empty success", async () => {
      // No prior successful fetch means no ETag was ever sent by this process,
      // so an unsolicited 304 cannot be trusted as "nothing changed" — there is
      // no document behind it this call ever saw. See the comment in
      // voice-pack-catalog-service.ts for the full reasoning.
      const fetchImpl = notModifiedResponse();
      const status = await service({ fetchImpl }).get();

      expect(status).toEqual({ state: "unknown" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("304"));
    });
  });
});

describe("createVoicePackCatalogService.entry", () => {
  it("hands back the full entry, including what an offer withholds", async () => {
    const svc = service({ fetchImpl: catalogResponse([pack("luca")]) });
    const entry = await svc.entry("luca");

    // The two fields a page never sees and an install cannot proceed without.
    expect(entry?.url).toBeDefined();
    expect(entry?.sha256).toBeDefined();
  });

  it("answers undefined for a pack the catalog does not list", async () => {
    const svc = service({ fetchImpl: catalogResponse([pack("luca")]) });

    expect(await svc.entry("vixen")).toBeUndefined();
  });

  // One cache, so the entry a user pressed Install on and the entry that is
  // fetched are the same document rather than two reads that could differ.
  it("shares the cache with get() rather than issuing its own request", async () => {
    const fetchImpl = catalogResponse([pack("luca")]);
    const svc = service({ fetchImpl });

    await svc.get();
    await svc.entry("luca");

    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the gate is off, so an install cannot become the one path that still fetches", async () => {
    const fetchImpl = catalogResponse([pack("luca")]);
    const svc = service({ fetchImpl, isEnabled: () => false });

    expect(await svc.entry("luca")).toBeUndefined();
    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
  });

  it("never rejects when the catalog cannot be read", async () => {
    const svc = service({ fetchImpl: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch });

    await expect(svc.entry("luca")).resolves.toBeUndefined();
  });
});

describe("createVoicePackCatalogService and the dev base override (#1100)", () => {
  it("fetches the published URL when no override is set", async () => {
    const fetchImpl = catalogResponse([pack("luca")]);

    await service({ fetchImpl }).get();

    expect(vi.mocked(fetchImpl).mock.calls[0][0]).toBe("https://iracedeck.com/voice-catalog.json");
  });

  it("fetches from the override when one is set", async () => {
    const fetchImpl = catalogResponse([pack("luca")]);

    await service({ fetchImpl, getDevBaseUrl: () => "http://127.0.0.1:8080" }).get();

    expect(vi.mocked(fetchImpl).mock.calls[0][0]).toBe("http://127.0.0.1:8080/voice-catalog.json");
  });

  it("falls back to the published URL when the override is unusable", async () => {
    const fetchImpl = catalogResponse([pack("luca")]);

    await service({ fetchImpl, getDevBaseUrl: () => "http://example.com" }).get();

    expect(vi.mocked(fetchImpl).mock.calls[0][0]).toBe("https://iracedeck.com/voice-catalog.json");
  });

  // Read per fetch, not captured at construction, so editing the settings file
  // takes effect on the next refresh rather than needing a restart.
  it("re-reads the override on every fetch", async () => {
    let base: string | undefined;
    const fetchImpl = catalogResponse([pack("luca")]);
    const svc = service({ fetchImpl, getDevBaseUrl: () => base, successTtlMs: 0 });

    await svc.get();
    base = "http://127.0.0.1:9999";
    await svc.get();

    expect(vi.mocked(fetchImpl).mock.calls[0][0]).toBe("https://iracedeck.com/voice-catalog.json");
    expect(vi.mocked(fetchImpl).mock.calls[1][0]).toBe("http://127.0.0.1:9999/voice-catalog.json");
  });

  // A throwing getter must not take the catalog down with it.
  it("survives a getter that throws", async () => {
    const svc = service({
      fetchImpl: catalogResponse([pack("luca")]),
      getDevBaseUrl: () => {
        throw new Error("settings unavailable");
      },
    });

    await expect(svc.get()).resolves.toMatchObject({ state: "unknown" });
  });
});
