import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrateGlobalSettingsKeys } from "./global-settings-migrations.js";
import {
  _resetGlobalSettings,
  getGlobalSettings,
  initGlobalSettings,
  updateGlobalSettings,
} from "./global-settings.js";
import { createMemorySettingsStore } from "./settings-store.js";
import type { IDeckPlatformAdapter } from "./types.js";

type EchoCallback = (settings: unknown) => void;

function createMockLogger(): ILogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ILogger;
}

function createMockAdapter(): IDeckPlatformAdapter {
  return {
    onDidReceiveGlobalSettings: (_cb: EchoCallback) => {},
    setGlobalSettings: vi.fn<(settings: Record<string, unknown>) => void>(),
    getGlobalSettings: vi.fn<() => void>(),
  } as unknown as IDeckPlatformAdapter;
}

type MemoryStore = ReturnType<typeof createMemorySettingsStore>;

/** Let the async load inside initGlobalSettings settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Initialize against a settings file seeded with `initial` (issue #993). */
function initWithStore(initial: Record<string, unknown> = {}): MemoryStore {
  const store = createMemorySettingsStore(initial);

  initGlobalSettings(createMockAdapter(), createMockLogger(), store);

  return store;
}

const RENAMES = {
  setupChassisLeftSpringIncrease: "setupChassisLrSpringIncrease",
  setupChassisRightSpringIncrease: "setupChassisRrSpringIncrease",
};

const cache = (): Record<string, unknown> => getGlobalSettings() as Record<string, unknown>;

describe("migrateGlobalSettingsKeys", () => {
  beforeEach(() => {
    _resetGlobalSettings();
  });

  afterEach(() => {
    _resetGlobalSettings();
  });

  it("copies a stored old-key value to the new key and deletes the old key", async () => {
    initWithStore({ setupChassisLeftSpringIncrease: "OLD-BINDING" });
    await tick();

    migrateGlobalSettingsKeys(RENAMES, createMockLogger());

    expect(cache().setupChassisLrSpringIncrease).toBe("OLD-BINDING");
    expect(cache().setupChassisLeftSpringIncrease).toBeUndefined();
  });

  it("persists the migrated value to the settings store", async () => {
    const store = initWithStore({ setupChassisLeftSpringIncrease: "OLD-BINDING" });
    await tick();

    migrateGlobalSettingsKeys(RENAMES, createMockLogger());

    const lastSave = store.saved.at(-1) as Record<string, unknown>;
    expect(lastSave.setupChassisLrSpringIncrease).toBe("OLD-BINDING");
    expect(lastSave).not.toHaveProperty("setupChassisLeftSpringIncrease");
  });

  it("lets an already-set new key win and still deletes the old key", async () => {
    initWithStore({
      setupChassisLeftSpringIncrease: "OLD-BINDING",
      setupChassisLrSpringIncrease: "NEW-BINDING",
    });
    await tick();

    migrateGlobalSettingsKeys(RENAMES, createMockLogger());

    expect(cache().setupChassisLrSpringIncrease).toBe("NEW-BINDING");
    expect(cache().setupChassisLeftSpringIncrease).toBeUndefined();
  });

  it("writes nothing when the stored settings hold no old key", async () => {
    const store = initWithStore({ someOtherKey: "value" });
    await tick();
    const savesBefore = store.saved.length;

    migrateGlobalSettingsKeys(RENAMES, createMockLogger());

    expect(store.saved).toHaveLength(savesBefore);
  });

  it("defers until the settings store has loaded, then migrates", async () => {
    initWithStore({ setupChassisRightSpringIncrease: "RIGHT-BINDING" });

    migrateGlobalSettingsKeys(RENAMES, createMockLogger());

    // The store hasn't loaded yet — the cache is pure defaults, where the
    // absence of an old key proves nothing, so nothing may be migrated.
    expect(cache().setupChassisRrSpringIncrease).toBeUndefined();

    await tick();

    expect(cache().setupChassisRrSpringIncrease).toBe("RIGHT-BINDING");
    expect(cache().setupChassisRightSpringIncrease).toBeUndefined();
  });

  it("migrates each key at most once across repeated change events", async () => {
    const store = initWithStore({ setupChassisLeftSpringIncrease: "OLD-BINDING" });
    await tick();

    migrateGlobalSettingsKeys(RENAMES, createMockLogger());
    const savesAfterMigration = store.saved.length;

    // Any later settings change re-runs the subscribed migration; a settled
    // key must not be migrated (or written) a second time.
    updateGlobalSettings({ someOtherKey: "value" });

    expect(cache().setupChassisLrSpringIncrease).toBe("OLD-BINDING");
    expect(cache().setupChassisLeftSpringIncrease).toBeUndefined();
    expect(store.saved).toHaveLength(savesAfterMigration + 1); // only the unrelated write
  });
});
