/**
 * Shared registry, formatters, and render helper for setup-action "View …" sub-modes (issue #541).
 *
 * Each setup action exposes a read-only View entry per driver-control telemetry value
 * (e.g. `view-brake-bias` → `dcBrakeBias`). The action's render path looks up the View
 * definition here to find the telemetry field, the on-icon label, and the value
 * formatter. `generateSetupViewSvg` builds the SVG data URI so each setup action's
 * dispatch is a one-liner; centralising the mapping and the render path keeps the
 * per-action wiring small and makes it cheap to add new View entries when iRacing
 * exposes more dc* fields.
 */
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
  type ResolvedTitleSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
  type TitleOverrides,
} from "@iracedeck/deck-core";
import { DisplayUnits, type TelemetryData } from "@iracedeck/iracing-sdk";

import setupViewTemplate from "../../icons/setup-view.svg";

/** Identifier shared between the Setting dropdown values, the icon route, and the VIEW_DEFS keys. */
export type ViewSettingId =
  // setup-brakes
  | "view-brake-bias"
  | "view-brake-bias-fine"
  | "view-peak-brake-bias"
  | "view-brake-misc"
  | "view-engine-braking"
  | "view-abs-adjust"
  // setup-traction (per-slot)
  | "view-tc-slot-1"
  | "view-tc-slot-2"
  | "view-tc-slot-3"
  | "view-tc-slot-4"
  // setup-fuel
  | "view-fuel-mixture"
  | "view-fuel-cut-position"
  // setup-engine
  | "view-engine-power"
  | "view-throttle-shape"
  | "view-launch-rpm"
  // setup-aero
  | "view-front-wing"
  | "view-rear-wing"
  // setup-chassis
  | "view-diff-preload"
  | "view-diff-entry"
  | "view-diff-middle"
  | "view-diff-exit"
  | "view-anti-roll-front"
  | "view-anti-roll-rear"
  | "view-power-steering"
  | "view-weight-jacker-left"
  | "view-weight-jacker-right"
  | "view-lr-spring-offset"
  | "view-rr-spring-offset"
  // setup-hybrid
  | "view-mguk-deploy-mode"
  | "view-mguk-regen-gain"
  | "view-mguk-deploy-fixed";

/** Placeholder used when telemetry is null/undefined or non-numeric. */
export const VIEW_NULL_VALUE = "---";

/**
 * Round to a fixed number of decimals without producing trailing zeros that the
 * caller doesn't want. Returns an integer string when `decimals` is 0.
 */
function fixedNoTrailing(value: number, decimals: number): string {
  return decimals <= 0 ? String(Math.round(value)) : value.toFixed(decimals);
}

/**
 * Format a 0.0–1.0 ratio as a percentage (multiplies by 100, appends "%").
 * Reserved for fields iRacing exposes as a fractional ratio.
 */
export function formatPercent(value: unknown, decimals = 0): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return VIEW_NULL_VALUE;

  return `${fixedNoTrailing(value * 100, decimals)}%`;
}

/**
 * Append "%" to a value iRacing already exposes in percentage units
 * (e.g. `dcBrakeBias` is "54", not "0.54"). One decimal by default.
 */
export function formatPercentRaw(value: unknown, decimals = 1): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return VIEW_NULL_VALUE;

  return `${fixedNoTrailing(value, decimals)}%`;
}

/** Same as formatPercent but preserves sign for bidirectional values (e.g. weight jacker). */
export function formatSignedPercent(value: unknown, decimals = 0): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return VIEW_NULL_VALUE;

  const pct = value * 100;
  const sign = pct > 0 ? "+" : "";

  return `${sign}${fixedNoTrailing(pct, decimals)}%`;
}

/** Format a raw integer slot/index (TC slot 0–10, ABS slot, mixture map …). */
export function formatInteger(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return VIEW_NULL_VALUE;

  return String(Math.round(value));
}

/** User units preference for DisplayUnits-aware formatters (#953). */
export type UnitsPreference = "auto" | "metric" | "imperial";

/**
 * Apply a units preference to a telemetry snapshot: `auto` passes it through
 * (formatters follow the sim's `DisplayUnits`), `metric`/`imperial` return a
 * copy with `DisplayUnits` forced so the same formatters render the chosen
 * units regardless of the sim setting (#953).
 */
