import { silentLogger } from "@iracedeck/logger";
import { createMemorySettingsStore, type SettingsFileRejection, type SettingsStore } from "@iracedeck/settings";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAMERA_CATALOG_FILE_NAME,
  createCameraCatalogService,
  resolveCameraCatalogPath,
} from "./camera-catalog-service.js";
import { CAMERA_CATALOG_REJECTED_WARNING_ID, createCameraCatalogRejectionReporter } from "./camera-catalog-warning.js";
import { type CameraGroupObservation } from "./camera-catalog.js";

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

    // Queued, the latest per track: the first Spa list is superseded by the second.
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
