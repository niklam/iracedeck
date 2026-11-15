import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupRetiredDisconnectedSetting,
  FUEL_MARGIN_DEFAULT_MIGRATED_KEY,
  migrateFuelMarginDefault,
  migrateGlobalSettingsKeys,
  migrateRaceEngineerVoiceId,
  seedBindingDefaultsIfAbsent,
} from "./global-settings-migrations.js";
import {
  _resetGlobalSettings,
  getGlobalSettings,
  getSettingsStoreHostDerivation,
  getSettingsStoreSource,
  GlobalSettingsSchema,
  initGlobalSettings,
  isSettingsStoreHostDerived,
  isSettingsStoreReady,
  MIGRATION_ABANDONED_KEY,
  MIGRATION_PENDING_KEY,
  runOnceSettingsStoreReady,
  updateGlobalSettings,
} from "./global-settings.js";
import type { SettingsHost } from "./settings-host.js";
import { createMemorySettingsStore } from "./settings-store.js";

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

function createMockAdapter(): SettingsHost {
  return {
    onDidReceiveGlobalSettings: (_cb: EchoCallback) => {},
    setGlobalSettings: vi.fn<(settings: Record<string, unknown>) => void>(),
    getGlobalSettings: vi.fn<() => void>(),
  };
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

/** An adapter whose host answer the test can deliver (`echo`). */
function createEchoAdapter(): { adapter: SettingsHost; echo: (settings: unknown) => void } {
  let echo: EchoCallback = () => {};

  const adapter: SettingsHost = {
    onDidReceiveGlobalSettings: (cb: EchoCallback) => {
      echo = cb;
    },
    setGlobalSettings: vi.fn<(settings: Record<string, unknown>) => void>(),
    getGlobalSettings: vi.fn<() => void>(),
  };

  return { adapter, echo: (settings) => echo(settings) };
}

/** A defaults-born file, as a fresh start persisted it. */
const defaultsFile = (extra: Record<string, unknown>): Record<string, unknown> => ({
  ...(GlobalSettingsSchema.parse({}) as Record<string, unknown>),
  ...extra,
});

describe("runOnceSettingsStoreReady", () => {
  beforeEach(() => {
    _resetGlobalSettings();
  });

  afterEach(() => {
    _resetGlobalSettings();
  });

  it("runs at once on a ready store", async () => {
    initWithStore({});
    await tick();
    const action = vi.fn();

    runOnceSettingsStoreReady(action);

    expect(action).toHaveBeenCalledTimes(1);
  });

  it("waits for the store, runs once, and never again on later changes", async () => {
    initWithStore({});
    const action = vi.fn();

    runOnceSettingsStoreReady(action);
    updateGlobalSettings({ early: 1 }); // a change before ready does not count
    expect(action).not.toHaveBeenCalled();

    await tick();
    updateGlobalSettings({ later: 1 });

    expect(action).toHaveBeenCalledTimes(1);
  });

  it("is done before the action runs, so an action that writes settings is not re-entered", async () => {
    initWithStore({});
    const action = vi.fn(() => updateGlobalSettings({ writtenByAction: true }));

    runOnceSettingsStoreReady(action);
    await tick();

    expect(action).toHaveBeenCalledTimes(1);
    expect(cache().writtenByAction).toBe(true);
  });

  it("runs nothing once disposed before the store is ready", async () => {
    initWithStore({});
    const action = vi.fn();

    runOnceSettingsStoreReady(action)();
    await tick();

    expect(action).not.toHaveBeenCalled();
  });
});

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

describe("cleanupRetiredDisconnectedSetting (#1599)", () => {
  const RETIRED = "disableWhenDisconnected";

  beforeEach(() => {
    _resetGlobalSettings();
  });

  afterEach(() => {
    _resetGlobalSettings();
  });

  it("is a passthrough key now, so a stored copy is visible in the cache (precondition)", async () => {
    // Positive control for every test below: if the schema still declared the
    // key, the cache would hold it on every store and "nothing to delete"
    // could never be observed.
    initWithStore({});
    await tick();

    expect(cache()).not.toHaveProperty(RETIRED);
  });

  it.each([true, false, "true", "false"])("deletes a stored %j from the cache and the file", async (value) => {
    const store = initWithStore({ [RETIRED]: value, driverName: "nick" });
    await tick();
    expect(cache()[RETIRED]).toBe(value);

    cleanupRetiredDisconnectedSetting(createMockLogger());

    expect(cache()).not.toHaveProperty(RETIRED);
    const lastSave = store.saved.at(-1) as Record<string, unknown>;
    expect(lastSave).not.toHaveProperty(RETIRED);
    // Nothing else in the file is touched.
    expect(lastSave.driverName).toBe("nick");
  });

  it.each([
    { stored: true, show: undefined, expected: false },
    { stored: true, show: false, expected: false },
    { stored: false, show: true, expected: true },
    { stored: "true", show: undefined, expected: false },
  ])(
    "carries nothing over: retired $stored with showDisconnectedState $show leaves it at $expected",
    async ({ stored, show, expected }) => {
      const initial: Record<string, unknown> = { [RETIRED]: stored };

      if (show !== undefined) initial.showDisconnectedState = show;

      const store = initWithStore(initial);
      await tick();

      cleanupRetiredDisconnectedSetting(createMockLogger());

      expect(cache().showDisconnectedState).toBe(expected);
      expect((store.saved.at(-1) as Record<string, unknown>).showDisconnectedState).toBe(expected);
    },
  );

  it("writes nothing and logs nothing when the file holds no retired key", async () => {
    const store = initWithStore({ showDisconnectedState: true });
    await tick();
    const savesBefore = store.saved.length;
    const logger = createMockLogger();

    cleanupRetiredDisconnectedSetting(logger);

    expect(store.saved).toHaveLength(savesBefore);
    expect(cache().showDisconnectedState).toBe(true);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs the deletion at info, naming the key only at debug", async () => {
    initWithStore({ [RETIRED]: true });
    await tick();
    const logger = createMockLogger();

    cleanupRetiredDisconnectedSetting(logger);

    expect(logger.info).toHaveBeenCalledWith("Deleted a retired global setting");
    expect(logger.debug).toHaveBeenCalledWith(`Deleted: ${RETIRED}`);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does nothing before the store is ready, then deletes once it is", async () => {
    const store = initWithStore({ [RETIRED]: true });

    cleanupRetiredDisconnectedSetting(createMockLogger());

    // Not loaded yet: the cache is pure defaults and nothing has been written.
    expect(isSettingsStoreReady()).toBe(false);
    expect(store.saved).toHaveLength(0);

    await tick();

    expect(isSettingsStoreReady()).toBe(true);
    expect(cache()).not.toHaveProperty(RETIRED);
    expect(store.saved.at(-1) as Record<string, unknown>).not.toHaveProperty(RETIRED);
  });

  it("returns a disposer that cancels a still-pending cleanup", async () => {
    initWithStore({ [RETIRED]: true });

    const dispose = cleanupRetiredDisconnectedSetting(createMockLogger());
    dispose();
    await tick();

    expect(cache()[RETIRED]).toBe(true);
  });

  it("is idempotent: a second run writes nothing", async () => {
    const store = initWithStore({ [RETIRED]: "true" });
    await tick();

    cleanupRetiredDisconnectedSetting(createMockLogger());
    const savesAfterFirst = store.saved.length;
    const logger = createMockLogger();

    cleanupRetiredDisconnectedSetting(logger);

    expect(store.saved).toHaveLength(savesAfterFirst);
    expect(cache()).not.toHaveProperty(RETIRED);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("runs once per start: a copy written back later in the run waits for the next start", async () => {
    initWithStore({ [RETIRED]: true });
    await tick();

    cleanupRetiredDisconnectedSetting(createMockLogger());
    // An older page's whole-snapshot frame brings the key back.
    updateGlobalSettings({ [RETIRED]: true });

    expect(cache()[RETIRED]).toBe(true);

    // The next start's run deletes it again.
    cleanupRetiredDisconnectedSetting(createMockLogger());

    expect(cache()).not.toHaveProperty(RETIRED);
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
  // One parser for both (app-constants key-binding-defaults.ts); pi-components'
  // key-binding-input.default-save.test.ts pins the field's save to it.
  const NEXT_STORED = '{"type":"keyboard","key":"v","modifiers":[],"code":"KeyV"}';
  const PREV_STORED = '{"type":"keyboard","key":"v","modifiers":["shift"],"code":"KeyV"}';
  const CUSTOM = JSON.stringify({ type: "keyboard", key: "n", modifiers: ["ctrl"], code: "KeyN" });

  beforeEach(() => {
    _resetGlobalSettings();
  });

  afterEach(() => {
    _resetGlobalSettings();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("seeds both keys, in the value the binding field stores, when neither was ever stored", async () => {
    const store = initWithStore({ driverName: "kept" });
    await tick();
    const logger = createMockLogger();

    seedBindingDefaultsIfAbsent(DEFAULTS, logger);

    expect(cache().replayControlNextCar).toBe(NEXT_STORED);
    expect(cache().replayControlPrevCar).toBe(PREV_STORED);
    expect(logger.info).toHaveBeenCalledWith("Seeded default key bindings");
    expect(logger.warn).not.toHaveBeenCalled();
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

  it("claims the seed only for a write that landed, and warns when the write was rejected", async () => {
    initWithStore({});
    await tick();
    const logger = createMockLogger();
    // The seed's own write fails its parse wholesale, so updateGlobalSettings
    // drops it — the cache never holds the value the seed handed over.
    vi.spyOn(GlobalSettingsSchema, "safeParse").mockReturnValueOnce({
      success: false,
      error: { issues: [{ path: [] }] },
    } as unknown as ReturnType<typeof GlobalSettingsSchema.safeParse>);

    seedBindingDefaultsIfAbsent(DEFAULTS, logger);

    expect(cache().replayControlNextCar).toBeUndefined();
    expect(logger.info).not.toHaveBeenCalledWith("Seeded default key bindings");
    expect(logger.warn).toHaveBeenCalledWith("Binding default seed write was rejected");
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
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("have not been read from the deck host yet"));
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

    it("does not seed a store whose migration was given up on, and says so without promising a later seed", async () => {
      initWithStore(defaultsFile({ [MIGRATION_ABANDONED_KEY]: "3.3.0" }));
      await tick();
      const logger = createMockLogger();

      seedBindingDefaultsIfAbsent(DEFAULTS, logger);

      expect(getSettingsStoreSource()).toBe("file");
      expect(isSettingsStoreHostDerived()).toBe(false);
      expect(cache().replayControlNextCar).toBeUndefined();
      expect(logger.info).toHaveBeenCalledWith(
        "Binding defaults not seeded: the migration from the deck host was given up on; binding defaults are left to the user",
      );
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("yet"));
    });

    describe("an abandoned store on the upgrade that asks the host once more (#1041 / #1047)", () => {
      /** An abandoned defaults file, loaded by a newer build so the give-up retry fires. */
      function initRetry(): { echo: (settings: unknown) => void; logger: ILogger } {
        const { adapter, echo } = createEchoAdapter();
        const logger = createMockLogger();
        initGlobalSettings(
          adapter,
          createMockLogger(),
          createMemorySettingsStore(defaultsFile({ [MIGRATION_ABANDONED_KEY]: "3.3.0" })),
          { pluginVersion: "3.4.0" },
        );
        // As every plugin does: called at startup, before the store is ready.
        seedBindingDefaultsIfAbsent(DEFAULTS, logger);

        return { echo, logger };
      }

      it("keeps the host's custom Next Car through the retry merge and seeds only Previous Car", async () => {
        const { echo, logger } = initRetry();
        await tick();

        // The retry is waiting on the host: nothing is ready, nothing seeded.
        expect(isSettingsStoreReady()).toBe(false);
        expect(cache().replayControlNextCar).toBeUndefined();

        echo({ replayControlNextCar: CUSTOM, driverName: "from the host" });

        // A real answer retires the marker, so the store is host-derived now.
        expect(getSettingsStoreSource()).toBe("host");
        expect(cache()[MIGRATION_ABANDONED_KEY]).toBeUndefined();
        expect(isSettingsStoreHostDerived()).toBe(true);
        expect(cache().replayControlNextCar).toBe(CUSTOM);
        expect(cache().replayControlPrevCar).toBe(PREV_STORED);
        expect(logger.info).toHaveBeenCalledWith("Seeded default key bindings");
      });

      it("seeds nothing when the retry's answer is empty: the store stays abandoned", async () => {
        const { echo, logger } = initRetry();
        await tick();

        echo({});

        expect(getSettingsStoreSource()).toBe("file");
        expect(isSettingsStoreHostDerived()).toBe(false);
        expect(cache().replayControlNextCar).toBeUndefined();
        expect(cache().replayControlPrevCar).toBeUndefined();
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("given up on"));
      });
    });

    it("does not seed when the stored file could not be parsed at all", async () => {
      initWithStore({ driverName: "kept" });
      // parseWithSalvage gives up wholesale on a failure it cannot pin to a key.
      vi.spyOn(GlobalSettingsSchema, "safeParse").mockReturnValueOnce({
        success: false,
        error: { issues: [{ path: [] }] },
      } as unknown as ReturnType<typeof GlobalSettingsSchema.safeParse>);
      await tick();

      const logger = createMockLogger();

      seedBindingDefaultsIfAbsent(DEFAULTS, logger);

      expect(isSettingsStoreReady()).toBe(true);
      expect(getSettingsStoreSource()).toBe("file");
      expect(cache().driverName).not.toBe("kept"); // proof the salvage-failed path ran
      expect(isSettingsStoreHostDerived()).toBe(false);
      expect(cache().replayControlNextCar).toBeUndefined();
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("could not be parsed"));
    });
  });
});

describe("migrateFuelMarginDefault (#1679)", () => {
  const MARKER = FUEL_MARGIN_DEFAULT_MIGRATED_KEY;
  const VERSION = "3.9.0";
  const MOVED = "Fuel margin moved from the old default 0.3 to 0";
  const REJECTED = "Fuel margin default migration write was rejected";

  const lastSave = (store: MemoryStore): Record<string, unknown> => store.saved.at(-1) as Record<string, unknown>;

  /** A silent host and a short migration deadline: the host read times out. */
  function initSilentHost(initial?: Record<string, unknown>): MemoryStore {
    const store = createMemorySettingsStore(initial);
    initGlobalSettings(createMockAdapter(), createMockLogger(), store, { migrationTimeoutMs: 20 });

    return store;
  }

  beforeEach(() => {
    _resetGlobalSettings();
  });

  afterEach(() => {
    _resetGlobalSettings();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts from a schema default of 0 and a marker the schema does not declare (precondition)", async () => {
    // Positive control: a stored 0 must be the new default for "leaves 0
    // alone" to mean anything, and the marker must be a passthrough key or a
    // "not marked" store could never be observed.
    initWithStore({});
    await tick();

    expect(cache().fuelCalloutMarginLaps).toBe(0);
    expect(cache()).not.toHaveProperty(MARKER);
  });

  it("moves a stored 0.3 to 0 and marks it with the running version, in one write", async () => {
    const store = initWithStore({ fuelCalloutMarginLaps: 0.3, driverName: "kept" });
    await tick();
    expect(cache().fuelCalloutMarginLaps).toBe(0.3);
    const savesBefore = store.saved.length;
    const logger = createMockLogger();

    migrateFuelMarginDefault(VERSION, logger);

    expect(cache().fuelCalloutMarginLaps).toBe(0);
    expect(cache()[MARKER]).toBe(VERSION);
    expect(store.saved).toHaveLength(savesBefore + 1);
    expect(lastSave(store)).toMatchObject({ fuelCalloutMarginLaps: 0, [MARKER]: VERSION, driverName: "kept" });
    expect(logger.info).toHaveBeenCalledWith(MOVED);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("moves a hand-edited string 0.3, which the parse reads as the number", async () => {
    initWithStore({ fuelCalloutMarginLaps: "0.3" });
    await tick();

    migrateFuelMarginDefault(VERSION, createMockLogger());

    expect(cache().fuelCalloutMarginLaps).toBe(0);
    expect(cache()[MARKER]).toBe(VERSION);
  });

  it.each([0.4, 0, 0.2, 1])("leaves a stored %d alone and marks it done, logging only at debug", async (value) => {
    const store = initWithStore({ fuelCalloutMarginLaps: value });
    await tick();
    const savesBefore = store.saved.length;
    const logger = createMockLogger();

    migrateFuelMarginDefault(VERSION, logger);

    expect(cache().fuelCalloutMarginLaps).toBe(value);
    expect(cache()[MARKER]).toBe(VERSION);
    expect(store.saved).toHaveLength(savesBefore + 1);
    expect(lastSave(store)).toMatchObject({ fuelCalloutMarginLaps: value, [MARKER]: VERSION });
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("marked done; nothing to move"));
  });

  it("marks a fresh install (nothing stored) without moving anything", async () => {
    const { adapter, echo } = createEchoAdapter();
    initGlobalSettings(adapter, createMockLogger(), createMemorySettingsStore());
    migrateFuelMarginDefault(VERSION, createMockLogger());
    await tick();

    echo({});

    expect(getSettingsStoreSource()).toBe("host");
    expect(cache().fuelCalloutMarginLaps).toBe(0);
    expect(cache()[MARKER]).toBe(VERSION);
  });

  it.each([true, VERSION, "3.8.0"])("does nothing on a store already marked %j, even with 0.3 stored", async (mark) => {
    const store = initWithStore({ fuelCalloutMarginLaps: 0.3, [MARKER]: mark });
    await tick();
    const savesBefore = store.saved.length;
    const logger = createMockLogger();

    migrateFuelMarginDefault(VERSION, logger);

    expect(cache().fuelCalloutMarginLaps).toBe(0.3);
    expect(cache()[MARKER]).toBe(mark);
    expect(store.saved).toHaveLength(savesBefore);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("keeps a 0.3 the user chose again after the upgrade, at every later start", async () => {
    const store = initWithStore({ fuelCalloutMarginLaps: 0.3 });
    await tick();
    migrateFuelMarginDefault(VERSION, createMockLogger());
    updateGlobalSettings({ fuelCalloutMarginLaps: 0.3 }); // the slider, put back
    const file = lastSave(store);

    // The next start loads that file.
    _resetGlobalSettings();
    const next = initWithStore(file);
    await tick();
    const savesBefore = next.saved.length;

    migrateFuelMarginDefault(VERSION, createMockLogger());

    expect(cache().fuelCalloutMarginLaps).toBe(0.3);
    expect(next.saved).toHaveLength(savesBefore);
  });

  it.each([undefined, "", "   "])("marks true when the running version is %j", async (version) => {
    initWithStore({ fuelCalloutMarginLaps: 0.3 });
    await tick();

    migrateFuelMarginDefault(version, createMockLogger());

    expect(cache().fuelCalloutMarginLaps).toBe(0);
    expect(cache()[MARKER]).toBe(true);
  });

  it("trims the version it records", async () => {
    initWithStore({});
    await tick();

    migrateFuelMarginDefault(` ${VERSION} `, createMockLogger());

    expect(cache()[MARKER]).toBe(VERSION);
  });

  it("does nothing before the store is ready, then runs at the ready moment", async () => {
    const store = initWithStore({ fuelCalloutMarginLaps: 0.3 });

    migrateFuelMarginDefault(VERSION, createMockLogger());
    // A change before ready must not trigger it either.
    updateGlobalSettings({ someOtherKey: "early" });

    expect(isSettingsStoreReady()).toBe(false);
    expect(store.saved).toHaveLength(0);
    expect(cache()).not.toHaveProperty(MARKER);

    await tick();

    expect(cache().fuelCalloutMarginLaps).toBe(0);
    expect(cache()[MARKER]).toBe(VERSION);
    expect(lastSave(store)).toMatchObject({ fuelCalloutMarginLaps: 0, [MARKER]: VERSION });
  });

  it("returns a disposer that cancels a still-pending migration", async () => {
    initWithStore({ fuelCalloutMarginLaps: 0.3 });

    migrateFuelMarginDefault(VERSION, createMockLogger())();
    await tick();

    expect(cache().fuelCalloutMarginLaps).toBe(0.3);
    expect(cache()).not.toHaveProperty(MARKER);
  });

  describe("by the store's host-read status", () => {
    it("writes nothing while the pending-migration countdown runs, then moves the host's 0.3 on the start whose answer lands", async () => {
      // A defaults-born file under the new default (0) whose host read is
      // still pending. The host holds the old default 0.3.
      vi.useFakeTimers();
      const first = initSilentHost(defaultsFile({ [MIGRATION_PENDING_KEY]: 1 }));
      const logger = createMockLogger();
      migrateFuelMarginDefault(VERSION, logger);

      await vi.advanceTimersByTimeAsync(30);

      expect(isSettingsStoreReady()).toBe(true);
      expect(getSettingsStoreHostDerivation()).toBe("not-read-yet");
      expect(cache()).not.toHaveProperty(MARKER);
      expect(first.saved.every((saved) => !(MARKER in saved))).toBe(true);
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("have not been read from the deck host yet"));
      expect(logger.info).not.toHaveBeenCalled();

      // The next start: the host answers. `mergeMigration` lets the host's 0.3
      // win over the file's default 0, so a marker written above would have
      // left 0.3 in place for good.
      const file = lastSave(first);
      _resetGlobalSettings();
      vi.useRealTimers();
      const { adapter, echo } = createEchoAdapter();
      const second = createMemorySettingsStore(file);
      initGlobalSettings(adapter, createMockLogger(), second);
      const nextLogger = createMockLogger();
      migrateFuelMarginDefault(VERSION, nextLogger);
      await tick();

      echo({ fuelCalloutMarginLaps: 0.3, driverName: "from the host" });

      expect(getSettingsStoreSource()).toBe("host");
      expect(getSettingsStoreHostDerivation()).toBe("host-derived");
      expect(nextLogger.info).toHaveBeenCalledWith(MOVED); // the merge did hand it 0.3
      expect(cache().fuelCalloutMarginLaps).toBe(0);
      expect(cache()[MARKER]).toBe(VERSION);
      expect(cache().driverName).toBe("from the host");
      expect(lastSave(second)).toMatchObject({ fuelCalloutMarginLaps: 0, [MARKER]: VERSION });
    });

    describe("a pending file an older build wrote under the old default 0.3", () => {
      /** What a 3.8 fresh start persisted: its defaults (0.3 among them) and the countdown. */
      const bornUnderOldDefault = (): Record<string, unknown> =>
        defaultsFile({ fuelCalloutMarginLaps: 0.3, [MIGRATION_PENDING_KEY]: 1 });

      /** The start whose host answer lands, with the migration called at startup as every plugin does. */
      async function answerWith(host: Record<string, unknown>): Promise<{ store: MemoryStore; logger: ILogger }> {
        const { adapter, echo } = createEchoAdapter();
        const store = createMemorySettingsStore(bornUnderOldDefault());
        initGlobalSettings(adapter, createMockLogger(), store);
        const logger = createMockLogger();
        migrateFuelMarginDefault(VERSION, logger);
        await tick();

        expect(isSettingsStoreReady()).toBe(false); // the read is out

        echo(host);

        expect(getSettingsStoreSource()).toBe("host");
        expect(getSettingsStoreHostDerivation()).toBe("host-derived");

        return { store, logger };
      }

      it("keeps the host's chosen margin: the file's old default does not beat it and is not then moved", async () => {
        const { store, logger } = await answerWith({ fuelCalloutMarginLaps: 1, driverName: "from the host" });

        expect(cache().fuelCalloutMarginLaps).toBe(1);
        expect(cache()[MARKER]).toBe(VERSION);
        expect(lastSave(store)).toMatchObject({ fuelCalloutMarginLaps: 1, [MARKER]: VERSION });
        expect(logger.info).not.toHaveBeenCalledWith(MOVED);
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("marked done; nothing to move"));
      });

      it("moves the host's own 0.3, the old default it persisted, to 0", async () => {
        const { store, logger } = await answerWith({ fuelCalloutMarginLaps: 0.3, driverName: "from the host" });

        expect(cache().fuelCalloutMarginLaps).toBe(0);
        expect(cache()[MARKER]).toBe(VERSION);
        expect(cache().driverName).toBe("from the host");
        expect(lastSave(store)).toMatchObject({ fuelCalloutMarginLaps: 0, [MARKER]: VERSION });
        expect(logger.info).toHaveBeenCalledWith(MOVED);
      });
    });

    it("writes nothing on a fresh start whose host read timed out", async () => {
      vi.useFakeTimers();
      const store = initSilentHost();
      const logger = createMockLogger();
      migrateFuelMarginDefault(VERSION, logger);

      await vi.advanceTimersByTimeAsync(30);

      expect(getSettingsStoreSource()).toBe("fresh");
      expect(getSettingsStoreHostDerivation()).toBe("not-read-yet");
      expect(cache()).not.toHaveProperty(MARKER);
      expect(store.saved.length).toBeGreaterThan(0); // the fresh start did save
      expect(store.saved.every((saved) => !(MARKER in saved))).toBe(true);
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("have not been read from the deck host yet"));
    });

    it("migrates a store whose host migration was given up on", async () => {
      const store = initWithStore(defaultsFile({ fuelCalloutMarginLaps: 0.3, [MIGRATION_ABANDONED_KEY]: "3.3.0" }));
      await tick();
      expect(getSettingsStoreHostDerivation()).toBe("abandoned");
      // The load itself re-stamps the give-up (no version passed to init).
      const giveUp = cache()[MIGRATION_ABANDONED_KEY];
      const logger = createMockLogger();

      migrateFuelMarginDefault(VERSION, logger);

      expect(cache().fuelCalloutMarginLaps).toBe(0);
      expect(cache()[MARKER]).toBe(VERSION);
      expect(cache()[MIGRATION_ABANDONED_KEY]).toBe(giveUp); // the give-up guard is untouched
      expect(getSettingsStoreHostDerivation()).toBe("abandoned");
      expect(lastSave(store)).toMatchObject({ fuelCalloutMarginLaps: 0, [MARKER]: VERSION });
      expect(logger.info).toHaveBeenCalledWith(MOVED);
    });

    it("writes nothing, marker included, when the stored file cannot be parsed; the next readable start migrates", async () => {
      const file = { fuelCalloutMarginLaps: 0.3, driverName: "kept" };
      const store = initWithStore(file);
      // parseWithSalvage gives up wholesale on a failure it cannot pin to a key.
      vi.spyOn(GlobalSettingsSchema, "safeParse").mockReturnValueOnce({
        success: false,
        error: { issues: [{ path: [] }] },
      } as unknown as ReturnType<typeof GlobalSettingsSchema.safeParse>);
      const logger = createMockLogger();
      migrateFuelMarginDefault(VERSION, logger);

      await tick();

      expect(isSettingsStoreReady()).toBe(true);
      expect(getSettingsStoreHostDerivation()).toBe("unparseable");
      expect(cache().driverName).not.toBe("kept"); // proof the salvage-failed path ran
      expect(cache().fuelCalloutMarginLaps).toBe(0); // only the schema default
      expect(cache()).not.toHaveProperty(MARKER);
      expect(store.saved).toHaveLength(0); // the file on disk is left as it was
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("could not be parsed"));
      expect(logger.info).not.toHaveBeenCalled();

      // The next start reads the same, untouched file, and it parses.
      _resetGlobalSettings();
      vi.restoreAllMocks();
      const next = initWithStore(file);
      const nextLogger = createMockLogger();
      migrateFuelMarginDefault(VERSION, nextLogger);
      await tick();

      expect(getSettingsStoreHostDerivation()).toBe("host-derived");
      expect(cache().fuelCalloutMarginLaps).toBe(0);
      expect(cache()[MARKER]).toBe(VERSION);
      expect(lastSave(next)).toMatchObject({ fuelCalloutMarginLaps: 0, [MARKER]: VERSION, driverName: "kept" });
      expect(nextLogger.info).toHaveBeenCalledWith(MOVED);
    });
  });

  describe("reads back what the write stored", () => {
    it("warns, and claims nothing, when the write is rejected; the next start tries again", async () => {
      initWithStore({ fuelCalloutMarginLaps: 0.3 });
      await tick();
      const logger = createMockLogger();
      // The migration's own write fails its parse wholesale, so
      // updateGlobalSettings drops it.
      vi.spyOn(GlobalSettingsSchema, "safeParse").mockReturnValueOnce({
        success: false,
        error: { issues: [{ path: [] }] },
      } as unknown as ReturnType<typeof GlobalSettingsSchema.safeParse>);

      migrateFuelMarginDefault(VERSION, logger);

      expect(cache().fuelCalloutMarginLaps).toBe(0.3);
      expect(cache()).not.toHaveProperty(MARKER);
      expect(logger.warn).toHaveBeenCalledWith(REJECTED);
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("Stored after the write"));
      expect(logger.info).not.toHaveBeenCalled();

      // Unmarked, so the next run moves it.
      migrateFuelMarginDefault(VERSION, createMockLogger());

      expect(cache().fuelCalloutMarginLaps).toBe(0);
      expect(cache()[MARKER]).toBe(VERSION);
    });

    it("warns when the marker landed but the value did not", async () => {
      initWithStore({ fuelCalloutMarginLaps: 0.3 });
      await tick();
      const logger = createMockLogger();
      const realSafeParse = GlobalSettingsSchema.safeParse.bind(GlobalSettingsSchema);
      // The write's parse keeps the marker and puts the old value back.
      vi.spyOn(GlobalSettingsSchema, "safeParse").mockImplementationOnce((input) => {
        const result = realSafeParse(input);

        return result.success ? { ...result, data: { ...result.data, fuelCalloutMarginLaps: 0.3 } } : result;
      });

      migrateFuelMarginDefault(VERSION, logger);

      expect(cache()[MARKER]).toBe(VERSION);
      expect(cache().fuelCalloutMarginLaps).toBe(0.3);
      expect(logger.warn).toHaveBeenCalledWith(REJECTED);
      expect(logger.info).not.toHaveBeenCalledWith(MOVED);
    });
  });
});