export function withUnitsPreference(
  telemetry: TelemetryData | null | undefined,
  units: UnitsPreference,
): TelemetryData | null | undefined {
  if (!telemetry || units === "auto") return telemetry;

  const forced = units === "imperial" ? DisplayUnits.English : DisplayUnits.Metric;

  // Skip the (full-snapshot) copy when the sim already displays the chosen
  // units — this runs on the per-tick render paths.
  if (telemetry.DisplayUnits === forced) return telemetry;

  return { ...telemetry, DisplayUnits: forced };
}

/**
 * Format a pending pit-stop spring offset (`dpWeightJacker*`, raw millimeters)
 * exactly the way iRacing's F7 box renders it (#953): metric display units
 * show rounded whole millimeters ("3 mm" for raw 2.54), english shows exact
 * three-decimal inch fractions (`0.125"` for raw 3.175). Falls back to metric
 * when `DisplayUnits` is unavailable.
 */
export function formatSpringOffsetMm(value: unknown, telemetry?: TelemetryData | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return VIEW_NULL_VALUE;

  if (telemetry?.DisplayUnits === DisplayUnits.English) {
    return `${(value / 25.4).toFixed(3)}"`;
  }

  return `${Math.round(value)} mm`;
}

interface ViewDef {
  /** TelemetryData field that holds the live value. */
  readonly telemetryField: keyof TelemetryData;
  /** Short label rendered at the top of the icon (e.g. "BRAKE BIAS"). */
  readonly label: string;
  /**
   * Formats the raw telemetry value into the on-icon display string. The full
   * snapshot is passed as the second argument for formatters whose rendering
   * depends on another field (e.g. `DisplayUnits` for the spring offsets).
   */
  readonly format: (value: unknown, telemetry?: TelemetryData | null) => string;
  /**
   * Per-view font size override for the centered value text. Falls back to
   * `VIEW_VALUE_FONT_SIZE_DEFAULT` (36) when omitted. Bump it up on entries
   * that always render short single-character strings (e.g. TC slot 0–10)
   * so the key looks balanced; drop it when the value carries unit text
   * (e.g. "54.0%") and would otherwise crowd the edges.
   */
  readonly valueFontSize?: number;
  /**
   * Adjustment-mode id this View maps to for dual-press dispatch (issue #540).
   * The per-action `SETUP_*_GLOBAL_KEYS` map uses this id (plus `-increase` /
   * `-decrease`) to look up the global key binding to tap on key-up. The id
   * is *not* always the View id with `view-` stripped — setup-engine has
   * `view-throttle-shape` mapping to `throttle-shaping`, setup-chassis has
   * `view-diff-*` mapping to `differential-*`, etc.
   */
  readonly adjustmentMode: string;
}

const VIEW_VALUE_FONT_SIZE_DEFAULT = 36;
/** Comfortable size for single-/two-character integer readouts (TC slots, ABS, mixture, etc.). */
const VIEW_VALUE_FONT_SIZE_LARGE = 48;
/** A step between the default and `LARGE` — used by signed-percent readouts like weight jacker. */
const VIEW_VALUE_FONT_SIZE_MEDIUM = 40;

/**
 * Central registry of View sub-modes. Each setup action declares its own View
 * IDs in its setting enum; the icon render path uses this map to drive the
 * label + value display.
 */
