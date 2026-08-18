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
  updateGlobalSettings,
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
  it("mirrors store + channel to the host exactly once per channel, and keeps the transient channel OUT of the store", async () => {
    const { adapter, setGlobalSettings } = mockAdapter();
    const store = createMemorySettingsStore({ driverName: "nick" });
    initGlobalSettings(adapter, silentLogger, store);
    await tick();
    const publisher = createSettingsChannelPublisher({ adapter, logger: silentLogger });

    publisher.publish(CHANNEL);
    publisher.publish(CHANNEL); // idempotent: the store-ready block and onStarted may both call it

    expect((getGlobalSettings() as Record<string, unknown>)[SETTINGS_CHANNEL_KEY]).toBeUndefined();
    expect(setGlobalSettings).toHaveBeenCalledTimes(1);
    expect(setGlobalSettings.mock.calls[0]?.[0]).toMatchObject({ driverName: "nick", [SETTINGS_CHANNEL_KEY]: CHANNEL });
  });

  it("removes a stale channel an older build persisted into the store, so the file never advertises a dead port", async () => {
    const { adapter } = mockAdapter();
    const store = createMemorySettingsStore({ driverName: "nick", [SETTINGS_CHANNEL_KEY]: { port: 1, token: "old" } });
    initGlobalSettings(adapter, silentLogger, store);
    await tick();
    const publisher = createSettingsChannelPublisher({ adapter, logger: silentLogger });

    publisher.publish(CHANNEL);
    await store.flush();

    expect((getGlobalSettings() as Record<string, unknown>)[SETTINGS_CHANNEL_KEY]).toBeUndefined();
    expect(store.saved.at(-1)).not.toHaveProperty(SETTINGS_CHANNEL_KEY);
  });

  it("a server that started before the store was ready is mirrored by the later call, not lost", async () => {
    const { adapter, setGlobalSettings } = mockAdapter();
    const store = createMemorySettingsStore({ driverName: "nick" });
    initGlobalSettings(adapter, silentLogger, store);
    const publisher = createSettingsChannelPublisher({ adapter, logger: silentLogger });

    publisher.publish(CHANNEL); // early open(): store not ready → mirror skipped, nothing written to the store
    expect(isSettingsStoreReady()).toBe(false);
    expect(setGlobalSettings).not.toHaveBeenCalled();

    await tick(); // the store loads
    publisher.publish(CHANNEL); // the store-ready block's call

    expect(setGlobalSettings).toHaveBeenCalledTimes(1);
    expect(setGlobalSettings.mock.calls[0]?.[0]).toMatchObject({ driverName: "nick", [SETTINGS_CHANNEL_KEY]: CHANNEL });
  });

  it("removes a stale persisted channel even when the ONLY publish happened before the store was ready (early delete)", async () => {
    const { adapter, setGlobalSettings } = mockAdapter();
    const store = createMemorySettingsStore({ driverName: "nick", [SETTINGS_CHANNEL_KEY]: { port: 1, token: "old" } });
    initGlobalSettings(adapter, silentLogger, store);
    const publisher = createSettingsChannelPublisher({ adapter, logger: silentLogger });

    publisher.publish(CHANNEL); // before the file has loaded: the cache can't show the legacy key yet
    expect(isSettingsStoreReady()).toBe(false);
    expect(setGlobalSettings).not.toHaveBeenCalled();

    await tick(); // the store loads — the early delete is applied over the file's contents
    await store.flush();

    expect((getGlobalSettings() as Record<string, unknown>)[SETTINGS_CHANNEL_KEY]).toBeUndefined();
    expect(store.saved.at(-1)).not.toHaveProperty(SETTINGS_CHANNEL_KEY);
    expect(store.saved.at(-1)).toMatchObject({ driverName: "nick" });
  });

  it("retries the stale-channel cleanup on the next publish when the first attempt threw", async () => {
    const { adapter } = mockAdapter();
    const store = createMemorySettingsStore({ [SETTINGS_CHANNEL_KEY]: { port: 1, token: "old" } });
    initGlobalSettings(adapter, silentLogger, store);
    await tick();
    let faults = 1;
    onGlobalSettingsChange(() => {
      if (faults-- > 0) throw new Error("listener fault");
    });
    const publisher = createSettingsChannelPublisher({ adapter, logger: silentLogger });

    publisher.publish(CHANNEL); // the delete lands in the cache but the listener throws → cleanup not marked done
    // Re-seed the legacy key behind the publisher's back to prove the retry really deletes again.
    updateGlobalSettings({ [SETTINGS_CHANNEL_KEY]: { port: 2, token: "older" } });
    publisher.publish(CHANNEL);
    await store.flush();

    expect((getGlobalSettings() as Record<string, unknown>)[SETTINGS_CHANNEL_KEY]).toBeUndefined();
    expect(store.saved.at(-1)).not.toHaveProperty(SETTINGS_CHANNEL_KEY);
  });

  it("a NEW channel (the server restarted on another port) is written and mirrored again", async () => {
    const { adapter, setGlobalSettings } = mockAdapter();
    initGlobalSettings(adapter, silentLogger, createMemorySettingsStore({}));
    await tick();
    const publisher = createSettingsChannelPublisher({ adapter, logger: silentLogger });

    publisher.publish(CHANNEL);
    publisher.publish({ ...CHANNEL, port: 60000 });

    expect(setGlobalSettings).toHaveBeenCalledTimes(2);
    expect(setGlobalSettings.mock.calls[1]?.[0]).toMatchObject({ [SETTINGS_CHANNEL_KEY]: { ...CHANNEL, port: 60000 } });
    expect((getGlobalSettings() as Record<string, unknown>)[SETTINGS_CHANNEL_KEY]).toBeUndefined();
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

  it("a throwing settings listener during the stale-channel cleanup is logged, not thrown, and the mirror still goes out", async () => {
    const { adapter, setGlobalSettings } = mockAdapter();
    initGlobalSettings(
      adapter,
      silentLogger,
      createMemorySettingsStore({ [SETTINGS_CHANNEL_KEY]: { port: 1, token: "old" } }),
    );
    await tick();
    onGlobalSettingsChange(() => {
      throw new Error("listener fault");
    });
    const error = vi.fn();
    const logger = { ...silentLogger, error, createScope: () => silentLogger, withLevel: () => silentLogger };

    expect(() => createSettingsChannelPublisher({ adapter, logger }).publish(CHANNEL)).not.toThrow();

    expect(error).toHaveBeenCalledWith("Cleaning the stale settings channel from the store failed");
    expect(setGlobalSettings).toHaveBeenCalledTimes(1);
  });
});
