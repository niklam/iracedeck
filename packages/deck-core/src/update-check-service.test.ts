import { describe, expect, it, vi } from "vitest";

import type { PublishedRelease } from "./published-changelog.js";
import {
  createUpdateCheckService,
  UPDATE_CHECK_FAILURE_TTL_MS,
  UPDATE_CHECK_SUCCESS_TTL_MS,
  type UpdateCheckServiceDeps,
} from "./update-check-service.js";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as UpdateCheckServiceDeps["logger"];

function release(version: string, date: string | null = "2026-08-14"): PublishedRelease {
  return { version, date, categories: [{ title: "Features", items: ["A thing."] }] };
}

/** A fetch double answering with the given releases artifact. */
function feed(releases: PublishedRelease[]): typeof fetch {
  return vi.fn(async () => ({ ok: true, json: async () => ({ releases }) })) as unknown as typeof fetch;
}

function service(overrides: Partial<UpdateCheckServiceDeps> = {}) {
  return createUpdateCheckService({
    isEnabled: () => true,
    getInstalledVersion: () => "2.4.0",
    fetchImpl: feed([release("2.6.0"), release("2.4.0")]),
    now: () => 1_000,
    logger,
    ...overrides,
  });
}

describe("createUpdateCheckService", () => {
  it("reports the newer releases", async () => {
    const status = await service().get();

    expect(status.state).toBe("ok");
    expect(status).toMatchObject({ installedVersion: "2.4.0", latestVersion: "2.6.0" });
    expect(status.state === "ok" && status.releases.map((r) => r.version)).toEqual(["2.6.0"]);
  });

  it("reports unavailable when nothing newer exists, without inventing a latest version", async () => {
    const status = await service({ fetchImpl: feed([release("2.4.0")]) }).get();

    expect(status).toEqual({ state: "unavailable", installedVersion: "2.4.0" });
  });

  it("reports unavailable when the request fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    expect((await service({ fetchImpl }).get()).state).toBe("unavailable");
  });

  it("does not fetch at all when the check is switched off", async () => {
    const fetchImpl = feed([release("2.6.0")]);
    const status = await service({ isEnabled: () => false, fetchImpl }).get();

    expect(status).toEqual({ state: "disabled", installedVersion: "2.4.0" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-reads the setting on every call, so a toggle needs no restart", async () => {
    let enabled = false;
    const svc = service({ isEnabled: () => enabled });

    expect((await svc.get()).state).toBe("disabled");
    enabled = true;
    expect((await svc.get()).state).toBe("ok");
  });

  it("serves a second call from the cache inside the TTL", async () => {
    const fetchImpl = feed([release("2.6.0")]);
    const svc = service({ fetchImpl });

    await svc.get();
    await svc.get();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fetches again once the success TTL has passed", async () => {
    const fetchImpl = feed([release("2.6.0")]);
    let clock = 1_000;
    const svc = service({ fetchImpl, now: () => clock });

    await svc.get();
    clock += UPDATE_CHECK_SUCCESS_TTL_MS + 1;
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
    clock += UPDATE_CHECK_FAILURE_TTL_MS + 1;
    await svc.get();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(UPDATE_CHECK_FAILURE_TTL_MS).toBeLessThan(UPDATE_CHECK_SUCCESS_TTL_MS);
  });

  it("shares one request between concurrent callers", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ releases: [release("2.6.0")] }),
    })) as unknown as typeof fetch;
    const svc = service({ fetchImpl });

    await Promise.all([svc.get(), svc.get(), svc.get()]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-applies the installed version to a cached fetch", async () => {
    let installed = "2.4.0";
    const svc = service({ fetchImpl: feed([release("2.6.0")]), getInstalledVersion: () => installed });

    expect((await svc.get()).state).toBe("ok");
    installed = "2.6.0";
    expect((await svc.get()).state).toBe("unavailable");
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
    } as unknown as UpdateCheckServiceDeps["logger"];
    const svc = service({ fetchImpl: feed([release("2.6.0")]), now: () => clock, logger: throwingLogger });

    expect((await svc.get()).state).toBe("unavailable");
    clock += UPDATE_CHECK_FAILURE_TTL_MS + 1;

    expect((await svc.get()).state).toBe("ok");
  });

  it("reports when the answer was fetched, not when it was asked for", async () => {
    let clock = 1_000;
    const svc = service({ fetchImpl: feed([release("2.6.0")]), now: () => clock });

    await svc.get();
    clock += 60_000;
    const status = await svc.get();

    expect(status.state === "ok" && status.checkedAt).toBe(1_000);
  });

  it("never rejects, even when the enable delegate throws", async () => {
    const svc = service({
      isEnabled: () => {
        throw new Error("settings exploded");
      },
    });

    expect((await svc.get()).state).toBe("unavailable");
  });
});