export const VIEW_DEFS: Record<ViewSettingId, ViewDef> = {
  // setup-brakes — iRacing exposes `dcBrakeBias` / `dcBrakeBiasFine` / `dcPeakBrakeBias`
  // already in percentage units (e.g. 54.0), so use `formatPercentRaw` rather than the
  // ratio-multiplying `formatPercent`. The "%-decimal" values stay at the default size to
  // avoid crowding the key edges; short-integer entries bump up to LARGE.
  "view-brake-bias": {
    telemetryField: "dcBrakeBias",
    label: "BRAKE BIAS",
    format: (v) => formatPercentRaw(v, 1),
    adjustmentMode: "brake-bias",
  },
  "view-brake-bias-fine": {
    telemetryField: "dcBrakeBiasFine",
    label: "BIAS FINE",
    format: (v) => formatPercentRaw(v, 1),
    adjustmentMode: "brake-bias-fine",
  },
  "view-peak-brake-bias": {
    telemetryField: "dcPeakBrakeBias",
    label: "PEAK BIAS",
    format: (v) => formatPercentRaw(v, 1),
    adjustmentMode: "peak-brake-bias",
  },
  "view-brake-misc": {
    telemetryField: "dcBrakeMisc",
    label: "BRAKE MISC",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "brake-misc",
  },
  "view-engine-braking": {
    telemetryField: "dcEngineBraking",
    label: "ENG BRAKE",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "engine-braking",
  },
  "view-abs-adjust": {
    telemetryField: "dcABS",
    label: "ABS",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "abs-adjust",
  },
  // setup-traction — slot 1 is the canonical `dcTractionControl`; cars with multiple TC
  // presets expose the others as `dcTractionControl2`/`3`/`4`.
  "view-tc-slot-1": {
    telemetryField: "dcTractionControl",
    label: "TC1",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "tc-slot-1",
  },
  "view-tc-slot-2": {
    telemetryField: "dcTractionControl2",
    label: "TC2",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "tc-slot-2",
  },
  "view-tc-slot-3": {
    telemetryField: "dcTractionControl3",
    label: "TC3",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "tc-slot-3",
  },
  "view-tc-slot-4": {
    telemetryField: "dcTractionControl4",
    label: "TC4",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "tc-slot-4",
  },
  // setup-fuel
  "view-fuel-mixture": {
    telemetryField: "dcFuelMixture",
    label: "FUEL MIX",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "fuel-mixture",
  },
  "view-fuel-cut-position": {
    telemetryField: "dcFuelCutPosition",
    label: "FUEL CUT",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "fuel-cut-position",
  },
  // setup-engine — Launch RPM keeps the default since it can render 4–5 digits (e.g. 12000).
  "view-engine-power": {
    telemetryField: "dcEnginePower",
    label: "ENG POWER",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "engine-power",
  },
  "view-throttle-shape": {
    telemetryField: "dcThrottleShape",
    label: "THROTTLE",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "throttle-shaping",
  },
  "view-launch-rpm": {
    telemetryField: "dcLaunchRPM",
    label: "LAUNCH RPM",
    format: formatInteger,
    adjustmentMode: "launch-rpm",
  },
  // setup-aero
  "view-front-wing": {
    telemetryField: "dcFrontWing",
    label: "FRONT WING",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "front-wing",
  },
  "view-rear-wing": {
    telemetryField: "dcRearWing",
    label: "REAR WING",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "rear-wing",
  },
  // setup-chassis — `view-diff-*` and `view-anti-roll-*` map to differently-named
  // adjustment modes (`differential-*` / `*-arb`); weight-jacker ids are new
  // dispatch-only keys added in #540 so the View can drive them via dual-press.
  "view-diff-preload": {
    telemetryField: "dcDiffPreload",
    label: "DIFF PRELOAD",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "differential-preload",
  },
  "view-diff-entry": {
    telemetryField: "dcDiffEntry",
    label: "DIFF ENTRY",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "differential-entry",
  },
  "view-diff-middle": {
    telemetryField: "dcDiffMiddle",
    label: "DIFF MIDDLE",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "differential-middle",
  },
  "view-diff-exit": {
    telemetryField: "dcDiffExit",
    label: "DIFF EXIT",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "differential-exit",
  },
  "view-anti-roll-front": {
    telemetryField: "dcAntiRollFront",
    label: "ARB FRONT",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "front-arb",
  },
  "view-anti-roll-rear": {
    telemetryField: "dcAntiRollRear",
    label: "ARB REAR",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "rear-arb",
  },
  "view-power-steering": {
    telemetryField: "dcPowerSteering",
    label: "PWR STEER",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "power-steering",
  },
  "view-weight-jacker-left": {
    telemetryField: "dcWeightJackerLeft",
    label: "WJKR LEFT",
    format: (v) => formatSignedPercent(v, 0),
    valueFontSize: VIEW_VALUE_FONT_SIZE_MEDIUM,
    adjustmentMode: "weight-jacker-left",
  },
  "view-weight-jacker-right": {
    telemetryField: "dcWeightJackerRight",
    label: "WJKR RIGHT",
    format: (v) => formatSignedPercent(v, 0),
    valueFontSize: VIEW_VALUE_FONT_SIZE_MEDIUM,
    adjustmentMode: "weight-jacker-right",
  },
  // Pending next-pit-stop LR/RR spring offsets (#953) — the `dp*` pitstop
  // family, distinct from the immediate in-car `dcWeightJacker*` Views above.
  // Raw values are millimeters regardless of the sim's display units; the
  // formatter mirrors iRacing's per-unit F7 rendering. Either field may be
  // absent per car (the SRX exposes only the Right one) → `---`.
  "view-lr-spring-offset": {
    telemetryField: "dpWeightJackerLeft",
    label: "LR SPRING",
    format: formatSpringOffsetMm,
    adjustmentMode: "lr-spring",
  },
  "view-rr-spring-offset": {
    telemetryField: "dpWeightJackerRight",
    label: "RR SPRING",
    format: formatSpringOffsetMm,
    adjustmentMode: "rr-spring",
  },
  // setup-hybrid — `view-mguk-deploy-fixed` maps to the existing `mguk-fixed-deploy`
  // adjustment mode (the View id was named in the noun-verb order to read more
  // naturally on the icon, the adjustment id keeps the original verb-noun order).
  "view-mguk-deploy-mode": {
    telemetryField: "dcMGUKDeployMode",
    label: "DEPLOY MODE",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "mguk-deploy-mode",
  },
  "view-mguk-regen-gain": {
    telemetryField: "dcMGUKRegenGain",
    label: "REGEN GAIN",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "mguk-regen-gain",
  },
  "view-mguk-deploy-fixed": {
    telemetryField: "dcMGUKDeployFixed",
    label: "FIXED DEPLOY",
    format: formatInteger,
    valueFontSize: VIEW_VALUE_FONT_SIZE_LARGE,
    adjustmentMode: "mguk-fixed-deploy",
  },
};

