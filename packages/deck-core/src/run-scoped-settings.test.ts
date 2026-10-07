import { PI_WARNINGS_KEY, PROFILE_CAPTURE_STATUS_KEY, VOICE_PACKS_KEY } from "@iracedeck/app-constants";
import { describe, expect, it } from "vitest";

import { hasOnlyRunScopedKeys, RUN_SCOPED_SETTING_KEYS, stripRunScopedKeys } from "./run-scoped-settings.js";

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
