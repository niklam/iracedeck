/**
 * Type declaration for SVG file imports.
 * SVG files are imported as strings via the rollup svgPlugin.
 */
declare module "*.svg" {
  const content: string;
  export default content;
}
