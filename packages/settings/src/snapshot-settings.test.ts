import { PI_WARNINGS_KEY, VOICE_PACKS_KEY } from "@iracedeck/app-constants";
import { silentLogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetGlobalSettings,
  getGlobalSettings,
  GlobalSettingsSchema,
  initGlobalSettings,
  isSettingsStoreReady,
  SETTINGS_CHANNEL_KEY,
  updateGlobalSettings,
} from "./global-settings.js";
import { parseStoredWarnings, setWarning } from "./pi-warnings.js";
import type { SettingsHost } from "./settings-host.js";
import { createMemorySettingsStore } from "./settings-store.js";
import { readSettingsForSnapshot, SNAPSHOT_KEPT_INTERNAL_KEYS } from "./snapshot-settings.js";

// The reader runs over the REAL settings cache: it reaches `getGlobalSettings`
// by relative path, which a mock of the package barrel would not touch, and
// the property under test is what a real cache holding a real channel yields.

/** A deck host that never answers: the memory store is the only source. */
const host: SettingsHost = {
  onDidReceiveGlobalSettings: () => {},
  getGlobalSettings: () => {},
  setGlobalSettings: () => {},
};

const tick = () => new Promise((r) => setTimeout(r, 0));

const TOKEN = "tok-SECRET-1387";
const PORT = 49152;

/** The cache as a plain bag, for reading keys the schema does not declare. */
const cache = (): Record<string, unknown> => getGlobalSettings() as Record<string, unknown>;

/** Starts the real cache over a memory store holding `stored`, and waits for the load. */
async function startWith(stored: Record<string, unknown>): Promise<void> {
  initGlobalSettings(host, silentLogger, createMemorySettingsStore(stored));
  await tick();
  expect(isSettingsStoreReady()).toBe(true);
}

