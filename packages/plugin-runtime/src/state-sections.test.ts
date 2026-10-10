import { readRaceEngineerState } from "@iracedeck/audio-scenarios/pit-crew";
import { _resetStateSections, collectStateSections, PLUGIN_STATE_SCHEMA } from "@iracedeck/diagnostics";
import { silentLogger } from "@iracedeck/logger";
import {
  _resetGlobalSettings,
  createMemorySettingsStore,
  getGlobalSettings,
  initGlobalSettings,
  isSettingsStoreReady,
  SETTINGS_CHANNEL_KEY,
  type SettingsHost,
  updateGlobalSettings,
} from "@iracedeck/settings";
import { _resetSimEventsIracing, readSimState } from "@iracedeck/sim-events-iracing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerStateSections } from "./state-sections.js";
import type { Core } from "./types.js";

// Everything the sections read is REAL here except the deck host's side and the
// SDK's: the registry and its encoder (`@iracedeck/diagnostics`), the settings
// cache and its snapshot filter (`@iracedeck/settings`), the translator's reader
// and the Race Engineer's. What this file proves is a property of the four wired
// together — what the collected output holds — so a recorded stub in any of
// those seats would prove nothing. The two packages below are stubbed because
// their answers come from the deck host (`config.json`) and from iRacing.
const deck = vi.hoisted(() => ({
  pluginVersion: "9.8.7-test",
  platform: "stream-deck",
  iRacingActive: false,
  elevationMismatch: false,
}));

vi.mock("@iracedeck/deck-core", () => ({
  getPluginVersion: () => deck.pluginVersion,
  getPluginPlatform: () => deck.platform,
}));
vi.mock("@iracedeck/deck-iracing", () => ({
  isIRacingActive: () => deck.iRacingActive,
  hasElevationMismatch: () => deck.elevationMismatch,
}));

const TOKEN = "tok-SECRET-1387";
const PORT = 49152;

/** The two paths `Core` carries. Each holds the Windows user name, which is why no section may report one. */
const BIN_DIR =
  "C:\\Users\\someone\\AppData\\Roaming\\Elgato\\StreamDeck\\Plugins\\com.iracedeck.sd.core.sdPlugin\\bin";
const LOG_PATH = "C:\\Users\\someone\\AppData\\Roaming\\Elgato\\StreamDeck\\logs\\com.iracedeck.sd.core.0.log";

/** A fixed clock, so no assertion on the output's text can meet a digit run of `Date.now()`. */
const NOW = 1_700_000_000_000;

/** A deck host that never answers: the memory store is the only source of settings. */
const settingsHost: SettingsHost = {
  onDidReceiveGlobalSettings: () => {},
  getGlobalSettings: () => {},
  setGlobalSettings: () => {},
};

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Starts the real settings cache over a memory store holding `stored`, and waits for the load. */
async function startSettingsWith(stored: Record<string, unknown>): Promise<void> {
  initGlobalSettings(settingsHost, silentLogger, createMemorySettingsStore(stored));
  await tick();
  expect(isSettingsStoreReady()).toBe(true);
}

let sdkConnected = false;

/** A `Core` whose controller answers `sdkConnected`, and whose paths are real-looking Windows ones. */
function createCore(): Core {
  return {
    binDir: BIN_DIR,
    logLocation: { kind: "file", path: LOG_PATH },
    controller: { getConnectionStatus: () => sdkConnected },
  } as unknown as Core;
}

const collect = () => collectStateSections(silentLogger, () => NOW);

