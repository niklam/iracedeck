import {
  applyInactiveOverlay,
  dataUriToSvg,
  hexToGrayscale,
  isDataUri,
  isRawSvg,
  overlayConfig,
  svgToDataUri,
} from "@iracedeck/deck-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("overlay-utils", () => {
  const simpleSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><circle cx="36" cy="36" r="30" fill="#ff0000"/></svg>';
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

  describe("hexToGrayscale", () => {
    it("should convert red to grayscale", () => {
      // Red (255, 0, 0) -> 0.299 * 255 = 76.245 -> #4c4c4c
      expect(hexToGrayscale("#ff0000")).toBe("#4c4c4c");
    });

    it("should convert green to grayscale", () => {
      // Green (0, 255, 0) -> 0.587 * 255 = 149.685 -> #969696
      expect(hexToGrayscale("#00ff00")).toBe("#969696");
    });

    it("should convert blue to grayscale", () => {
      // Blue (0, 0, 255) -> 0.114 * 255 = 29.07 -> #1d1d1d
      expect(hexToGrayscale("#0000ff")).toBe("#1d1d1d");
    });

    it("should convert white to white", () => {
      expect(hexToGrayscale("#ffffff")).toBe("#ffffff");
    });

    it("should convert black to black", () => {
      expect(hexToGrayscale("#000000")).toBe("#000000");
    });

    it("should handle short hex format", () => {
      // #f00 = #ff0000 -> #4c4c4c
      expect(hexToGrayscale("#f00")).toBe("#4c4c4c");
    });

    it("should handle hex without #", () => {
      expect(hexToGrayscale("ff0000")).toBe("#4c4c4c");
    });

    it("should return invalid formats unchanged", () => {
      expect(hexToGrayscale("#gg0000")).toBe("#gg0000");
      expect(hexToGrayscale("red")).toBe("red");
    });
  });

  describe("applyInactiveOverlay", () => {
    beforeEach(() => {
      overlayConfig.inactiveOverlayEnabled = true;
    });

    afterEach(() => {
      overlayConfig.inactiveOverlayEnabled = false;
    });

    it("should add grayscale filter to raw SVG", () => {
      const result = applyInactiveOverlay(simpleSvg);

      // Should add filter definition
      expect(result).toContain('<filter id="activity-state">');
      expect(result).toContain("feColorMatrix");
    });

    it("should preserve SVG structure when applying filter", () => {
      const result = applyInactiveOverlay(simpleSvg);

      expect(result).toContain('<circle cx="36" cy="36" r="30"');
      expect(result).toContain('viewBox="0 0 72 72"');
      // Original colors should be preserved (filter is applied at render time)
      expect(result).toContain('fill="#ff0000"');
    });

    it("should add filter in data URI and return data URI", () => {
      const result = applyInactiveOverlay(simpleDataUri);

      expect(isDataUri(result)).toBe(true);

      // Decode and verify filter was added
      const decoded = dataUriToSvg(result);

      expect(decoded).toContain('<filter id="activity-state">');
    });

    it("should preserve all colors (filter applied at render)", () => {
      const multiColorSvg = '<svg><rect fill="#ff0000"/><circle stroke="#00ff00"/><path fill="#0000ff"/></svg>';
      const result = applyInactiveOverlay(multiColorSvg);

      // Filter is added, but colors are preserved in the SVG markup
      expect(result).toContain('fill="#ff0000"');
      expect(result).toContain('stroke="#00ff00"');
      expect(result).toContain('fill="#0000ff"');
      expect(result).toContain("activity-state");
    });

    it("should return input unchanged for non-SVG strings", () => {
      expect(applyInactiveOverlay("hello world")).toBe("hello world");
      expect(applyInactiveOverlay("<div></div>")).toBe("<div></div>");
    });

    it("should add filter to SVG with no colors", () => {
      const noColorSvg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
      const result = applyInactiveOverlay(noColorSvg);

      expect(result).toContain("activity-state");
    });

    it("should add filter regardless of color format", () => {
      const shortHexSvg = '<svg><rect fill="#f00"/></svg>';
      const result = applyInactiveOverlay(shortHexSvg);

      expect(result).toContain("activity-state");
      // Original color preserved
      expect(result).toContain('fill="#f00"');
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
