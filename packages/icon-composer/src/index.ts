/**
 * @iracedeck/icon-composer
 *
 * Standalone SVG icon assembly and composition for Stream Deck plugins.
 * Pure functions with no external dependencies.
 */

// SVG utilities
export { dataUriToSvg, isDataUri, isRawSvg, svgToDataUri } from "./svg-utils.js";

// Icon base template and border parts
export { extractGraphicContent, generateBorderParts, ICON_BASE_TEMPLATE } from "./icon-base.js";

// Icon template rendering and metadata parsing
export {
  escapeXml,
  generateIconText,
  parseDescMetadata,
  parseIconBorderDefaults,
  parseIconDefaults,
  parseIconLocked,
  parseIconTitleDefaults,
  parseSvgViewBox,
  renderIconTemplate,
  resolveIconColors,
  validateIconTemplate,
  type ColorSlots,
  type GenerateIconTextOptions,
  type IconBorderDefaults,
  type IconTitleDefaults,
  type SvgViewBox,
} from "./icon-template.js";

// Title, border, graphic settings and icon assembly
export {
  applyGraphicTransform,
  assembleIcon,
  BORDER_DEFAULTS,
  calculateYPositions,
  computeGraphicArea,
  generateTitleText,
  GRAPHIC_DEFAULTS,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveTitleSettings,
  TITLE_DEFAULTS,
  type BorderOverrides,
  type GenerateTitleTextOptions,
  type GlobalBorderSettings,
  type GlobalGraphicSettings,
  type GraphicArea,
  type GraphicOverrides,
  type ResolvedBorderSettings,
  type ResolvedGraphicSettings,
  type ResolvedTitleSettings,
  type GlobalTitleSettings,
  type TitleOverrides,
} from "./title-settings.js";
