import { describe, expect, it } from "vitest";

import { applyInactiveOverlay, dataUriToSvg, isDataUri, isRawSvg, svgToDataUri } from "./overlay-utils.js";

describe("overlay-utils", () => {
  const simpleSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><circle cx="36" cy="36" r="30"/></svg>';
  const simpleSvgBase64 = Buffer.from(simpleSvg).toString("base64");
  const simpleDataUri = `data:image/svg+xml;base64,${simpleSvgBase64}`;

  describe("isDataUri", () => {
    it("should return true for data URIs", () => {
      expect(isDataUri(simpleDataUri)).toBe(true);
      expect(isDataUri("data:image/png;base64,abc")).toBe(true);
    });

    it("should return false for raw SVG", () => {
      expect(isDataUri(simpleSvg)).toBe(false);
      expect(isDataUri("<svg></svg>")).toBe(false);
    });

    it("should return false for other strings", () => {
      expect(isDataUri("hello world")).toBe(false);
      expect(isDataUri("")).toBe(false);
    });
  });

  describe("isRawSvg", () => {
    it("should return true for SVG strings starting with <svg", () => {
      expect(isRawSvg(simpleSvg)).toBe(true);
      expect(isRawSvg("<svg></svg>")).toBe(true);
      expect(isRawSvg("  <svg></svg>")).toBe(true);
    });

    it("should return true for SVG strings starting with <?xml", () => {
      expect(isRawSvg('<?xml version="1.0"?><svg></svg>')).toBe(true);
    });

    it("should return false for data URIs", () => {
      expect(isRawSvg(simpleDataUri)).toBe(false);
    });

    it("should return false for other strings", () => {
      expect(isRawSvg("hello world")).toBe(false);
      expect(isRawSvg("<div></div>")).toBe(false);
    });
  });

  describe("svgToDataUri", () => {
    it("should convert raw SVG to base64 data URI", () => {
      const result = svgToDataUri(simpleSvg);

      expect(result).toBe(simpleDataUri);
      expect(result.startsWith("data:image/svg+xml;base64,")).toBe(true);
    });

    it("should handle empty SVG", () => {
      const result = svgToDataUri("<svg></svg>");

      expect(isDataUri(result)).toBe(true);
    });
  });

  describe("dataUriToSvg", () => {
    it("should convert base64 data URI to raw SVG", () => {
      const result = dataUriToSvg(simpleDataUri);

      expect(result).toBe(simpleSvg);
    });

    it("should handle plain text data URI", () => {
      const plainUri = `data:image/svg+xml,${encodeURIComponent("<svg></svg>")}`;
      const result = dataUriToSvg(plainUri);

      expect(result).toBe("<svg></svg>");
    });

    it("should throw for invalid data URI format", () => {
      expect(() => dataUriToSvg("not-a-data-uri")).toThrow("Invalid SVG data URI format");
      expect(() => dataUriToSvg("data:image/png;base64,abc")).toThrow("Invalid SVG data URI format");
    });
  });

  describe("applyInactiveOverlay", () => {
    it("should add overlay rect to raw SVG", () => {
      const result = applyInactiveOverlay(simpleSvg);

      expect(result).toContain('<rect width="100%" height="100%" fill="rgba(128, 128, 128, 0.6)"/>');
      expect(result).toContain("</svg>");
      expect(result.endsWith("</svg>")).toBe(true);
    });

    it("should preserve SVG content when adding overlay", () => {
      const result = applyInactiveOverlay(simpleSvg);

      expect(result).toContain('<circle cx="36" cy="36" r="30"/>');
      expect(result).toContain('viewBox="0 0 72 72"');
    });

    it("should add overlay rect to data URI and return data URI", () => {
      const result = applyInactiveOverlay(simpleDataUri);

      expect(isDataUri(result)).toBe(true);

      // Decode and verify overlay was added
      const decoded = dataUriToSvg(result);

      expect(decoded).toContain('<rect width="100%" height="100%" fill="rgba(128, 128, 128, 0.6)"/>');
    });

    it("should return input unchanged for non-SVG strings", () => {
      expect(applyInactiveOverlay("hello world")).toBe("hello world");
      expect(applyInactiveOverlay("<div></div>")).toBe("<div></div>");
    });

    it("should handle SVG with whitespace after closing tag", () => {
      const svgWithWhitespace = '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n  ';
      const result = applyInactiveOverlay(svgWithWhitespace);

      expect(result).toContain("rect");
    });
  });

  describe("roundtrip conversion", () => {
    it("should preserve SVG through dataUri -> svg -> dataUri conversion", () => {
      const dataUri = svgToDataUri(simpleSvg);
      const svg = dataUriToSvg(dataUri);
      const dataUriAgain = svgToDataUri(svg);

      expect(dataUriAgain).toBe(dataUri);
    });
  });
});
