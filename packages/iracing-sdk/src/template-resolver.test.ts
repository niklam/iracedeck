import { describe, expect, it } from "vitest";

import type { TemplateContext, TemplateValue } from "./template-context.js";
import { resolveTemplate } from "./template-resolver.js";

/** Builds a combined context from a display map (raw defaults to empty). */
function ctx(display: Record<string, unknown>, raw: Record<string, TemplateValue> = {}): TemplateContext {
  return { display: display as Record<string, string>, raw };
}

describe("resolveTemplate", () => {
  it("should replace a simple flat variable", () => {
    expect(resolveTemplate("Hello {{name}}", ctx({ name: "World" }))).toBe("Hello World");
  });

  it("should replace dot-notation variables via flat key lookup", () => {
    const context = ctx({ "self.first_name": "John", "self.position": "3" });

    expect(resolveTemplate("P{{self.position}} - {{self.first_name}}", context)).toBe("P3 - John");
  });

  it("should replace the same variable used multiple times", () => {
    expect(resolveTemplate("{{x}} and {{x}}", ctx({ x: "ok" }))).toBe("ok and ok");
  });

  it("should replace multiple different variables", () => {
    const context = ctx({ a: "1", b: "2", c: "3" });

    expect(resolveTemplate("{{a}}-{{b}}-{{c}}", context)).toBe("1-2-3");
  });

  it("should replace missing variables with empty string", () => {
    expect(resolveTemplate("Hello {{missing}}", ctx({}))).toBe("Hello ");
  });

  it("should replace missing dot-notation key with empty string", () => {
    const context = ctx({ "self.name": "John" });

    expect(resolveTemplate("{{self.nonexistent}}", context)).toBe("");
  });

  it("should replace deeply nested dot-notation key with empty string when missing", () => {
    const context = ctx({ "a.b": "value" });

    expect(resolveTemplate("{{a.b.c.d}}", context)).toBe("");
  });

  it("should resolve deeply nested dot-notation keys", () => {
    const context = ctx({ "sessionInfo.CarSetup.TiresAero.TireType.TireType": "Dry" });

    expect(resolveTemplate("{{sessionInfo.CarSetup.TiresAero.TireType.TireType}}", context)).toBe("Dry");
  });

  it("should return template unchanged when no placeholders present", () => {
    expect(resolveTemplate("plain text", ctx({ foo: "bar" }))).toBe("plain text");
  });

  it("should handle empty template", () => {
    expect(resolveTemplate("", ctx({ foo: "bar" }))).toBe("");
  });

  it("should handle template with only a variable", () => {
    expect(resolveTemplate("{{name}}", ctx({ name: "John" }))).toBe("John");
  });

  it("should convert numbers to strings", () => {
    expect(resolveTemplate("P{{pos}}", ctx({ pos: 5 }))).toBe("P5");
  });

  it("should replace null values with empty string", () => {
    expect(resolveTemplate("{{val}}", ctx({ val: null }))).toBe("");
  });

  it("should replace undefined values with empty string", () => {
    expect(resolveTemplate("{{val}}", ctx({ val: undefined }))).toBe("");
  });

  it("should not match malformed placeholders", () => {
    expect(resolveTemplate("{{missing}", ctx({}))).toBe("{{missing}");
    expect(resolveTemplate("{missing}}", ctx({}))).toBe("{missing}}");
    expect(resolveTemplate("{{ spaced }}", ctx({}))).toBe("{{ spaced }}");
  });

  it("should support underscores in variable names", () => {
    const context = ctx({ "self.first_name": "John" });

    expect(resolveTemplate("{{self.first_name}}", context)).toBe("John");
  });
});

describe("resolveTemplate expression integration", () => {
  it("should resolve mixed variable and expression placeholders", () => {
    const context = ctx({ "self.first_name": "John" }, { "telemetry.Speed": 43.5 });

    expect(resolveTemplate("{{self.first_name}}: {{= round(telemetry.Speed * 3.6, 0) }}", context)).toBe("John: 157");
  });

  it("should resolve expressions without spaces around the delimiters", () => {
    expect(resolveTemplate("{{=1+2}}", ctx({}))).toBe("3");
  });

  it("should resolve expressions with spaces around the delimiters", () => {
    expect(resolveTemplate("{{= 1 + 2 }}", ctx({}))).toBe("3");
  });

  it("should resolve multiline templates with expressions and variables on different lines", () => {
    const context = ctx({ "self.name": "John Smith" }, { "telemetry.Speed": 50.4 });

    const result = resolveTemplate("Speed: {{= round(telemetry.Speed, 0) }}\nDriver: {{self.name}}", context);

    expect(result).toBe("Speed: 50\nDriver: John Smith");
  });

  it("should resolve multiple expressions in one template", () => {
    expect(resolveTemplate("{{= 1 + 1 }}|{{= 2 * 3 }}", ctx({}))).toBe("2|6");
  });

  it("should leave a parse-error placeholder verbatim while other placeholders resolve", () => {
    const context = ctx({ name: "John" }, { x: 2 });

    expect(resolveTemplate("{{= 1 + }} {{name}} {{= x * 2 }}", context)).toBe("{{= 1 + }} John 4");
  });

  it("should render empty string for a runtime error (unknown variable) in that placeholder only", () => {
    const context = ctx({ name: "John" });

    expect(resolveTemplate("[{{= missing.var + 1 }}] {{name}}", context)).toBe("[] John");
  });

  it("should still render plain spaced placeholders literally", () => {
    expect(resolveTemplate("{{ spaced }}", ctx({ spaced: "value" }))).toBe("{{ spaced }}");
  });

  it("should resolve expressions with string literals", () => {
    const context = ctx({}, { "telemetry.OnPitRoad": 1 });

    expect(resolveTemplate("{{= telemetry.OnPitRoad == 1 ? 'PIT' : '' }}", context)).toBe("PIT");
  });

  it("should leave an unclosed expression marker verbatim", () => {
    expect(resolveTemplate("{{= 1 + 2", ctx({}))).toBe("{{= 1 + 2");
  });

  it("should leave over-limit expressions verbatim", () => {
    const longExpr = "1".repeat(1001);

    expect(resolveTemplate(`{{= ${longExpr} }}`, ctx({}))).toBe(`{{= ${longExpr} }}`);
  });

  it("should end the expression at the first }}, even inside a string literal", () => {
    expect(resolveTemplate("{{= 'a }} b' }}", ctx({}))).toBe("{{= 'a }} b' }}");
  });
});
