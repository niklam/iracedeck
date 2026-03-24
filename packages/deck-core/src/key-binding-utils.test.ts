import { describe, expect, it } from "vitest";

import { isSimHubBinding, type SimHubBindingValue } from "./global-settings.js";
import { parseBinding } from "./key-binding-utils.js";

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
