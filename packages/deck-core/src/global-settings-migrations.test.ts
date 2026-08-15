import type { ILogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { migrateGlobalSettingsKeys } from "./global-settings-migrations.js";
import { _resetGlobalSettings, getGlobalSettings, initGlobalSettings } from "./global-settings.js";
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

interface MockAdapter {
  adapter: IDeckPlatformAdapter;
  echo: EchoCallback | null;
  setGlobalSettings: ReturnType<typeof vi.fn<(settings: Record<string, unknown>) => void>>;
}

function createMockAdapter(): MockAdapter {
  const echoHolder: { echo: EchoCallback | null } = { echo: null };
  const setGlobalSettings = vi.fn<(settings: Record<string, unknown>) => void>();
  const getGlobalSettings = vi.fn<() => void>();

  const adapter = {
    onDidReceiveGlobalSettings: (cb: EchoCallback) => {
      echoHolder.echo = cb;
    },
    setGlobalSettings,
    getGlobalSettings,
  } as unknown as IDeckPlatformAdapter;

  return {
    adapter,
    get echo() {
      return echoHolder.echo;
    },
    setGlobalSettings,
  };
}

const RENAMES = {
  setupChassisLeftSpringIncrease: "setupChassisLrSpringIncrease",
  setupChassisRightSpringIncrease: "setupChassisRrSpringIncrease",
};

const cache = (): Record<string, unknown> => getGlobalSettings() as Record<string, unknown>;

describe("migrateGlobalSettingsKeys", () => {
  let mock: MockAdapter;

  beforeEach(() => {
    _resetGlobalSettings();
    mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger());
  });

  it("copies a stored old-key value to the new key and deletes the old key", () => {
    mock.echo?.({ setupChassisLeftSpringIncrease: "OLD-BINDING" });

    migrateGlobalSettingsKeys(RENAMES, createMockLogger());

    expect(cache().setupChassisLrSpringIncrease).toBe("OLD-BINDING");
    expect(cache().setupChassisLeftSpringIncrease).toBeUndefined();
  });

  it("persists the migrated value through the adapter", () => {
    mock.echo?.({ setupChassisLeftSpringIncrease: "OLD-BINDING" });

    migrateGlobalSettingsKeys(RENAMES, createMockLogger());

    const lastWrite = mock.setGlobalSettings.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastWrite.setupChassisLrSpringIncrease).toBe("OLD-BINDING");
    expect(lastWrite).not.toHaveProperty("setupChassisLeftSpringIncrease");
  });

  it("lets an already-set new key win and still deletes the old key", () => {
    mock.echo?.({
      setupChassisLeftSpringIncrease: "OLD-BINDING",
      setupChassisLrSpringIncrease: "NEW-BINDING",
    });

    migrateGlobalSettingsKeys(RENAMES, createMockLogger());

    expect(cache().setupChassisLrSpringIncrease).toBe("NEW-BINDING");
    expect(cache().setupChassisLeftSpringIncrease).toBeUndefined();
  });

  it("writes nothing when the settings have arrived without any old key", () => {
    mock.echo?.({ someOtherKey: "value" });
    mock.setGlobalSettings.mockClear();

    migrateGlobalSettingsKeys(RENAMES, createMockLogger());

    expect(mock.setGlobalSettings).not.toHaveBeenCalled();
  });

  it("defers until the first host settings arrival, then migrates", () => {
    migrateGlobalSettingsKeys(RENAMES, createMockLogger());

    // Nothing stored yet — the cache is pure defaults and nothing may persist.
    expect(cache().setupChassisLrSpringIncrease).toBeUndefined();

    mock.echo?.({ setupChassisRightSpringIncrease: "RIGHT-BINDING" });

    expect(cache().setupChassisRrSpringIncrease).toBe("RIGHT-BINDING");
    expect(cache().setupChassisRightSpringIncrease).toBeUndefined();
  });

  it("migrates each key at most once across repeated change events", () => {
    mock.echo?.({ setupChassisLeftSpringIncrease: "OLD-BINDING" });

    migrateGlobalSettingsKeys(RENAMES, createMockLogger());
    const writesAfterMigration = mock.setGlobalSettings.mock.calls.length;

    // A stale echo still carrying the old key must not re-trigger a migration write.
    mock.echo?.({ setupChassisLeftSpringIncrease: "OLD-BINDING" });

    expect(cache().setupChassisLrSpringIncrease).toBe("OLD-BINDING");
    expect(cache().setupChassisLeftSpringIncrease).toBeUndefined();
    expect(mock.setGlobalSettings.mock.calls.length).toBe(writesAfterMigration);
  });
});
