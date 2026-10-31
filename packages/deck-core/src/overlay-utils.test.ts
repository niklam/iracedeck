import { dataUriToSvg, isDataUri } from "@iracedeck/icon-composer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyInactiveOverlay, hexToGrayscale, overlayConfig } from "./overlay-utils.js";

describe("overlay-utils", () => {
  const simpleSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><circle cx="36" cy="36" r="30" fill="#ff0000"/></svg>';
  const simpleSvgBase64 = Buffer.from(simpleSvg).toString("base64");
  const simpleDataUri = `data:image/svg+xml;base64,${simpleSvgBase64}`;

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
});
