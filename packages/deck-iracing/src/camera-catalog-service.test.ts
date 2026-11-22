import { type ILogger, silentLogger } from "@iracedeck/logger";
import { createMemorySettingsStore, type SettingsFileRejection, type SettingsStore } from "@iracedeck/settings";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAMERA_CATALOG_COLLISION_FILE_NAME,
  CAMERA_CATALOG_FILE_NAME,
  CAMERA_CATALOG_QUEUE_LIMIT,
  createCameraCatalogService,
  resolveCameraCatalogPath,
} from "./camera-catalog-service.js";
import { CAMERA_CATALOG_REJECTED_WARNING_ID, createCameraCatalogRejectionReporter } from "./camera-catalog-warning.js";
import { type CameraGroupObservation } from "./camera-catalog.js";

/** A logger whose `info` and `error` are spies and whose other levels are silent. */
function spyLogger() {
  return {
    ...silentLogger,
    info: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
  } satisfies ILogger;
}

/** A memory store whose load the test releases with the returned `finish`. */
function deferredStore(overrides: Partial<SettingsStore> = {}) {
  let finish: (value: Record<string, unknown> | undefined) => void = () => undefined;
  const memory = createMemorySettingsStore();
  const store: SettingsStore = {
    ...memory,
    load: () => new Promise((resolve) => (finish = resolve)),
    ...overrides,
  };

  return { memory, store, finish: (value?: Record<string, unknown>) => finish(value) };
}

const NOW = new Date("2026-11-08T12:00:00.000Z");
const now = (): Date => NOW;

const spa: CameraGroupObservation = {
  trackId: 13,
  trackName: "Spa",
  trackConfig: "Grand Prix",
  groups: ["Nose", "TV1", "DynamicTV"],
};

const storedFile = {
  version: 1,
  tracks: {
    "13": { name: "Spa", config: "Grand Prix", groups: ["Nose", "TV1", "DynamicTV"], lastSeen: NOW.toISOString() },
  },
  groups: {
    Nose: { firstSeen: NOW.toISOString(), lastSeen: NOW.toISOString() },
    TV1: { firstSeen: NOW.toISOString(), lastSeen: NOW.toISOString() },
    DynamicTV: { firstSeen: NOW.toISOString(), lastSeen: NOW.toISOString() },
  },
};

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "camera-catalog-"));
  path = join(dir, CAMERA_CATALOG_FILE_NAME);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, "utf-8"));

/** A file-backed service with a long debounce, so a test decides when the save lands (flush / flushSync). */
function fileService(extra: Partial<Parameters<typeof createCameraCatalogService>[0]> = {}) {
  return createCameraCatalogService({
    path,
    logger: silentLogger,
    now,
    debounceMs: 60_000,
    loadRetryDelayMs: 1,
    ...extra,
  });
}

describe("resolveCameraCatalogPath (#1653)", () => {
  it("puts cameras.json in the settings file's folder", () => {
    expect(resolveCameraCatalogPath(join("C:", "x", "Settings", "Stream Deck", "global-settings.json"))).toBe(
      join("C:", "x", "Settings", "Stream Deck", "cameras.json"),
    );
    // The IRACEDECK_SETTINGS_PATH override names a file anywhere; the catalog follows it.
    expect(resolveCameraCatalogPath(join(dir, "dev-settings.json"))).toBe(join(dir, "cameras.json"));
  });

  it("never gives the settings file's own path: a settings file called cameras.json moves the catalog aside", () => {
    // The catalog store's validate would reject the settings file and move it aside.
    expect(resolveCameraCatalogPath(join(dir, "cameras.json"))).toBe(join(dir, CAMERA_CATALOG_COLLISION_FILE_NAME));
    // Windows paths compare case-insensitively.
    expect(resolveCameraCatalogPath(join(dir, "Cameras.JSON"))).toBe(join(dir, CAMERA_CATALOG_COLLISION_FILE_NAME));
    // The same file through a path that is not normalised.
    expect(resolveCameraCatalogPath(join(dir, "sub", "..", "cameras.json"))).toBe(
      join(dir, CAMERA_CATALOG_COLLISION_FILE_NAME),
    );
    expect(CAMERA_CATALOG_COLLISION_FILE_NAME).not.toBe(CAMERA_CATALOG_FILE_NAME);
    // A name that only resembles it keeps the normal one.
    expect(resolveCameraCatalogPath(join(dir, "cameras.json.bak"))).toBe(join(dir, CAMERA_CATALOG_FILE_NAME));
  });
});

