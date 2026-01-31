import { describe, expect, it } from "vitest";

import { formatKeyBinding, type KeyBindingValue, parseKeyBinding, parseSimpleDefault } from "./key-binding-utils.js";
import { resolveEventCode } from "./key-maps.js";

describe("key-binding-input", () => {
  describe("resolveEventCode", () => {
    it("should return navigation code when numpad code has navigation key", () => {
      expect(resolveEventCode("Numpad9", "PageUp")).toBe("PageUp");
      expect(resolveEventCode("Numpad3", "PageDown")).toBe("PageDown");
      expect(resolveEventCode("Numpad7", "Home")).toBe("Home");
      expect(resolveEventCode("Numpad1", "End")).toBe("End");
    });

    it("should return navigation code for numpad arrow keys", () => {
      expect(resolveEventCode("Numpad8", "ArrowUp")).toBe("ArrowUp");
      expect(resolveEventCode("Numpad2", "ArrowDown")).toBe("ArrowDown");
      expect(resolveEventCode("Numpad4", "ArrowLeft")).toBe("ArrowLeft");
      expect(resolveEventCode("Numpad6", "ArrowRight")).toBe("ArrowRight");
    });

    it("should return navigation code for numpad Insert/Delete", () => {
      expect(resolveEventCode("Numpad0", "Insert")).toBe("Insert");
      expect(resolveEventCode("NumpadDecimal", "Delete")).toBe("Delete");
    });

    it("should pass through numpad codes when key is a digit (NumLock on)", () => {
      expect(resolveEventCode("Numpad9", "9")).toBe("Numpad9");
      expect(resolveEventCode("Numpad3", "3")).toBe("Numpad3");
      expect(resolveEventCode("Numpad0", "0")).toBe("Numpad0");
    });

    it("should pass through non-numpad codes unchanged", () => {
      expect(resolveEventCode("PageUp", "PageUp")).toBe("PageUp");
      expect(resolveEventCode("KeyA", "a")).toBe("KeyA");
      expect(resolveEventCode("F1", "F1")).toBe("F1");
      expect(resolveEventCode("Minus", "+")).toBe("Minus");
    });
  });

  describe("formatKeyBinding", () => {
    it("should return 'Not set' for null value", () => {
      expect(formatKeyBinding(null)).toBe("Not set");
    });

    it("should return 'Not set' for empty key", () => {
      expect(formatKeyBinding({ key: "", modifiers: [] })).toBe("Not set");
    });

    it("should format simple key without modifiers", () => {
      expect(formatKeyBinding({ key: "a", modifiers: [] })).toBe("A");
    });

    it("should format key with single modifier", () => {
      expect(formatKeyBinding({ key: "a", modifiers: ["ctrl"] })).toBe("Ctrl + A");
    });

    it("should format key with multiple modifiers in correct order", () => {
      expect(formatKeyBinding({ key: "a", modifiers: ["alt", "ctrl", "shift"] })).toBe("Ctrl + Shift + Alt + A");
    });

    it("should use display names for special keys", () => {
      expect(formatKeyBinding({ key: "space", modifiers: [] })).toBe("Space");
      expect(formatKeyBinding({ key: "enter", modifiers: [] })).toBe("Enter");
      expect(formatKeyBinding({ key: "escape", modifiers: [] })).toBe("Esc");
    });

    it("should format function keys correctly", () => {
      expect(formatKeyBinding({ key: "f1", modifiers: [] })).toBe("F1");
      expect(formatKeyBinding({ key: "f12", modifiers: ["ctrl"] })).toBe("Ctrl + F12");
    });

    it("should format arrow keys correctly", () => {
      expect(formatKeyBinding({ key: "up", modifiers: [] })).toBe("Up");
      expect(formatKeyBinding({ key: "down", modifiers: ["shift"] })).toBe("Shift + Down");
    });

    it("should format numpad keys correctly", () => {
      expect(formatKeyBinding({ key: "numpad0", modifiers: [] })).toBe("Num 0");
      expect(formatKeyBinding({ key: "numpad_add", modifiers: [] })).toBe("Num +");
    });

    it("should handle undefined modifiers gracefully", () => {
      const value = { key: "a" } as KeyBindingValue;

      expect(formatKeyBinding(value)).toBe("A");
    });

    it("should use displayKey when present for single character", () => {
      expect(formatKeyBinding({ key: "'", modifiers: [], displayKey: "ä" })).toBe("Ä");
    });

    it("should use displayKey with modifiers", () => {
      expect(formatKeyBinding({ key: "'", modifiers: ["shift"], displayKey: "Ä" })).toBe("Shift + Ä");
    });

    it("should fall back to key when displayKey is absent", () => {
      expect(formatKeyBinding({ key: "f1", modifiers: [] })).toBe("F1");
    });

    it("should fall back to key for old format bindings without displayKey", () => {
      expect(formatKeyBinding({ key: "'", modifiers: [] })).toBe("'");
    });

    it("should not capitalize multi-character displayKey", () => {
      expect(formatKeyBinding({ key: "enter", modifiers: [], displayKey: "Enter" })).toBe("Enter");
    });
  });

  describe("parseKeyBinding", () => {
    it("should return null for null input", () => {
      expect(parseKeyBinding(null)).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(parseKeyBinding("")).toBeNull();
    });

    it("should parse valid JSON key binding", () => {
      const json = '{"key":"a","modifiers":["ctrl"]}';
      const result = parseKeyBinding(json);

      expect(result).toEqual({ key: "a", modifiers: ["ctrl"] });
    });

    it("should parse key binding with multiple modifiers", () => {
      const json = '{"key":"f1","modifiers":["ctrl","shift","alt"]}';
      const result = parseKeyBinding(json);

      expect(result).toEqual({ key: "f1", modifiers: ["ctrl", "shift", "alt"] });
    });

    it("should parse key binding with no modifiers", () => {
      const json = '{"key":"space","modifiers":[]}';
      const result = parseKeyBinding(json);

      expect(result).toEqual({ key: "space", modifiers: [] });
    });

    it("should return null for invalid JSON", () => {
      expect(parseKeyBinding("not json")).toBeNull();
    });

    it("should return null for missing key property", () => {
      expect(parseKeyBinding('{"modifiers":["ctrl"]}')).toBeNull();
    });

    it("should return null for non-string key", () => {
      expect(parseKeyBinding('{"key":123,"modifiers":[]}')).toBeNull();
    });

    it("should return null for non-array modifiers", () => {
      expect(parseKeyBinding('{"key":"a","modifiers":"ctrl"}')).toBeNull();
    });

    it("should preserve code and displayKey fields", () => {
      const json = '{"key":"\'","modifiers":["shift"],"code":"Quote","displayKey":"Ä"}';
      const result = parseKeyBinding(json);

      expect(result).toEqual({
        key: "'",
        modifiers: ["shift"],
        code: "Quote",
        displayKey: "Ä",
      });
    });

    it("should parse old format without code/displayKey", () => {
      const json = '{"key":"\'","modifiers":[]}';
      const result = parseKeyBinding(json);

      expect(result).toEqual({ key: "'", modifiers: [] });
      expect(result?.code).toBeUndefined();
      expect(result?.displayKey).toBeUndefined();
    });

    it("should sanitize non-string code field", () => {
      const json = '{"key":"a","modifiers":[],"code":123}';
      const result = parseKeyBinding(json);

      expect(result?.code).toBeUndefined();
    });

    it("should sanitize non-string displayKey field", () => {
      const json = '{"key":"a","modifiers":[],"displayKey":456}';
      const result = parseKeyBinding(json);

      expect(result?.displayKey).toBeUndefined();
    });

    it("should parse old format with extra fields gracefully", () => {
      const json = '{"key":"a","modifiers":[],"vk":65}';
      const result = parseKeyBinding(json);

      expect(result?.key).toBe("a");
      expect(result?.modifiers).toEqual([]);
    });
  });

  describe("parseSimpleDefault", () => {
    it("should parse simple key with code", () => {
      expect(parseSimpleDefault("a")).toEqual({ key: "a", modifiers: [], code: "KeyA" });
    });

    it("should parse function key with code", () => {
      expect(parseSimpleDefault("F1")).toEqual({ key: "f1", modifiers: [], code: "F1" });
    });

    it("should parse key with single modifier", () => {
      expect(parseSimpleDefault("Ctrl+A")).toEqual({ key: "a", modifiers: ["ctrl"], code: "KeyA" });
    });

    it("should parse key with multiple modifiers", () => {
      expect(parseSimpleDefault("Ctrl+Shift+Alt+A")).toEqual({
        key: "a",
        modifiers: ["ctrl", "shift", "alt"],
        code: "KeyA",
      });
    });

    it("should handle 'Control' alias for 'ctrl'", () => {
      expect(parseSimpleDefault("Control+A")).toEqual({ key: "a", modifiers: ["ctrl"], code: "KeyA" });
    });

    it("should handle spaces around plus signs", () => {
      expect(parseSimpleDefault("Ctrl + Shift + A")).toEqual({
        key: "a",
        modifiers: ["ctrl", "shift"],
        code: "KeyA",
      });
    });

    it("should be case-insensitive", () => {
      expect(parseSimpleDefault("CTRL+SHIFT+A")).toEqual({
        key: "a",
        modifiers: ["ctrl", "shift"],
        code: "KeyA",
      });
    });

    it("should return null for invalid key", () => {
      expect(parseSimpleDefault("InvalidKey")).toBeNull();
    });

    it("should return null for modifier-only input", () => {
      expect(parseSimpleDefault("Ctrl+Shift")).toBeNull();
    });

    it("should parse special keys with code", () => {
      expect(parseSimpleDefault("Space")).toEqual({ key: "space", modifiers: [], code: "Space" });
      expect(parseSimpleDefault("Ctrl+Enter")).toEqual({ key: "enter", modifiers: ["ctrl"], code: "Enter" });
    });

    it("should include code for navigation keys", () => {
      expect(parseSimpleDefault("Ctrl+pageup")).toEqual({ key: "pageup", modifiers: ["ctrl"], code: "PageUp" });
      expect(parseSimpleDefault("Ctrl+pagedown")).toEqual({ key: "pagedown", modifiers: ["ctrl"], code: "PageDown" });
    });

    it("should include code for symbol keys", () => {
      const result = parseSimpleDefault("-");
      expect(result?.code).toBe("Minus");

      const result2 = parseSimpleDefault("/");
      expect(result2?.code).toBe("Slash");
    });
  });
});
