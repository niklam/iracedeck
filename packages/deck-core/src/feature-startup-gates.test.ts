import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyStartupFeatureGates, migrateStartupPolicies } from "./feature-startup-gates.js";
import {
  _resetGlobalSettings,
  getGlobalSettings,
  initGlobalSettings,
  updateGlobalSettings,
} from "./global-settings.js";
import { createMemorySettingsStore } from "./settings-store.js";
import type { IDeckPlatformAdapter } from "./types.js";

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
    onDidReceiveGlobalSettings: (_cb: (settings: unknown) => void) => {},
    setGlobalSettings: vi.fn<(settings: Record<string, unknown>) => void>(),
    getGlobalSettings: vi.fn<() => void>(),
  } as unknown as IDeckPlatformAdapter;
}

/** Let the async load inside initGlobalSettings settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Initialize against a settings file seeded with `initial` (issue #993). */
function initWithStore(initial: Record<string, unknown> = {}): ReturnType<typeof createMemorySettingsStore> {
  const store = createMemorySettingsStore(initial);

  initGlobalSettings(createMockAdapter(), createMockLogger(), store);

  return store;
}

const cache = (): Record<string, unknown> => getGlobalSettings() as unknown as Record<string, unknown>;

describe("applyStartupFeatureGates", () => {
  beforeEach(() => {
    _resetGlobalSettings();
  });

  afterEach(() => {
    _resetGlobalSettings();
  });

  it("leaves the remembered gates untouched under remember-last", async () => {
    const store = initWithStore({
      pitCrewRaceEngineerEnabled: true,
      pitCrewRadarEnabled: false,
      pitCrewRaceEngineerStartupPolicy: "remember-last",
      pitCrewRadarStartupPolicy: "remember-last",
    });
    await tick();
    const savesBefore = store.saved.length;

    applyStartupFeatureGates(createMockLogger());

    expect(cache().pitCrewRaceEngineerEnabled).toBe(true);
    expect(cache().pitCrewRadarEnabled).toBe(false);
    expect(store.saved).toHaveLength(savesBefore);
  });

  it("forces the gate on under always-on", async () => {
    initWithStore({
      pitCrewRaceEngineerEnabled: false,
      pitCrewRaceEngineerStartupPolicy: "always-on",
    });
    await tick();

    applyStartupFeatureGates(createMockLogger());

    expect(cache().pitCrewRaceEngineerEnabled).toBe(true);
  });

  it("forces the gate off under always-off", async () => {
    initWithStore({
      pitCrewRadarEnabled: true,
      pitCrewRadarStartupPolicy: "always-off",
    });
    await tick();

    applyStartupFeatureGates(createMockLogger());

    expect(cache().pitCrewRadarEnabled).toBe(false);
  });

  it("writes nothing when the forced value already matches", async () => {
    const store = initWithStore({
      pitCrewRaceEngineerEnabled: true,
      pitCrewRaceEngineerStartupPolicy: "always-on",
    });
    await tick();
    const savesBefore = store.saved.length;

    applyStartupFeatureGates(createMockLogger());

    expect(store.saved).toHaveLength(savesBefore);
  });
});

describe("migrateStartupPolicies", () => {
  beforeEach(() => {
    _resetGlobalSettings();
  });

  afterEach(() => {
    _resetGlobalSettings();
  });

  it("maps a stored true to always-on and deletes the retired key", async () => {
    initWithStore({ pitCrewRaceEngineerEnabledOnStartup: true });
    await tick();

    migrateStartupPolicies(createMockLogger());

    expect(cache().pitCrewRaceEngineerStartupPolicy).toBe("always-on");
    expect(cache().pitCrewRaceEngineerEnabledOnStartup).toBeUndefined();
  });

  it("maps a stored false to always-off and deletes the retired key", async () => {
    initWithStore({ pitCrewRadarEnabledOnStartup: false });
    await tick();

    migrateStartupPolicies(createMockLogger());

    expect(cache().pitCrewRadarStartupPolicy).toBe("always-off");
    expect(cache().pitCrewRadarEnabledOnStartup).toBeUndefined();
  });

  it("accepts the string form the Property Inspector used to persist", async () => {
    initWithStore({ pitCrewRaceEngineerEnabledOnStartup: "true" });
    await tick();

    migrateStartupPolicies(createMockLogger());

    expect(cache().pitCrewRaceEngineerStartupPolicy).toBe("always-on");
  });

  it("persists the migrated policy and the deletion to the settings store", async () => {
    const store = initWithStore({ pitCrewRadarEnabledOnStartup: true });
    await tick();

    migrateStartupPolicies(createMockLogger());

    const lastSave = store.saved.at(-1) as Record<string, unknown>;
    expect(lastSave.pitCrewRadarStartupPolicy).toBe("always-on");
    expect(lastSave).not.toHaveProperty("pitCrewRadarEnabledOnStartup");
  });

  it("writes nothing when no retired key is stored", async () => {
    const store = initWithStore({ someOtherKey: "value" });
    await tick();
    const savesBefore = store.saved.length;

    migrateStartupPolicies(createMockLogger());

    expect(store.saved).toHaveLength(savesBefore);
    expect(cache().pitCrewRaceEngineerStartupPolicy).toBe("remember-last");
  });

  it("is idempotent — a second run cannot clobber a later user choice", async () => {
    initWithStore({ pitCrewRaceEngineerEnabledOnStartup: true });
    await tick();

    migrateStartupPolicies(createMockLogger());
    // The user then picks something else.
    updateGlobalSettings({ pitCrewRaceEngineerStartupPolicy: "remember-last" });

    migrateStartupPolicies(createMockLogger());

    expect(cache().pitCrewRaceEngineerStartupPolicy).toBe("remember-last");
  });
});
