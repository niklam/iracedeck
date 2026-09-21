import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrateGlobalSettingsKeys, migrateRaceEngineerVoiceId } from "./global-settings-migrations.js";
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

describe("migrateRaceEngineerVoiceId (#1144)", () => {
  const VOICES = ["aaa::default", "default::default", "zeta::matt", "beta::matt"];

  beforeEach(() => {
    _resetGlobalSettings();
  });

  afterEach(() => {
    _resetGlobalSettings();
  });

  it("does nothing before the settings store is ready", () => {
    // Before the load the cache is schema defaults, where `raceEngineerVoice`
    // is the empty string — there is nothing to qualify and writing anything
    // would persist a default over the file.
    const store = initWithStore({ raceEngineerVoice: "default" });
    const saves = store.saved.length;

    expect(migrateRaceEngineerVoiceId(VOICES, createMockLogger())).toBe(false);
    expect(store.saved).toHaveLength(saves);
  });

  it("qualifies a bare id the managed pack provides, in one write", async () => {
    const store = initWithStore({ raceEngineerVoice: "default" });
    await tick();
    const saves = store.saved.length;
    const logger = createMockLogger();

    expect(migrateRaceEngineerVoiceId(VOICES, logger)).toBe(true);
    expect(cache().raceEngineerVoice).toBe("default::default");
    expect(store.saved).toHaveLength(saves + 1);
    expect((store.saved.at(-1) as Record<string, unknown>).raceEngineerVoice).toBe("default::default");
    expect(logger.info).toHaveBeenCalledWith("Qualified the Race Engineer voice with its pack");
    expect(logger.debug).toHaveBeenCalledWith("default -> default::default");
  });

  it("qualifies a bare id only another pack provides with the alphabetically first one", async () => {
    initWithStore({ raceEngineerVoice: "matt" });
    await tick();

    expect(migrateRaceEngineerVoiceId(VOICES, createMockLogger())).toBe(true);
    expect(cache().raceEngineerVoice).toBe("beta::matt");
  });

  it("is idempotent — a second call writes nothing", async () => {
    const store = initWithStore({ raceEngineerVoice: "default" });
    await tick();

    migrateRaceEngineerVoiceId(VOICES, createMockLogger());
    const saves = store.saved.length;

    expect(migrateRaceEngineerVoiceId(VOICES, createMockLogger())).toBe(false);
    expect(store.saved).toHaveLength(saves);
  });

  it("never touches a composite value, even one no pack provides", async () => {
    const store = initWithStore({ raceEngineerVoice: "gone::voice" });
    await tick();
    const saves = store.saved.length;

    expect(migrateRaceEngineerVoiceId(VOICES, createMockLogger())).toBe(false);
    expect(cache().raceEngineerVoice).toBe("gone::voice");
    expect(store.saved).toHaveLength(saves);
  });

  it("keeps a bare id no pack provides, so a pack arriving later can still qualify it", async () => {
    // A fresh launch still downloading `default`: the value must survive
    // untouched for the re-run after that scan, never be replaced by a
    // fallback the user did not choose.
    const store = initWithStore({ raceEngineerVoice: "default" });
    await tick();
    const saves = store.saved.length;

    expect(migrateRaceEngineerVoiceId(["aria::aria"], createMockLogger())).toBe(false);
    expect(cache().raceEngineerVoice).toBe("default");
    expect(store.saved).toHaveLength(saves);

    expect(migrateRaceEngineerVoiceId(["aria::aria", "default::default"], createMockLogger())).toBe(true);
    expect(cache().raceEngineerVoice).toBe("default::default");
  });

  it("does nothing for an empty value", async () => {
    const store = initWithStore({ raceEngineerVoice: "" });
    await tick();
    const saves = store.saved.length;

    expect(migrateRaceEngineerVoiceId(VOICES, createMockLogger())).toBe(false);
    expect(store.saved).toHaveLength(saves);
  });
});
