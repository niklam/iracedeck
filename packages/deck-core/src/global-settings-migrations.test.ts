import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetBindingDispatcher, initializeBindingDispatcher } from "./binding-dispatcher.js";
import {
  migrateGlobalSettingsKeys,
  migrateRaceEngineerVoiceId,
  seedBindingDefaultsIfAbsent,
} from "./global-settings-migrations.js";
import {
  _resetGlobalSettings,
  getGlobalSettings,
  getSettingsStoreSource,
  GlobalSettingsSchema,
  initGlobalSettings,
  isSettingsStoreHostDerived,
  isSettingsStoreReady,
  MIGRATION_ABANDONED_KEY,
  MIGRATION_PENDING_KEY,
  updateGlobalSettings,
} from "./global-settings.js";
import { createMemorySettingsStore } from "./settings-store.js";
import type { IDeckPlatformAdapter } from "./types.js";

// Only the native send is replaced: the positive control below drives the REAL
// binding dispatcher over the REAL settings cache, so a seeded value has to
// survive the same parse a key press does.
const { mockSendKeyCombination } = vi.hoisted(() => ({
  mockSendKeyCombination: vi.fn().mockResolvedValue(true),
}));

vi.mock("./keyboard-service.js", () => ({
  getKeyboard: () => ({ sendKeyCombination: mockSendKeyCombination }),
}));

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

  it("does nothing before the settings store is ready, even with a bare value in the cache", () => {
    // A startup write can put a bare value in the cache before the load — so
    // the value alone is not what stops the migration; the readiness gate is.
    // Without it this would qualify and write.
    const store = initWithStore({ raceEngineerVoice: "default" });
    updateGlobalSettings({ raceEngineerVoice: "default" });
    const saves = store.saved.length;

    expect(migrateRaceEngineerVoiceId(VOICES, createMockLogger())).toBe(false);
    expect(cache().raceEngineerVoice).toBe("default");
    expect(store.saved).toHaveLength(saves);
  });

  it("waits for the managed pack before persisting anything, whatever else is available", async () => {
    // A leftover sideload declaring a voice called `default` (refused before
    // 3.3.0, never deleted) while `default` itself is still downloading: the
    // alphabetical half alone would write `aaa::default` for good. The
    // resolver still reads the value through the same rule meanwhile, so
    // nothing is silent; the scan that installs `default` persists the answer.
    const store = initWithStore({ raceEngineerVoice: "default" });
    await tick();
    const saves = store.saved.length;

    expect(migrateRaceEngineerVoiceId(["aaa::default", "zeta::matt"], createMockLogger())).toBe(false);
    expect(cache().raceEngineerVoice).toBe("default");
    expect(store.saved).toHaveLength(saves);

    expect(migrateRaceEngineerVoiceId(["aaa::default", "default::default"], createMockLogger())).toBe(true);
    expect(cache().raceEngineerVoice).toBe("default::default");
  });

  it("persists an alphabetical answer once the managed pack is present, even for a voice it lacks", async () => {
    // The gate is about the managed PACK being there, not about it providing
    // this voice: with `default` installed the pre-3.3.0 order is fully known.
    initWithStore({ raceEngineerVoice: "matt" });
    await tick();

    expect(migrateRaceEngineerVoiceId(["default::default", "zeta::matt", "beta::matt"], createMockLogger())).toBe(true);
    expect(cache().raceEngineerVoice).toBe("beta::matt");
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
    // The managed pack is present but does not provide this voice, and no
    // other pack does yet: the value must survive untouched for the re-run
    // after a later scan, never be replaced by a fallback the user did not
    // choose.
    const store = initWithStore({ raceEngineerVoice: "matt" });
    await tick();
    const saves = store.saved.length;

    expect(migrateRaceEngineerVoiceId(["default::default"], createMockLogger())).toBe(false);
    expect(cache().raceEngineerVoice).toBe("matt");
    expect(store.saved).toHaveLength(saves);

    expect(migrateRaceEngineerVoiceId(["default::default", "zeta::matt"], createMockLogger())).toBe(true);
    expect(cache().raceEngineerVoice).toBe("zeta::matt");
  });

  it("does nothing for an empty value", async () => {
    const store = initWithStore({ raceEngineerVoice: "" });
    await tick();
    const saves = store.saved.length;

    expect(migrateRaceEngineerVoiceId(VOICES, createMockLogger())).toBe(false);
    expect(store.saved).toHaveLength(saves);
  });
});

