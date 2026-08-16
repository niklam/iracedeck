import { silentLogger } from "@iracedeck/logger";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFileSettingsStore,
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

  it("flush() with nothing pending resolves immediately", async () => {
    await expect(store.flush()).resolves.toBeUndefined();
  });

  it("load() resolves to undefined when rename fails (copy fallback)", async () => {
    // Setup: write a valid file, then corrupt it
    store.save({ ok: true });
    await store.flush();
    writeFileSync(store.path, "{ not json", "utf-8");

    // Mock node:fs/promises with rename failing, copyFile succeeding
    await vi.doMock(
      "node:fs/promises",
      async () => {
        const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

        return {
          ...actual,
          rename: vi.fn(async () => {
            throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
          }),
        };
      },
      { spy: true },
    );

    vi.resetModules();
    const { createFileSettingsStore: createStoreMocked } = await import("./settings-store.js");

    const storeWithFailedRename = createStoreMocked({
      path: store.path,
      logger: silentLogger,
      debounceMs: 10,
    });

    // load() should return undefined despite rename failure (copy fallback applies)
    expect(await storeWithFailedRename.load()).toBeUndefined();

    // Verify the corrupt file was moved aside (copied, since rename failed)
    const aside = readdirSync(dirname(store.path)).filter((f) => /^global-settings\.corrupt-.*\.json$/.test(f));
    expect(aside.length).toBeGreaterThan(0);

    vi.doUnmock("node:fs/promises");
  });
});
