import { describe, expect, it } from "vitest";

import {
  defaultBindingStoredValue,
  isValidKey,
  KEY_CODE_MAP,
  keyForCode,
  keyToCode,
  parseDefaultKeyBinding,
} from "./key-binding-defaults.js";

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
      // from this package); these pin its observable results.
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

  describe("names inherited from Object.prototype are not keys", () => {
    // Default strings and event codes are outside input; an object index would
    // answer these with a function (`KEY_CODE_MAP.constructor`).
    const INHERITED = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"];

    it.each(INHERITED)("%s is neither a key nor a code", (name) => {
      expect(isValidKey(name)).toBe(false);
      expect(keyToCode(name)).toBeUndefined();
      expect(keyForCode(name)).toBeUndefined();
    });

    it.each(INHERITED)("a default naming %s is not a binding", (name) => {
      expect(parseDefaultKeyBinding(name)).toBeUndefined();
      expect(parseDefaultKeyBinding(`Shift+${name}`)).toBeUndefined();
      expect(defaultBindingStoredValue(name)).toBeUndefined();
    });

    it.each(INHERITED)("%s is not a modifier alias either", (name) => {
      expect(parseDefaultKeyBinding(`${name}+V`)).toEqual({ type: "keyboard", key: "v", modifiers: [], code: "KeyV" });
    });

    it("still maps every real code both ways", () => {
      for (const [code, key] of Object.entries(KEY_CODE_MAP)) {
        expect(keyForCode(code), code).toBe(key);
        expect(keyToCode(key), key).toBe(code);
      }
    });
  });
});
