/**
 * SVG → PNG rasterizer for device-bound deck images.
 *
 * Wraps @resvg/resvg-js and owns the bundled Arimo fonts (fonts/ in this
 * package; copied into each plugin's assets/fonts at build time). Icons ask
 * for "Arial, sans-serif" — Arimo is metric-compatible with Arial and is
 * served through the sans-serif generic fallback, so no icon SVG changes.
 */
import { renderAsync } from "@resvg/resvg-js";
import { existsSync } from "node:fs";

export type SvgRasterizer = (svg: string, widthPx: number) => Promise<Buffer>;

export interface SvgRasterizerOptions {
  /** Directory containing the bundled Arimo font files. */
  fontsDir: string;
}

export function createSvgRasterizer(options: SvgRasterizerOptions): SvgRasterizer {
  const { fontsDir } = options;

  // With loadSystemFonts: false, resvg renders text-less WITHOUT erroring if
  // fontsDir is missing — silently stripping every icon title with nothing
  // in the logs. Fail loud instead, before the first render ever happens.
  if (!existsSync(fontsDir)) {
    throw new Error(
      `Rasterizer fonts directory not found: ${fontsDir} — icons would render without text. ` +
        `Ensure the plugin bundle contains assets/fonts.`,
    );
  }

  return async (svg: string, widthPx: number): Promise<Buffer> => {
    const rendered = await renderAsync(svg, {
      fitTo: { mode: "width", value: widthPx },
      font: {
        // Never loadSystemFonts: true — it rescans the system font dir on
        // EVERY render (~130 ms). fontFiles is silently broken; use fontDirs.
        loadSystemFonts: false,
        fontDirs: [fontsDir],
        defaultFontFamily: "Arimo",
        sansSerifFamily: "Arimo",
      },
    });

    return rendered.asPng();
  };
}
