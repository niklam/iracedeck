import { silentLogger } from "@iracedeck/logger";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFileSettingsStore,
  createMemorySettingsStore,
  resolveSettingsStorePath,
  type SettingsStore,
  settingsStoreFolderName,
} from "./settings-store.js";

describe("settingsStoreFolderName", () => {
  it("maps the plugin platform id to a human-readable per-ecosystem folder", () => {
    expect(settingsStoreFolderName("stream-deck")).toBe("Stream Deck");
    expect(settingsStoreFolderName("mirabox")).toBe("Mirabox");
    expect(settingsStoreFolderName("ulanzi")).toBe("Ulanzi");
  });

  it("passes an unknown platform id through so two unknown ecosystems still get separate files", () => {
    expect(settingsStoreFolderName("something-new")).toBe("something-new");
  });
});

describe("resolveSettingsStorePath", () => {
  it("defaults to %LOCALAPPDATA%\\iRaceDeck\\Settings\\<ecosystem>\\global-settings.json", () => {
    const p = resolveSettingsStorePath({
      platform: "stream-deck",
      env: { LOCALAPPDATA: "C:\\Users\\n\\AppData\\Local" },
    });

    expect(p.replace(/\\/g, "/")).toBe("C:/Users/n/AppData/Local/iRaceDeck/Settings/Stream Deck/global-settings.json");
  });

  it("falls back to USERPROFILE\\AppData\\Local when LOCALAPPDATA is unset", () => {
    const p = resolveSettingsStorePath({ platform: "mirabox", env: { USERPROFILE: "C:\\Users\\n" } });

    expect(p.replace(/\\/g, "/")).toBe("C:/Users/n/AppData/Local/iRaceDeck/Settings/Mirabox/global-settings.json");
  });

  it("treats a set-but-blank LOCALAPPDATA like an unset one — never a relative path", () => {
    const p = resolveSettingsStorePath({
      platform: "mirabox",
      env: { LOCALAPPDATA: "  ", USERPROFILE: "C:\\Users\\n" },
    });

    expect(p.replace(/\\/g, "/")).toBe("C:/Users/n/AppData/Local/iRaceDeck/Settings/Mirabox/global-settings.json");
  });

  it("honours IRACEDECK_SETTINGS_PATH as a full file path override (dev / fresh-install testing)", () => {
    const p = resolveSettingsStorePath({
      platform: "ulanzi",
      env: { LOCALAPPDATA: "C:\\x", IRACEDECK_SETTINGS_PATH: "D:\\test\\fresh.json" },
    });

    expect(p).toBe("D:\\test\\fresh.json");
  });
});

