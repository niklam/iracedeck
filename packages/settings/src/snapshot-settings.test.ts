import {
  PI_WARNINGS_KEY,
  PROFILE_CAPTURE_STATUS_KEY,
  VOICE_PACK_STATUS_KEY,
  VOICE_PACKS_KEY,
} from "@iracedeck/app-constants";
import { silentLogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FIRST_RUN_VERSION_KEY, runFirstRunCheck } from "./first-run.js";
import {
  _resetGlobalSettings,
  getGlobalSettings,
  GlobalSettingsSchema,
  initGlobalSettings,
  isSettingsStoreReady,
  MIGRATION_ABANDONED_KEY,
  MIGRATION_PENDING_KEY,
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

/**
 * The key the version check and the first-run check write. No package exports a
 * constant for it; "the last-seen version" below goes through the real writer.
 */
const LAST_SEEN_VERSION_KEY = "_lastSeenVersion";

/** What a kept key reads as when it is present but not in its documented form. */
const REJECTED = { rejected: true };

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
    it("keeps exactly five internal keys", () => {
      expect([...SNAPSHOT_KEPT_INTERNAL_KEYS].sort()).toEqual(
        [
          PI_WARNINGS_KEY,
          LAST_SEEN_VERSION_KEY,
          MIGRATION_PENDING_KEY,
          MIGRATION_ABANDONED_KEY,
          VOICE_PACKS_KEY,
        ].sort(),
      );
      // Named here so that keeping either takes an edit to this test as well.
      expect(SNAPSHOT_KEPT_INTERNAL_KEYS).not.toContain(SETTINGS_CHANNEL_KEY);
      expect(SNAPSHOT_KEPT_INTERNAL_KEYS).not.toContain(VOICE_PACK_STATUS_KEY);
    });

    it("leaves no key starting with an underscore except the kept ones", async () => {
      await startWith({
        [SETTINGS_CHANNEL_KEY]: { port: PORT, token: TOKEN },
        [LAST_SEEN_VERSION_KEY]: "3.5.0",
        [MIGRATION_ABANDONED_KEY]: "3.4.0",
        [FIRST_RUN_VERSION_KEY]: "3.4.0",
        _settingsStorePath: "C:/Users/someone/AppData/Local/iRaceDeck/Settings/x/global-settings.json",
        _lastChangelogOpenedAt: 1791727391482,
        _devBaseUrl: "http://127.0.0.1:4321",
        _selectedCar: { carIdx: 3, carNumber: "12" },
        _audioDeviceList: JSON.stringify([{ id: "{0.0.0.00000000}.{guid}", name: "Speakers" }]),
        _voiceLabels: JSON.stringify({ "default::default": "Default" }),
      });
      // Run-scoped keys never load from a store: their producers write them.
      updateGlobalSettings({
        [VOICE_PACKS_KEY]: JSON.stringify({ packs: [], problems: [] }),
        [VOICE_PACK_STATUS_KEY]: JSON.stringify({ catalog: { state: "LEAK-status" }, installs: {} }),
        [PROFILE_CAPTURE_STATUS_KEY]: JSON.stringify({ state: "capturing" }),
      });
      setWarning("a", "warning", "A banner");
      expect(Object.keys(cache()).filter((key) => key.startsWith("_")).length).toBeGreaterThan(10);

      const result = readSettingsForSnapshot();
      const internal = Object.keys(result).filter((key) => key.startsWith("_"));

      expect(internal.sort()).toEqual(
        [PI_WARNINGS_KEY, LAST_SEEN_VERSION_KEY, MIGRATION_ABANDONED_KEY, VOICE_PACKS_KEY].sort(),
      );
      expect(JSON.stringify(result)).not.toContain("someone");
      expect(JSON.stringify(result)).not.toContain("LEAK");
    });

    it("leaves the voice-pack status out", async () => {
      await startWith({});
      updateGlobalSettings({
        [VOICE_PACK_STATUS_KEY]: JSON.stringify({ catalog: { packs: [{ id: "LEAK-catalog" }] }, installs: {} }),
      });
      expect(cache()[VOICE_PACK_STATUS_KEY]).toContain("LEAK-catalog");

      const result = readSettingsForSnapshot();

      expect(VOICE_PACK_STATUS_KEY in result).toBe(false);
      expect(JSON.stringify(result)).not.toContain("LEAK");
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

  describe("the last-seen version", () => {
    it("keeps the version the first-run check itself records", async () => {
      await startWith({});
      expect(LAST_SEEN_VERSION_KEY in cache()).toBe(false);

      // The real writer, so a renamed key cannot leave the reader keeping a
      // name nothing writes any more.
      await runFirstRunCheck({
        currentVersion: "3.6.0-dev.0",
        persist: updateGlobalSettings,
        openGettingStarted: () => {},
        logger: silentLogger,
      });

      const result = readSettingsForSnapshot();

      expect(result[LAST_SEEN_VERSION_KEY]).toBe("3.6.0-dev.0");
      // Its sibling from the same write is not a kept key.
      expect(cache()[FIRST_RUN_VERSION_KEY]).toBe("3.6.0-dev.0");
      expect(FIRST_RUN_VERSION_KEY in result).toBe(false);
    });

    // Its ABSENCE is the first-run signal, so it must read as absence.
    it("is absent from the snapshot when the settings do not hold it", async () => {
      await startWith({});

      expect(LAST_SEEN_VERSION_KEY in readSettingsForSnapshot()).toBe(false);
      expect(LAST_SEEN_VERSION_KEY in readSettingsForSnapshot({ [LAST_SEEN_VERSION_KEY]: undefined })).toBe(false);
    });

    it.each([
      ["a number", 3.5],
      ["an object", { LEAK: "object" }],
      ["a list", ["LEAK-list"]],
      ["null", null],
      ["a string longer than a version can be", `LEAK-${"9".repeat(300)}`],
    ])("writes the rejected marker, and none of the value, for %s", async (_name, stored) => {
      await startWith({ [LAST_SEEN_VERSION_KEY]: stored });
      expect(cache()[LAST_SEEN_VERSION_KEY]).toEqual(stored);

      const result = readSettingsForSnapshot();

      expect(result[LAST_SEEN_VERSION_KEY]).toEqual(REJECTED);
      expect(JSON.stringify(result)).not.toContain("LEAK");
    });
  });

  describe("the migration markers", () => {
    it("keeps the countdown the store itself writes when the host never answers", async () => {
      // No file and a silent host: the store is born fresh and counts the start.
      initGlobalSettings(host, silentLogger, createMemorySettingsStore(), { migrationTimeoutMs: 1 });
      await new Promise((r) => setTimeout(r, 25));
      expect(isSettingsStoreReady()).toBe(true);
      expect(cache()[MIGRATION_PENDING_KEY]).toBe(1);

      expect(readSettingsForSnapshot()[MIGRATION_PENDING_KEY]).toBe(1);
    });

    it.each([
      ["zero", 0],
      ["a count", 2],
    ])("keeps %s as the countdown", (_name, stored) => {
      expect(readSettingsForSnapshot({ [MIGRATION_PENDING_KEY]: stored })[MIGRATION_PENDING_KEY]).toBe(stored);
    });

    it.each([
      ["a negative number", -1],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["a numeric string", "2"],
      ["true", true],
      ["an object", { LEAK: "object" }],
      ["null", null],
    ])("writes the rejected marker for a countdown that is %s", (_name, stored) => {
      const result = readSettingsForSnapshot({ [MIGRATION_PENDING_KEY]: stored });

      expect(result[MIGRATION_PENDING_KEY]).toEqual(REJECTED);
      expect(JSON.stringify(result)).not.toContain("LEAK");
    });

    // Both forms come out of the store's own load: it re-stamps a give-up
    // marker it finds with the version it is running as.
    it("keeps the give-up marker's version, as the store stamps it", async () => {
      initGlobalSettings(host, silentLogger, createMemorySettingsStore({ [MIGRATION_ABANDONED_KEY]: "3.4.0" }), {
        pluginVersion: "3.4.0",
      });
      await tick();
      expect(cache()[MIGRATION_ABANDONED_KEY]).toBe("3.4.0");

      expect(readSettingsForSnapshot()[MIGRATION_ABANDONED_KEY]).toBe("3.4.0");
    });

    it("keeps the give-up marker's true, which a build that cannot name its version stamps", async () => {
      await startWith({ [MIGRATION_ABANDONED_KEY]: "3.4.0" });
      expect(cache()[MIGRATION_ABANDONED_KEY]).toBe(true);

      expect(readSettingsForSnapshot()[MIGRATION_ABANDONED_KEY]).toBe(true);
    });

    it.each([
      ["false", false],
      ["a number", 1],
      ["an object", { LEAK: "object" }],
      ["null", null],
      ["a string longer than a version can be", `LEAK-${"9".repeat(300)}`],
    ])("writes the rejected marker for a give-up marker that is %s", (_name, stored) => {
      const result = readSettingsForSnapshot({ [MIGRATION_ABANDONED_KEY]: stored });

      expect(result[MIGRATION_ABANDONED_KEY]).toEqual(REJECTED);
      expect(JSON.stringify(result)).not.toContain("LEAK");
    });

    it("are absent from the snapshot when the settings do not hold them", async () => {
      await startWith({ driverName: "nick" });

      const result = readSettingsForSnapshot();

      expect(MIGRATION_PENDING_KEY in result).toBe(false);
      expect(MIGRATION_ABANDONED_KEY in result).toBe(false);
    });
  });

  describe("the voice packs", () => {
    /** The payload as `plugin-runtime`'s voice-pack phase publishes it. */
    const published = {
      packs: [
        {
          id: "default",
          label: "Default",
          version: "1.4.0",
          voices: [{ id: "default::default", label: "Default" }],
          provenance: "catalog",
          managed: true,
        },
        {
          id: "sample-pack",
          label: "Sample Pack",
          version: "0.1.0",
          voices: [
            { id: "sample-pack::one", label: "One" },
            { id: "sample-pack::two", label: "Two" },
          ],
          dir: "C:\\Users\\someone\\voices\\pack",
          provenance: "development",
          managed: false,
        },
      ],
      problems: [{ pack: "broken-pack", reason: "no voice-pack.json" }],
    };

    /** The same payload without the development pack's directory. */
    const expected = {
      packs: [
        published.packs[0],
        {
          id: "sample-pack",
          label: "Sample Pack",
          version: "0.1.0",
          voices: [
            { id: "sample-pack::one", label: "One" },
            { id: "sample-pack::two", label: "Two" },
          ],
          provenance: "development",
          managed: false,
        },
      ],
      problems: published.problems,
    };

    it("keeps the scan result as data, without the development pack's directory", async () => {
      await startWith({});
      // The producer's own write: a JSON string under a run-scoped key.
      updateGlobalSettings({ [VOICE_PACKS_KEY]: JSON.stringify(published) });
      expect(cache()[VOICE_PACKS_KEY]).toContain("someone");

      const result = readSettingsForSnapshot();
      const json = JSON.stringify(result);

      expect(json).not.toContain("someone");
      expect(json).not.toContain('"dir"');
      expect(json).not.toContain("voices\\\\pack");
      // Everything else about both packs is there, the development one included.
      expect(result[VOICE_PACKS_KEY]).toStrictEqual(expected);
    });

    it("drops a field nobody named, on a pack, a voice, a problem and the payload", async () => {
      await startWith({});
      updateGlobalSettings({
        [VOICE_PACKS_KEY]: JSON.stringify({
          packs: [
            {
              ...published.packs[0],
              author: "LEAK-author",
              clips: ["LEAK-clip.mp3"],
              voices: [{ id: "default::default", label: "Default", script: { LEAK: "script" } }],
            },
          ],
          problems: [{ pack: "broken-pack", reason: "no voice-pack.json", path: "C:\\LEAK\\broken-pack" }],
          scannedFrom: "C:\\LEAK\\packs",
        }),
      });

      const result = readSettingsForSnapshot();

      expect(result[VOICE_PACKS_KEY]).toEqual({ packs: [published.packs[0]], problems: published.problems });
      expect(JSON.stringify(result)).not.toContain("LEAK");
    });

    it.each([
      ["a value that is not a string", { packs: [], problems: [] }],
      ["text that is not JSON", "{LEAK not json"],
      ["an empty string", ""],
      ["JSON that is not an object", JSON.stringify(["LEAK-list"])],
      ["a payload with no problems list", JSON.stringify({ packs: [] })],
      ["a payload whose packs are not a list", JSON.stringify({ packs: "LEAK-packs", problems: [] })],
      [
        "a pack with a field of the wrong type",
        JSON.stringify({ packs: [{ ...published.packs[0], version: { LEAK: 1 } }], problems: [] }),
      ],
      [
        "a pack with a named field missing",
        JSON.stringify({ packs: [{ id: "LEAK-pack", label: "LEAK" }], problems: [] }),
      ],
      [
        "a voice that is not a record",
        JSON.stringify({ packs: [{ ...published.packs[0], voices: ["LEAK-voice"] }], problems: [] }),
      ],
      ["a problem with no reason", JSON.stringify({ packs: [], problems: [{ pack: "LEAK-problem" }] })],
      ["null", null],
    ])("writes the rejected marker, and none of the value, for %s", async (_name, stored) => {
      await startWith({});
      updateGlobalSettings({ [VOICE_PACKS_KEY]: stored });
      expect(cache()[VOICE_PACKS_KEY]).toEqual(stored);

      const result = readSettingsForSnapshot();

      expect(result[VOICE_PACKS_KEY]).toEqual(REJECTED);
      expect(JSON.stringify(result)).not.toContain("LEAK");
    });

    it("validates the value it was handed, not the cache's", async () => {
      await startWith({});
      updateGlobalSettings({ [VOICE_PACKS_KEY]: JSON.stringify(published) });

      const result = readSettingsForSnapshot({
        [VOICE_PACKS_KEY]: JSON.stringify({ packs: [], problems: [{ pack: "from-the-argument", reason: "r" }] }),
      });

      expect(result).toEqual({
        [VOICE_PACKS_KEY]: { packs: [], problems: [{ pack: "from-the-argument", reason: "r" }] },
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