describe("createCameraCatalogService over a temp dir (#1653)", () => {
  it("reads a missing file as an empty catalog and writes nothing until a change", async () => {
    const service = fileService();
    const listener = vi.fn();

    service.subscribe(listener);
    expect(service.isLoaded()).toBe(false);
    expect(service.persistence()).toBe("loading");

    await service.start();

    expect(service.isLoaded()).toBe(true);
    expect(service.persistence()).toBe("file");
    expect(Object.keys(service.getCatalog().tracks)).toEqual([]);
    expect(listener).toHaveBeenCalledOnce();

    await service.flush();
    expect(existsSync(path)).toBe(false);
  });

  it("saves an observation that changes the catalog, and notifies", async () => {
    const service = fileService();
    const listener = vi.fn();

    await service.start();
    service.subscribe(listener);

    expect(service.observe(spa)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();

    await service.flush();
    expect(await readJson(path)).toEqual(storedFile);
  });

  it("loads a saved file, and an unchanged observation neither saves nor notifies", async () => {
    await writeFile(path, JSON.stringify(storedFile));

    const before = await stat(path);
    const service = fileService();

    await service.start();
    expect(JSON.parse(JSON.stringify(service.getCatalog()))).toEqual(storedFile);

    const listener = vi.fn();

    service.subscribe(listener);
    expect(service.observe(spa)).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    await service.flush();
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it("lands a debounced save synchronously on the exit flush", async () => {
    const service = fileService();

    await service.start();
    service.observe(spa);
    expect(existsSync(path)).toBe(false);

    service.flushSync();
    expect(await readJson(path)).toEqual(storedFile);
  });

  it("moves an unparseable file aside, raises the banner and starts empty, saving again", async () => {
    await writeFile(path, "{ not json");

    const setWarning = vi.fn();
    const rejections: SettingsFileRejection[] = [];
    const reporter = createCameraCatalogRejectionReporter({ setWarning });
    const service = fileService({
      onRejected: (rejection) => {
        rejections.push(rejection);
        reporter(rejection);
      },
    });

    await service.start();

    expect(service.persistence()).toBe("file");
    expect(Object.keys(service.getCatalog().groups)).toEqual([]);
    expect(rejections).toHaveLength(1);
    expect(rejections[0].preservedAt).toMatch(/cameras\.corrupt-.+\.json$/);
    expect(await readFile(rejections[0].preservedAt, "utf-8")).toBe("{ not json");
    expect(existsSync(path)).toBe(false);
    expect(setWarning).toHaveBeenCalledExactlyOnceWith(
      CAMERA_CATALOG_REJECTED_WARNING_ID,
      "warning",
      expect.stringContaining(rejections[0].preservedAt),
    );

    service.observe(spa);
    await service.flush();
    expect(await readJson(path)).toEqual(storedFile);
  });

  it("never saves over a file it could not read: retries, then runs in memory only", async () => {
    // A directory where the file should be: every read fails with something other than ENOENT.
    await mkdir(path);

    const service = fileService({ loadAttempts: 3 });
    const listener = vi.fn();

    service.subscribe(listener);
    await service.start();

    expect(service.persistence()).toBe("memory-only");
    expect(listener).toHaveBeenCalledOnce();

    // Recorded and readable in memory for the run…
    expect(service.observe(spa)).toBe(true);
    expect(Object.keys(service.getCatalog().tracks)).toEqual(["13"]);
    expect(service.remove("TV1")).toBe(true);

    // …but nothing is ever written.
    await service.flush();
    service.flushSync();
    expect((await stat(path)).isDirectory()).toBe(true);
    expect(await readdir(dir)).toEqual([CAMERA_CATALOG_FILE_NAME]);
  });

  it("hands a store that keeps failing to read no save at all", async () => {
    const saved: Array<Record<string, unknown>> = [];
    let reads = 0;
    const store: SettingsStore = {
      path,
      load: async () => {
        reads++;
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      },
      save: (settings) => {
        saved.push(settings);
      },
      flush: async () => {},
      flushSync: () => {},
    };
    const service = fileService({ store, loadAttempts: 4 });

    await service.start();

    expect(reads).toBe(4);
    expect(service.persistence()).toBe("memory-only");
    expect(service.observe(spa)).toBe(true);
    expect(service.remove("TV1")).toBe(true);
    expect(saved).toEqual([]);
  });

  it("reads the file once a retried read succeeds", async () => {
    let reads = 0;
    const saved: Array<Record<string, unknown>> = [];
    const store: SettingsStore = {
      path,
      load: async () => {
        reads++;

        if (reads < 3) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });

        return JSON.parse(JSON.stringify(storedFile));
      },
      save: (settings) => {
        saved.push(settings);
      },
      flush: async () => {},
      flushSync: () => {},
    };
    const service = fileService({ store, loadAttempts: 6 });

    await service.start();

    expect(reads).toBe(3);
    expect(service.persistence()).toBe("file");
    expect(Object.keys(service.getCatalog().tracks)).toEqual(["13"]);
    expect(saved).toEqual([]);
  });

  it.each([
    ["no version", { tracks: {}, groups: {} }],
    ["an emptied file", {}],
    ["a version written as text", { version: "1", tracks: {}, groups: {} }],
    ["a version that is no whole number above 1", { version: 1.5, tracks: {}, groups: {} }],
    ["a version-1 file whose tracks are a list", { version: 1, tracks: [], groups: {} }],
  ])(
    "sets aside valid JSON that is no camera catalog (%s) with the banner, and saves again (#1653 second read)",
    async (_label, content) => {
      const text = JSON.stringify(content);

      await writeFile(path, text);

      const rejections: SettingsFileRejection[] = [];
      const service = fileService({ onRejected: (rejection) => rejections.push(rejection) });

      await service.start();

      expect(service.persistence()).toBe("file");
      expect(rejections).toHaveLength(1);
      expect(rejections[0].reason).toMatch(/^It is not a camera catalog: /);
      expect(await readFile(rejections[0].preservedAt, "utf-8")).toBe(text);

      service.observe(spa);
      await service.flush();
      expect(await readJson(path)).toEqual(storedFile);
    },
  );

  it("keeps a file of an unknown version as it is and never writes it, running in memory only", async () => {
    const newer = JSON.stringify({ version: 2, cameras: { anything: true } }, null, 2);

    await writeFile(path, newer);

    const service = fileService();

    await service.start();

    expect(service.persistence()).toBe("memory-only");
    expect(service.observe(spa)).toBe(true);

    await service.flush();
    service.flushSync();
    expect(await readFile(path, "utf-8")).toBe(newer);
    expect(await readdir(dir)).toEqual([CAMERA_CATALOG_FILE_NAME]);
  });

  it("keeps observations made before the load finished and records them once it has", async () => {
    let finishLoad: (value: Record<string, unknown> | undefined) => void = () => undefined;
    const store = createMemorySettingsStore();
    const deferred: SettingsStore = {
      ...store,
      load: () => new Promise((resolve) => (finishLoad = resolve)),
    };
    const service = fileService({ store: deferred });
    const listener = vi.fn();

    service.subscribe(listener);

    const loading = service.start();

    // Queued, every one in order: the second Spa list replaces the first as the track's list.
    expect(service.observe({ ...spa, groups: ["Nose"] })).toBe(false);
    expect(service.observe(spa)).toBe(false);
    expect(service.observe({ trackId: 7, trackName: "Lakeland", trackConfig: "", groups: ["Blimp"] })).toBe(false);
    expect(Object.keys(service.getCatalog().tracks)).toEqual([]);

    finishLoad(undefined);
    await loading;

    expect(service.getCatalog().tracks["13"].groups).toEqual(["Nose", "TV1", "DynamicTV"]);
    expect(service.getCatalog().tracks["7"].groups).toEqual(["Blimp"]);
    // One save and one notification for the load and the queue together.
    expect(store.saved).toHaveLength(1);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("keeps a queued observation's groups when a later one for the same track no longer shows them", async () => {
    const { store, finish } = deferredStore();
    const service = fileService({ store });
    const loading = service.start();

    service.observe({ ...spa, groups: ["Drone"] });
    service.observe({ ...spa, groups: ["Nose"] });
    finish(undefined);
    await loading;

    // The same sequence after the load: `groups` only grows, the track keeps its latest list.
    const reference = fileService({ store: createMemorySettingsStore() });

    await reference.start();
    reference.observe({ ...spa, groups: ["Drone"] });
    reference.observe({ ...spa, groups: ["Nose"] });

    expect(Object.keys(service.getCatalog().groups)).toEqual(["Drone", "Nose"]);
    expect(service.getCatalog().tracks["13"].groups).toEqual(["Nose"]);
    expect(service.getCatalog()).toEqual(reference.getCatalog());
  });

  it("records a queued observation as it was when observed, not as its array later reads (#1653 review)", async () => {
    const { store, finish } = deferredStore();
    const service = fileService({ store });
    const loading = service.start();
    const groups = ["Nose"];

    service.observe({ ...spa, groups });
    groups.push("Drone");
    finish(undefined);
    await loading;

    expect(service.getCatalog().tracks["13"].groups).toEqual(["Nose"]);
    expect(Object.keys(service.getCatalog().groups)).toEqual(["Nose"]);
  });

  it("replays queued observations in capture order, each with its own time", async () => {
    const times = ["2026-11-08T12:00:00.000Z", "2026-11-08T12:00:05.000Z", "2026-11-08T12:00:10.000Z"];
    const clock = (): (() => Date) => {
      let i = 0;

      return () => new Date(times[Math.min(i++, times.length - 1)]);
    };
    const sequence: CameraGroupObservation[] = [
      { ...spa, groups: ["Nose"] },
      { trackId: 7, trackName: "Lakeland", trackConfig: "", groups: ["Blimp"] },
      { ...spa, groups: ["Blimp"] },
    ];
    const { store, finish } = deferredStore();
    const service = fileService({ store, now: clock() });
    const loading = service.start();

    for (const observation of sequence) service.observe(observation);

    finish(undefined);
    await loading;

    const reference = fileService({ store: createMemorySettingsStore(), now: clock() });

    await reference.start();

    for (const observation of sequence) reference.observe(observation);

    const { groups, tracks } = service.getCatalog();

    // Blimp first seen on Lakeland at :05, last on Spa at :10 — never the other way round.
    expect(groups.Blimp).toEqual({ firstSeen: times[1], lastSeen: times[2] });
    expect(tracks["7"].lastSeen).toBe(times[1]);
    expect(tracks["13"].lastSeen).toBe(times[2]);
    expect(service.getCatalog()).toEqual(reference.getCatalog());
  });

  it(`keeps at most ${CAMERA_CATALOG_QUEUE_LIMIT} queued observations, dropping the oldest`, async () => {
    const { store, finish } = deferredStore();
    const service = fileService({ store });
    const loading = service.start();
    const extra = 3;

    for (let i = 1; i <= CAMERA_CATALOG_QUEUE_LIMIT + extra; i++) {
      service.observe({ trackId: i, trackName: `Track ${i}`, trackConfig: "", groups: [`Group ${i}`] });
    }

    finish(undefined);
    await loading;

    const keys = Object.keys(service.getCatalog().tracks).map(Number);

    expect(keys).toHaveLength(CAMERA_CATALOG_QUEUE_LIMIT);
    expect(Math.min(...keys)).toBe(extra + 1);
    expect(Math.max(...keys)).toBe(CAMERA_CATALOG_QUEUE_LIMIT + extra);
  });

  it("finishes the load and notifies once when saving the replayed queue throws, keeping the catalog in memory", async () => {
    const logger = spyLogger();
    const { store, finish } = deferredStore({
      save: () => {
        throw new Error("disk full");
      },
    });
    const service = fileService({ store, logger });
    const listener = vi.fn();

    service.subscribe(listener);

    const loading = service.start();

    service.observe(spa);
    finish(undefined);

    await expect(loading).resolves.toBeUndefined();
    await expect(service.start()).resolves.toBeUndefined();
    expect(service.isLoaded()).toBe(true);
    expect(service.persistence()).toBe("file");
    expect(service.getCatalog().tracks["13"].groups).toEqual(["Nose", "TV1", "DynamicTV"]);
    expect(listener).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith("The camera catalog could not be saved");
  });

  it("records and notifies an observation whose save throws, and does not throw itself", async () => {
    const logger = spyLogger();
    const store: SettingsStore = {
      ...createMemorySettingsStore(),
      save: () => {
        throw new Error("disk full");
      },
    };
    const service = fileService({ store, logger });
    const listener = vi.fn();

    await service.start();
    service.subscribe(listener);

    expect(service.observe(spa)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(service.remove("TV1")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("logs a finished load at info, once, for a saved file and for a missing one; not for memory only", async () => {
    await writeFile(path, JSON.stringify(storedFile));

    const loaded = spyLogger();

    await fileService({ logger: loaded }).start();
    expect(loaded.info).toHaveBeenCalledExactlyOnceWith("Camera catalog loaded");

    const missing = spyLogger();

    await fileService({ logger: missing, store: createMemorySettingsStore() }).start();
    expect(missing.info).toHaveBeenCalledExactlyOnceWith("Camera catalog loaded");

    await writeFile(path, JSON.stringify({ version: 2 }));

    const newer = spyLogger();

    await fileService({ logger: newer }).start();
    expect(newer.info).not.toHaveBeenCalled();
  });

  it("loads once however often it is started", async () => {
    const store = createMemorySettingsStore();
    const load = vi.spyOn(store, "load");
    const service = fileService({ store });

    const first = service.start();

    expect(service.start()).toBe(first);
    await first;
    await service.start();
    expect(load).toHaveBeenCalledOnce();
  });

  it("removes a known name only, saving and notifying, and refuses before the load", async () => {
    await writeFile(path, JSON.stringify(storedFile));

    const service = fileService();
    const listener = vi.fn();

    expect(service.remove("TV1")).toBe(false);

    await service.start();
    service.subscribe(listener);

    expect(service.remove("Drone")).toBe(false);
    expect(service.remove("tv1")).toBe(false);
    expect(service.remove("constructor")).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    expect(service.remove("TV1")).toBe(true);
    expect(listener).toHaveBeenCalledOnce();

    await service.flush();

    const saved = (await readJson(path)) as typeof storedFile;

    expect(Object.keys(saved.groups)).toEqual(["Nose", "DynamicTV"]);
    // The track's latest list is untouched (spec decision 7).
    expect(saved.tracks["13"].groups).toEqual(["Nose", "TV1", "DynamicTV"]);

    // Its next observation brings it back, since the file still has it.
    expect(service.observe(spa)).toBe(true);
    expect(Object.keys(service.getCatalog().groups)).toContain("TV1");
  });

  it("keeps notifying the other listeners when one throws, and stops after unsubscribe", async () => {
    const service = fileService({ store: createMemorySettingsStore() });
    const second = vi.fn();
    const unsubscribe = service.subscribe(() => {
      throw new Error("boom");
    });

    service.subscribe(second);
    await service.start();
    expect(second).toHaveBeenCalledOnce();

    unsubscribe();
    service.observe(spa);
    expect(second).toHaveBeenCalledTimes(2);
  });
});
