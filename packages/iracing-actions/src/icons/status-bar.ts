import {
  applyBindingWarning,
  type BorderOverrides,
  type ColorSlots,
  generateBorderParts,
  generateTitleText,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalTitleSettings,
  renderIconTemplate,
  resolveBorderSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
  type TitleOverrides,
} from "@iracedeck/deck-core";

const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const RED = "#e74c3c";
const GRAY = "#888888";

/**
 * Tri-state toggle indication shared by the status bars, state-driven key
 * borders, and the Fuel Service dial's bar styling: on (green) / off (red) / na (gray).
 */
export type ToggleState = "on" | "off" | "na";

/**
 * @internal Exported for testing
 *
 * Status bar showing ON state — full-width green bar with "ON" text at the bottom.
 */
export function statusBarOn(): string {
  return `
    <rect x="0" y="100" width="144" height="44" fill="${GREEN}"/>
    <text x="72" y="129" text-anchor="middle"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="20" font-weight="bold">ON</text>`;
}

/**
 * @internal Exported for testing
 *
 * Status bar showing OFF state — full-width red bar with "OFF" text at the bottom.
 */
export function statusBarOff(): string {
  return `
    <rect x="0" y="100" width="144" height="44" fill="${RED}"/>
    <text x="72" y="129" text-anchor="middle"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="20" font-weight="bold">OFF</text>`;
}

/**
 * @internal Exported for testing
 *
 * Status bar showing N/A state — full-width gray bar with "N/A" text at the bottom.
 */
export function statusBarNA(): string {
  return `
    <rect x="0" y="100" width="144" height="44" fill="${GRAY}"/>
    <text x="72" y="129" text-anchor="middle"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="20" font-weight="bold">N/A</text>`;
}

/**
 * @internal Exported for testing
 *
 * Maps a toggle state to the corresponding status bar color for border indicators.
 */
export function borderColorForState(state: ToggleState): string {
  switch (state) {
    case "on":
      return GREEN;
    case "off":
      return RED;
    case "na":
      return GRAY;
  }
}

const STATUS_BARS: Record<ToggleState, () => string> = { on: statusBarOn, off: statusBarOff, na: statusBarNA };

/**
 * Maps a dc* toggle level to the tri-state shown on a toggle key: no telemetry
 * (or a non-finite value like NaN) -> N/A; level > 0 -> on; otherwise off.
 * Shared by ABS Toggle (dcABS) and TC Toggle (dcTractionControl), whose toggle
 * bindings flip the level between off and the configured value.
 */
export function toggleStateFromLevel(value: unknown): ToggleState {
  if (typeof value !== "number" || !Number.isFinite(value)) return "na";

  return value > 0 ? "on" : "off";
}

/**
 * Telemetry-memo key for a tri-state toggle key: a tick only re-renders the
 * key when the derived state flips. Both toggle actions derive their memo
 * through this helper so the memo shape can't drift between them.
 */
export function toggleStateMemoKey(setting: string, state: ToggleState): string {
  return `${setting}|${state}`;
}

/** Inputs for {@link generateToggleStateSvg} — the CommonSettings override fields plus the per-action template. */
export interface ToggleStateRenderInputs {
  /** The action's dedicated 144x144 tri-state chrome template (background, border, title, `{{iconContent}}` slot). */
  readonly template: string;
  /**
   * Optional artwork snippet composed into `{{iconContent}}` above the status
   * bar (e.g. the ISO ABS symbol). May use color placeholders — it is rendered
   * with the icon's resolved colors. Keep artwork here rather than baked into
   * the template so the binding-missing warning dims it too (the DRS pattern);
   * a toggle whose identity is its locked title (TC) passes none.
   */
  readonly artwork?: string;
  readonly state: ToggleState;
  readonly colorOverrides?: ColorSlots;
  readonly titleOverrides?: TitleOverrides;
  readonly borderOverrides?: BorderOverrides;
  readonly bindingMissing?: boolean;
}

/**
 * Renders a telemetry-aware tri-state toggle key (the DRS pattern, #827): the
 * template's artwork above a full-width ON/OFF/N-A status bar, with the key
 * border tracking the same state color. Shared by ABS Toggle and TC Toggle so
 * the render path stays identical for every tri-state toggle.
 */
export function generateToggleStateSvg(inputs: ToggleStateRenderInputs): string {
  const { template, state, bindingMissing } = inputs;

  const colors = resolveIconColors(template, getGlobalColors(), inputs.colorOverrides) as Record<string, string>;
  const resolvedTitle = resolveTitleSettings(template, getGlobalTitleSettings(), inputs.titleOverrides);

  const titleContent = resolvedTitle.showTitle
    ? generateTitleText({
        text: resolvedTitle.titleText,
        fontSize: resolvedTitle.fontSize,
        bold: resolvedTitle.bold,
        position: resolvedTitle.position,
        customPosition: resolvedTitle.customPosition,
        fill: colors.textColor ?? "#ffffff",
      })
    : "";

  const border = resolveBorderSettings(
    template,
    getGlobalBorderSettings(),
    inputs.borderOverrides,
    borderColorForState(state),
  );
  const borderSvg = generateBorderParts(border);

  const artworkContent = inputs.artwork ? renderIconTemplate(inputs.artwork, colors) : "";
  const baseIconContent = artworkContent + STATUS_BARS[state]();
  const iconContent = bindingMissing ? applyBindingWarning(baseIconContent) : baseIconContent;

  const svg = renderIconTemplate(template, {
    iconContent,
    titleContent,
    borderDefs: borderSvg.defs,
    borderContent: borderSvg.rects,
    ...colors,
  });

  return svgToDataUri(svg);
}
