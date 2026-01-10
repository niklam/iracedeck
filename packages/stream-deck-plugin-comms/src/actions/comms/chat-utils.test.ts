import { describe, expect, it } from "vitest";

import { DEFAULT_ICON_COLOR, generateChatSvg } from "./chat-utils.js";

describe("generateChatSvg", () => {
  it("should return a data URI with base64 encoded SVG", () => {
    const result = generateChatSvg("#ff0000");

    expect(result).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("should include the color in the SVG", () => {
    const color = "#4a90d9";
    const result = generateChatSvg(color);

    // Decode the base64 to verify color is present
    const base64 = result.replace("data:image/svg+xml;base64,", "");
    const svg = Buffer.from(base64, "base64").toString("utf-8");

    expect(svg).toContain(`stroke="${color}"`);
  });

  it("should generate valid SVG structure", () => {
    const result = generateChatSvg("#000000");

    const base64 = result.replace("data:image/svg+xml;base64,", "");
    const svg = Buffer.from(base64, "base64").toString("utf-8");

    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).toContain("<path");
    expect(svg).toContain('viewBox="0 0 72 72"');
  });

  it("should work with different color formats", () => {
    // Hex color
    expect(() => generateChatSvg("#ff0000")).not.toThrow();

    // Named color
    expect(() => generateChatSvg("red")).not.toThrow();

    // RGB color
    expect(() => generateChatSvg("rgb(255, 0, 0)")).not.toThrow();
  });

  it("should include keyText when provided", () => {
    const result = generateChatSvg("#ff0000", "Hello");

    const base64 = result.replace("data:image/svg+xml;base64,", "");
    const svg = Buffer.from(base64, "base64").toString("utf-8");

    expect(svg).toContain("<text");
    expect(svg).toContain("Hello");
    expect(svg).toContain('fill="#ffffff"');
  });

  it("should handle multi-line text with Unix newlines", () => {
    const result = generateChatSvg("#ff0000", "Line1\nLine2");

    const base64 = result.replace("data:image/svg+xml;base64,", "");
    const svg = Buffer.from(base64, "base64").toString("utf-8");

    // Multiple lines create separate text elements
    expect(svg).toContain("Line1</text>");
    expect(svg).toContain("Line2</text>");
  });

  it("should handle multi-line text with Windows newlines", () => {
    const result = generateChatSvg("#ff0000", "Line1\r\nLine2");

    const base64 = result.replace("data:image/svg+xml;base64,", "");
    const svg = Buffer.from(base64, "base64").toString("utf-8");

    // Multiple lines create separate text elements
    expect(svg).toContain("Line1</text>");
    expect(svg).toContain("Line2</text>");
  });

  it("should escape XML special characters in keyText", () => {
    const result = generateChatSvg("#ff0000", "<script>&test</script>");

    const base64 = result.replace("data:image/svg+xml;base64,", "");
    const svg = Buffer.from(base64, "base64").toString("utf-8");

    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;test");
  });

  it("should not include text element when keyText is empty", () => {
    const result = generateChatSvg("#ff0000", "");

    const base64 = result.replace("data:image/svg+xml;base64,", "");
    const svg = Buffer.from(base64, "base64").toString("utf-8");

    expect(svg).not.toContain("<text");
  });

  it("should not include text element when keyText is whitespace only", () => {
    const result = generateChatSvg("#ff0000", "   ");

    const base64 = result.replace("data:image/svg+xml;base64,", "");
    const svg = Buffer.from(base64, "base64").toString("utf-8");

    expect(svg).not.toContain("<text");
  });
});

describe("DEFAULT_ICON_COLOR", () => {
  it("should be a valid hex color", () => {
    expect(DEFAULT_ICON_COLOR).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("should be the expected blue color", () => {
    expect(DEFAULT_ICON_COLOR).toBe("#4a90d9");
  });
});