describe("seedBindingDefaultsIfAbsent (#1277)", () => {
  // What Camera Controls' Cycle by Track Order supplies (iracing-actions'
  // CAR_CYCLE_BINDING_DEFAULTS, read from key-bindings.json).
  const DEFAULTS = { replayControlNextCar: "V", replayControlPrevCar: "Shift+V" };
  // What `ird-key-binding` saves for those defaults: JSON.stringify(parseSimpleDefault(...)).
  // pi-components' key-binding-default-parity.test.ts pins the two sides together.
  const NEXT_STORED = '{"type":"keyboard","key":"v","modifiers":[],"code":"KeyV"}';
  const PREV_STORED = '{"type":"keyboard","key":"v","modifiers":["shift"],"code":"KeyV"}';
  const CUSTOM = JSON.stringify({ type: "keyboard", key: "n", modifiers: ["ctrl"], code: "KeyN" });

  /** An adapter whose host answer the test can deliver (`echo`). */
  function createEchoAdapter(): { adapter: IDeckPlatformAdapter; echo: (settings: unknown) => void } {
    let echo: EchoCallback = () => {};

    const adapter = {
      onDidReceiveGlobalSettings: (cb: EchoCallback) => {
        echo = cb;
      },
      setGlobalSettings: vi.fn<(settings: Record<string, unknown>) => void>(),
      getGlobalSettings: vi.fn<() => void>(),
    } as unknown as IDeckPlatformAdapter;

    return { adapter, echo: (settings) => echo(settings) };
  }

  /** A defaults-born file, as a fresh start persisted it. */
  const defaultsFile = (extra: Record<string, unknown>): Record<string, unknown> => ({
    ...(GlobalSettingsSchema.parse({}) as Record<string, unknown>),
    ...extra,
  });

  beforeEach(() => {
    _resetGlobalSettings();
    _resetBindingDispatcher();
    mockSendKeyCombination.mockClear();
  });

  afterEach(() => {
    _resetGlobalSettings();
    _resetBindingDispatcher();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("seeds both keys, in the value the binding field stores, when neither was ever stored", async () => {
    const store = initWithStore({ driverName: "kept" });
    await tick();

    seedBindingDefaultsIfAbsent(DEFAULTS, createMockLogger());

    expect(cache().replayControlNextCar).toBe(NEXT_STORED);
    expect(cache().replayControlPrevCar).toBe(PREV_STORED);
    expect(store.saved.at(-1)).toMatchObject({
      replayControlNextCar: NEXT_STORED,
      replayControlPrevCar: PREV_STORED,
      driverName: "kept",
    });
  });

  it("never touches a stored binding — only the absent key is seeded", async () => {
    initWithStore({ replayControlNextCar: CUSTOM });
    await tick();

    seedBindingDefaultsIfAbsent(DEFAULTS, createMockLogger());

    expect(cache().replayControlNextCar).toBe(CUSTOM);
    expect(cache().replayControlPrevCar).toBe(PREV_STORED);
  });

  it("keeps a deliberately cleared binding cleared", async () => {
    const store = initWithStore({ replayControlNextCar: "", replayControlPrevCar: "" });
    await tick();
    const savesBefore = store.saved.length;

    seedBindingDefaultsIfAbsent(DEFAULTS, createMockLogger());

    expect(cache().replayControlNextCar).toBe("");
    expect(cache().replayControlPrevCar).toBe("");
    expect(store.saved).toHaveLength(savesBefore);
  });

  it("writes nothing before the stored settings have loaded, then seeds once they have", async () => {
    initWithStore({});

    seedBindingDefaultsIfAbsent(DEFAULTS, createMockLogger());

    // The cache is pure schema defaults here: absence proves nothing.
    expect(isSettingsStoreReady()).toBe(false);
    expect(cache().replayControlNextCar).toBeUndefined();

    // A change arriving before the store is ready must not trigger it either.
    updateGlobalSettings({ someOtherKey: "early" });
    expect(cache().replayControlNextCar).toBeUndefined();

    await tick();

    expect(cache().replayControlNextCar).toBe(NEXT_STORED);
    expect(cache().replayControlPrevCar).toBe(PREV_STORED);
  });

  it("runs harmlessly a second time (every start calls it)", async () => {
    const store = initWithStore({});
    await tick();

    seedBindingDefaultsIfAbsent(DEFAULTS, createMockLogger());
    const savesAfterSeed = store.saved.length;
    seedBindingDefaultsIfAbsent(DEFAULTS, createMockLogger());
    updateGlobalSettings({ someOtherKey: "value" });

    expect(store.saved).toHaveLength(savesAfterSeed + 1); // only the unrelated write
    expect(cache().replayControlNextCar).toBe(NEXT_STORED);
    expect(cache().replayControlPrevCar).toBe(PREV_STORED);
  });

  it("skips a default that names no key rather than storing an empty binding", async () => {
    initWithStore({});
    await tick();
    const logger = createMockLogger();

    seedBindingDefaultsIfAbsent({ replayControlNextCar: "V", somethingElse: "Hyper+Q1" }, logger);

    expect(cache().replayControlNextCar).toBe(NEXT_STORED);
    expect(cache().somethingElse).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  describe("only on a store that has read the deck host", () => {
    it("seeds after a host migration, keeping what the host held", async () => {
      const { adapter, echo } = createEchoAdapter();
      initGlobalSettings(adapter, createMockLogger(), createMemorySettingsStore());
      seedBindingDefaultsIfAbsent(DEFAULTS, createMockLogger());
      await tick();

      echo({ replayControlNextCar: CUSTOM });

      expect(getSettingsStoreSource()).toBe("host");
      expect(isSettingsStoreHostDerived()).toBe(true);
      expect(cache().replayControlNextCar).toBe(CUSTOM);
      expect(cache().replayControlPrevCar).toBe(PREV_STORED);
    });

    it("does not seed a fresh store (the host never answered): the binding may be in the copy nobody read", async () => {
      vi.useFakeTimers();
      const store = createMemorySettingsStore();
      initGlobalSettings(createMockAdapter(), createMockLogger(), store, { migrationTimeoutMs: 20 });
      const logger = createMockLogger();
      seedBindingDefaultsIfAbsent(DEFAULTS, logger);

      await vi.advanceTimersByTimeAsync(30);

      expect(getSettingsStoreSource()).toBe("fresh");
      expect(isSettingsStoreHostDerived()).toBe(false);
      expect(cache().replayControlNextCar).toBeUndefined();
      expect(cache().replayControlPrevCar).toBeUndefined();
      expect(store.saved.at(-1)).not.toHaveProperty("replayControlNextCar");
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("not seeded"));
    });

    it("does not seed a file still carrying the pending-migration countdown while the host stays silent", async () => {
      vi.useFakeTimers();
      const store = createMemorySettingsStore(defaultsFile({ [MIGRATION_PENDING_KEY]: 1 }));
      initGlobalSettings(createMockAdapter(), createMockLogger(), store, { migrationTimeoutMs: 20 });
      seedBindingDefaultsIfAbsent(DEFAULTS, createMockLogger());

      await vi.advanceTimersByTimeAsync(30);

      expect(isSettingsStoreReady()).toBe(true);
      expect(isSettingsStoreHostDerived()).toBe(false);
      expect(cache().replayControlNextCar).toBeUndefined();
    });

    it("seeds on the start whose host answer finally lands, under the host's own binding", async () => {
      const { adapter, echo } = createEchoAdapter();
      initGlobalSettings(
        adapter,
        createMockLogger(),
        createMemorySettingsStore(defaultsFile({ [MIGRATION_PENDING_KEY]: 1 })),
      );
      seedBindingDefaultsIfAbsent(DEFAULTS, createMockLogger());
      await tick();

      echo({ replayControlPrevCar: CUSTOM });

      expect(isSettingsStoreHostDerived()).toBe(true);
      expect(cache().replayControlNextCar).toBe(NEXT_STORED);
      expect(cache().replayControlPrevCar).toBe(CUSTOM);
    });

    it("does not seed a store whose migration was given up on", async () => {
      initWithStore(defaultsFile({ [MIGRATION_ABANDONED_KEY]: "3.3.0" }));
      await tick();

      seedBindingDefaultsIfAbsent(DEFAULTS, createMockLogger());

      expect(getSettingsStoreSource()).toBe("file");
      expect(isSettingsStoreHostDerived()).toBe(false);
      expect(cache().replayControlNextCar).toBeUndefined();
    });

    it("does not seed when the stored file could not be parsed at all", async () => {
      initWithStore({ driverName: "kept" });
      // parseWithSalvage gives up wholesale on a failure it cannot pin to a key.
      vi.spyOn(GlobalSettingsSchema, "safeParse").mockReturnValueOnce({
        success: false,
        error: { issues: [{ path: [] }] },
      } as unknown as ReturnType<typeof GlobalSettingsSchema.safeParse>);
      await tick();

      seedBindingDefaultsIfAbsent(DEFAULTS, createMockLogger());

      expect(isSettingsStoreReady()).toBe(true);
      expect(getSettingsStoreSource()).toBe("file");
      expect(cache().driverName).not.toBe("kept"); // proof the salvage-failed path ran
      expect(isSettingsStoreHostDerived()).toBe(false);
      expect(cache().replayControlNextCar).toBeUndefined();
    });
  });

  describe("positive control: the real binding dispatcher over the real cache", () => {
    it("reads both keys as missing before the seed, as set after it, and taps V / Shift+V", async () => {
      initWithStore({});
      await tick();
      const dispatcher = initializeBindingDispatcher(createMockLogger());

      // The check can fail: with nothing stored both read as missing (#612) and a tap sends nothing.
      expect(dispatcher.isConfigured("replayControlNextCar")).toBe(false);
      expect(dispatcher.isConfigured("replayControlPrevCar")).toBe(false);
      expect(await dispatcher.tap("replayControlNextCar")).toBe(false);
      expect(mockSendKeyCombination).not.toHaveBeenCalled();

      seedBindingDefaultsIfAbsent(DEFAULTS, createMockLogger());

      expect(dispatcher.isConfigured("replayControlNextCar")).toBe(true);
      expect(dispatcher.isConfigured("replayControlPrevCar")).toBe(true);
      expect(dispatcher.isKeyboardBound("replayControlPrevCar")).toBe(true);

      expect(await dispatcher.tap("replayControlNextCar")).toBe(true);
      expect(await dispatcher.tap("replayControlPrevCar")).toBe(true);
      expect(mockSendKeyCombination).toHaveBeenNthCalledWith(1, { key: "v", modifiers: undefined, code: "KeyV" });
      expect(mockSendKeyCombination).toHaveBeenNthCalledWith(2, { key: "v", modifiers: ["shift"], code: "KeyV" });
    });

    it("leaves a cleared binding reading as missing", async () => {
      initWithStore({ replayControlNextCar: "" });
      await tick();
      const dispatcher = initializeBindingDispatcher(createMockLogger());

      seedBindingDefaultsIfAbsent(DEFAULTS, createMockLogger());

      expect(dispatcher.isConfigured("replayControlNextCar")).toBe(false);
      expect(dispatcher.isConfigured("replayControlPrevCar")).toBe(true);
    });
  });
});
