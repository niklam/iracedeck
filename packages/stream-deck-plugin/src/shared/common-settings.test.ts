import { describe, expect, it } from "vitest";
import z from "zod";

import { CommonSettings } from "./common-settings.js";

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
});
