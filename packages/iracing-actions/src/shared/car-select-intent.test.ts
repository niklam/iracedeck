import { beforeEach, describe, expect, it } from "vitest";

import { _resetSelectIntents, clearSelectIntent, getSelectIntent, setSelectIntent } from "./car-select-intent.js";

describe("car-select-intent", () => {
  beforeEach(() => {
    _resetSelectIntents();
  });

  it("stores and returns an intent per device", () => {
    setSelectIntent("dev-1", { action: "focus-camera" });

    expect(getSelectIntent("dev-1")).toEqual({ action: "focus-camera" });
    expect(getSelectIntent("dev-2")).toBeUndefined();
  });

  it("clears only the given device's intent", () => {
    setSelectIntent("dev-1", { action: "focus-camera" });
    setSelectIntent("dev-2", { action: "focus-camera" });
    clearSelectIntent("dev-1");

    expect(getSelectIntent("dev-1")).toBeUndefined();
    expect(getSelectIntent("dev-2")).toEqual({ action: "focus-camera" });
  });

  it("normalizes an undefined deviceId to the empty-string group", () => {
    setSelectIntent(undefined, { action: "focus-camera" });

    expect(getSelectIntent(undefined)).toEqual({ action: "focus-camera" });
    expect(getSelectIntent("")).toEqual({ action: "focus-camera" });

    clearSelectIntent(undefined);
    expect(getSelectIntent("")).toBeUndefined();
  });

  it("clearing an absent intent is a no-op", () => {
    expect(() => clearSelectIntent("nope")).not.toThrow();
  });
});
