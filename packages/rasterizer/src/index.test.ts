import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createSvgRasterizer } from "./index.js";

const fontsDir = fileURLToPath(new URL("../fonts", import.meta.url));

// Matches the assembled-icon shape: bg + glow filter + artwork + Arial-bold text.
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <defs><filter id="glow"><feGaussianBlur in="SourceGraphic" stdDeviation="6"/></filter></defs>
  <rect width="144" height="144" fill="#1a2733"/>
  <rect x="6" y="6" width="132" height="132" rx="12" fill="none" stroke="#00aaff" stroke-width="7" filter="url(#glow)"/>
  <text x="72" y="120" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="18" font-weight="bold">FUEL</text>
</svg>`;

const NO_TEXT_SVG = ICON_SVG.replace(/<text[\s\S]*?<\/text>/, "");

describe("createSvgRasterizer", () => {
  it("renders SVG to a PNG buffer at the requested width", async () => {
    const rasterize = createSvgRasterizer({ fontsDir });
    const png = await rasterize(ICON_SVG, 144);
    // PNG magic bytes
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR width at byte offset 16 (big-endian u32)
    expect(png.readUInt32BE(16)).toBe(144);
    expect(png.readUInt32BE(20)).toBe(144);
  });

  it("scales output to a larger target width", async () => {
    const rasterize = createSvgRasterizer({ fontsDir });
    const png = await rasterize(ICON_SVG, 240);
    expect(png.readUInt32BE(16)).toBe(240);
    expect(png.readUInt32BE(20)).toBe(240);
  });

  it("renders Arial-family text via the bundled Arimo fallback (text changes the output)", async () => {
    const rasterize = createSvgRasterizer({ fontsDir });
    const withText = await rasterize(ICON_SVG, 144);
    const withoutText = await rasterize(NO_TEXT_SVG, 144);
    expect(withText.equals(withoutText)).toBe(false);
  });

  it("throws when the fonts directory is missing", () => {
    const missingFontsDir = fileURLToPath(new URL("../fonts-does-not-exist", import.meta.url));
    expect(() => createSvgRasterizer({ fontsDir: missingFontsDir })).toThrow(/fonts directory not found/i);
  });
});
