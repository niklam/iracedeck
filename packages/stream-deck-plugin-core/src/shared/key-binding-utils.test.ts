import { describe, expect, it } from "vitest";

import { formatKeyBinding, parseKeyBinding } from "./key-binding-utils.js";

describe("Key Binding Utils", () => {
  describe("formatKeyBinding", () => {
    it("should return empty string for undefined binding", () => {
      expect(formatKeyBinding(undefined)).toBe("");
    });

    it("should return empty string for binding without key", () => {
      expect(formatKeyBinding({ key: "", modifiers: [] })).toBe("");
    });

    it("should format key without modifiers", () => {
      expect(formatKeyBinding({ key: "f1", modifiers: [] })).toBe("F1");
    });

    it("should format key with single modifier", () => {
      expect(formatKeyBinding({ key: "r", modifiers: ["shift"] })).toBe("Shift+R");
    });

    it("should format key with multiple modifiers", () => {
      expect(formatKeyBinding({ key: "s", modifiers: ["ctrl", "shift"] })).toBe("Ctrl+Shift+S");
    });

    it("should filter out unsupported modifiers", () => {
      expect(formatKeyBinding({ key: "a", modifiers: ["ctrl", "meta", "alt"] })).toBe("Ctrl+Alt+A");
    });

    it("should capitalize modifiers correctly", () => {
      expect(formatKeyBinding({ key: "x", modifiers: ["alt"] })).toBe("Alt+X");
    });

    it("should prefer displayKey over key for single character", () => {
      expect(formatKeyBinding({ key: "'", modifiers: [], displayKey: "ä" })).toBe("Ä");
    });

    it("should format displayKey with modifiers", () => {
      expect(formatKeyBinding({ key: "[", modifiers: ["ctrl"], displayKey: "å" })).toBe("Ctrl+Å");
    });

    it("should not capitalize multi-character displayKey", () => {
      expect(formatKeyBinding({ key: "enter", modifiers: [], displayKey: "Enter" })).toBe("Enter");
    });

    it("should fall back to key when displayKey is absent", () => {
      expect(formatKeyBinding({ key: "'", modifiers: [] })).toBe("'");
    });
  });

  describe("parseKeyBinding", () => {
    it("should return undefined for null value", () => {
      expect(parseKeyBinding(null)).toBeUndefined();
    });

    it("should return undefined for undefined value", () => {
      expect(parseKeyBinding(undefined)).toBeUndefined();
    });

    it("should return undefined for empty string", () => {
      expect(parseKeyBinding("")).toBeUndefined();
    });

    it("should parse valid JSON string", () => {
      const json = JSON.stringify({ key: "f1", modifiers: [] });
      const result = parseKeyBinding(json);

      expect(result).toEqual({ key: "f1", modifiers: [] });
    });

    it("should parse JSON string with modifiers", () => {
      const json = JSON.stringify({ key: "r", modifiers: ["ctrl", "shift"] });
      const result = parseKeyBinding(json);

      expect(result).toEqual({ key: "r", modifiers: ["ctrl", "shift"] });
    });

    it("should return undefined for invalid JSON string", () => {
      expect(parseKeyBinding("not valid json")).toBeUndefined();
    });

    it("should return undefined for JSON missing required fields", () => {
      const json = JSON.stringify({ notKey: "f1" });

      expect(parseKeyBinding(json)).toBeUndefined();
    });

    it("should parse already-parsed object", () => {
      const obj = { key: "f3", modifiers: ["alt"] };
      const result = parseKeyBinding(obj);

      expect(result).toEqual({ key: "f3", modifiers: ["alt"] });
    });

    it("should add default empty modifiers array if missing", () => {
      const obj = { key: "f5" };
      const result = parseKeyBinding(obj);

      expect(result).toEqual({ key: "f5", modifiers: [] });
    });

    it("should return undefined for invalid object", () => {
      const obj = { wrong: "shape" };

      expect(parseKeyBinding(obj)).toBeUndefined();
    });

    it("should return undefined for number value", () => {
      expect(parseKeyBinding(123)).toBeUndefined();
    });

    it("should return undefined for boolean value", () => {
      expect(parseKeyBinding(true)).toBeUndefined();
    });

    it("should pass through code and displayKey from JSON string", () => {
      const json = JSON.stringify({ key: "'", modifiers: [], code: "Quote", displayKey: "ä" });
      const result = parseKeyBinding(json);

      expect(result?.code).toBe("Quote");
      expect(result?.displayKey).toBe("ä");
    });

    it("should pass through code and displayKey from object", () => {
      const obj = { key: "'", modifiers: [], code: "Quote", displayKey: "ä" };
      const result = parseKeyBinding(obj);

      expect(result?.code).toBe("Quote");
      expect(result?.displayKey).toBe("ä");
    });

    it("should parse old format without code/displayKey", () => {
      const json = JSON.stringify({ key: "f1", modifiers: [] });
      const result = parseKeyBinding(json);

      expect(result?.code).toBeUndefined();
      expect(result?.displayKey).toBeUndefined();
    });
  });
});
