import { describe, expect, it } from "vitest";

import { generateBorderParts } from "./icon-base.js";
import type { ResolvedBorderSettings } from "./title-settings.js";

const DEFAULTS: ResolvedBorderSettings = {
  enabled: false,
  borderWidth: 7,
  borderColor: "#00aaff",
  glowEnabled: true,
  glowWidth: 18,
};

describe("generateBorderParts", () => {
  it("should return empty parts when disabled", () => {
    const result = generateBorderParts(DEFAULTS);
    expect(result.defs).toBe("");
    expect(result.rects).toBe("");
  });

  it("should return border rect without glow when glow is disabled", () => {
    const result = generateBorderParts({ ...DEFAULTS, enabled: true, glowEnabled: false });
    expect(result.defs).toBe("");
    expect(result.rects).toContain('stroke="#00aaff"');
    expect(result.rects).toContain('stroke-width="7"');
    expect(result.rects).toContain('x="3.5"');
    expect(result.rects).toContain('y="3.5"');
    expect(result.rects).toContain('width="137"');
    expect(result.rects).toContain('height="137"');
    expect(result.rects).toContain('rx="20.5"');
    expect(result.rects).not.toContain("ird-border-glow");
  });

  it("should return defs and rects with glow when glow is enabled", () => {
    const result = generateBorderParts({ ...DEFAULTS, enabled: true });
    expect(result.defs).toContain("<defs>");
    expect(result.defs).toContain("ird-border-glow");
    // Glow rect: glowInset = borderWidth = 7
    expect(result.rects).toContain('stroke-width="18"');
    expect(result.rects).toContain('opacity="0.4"');
    expect(result.rects).toContain('x="7"');
    expect(result.rects).toContain('width="130"');
    expect(result.rects).toContain('rx="17"');
    // Border rect
    expect(result.rects).toContain('stroke-width="7"');
  });

  it("should clamp glow width at 30", () => {
    const result = generateBorderParts({ ...DEFAULTS, enabled: true, glowWidth: 80 });
    expect(result.rects).toContain('stroke-width="30"');
    expect(result.rects).not.toContain('stroke-width="80"');
  });

  it("should use specified border color", () => {
    const result = generateBorderParts({ ...DEFAULTS, enabled: true, borderColor: "#e74c3c" });
    expect(result.rects).toContain('stroke="#e74c3c"');
  });

  it("should use specified border width", () => {
    const result = generateBorderParts({ ...DEFAULTS, enabled: true, borderWidth: 8, glowEnabled: false });
    expect(result.rects).toContain('stroke-width="8"');
    expect(result.rects).toContain('x="4"');
    expect(result.rects).toContain('width="136"');
    expect(result.rects).toContain('rx="20"');
  });

  it("should handle minimum border width", () => {
    const result = generateBorderParts({ ...DEFAULTS, enabled: true, borderWidth: 1, glowEnabled: false });
    expect(result.rects).toContain('stroke-width="1"');
    expect(result.rects).toContain('x="0.5"');
    expect(result.rects).toContain('width="143"');
    expect(result.rects).toContain('rx="23.5"');
  });

  it("should reduce rx proportionally to inset", () => {
    const result = generateBorderParts({ ...DEFAULTS, enabled: true, borderWidth: 20, glowWidth: 18 });
    // borderRx = max(0, 24 - 10) = 14; glowInset = 20, glowRx = max(0, 24 - 20) = 4
    expect(result.rects).toContain('rx="14"');
    expect(result.rects).toContain('x="20"');
    expect(result.rects).toContain('width="104"');
    expect(result.rects).toContain('rx="4"');
  });
});
