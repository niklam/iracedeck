/**
 * Binding-missing warning overlay.
 *
 * Drawn centered on a key icon when a mode requires a binding (keyboard or
 * SimHub) and neither is configured, so the problem is visible at a glance on
 * the deck without opening the Property Inspector (issue #612).
 *
 * Cross-platform constraint: the glyph must render on Mirabox's QT5 engine
 * (SVG Tiny 1.2 static). It uses only `polygon`, `rect` (with `rx`), and
 * `circle` — no filters, masks, clipPath, or CSS. See
 * `.claude/rules/svg-platform-compatibility.md`.
 */

/** Opacity applied to the existing artwork beneath the warning triangle. */
export const BINDING_WARNING_DIM_OPACITY = 0.25;

/** Warning triangle fill (matches the project's semantic yellow). */
const WARNING_FILL = "#f39c12";
/** Dark outline + exclamation colour for contrast over any artwork. */
const WARNING_INK = "#1a1a1a";

/**
 * Centered warning-triangle glyph (⚠) for the 144×144 icon canvas.
 *
 * A standalone SVG snippet — no wrapping `<svg>` — so it can be appended into
 * the icon base template's graphic slot (via {@link assembleIcon}'s
 * `bindingMissing` option) or composed by actions that render dynamic
 * templates directly (e.g. fuel-service's telemetry modes).
 */
export const BINDING_WARNING_GLYPH = [
  // Plain group, no class attribute — QT5 has no CSS/class-based styling and the
  // overlay must not rely on it (see svg-platform-compatibility rule).
  "<g>",
  // Triangle body, centered around (72, 72).
  `<polygon points="72,42 104,100 40,100" fill="${WARNING_FILL}" stroke="${WARNING_INK}" stroke-width="3" stroke-linejoin="round"/>`,
  // Exclamation bar.
  `<rect x="68.5" y="64" width="7" height="20" rx="2.5" fill="${WARNING_INK}"/>`,
  // Exclamation dot.
  `<circle cx="72" cy="92" r="4" fill="${WARNING_INK}"/>`,
  "</g>",
].join("");

/**
 * Return the centered binding-missing warning glyph snippet.
 *
 * Provided as a function (alongside the {@link BINDING_WARNING_GLYPH} constant)
 * so dynamic-template actions can compose the same overlay their static
 * counterparts get from {@link assembleIcon}.
 */
export function bindingWarningSvg(): string {
  return BINDING_WARNING_GLYPH;
}

/**
 * Wrap arbitrary icon content in a dim group, used to fade existing artwork
 * beneath the warning triangle so the triangle reads clearly while the mode's
 * artwork stays faintly identifiable.
 */
export function dimForBindingWarning(content: string): string {
  if (!content) return "";

  return `<g opacity="${BINDING_WARNING_DIM_OPACITY}">${content}</g>`;
}

/**
 * Compose the full binding-missing overlay over existing graphic content:
 * the content dimmed, with the warning triangle drawn on top.
 *
 * Shared by {@link assembleIcon} and dynamic-template actions so both produce
 * an identical overlay.
 */
export function applyBindingWarning(graphicContent: string): string {
  return dimForBindingWarning(graphicContent) + BINDING_WARNING_GLYPH;
}