describe("registerStateSections (#1387)", () => {
  beforeEach(() => {
    _resetStateSections();
    _resetGlobalSettings();
    _resetSimEventsIracing();
    deck.pluginVersion = "9.8.7-test";
    deck.platform = "stream-deck";
    deck.iRacingActive = false;
    deck.elevationMismatch = false;
    sdkConnected = false;
  });

  afterEach(() => {
    _resetStateSections();
    _resetGlobalSettings();
  });

  describe("the sections", () => {
    it("registers environment, settings, sim and raceEngineer, in the order the file lists them", () => {
      registerStateSections(createCore());

      const { state, failed } = collect();

      expect(Object.keys(state)).toEqual(["schema", "collectedAt", "environment", "settings", "sim", "raceEngineer"]);
      expect(state.schema).toBe(PLUGIN_STATE_SCHEMA);
      expect(state.collectedAt).toBe(NOW);
      expect(failed).toEqual([]);
    });

    it("throws when called a second time: the registry's one-owner rule reaches the caller", () => {
      registerStateSections(createCore());

      expect(() => registerStateSections(createCore())).toThrow(/"environment" is already registered/);
    });

    it("reads nothing at registration", () => {
      const getConnectionStatus = vi.fn(() => false);

      registerStateSections({ controller: { getConnectionStatus } } as unknown as Core);

      expect(getConnectionStatus).not.toHaveBeenCalled();

      // Positive control: the same spy is what a collection calls.
      collect();
      expect(getConnectionStatus).toHaveBeenCalledTimes(1);
    });
  });

  describe("environment", () => {
    it("reports the plugin version, the deck host, Node, the three sim-side answers and the settings store", () => {
      registerStateSections(createCore());

      expect(collect().state.environment).toEqual({
        pluginVersion: "9.8.7-test",
        host: "stream-deck",
        node: process.version,
        sdkConnected: false,
        iRacingActive: false,
        elevationMismatch: false,
        settingsStoreReady: false,
        settingsStoreSource: null,
      });
    });

    it("leads the Markdown report with the plugin version and the deck host", () => {
      registerStateSections(createCore());

      expect(collect().headline.slice(0, 2)).toEqual([
        ["Plugin version", "9.8.7-test"],
        ["Deck host", "stream-deck"],
      ]);
    });

    // The SDK connects, iRacing starts and the settings load long after
    // `initCore` registered the reader, so a value captured at registration
    // would describe startup rather than the press.
    it("is read at the press, not at registration", async () => {
      registerStateSections(createCore());
      const before = collect().state.environment;

      deck.pluginVersion = "9.9.0-later";
      deck.platform = "mirabox";
      deck.iRacingActive = true;
      deck.elevationMismatch = true;
      sdkConnected = true;
      await startSettingsWith({ driverName: "nick" });

      expect(before).toMatchObject({ sdkConnected: false, iRacingActive: false, settingsStoreReady: false });
      expect(collect().state.environment).toEqual({
        pluginVersion: "9.9.0-later",
        host: "mirabox",
        node: process.version,
        sdkConnected: true,
        iRacingActive: true,
        elevationMismatch: true,
        settingsStoreReady: true,
        settingsStoreSource: "file",
      });
    });

    // The settings section alone cannot tell a user on the defaults from a
    // press before the store loaded: both read as the schema defaults.
    it("tells a store that has not loaded yet from one that has", async () => {
      registerStateSections(createCore());
      initGlobalSettings(settingsHost, silentLogger, createMemorySettingsStore({ driverName: "nick" }));

      expect(collect().state.environment).toMatchObject({ settingsStoreReady: false, settingsStoreSource: null });

      await tick();

      expect(collect().state.environment).toMatchObject({ settingsStoreReady: true, settingsStoreSource: "file" });
    });

    it("holds no file path: no backslash and no drive letter in any value, and neither of the core's paths", async () => {
      await startSettingsWith({});
      deck.iRacingActive = true;
      sdkConnected = true;
      registerStateSections(createCore());

      const collected = collect();
      const environment = collected.state.environment as Record<string, unknown>;

      // Positive control: the section is the real one, not an error entry with nothing to find.
      expect(environment.pluginVersion).toBe("9.8.7-test");

      for (const [key, value] of Object.entries(environment)) {
        const text = JSON.stringify(value);

        expect(text, key).not.toContain("\\");
        expect(text, key).not.toMatch(/[A-Za-z]:[\\/]/);
      }

      // And nothing else in the output carries the plugin's own directories.
      const json = JSON.stringify(collected);

      expect(json).not.toContain(JSON.stringify(BIN_DIR).slice(1, -1));
      expect(json).not.toContain(JSON.stringify(LOG_PATH).slice(1, -1));
      expect(json).not.toContain("someone");
    });
  });

  // Review Focus 3: the settings-server token must not reach the file by ANY
  // route, so these read the whole collected output, headline rows included,
  // not the settings section.
  describe("the settings-server token", () => {
    it("is nowhere in the collected output when the stored settings carried the channel", async () => {
      await startSettingsWith({ [SETTINGS_CHANNEL_KEY]: { port: PORT, token: TOKEN }, driverName: "nick" });
      // Not vacuous: the cache the sections read really holds the secret.
      expect(JSON.stringify(getGlobalSettings())).toContain(TOKEN);
      registerStateSections(createCore());

      const collected = collect();
      const json = JSON.stringify(collected);

      expect(json).not.toContain(TOKEN);
      expect(json).not.toContain(SETTINGS_CHANNEL_KEY);
      expect(json).not.toContain(String(PORT));
      // Positive control: the settings section did read that cache, and no section failed its way out.
      expect((collected.state.settings as Record<string, unknown>).driverName).toBe("nick");
      expect(collected.failed).toEqual([]);
    });

    it("is nowhere in the collected output when the channel was published during the run", async () => {
      await startSettingsWith({ driverName: "nick" });
      registerStateSections(createCore());
      updateGlobalSettings({ [SETTINGS_CHANNEL_KEY]: { port: PORT, token: TOKEN } });
      expect(JSON.stringify(getGlobalSettings())).toContain(TOKEN);

      const collected = collect();
      const json = JSON.stringify(collected);

      expect(json).not.toContain(TOKEN);
      expect(json).not.toContain(SETTINGS_CHANNEL_KEY);
      expect(json).not.toContain(String(PORT));
      expect((collected.state.settings as Record<string, unknown>).driverName).toBe("nick");
      expect(collected.failed).toEqual([]);
    });
  });

  // Review Focus 2: a press before the later phases have started anything.
  describe("before the subsystems are up", () => {
    it("reports sim and raceEngineer as uninitialised, and fails no section", () => {
      // The precondition, on the real readers: no translator, no scenario engine.
      expect(readSimState()).toEqual({ initialized: false });
      expect(readRaceEngineerState()).toEqual({ initialized: false });
      registerStateSections(createCore());

      const { state, failed, headline } = collect();

      expect(state.sim).toEqual({ initialized: false });
      expect(state.raceEngineer).toEqual({ initialized: false });
      expect(failed).toEqual([]);
      // Their rows say so too, after the environment's two. Settings has no headline.
      expect(headline.slice(2)).toEqual([
        ["Sim state", "not initialized"],
        ["Race Engineer", "not initialized"],
      ]);
    });

    it("reports the schema defaults as the settings when the settings were never initialised", () => {
      registerStateSections(createCore());

      const { state, failed } = collect();

      expect(state.settings).toEqual(JSON.parse(JSON.stringify(getGlobalSettings())));
      expect(Object.keys(state.settings as object).filter((key) => key.startsWith("_"))).toEqual([]);
      expect(failed).toEqual([]);
    });
  });
});
