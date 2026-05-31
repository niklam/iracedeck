import { describe, expect, it } from "vitest";

import {
  isConstantBindingKey,
  isMultiBindingKey,
  keybind,
  keybindBy,
  keybindFixed,
  keybindKeys,
  resolveBindingKey,
  resolveBindingKeys,
} from "./comm-descriptor.js";

describe("comm-descriptor helpers", () => {
  it("keybind() builds a constant-key keybind descriptor", () => {
    const d = keybind("fuelServiceToggleAutofuel");
    expect(d.method).toBe("keybind");
    expect(d.binding).toEqual({ scope: "global", key: "fuelServiceToggleAutofuel" });
    expect(isConstantBindingKey(d.binding!)).toBe(true);
  });

  it("keybindBy() builds a secondary-setting-resolved descriptor", () => {
    const d = keybindBy("direction", { increase: "viewFovInc", decrease: "viewFovDec" });
    expect(d.method).toBe("keybind");
    expect(isConstantBindingKey(d.binding!)).toBe(false);
  });

  it("resolveBindingKey returns the constant key directly", () => {
    expect(resolveBindingKey({ scope: "global", key: "blackBoxCycleNext" }, {})).toBe("blackBoxCycleNext");
  });

  it("resolveBindingKey resolves keyBy from the secondary setting", () => {
    const ref = {
      scope: "global" as const,
      keyBy: { setting: "direction", map: { increase: "incKey", decrease: "decKey" } },
    };
    expect(resolveBindingKey(ref, { direction: "increase" })).toBe("incKey");
    expect(resolveBindingKey(ref, { direction: "decrease" })).toBe("decKey");
  });

  it("resolveBindingKey returns undefined when the secondary value is absent or unmapped", () => {
    const ref = { scope: "global" as const, keyBy: { setting: "direction", map: { increase: "incKey" } } };
    expect(resolveBindingKey(ref, {})).toBeUndefined();
    expect(resolveBindingKey(ref, { direction: "sideways" })).toBeUndefined();
  });

  it("resolveBindingKey returns undefined for an undefined ref (api/chat modes)", () => {
    expect(resolveBindingKey(undefined, { direction: "increase" })).toBeUndefined();
  });

  it("keybindKeys() builds a multi-key descriptor and is recognised by the guard", () => {
    const d = keybindKeys(["incKey", "decKey"]);
    expect(d.method).toBe("keybind");
    expect(isMultiBindingKey(d.binding!)).toBe(true);
    expect(isConstantBindingKey(d.binding!)).toBe(false);
  });

  it("keybindFixed() builds a keybind descriptor with no binding (fixed key)", () => {
    const d = keybindFixed();
    expect(d).toEqual({ method: "keybind" });
    expect(d.binding).toBeUndefined();
  });

  it("resolveBindingKeys returns all required keys for a multi-key ref", () => {
    expect(resolveBindingKeys({ scope: "global", keys: ["incKey", "decKey"] }, {})).toEqual(["incKey", "decKey"]);
  });

  it("resolveBindingKeys returns a single-element array for a constant ref", () => {
    expect(resolveBindingKeys({ scope: "global", key: "k" }, {})).toEqual(["k"]);
  });

  it("resolveBindingKeys resolves keyBy to one key (or empty when unmapped)", () => {
    const ref = { scope: "global" as const, keyBy: { setting: "direction", map: { increase: "incKey" } } };
    expect(resolveBindingKeys(ref, { direction: "increase" })).toEqual(["incKey"]);
    expect(resolveBindingKeys(ref, { direction: "down" })).toEqual([]);
  });

  it("resolveBindingKeys returns empty for an undefined ref (fixed/api/chat modes)", () => {
    expect(resolveBindingKeys(undefined, {})).toEqual([]);
  });
});