/**
 * Look up the adjustment-mode id used to dispatch dual-press for a View (#540).
 * Returns `undefined` if `id` isn't a known View — callers should pre-filter
 * with `isViewSetting`.
 */
export function getAdjustmentModeForView(id: string): string | undefined {
  return isViewSetting(id) ? VIEW_DEFS[id].adjustmentMode : undefined;
}

const VIEW_IDS: ReadonlySet<string> = new Set(Object.keys(VIEW_DEFS));

/** Type guard: is `id` a known View setting? Used to gate rendering and press handlers. */
export function isViewSetting(id: string): id is ViewSettingId {
  return VIEW_IDS.has(id);
}

/**
 * Format the current telemetry snapshot for the given View setting. Returns the
 * null-value placeholder when telemetry is unavailable or the field is missing.
 */
export function formatViewValue(viewId: ViewSettingId, telemetry: TelemetryData | null | undefined): string {
  if (!telemetry) return VIEW_NULL_VALUE;

  const def = VIEW_DEFS[viewId];

  return def.format(telemetry[def.telemetryField], telemetry);
}

/**
 * Visual center y for the View value text — the single source of truth for
 * title-aware content centering, shared by `generateSetupViewSvg` below AND
 * `adjust-styles.ts`'s `titleAwareCenterY` (which delegates here), so the
 * View look, the pill-middle styles, and the simple directional styles
 * (edge-chevrons, big-glyph, big-chevron) all move identically (issue #810).
 * Resolved from where the title sits: a hidden title frees the whole key so
 * the value sits at the true center (72); a bottom title (or middle/custom)
 * pushes the value UP so it clears the title, landing at 60; a top title
 * needs the value pushed DOWN so it clears the title, landing at 84.
 */
export function viewValueCenterY(title: Pick<ResolvedTitleSettings, "showTitle" | "position">): number {
  if (!title.showTitle) return 72;

  return title.position === "top" ? 84 : 60;
}

/**
 * Inputs the setup-action passes to the shared View renderer. The override
 * fields mirror the matching `CommonSettings` fields verbatim; importing the
 * types here keeps the renderer type-checked end-to-end while still letting
 * each per-action settings shape pass through (CommonSettings is the shared
 * base, so every setup-action's Zod-inferred type is assignable).
 */
