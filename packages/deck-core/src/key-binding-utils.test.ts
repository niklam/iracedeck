import { defaultBindingStoredValue } from "@iracedeck/app-constants";
import { isSimHubBinding, type SimHubBindingValue } from "@iracedeck/settings";
import { describe, expect, it } from "vitest";

import { formatKeyBinding, parseBinding, parseKeyBinding } from "./key-binding-utils.js";

describe("parseBinding", () => {
  describe("keyboard bindings (JSON string)", () => {
    it("should parse a keyboard binding JSON string", () => {
      const result = parseBinding('{"key":"f1","modifiers":["ctrl"],"code":"F1"}');

      expect(result).toEqual({ type: "keyboard", key: "f1", modifiers: ["ctrl"], code: "F1" });
    });

    it("should parse a keyboard binding with explicit type", () => {
      const result = parseBinding('{"type":"keyboard","key":"f1","modifiers":["ctrl"]}');

      expect(result).toEqual({ type: "keyboard", key: "f1", modifiers: ["ctrl"] });
    });

    it("should parse a keyboard binding with empty modifiers", () => {
      const result = parseBinding('{"key":"a","modifiers":[]}');

      expect(result).toEqual({ type: "keyboard", key: "a", modifiers: [] });
    });

    it("should parse a keyboard binding with displayKey", () => {
      const result = parseBinding('{"key":"\'","modifiers":[],"code":"Quote","displayKey":"ä"}');

      expect(result).toEqual({ type: "keyboard", key: "'", modifiers: [], code: "Quote", displayKey: "ä" });
    });

    it("should reject a keyboard binding with empty key", () => {
      expect(parseBinding('{"key":"","modifiers":[]}')).toBeUndefined();
    });
  });

  describe("SimHub bindings (JSON string)", () => {
    it("should parse a SimHub binding JSON string", () => {
      const result = parseBinding('{"type":"simhub","role":"My Role"}');

      expect(result).toEqual({ type: "simhub", role: "My Role" });
      expect(isSimHubBinding(result!)).toBe(true);
    });

    it("should parse SimHub binding with special characters in role name", () => {
      const result = parseBinding('{"type":"simhub","role":"Black Box - Lap Timing"}');

      expect(result).toEqual({ type: "simhub", role: "Black Box - Lap Timing" });
    });

    it("should reject a SimHub binding with empty role", () => {
      expect(parseBinding('{"type":"simhub","role":""}')).toBeUndefined();
    });
  });

  describe("object input (already parsed)", () => {
    it("should handle an already-parsed keyboard binding object", () => {
      const result = parseBinding({ key: "f3", modifiers: ["shift"], code: "F3" });

      expect(result).toEqual({ type: "keyboard", key: "f3", modifiers: ["shift"], code: "F3" });
    });

    it("should handle an already-parsed SimHub binding object", () => {
      const result = parseBinding({ type: "simhub", role: "TestRole" });

      expect(result).toEqual({ type: "simhub", role: "TestRole" });
    });
  });

  describe("invalid input", () => {
    it("should return undefined for empty string", () => {
      expect(parseBinding("")).toBeUndefined();
    });

    it("should return undefined for null", () => {
      expect(parseBinding(null)).toBeUndefined();
    });

    it("should return undefined for undefined", () => {
      expect(parseBinding(undefined)).toBeUndefined();
    });

    it("should return undefined for invalid JSON", () => {
      expect(parseBinding("not json")).toBeUndefined();
    });

    it("should return undefined for object matching neither schema", () => {
      expect(parseBinding({ foo: "bar" })).toBeUndefined();
    });

    it("should return undefined for SimHub binding missing role", () => {
      expect(parseBinding('{"type":"simhub"}')).toBeUndefined();
    });

    it("should return undefined for keyboard binding missing key", () => {
      expect(parseBinding('{"modifiers":["ctrl"]}')).toBeUndefined();
    });
  });
});

describe("isSimHubBinding", () => {
  it("should return true for SimHub binding", () => {
    const binding: SimHubBindingValue = { type: "simhub", role: "Test" };

    expect(isSimHubBinding(binding)).toBe(true);
  });

  it("should return false for keyboard binding", () => {
    expect(isSimHubBinding({ type: "keyboard", key: "f1", modifiers: [] })).toBe(false);
  });

  it("should return false for undefined", () => {
    expect(isSimHubBinding(undefined)).toBe(false);
  });
});

describe("a default binding the plugin seeds (#1277)", () => {
  it("round-trips through the parser the dispatcher reads bindings with", () => {
    const stored = defaultBindingStoredValue("Shift+V");

    expect(parseBinding(stored)).toEqual({ type: "keyboard", key: "v", modifiers: ["shift"], code: "KeyV" });
    expect(parseKeyBinding(stored)).toEqual({ type: "keyboard", key: "v", modifiers: ["shift"], code: "KeyV" });
  });
});

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

    expect(result).toEqual({ type: "keyboard", key: "f1", modifiers: [] });
  });

  it("should parse JSON string with modifiers", () => {
    const json = JSON.stringify({ key: "r", modifiers: ["ctrl", "shift"] });
    const result = parseKeyBinding(json);

    expect(result).toEqual({ type: "keyboard", key: "r", modifiers: ["ctrl", "shift"] });
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

    expect(result).toEqual({ type: "keyboard", key: "f3", modifiers: ["alt"] });
  });

  it("should add default empty modifiers array if missing", () => {
    const obj = { key: "f5" };
    const result = parseKeyBinding(obj);

    expect(result).toEqual({ type: "keyboard", key: "f5", modifiers: [] });
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