describe("createFileSettingsStore", () => {
  let dir: string;
  let store: SettingsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ird-settings-store-"));
    store = createFileSettingsStore({
      path: join(dir, "sub", "global-settings.json"),
      logger: silentLogger,
      debounceMs: 10,
    });
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it("load() is undefined when the file does not exist yet — that is the migration signal", async () => {
    expect(await store.load()).toBeUndefined();
  });

  it("save() then flush() writes pretty-printed JSON, creating the folder", async () => {
    store.save({ driverName: "nick", debugLogging: true });
    await store.flush();

    const text = readFileSync(store.path, "utf-8");

    expect(JSON.parse(text)).toEqual({ driverName: "nick", debugLogging: true });
    expect(text).toContain("\n"); // pretty-printed
  });

  it("load() returns what was saved", async () => {
    store.save({ a: 1 });
    await store.flush();

    expect(await store.load()).toEqual({ a: 1 });
  });

  it("debounces: rapid saves produce one file write with the LAST value", async () => {
    store.save({ n: 1 });
    store.save({ n: 2 });
    store.save({ n: 3 });
    await store.flush();

    expect(await store.load()).toEqual({ n: 3 });
    // No stray temp files left behind by the atomic write.
    expect(readdirSync(join(dir, "sub")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("writes atomically — a reader never sees a partial file (temp + rename)", async () => {
    store.save({ big: "x".repeat(200_000) });
    await store.flush();

    expect(readdirSync(join(dir, "sub"))).toEqual(["global-settings.json"]);
    expect(JSON.parse(readFileSync(store.path, "utf-8"))).toEqual({ big: "x".repeat(200_000) });
  });

  it("moves a corrupt file aside and returns undefined — never silently discards a user's file", async () => {
    const dirty = join(dir, "sub");
    store.save({ ok: true });
    await store.flush();
    writeFileSync(store.path, "{ not json", "utf-8");

    expect(await store.load()).toBeUndefined();
    const aside = readdirSync(dirty).filter((f) => /^global-settings\.corrupt-.*\.json$/.test(f));
    expect(aside).toHaveLength(1);
    expect(existsSync(store.path)).toBe(false);
  });

  it("load() tolerates a UTF-8 BOM (PowerShell 5.1 Set-Content / BOM-writing editors) instead of calling the file corrupt", async () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(store.path, String.fromCharCode(0xfeff) + JSON.stringify({ restored: true }), "utf-8");

    expect(await store.load()).toEqual({ restored: true });
    expect(existsSync(store.path)).toBe(true);
  });

  it("flushSync() lands a write whose debounce already fired but whose async I/O has not finished (the process.exit window)", () => {
    vi.useFakeTimers();

    try {
      store.save({ inFlight: "landed" });
      // The debounce fires: the payload is handed to the async write chain, which
      // has not touched the disk yet (its first await is still queued).
      vi.advanceTimersByTime(10);
      expect(existsSync(store.path)).toBe(false);

      store.flushSync();

      expect(JSON.parse(readFileSync(store.path, "utf-8"))).toEqual({ inFlight: "landed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a payload whose write failed, cleans up its temp file, and retries it", async () => {
    // Make the destination un-renamable: the store path is a DIRECTORY, so
    // writeFile(tmp) succeeds but rename(tmp, path) fails — the Windows
    // "file held by another process" shape.
    mkdirSync(store.path, { recursive: true });
    const retrying = createFileSettingsStore({
      path: store.path,
      logger: silentLogger,
      debounceMs: 10,
      writeRetryDelaysMs: [20],
    });

    retrying.save({ survives: "the lock" });
    await retrying.flush(); // the write fails and is logged, but the payload is kept

    expect(readdirSync(join(dir, "sub")).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    rmSync(store.path, { recursive: true, force: true }); // the "lock" clears
    await new Promise((resolve) => setTimeout(resolve, 60)); // past the 20 ms retry

    expect(JSON.parse(readFileSync(store.path, "utf-8"))).toEqual({ survives: "the lock" });
    await retrying.flush();
  });

  it("does not retry a failed payload that a newer save already superseded — the retry can never overwrite the newer write", async () => {
    // Make the FIRST write fail: the store path is a directory when it runs.
    // The second write, chained behind it, runs after the directory is gone
    // and succeeds; the first must not be re-queued behind it.
    mkdirSync(store.path, { recursive: true });
    const racing = createFileSettingsStore({
      path: store.path,
      logger: silentLogger,
      debounceMs: 10,
      writeRetryDelaysMs: [20],
    });

    racing.save({ v: "older" });
    const first = racing.flush(); // enqueued; rename will fail (destination is a directory)
    racing.save({ v: "newer" });
    const second = racing.flush(); // enqueued behind the first
    // Clear the "lock" while both are queued so only the first write hits it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(store.path, { recursive: true, force: true });
    await Promise.all([first, second]);

    expect(JSON.parse(readFileSync(store.path, "utf-8"))).toEqual({ v: "newer" });
    await new Promise((resolve) => setTimeout(resolve, 60)); // past any retry of the older payload

    expect(JSON.parse(readFileSync(store.path, "utf-8"))).toEqual({ v: "newer" });
    racing.flushSync(); // nor may the shutdown flush resurrect it
    expect(JSON.parse(readFileSync(store.path, "utf-8"))).toEqual({ v: "newer" });
  });

  it("with the retry schedule exhausted the failed payload still lands on the shutdown flushSync()", async () => {
    mkdirSync(store.path, { recursive: true });
    const noRetry = createFileSettingsStore({
      path: store.path,
      logger: silentLogger,
      debounceMs: 10,
      writeRetryDelaysMs: [],
    });

    noRetry.save({ kept: "for shutdown" });
    await noRetry.flush(); // fails, no retry timer, payload kept

    rmSync(store.path, { recursive: true, force: true });
    noRetry.flushSync();

    expect(JSON.parse(readFileSync(store.path, "utf-8"))).toEqual({ kept: "for shutdown" });
  });

  it("flush() with nothing pending resolves immediately", async () => {
    await expect(store.flush()).resolves.toBeUndefined();
  });

  it("flushSync() writes the pending save synchronously — the shutdown path", () => {
    store.save({ shutdown: "saved" });

    // No await anywhere: process.on("exit") can only run synchronous work.
    store.flushSync();

    expect(JSON.parse(readFileSync(store.path, "utf-8"))).toEqual({ shutdown: "saved" });
    expect(readdirSync(join(dir, "sub")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("flushSync() clears the debounce timer so the pending write cannot fire twice", async () => {
    store.save({ n: 1 });
    store.flushSync();
    rmSync(store.path, { force: true });

    // Well past the 10 ms debounce: a surviving timer would recreate the file.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(existsSync(store.path)).toBe(false);
  });

  it("flushSync() with nothing pending writes nothing", () => {
    store.flushSync();

    expect(existsSync(store.path)).toBe(false);
  });

  it("load() resolves to undefined when rename fails (copy fallback)", async () => {
    // Setup: write a valid file, then corrupt it
    store.save({ ok: true });
    await store.flush();
    const corruptText = "{ not json";
    writeFileSync(store.path, corruptText, "utf-8");

    // Capture the mocked rename function to verify it was called
    let mockRename: ReturnType<typeof vi.fn> | undefined;

    // Mock node:fs/promises with rename failing, copyFile succeeding
    await vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      mockRename = vi.fn(async () => {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      });

      return {
        ...actual,
        rename: mockRename,
      };
    });

    vi.resetModules();
    const { createFileSettingsStore: createStoreMocked } = await import("./settings-store.js");

    const storeWithFailedRename = createStoreMocked({
      path: store.path,
      logger: silentLogger,
      debounceMs: 10,
    });

    // load() should return undefined despite rename failure (copy fallback applies)
    expect(await storeWithFailedRename.load()).toBeUndefined();

    // Assertions unique to copy-fallback path:
    // (a) Original corrupt file still exists (copy leaves source in place, unlike rename)
    expect(existsSync(store.path)).toBe(true);

    // (b) The mocked rename was called (proves the failure path was triggered)
    expect(mockRename).toBeDefined();
    expect(mockRename?.mock.calls.length).toBeGreaterThan(0);

    // (c) Verify the corrupt file was copied aside with correct content
    const aside = readdirSync(dirname(store.path)).filter((f) => /^global-settings\.corrupt-.*\.json$/.test(f));
    expect(aside.length).toBeGreaterThan(0);
    const asideContent = readFileSync(join(dirname(store.path), aside[0]), "utf-8");
    expect(asideContent).toBe(corruptText);

    vi.doUnmock("node:fs/promises");
  });
});

describe("createMemorySettingsStore", () => {
  it("returns the seed from load(), records every save(), and flush() resolves", async () => {
    const store = createMemorySettingsStore({ a: 1 });

    expect(await store.load()).toEqual({ a: 1 });
    store.save({ a: 2 });
    await store.flush();
    store.flushSync();
    expect(store.saved).toEqual([{ a: 2 }]);
  });

  it("load() is undefined with no seed", async () => {
    expect(await createMemorySettingsStore().load()).toBeUndefined();
  });
});
