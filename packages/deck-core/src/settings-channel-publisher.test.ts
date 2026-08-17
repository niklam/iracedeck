import { silentLogger } from "@iracedeck/logger";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetGlobalSettings,
  getGlobalSettings,
  initGlobalSettings,
  isSettingsStoreReady,
  MIGRATION_PENDING_KEY,
  onGlobalSettingsChange,
  SETTINGS_CHANNEL_KEY,
} from "./global-settings.js";
import { createSettingsChannelPublisher } from "./settings-channel-publisher.js";
import { createMemorySettingsStore } from "./settings-store.js";
import type { IDeckPlatformAdapter } from "./types.js";

const CHANNEL = { port: 55762, token: "cc29ab52f34a2a927663a0832b86a807b4cc329ebe68a98d" };
const tick = () => new Promise((r) => setTimeout(r, 0));

function mockAdapter() {
  const setGlobalSettings = vi.fn();
  const adapter = {
    onDidReceiveGlobalSettings: vi.fn(),
    getGlobalSettings: vi.fn(),
    setGlobalSettings,
  } as unknown as IDeckPlatformAdapter;

  return { adapter, setGlobalSettings };
}

afterEach(() => _resetGlobalSettings());

describe("createSettingsChannelPublisher (#993 phase 2)", () => {
  it("writes the channel to the store and mirrors store + channel to the host exactly once per channel", async () => {
    const { adapter, setGlobalSettings } = mockAdapter();
    const store = createMemorySettingsStore({ driverName: "nick" });
    initGlobalSettings(adapter, silentLogger, store);
    await tick();
    const publisher = createSettingsChannelPublisher({ adapter, logger: silentLogger });

    publisher.publish(CHANNEL);
    publisher.publish(CHANNEL); // idempotent: the store-ready block and onStarted may both call it

    expect((getGlobalSettings() as Record<string, unknown>)[SETTINGS_CHANNEL_KEY]).toEqual(CHANNEL);
    expect(setGlobalSettings).toHaveBeenCalledTimes(1);
    expect(setGlobalSettings.mock.calls[0]?.[0]).toMatchObject({ driverName: "nick", [SETTINGS_CHANNEL_KEY]: CHANNEL });
  });

  it("a server that started before the store was ready is mirrored by the later call, not lost", async () => {
    const { adapter, setGlobalSettings } = mockAdapter();
    const store = createMemorySettingsStore({ driverName: "nick" });
    initGlobalSettings(adapter, silentLogger, store);
    const publisher = createSettingsChannelPublisher({ adapter, logger: silentLogger });

    publisher.publish(CHANNEL); // early open(): store not ready → channel written (early write), mirror skipped
    expect(isSettingsStoreReady()).toBe(false);
    expect(setGlobalSettings).not.toHaveBeenCalled();

    await tick(); // the store loads
    publisher.publish(CHANNEL); // the store-ready block's call

    expect(setGlobalSettings).toHaveBeenCalledTimes(1);
    expect(setGlobalSettings.mock.calls[0]?.[0]).toMatchObject({ driverName: "nick", [SETTINGS_CHANNEL_KEY]: CHANNEL });
  });

  it("a NEW channel (the server restarted on another port) is written and mirrored again", async () => {
    const { adapter, setGlobalSettings } = mockAdapter();
    initGlobalSettings(adapter, silentLogger, createMemorySettingsStore({}));
    await tick();
    const publisher = createSettingsChannelPublisher({ adapter, logger: silentLogger });

    publisher.publish(CHANNEL);
    publisher.publish({ ...CHANNEL, port: 60000 });

    expect(setGlobalSettings).toHaveBeenCalledTimes(2);
    expect((getGlobalSettings() as Record<string, unknown>)[SETTINGS_CHANNEL_KEY]).toEqual({ ...CHANNEL, port: 60000 });
  });

  it("never mirrors a store that holds no host-derived settings (pending-migration marker)", async () => {
    const { adapter, setGlobalSettings } = mockAdapter();
    vi.useFakeTimers();

    try {
      initGlobalSettings(adapter, silentLogger, createMemorySettingsStore(), { migrationTimeoutMs: 20 });
      await vi.advanceTimersByTimeAsync(30); // silent host → fresh, marker set
      expect((getGlobalSettings() as Record<string, unknown>)[MIGRATION_PENDING_KEY]).toBe(1);

      createSettingsChannelPublisher({ adapter, logger: silentLogger }).publish(CHANNEL);

      expect(setGlobalSettings).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throwing settings listener during the store write is logged, not thrown, and the mirror still goes out", async () => {
    const { adapter, setGlobalSettings } = mockAdapter();
    initGlobalSettings(adapter, silentLogger, createMemorySettingsStore({}));
    await tick();
    onGlobalSettingsChange(() => {
      throw new Error("listener fault");
    });
    const error = vi.fn();
    const logger = { ...silentLogger, error, createScope: () => silentLogger, withLevel: () => silentLogger };

    expect(() => createSettingsChannelPublisher({ adapter, logger }).publish(CHANNEL)).not.toThrow();

    expect(error).toHaveBeenCalledWith("Publishing the settings channel to the store failed");
    expect(setGlobalSettings).toHaveBeenCalledTimes(1);
  });
});
