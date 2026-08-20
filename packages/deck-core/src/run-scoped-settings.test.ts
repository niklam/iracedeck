import { describe, expect, it } from "vitest";

import { PI_WARNINGS_KEY } from "./pi-warnings-constants.js";
import { hasOnlyRunScopedKeys, RUN_SCOPED_SETTING_KEYS, stripRunScopedKeys } from "./run-scoped-settings.js";

describe("run-scoped settings keys (issue #1014)", () => {
  it("enrols the PI warnings key", () => {
    expect(RUN_SCOPED_SETTING_KEYS).toContain(PI_WARNINGS_KEY);
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
