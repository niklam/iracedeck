import { describe, expect, it } from "vitest";

import { resolvePathValue, resolveTemplate } from "./template-resolver.js";

describe("resolveTemplate", () => {
  it("should replace a simple flat variable", () => {
    expect(resolveTemplate("Hello {{name}}", { name: "World" })).toBe("Hello World");
  });

  it("should replace dot-notation variables", () => {
    const context = { self: { first_name: "John", position: "3" } };

    expect(resolveTemplate("P{{self.position}} - {{self.first_name}}", context)).toBe("P3 - John");
  });

  it("should replace the same variable used multiple times", () => {
    expect(resolveTemplate("{{x}} and {{x}}", { x: "ok" })).toBe("ok and ok");
  });

  it("should replace multiple different variables", () => {
    const context = { a: "1", b: "2", c: "3" };

    expect(resolveTemplate("{{a}}-{{b}}-{{c}}", context)).toBe("1-2-3");
  });

  it("should replace missing variables with empty string", () => {
    expect(resolveTemplate("Hello {{missing}}", {})).toBe("Hello ");
  });

  it("should replace partially resolved paths with empty string", () => {
    const context = { self: { name: "John" } };

    expect(resolveTemplate("{{self.nonexistent}}", context)).toBe("");
  });

  it("should replace deeply nested missing path with empty string", () => {
    const context = { a: { b: "value" } };

    expect(resolveTemplate("{{a.b.c.d}}", context)).toBe("");
  });

  it("should return template unchanged when no placeholders present", () => {
    expect(resolveTemplate("plain text", { foo: "bar" })).toBe("plain text");
  });

  it("should handle empty template", () => {
    expect(resolveTemplate("", { foo: "bar" })).toBe("");
  });

  it("should handle template with only a variable", () => {
    expect(resolveTemplate("{{name}}", { name: "John" })).toBe("John");
  });

  it("should convert numbers to strings", () => {
    expect(resolveTemplate("P{{pos}}", { pos: 5 })).toBe("P5");
  });

  it("should replace null values with empty string", () => {
    expect(resolveTemplate("{{val}}", { val: null })).toBe("");
  });

  it("should replace undefined values with empty string", () => {
    expect(resolveTemplate("{{val}}", { val: undefined })).toBe("");
  });

  it("should not match malformed placeholders", () => {
    expect(resolveTemplate("{{missing}", {})).toBe("{{missing}");
    expect(resolveTemplate("{missing}}", {})).toBe("{missing}}");
    expect(resolveTemplate("{{ spaced }}", {})).toBe("{{ spaced }}");
  });

  it("should support underscores in variable names", () => {
    const context = { self: { first_name: "John" } };

    expect(resolveTemplate("{{self.first_name}}", context)).toBe("John");
  });
});

describe("resolvePathValue", () => {
  it("should resolve a flat key", () => {
    expect(resolvePathValue({ name: "John" }, "name")).toBe("John");
  });

  it("should resolve a nested path", () => {
    expect(resolvePathValue({ a: { b: { c: "deep" } } }, "a.b.c")).toBe("deep");
  });

  it("should return undefined for missing key", () => {
    expect(resolvePathValue({}, "missing")).toBeUndefined();
  });

  it("should return undefined when path traverses a non-object", () => {
    expect(resolvePathValue({ a: "string" }, "a.b")).toBeUndefined();
  });

  it("should return undefined when path traverses null", () => {
    expect(resolvePathValue({ a: null }, "a.b")).toBeUndefined();
  });
});
