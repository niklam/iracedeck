import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { defaultBindingStoredValue, KEY_CODE_MAP, parseDefaultKeyBinding } from "./key-binding-defaults.js";
import { parseBinding, parseKeyBinding } from "./key-binding-utils.js";

describe("key-binding-defaults (#1277)", () => {
  describe("defaultBindingStoredValue", () => {
    it("stores V as the JSON the binding field saves for it", () => {
      // Byte-for-byte what `ird-key-binding` saves: JSON.stringify(parseSimpleDefault("V")).
      expect(defaultBindingStoredValue("V")).toBe('{"type":"keyboard","key":"v","modifiers":[],"code":"KeyV"}');
    });

    it("stores Shift+V with the modifier and the physical key code", () => {
      expect(defaultBindingStoredValue("Shift+V")).toBe(
        '{"type":"keyboard","key":"v","modifiers":["shift"],"code":"KeyV"}',
      );
    });

    it("is undefined for an empty default or one naming no key", () => {
      expect(defaultBindingStoredValue("")).toBeUndefined();
      expect(defaultBindingStoredValue("Shift")).toBeUndefined();
      expect(defaultBindingStoredValue("Hyper+Q1")).toBeUndefined();
    });

    it("round-trips through the parser the dispatcher reads bindings with", () => {
      const stored = defaultBindingStoredValue("Shift+V");

      expect(parseBinding(stored)).toEqual({ type: "keyboard", key: "v", modifiers: ["shift"], code: "KeyV" });
      expect(parseKeyBinding(stored)).toEqual({ type: "keyboard", key: "v", modifiers: ["shift"], code: "KeyV" });
    });
  });

  describe("parseDefaultKeyBinding", () => {
    it("keeps modifiers in the order written and accepts the Control alias", () => {
      expect(parseDefaultKeyBinding("Ctrl+Shift+Alt+A")).toEqual({
        type: "keyboard",
        key: "a",
        modifiers: ["ctrl", "shift", "alt"],
        code: "KeyA",
      });
      expect(parseDefaultKeyBinding("Alt+Control+A")?.modifiers).toEqual(["alt", "ctrl"]);
    });

    it("ignores case and whitespace around the parts", () => {
      expect(parseDefaultKeyBinding(" CTRL + shift + f1 ")).toEqual({
        type: "keyboard",
        key: "f1",
        modifiers: ["ctrl", "shift"],
        code: "F1",
      });
    });

    it("is exactly what the PI field saves for a default, key by key", () => {
      // The PI's parseSimpleDefault is this function (pi-components imports it
      // through the subpath); these pin its observable results.
      expect(parseDefaultKeyBinding("a")).toEqual({ type: "keyboard", key: "a", modifiers: [], code: "KeyA" });
      expect(parseDefaultKeyBinding("Ctrl+pageup")?.code).toBe("PageUp");
      expect(parseDefaultKeyBinding("-")?.code).toBe("Minus");
      expect(parseDefaultKeyBinding("Ctrl+Shift")).toBeUndefined();
      expect(parseDefaultKeyBinding("numpad10")).toBeUndefined();
    });

    it("maps every recordable key back to its code", () => {
      for (const [code, key] of Object.entries(KEY_CODE_MAP)) {
        expect(parseDefaultKeyBinding(key)?.code, key).toBe(code);
      }
    });
  });

  it("imports nothing, so the PI bundle can take it through the subpath", () => {
    // pi-components bundles this file into every Property Inspector via
    // `@iracedeck/deck-core/key-binding-defaults`; an import here would travel
    // with it — the deck-core barrel it exists to keep out, at worst.
    const source = readFileSync(new URL("./key-binding-defaults.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/^\s*(import|export\s.*\sfrom)\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
});
