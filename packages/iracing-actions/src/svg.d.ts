/**
 * Type declaration for SVG file imports.
 * SVG files are imported as strings via the rollup svgPlugin.
 *
 * Duplicated from each plugin's own `src/svg.d.ts` rather than shared: an
 * ambient declaration is only visible inside the TypeScript program that
 * includes it, and this package's program is separate from the three plugin
 * programs (which reach these sources through import resolution, not through
 * this tsconfig). Verified: the plugins do NOT pick this file up, so the
 * declarations do not collide.
 */
declare module "*.svg" {
  const content: string;
  export default content;
}
