import {
  CAMERA_CATALOG_KEY,
  PI_WARNINGS_KEY,
  PROFILE_CAPTURE_STATUS_KEY,
  VOICE_PACKS_KEY,
} from "@iracedeck/app-constants";
import { silentLogger } from "@iracedeck/logger";
import { afterEach, describe, expect, it } from "vitest";

import {
  _resetGlobalSettings,
  getGlobalSettings,
  hostMirrorPayload,
  initGlobalSettings,
  updateGlobalSettings,
} from "./global-settings.js";
import { hasOnlyRunScopedKeys, RUN_SCOPED_SETTING_KEYS, stripRunScopedKeys } from "./run-scoped-settings.js";
import type { SettingsHost } from "./settings-host.js";
import { createMemorySettingsStore } from "./settings-store.js";

describe("run-scoped settings keys (issue #1014)", () => {
  it("enrols the PI warnings key", () => {
    expect(RUN_SCOPED_SETTING_KEYS).toContain(PI_WARNINGS_KEY);
  });

  // #1338: a "capturing" state read back after a restart would count down a
  // capture that died with the previous process.
  it("enrols the CPU profile capture status and strips it before the file", () => {
    expect(RUN_SCOPED_SETTING_KEYS).toContain(PROFILE_CAPTURE_STATUS_KEY);
    expect(
      stripRunScopedKeys({ [PROFILE_CAPTURE_STATUS_KEY]: JSON.stringify({ state: "capturing" }), driverName: "nick" }),
    ).toEqual({ driverName: "nick" });
    expect(hasOnlyRunScopedKeys([PROFILE_CAPTURE_STATUS_KEY])).toBe(true);
  });

  it("drops every enrolled key", () => {
    const stripped = stripRunScopedKeys(Object.fromEntries(RUN_SCOPED_SETTING_KEYS.map((key) => [key, "value"])));

    expect(Object.keys(stripped)).toEqual([]);
  });

  it("keeps every other key, durable underscore-prefixed ones included", () => {
    const stripped = stripRunScopedKeys({
      [PI_WARNINGS_KEY]: "[]",
      driverName: "nick",
      _lastSeenVersion: "3.0.0",
    });

    expect(stripped).toEqual({ driverName: "nick", _lastSeenVersion: "3.0.0" });
  });

  it("leaves the input untouched", () => {
    const input = { [PI_WARNINGS_KEY]: "[]", driverName: "nick" };

    stripRunScopedKeys(input);

    expect(input).toEqual({ [PI_WARNINGS_KEY]: "[]", driverName: "nick" });
  });

  it("returns a copy even when nothing is enrolled in the input", () => {
    const input = { driverName: "nick" };
    const stripped = stripRunScopedKeys(input);

    expect(stripped).toEqual(input);
    expect(stripped).not.toBe(input);
  });

  describe("hasOnlyRunScopedKeys", () => {
    it("is true for a write that touches nothing else", () => {
      expect(hasOnlyRunScopedKeys([...RUN_SCOPED_SETTING_KEYS])).toBe(true);
    });

    it("is false as soon as one durable key rides along", () => {
      expect(hasOnlyRunScopedKeys([PI_WARNINGS_KEY, "driverName"])).toBe(false);
    });

    it("is false for an empty write — nothing to write is not a run-scoped write", () => {
      expect(hasOnlyRunScopedKeys([])).toBe(false);
    });
  });
});

describe("voice packs are run-scoped (issue #1034)", () => {
  it("enrols the voice-pack list", () => {
    expect(RUN_SCOPED_SETTING_KEYS).toContain(VOICE_PACKS_KEY);
  });

  it("never writes the voice-pack list to the settings file", () => {
    const scan =
      '{"packs":[{"id":"luca","label":"Luca","version":"1.0.0","voices":[{"id":"luca","label":"Luca"}]}],"problems":[]}';
    const stripped = stripRunScopedKeys({ [VOICE_PACKS_KEY]: scan, raceEngineerVoice: "luca" });

    expect(stripped).toEqual({ raceEngineerVoice: "luca" });
  });

  it("treats a voice-pack-only write as touching nothing on disk", () => {
    expect(hasOnlyRunScopedKeys([VOICE_PACKS_KEY])).toBe(true);
  });
});

describe("the camera catalog view is run-scoped (issue #1653)", () => {
  const view = JSON.stringify({
    version: 1,
    tracks: [{ id: 13, name: "Spa", config: "Grand Prix" }],
    groups: [{ name: "DynamicTV", tracks: [0], lastSeen: "2026-11-08T12:00:00.000Z" }],
    current: { trackId: 13, groups: ["DynamicTV"] },
  });
  const host: SettingsHost = {
    onDidReceiveGlobalSettings: () => {},
    getGlobalSettings: () => {},
    setGlobalSettings: () => {},
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => _resetGlobalSettings());

  it("is enrolled", () => {
    expect(RUN_SCOPED_SETTING_KEYS).toContain(CAMERA_CATALOG_KEY);
  });

  it("is stripped before the file, and a catalog-only write touches nothing on disk", () => {
    expect(stripRunScopedKeys({ [CAMERA_CATALOG_KEY]: view, driverName: "nick" })).toEqual({ driverName: "nick" });
    expect(hasOnlyRunScopedKeys([CAMERA_CATALOG_KEY])).toBe(true);
    expect(hasOnlyRunScopedKeys([CAMERA_CATALOG_KEY, PI_WARNINGS_KEY])).toBe(true);
  });

  it("never enters the cache from a stored file, and the load-time re-save cleans it out", async () => {
    const store = createMemorySettingsStore({ [CAMERA_CATALOG_KEY]: view, driverName: "nick" });

    initGlobalSettings(host, silentLogger, store);
    await tick();

    expect((getGlobalSettings() as Record<string, unknown>)[CAMERA_CATALOG_KEY]).toBeUndefined();
    expect(getGlobalSettings().driverName).toBe("nick");

    for (const saved of store.saved) expect(saved).not.toHaveProperty(CAMERA_CATALOG_KEY);
  });

  it("lives in the cache for the run, never in a save or the host mirror", async () => {
    const store = createMemorySettingsStore({ driverName: "nick" });

    initGlobalSettings(host, silentLogger, store);
    await tick();

    const savesBefore = store.saved.length;

    updateGlobalSettings({ [CAMERA_CATALOG_KEY]: view });

    expect((getGlobalSettings() as Record<string, unknown>)[CAMERA_CATALOG_KEY]).toBe(view);
    // Durable in cameras.json and large: left out of the host mirror (HOST_MIRROR_EXCLUDED_KEYS).
    expect(hostMirrorPayload({ port: 1, token: "t".repeat(48) })).not.toHaveProperty(CAMERA_CATALOG_KEY);
    // A catalog-only write is not saved at all…
    expect(store.saved.length).toBe(savesBefore);

    // …and a durable write beside it saves without it.
    updateGlobalSettings({ driverName: "nicky" });
    expect(store.saved.at(-1)).toMatchObject({ driverName: "nicky" });
    expect(store.saved.at(-1)).not.toHaveProperty(CAMERA_CATALOG_KEY);
  });
});