export interface SetupViewRenderInputs {
  readonly viewId: ViewSettingId;
  readonly telemetry: TelemetryData | null | undefined;
  /**
   * Optional representative static icon from the parent setup action. Its `<desc>`
   * metadata supplies the default `backgroundColor` / `textColor` / etc. so a View
   * key inherits the action's category color scheme (e.g. setup-engine's green
   * background instead of the shared template's blue). Falls back to the shared
   * View template's own defaults when omitted.
   */
  readonly colorSourceSvg?: string;
  readonly colorOverrides?: ColorSlots;
  readonly titleOverrides?: TitleOverrides;
  readonly borderOverrides?: BorderOverrides;
  /**
   * When true, draw the centered binding-missing warning triangle over the
   * dimmed value readout (issue #612). A View sub-mode requires a binding only
   * when its dual-press opt-in is on AND the adjustment binding(s) it would
   * dispatch are unconfigured; the caller computes this per-button.
   */
  readonly bindingMissing?: boolean;
}

/**
 * Render the SVG data URI for a View sub-mode. Uses the shared dynamic icon
 * template (`icons/setup-view.svg`) for the layout but reads default colors /
 * title / border from `colorSourceSvg` (the action's representative static icon)
 * so the View key stays visually consistent with the action's adjust icons.
 */
export function generateSetupViewSvg(inputs: SetupViewRenderInputs): string {
  const { viewId, telemetry } = inputs;
  const def = VIEW_DEFS[viewId];
  const value = formatViewValue(viewId, telemetry);

  const styleSource = inputs.colorSourceSvg ?? setupViewTemplate;
  const colors = resolveIconColors(styleSource, getGlobalColors(), inputs.colorOverrides);
  const resolvedTitle = resolveTitleSettings(styleSource, getGlobalTitleSettings(), inputs.titleOverrides, def.label);

  const titleContent = resolvedTitle.showTitle
    ? generateTitleText({
        text: resolvedTitle.titleText,
        fontSize: resolvedTitle.fontSize,
        bold: resolvedTitle.bold,
        position: resolvedTitle.position,
        customPosition: resolvedTitle.customPosition,
        fill: colors.textColor,
      })
    : "";

  const border = resolveBorderSettings(styleSource, getGlobalBorderSettings(), inputs.borderOverrides);
  const borderSvg = generateBorderParts(border);

  // Per-view override (set in VIEW_DEFS) wins; fall back to the default size that fits
  // longer values like "54.0%" without crowding the key's left/right edges.
  const valueFontSize = String(def.valueFontSize ?? VIEW_VALUE_FONT_SIZE_DEFAULT);
  // The value's vertical center depends on where the resolved title sits
  // (viewValueCenterY, #810): a shown bottom title pushes the value up to
  // 60, a hidden title lets the value drop to true center (72), and a top
  // title pushes it to 84 so it clears the title. Qt's SVG renderer ignores
  // `dominant-baseline`, so the visual-center y is converted to a baseline y
  // by shifting down ~0.36em (see adjust-styles.ts TEXT_CENTER_BASELINE_FACTOR
  // for the same math).
  const valueY = String(viewValueCenterY(resolvedTitle) + Math.round(0.36 * Number(valueFontSize)));

  // When a required binding is missing (#612), draw the value via the warning
  // overlay slot — dimmed beneath the centered warning triangle — and blank the
  // template's own value slot so it isn't rendered twice at full opacity.
  const valueText = `<text x="72" y="${valueY}" text-anchor="middle" fill="${colors.textColor}" font-family="Arial, sans-serif" font-size="${valueFontSize}" font-weight="bold">${value}</text>`;
  const warningContent = inputs.bindingMissing ? applyBindingWarning(valueText) : "";

  const svg = renderIconTemplate(setupViewTemplate, {
    backgroundColor: colors.backgroundColor,
    textColor: colors.textColor,
    titleContent,
    borderDefs: borderSvg.defs,
    borderContent: borderSvg.rects,
    value: inputs.bindingMissing ? "" : value,
    valueFontSize,
    valueY,
    warningContent,
  });

  return svgToDataUri(svg);
}