describe("readSettingsForSnapshot", () => {
  beforeEach(() => {
    _resetGlobalSettings();
  });

  afterEach(() => {
    _resetGlobalSettings();
  });

  describe("the settings-server channel", () => {
    it("never returns the channel's token or port, however the cache came to hold it", async () => {
      // A file written by an older build, or the deck host's mirror read for the
      // migration, carries the channel into the cache.
      await startWith({ [SETTINGS_CHANNEL_KEY]: { port: PORT, token: TOKEN }, driverName: "nick" });

      // Not vacuous: the cache really holds the secret the reader must drop.
      expect(JSON.stringify(getGlobalSettings())).toContain(TOKEN);

      const json = JSON.stringify(readSettingsForSnapshot());

      expect(json).not.toContain(TOKEN);
      expect(json).not.toContain(String(PORT));
      expect(json).not.toContain(SETTINGS_CHANNEL_KEY);
      expect(json).toContain("nick");
    });

    it("drops a channel written during the run as well", async () => {
      await startWith({});
      updateGlobalSettings({ [SETTINGS_CHANNEL_KEY]: { port: PORT, token: TOKEN } });
      expect(cache()[SETTINGS_CHANNEL_KEY]).toEqual({ port: PORT, token: TOKEN });

      const result = readSettingsForSnapshot();

      expect(SETTINGS_CHANNEL_KEY in result).toBe(false);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });
  });

  describe("the allow-list", () => {
    it("keeps exactly the warnings key among the internal ones", () => {
      expect(SNAPSHOT_KEPT_INTERNAL_KEYS).toEqual([PI_WARNINGS_KEY]);
    });

    it("leaves no key starting with an underscore except the kept ones", async () => {
      await startWith({
        [SETTINGS_CHANNEL_KEY]: { port: PORT, token: TOKEN },
        _lastSeenVersion: "3.5.0",
        _settingsStorePath: "C:/Users/someone/AppData/Local/iRaceDeck/Settings/x/global-settings.json",
      });
      updateGlobalSettings({ [VOICE_PACKS_KEY]: JSON.stringify([{ id: "default" }]) });
      setWarning("a", "warning", "A banner");

      const internal = Object.keys(readSettingsForSnapshot()).filter((key) => key.startsWith("_"));

      expect(internal).toEqual([PI_WARNINGS_KEY]);
    });

    // What pins an allow-list over a deny-list of known secrets: a key nobody
    // has heard of yet is dropped without this file being edited.
    it("drops an internal key it has never heard of", async () => {
      await startWith({ _somethingNew: "x", _future: { token: "another-secret" } });
      expect(cache()._somethingNew).toBe("x");

      const result = readSettingsForSnapshot();

      expect("_somethingNew" in result).toBe(false);
      expect("_future" in result).toBe(false);
      expect(JSON.stringify(result)).not.toContain("another-secret");
    });
  });

  describe("the warnings", () => {
    it("keeps the banners the real producer posted, as data", async () => {
      await startWith({});
      setWarning("a", "warning", "A banner");
      setWarning("b", "error", "Another");

      // The store holds them as a JSON string; the snapshot reads as data.
      expect(typeof cache()[PI_WARNINGS_KEY]).toBe("string");
      expect(readSettingsForSnapshot()[PI_WARNINGS_KEY]).toEqual([
        { id: "a", level: "warning", message: "A banner" },
        { id: "b", level: "error", message: "Another" },
      ]);
    });

    // The key is passthrough, so the schema never validates it: whatever sits
    // under it reaches the reader as it is. Only well-formed records may leave.
    describe("a value no producer wrote", () => {
      const valid = { id: "a", level: "warning", message: "A banner" };

      it("yields only the well-formed records of a list that holds malformed ones too", async () => {
        await startWith({});
        updateGlobalSettings({
          [PI_WARNINGS_KEY]: JSON.stringify([
            valid,
            { id: "no-message", level: "warning", leaked: "LEAK-no-message" },
            { id: "bad-level", level: "LEAK-level", message: "LEAK-bad-level" },
            { id: 7, level: "info", message: "LEAK-numeric-id" },
            "LEAK-bare-string",
            ["LEAK-nested-array"],
            null,
            42,
          ]),
        });
        // Not vacuous: the cache holds what the reader must not pass on.
        expect(cache()[PI_WARNINGS_KEY]).toContain("LEAK-bare-string");

        const result = readSettingsForSnapshot();

        expect(result[PI_WARNINGS_KEY]).toEqual([valid]);
        expect(JSON.stringify(result)).not.toContain("LEAK");
      });

      it("drops a field the record shape does not have", async () => {
        await startWith({});
        updateGlobalSettings({
          [PI_WARNINGS_KEY]: JSON.stringify([{ ...valid, token: "tok-EXTRA", nested: { deep: "tok-DEEP" } }]),
        });

        const result = readSettingsForSnapshot();

        expect(result[PI_WARNINGS_KEY]).toEqual([valid]);
        expect(Object.keys((result[PI_WARNINGS_KEY] as object[])[0])).toEqual(["id", "level", "message"]);
        expect(JSON.stringify(result)).not.toContain("tok-");
      });

      it.each([
        ["a JSON object", JSON.stringify(valid)],
        ["a JSON string", JSON.stringify("LEAK-text")],
        ["a JSON number", "5"],
        ["text that is not JSON", "[{LEAK not json"],
        ["an empty string", ""],
        ["a list that was never serialised", [valid]],
        ["an object", { LEAK: "object" }],
        ["a number", 5],
        ["null", null],
      ])("yields no records for %s, as the plugin's own read of the key does", async (_name, stored) => {
        await startWith({});
        updateGlobalSettings({ [PI_WARNINGS_KEY]: stored });
        expect(cache()[PI_WARNINGS_KEY]).toEqual(stored);

        const result = readSettingsForSnapshot();

        expect(result[PI_WARNINGS_KEY]).toEqual([]);
        expect(JSON.stringify(result)).not.toContain("LEAK");
        // The same read the plugin's banners go through.
        expect(result[PI_WARNINGS_KEY]).toEqual(parseStoredWarnings(stored));

        // And the plugin agrees there was nothing: its next write starts from
        // an empty list rather than from anything the value held.
        setWarning("b", "info", "B");
        expect(JSON.parse(cache()[PI_WARNINGS_KEY] as string)).toEqual([{ id: "b", level: "info", message: "B" }]);
      });

      it("validates the value it was handed, not the cache's", async () => {
        await startWith({});
        setWarning("from-the-cache", "error", "CACHE banner");

        const result = readSettingsForSnapshot({
          [PI_WARNINGS_KEY]: JSON.stringify([valid, { id: "x", level: "warning", extra: "LEAK-argument" }]),
        });

        expect(result).toEqual({ [PI_WARNINGS_KEY]: [valid] });
      });

      it("hands back records of its own, not the stored ones", () => {
        const stored = JSON.stringify([valid]);
        const first = readSettingsForSnapshot({ [PI_WARNINGS_KEY]: stored })[PI_WARNINGS_KEY];
        const second = readSettingsForSnapshot({ [PI_WARNINGS_KEY]: stored })[PI_WARNINGS_KEY];

        expect(first).toEqual(second);
        expect(first).not.toBe(second);
      });
    });
  });

  describe("ordinary keys", () => {
    it("keeps them unchanged, nested objects and arrays included", async () => {
      await startWith({
        fuelCalloutMarginLaps: "0.7",
        blackBoxLapTiming: JSON.stringify({ key: "f1", modifiers: [] }),
        someObject: { nested: { deep: [1, 2, 3] }, flag: true },
        someArray: ["a", { b: 2 }],
      });

      const result = readSettingsForSnapshot();

      // The parsed value, not the stored string.
      expect(result.fuelCalloutMarginLaps).toBe(0.7);
      // An ordinary string stays a string, JSON-shaped or not: only kept
      // internal keys are parsed.
      expect(result.blackBoxLapTiming).toBe(JSON.stringify({ key: "f1", modifiers: [] }));
      expect(result.someObject).toEqual({ nested: { deep: [1, 2, 3] }, flag: true });
      expect(result.someArray).toEqual(["a", { b: 2 }]);
      // A schema default the store never held is there too.
      expect(result.disableWhenDisconnected).toBe(true);
    });

    it("returns every key of the cache that does not start with an underscore", async () => {
      await startWith({ [SETTINGS_CHANNEL_KEY]: { port: PORT, token: TOKEN }, driverName: "nick" });

      const expected = Object.fromEntries(Object.entries(cache()).filter(([key]) => !key.startsWith("_")));

      expect(readSettingsForSnapshot()).toEqual(expected);
    });
  });

  describe("the explicit argument", () => {
    it("filters the same way and does not read the cache", async () => {
      await startWith({ driverName: "from-the-cache", [SETTINGS_CHANNEL_KEY]: { port: PORT, token: TOKEN } });

      const result = readSettingsForSnapshot({
        simHubPort: 8888,
        [SETTINGS_CHANNEL_KEY]: { port: 50000, token: "tok-ARGUMENT" },
        _somethingNew: "x",
        [PI_WARNINGS_KEY]: "[]",
      });

      // Exactly the argument's own survivors: no cache key, no schema default.
      expect(result).toEqual({ simHubPort: 8888, [PI_WARNINGS_KEY]: [] });
    });

    it("does not mutate its argument", () => {
      const settings = {
        simHubPort: 8888,
        [SETTINGS_CHANNEL_KEY]: { port: PORT, token: TOKEN },
        [PI_WARNINGS_KEY]: JSON.stringify([{ id: "a", level: "info", message: "m" }]),
        someObject: { nested: [1, 2] },
      };
      const before = structuredClone(settings);

      const result = readSettingsForSnapshot(settings);

      expect(settings).toEqual(before);
      expect(result).not.toBe(settings);
    });
  });

  describe("the cache", () => {
    it("is neither returned nor changed", async () => {
      await startWith({ driverName: "nick", someObject: { nested: [1, 2] } });
      updateGlobalSettings({ [SETTINGS_CHANNEL_KEY]: { port: PORT, token: TOKEN } });
      setWarning("a", "warning", "A banner");

      const cacheObject = getGlobalSettings();
      const before = structuredClone(cacheObject);

      const result = readSettingsForSnapshot();

      expect(result).not.toBe(cacheObject);
      expect(getGlobalSettings()).toBe(cacheObject);
      expect(getGlobalSettings()).toEqual(before);
      // Still holding what the reader dropped and what it parsed.
      expect(cache()[SETTINGS_CHANNEL_KEY]).toEqual({ port: PORT, token: TOKEN });
      expect(typeof cache()[PI_WARNINGS_KEY]).toBe("string");
    });

    it("gives a fresh object on every call", async () => {
      await startWith({});

      expect(readSettingsForSnapshot()).not.toBe(readSettingsForSnapshot());
    });
  });

  // Review Focus 2: a press before the subsystems are up.
  describe("before the settings are up", () => {
    it("returns the schema defaults without throwing when init was never called", () => {
      const result = readSettingsForSnapshot();

      expect(result).toEqual(GlobalSettingsSchema.parse({}));
      expect(Object.keys(result).filter((key) => key.startsWith("_"))).toEqual([]);
    });

    it("returns the schema defaults while the store is still loading, and the stored settings once it has", async () => {
      initGlobalSettings(
        host,
        silentLogger,
        createMemorySettingsStore({ driverName: "nick", [SETTINGS_CHANNEL_KEY]: { port: PORT, token: TOKEN } }),
      );
      expect(isSettingsStoreReady()).toBe(false);

      expect(readSettingsForSnapshot()).toEqual(GlobalSettingsSchema.parse({}));

      // Let the load land before the reset, so it cannot arrive in a later test.
      await tick();
      expect(isSettingsStoreReady()).toBe(true);
      expect(readSettingsForSnapshot()).toEqual({ ...GlobalSettingsSchema.parse({}), driverName: "nick" });
    });
  });
});
