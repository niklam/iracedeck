import {
  applyBindingWarning,
  classifyDialRelease,
  CommonSettings,
  ConnectionStateAwareAction,
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  type DirectionalPair,
  fuelFromDisplayUnits,
  fuelToDisplayUnits,
  getCommands,
  getDualPressThresholdMs,
  getFuelUnitSuffix,
  type IDeckActionContext,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckTouchTapEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  isAutofuelActive,
  isAutofuelEnabled,
  isFuelFillOn,
  resolvePairedAction,
  svgToDataUri,
} from "@iracedeck/deck-core";
import { DisplayUnits, type SessionInfo, type TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import { borderColorForState, type ToggleState } from "../../icons/status-bar.js";

/**
 * The actions a dial-button / touch gesture (Push, Long Press, Tap Display,
 * Long Touch) can run, plus the "none" sentinel. `fill-to-max` toggles a full
 * tank vs no fuel; `toggle-autofuel-mode` flips iRacing's autofuel via its key
 * binding (switching which mode the bare turn adjusts); `switch-mode` flips the
 * manual dial mode between Add Amount and Target Amount.
 */
const GESTURE_ACTIONS = ["toggle-fueling", "fill-to-max", "toggle-autofuel-mode", "switch-mode", "none"] as const;

/** A configurable gesture-slot value (one of {@link GESTURE_ACTIONS}). */
type GestureSlot = (typeof GESTURE_ACTIONS)[number];

/**
 * Push + Turn pair members — directional fuel endpoints dispatched per pressed
 * rotation. They are not offered as standalone gesture slots; they only appear
 * inside a {@link PUSH_TURN_PAIRS} pair.
 */
type PushTurnMember = "fill-full" | "no-fuel";

/** Anything {@link FuelDial.doPress} can run (gesture slots minus "none", plus push+turn members). */
type GestureAction = Exclude<GestureSlot, "none"> | PushTurnMember;

/** Global-settings keys for the autofuel key bindings (shared with Fuel Service). */
const TOGGLE_AUTOFUEL_KEY = "fuelServiceToggleAutofuel";
const LAP_MARGIN_INCREASE_KEY = "fuelServiceLapMarginIncrease";
const LAP_MARGIN_DECREASE_KEY = "fuelServiceLapMarginDecrease";

/**
 * Trailing-throttle window for coalescing rapid rotations into a single
 * `pit.fuel()` broadcast + touch-strip update. The first change fires
 * promptly (leading edge); subsequent changes within the window are coalesced
 * and the latest value is flushed at the trailing edge.
 */
const THROTTLE_WINDOW_MS = 100;

/**
 * How long (ms) after a user rotation we keep ignoring telemetry re-seeds, so
 * a live update can't fight an in-flight adjustment.
 */
const USER_ACTIVITY_GRACE_MS = 3000;

/**
 * Cadence (ms) for the periodic display refresh. While the action is appeared,
 * the bar + value are re-rendered on this interval to track live fuel burn
 * without pushing `setFeedback` on every telemetry tick (which would blow past
 * the documented ≤10 setFeedback/sec/dial cap). Event-driven renders (rotate,
 * press, settings, appear) still fire immediately.
 */
const DISPLAY_REFRESH_MS = 5000;

/**
 * Minimum gap (ms) between change-driven feedback pushes. The bar/value re-render
 * the moment the DISPLAYED state changes (fuel-fill flips, or a rounded value
 * moves) rather than waiting for the 5 s heartbeat — but no more than once per
 * this window so a burst of telemetry can't exceed the ≤10 setFeedback/sec/dial
 * cap (issue #681).
 */
const CHANGE_RENDER_MIN_INTERVAL_MS = 100;

/**
 * The dialed value the "No Fuel" side of "Toggle Full / No Fuel" parks at (0).
 * The command itself is sent by `sendNoFuel` (1 L then clear); this just records
 * the empty state so the toggle's next press detects "not at max" and fills again.
 */
const TOGGLE_FULL_EMPTY_LTR = 0;

const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const GRAY = "#888888";
/** Neutral color for the static "current fuel" segment of the two-segment bar. */
const CURRENT_SEGMENT = "#9aa7b4";
/** Dark track behind both bar segments. */
const BAR_TRACK = "#1a1f26";
/** Color of the on-bar "current" amount label (dark, sits over the light current segment). */
const BAR_LABEL = "#0d1117";
/** Color of the on-bar "+add" amount label (white, sits over the green/red/gray add segment). */
const ADD_LABEL = WHITE;
/** Color of the "fill-to" target marker line (red, confined to the bar height). */
const TARGET_LINE = "#e74c3c";

const FuelDialSettings = CommonSettings.extend({
  dialMode: z.enum(["add-amount", "fill-to"]).default("add-amount"),
  stepSize: z.preprocess(
    (val) => (typeof val === "string" ? val.replace(",", ".") : val),
    z.coerce.number().min(0.1).max(50).default(1),
  ),
  // Push (short press) — fires on dialUp. Default: toggle fuel-fill on/off.
  pressAction: z.enum(GESTURE_ACTIONS).default("toggle-fueling"),
  // Long Press (held dial button past the threshold, no rotation) — fires on
  // dialUp. Default: toggle autofuel mode (blind-safe for VR).
  longPressAction: z.enum(GESTURE_ACTIONS).default("toggle-autofuel-mode"),
  // Push + Turn — a single bidirectional pair, dispatched per pressed rotation
  // (clockwise → cw action, counter-clockwise → ccw action) via the shared dial
  // convention. "full-empty": CW fills the tank, CCW empties it (no fuel).
  pushTurnAction: z.enum(["none", "full-empty"]).default("none"),
  // Tap Display (touch-strip tap, hold === false) — renamed from `touchAction`.
  // Default None for VR safety; the legacy key is migrated in parseSettings.
  tapAction: z.enum(GESTURE_ACTIONS).default("none"),
  // Long Touch (touch-strip tap, hold === true). Default None for VR safety.
  longTouchAction: z.enum(GESTURE_ACTIONS).default("none"),
  unitMode: z.enum(["auto", "liters", "gallons"]).default("auto"),
});

type FuelDialSettings = z.infer<typeof FuelDialSettings>;

/**
 * The "Push + Turn" pair for each `pushTurnAction` value. The per-tick dispatch
 * goes through the shared {@link resolvePairedAction} — the same path a future
 * Traction Control action will reuse with its own pairs. "none" maps to `null`
 * (no dispatch).
 */
const PUSH_TURN_PAIRS: Record<FuelDialSettings["pushTurnAction"], DirectionalPair<GestureAction> | null> = {
  none: null,
  // Press + turn: clockwise fills the tank to full, counter-clockwise empties it (no fuel).
  "full-empty": { cw: "fill-full", ccw: "no-fuel" },
};

/** Pending throttle state for one context. */
interface ThrottleState {
  /** Timer for the trailing flush, or null when idle. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Latest add target (liters) requested during the current window. */
  pendingLtr: number | null;
  /** Last liters value actually broadcast (suppresses no-op repeats). */
  lastSentLtr: number | null;
}

/**
 * Coalescing state for autofuel lap-margin keybind taps (one context). A fast
 * spin accumulates net detents within a window and dispatches a single
 * increase/decrease tap per window instead of one tap per detent, so the
 * black box isn't flooded (mirrors the {@link ThrottleState} pit.fuel pattern).
 */
interface MarginThrottleState {
  /** Timer for the trailing tap, or null when idle. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Net dial detents accumulated during the current window (signed). */
  pendingTicks: number;
}

/** Per-context runtime state. */
interface FuelDialContext {
  settings: FuelDialSettings;
  action: IDeckActionContext;
  /**
   * Dialed quantity, always in LITERS. In add-amount mode this is the amount to
   * ADD; in fill-to mode this is the desired TOTAL after the stop.
   */
  dialValueLtr: number;
  /** Timestamp (ms) of the last user rotation; guards telemetry re-seed. */
  lastUserActivity: number;
  /** Timestamp (ms) the current dial-button press started (dialDown). */
  pressStart: number;
  /**
   * Whether the dial was rotated while the button was held during the current
   * press. Set in onDialRotate (pressed === true), read once at dialUp to
   * pre-empt both press actions — a push+turn fires nothing on release.
   */
  rotatedWhilePressed: boolean;
  /** Recurring display-refresh timer (re-renders bar + value), or null. */
  displayTimer: ReturnType<typeof setInterval> | null;
  /**
   * Signature of the DISPLAYED state at the last change-driven feedback push.
   * Compared on every telemetry tick so a render fires the moment the displayed
   * fuel-fill color or a rounded value moves, not just on the 5 s heartbeat.
   */
  lastRenderSig: string | null;
  /** Timestamp (ms) of the last change-driven feedback push (throttle gate). */
  lastChangeRenderAt: number;
  /**
   * Whole-DISPLAY-unit add value at the last continuous fill-to re-broadcast, or
   * null when nothing is armed. The continuous monitor gates on this so it
   * re-broadcasts at most once per whole unit. `computeAddLtr` returns the add
   * rounded UP to a whole display unit (no fractional headroom clamp), so the
   * whole-unit key only moves when the rounded-up need crosses a whole-unit
   * boundary — never sub-litre spam (issue #681).
   */
  lastSentWholeAdd: number | null;
  throttle: ThrottleState;
  /** Coalescing state for autofuel lap-margin keybind taps. */
  marginThrottle: MarginThrottleState;
}

/**
 * @internal Exported for testing
 *
 * Resolves the effective iRacing DisplayUnits value for the chosen unit mode.
 * `auto` defers to telemetry; explicit modes force metric/english.
 */
export function resolveDisplayUnits(
  unitMode: FuelDialSettings["unitMode"],
  telemetryUnits: number | undefined,
): number {
  if (unitMode === "liters") return DisplayUnits.Metric;

  if (unitMode === "gallons") return DisplayUnits.English;

  // auto: follow telemetry; default to metric when unknown
  return telemetryUnits === undefined ? DisplayUnits.Metric : telemetryUnits;
}

/**
 * @internal Exported for testing
 *
 * Reads the effective fuel tank capacity (liters) from session info:
 * `DriverCarFuelMaxLtr × (DriverCarMaxFuelPct ?? 1)`. Returns undefined when
 * the capacity is unknown so callers can avoid clamping the upper bound.
 */
export function readEffectiveMaxLtr(sessionInfo: SessionInfo | null): number | undefined {
  const driverInfo = (sessionInfo as Record<string, unknown> | null)?.DriverInfo as Record<string, unknown> | undefined;

  if (!driverInfo) return undefined;

  const maxLtr = driverInfo.DriverCarFuelMaxLtr;

  if (typeof maxLtr !== "number" || !Number.isFinite(maxLtr) || maxLtr <= 0) return undefined;

  const pctRaw = driverInfo.DriverCarMaxFuelPct;
  const pct = typeof pctRaw === "number" && Number.isFinite(pctRaw) && pctRaw > 0 ? pctRaw : 1;

  return maxLtr * pct;
}

/**
 * @internal Exported for testing
 *
 * Clamps a value (liters) to [0, maxLtr]. When the max is unknown only the
 * lower bound is enforced.
 */
export function clampTargetLtr(targetLtr: number, maxLtr: number | undefined): number {
  const lower = Math.max(0, targetLtr);

  if (maxLtr === undefined) return lower;

  return Math.min(lower, maxLtr);
}

/**
 * @internal Exported for testing
 *
 * Formats a liters amount in display units, dropping the decimal for whole
 * numbers (e.g. "74" / "12.5").
 */
export function formatDisplayValue(liters: number, displayUnits: number): string {
  const value = fuelToDisplayUnits(liters, displayUnits);
  const rounded = Math.round(value * 10) / 10;

  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * @internal Exported for testing
 *
 * Builds the per-mode value text shown on the touch strip.
 *
 * - add-amount: `"+<add> = <total> <unit>"` (e.g. `"+20 = 65 L"`). The total is
 *   `min(current + add, capacity)` and reflects live fuel burn.
 * - fill-to: `"→ <target> <unit>"` (e.g. `"→ 65 L"`). The target is shown
 *   even when capacity is unknown.
 */
export function buildValueText(
  dialMode: FuelDialSettings["dialMode"],
  addLtr: number,
  totalLtr: number,
  targetLtr: number,
  displayUnits: number,
): string {
  const suffix = getFuelUnitSuffix(displayUnits);

  if (dialMode === "fill-to") {
    return `→ ${formatDisplayValue(targetLtr, displayUnits)} ${suffix}`;
  }

  return `+${formatDisplayValue(addLtr, displayUnits)} = ${formatDisplayValue(totalLtr, displayUnits)} ${suffix}`;
}

/** Manual / autofuel / autofuel-unavailable, derived from live autofuel telemetry. */
export type DialDisplayMode = "manual" | "autofuel" | "autofuel-off";

/**
 * Tri-state fueling indication shown on the key icon and touch strip (#728):
 * green ON / red OFF / gray N-A — the shared {@link ToggleState} language of
 * the toggle buttons' status bars and state borders.
 */
export type FuelFillState = ToggleState;

/**
 * @internal Exported for testing
 *
 * Derives the tri-state fueling indication from the display mode and live
 * telemetry. N/A when autofuel is engaged but unavailable (`autofuel-off` —
 * there is no controllable fuel request) or when there is no telemetry at all
 * (unknown must not read as OFF — mirrors Fuel Service's N/A). Otherwise the
 * live pit fuel-fill checkbox decides on/off.
 */
export function resolveFuelFillState(mode: DialDisplayMode, telemetry: TelemetryData | null): FuelFillState {
  if (mode === "autofuel-off") return "na";

  if (!telemetry) return "na";

  return isFuelFillOn(telemetry) ? "on" : "off";
}

/**
 * @internal Exported for testing
 *
 * Derives the Fuel Dial display mode from live telemetry. The dial is modal:
 * `dpFuelAutoFillActive` selects manual vs autofuel, and `dpFuelAutoFillEnabled`
 * downgrades an engaged autofuel to "autofuel-off" (unavailable for this
 * car/series, mirroring Fuel Service's N/A). It never fabricates a combination —
 * it reflects exactly what telemetry reports.
 */
export function resolveDialDisplayMode(telemetry: TelemetryData | null): DialDisplayMode {
  if (!isAutofuelActive(telemetry)) return "manual";

  return isAutofuelEnabled(telemetry) ? "autofuel" : "autofuel-off";
}

/**
 * @internal Exported for testing
 *
 * The status-band text on the key icon, mirrored as the touch-strip title
 * (#728): the fuel subsystem a bare turn controls (`REFUEL` in manual mode,
 * `AUTOFUEL` when iRacing's autofuel is engaged) plus the live tri-state —
 * `ON` / `OFF` / `N/A`. Text, never colour alone, so VR drivers catching a
 * peripheral look can read the state.
 */
export function buildRefuelBandText(mode: DialDisplayMode, fillState: FuelFillState): string {
  const subject = mode === "manual" ? "REFUEL" : "AUTOFUEL";

  if (mode === "autofuel-off" || fillState === "na") return `${subject}: N/A`;

  return `${subject}: ${fillState === "on" ? "ON" : "OFF"}`;
}

/**
 * @internal Exported for testing
 *
 * The amount readout. Autofuel shows the telemetry-derived intended add
 * (`PitSvFuel`) as `AUTO → <add> <u>` — open-loop, since the lap-margin value is
 * not in telemetry, so it is never a fabricated counter. Manual delegates to
 * {@link buildValueText}; autofuel-unavailable shows a dash.
 */
export function buildDialReadout(
  mode: DialDisplayMode,
  dialMode: FuelDialSettings["dialMode"],
  addLtr: number,
  totalLtr: number,
  targetLtr: number,
  displayUnits: number,
): string {
  if (mode === "autofuel-off") return "—";

  if (mode === "autofuel") {
    return `AUTO → ${formatDisplayValue(addLtr, displayUnits)} ${getFuelUnitSuffix(displayUnits)}`;
  }

  return buildValueText(dialMode, addLtr, totalLtr, targetLtr, displayUnits);
}

/**
 * @internal Exported for testing
 *
 * Reads `FuelLevel` (current fuel in tank, liters) from telemetry. Unknown
 * values are treated as 0 so the bar/readout never break.
 */
export function readFuelLevel(telemetry: TelemetryData | null): number {
  if (!telemetry) return 0;

  const value = telemetry.FuelLevel;

  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * @internal Exported for testing
 *
 * Reads `PitSvFuel` (the requested pit fuel add, liters) from telemetry, or
 * undefined when unavailable.
 */
export function readPitSvFuel(telemetry: TelemetryData | null): number | undefined {
  if (!telemetry) return undefined;

  const value = telemetry.PitSvFuel;

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * @internal Exported for testing
 *
 * Rounds a liters amount so it lands on a whole integer in DISPLAY units, then
 * converts back to liters. Used in fill-to mode so the dialed target is
 * always a whole displayed value (e.g. an integer number of liters/gallons).
 */
export function roundToWholeDisplayLtr(liters: number, displayUnits: number): number {
  const display = Math.round(fuelToDisplayUnits(liters, displayUnits));

  return fuelFromDisplayUnits(display, displayUnits);
}

/**
 * @internal Exported for testing
 *
 * Computes the effective liters to ADD for the next stop from the dialed value,
 * the current fuel level, and the tank capacity.
 *
 * - add-amount: `dialValueLtr` is the requested amount to add. The add is FIXED
 *   — it does not change as fuel burns. iRacing clamps at the pump, so here we
 *   only enforce the lower bound (and the upper tank capacity, since the dial
 *   already spans the full tank range `[0, capacity]`).
 * - fill-to: `dialValueLtr` is the desired TOTAL after the stop (kept a
 *   whole integer display value). The add is `max(0, target − current)`, rounded
 *   UP to the next whole DISPLAY unit so the stop never finishes below the
 *   (integer) target — the round-up alone guarantees current + add ≥ target. The
 *   add is NOT clamped to the remaining tank space: it is simply the amount needed
 *   to reach the target, and may exceed the CURRENT remaining space because more
 *   fuel burns before the pit stop (iRacing only fills up to the tank capacity
 *   anyway). Because the add is recomputed against the LIVE fuel level on every
 *   telemetry tick (continuous monitoring), it stays fresh as fuel burns and needs
 *   no extra safety buffer. The unclamped add is always a clean whole display value,
 *   so the continuous re-send fires exactly once per whole unit. When the need is
 *   ≤ 0 (target at/below current) the add stays 0 so the "0 → clearFuel" path still
 *   fires (issue #681).
 */
export function computeAddLtr(
  dialMode: FuelDialSettings["dialMode"],
  dialValueLtr: number,
  currentLtr: number,
  maxLtr: number | undefined,
  displayUnits: number,
): number {
  if (dialMode === "fill-to") {
    const rawAdd = Math.max(0, dialValueLtr - currentLtr);
    // Round the ADD up to the next whole display unit so current + add is at or
    // just above the integer target — a stop never finishes under target. The add
    // is the amount NEEDED to reach the target; it is NOT clamped to the current
    // remaining space (more fuel burns before the stop, and iRacing fills only up
    // to capacity). A need of ≤ 0 stays 0 so the "0 → clearFuel" path still fires.
    const addDisplay = Math.ceil(fuelToDisplayUnits(rawAdd, displayUnits));

    return addDisplay > 0 ? fuelFromDisplayUnits(addDisplay, displayUnits) : 0;
  }

  // add-amount: the dial spans the FULL tank range; clamp to [0, capacity].
  return clampTargetLtr(dialValueLtr, maxLtr);
}

/**
 * @internal Exported for testing
 *
 * The total fuel (liters) in the tank after the stop completes, capped at the
 * tank capacity when known.
 */
export function computeTotalLtr(currentLtr: number, addLtr: number, maxLtr: number | undefined): number {
  const total = currentLtr + addLtr;

  return maxLtr === undefined ? total : Math.min(total, maxLtr);
}

/**
 * @internal Exported for testing
 *
 * Builds an SVG `<path>` `d` for a horizontal bar segment with INDEPENDENTLY
 * rounded left/right ends. The left end rounds its top-left + bottom-left
 * corners; the right end rounds its top-right + bottom-right corners. A square
 * end is drawn flush. This lets two butted segments share a square boundary
 * while keeping the outer ends rounded — without `clipPath` (unsupported on
 * Mirabox QT5), using only arcs/paths from the safe SVG Tiny 1.2 set.
 */
export function roundedBarPath(
  x: number,
  width: number,
  height: number,
  roundLeft: boolean,
  roundRight: boolean,
  radius: number,
): string {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const left = x;
  const right = x + width;
  const top = 0;
  const bottom = height;
  const rl = roundLeft ? r : 0;
  const rr = roundRight ? r : 0;

  // Clockwise from the top-left (after its arc).
  return [
    `M ${(left + rl).toFixed(2)} ${top}`,
    `L ${(right - rr).toFixed(2)} ${top}`,
    rr ? `A ${rr.toFixed(2)} ${rr.toFixed(2)} 0 0 1 ${right.toFixed(2)} ${(top + rr).toFixed(2)}` : "",
    `L ${right.toFixed(2)} ${(bottom - rr).toFixed(2)}`,
    rr ? `A ${rr.toFixed(2)} ${rr.toFixed(2)} 0 0 1 ${(right - rr).toFixed(2)} ${bottom}` : "",
    `L ${(left + rl).toFixed(2)} ${bottom}`,
    rl ? `A ${rl.toFixed(2)} ${rl.toFixed(2)} 0 0 1 ${left.toFixed(2)} ${(bottom - rl).toFixed(2)}` : "",
    `L ${left.toFixed(2)} ${(top + rl).toFixed(2)}`,
    rl ? `A ${rl.toFixed(2)} ${rl.toFixed(2)} 0 0 1 ${(left + rl).toFixed(2)} ${top}` : "",
    "Z",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * @internal Exported for testing
 *
 * Renders ONE continuous two-segment fuel bar as a full SVG string (composed
 * into the touch strip's full-canvas pixmap).
 *
 * - A dark rounded track spans the full width.
 * - The CURRENT segment runs from the left (neutral gray-blue), the ADD segment
 *   is butted directly onto it: GREEN when fueling is ON, GRAY otherwise (off
 *   or state unknown). The bar stays deliberately subtle — the LOUD tri-state
 *   indicator is the status band at the top of the key (#728).
 * - Only the OUTER corners round (left end of current, right end of add); the
 *   shared current↔add boundary is SQUARE. When add is 0 the current segment
 *   alone rounds both ends; when current is 0 the add segment alone rounds both.
 * - On-bar amount labels: current LEFT-aligned in dark over the light current
 *   segment; the to-be-added `+add` RIGHT-aligned at the add segment's right end
 *   in WHITE for contrast over the green/gray add fill. Each label is omitted
 *   when its segment is too narrow to hold it legibly (never drawn over the dark
 *   empty track).
 * - In fill-to mode a thin RED vertical marker line marks the target total
 *   (`targetLtr` set + capacity known); it spans the FULL bar height (y=0 to
 *   y=height) and is confined to the bar — no overhang past the top/bottom. The
 *   SVG viewBox is `0 0 width height` so the track + segments fill the full
 *   pixmap rect. Omitted in add-amount mode.
 */
export function renderFuelBarSvg(
  currentLtr: number,
  addLtr: number,
  maxLtr: number | undefined,
  fillState: FuelFillState,
  widthPx: number,
  heightPx: number,
  displayUnits: number,
  targetLtr?: number,
): string {
  const radius = Math.min(heightPx / 2, 8);
  const span = maxLtr !== undefined && maxLtr > 0 ? maxLtr : Math.max(currentLtr + addLtr, 1);
  const currentW = Math.max(0, Math.min(widthPx, (currentLtr / span) * widthPx));
  const addW = Math.max(0, Math.min(widthPx - currentW, (addLtr / span) * widthPx));
  const addColor = fillState === "on" ? GREEN : GRAY;
  const fontSize = Math.max(8, Math.round(heightPx * 0.5));
  // Label y is a BASELINE (the deck app's QT renderer ignores dominant-baseline):
  // vertical center plus ~0.35 × font size centers the glyphs on the bar.
  const labelY = Math.round(heightPx / 2 + fontSize * 0.35);
  const pad = Math.max(3, Math.round(heightPx * 0.18));

  const parts = [
    `<rect x="0" y="0" width="${widthPx}" height="${heightPx}" rx="${radius}" fill="${BAR_TRACK}"/>`,
  ];

  if (currentW > 0) {
    // Round the left end always; round the right end too only when there's no add.
    parts.push(
      `<path d="${roundedBarPath(0, currentW, heightPx, true, addW <= 0, radius)}" fill="${CURRENT_SEGMENT}"/>`,
    );
  }

  if (addW > 0) {
    // Round the right (leading) end always; round the left end too only when there's no current.
    parts.push(
      `<path d="${roundedBarPath(currentW, addW, heightPx, currentW <= 0, true, radius)}" fill="${addColor}"/>`,
    );
  }

  // Fill-to target marker line: red, ~2-3px wide, spanning the full bar height (confined to the bar).
  if (targetLtr !== undefined && maxLtr !== undefined && maxLtr > 0) {
    const targetX = Math.max(0, Math.min(widthPx, (targetLtr / span) * widthPx));
    const lineW = Math.max(2, Math.min(3, Math.round(heightPx * 0.1)));
    parts.push(
      `<rect x="${(targetX - lineW / 2).toFixed(2)}" y="0" width="${lineW}" height="${heightPx}" fill="${TARGET_LINE}"/>`,
    );
  }

  // Current label: dark, left-aligned, only when the current segment can hold it.
  const currentLabel = formatDisplayValue(currentLtr, displayUnits);
  const currentLabelW = currentLabel.length * fontSize * 0.6 + pad;

  if (currentW >= currentLabelW) {
    parts.push(
      `<text x="${pad}" y="${labelY}" text-anchor="start" fill="${BAR_LABEL}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold">${currentLabel}</text>`,
    );
  }

  // +add label: WHITE, right-aligned at the add segment's right end, only when
  // the add segment can hold it (so it never lands on the dark empty track).
  const addLabel = `+${formatDisplayValue(addLtr, displayUnits)}`;
  const addLabelW = addLabel.length * fontSize * 0.6 + pad;

  if (addW >= addLabelW) {
    const addRight = currentW + addW;
    parts.push(
      `<text x="${(addRight - pad).toFixed(2)}" y="${labelY}" text-anchor="end" fill="${ADD_LABEL}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold">${addLabel}</text>`,
    );
  }

  // The viewBox spans exactly the bar so the track + segments fill the full
  // pixmap rect; the target line is confined to y in [0, heightPx].
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${widthPx} ${heightPx}" width="${widthPx}" height="${heightPx}">${parts.join("")}</svg>`;
}

/**
 * @internal Exported for testing
 *
 * Renders the ENTIRE 200×100 touch-strip slot as one SVG — the encoder layout
 * (`layouts/fuel-dial.json`) is a single full-canvas pixmap, drawn ourselves
 * because the built-in layout text items cannot have a colored background
 * (#728): the status band across the top (green `REFUEL: ON` / red
 * `REFUEL: OFF` / `AUTOFUEL` variants / gray N-A), the per-mode readout, and
 * the two-segment fuel bar (with the red target line in manual fill-to mode).
 */
export function renderStripCanvasSvg(
  mode: DialDisplayMode,
  dialMode: FuelDialSettings["dialMode"],
  fillState: FuelFillState,
  currentLtr: number,
  addLtr: number,
  totalLtr: number,
  targetLtr: number,
  maxLtr: number | undefined,
  displayUnits: number,
  bindingMissing = false,
): string {
  const bandText = buildRefuelBandText(mode, fillState);
  const valueText = buildDialReadout(mode, dialMode, addLtr, totalLtr, targetLtr, displayUnits);
  // The red target line is drawn only in MANUAL fill-to mode; suppressed in autofuel.
  const barTarget = mode === "manual" && dialMode === "fill-to" ? targetLtr : undefined;
  const barSvg = renderFuelBarSvg(currentLtr, addLtr, maxLtr, fillState, 184, 28, displayUnits, barTarget);
  const bandHeight = 30;

  // Text y values are BASELINES — the deck app's QT SVG renderer ignores
  // dominant-baseline, so each text is centered by an explicit baseline offset
  // (~0.35 × font size below the intended visual center).
  const content = [
    // Status band with rounded top corners (the strip slot itself is square,
    // the small radius just softens the band edge).
    `<path d="M 0 ${bandHeight} L 0 8 A 8 8 0 0 1 8 0 L 192 0 A 8 8 0 0 1 200 8 L 200 ${bandHeight} Z" fill="${borderColorForState(fillState)}"/>`,
    `<text x="100" y="21" text-anchor="middle" fill="${WHITE}" font-family="Arial, sans-serif" font-size="17" font-weight="bold">${bandText}</text>`,
    `<text x="100" y="56" text-anchor="middle" fill="${WHITE}" font-family="Arial, sans-serif" font-size="24" font-weight="bold">${valueText}</text>`,
    `<g transform="translate(8, 66)">${stripSvgWrapper(barSvg)}</g>`,
  ].join("");

  // When a gesture slot needs the autofuel key binding but it's unset, dim the
  // slot and draw the centered #612 warning triangle over it (same convention
  // as Setup Brakes Dial's strip box).
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">${
    bindingMissing ? applyBindingWarning(content) : content
  }</svg>`;
}

/** Strips the outer `<svg …>…</svg>` wrapper, returning only the inner markup. */
function stripSvgWrapper(svg: string): string {
  const open = svg.indexOf(">");
  const close = svg.lastIndexOf("</svg>");

  if (open === -1 || close === -1 || close <= open) return svg;

  return svg.slice(open + 1, close);
}

/** Human-readable label for a gesture slot (for trigger descriptions). */
function actionLabel(action: GestureSlot): string {
  switch (action) {
    case "toggle-fueling":
      return "Toggle fueling";
    case "fill-to-max":
      return "Toggle full / no fuel";
    case "toggle-autofuel-mode":
      return "Toggle autofuel";
    case "switch-mode":
      return "Switch mode";
    case "none":
      return "None";
  }
}

/**
 * @internal Exported for testing
 *
 * Computes the encoder trigger descriptions from the current settings.
 *
 * The Elgato SDK fields describe specific gestures: `rotate` (dial rotation),
 * `push` (dial button press), `touch` (touchscreen tap) and `longTouch`
 * (touchscreen LONG tap). The dial-button LONG PRESS has no dedicated SDK field,
 * so it rides on the `push` label as a "(hold: …)" hint; the touchscreen long
 * tap (Long Touch slot) maps to `longTouch`.
 */
export function buildTriggerDescription(settings: FuelDialSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = {
    rotate: settings.dialMode === "fill-to" ? "Adjust target / autofuel margin" : "Adjust fuel / autofuel margin",
  };

  const pushLabel = settings.pressAction === "none" ? undefined : actionLabel(settings.pressAction);
  const holdLabel = settings.longPressAction === "none" ? undefined : actionLabel(settings.longPressAction);

  if (pushLabel && holdLabel) {
    description.push = `${pushLabel} (hold: ${holdLabel})`;
  } else if (pushLabel) {
    description.push = pushLabel;
  } else if (holdLabel) {
    description.push = `Hold: ${holdLabel}`;
  }

  if (settings.tapAction !== "none") {
    description.touch = actionLabel(settings.tapAction);
  }

  if (settings.longTouchAction !== "none") {
    description.longTouch = actionLabel(settings.longTouchAction);
  }

  return description;
}

/**
 * Fuel Dial Action
 *
 * An ENCODER-ONLY action (no keypad — Fuel Service covers keys). Rotating sets
 * either the amount to add (add-amount mode) or the desired total after the
 * stop (fill-to mode); pressing/tapping runs a configurable action
 * (toggle/clear/fill); the touch strip is one self-drawn pixmap with the
 * REFUEL/AUTOFUEL status band, a live readout, and a two-segment fuel bar. All
 * communication uses the iRacing API (`pit.fuel` / `pit.clearFuel`).
 */
export const FUEL_DIAL_UUID = "com.iracedeck.sd.core.fuel-dial" as const;

export class FuelDial extends ConnectionStateAwareAction<FuelDialSettings> {
  private contextsState = new Map<string, FuelDialContext>();
  /** Whether the last pit command this action sent was a clearFuel (dedup guard). */
  private lastPitWasClear = false;
  /**
   * Last observed fuel-fill state, to detect the OFF→ON edge in {@link onTelemetry}.
   * When fuel becomes armed (by us OR anything external — Fuel Service, the in-sim
   * checkbox, a `#fuel` macro), the dedup guard is released so a later clear isn't
   * wrongly skipped.
   */
  private lastFuelFillObserved = false;

  override async onWillAppear(ev: IDeckWillAppearEvent<FuelDialSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const ctx = this.ensureContext(ev.action, settings);
    // Seed the dialed value from current pit fuel request on appear.
    this.seedFromTelemetry(ctx, true);

    // Start the periodic display refresh so the bar + value track live burn.
    this.startDisplayTimer(ctx);
    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);

    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      const current = this.contextsState.get(ev.action.id);

      if (current) {
        this.onTelemetry(current, telemetry);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<FuelDialSettings>): Promise<void> {
    const ctx = this.contextsState.get(ev.action.id);

    if (ctx) {
      this.clearTimers(ctx);
    }

    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.contextsState.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<FuelDialSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const ctx = this.ensureContext(ev.action, settings);
    ctx.settings = settings;

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<FuelDialSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    const ctx = this.ensureContext(ev.action, settings);
    ctx.settings = settings;

    // Push + Turn: a pressed rotation dispatches the configured bidirectional
    // pair (cw on a positive tick sign, ccw on a negative one) and sets the guard
    // so the dialUp classifier pre-empts both press actions. It does NOT adjust
    // the bare-turn primary. Fuel Dial's "full-empty" pair maps CW → fill full,
    // CCW → no fuel; "none" dispatches nothing.
    if (ev.payload.pressed) {
      ctx.rotatedWhilePressed = true;
      const action = resolvePairedAction(PUSH_TURN_PAIRS[settings.pushTurnAction], ev.payload.ticks);

      if (action) {
        await this.doPress(action, ctx);
      }

      return;
    }

    // Bare turn in AUTOFUEL mode adjusts the autofuel lap margin via key bindings
    // (coalesced so a fast spin doesn't flood the black box). The readout settles
    // a beat later from PitSvFuel — there is no margin value in telemetry.
    const mode = this.displayMode();

    if (mode === "autofuel") {
      ctx.lastUserActivity = Date.now();
      this.adjustLapMargin(ctx, ev.payload.ticks);

      return;
    }

    // Autofuel engaged but unavailable (AUTO OFF): there is no controllable fuel
    // value and the display is frozen, so a bare turn does nothing — it must NOT
    // broadcast pit.fuel against a readout the driver can't see change.
    if (mode === "autofuel-off") return;

    // Bare turn in MANUAL mode: adjust the fuel add / fill-to target. BOTH modes
    // span the full tank range [0, capacity]; fill-to snaps to a whole display
    // value on every rotate. ticks is a SIGNED DELTA (may be >1).
    const displayUnits = this.effectiveDisplayUnits(ctx);
    const stepLtr = fuelFromDisplayUnits(settings.stepSize, displayUnits);
    const upperBound = this.effectiveMaxLtr();
    let nextValue = ctx.dialValueLtr + ev.payload.ticks * stepLtr;

    if (settings.dialMode === "fill-to") {
      nextValue = roundToWholeDisplayLtr(nextValue, displayUnits);
    }

    ctx.dialValueLtr = clampTargetLtr(nextValue, upperBound);
    ctx.lastUserActivity = Date.now();
    this.logger.debug(
      `Dial=${ctx.dialValueLtr.toFixed(2)}L (${settings.dialMode}), ticks=${ev.payload.ticks}, step=${stepLtr.toFixed(2)}L`,
    );

    // Rotating issues pit.fuel (auto-arm). The touch-strip feedback (and the
    // pit.fuel broadcast) are throttled via the send window so a continuous spin
    // can't exceed the ≤10 setFeedback/sec/dial cap — flushSend issues the
    // broadcast + feedback at the window edges, so nothing renders per-event.
    this.scheduleSend(ctx);
  }

  override async onDialDown(ev: IDeckDialDownEvent<FuelDialSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    const ctx = this.ensureContext(ev.action, settings);
    ctx.settings = settings;

    // Record the press start and clear the push+turn guard. Fire NOTHING and
    // start NO timer — press vs long-press is classified once at dialUp.
    ctx.pressStart = Date.now();
    ctx.rotatedWhilePressed = false;
  }

  override async onDialUp(ev: IDeckDialUpEvent<FuelDialSettings>): Promise<void> {
    const ctx = this.contextsState.get(ev.action.id);

    if (!ctx) return;

    // Consume the press start immediately so a stray dialUp without a preceding
    // dialDown (e.g. the context was recreated while the button was held) can't
    // reclassify. A 0 sentinel means "no press in progress" — fire nothing; else
    // `nowMs - 0` would read as a huge elapsed time and misfire the long press.
    const pressStartMs = ctx.pressStart;
    ctx.pressStart = 0;

    if (pressStartMs === 0) return;

    // Classify the release with full information (duration + the rotated guard),
    // so long-press never races push+turn. No timer fired mid-hold.
    const kind = classifyDialRelease({
      pressStartMs,
      nowMs: Date.now(),
      rotatedWhilePressed: ctx.rotatedWhilePressed,
      // Honor the plugin-wide "Long-press threshold" global setting (shared with
      // the dual-press feature); falls back to DIAL_LONG_PRESS_THRESHOLD_MS.
      thresholdMs: getDualPressThresholdMs(),
    });

    if (kind === "push-turn") return;

    const action = kind === "long" ? ctx.settings.longPressAction : ctx.settings.pressAction;

    if (action === "none") return;

    this.logger.info(kind === "long" ? "Fuel dial long-pressed" : "Fuel dial pressed");
    await this.doPress(action, ctx);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<FuelDialSettings>): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    const settings = this.parseSettings(ev.payload.settings);
    // hold === true → Long Touch slot; hold === false → Tap Display slot.
    const action = ev.payload.hold ? settings.longTouchAction : settings.tapAction;

    if (action === "none") return;

    const ctx = this.ensureContext(ev.action, settings);
    ctx.settings = settings;
    this.logger.info(ev.payload.hold ? "Fuel dial long touch" : "Fuel dial tap");
    await this.doPress(action, ctx);
  }

  /**
   * Runs the configured press action against the LIVE pit fuel-fill state and
   * re-renders. Toggle reads the real checkbox each time so it correctly
   * alternates between requesting fuel and clearing it.
   */
  private async doPress(action: GestureAction, ctx: FuelDialContext): Promise<void> {
    // Toggle autofuel mode: flip iRacing's autofuel via its key binding. The dial
    // re-derives manual vs autofuel from the resulting dpFuelAutoFillActive
    // telemetry, so there is no local mode flag to keep in sync.
    if (action === "toggle-autofuel-mode") {
      this.logger.info("Fuel dial toggled autofuel");
      await this.tapBinding(TOGGLE_AUTOFUEL_KEY);
      await this.renderFeedback(ctx);

      return;
    }

    // Switch the manual dial mode between Add Amount and Target Amount. Persists
    // so it sticks and the Property Inspector reflects it; re-seeds the dialed
    // value for the new mode and re-renders.
    if (action === "switch-mode") {
      const next = ctx.settings.dialMode === "fill-to" ? "add-amount" : "fill-to";
      this.logger.info(`Fuel dial switched mode to ${next}`);
      ctx.settings = { ...ctx.settings, dialMode: next };
      this.seedFromTelemetry(ctx, true);
      await this.applyTriggerDescription(ctx);
      await this.renderFeedback(ctx);
      await ctx.action.setSettings({ ...ctx.settings });

      return;
    }

    const fuelOn = this.isFuelFillOn();
    // Whether this press cleared fueling. Tracked so the continuous-monitoring
    // re-send baselines (`ctx.throttle.lastSentLtr` and `ctx.lastSentWholeAdd`)
    // stay in sync: a clear resets them to null, an arm records the amount
    // actually broadcast.
    let cleared = false;
    // The amount actually armed (liters), or null when this press cleared.
    let armedLtr: number | null = null;

    switch (action) {
      case "toggle-fueling":
        if (fuelOn) {
          this.pitClearFuel();
          cleared = true;
          this.logger.debug("Toggle: cleared fueling");
        } else {
          const addLtr = this.effectiveAddLtr(ctx);
          this.sendFuel(addLtr);
          // A resolved add of 0 clears instead of arming — keep bookkeeping in sync.
          cleared = addLtr <= 0;
          armedLtr = cleared ? null : addLtr;
          this.logger.debug(`Toggle: requested ${addLtr.toFixed(2)}L`);
        }

        break;

      case "fill-to-max": {
        const maxLtr = this.effectiveMaxLtr();

        if (maxLtr === undefined) {
          // No tank capacity to fill to — don't send a stale/zero target or arm.
          this.logger.warn("Toggle full/no fuel: tank capacity unknown, skipping");

          return;
        }

        // "Toggle Full / No Fuel" is a TOGGLE. The dialed value is set to the FULL
        // tank capacity (add-mode: capacity as the add; fill-to: capacity as the
        // target). A second invocation while already at max empties the request.
        const atMax = ctx.dialValueLtr >= maxLtr - 0.5;

        if (atMax) {
          // No Fuel side — reduce the request by the full tank so the requested
          // amount drops to 0 (see sendNoFuel).
          ctx.dialValueLtr = TOGGLE_FULL_EMPTY_LTR;
          this.sendNoFuel();
          cleared = true;
          armedLtr = null;
          this.logger.debug("Toggle full/no fuel (no fuel): reduced by max");
        } else {
          ctx.dialValueLtr = maxLtr;
          const addLtr = this.effectiveAddLtr(ctx);
          this.sendFuel(addLtr);
          cleared = addLtr <= 0;
          armedLtr = cleared ? null : addLtr;
          this.logger.debug(`Toggle full/no fuel (full): requested ${addLtr.toFixed(2)}L`);
        }

        break;
      }

      case "fill-full": {
        // Push + Turn CW — always fill the tank to capacity (directional, not a toggle).
        const maxLtr = this.effectiveMaxLtr();

        if (maxLtr === undefined) {
          this.logger.warn("Push+turn full: tank capacity unknown, skipping");

          return;
        }

        ctx.dialValueLtr = maxLtr;
        const addLtr = this.effectiveAddLtr(ctx);
        this.sendFuel(addLtr);
        cleared = addLtr <= 0;
        armedLtr = cleared ? null : addLtr;
        this.logger.debug(`Push+turn full: requested ${addLtr.toFixed(2)}L`);
        break;
      }

      case "no-fuel": {
        // Push + Turn CCW — empty the request by reducing it by the full tank.
        ctx.dialValueLtr = TOGGLE_FULL_EMPTY_LTR;
        this.sendNoFuel();
        cleared = true;
        armedLtr = null;
        this.logger.debug("Push+turn no fuel: reduced by max");
        break;
      }
    }

    // Sync the continuous-monitoring baselines: a clear resets both to null; an
    // arm records the broadcast amount (raw liters for the rotate throttle, the
    // whole DISPLAY unit for the per-litre re-send gate) so the next telemetry
    // tick doesn't immediately re-broadcast or wrongly suppress.
    ctx.throttle.lastSentLtr = armedLtr;
    ctx.lastSentWholeAdd =
      armedLtr === null ? null : Math.round(fuelToDisplayUnits(armedLtr, this.effectiveDisplayUnits(ctx)));

    await this.renderFeedback(ctx);
  }

  /**
   * Schedules a trailing-throttle send of the latest add target. The first
   * change fires promptly (leading edge); rapid follow-ups coalesce into one
   * flush per window. No-op repeats of the same liters are suppressed.
   */
  private scheduleSend(ctx: FuelDialContext): void {
    ctx.throttle.pendingLtr = this.effectiveAddLtr(ctx);

    if (ctx.throttle.timer === null) {
      // Leading edge — send immediately, then open the coalescing window.
      this.flushSend(ctx);
      ctx.throttle.timer = setTimeout(() => {
        ctx.throttle.timer = null;
        // Recompute against the latest dialed value before the trailing send.
        ctx.throttle.pendingLtr = this.effectiveAddLtr(ctx);
        this.flushSend(ctx);
      }, THROTTLE_WINDOW_MS);
    }
  }

  /** Broadcasts the pending add target (suppressing no-op repeats) and updates feedback. */
  private flushSend(ctx: FuelDialContext): void {
    const target = ctx.throttle.pendingLtr;
    ctx.throttle.pendingLtr = null;

    if (target === null) return;

    if (ctx.throttle.lastSentLtr === target) {
      // Same value already sent — still refresh feedback, skip the broadcast.
      void this.renderFeedback(ctx);

      return;
    }

    this.sendFuel(target);
    ctx.throttle.lastSentLtr = target;
    // Keep the continuous fill-to monitor's per-litre re-send gate in sync with
    // what was just broadcast (mirrors doPress). Without this, the first telemetry
    // tick after a fill-to rotate sees a stale `lastSentWholeAdd` and emits one
    // redundant `pit.fuel` (issue #681).
    const displayUnits = this.effectiveDisplayUnits(ctx);
    ctx.lastSentWholeAdd = target <= 0 ? null : Math.round(fuelToDisplayUnits(target, displayUnits));
    this.logger.info("Fuel request sent");
    this.logger.debug(`Sent ${target.toFixed(2)}L`);
    void this.renderFeedback(ctx);
  }

  /**
   * Sends a fuel request through the single SDK entry point, mapping a resolved
   * add of 0 (or less) to `pit.clearFuel()` instead of `pit.fuel(0)`. The iRacing
   * SDK treats `pit.fuel(0)` as "keep the existing amount", NOT "request zero", so
   * a computed add of 0 must clear the request to mean "don't add anything"
   * (issue #681). Any non-zero add goes through `pit.fuel`, which arms the
   * fuel-fill checkbox per iRacing's default behaviour.
   */
  private sendFuel(addLtr: number): void {
    if (addLtr <= 0) {
      this.pitClearFuel();
      this.logger.debug("Resolved add is 0 — cleared fueling instead of requesting 0 L");

      return;
    }

    this.pitFuel(addLtr);
  }

  /**
   * Empties the pit fuel request: set a minimal 1 L, then clear the checkbox. The
   * pit fuel broadcast is an UNSIGNED int, so a negative wraps to a huge positive
   * (e.g. −120 → 65416), and `pit.fuel(0)` means "keep existing" — so 1 L is the
   * smallest value that actually resets the requested amount, after which
   * `pit.clearFuel` unchecks the box. Used by the "No Fuel" gestures.
   */
  private sendNoFuel(): void {
    this.pitFuel(1);
    this.pitClearFuel();
    this.logger.debug("No fuel — set 1 L then cleared");
  }

  /** Sends a `pit.fuel` request and records that the last pit command was not a clear. */
  private pitFuel(liters: number): void {
    getCommands().pit.fuel(liters);
    this.lastPitWasClear = false;
  }

  /**
   * Clears the fuel checkbox — but never twice in a row. A redundant repeat (e.g.
   * a throttle's trailing flush landing on an already-cleared request) is skipped
   * so iRacing isn't sent back-to-back clears.
   */
  private pitClearFuel(): void {
    if (this.lastPitWasClear) return;

    getCommands().pit.clearFuel();
    this.lastPitWasClear = true;
  }

  private parseSettings(settings: unknown): FuelDialSettings {
    const parsed = FuelDialSettings.safeParse(this.migrateLegacySettings(settings));

    return parsed.success ? parsed.data : FuelDialSettings.parse({});
  }

  /**
   * Brings older saved configs forward so a single stale field can't fail the
   * whole `safeParse` (which would reset EVERY setting to default):
   *  - the legacy `touchAction` key is renamed to `tapAction`;
   *  - any gesture slot holding a retired value (e.g. the removed "clear-fueling",
   *    which used to be the `longPressAction` default) is coerced to "none" so the
   *    rest of the user's config — step size, mode, units, other slots — survives.
   */
  private migrateLegacySettings(settings: unknown): unknown {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return settings;

    const obj: Record<string, unknown> = { ...(settings as Record<string, unknown>) };

    // Legacy `touchAction` → renamed `tapAction`.
    if (obj.touchAction !== undefined && obj.tapAction === undefined) {
      obj.tapAction = obj.touchAction;
    }

    // Coerce any retired gesture-slot value so it can't fail the whole parse.
    const validSlots: readonly string[] = GESTURE_ACTIONS;

    for (const key of ["pressAction", "longPressAction", "tapAction", "longTouchAction"] as const) {
      const val = obj[key];

      if (typeof val === "string" && !validSlots.includes(val)) {
        obj[key] = "none";
      }
    }

    return obj;
  }

  private ensureContext(action: IDeckActionContext, settings: FuelDialSettings): FuelDialContext {
    let ctx = this.contextsState.get(action.id);

    if (!ctx) {
      ctx = {
        settings,
        action,
        dialValueLtr: 0,
        lastUserActivity: 0,
        pressStart: 0,
        rotatedWhilePressed: false,
        displayTimer: null,
        lastRenderSig: null,
        lastChangeRenderAt: 0,
        lastSentWholeAdd: null,
        throttle: { timer: null, pendingLtr: null, lastSentLtr: null },
        marginThrottle: { timer: null, pendingTicks: 0 },
      };
      this.contextsState.set(action.id, ctx);
    } else {
      ctx.action = action;
      ctx.settings = settings;
    }

    return ctx;
  }

  private effectiveDisplayUnits(ctx: FuelDialContext): number {
    const telemetry = this.sdkController.getCurrentTelemetry();
    const telemetryUnits = telemetry?.DisplayUnits;

    return resolveDisplayUnits(ctx.settings.unitMode, typeof telemetryUnits === "number" ? telemetryUnits : undefined);
  }

  private effectiveMaxLtr(): number | undefined {
    return readEffectiveMaxLtr(this.sdkController.getSessionInfo());
  }

  /** Current fuel level (liters) from live telemetry; 0 when unknown. */
  private currentLtr(): number {
    return readFuelLevel(this.sdkController.getCurrentTelemetry());
  }

  /** Live pit fuel-fill checkbox state. */
  private isFuelFillOn(): boolean {
    return isFuelFillOn(this.sdkController.getCurrentTelemetry());
  }

  /** Tri-state fueling indication for the display paths (green/red/gray, #728). */
  private fuelFillState(mode: DialDisplayMode): FuelFillState {
    return resolveFuelFillState(mode, this.sdkController.getCurrentTelemetry());
  }

  /** Effective liters to ADD for a context, from its dialed value + live telemetry. */
  private effectiveAddLtr(ctx: FuelDialContext): number {
    return computeAddLtr(
      ctx.settings.dialMode,
      ctx.dialValueLtr,
      this.currentLtr(),
      this.effectiveMaxLtr(),
      this.effectiveDisplayUnits(ctx),
    );
  }

  /** The live display mode (manual / autofuel / autofuel-off) from telemetry. */
  private displayMode(): DialDisplayMode {
    return resolveDialDisplayMode(this.sdkController.getCurrentTelemetry());
  }

  /** Whether the bare turn adjusts the autofuel lap margin (autofuel engaged + available). */
  private isAutofuelMode(): boolean {
    return this.displayMode() === "autofuel";
  }

  /**
   * The liters value used for the bar's add segment and the readout, by mode:
   *
   * - autofuel: the live requested add (`PitSvFuel`).
   * - manual add-amount: ALSO the live requested add (`PitSvFuel`), clamped to the
   *   dial's domain `[0, capacity]` — the display follows what iRacing actually
   *   banked, never the optimistically-dialed guess, so the readout matches the
   *   in-sim black box and never shows a value that resyncs a beat later (e.g.
   *   dialing "+1 gal" shows the real integer-litre amount the SDK applied, not a
   *   fabricated "+1") (#726). The capacity clamp preserves the prior `[0, max]`
   *   bound so a pit request set above the tank (e.g. externally) can't render a
   *   nonsensical add larger than the capped total. The dialed value still drives
   *   what is SENT (`effectiveAddLtr` via `scheduleSend`/`doPress`); only the
   *   DISPLAY is decoupled onto telemetry.
   * - manual fill-to: the computed target − current add (already telemetry-aware
   *   via the live fuel level + continuous monitoring), keeping the bar's add
   *   segment reaching the user's target marker.
   * - autofuel-off: no controllable add (current segment only).
   */
  private displayAddLtr(ctx: FuelDialContext, mode: DialDisplayMode): number {
    if (mode === "autofuel-off") return 0;

    if (mode === "autofuel") return Math.max(0, readPitSvFuel(this.sdkController.getCurrentTelemetry()) ?? 0);

    if (ctx.settings.dialMode === "add-amount") {
      return clampTargetLtr(readPitSvFuel(this.sdkController.getCurrentTelemetry()) ?? 0, this.effectiveMaxLtr());
    }

    return this.effectiveAddLtr(ctx);
  }

  /**
   * Whether the autofuel key binding is required (a gesture slot is set to
   * toggle-autofuel-mode) but unset — drives the #612 missing-binding overlay on
   * the key. The dial's primary functions (rotate to add fuel, press to toggle
   * fueling) go through the iRacing API and need NO binding, so a missing autofuel
   * binding must never gate the whole key's readiness — that would dim the key out
   * of the box for everyone (the default Long Press is toggle-autofuel-mode).
   */
  private autofuelBindingMissing(settings: FuelDialSettings): boolean {
    const slots = [settings.pressAction, settings.longPressAction, settings.tapAction, settings.longTouchAction];

    return slots.includes("toggle-autofuel-mode") && this.isBindingMissing(TOGGLE_AUTOFUEL_KEY);
  }

  /**
   * Schedules a coalesced autofuel lap-margin keybind tap from a dial rotation.
   * Net detents accumulate within a window; a single increase/decrease tap fires
   * per window (leading + trailing edges) so a fast spin can't flood the iRacing
   * black box. The readout settles from `PitSvFuel` a beat later (open-loop).
   */
  private adjustLapMargin(ctx: FuelDialContext, ticks: number): void {
    ctx.marginThrottle.pendingTicks += ticks;

    if (ctx.marginThrottle.timer === null) {
      // Leading edge — tap immediately, then open the coalescing window.
      void this.flushMarginTap(ctx);
      ctx.marginThrottle.timer = setTimeout(() => {
        ctx.marginThrottle.timer = null;
        void this.flushMarginTap(ctx);
      }, THROTTLE_WINDOW_MS);
    }
  }

  /** Dispatches one margin tap for the net accumulated direction, then refreshes feedback. */
  private async flushMarginTap(ctx: FuelDialContext): Promise<void> {
    const net = ctx.marginThrottle.pendingTicks;
    ctx.marginThrottle.pendingTicks = 0;

    if (net === 0) return;

    const key = net > 0 ? LAP_MARGIN_INCREASE_KEY : LAP_MARGIN_DECREASE_KEY;
    this.logger.info("Fuel dial autofuel margin adjusted");
    this.logger.debug(`Lap margin ${net > 0 ? "increase" : "decrease"} (net ${net})`);
    await this.tapBinding(key);
    await this.renderFeedback(ctx);
  }

  /**
   * Re-seeds the dialed value from telemetry. When `force` is false the re-seed
   * is skipped if the user rotated recently (so live telemetry can't fight an
   * in-flight adjustment). add-mode seeds from `PitSvFuel` (the requested add);
   * fill-to mode seeds from `current + PitSvFuel` (the resulting total).
   */
  private seedFromTelemetry(ctx: FuelDialContext, force: boolean): void {
    if (!force && Date.now() - ctx.lastUserActivity < USER_ACTIVITY_GRACE_MS) return;

    const telemetry = this.sdkController.getCurrentTelemetry();
    const pitFuel = readPitSvFuel(telemetry);

    if (pitFuel === undefined) return;

    const maxLtr = this.effectiveMaxLtr();

    if (ctx.settings.dialMode === "fill-to") {
      const current = readFuelLevel(telemetry);
      // Seed the target as a whole integer display value.
      ctx.dialValueLtr = clampTargetLtr(
        roundToWholeDisplayLtr(current + pitFuel, this.effectiveDisplayUnits(ctx)),
        maxLtr,
      );
    } else {
      ctx.dialValueLtr = clampTargetLtr(pitFuel, maxLtr);
    }
  }

  /**
   * Manual-mode telemetry behaviours: re-seed the dialed value (add-amount only)
   * and run the continuous fill-to re-broadcast. Called from onTelemetry only
   * when NOT in autofuel mode.
   */
  private updateManualFromTelemetry(ctx: FuelDialContext, telemetry: TelemetryData | null): void {
    // Re-seed the dialed value from telemetry only when the user hasn't rotated
    // recently — and ONLY in add-amount mode. In fill-to mode the dialed
    // value is the user's chosen TOTAL: re-seeding it from `current + PitSvFuel`
    // would silently lower the target as fuel burns (PitSvFuel is the last-sent
    // add, not the live gap). Continuous monitoring (below) + the live add
    // computation keep the request matched to the burning fuel (issue #681).
    if (ctx.settings.dialMode === "add-amount" && Date.now() - ctx.lastUserActivity >= USER_ACTIVITY_GRACE_MS) {
      const pitFuel = readPitSvFuel(telemetry);

      if (pitFuel !== undefined) {
        ctx.dialValueLtr = clampTargetLtr(pitFuel, this.effectiveMaxLtr());
      }
    }

    // Continuous fill-to monitoring (issue #681): while fuel-fill is ON in
    // fill-to mode, recompute the add from the LIVE fuel level on every tick and
    // re-broadcast only when the whole-DISPLAY-unit add actually changes (i.e.
    // about once per litre/gallon burned). The round-up keeps the request always
    // at/above target with no buffer. `computeAddLtr` returns the rounded-up need
    // as a clean whole display value (no headroom clamp), so the whole-unit key
    // only moves when the need crosses a whole-unit boundary — no sub-litre spam.
    // We never re-send when fuel-fill is OFF (the user's toggle-off is respected)
    // nor in add-amount mode (its add is fixed). The render-on-change path
    // pushes the resulting feedback — `sendFuel` here only updates the request.
    //
    // The `!lastPitWasClear` guard respects a deliberate clear during the telemetry
    // LAG window: right after a toggle-off (or an auto-clear when the add hits 0)
    // iRacing keeps reporting fuel-fill ON for a few ticks, while the clear nulls
    // `lastSentWholeAdd`. Without the guard the monitor would see "the add changed"
    // and re-broadcast `pit.fuel`, silently RE-ARMING the fueling the user just
    // turned off. `lastPitWasClear` stays set until fueling is genuinely re-armed
    // (our own `pit.fuel`, or an external fuel-fill OFF→ON edge), so the monitor
    // resumes the moment a real request exists again.
    //
    // `lastPitWasClear` is action-wide (one flag per FuelDial instance, shared by
    // every button/dial context) on purpose: all Fuel Dial buttons drive the SAME
    // single iRacing pit fuel request, so "the request was deliberately cleared" is
    // an action-wide fact, not a per-context one. With two fill-to dials targeting
    // the same request a clear on either correctly suppresses the other's re-arm
    // (last command wins, no ping-pong) — a per-context flag would have them fight
    // over the shared request every tick.
    if (ctx.settings.dialMode === "fill-to" && this.isFuelFillOn() && !this.lastPitWasClear) {
      const addLtr = this.effectiveAddLtr(ctx);
      const displayUnits = this.effectiveDisplayUnits(ctx);
      const wholeKey = addLtr <= 0 ? null : Math.round(fuelToDisplayUnits(addLtr, displayUnits));

      if (wholeKey !== ctx.lastSentWholeAdd) {
        this.sendFuel(addLtr);
        ctx.lastSentWholeAdd = wholeKey;
        // Keep the rotate/doPress throttle baseline in sync so its no-op
        // suppression stays consistent with what was actually broadcast.
        ctx.throttle.lastSentLtr = addLtr <= 0 ? null : addLtr;
        this.logger.debug(`Continuous fill-to: requested ${addLtr.toFixed(2)}L`);
      }
    }
  }

  private onTelemetry(ctx: FuelDialContext, telemetry: TelemetryData | null): void {
    // Release the no-double-clear guard on the fuel-fill OFF→ON edge: once fuel is
    // armed again (by us OR anything external — Fuel Service, the in-sim checkbox,
    // a `#fuel` macro), a later clear is meaningful and must not be skipped. Edge-
    // triggered so it never fires during the lag after our own clear (fuel reads
    // ON→OFF there, not OFF→ON).
    const fuelOn = isFuelFillOn(telemetry);

    if (fuelOn && !this.lastFuelFillObserved) this.lastPitWasClear = false;

    this.lastFuelFillObserved = fuelOn;

    // Manual-mode telemetry behaviours (dialed-value re-seed + continuous fill-to
    // re-broadcast) are skipped in autofuel mode — iRacing's autofuel owns the
    // fuel request there; the dial only mirrors PitSvFuel.
    if (!this.isAutofuelMode()) {
      this.updateManualFromTelemetry(ctx, telemetry);
    }

    // Render-on-CHANGE (issue #681): the band/bar colors and the displayed
    // values must track telemetry without the up-to-5s lag of the heartbeat
    // timer. When the DISPLAYED signature is UNCHANGED nothing renders at all —
    // the feedback already reflects the current state and the 5s heartbeat
    // still refreshes — so an unchanged tick never rebuilds the SVG or pushes an
    // image ~60×/s. When the signature changes, push feedback immediately,
    // throttled to at most once per CHANGE_RENDER_MIN_INTERVAL_MS so a burst of
    // ticks can't blow past the ≤10 setFeedback/sec/dial cap; while inside the
    // throttle window lastRenderSig is deliberately NOT advanced so the
    // throttled feedback still fires once the window elapses. The 5s timer
    // remains as a heartbeat.
    const sig = this.displayedSignature(ctx);

    if (sig !== ctx.lastRenderSig && Date.now() - ctx.lastChangeRenderAt >= CHANGE_RENDER_MIN_INTERVAL_MS) {
      ctx.lastRenderSig = sig;
      ctx.lastChangeRenderAt = Date.now();
      void this.renderFeedback(ctx);
    }
  }

  /**
   * A compact signature of the DISPLAYED state used by the render-on-change path:
   * the tri-state fueling indication (on/off/na — mode-gated, so in autofuel-off
   * it is constantly "na" and a checkbox flip alone doesn't re-render; the mode
   * element covers entering/leaving that state) plus the rounded current / add /
   * total values. When this string differs from the last rendered one, a
   * feedback push is due.
   *
   * In fill-to mode the displayed target (`dialValueLtr`, shown in the "→ <target>"
   * readout and the red target line) can change while the resolved add stays 0 —
   * dialing the target at/below current fuel leaves add at 0 but moves the marker.
   * The target is therefore appended only in fill-to mode so the readout refreshes
   * promptly instead of waiting for the 5 s heartbeat (issue #681). In add-amount
   * mode the displayed add is the live `PitSvFuel` (already captured via `addLtr`),
   * and the dialed value is not displayed, so it need not be in the signature (#726).
   */
  private displayedSignature(ctx: FuelDialContext): string {
    const displayUnits = this.effectiveDisplayUnits(ctx);
    const maxLtr = this.effectiveMaxLtr();
    const mode = this.displayMode();
    const currentLtr = this.currentLtr();
    const addLtr = this.displayAddLtr(ctx, mode);
    const totalLtr = computeTotalLtr(currentLtr, addLtr, maxLtr);

    return [
      mode,
      this.fuelFillState(mode),
      formatDisplayValue(currentLtr, displayUnits),
      formatDisplayValue(addLtr, displayUnits),
      formatDisplayValue(totalLtr, displayUnits),
      mode === "manual" && ctx.settings.dialMode === "fill-to"
        ? formatDisplayValue(ctx.dialValueLtr, displayUnits)
        : "",
      // So the key re-renders when the autofuel binding is set/cleared (#612).
      this.autofuelBindingMissing(ctx.settings) ? "warn" : "",
    ].join("|");
  }

  /**
   * Starts the periodic display-refresh timer for a context. While appeared it
   * re-renders the bar + value every DISPLAY_REFRESH_MS so the displayed add
   * (target − current in fill-to mode) and the live total track fuel burn without
   * pushing feedback on every telemetry tick. Acts as a heartbeat alongside the
   * render-on-change path in onTelemetry. Idempotent — never stacks.
   */
  private startDisplayTimer(ctx: FuelDialContext): void {
    if (ctx.displayTimer !== null) return;

    ctx.displayTimer = setInterval(() => {
      void this.renderFeedback(ctx);
    }, DISPLAY_REFRESH_MS);
  }

  private clearDisplayTimer(ctx: FuelDialContext): void {
    if (ctx.displayTimer !== null) {
      clearInterval(ctx.displayTimer);
      ctx.displayTimer = null;
    }
  }

  private clearTimers(ctx: FuelDialContext): void {
    this.clearDisplayTimer(ctx);

    if (ctx.throttle.timer !== null) {
      clearTimeout(ctx.throttle.timer);
      ctx.throttle.timer = null;
    }

    if (ctx.marginThrottle.timer !== null) {
      clearTimeout(ctx.marginThrottle.timer);
      ctx.marginThrottle.timer = null;
    }
  }

  /** Pushes the encoder trigger descriptions for a dial (Elgato only). */
  private async applyTriggerDescription(ctx: FuelDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.settings));
  }

  /**
   * Pushes the touch-strip feedback when this is a dial. The Fuel Dial is
   * encoder-only (no keypad — Fuel Service covers keys), so this is the
   * action's only render path.
   */
  private async renderFeedback(ctx: FuelDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (!ctx.action.isDial()) return;

    const displayUnits = this.effectiveDisplayUnits(ctx);
    const maxLtr = this.effectiveMaxLtr();
    const mode = this.displayMode();
    const currentLtr = this.currentLtr();
    const addLtr = this.displayAddLtr(ctx, mode);
    const totalLtr = computeTotalLtr(currentLtr, addLtr, maxLtr);
    const fillState = this.fuelFillState(mode);
    // The whole strip slot is ONE self-drawn pixmap (band + readout + bar) — the
    // built-in layout text items can't have the colored band background (#728).
    const canvasSvg = renderStripCanvasSvg(
      mode,
      ctx.settings.dialMode,
      fillState,
      currentLtr,
      addLtr,
      totalLtr,
      ctx.dialValueLtr,
      maxLtr,
      displayUnits,
      this.autofuelBindingMissing(ctx.settings),
    );
    const feedback: DeckFeedbackPayload = { box: svgToDataUri(canvasSvg) };
    await ctx.action.setFeedback(feedback);

    // Reset the change-detector baseline so a pushed feedback (rotate/press/
    // heartbeat) doesn't immediately re-fire the render-on-change path next tick.
    ctx.lastRenderSig = this.displayedSignature(ctx);
    ctx.lastChangeRenderAt = Date.now();
  }
}
