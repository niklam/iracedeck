import { describe, expect, it } from "vitest";

import { isConstantBindingKey, keybind, keybindBy, resolveBindingKey } from "./comm-descriptor.js";

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
});
