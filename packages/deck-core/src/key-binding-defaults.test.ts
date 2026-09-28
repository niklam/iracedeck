import { describe, expect, it } from "vitest";

import { BINDING_KEY_CODE_MAP, defaultBindingStoredValue, parseDefaultKeyBinding } from "./key-binding-defaults.js";
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

    it("maps every recordable key back to its code", () => {
      for (const [code, key] of Object.entries(BINDING_KEY_CODE_MAP)) {
        expect(parseDefaultKeyBinding(key)?.code, key).toBe(code);
      }
    });
  });
});
