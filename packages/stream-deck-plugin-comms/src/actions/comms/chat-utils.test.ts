import { describe, expect, it } from "vitest";

import { DEFAULT_ICON_COLOR, formatChatTitle, generateChatSvg } from "./chat-utils.js";

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
});

describe("formatChatTitle", () => {
  describe("when disconnected", () => {
    it("should return disconnected message", () => {
      const result = formatChatTitle("Hello", false);

      expect(result).toBe("iRacing\nnot\nconnected");
    });

    it("should return disconnected message even with empty message", () => {
      const result = formatChatTitle("", false);

      expect(result).toBe("iRacing\nnot\nconnected");
    });

    it("should return disconnected message even with undefined message", () => {
      const result = formatChatTitle(undefined, false);

      expect(result).toBe("iRacing\nnot\nconnected");
    });
  });

  describe("when connected", () => {
    it("should return empty string for empty message", () => {
      const result = formatChatTitle("", true);

      expect(result).toBe("");
    });

    it("should return empty string for undefined message", () => {
      const result = formatChatTitle(undefined, true);

      expect(result).toBe("");
    });

    it("should return empty string for whitespace-only message", () => {
      const result = formatChatTitle("   ", true);

      expect(result).toBe("");
    });

    it("should return short message as-is", () => {
      const result = formatChatTitle("Hello!", true);

      expect(result).toBe("Hello!");
    });

    it("should return message at exactly 20 chars as-is", () => {
      const message = "12345678901234567890"; // 20 chars
      const result = formatChatTitle(message, true);

      expect(result).toBe(message);
    });

    it("should truncate message longer than 20 chars", () => {
      const message = "This is a very long chat message";
      const result = formatChatTitle(message, true);

      expect(result).toBe("This is a very lo...");
      expect(result.length).toBe(20);
    });

    it("should truncate to first 17 chars plus ellipsis", () => {
      const message = "123456789012345678901"; // 21 chars
      const result = formatChatTitle(message, true);

      expect(result).toBe("12345678901234567...");
    });

    it("should trim whitespace before processing", () => {
      const result = formatChatTitle("  Hello  ", true);

      expect(result).toBe("Hello");
    });
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
