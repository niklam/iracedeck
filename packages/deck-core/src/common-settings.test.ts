import { describe, expect, it } from "vitest";
import z from "zod";

import { CommonSettings, WINDOW_FOCUS_OVERRIDES, WindowFocusOverrideSchema } from "./common-settings.js";

describe("CommonSettings", () => {
  it("should default flagsOverlay to undefined when omitted", () => {
    const result = CommonSettings.parse({});
    expect(result.flagsOverlay).toBeUndefined();
  });

  it("should accept boolean true", () => {
    const result = CommonSettings.parse({ flagsOverlay: true });
    expect(result.flagsOverlay).toBe(true);
  });

  it("should accept boolean false", () => {
    const result = CommonSettings.parse({ flagsOverlay: false });
    expect(result.flagsOverlay).toBe(false);
  });

  it("should transform string 'true' to boolean true", () => {
    const result = CommonSettings.parse({ flagsOverlay: "true" });
    expect(result.flagsOverlay).toBe(true);
  });

  it("should transform string 'false' to boolean false", () => {
    const result = CommonSettings.parse({ flagsOverlay: "false" });
    expect(result.flagsOverlay).toBe(false);
  });

  it("should be extendable with action-specific settings", () => {
    const ActionSettings = CommonSettings.extend({
      direction: z.enum(["next", "previous"]).default("next"),
    });

    const result = ActionSettings.parse({});
    expect(result.flagsOverlay).toBeUndefined();
    expect(result.direction).toBe("next");
  });

  it("should preserve flagsOverlay when extended schema is parsed", () => {
    const ActionSettings = CommonSettings.extend({
      direction: z.enum(["next", "previous"]).default("next"),
    });

    const result = ActionSettings.parse({ flagsOverlay: true, direction: "previous" });
    expect(result.flagsOverlay).toBe(true);
    expect(result.direction).toBe("previous");
  });

  describe("windowFocus (#1654)", () => {
    it("defaults to global when omitted, so a key saved before the setting keeps the global mode", () => {
      expect(CommonSettings.parse({}).windowFocus).toBe("global");
    });

    it.each(WINDOW_FOCUS_OVERRIDES)("keeps the stored value %s", (value) => {
      expect(CommonSettings.parse({ windowFocus: value }).windowFocus).toBe(value);
    });

    it.each([
      ["a value from a newer build", "when-required"],
      ["junk text", "banana"],
      ["a differently cased value", "NO-FOCUS"],
      ["an empty string", ""],
      ["a number", 3],
      ["a boolean", true],
      ["null", null],
      ["an object", { mode: "focus" }],
    ])("reads %s as global", (_label, value) => {
      expect(CommonSettings.parse({ windowFocus: value }).windowFocus).toBe("global");
    });

    it("never resets the key's other settings when the value is unreadable", () => {
      const ActionSettings = CommonSettings.extend({
        direction: z.enum(["next", "previous"]).default("next"),
      });

      const result = ActionSettings.safeParse({
        addedWithVersion: "3.9.0",
        windowFocus: "a-future-value",
        flagsOverlay: true,
        colorOverrides: { backgroundColor: "#1a1a3e" },
        titleOverrides: { titleText: "PIT" },
        direction: "previous",
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        addedWithVersion: "3.9.0",
        windowFocus: "global",
        flagsOverlay: true,
        colorOverrides: { backgroundColor: "#1a1a3e" },
        titleOverrides: { titleText: "PIT" },
        direction: "previous",
      });
    });

    it("keeps the value through an extended action schema", () => {
      const ActionSettings = CommonSettings.extend({
        direction: z.enum(["next", "previous"]).default("next"),
      });

      expect(ActionSettings.parse({ windowFocus: "no-focus" }).windowFocus).toBe("no-focus");
    });

    it("parses on its own through WindowFocusOverrideSchema, which never throws", () => {
      expect(WindowFocusOverrideSchema.parse(undefined)).toBe("global");
      expect(WindowFocusOverrideSchema.parse("focus")).toBe("focus");
      expect(() => WindowFocusOverrideSchema.parse(Symbol("junk"))).not.toThrow();
    });
  });

  describe("colorOverrides", () => {
    it("should default colorOverrides to undefined when omitted", () => {
      const result = CommonSettings.parse({});
      expect(result.colorOverrides).toBeUndefined();
    });

    it("should accept color overrides with all fields", () => {
      const result = CommonSettings.parse({
        colorOverrides: {
          backgroundColor: "#1a1a3e",
          textColor: "#d0d8ff",
          graphic1Color: "#5b9bd5",
          graphic2Color: "#888888",
        },
      });

      expect(result.colorOverrides).toEqual({
        backgroundColor: "#1a1a3e",
        textColor: "#d0d8ff",
        graphic1Color: "#5b9bd5",
        graphic2Color: "#888888",
      });
    });

    it("should accept partial color overrides", () => {
      const result = CommonSettings.parse({
        colorOverrides: { backgroundColor: "#1a1a3e" },
      });

      expect(result.colorOverrides?.backgroundColor).toBe("#1a1a3e");
      expect(result.colorOverrides?.textColor).toBeUndefined();
    });

    it("should preserve colorOverrides in extended schemas", () => {
      const ActionSettings = CommonSettings.extend({
        direction: z.enum(["next", "previous"]).default("next"),
      });

      const result = ActionSettings.parse({
        colorOverrides: { backgroundColor: "#ff0000" },
        direction: "previous",
      });

      expect(result.colorOverrides?.backgroundColor).toBe("#ff0000");
      expect(result.direction).toBe("previous");
    });
  });
});
