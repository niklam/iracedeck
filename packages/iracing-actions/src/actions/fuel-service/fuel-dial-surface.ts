/**
 * Fuel Service — dial surface (issue #759).
 *
 * The encoder half of the merged Fuel Service action, carried over from the
 * former Fuel Dial action (#681/#726/#728). Rotating sets either the amount to
 * add (add-amount mode) or the desired total after the stop (fill-to mode);
 * pressing/tapping runs a configurable gesture; the touch strip is one
 * self-drawn pixmap with the REFUEL/AUTOFUEL status band, a live readout, and
 * a two-segment fuel bar. All fuel communication goes through the shared
 * {@link FuelPipeline} (`pit.fuel` / `pit.clearFuel`).
 *
 * The surface holds the per-dial-context state; the owning FuelService action
 * routes `IDeck*` dial events here and provides telemetry/session/binding
 * access through {@link FuelDialHost}.
 */
import {
  createHoldPreview,
  type DeckTriggerDescription,
  type DirectionalPair,
  getDualPressThresholdMs,
  type HoldPreview,
  type IDeckActionContext,
  NOOP_HOLD_PREVIEW,
  resolvePairedAction,
  svgToDataUri,
} from "@iracedeck/deck-core";
import type { UnitSystem } from "@iracedeck/deck-core/display-units";
import {
  fuelFromDisplayUnits,
  fuelToDisplayUnits,
  isAutofuelActive,
  isAutofuelEnabled,
  isFuelFillOn,
  isPitstopActive,
  unitSystemOf,
} from "@iracedeck/deck-iracing";
import type { SessionInfo, TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";

import { borderColorForState } from "../../icons/status-bar.js";
import { pushDialNameIcon } from "../../shared/dial-name-icon.js";
import { persistDialPatch } from "../../shared/dial-persist.js";
import type { DialPendingPreview } from "../../shared/dial-preview.js";
import { classifyDialReleaseForHost } from "../../shared/dial-release.js";
import { type DialGestures, gestureSlots, ReleaseDialSurfaceBase } from "../../shared/dial-surface-base.js";
import {
  type DialDisplayMode,
  formatDisplayValue,
  type FuelFillState,
  renderFuelCanvasFor,
  WHITE,
} from "./fuel-dial-render.js";
import type { FuelPipeline } from "./fuel-pipeline.js";
import {
  type DialGestureSlot,
  type DialSettings,
  type FuelServiceSettings,
  LAP_MARGIN_DECREASE_KEY,
  LAP_MARGIN_INCREASE_KEY,
  resolveDisplayUnits,
  TOGGLE_AUTOFUEL_KEY,
} from "./fuel-service-settings.js";
import { type FuelStepper, type FuelStepResult, readPitSvFuel, readPlayerCarPath } from "./fuel-step.js";

/**
 * Push + Turn pair members — directional fuel endpoints dispatched per pressed
 * rotation. They are not offered as standalone gesture slots; they only appear
 * inside a {@link PUSH_TURN_PAIRS} pair.
 */
type PushTurnMember = "fill-full" | "no-fuel";

/** Anything {@link FuelDialSurface.doPress} can run (gesture slots minus "none", plus push+turn members). */
type GestureAction = Exclude<DialGestureSlot, "none"> | PushTurnMember;

/**
 * Trailing-throttle window for coalescing rapid rotations into a single
 * `pit.fuel` broadcast + touch-strip update. The first change fires
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
 * The command itself is sent by `FuelPipeline.sendNoFuel` (1 L then clear); this
 * just records the empty state so the toggle's next press detects "not at max"
 * and fills again.
 */
const TOGGLE_FULL_EMPTY_LTR = 0;

/**
 * The fuel step the continuous fill-to monitor assumes while the car's is
 * unknown (#1483): a whole liter, the finest step a whole-liter request can
 * resolve. A bank this far above the need is re-sent, so a whole-liter car
 * re-sends exactly when the rounded-up need differs from its bank, as before.
 */
const UNKNOWN_FUEL_STEP_LTR = 1;

/** A `PitSvFuel` difference smaller than this is float noise (as in the fuel step check). */
const BANK_EPSILON_LTR = 0.01;

/**
 * The "Push + Turn" pair for each `dial.pushTurnAction` value. The per-tick
 * dispatch goes through the shared {@link resolvePairedAction}. "none" maps to
 * `null` (no dispatch).
 */
const PUSH_TURN_PAIRS: Record<DialSettings["pushTurnAction"], DirectionalPair<GestureAction> | null> = {
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
  settings: FuelServiceSettings;
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
   * press. Set in rotate (pressed === true), read once at dialUp to
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
   * Whole-DISPLAY-unit key of the add at the last Target Amount send or
   * continuous fill-to evaluation, or null when nothing is armed. The
   * continuous monitor evaluates only when the live add's key moves off this
   * one, so at most once per whole unit: `computeAddLtr` returns the add
   * rounded UP to a whole display unit (no fractional headroom clamp), so the
   * key only moves when the rounded-up need crosses a whole-unit boundary —
   * never sub-litre spam (issue #681). Whether an evaluation SENDS anything
   * depends on what is banked (#1483, see `updateManualFromTelemetry`).
   */
  lastSentWholeAdd: number | null;
  /**
   * The bank (`PitSvFuel`, liters) a Target Amount step ended at when it could
   * not reach its floor (`unmoved`), or null (#1483). Within the same key the
   * continuous monitor does not re-send a bank still equal to this, instead of
   * repeating a nine-send burst on every tick. Cleared when the bank moves, when
   * the need's whole-unit key changes (so a bank stuck by a passing cause, such
   * as commands ignored out of the car, is retried once per whole unit) and by
   * every new Target Amount send.
   */
  unreachableBankLtr: number | null;
  /** Counts Target Amount sends, so only the latest one's end sets {@link unreachableBankLtr}. */
  fillToSends: number;
  /**
   * The floor (liters) the bank was last checked against: set when a Target
   * Amount step starts and when the monitor finds the bank covering a new key,
   * null when nothing is armed (#1483). The monitor re-sends on any tick while
   * the live bank is short of it, but compares against this recorded value
   * rather than the live floor, which moves every tick as fuel burns once it
   * is capped at the space left — so a short bank is acted on at once without
   * a send per tick of burn.
   */
  checkedFloorLtr: number | null;
  throttle: ThrottleState;
  /** Coalescing state for autofuel lap-margin keybind taps. */
  marginThrottle: MarginThrottleState;
  /**
   * The long-press outcome the strip is previewing (#1120), or null when no
   * hold is past the threshold. Read by EVERY render path — the 5 s heartbeat
   * and the render-on-change tick included — so a preview survives a mid-hold
   * refresh and the revert is simply "render normally again".
   */
  preview: DialPendingPreview | null;
  /** The display-only hold-preview timer for this context (a no-op off Elgato). */
  holdPreview: HoldPreview;
}

/**
 * What the dial surface needs from the owning action: scoped logging, live
 * telemetry/session access, and the base-class binding delegates (which must
 * stay on the action so #612 warning semantics are unchanged).
 */
export interface FuelDialHost {
  readonly logger: ILogger;
  getTelemetry(): TelemetryData | null;
  getSessionInfo(): SessionInfo | null;
  tapBinding(settingKey: string): Promise<boolean>;
  isBindingMissing(keys: string | string[] | null | undefined): boolean;
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
 * Derives the tri-state fueling indication from the display mode and live
 * telemetry. N/A when autofuel is engaged but unavailable (`autofuel-off` —
 * there is no controllable fuel request) or when there is no telemetry at all
 * (unknown must not read as OFF — mirrors the keypad toggle's N/A). Otherwise
 * the live pit fuel-fill checkbox decides on/off.
 */
export function resolveFuelFillState(mode: DialDisplayMode, telemetry: TelemetryData | null): FuelFillState {
  if (mode === "autofuel-off") return "na";

  if (!telemetry) return "na";

  return isFuelFillOn(telemetry) ? "on" : "off";
}

/**
 * @internal Exported for testing
 *
 * Derives the dial display mode from live telemetry. The dial is modal:
 * `dpFuelAutoFillActive` selects manual vs autofuel, and `dpFuelAutoFillEnabled`
 * downgrades an engaged autofuel to "autofuel-off" (unavailable for this
 * car/series, mirroring the keypad toggle's N/A). It never fabricates a
 * combination — it reflects exactly what telemetry reports.
 */
export function resolveDialDisplayMode(telemetry: TelemetryData | null): DialDisplayMode {
  if (!isAutofuelActive(telemetry)) return "manual";

  return isAutofuelEnabled(telemetry) ? "autofuel" : "autofuel-off";
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
 * The fuel the next stop will add under autofuel, for the `AUTO → <add>`
 * readout and the bar's add segment: autofuel's requested add (`PitSvFuel`)
 * while the fuel-fill checkbox is on, and 0 while it is unchecked — the stop
 * then adds nothing whatever autofuel requested. The status band says
 * `AUTOFUEL: ON` in both cases, so this readout is the only place the dial
 * shows that fueling is off (#1226).
 */
export function resolveAutofuelAddLtr(telemetry: TelemetryData | null): number {
  if (!isFuelFillOn(telemetry)) return 0;

  return Math.max(0, readPitSvFuel(telemetry) ?? 0);
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
 *   UP to the next whole DISPLAY unit, so a stop that takes the whole add never
 *   finishes below the (integer) target. The round-up alone does not make the
 *   stop TAKE that much: iRacing banks a request on the car's fuel grid, rounding
 *   to the nearest point, and on a gallon car that point can sit below the add.
 *   So this add is the FLOOR the Target Amount send hands the fuel step check,
 *   which steps up until the bank covers it (#1483). The add is NOT clamped to
 *   the remaining tank space: it is simply the amount needed to reach the target,
 *   and may exceed the CURRENT remaining space because more fuel burns before the
 *   pit stop (iRacing only fills up to the tank capacity anyway). Because the add
 *   is recomputed against the LIVE fuel level on every telemetry tick (continuous
 *   monitoring), it stays fresh as fuel burns and needs no extra safety buffer.
 *   The unclamped add is always a clean whole display value, so the monitor's
 *   whole-unit key moves at most once per whole unit. When the need is ≤ 0
 *   (target at/below current) the add stays 0 so the "0 → clearFuel" path still
 *   fires (issue #681).
 */
export function computeAddLtr(
  dialMode: DialSettings["mode"],
  dialValueLtr: number,
  currentLtr: number,
  maxLtr: number | undefined,
  displayUnits: number,
): number {
  if (dialMode === "fill-to") {
    const rawAdd = Math.max(0, dialValueLtr - currentLtr);
    // Round the ADD up to the next whole display unit so current + add is at or
    // just above the integer target; the Target Amount send makes it a floor the
    // bank must reach (#1483), so a stop never finishes under target. The add
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
 * The "Toggle Full / No Fuel" side test: whether the dialed value already sits
 * at the tank capacity (within half a litre), so the next invocation is the
 * NO FUEL side. One predicate shared by the press itself and the hold preview
 * (#1120), so the preview can never disagree with what the release does.
 */
export function isAtMaxRequest(dialValueLtr: number, maxLtr: number): boolean {
  return dialValueLtr >= maxLtr - 0.5;
}

/** What {@link resolveHoldPreview} needs to know about the dial and the sim. */
export interface HoldPreviewInputs {
  /** Live telemetry, or null when there is none — with none, no fuel state is knowable. */
  telemetry: TelemetryData | null;
  dialMode: DialSettings["mode"];
  /** The dialed value (liters) — the add in add-amount mode, the target in fill-to. */
  dialValueLtr: number;
  /** Effective tank capacity (liters), or undefined when unknown. */
  maxLtr: number | undefined;
  displayUnits: number;
  /** Whether the autofuel key binding is required by a gesture slot but unset (#612). */
  autofuelBindingMissing: boolean;
}

/**
 * @internal Exported for testing
 *
 * The outcome a long-press gesture will have if the dial is released now, as
 * the short text and colour the strip previews once the hold passes the
 * threshold (#1120) — or `null` when that outcome is not genuinely knowable,
 * in which case the strip shows nothing and nothing is armed.
 *
 * Each case mirrors {@link FuelDialSurface.doPress} exactly, including its
 * escape hatches, so the preview is a promise the release keeps:
 *
 * - `toggle-fueling`: fueling ON → it will be cleared (`FUEL OFF`); fueling OFF
 *   → it will be armed with the resolved add (`FUEL ON`) — but an add of 0
 *   clears instead of arming, so previewing ON there would be a lie, and a
 *   press that leaves fueling off has no change to show. No telemetry, or an
 *   N/A state (autofuel engaged but unavailable), is not readable at all.
 * - `fill-to-max`: unknown capacity → the press warns and skips → nothing. At
 *   capacity ({@link isAtMaxRequest}) → the NO FUEL side. Otherwise the FULL
 *   side — unless the add it would arm (dialed at capacity) resolves to 0, the
 *   same clear-instead-of-arm case as above.
 * - `toggle-autofuel-mode`: flips iRacing's autofuel through its key binding;
 *   nothing when the binding is unset (the tap goes nowhere) or autofuel is
 *   unavailable for this car (the sim ignores the key).
 * - `switch-mode`: flips the manual dial mode; owned by the plugin, so always
 *   knowable — even without telemetry.
 * - `none`: nothing.
 *
 * The colours are the band's own tri-state language — green for a state that
 * will be ON, red for one that will be OFF — so a preview reads like the band
 * it sits under. The mode switch is not a state and stays in the readout's white.
 */
export function resolveHoldPreview(gesture: DialGestureSlot, inputs: HoldPreviewInputs): DialPendingPreview | null {
  const { telemetry, dialMode, dialValueLtr, maxLtr, displayUnits, autofuelBindingMissing } = inputs;
  const on = borderColorForState("on");
  const off = borderColorForState("off");

  switch (gesture) {
    case "none":
      return null;

    case "switch-mode":
      return { text: dialMode === "fill-to" ? "ADD AMOUNT" : "TARGET", color: WHITE };

    case "toggle-autofuel-mode": {
      if (!telemetry || autofuelBindingMissing || !isAutofuelEnabled(telemetry)) return null;

      return isAutofuelActive(telemetry) ? { text: "AUTO OFF", color: off } : { text: "AUTO ON", color: on };
    }

    case "toggle-fueling": {
      const fillState = resolveFuelFillState(resolveDialDisplayMode(telemetry), telemetry);

      if (fillState === "na") return null;

      if (fillState === "on") return { text: "FUEL OFF", color: off };

      const addLtr = computeAddLtr(dialMode, dialValueLtr, readFuelLevel(telemetry), maxLtr, displayUnits);

      return addLtr > 0 ? { text: "FUEL ON", color: on } : null;
    }

    case "fill-to-max": {
      if (maxLtr === undefined) return null;

      const fillState = resolveFuelFillState(resolveDialDisplayMode(telemetry), telemetry);

      if (fillState === "na") return null;

      if (isAtMaxRequest(dialValueLtr, maxLtr)) return { text: "NO FUEL", color: off };

      const addLtr = computeAddLtr(dialMode, maxLtr, readFuelLevel(telemetry), maxLtr, displayUnits);

      return addLtr > 0 ? { text: "FULL", color: on } : null;
    }
  }
}

/** Human-readable label for a gesture slot (for trigger descriptions). */
function actionLabel(action: DialGestureSlot): string {
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
 * Computes the encoder trigger descriptions from the current dial settings.
 *
 * The Elgato SDK fields describe specific gestures: `rotate` (dial rotation),
 * `push` (dial button press), `touch` (touchscreen tap) and `longTouch`
 * (touchscreen LONG tap). The dial-button LONG PRESS has no dedicated SDK field,
 * so it rides on the `push` label as a "(hold: …)" hint; the touchscreen long
 * tap (Long Touch slot) maps to `longTouch`.
 */
export function buildTriggerDescription(dial: DialSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = {
    rotate: dial.mode === "fill-to" ? "Adjust target / autofuel margin" : "Adjust fuel / autofuel margin",
  };

  const pushLabel = dial.pressAction === "none" ? undefined : actionLabel(dial.pressAction);
  const holdLabel = dial.longPressAction === "none" ? undefined : actionLabel(dial.longPressAction);

  if (pushLabel && holdLabel) {
    description.push = `${pushLabel} (hold: ${holdLabel})`;
  } else if (pushLabel) {
    description.push = pushLabel;
  } else if (holdLabel) {
    description.push = `Hold: ${holdLabel}`;
  }

  if (dial.tapAction !== "none") {
    description.touch = actionLabel(dial.tapAction);
  }

  if (dial.longTouchAction !== "none") {
    description.longTouch = actionLabel(dial.longTouchAction);
  }

  return description;
}

/**
 * The dial surface of the merged Fuel Service action. One instance per
 * FuelService instance; holds every dial context's runtime state and all
 * dial-side behavior. The owning action routes events here after parsing
 * settings, and forwards telemetry ticks per subscribed context.
 */
export class FuelDialSurface extends ReleaseDialSurfaceBase<FuelDialContext, FuelServiceSettings> {
  constructor(
    protected override readonly host: FuelDialHost,
    private readonly pipeline: FuelPipeline,
    /**
     * The action's fuel step check (#1314), shared with the keypad: Add Amount
     * sends through its move rule, Target Amount through its floor rule (#1483).
     */
    private readonly stepper: FuelStepper,
  ) {
    super();
  }

  async willAppear(action: IDeckActionContext, settings: FuelServiceSettings): Promise<void> {
    const ctx = this.ensureContext(action, settings);
    ctx.settings = settings;
    // Seed the dialed value from current pit fuel request on appear.
    this.seedFromTelemetry(ctx, true);

    // The deck-app image for the dial: just the action name (#775). Without
    // this the app falls back to keypad iconography for the dial slot.
    pushDialNameIcon(action, { line1: "FUEL", line2: "SERVICE", backgroundColor: "#3a2a2a" }, this.host.logger);

    // Start the periodic display refresh so the bar + value track live burn.
    this.startDisplayTimer(ctx);
    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  willDisappear(actionId: string): void {
    const ctx = this.contextsState.get(actionId);

    if (ctx) {
      this.clearTimers(ctx);
    }

    this.forgetContext(actionId);
  }

  async didReceiveSettings(action: IDeckActionContext, settings: FuelServiceSettings): Promise<void> {
    const ctx = this.ensureContext(action, settings);
    const previousMode = ctx.settings.dial.mode;
    ctx.settings = settings;

    // A Mode change in the Property Inspector re-seeds the dialed value for the
    // new mode, as the switch-mode gesture does (#1483). Without it the old
    // value carried over: an Add Amount of a few liters became a Target Amount
    // TOTAL below the fuel in the tank, so the request cleared and every detent
    // moved a target still under the tank level, as if the choice were ignored.
    if (settings.dial.mode !== previousMode) {
      this.clearModeBaselines(ctx);
      this.seedFromTelemetry(ctx, true);
    }

    // The settings may have changed the long-press gesture mid-hold, so a
    // preview computed for the old one is dropped without a revert frame of its
    // own — the re-render below IS the revert (#1120).
    ctx.holdPreview.dispose();
    ctx.preview = null;

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  /**
   * Forgets what the previous mode sent, before a Mode change re-seeds the dial
   * (#1483). Each baseline describes a request of the OLD mode: the floor and
   * the unreachable bank of a Target Amount request, and the whole-unit key and
   * the rotate throttle's no-op value, which Add Amount records too. Left in
   * place, a new Target Amount need that lands on the same key would read as
   * already evaluated, and a bank short of it would not be re-sent until the
   * need moved a whole unit.
   */
  private clearModeBaselines(ctx: FuelDialContext): void {
    ctx.checkedFloorLtr = null;
    ctx.unreachableBankLtr = null;
    ctx.lastSentWholeAdd = null;
    ctx.throttle.lastSentLtr = null;
  }

  async rotate(
    action: IDeckActionContext,
    settings: FuelServiceSettings,
    ticks: number,
    pressed: boolean,
  ): Promise<void> {
    const ctx = this.inputContext(action, settings, "rotate");

    if (!ctx) return;

    // Everything below reads ctx.settings, never the event payload (see refreshContext).
    const dial = ctx.settings.dial;

    // Push + Turn: a pressed rotation dispatches the configured bidirectional
    // pair (cw on a positive tick sign, ccw on a negative one) and sets the guard
    // so the dialUp classifier pre-empts both press actions. It does NOT adjust
    // the bare-turn primary. The "full-empty" pair maps CW → fill full,
    // CCW → no fuel; "none" dispatches nothing.
    if (pressed) {
      ctx.rotatedWhilePressed = true;
      // The hold is now a push+turn, so the release will fire nothing: revert
      // the hold preview at once (#1120). Deliberately beside the guard and
      // before the zero-tick resolve below, so a zero-tick pressed rotate —
      // which already makes the release a no-op — also takes the preview down.
      ctx.holdPreview.rotated();

      // Push+turn is an extended gesture: where those are compiled out (Mirabox,
      // Ulanzi) a pressed rotation keeps only the guard above — its release
      // fires nothing — and dispatches no pair.
      if (!__FEATURE_DIAL_EXTENDED_GESTURES__) return;

      const gesture = resolvePairedAction(PUSH_TURN_PAIRS[dial.pushTurnAction], ticks);

      if (gesture) {
        await this.doPress(gesture, ctx);
      }

      return;
    }

    // Bare turn in AUTOFUEL mode adjusts the autofuel lap margin via key bindings
    // (coalesced so a fast spin doesn't flood the black box). The readout settles
    // a beat later from PitSvFuel — there is no margin value in telemetry.
    const mode = this.displayMode();

    if (mode === "autofuel") {
      ctx.lastUserActivity = Date.now();
      this.adjustLapMargin(ctx, ticks);

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
    const stepLtr = fuelFromDisplayUnits(dial.stepSize, displayUnits);
    const upperBound = this.effectiveMaxLtr();
    let nextValue = ctx.dialValueLtr + ticks * stepLtr;

    if (dial.mode === "fill-to") {
      nextValue = roundToWholeDisplayLtr(nextValue, displayUnits);
    }

    ctx.dialValueLtr = clampTargetLtr(nextValue, upperBound);
    ctx.lastUserActivity = Date.now();
    this.host.logger.debug(
      `Dial=${ctx.dialValueLtr.toFixed(2)}L (${dial.mode}), ticks=${ticks}, step=${stepLtr.toFixed(2)}L`,
    );

    // Rotating issues pit.fuel (auto-arm). The touch-strip feedback (and the
    // pit.fuel broadcast) are throttled via the send window so a continuous spin
    // can't exceed the ≤10 setFeedback/sec/dial cap — flushSend issues the
    // broadcast + feedback at the window edges, so nothing renders per-event.
    this.scheduleSend(ctx);
  }

  down(action: IDeckActionContext, settings: FuelServiceSettings): void {
    const ctx = this.inputContext(action, settings, "down");

    if (!ctx) return;

    // Record the press start and clear the push+turn guard. Fire NOTHING and
    // start NO dispatch timer — press vs long-press is classified once at dialUp.
    ctx.pressStart = Date.now();
    ctx.rotatedWhilePressed = false;

    // The one timer this arms only DRAWS (#1120): at the long-press threshold
    // the strip previews what releasing now will do. Execution stays at dialUp.
    ctx.holdPreview.down();
  }

  async up(actionId: string, rawSettings?: unknown): Promise<void> {
    const ctx = this.contextsState.get(actionId);

    if (!ctx) return;

    // Disarm the hold preview and revert a showing one FIRST — before every
    // early return below, since a stray release, a push+turn and a `none`
    // gesture all still need the strip put back (#1120).
    ctx.holdPreview.up();

    // Consume the press start immediately so a stray dialUp without a preceding
    // dialDown (e.g. the context was recreated while the button was held) can't
    // reclassify. A 0 sentinel means "no press in progress" — fire nothing; else
    // `nowMs - 0` would read as a huge elapsed time and misfire the long press.
    const pressStartMs = ctx.pressStart;
    ctx.pressStart = 0;

    if (pressStartMs === 0) return;

    // Classify the release with full information (duration + the rotated guard),
    // so long-press never races push+turn. No timer fired mid-hold. Where
    // the extended gestures are compiled out a release is never long: a knob
    // press never reports its release (`classifyDialReleaseForHost`).
    const kind = classifyDialReleaseForHost({
      pressStartMs,
      nowMs: Date.now(),
      rotatedWhilePressed: ctx.rotatedWhilePressed,
      // Honor the plugin-wide "Long-press threshold" global setting (shared with
      // the dual-press feature); falls back to DIAL_LONG_PRESS_THRESHOLD_MS.
      thresholdMs: getDualPressThresholdMs(),
    });

    if (kind === "push-turn") return;

    const gesture = kind === "long" ? ctx.settings.dial.longPressAction : ctx.settings.dial.pressAction;

    if (gesture === "none") return;

    this.host.logger.info(kind === "long" ? "Fuel dial long-pressed" : "Fuel dial pressed");
    await this.doPress(gesture, ctx, rawSettings);
  }

  async touchTap(
    action: IDeckActionContext,
    settings: FuelServiceSettings,
    hold: boolean,
    rawSettings?: unknown,
  ): Promise<void> {
    if (!__FEATURE_DIAL_EXTENDED_GESTURES__) return;

    // Read the gesture from ctx.settings, not the event payload — the same
    // stale-settings model `up()` follows (see refreshContext).
    const ctx = this.inputContext(action, settings, "touchTap");

    if (!ctx) return;

    // hold === true → Long Touch slot; hold === false → Tap Display slot.
    const gesture = hold ? ctx.settings.dial.longTouchAction : ctx.settings.dial.tapAction;

    if (gesture === "none") return;

    this.host.logger.info(hold ? "Fuel dial long touch" : "Fuel dial tap");
    await this.doPress(gesture, ctx, rawSettings);
  }

  /**
   * Runs the configured press action against the LIVE pit fuel-fill state and
   * re-renders. Toggle reads the real checkbox each time so it correctly
   * alternates between requesting fuel and clearing it.
   */
  private async doPress(gesture: GestureAction, ctx: FuelDialContext, rawSettings?: unknown): Promise<void> {
    // Toggle autofuel mode: flip iRacing's autofuel via its key binding. The dial
    // re-derives manual vs autofuel from the resulting dpFuelAutoFillActive
    // telemetry, so there is no local mode flag to keep in sync.
    if (gesture === "toggle-autofuel-mode") {
      this.host.logger.info("Fuel dial toggled autofuel");
      await this.host.tapBinding(TOGGLE_AUTOFUEL_KEY);
      await this.renderFeedback(ctx);

      return;
    }

    // Switch the manual dial mode between Add Amount and Target Amount. Persists
    // so it sticks and the Property Inspector reflects it; re-seeds the dialed
    // value for the new mode and re-renders.
    if (gesture === "switch-mode") {
      const next = ctx.settings.dial.mode === "fill-to" ? "add-amount" : "fill-to";
      this.host.logger.info(`Fuel dial switched mode to ${next}`);

      // The host never echoes a plugin-side setSettings back as
      // didReceiveSettings, so ctx.settings is what the next gesture flips
      // from — and it flips BEFORE the write is awaited, so a second press
      // landing while the write is in flight flips back rather than repeating
      // this one (#957).
      ctx.settings = { ...ctx.settings, dial: { ...ctx.settings.dial, mode: next } };
      this.clearModeBaselines(ctx);
      await persistDialPatch(ctx.action, rawSettings, { mode: next }, this.host.logger, "mode switch");
      this.seedFromTelemetry(ctx, true);
      await this.applyTriggerDescription(ctx);
      await this.renderFeedback(ctx);

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

    switch (gesture) {
      case "toggle-fueling":
        if (fuelOn) {
          this.pipeline.clearFuel();
          cleared = true;
          this.host.logger.debug("Toggle: cleared fueling");
        } else {
          const addLtr = this.effectiveAddLtr(ctx);
          this.sendPressAdd(ctx, addLtr);
          // A resolved add of 0 clears instead of arming — keep bookkeeping in sync.
          cleared = addLtr <= 0;
          armedLtr = cleared ? null : addLtr;
          this.host.logger.debug(`Toggle: requested ${addLtr.toFixed(2)}L`);
        }

        break;

      case "fill-to-max": {
        const maxLtr = this.effectiveMaxLtr();

        if (maxLtr === undefined) {
          // No tank capacity to fill to — don't send a stale/zero target or arm.
          this.host.logger.warn("Toggle full/no fuel: tank capacity unknown, skipping");

          return;
        }

        // "Toggle Full / No Fuel" is a TOGGLE. The dialed value is set to the FULL
        // tank capacity (add-mode: capacity as the add; fill-to: capacity as the
        // target). A second invocation while already at max empties the request.
        const atMax = isAtMaxRequest(ctx.dialValueLtr, maxLtr);

        if (atMax) {
          // No Fuel side — reduce the request by the full tank so the requested
          // amount drops to 0 (see FuelPipeline.sendNoFuel).
          ctx.dialValueLtr = TOGGLE_FULL_EMPTY_LTR;
          this.pipeline.sendNoFuel();
          cleared = true;
          armedLtr = null;
          this.host.logger.debug("Toggle full/no fuel (no fuel): reduced by max");
        } else {
          ctx.dialValueLtr = maxLtr;
          const addLtr = this.effectiveAddLtr(ctx);
          this.sendPressAdd(ctx, addLtr);
          cleared = addLtr <= 0;
          armedLtr = cleared ? null : addLtr;
          this.host.logger.debug(`Toggle full/no fuel (full): requested ${addLtr.toFixed(2)}L`);
        }

        break;
      }

      case "fill-full": {
        // Push + Turn CW — always fill the tank to capacity (directional, not a toggle).
        const maxLtr = this.effectiveMaxLtr();

        if (maxLtr === undefined) {
          this.host.logger.warn("Push+turn full: tank capacity unknown, skipping");

          return;
        }

        ctx.dialValueLtr = maxLtr;
        const addLtr = this.effectiveAddLtr(ctx);
        this.sendPressAdd(ctx, addLtr);
        cleared = addLtr <= 0;
        armedLtr = cleared ? null : addLtr;
        this.host.logger.debug(`Push+turn full: requested ${addLtr.toFixed(2)}L`);
        break;
      }

      case "no-fuel": {
        // Push + Turn CCW — empty the request by reducing it by the full tank.
        ctx.dialValueLtr = TOGGLE_FULL_EMPTY_LTR;
        this.pipeline.sendNoFuel();
        cleared = true;
        armedLtr = null;
        this.host.logger.debug("Push+turn no fuel: reduced by max");
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

    // Both modes go through the fuel step check. Add Amount by its move rule
    // (#1314): a detent smaller than the car's fuel step rounds back in iRacing,
    // so the check steps further. Target Amount by its floor rule (#1483): the
    // add is the least the stop must take, and iRacing may bank the grid point
    // below it. A target of 0 keeps its clear (below).
    if (ctx.settings.dial.mode === "add-amount" && target > 0) {
      this.sendAddAmountStep(ctx, target);

      return;
    }

    if (ctx.settings.dial.mode === "fill-to" && target > 0) {
      this.sendFillToStep(ctx, target);
      void this.renderFeedback(ctx);

      return;
    }

    this.pipeline.sendFuel(target);
    ctx.throttle.lastSentLtr = target;
    // Keep the continuous fill-to monitor's per-litre re-send gate in sync with
    // what was just broadcast (mirrors doPress). Without this, the first telemetry
    // tick after a fill-to rotate sees a stale `lastSentWholeAdd` and emits one
    // redundant `pit.fuel` (issue #681).
    const displayUnits = this.effectiveDisplayUnits(ctx);
    ctx.lastSentWholeAdd = target <= 0 ? null : Math.round(fuelToDisplayUnits(target, displayUnits));
    this.host.logger.info("Fuel request sent");
    this.host.logger.debug(`Sent ${target.toFixed(2)}L`);
    void this.renderFeedback(ctx);
  }

  /**
   * Sends a press's resolved add (`doPress`): a Target Amount add through the
   * fuel step check's floor rule (#1483), anything else — an Add Amount add, or
   * an add of 0, which clears — straight through the pipeline, as before.
   */
  private sendPressAdd(ctx: FuelDialContext, addLtr: number): void {
    if (ctx.settings.dial.mode === "fill-to" && addLtr > 0) {
      this.sendFillToStep(ctx, addLtr);

      return;
    }

    this.pipeline.sendFuel(addLtr);
  }

  /**
   * The one Target Amount send path (#1483): hands the fuel step check a FLOOR —
   * the stop must add at least the add — and the check steps a whole liter up
   * while the bank is below it, so a car whose fuel step is coarser than a
   * liter cannot round the request down to the grid point under the target.
   * Used by a fill-to rotation (`flushSend`), the arming presses (`doPress`) and
   * the continuous fill-to monitor.
   *
   * The floor is resolved when the step STARTS — the dialed target against the
   * live fuel level at that moment — because a send arriving while another
   * check runs waits in the stepper's queue. A floor that has dropped to zero
   * by then (the target reached meanwhile), or a dial switched to Add Amount,
   * sends nothing: the monitor clears at its next evaluation, since the key
   * recorded here is no longer the live one.
   *
   * `addLtr` is the add at handover: the rotate throttle's no-op baseline and
   * the monitor's whole-unit key are recorded from it at once, so a tick while
   * the step runs or waits does not send it again.
   *
   * The floor is capped at the space left in the tank ({@link fillToFloorLtr})
   * and recorded in `ctx.checkedFloorLtr` when the step starts. A step that
   * still ends `unmoved` leaves the bank it ended at in `ctx.unreachableBankLtr`,
   * so the monitor does not repeat the burst within the same need (see
   * `updateManualFromTelemetry`); every new send clears it, and only the
   * latest send's end may set it, so an older step ending late cannot.
   *
   * `source` says who sent: a monitor step logs its end at debug only, since
   * the monitor re-sends as fuel burns, while a rotation or press logs the
   * user-facing info line.
   */
  private sendFillToStep(ctx: FuelDialContext, addLtr: number, source: "user" | "monitor" = "user"): void {
    ctx.throttle.lastSentLtr = addLtr;
    ctx.lastSentWholeAdd = Math.round(fuelToDisplayUnits(addLtr, this.effectiveDisplayUnits(ctx)));
    ctx.unreachableBankLtr = null;
    ctx.fillToSends += 1;
    const send = ctx.fillToSends;
    // Debug only: the step may yet be queued and superseded without sending
    // anything. The info line comes from the end handler, once it has sent.
    this.host.logger.debug(`Target Amount ${addLtr.toFixed(2)}L handed to the fuel step check`);

    void this.stepper.sendFuelStep(
      () => {
        if (ctx.settings.dial.mode !== "fill-to") return null;

        const floorLtr = this.fillToFloorLtr(this.effectiveAddLtr(ctx));

        if (!(floorLtr > 0)) return null;

        ctx.checkedFloorLtr = floorLtr;

        return { floorLtr };
      },
      (result) => {
        if (result.outcome === "unmoved" && result.endLtr !== undefined && send === ctx.fillToSends) {
          ctx.unreachableBankLtr = result.endLtr;
        }

        this.logStepEnd("Target Amount", result, source === "monitor");
      },
    );
  }

  /**
   * The floor a Target Amount add is checked against (#1483): the add, capped
   * at the SPACE left in the tank (capacity − current) when the capacity is
   * known. The add is rounded up to a whole display unit, so it can exceed that
   * space by up to one unit (Fill to Max at 30.4 L of a 40 L tank asks for 10,
   * with 9.6 L of room); if the sim caps the request at the space, or at the
   * tank, a floor above it is one no bank can reach, and the step would end
   * `unmoved` short of a fill the stop could have made. The target is clamped
   * to the capacity, so the raw need (target − current) never exceeds the
   * space: the capped floor is never below what the target needs, and is
   * reachable whichever way the sim caps.
   */
  private fillToFloorLtr(addLtr: number): number {
    const maxLtr = this.effectiveMaxLtr();

    return maxLtr === undefined ? addLtr : Math.min(addLtr, Math.max(0, maxLtr - this.currentLtr()));
  }

  /**
   * Sends an Add Amount rotation through the fuel step check (#1314). The
   * request is resolved when the step STARTS — from the dialed value at that
   * moment, against the live `PitSvFuel` — because a rotation that arrives while
   * another check runs waits in the stepper's queue and must run from the
   * baseline that check left. The direction is the request's side of that
   * baseline, which is the rotation's direction, decided in whole liters — what
   * the stepper actually sends: a request that rounds to the banked amount is
   * sent once without a check, so a turn still arms fueling as it always has.
   */
  private sendAddAmountStep(ctx: FuelDialContext, target: number): void {
    ctx.throttle.lastSentLtr = target;
    ctx.lastSentWholeAdd = Math.round(fuelToDisplayUnits(target, this.effectiveDisplayUnits(ctx)));
    // Debug only: the step may yet be queued and superseded without sending
    // anything. The info line comes from onAddAmountStepEnd, once it has sent.
    this.host.logger.debug(`Add Amount ${target.toFixed(2)}L handed to the fuel step check`);

    // The dialed add when the step started, kept fractional: the re-base in
    // onAddAmountStepEnd measures detents turned since against it, not
    // against the rounded request.
    let startLtr: number | null = null;

    void this.stepper.sendFuelStep(
      (baselineLtr) => {
        startLtr = this.effectiveAddLtr(ctx);
        const requestLtr = Math.round(startLtr);
        const bankLtr = Math.round(baselineLtr);
        const direction = requestLtr > bankLtr ? "add" : requestLtr < bankLtr ? "reduce" : null;

        return { direction, firstLtr: requestLtr };
      },
      (result) => this.onAddAmountStepEnd(ctx, startLtr, result),
    );
    void this.renderFeedback(ctx);
  }

  /**
   * Re-bases the dial on what an Add Amount step left banked (#1314). After a
   * step that escalated, `PitSvFuel` is past the dialed value — on the MX-5 a
   * one-liter detent banks a whole gallon — and the dialed value must follow it,
   * or the next clockwise detent (dialed value + step) would sit BELOW the bank
   * and lower the request. Detents turned while the check ran are kept on top
   * of the bank, so the queued step (which reads the dialed value when it
   * starts) runs from the new baseline. The rotate throttle's no-op baseline
   * (`lastSentLtr`) moves to the settled value only when nothing was turned
   * meanwhile; otherwise it keeps the last handed-over target, so a trailing
   * flush still sends the extra detents. An emptied request (a reduce stepping
   * past the last step, sent as 1 L + clear) settles at 0 with the baselines
   * nulled, as every clear does. `pipeline.lastPitWasClear` needs nothing: it
   * already reflects the step's last command (`pit.fuel` or the clear).
   *
   * A step whose own request landed (no extra liters, so every whole-liter car)
   * leaves the dial exactly as before #1314: the dialed value keeps its
   * fraction — a 1 gal step on a liter car still adds 3.785 L per detent over a
   * spin, not the whole liters each rounded send banks.
   *
   * `startLtr` is the dialed add when the step started (null when it never
   * started), the fractional value the detents turned since are measured from.
   */
  private onAddAmountStepEnd(ctx: FuelDialContext, startLtr: number | null, result: FuelStepResult): void {
    this.logStepEnd("Add Amount", result);

    // Switched to Fill To while the check ran: the switch sends no pipeline
    // command, so it cancelled nothing, and its re-seed has already set the
    // dialed value to a TOTAL. Re-basing an add on top of it would be wrong.
    if (ctx.settings.dial.mode !== "add-amount") return;

    const steppedPast = result.outcome === "landed" && result.extraLtr > 0;

    if (!steppedPast && result.outcome !== "unmoved" && result.outcome !== "emptied") return;

    if (startLtr === null) return;

    const turnedSinceLtr = ctx.dialValueLtr - startLtr;
    const bankedLtr = result.outcome === "emptied" ? 0 : (result.endLtr ?? result.baselineLtr ?? 0);
    ctx.dialValueLtr = clampTargetLtr(bankedLtr + turnedSinceLtr, this.effectiveMaxLtr());

    if (result.outcome === "emptied" && turnedSinceLtr === 0) {
      ctx.throttle.lastSentLtr = null;
      ctx.lastSentWholeAdd = null;

      return;
    }

    if (turnedSinceLtr === 0) {
      const settledLtr = this.effectiveAddLtr(ctx);
      ctx.throttle.lastSentLtr = settledLtr;
      ctx.lastSentWholeAdd =
        settledLtr <= 0 ? null : Math.round(fuelToDisplayUnits(settledLtr, this.effectiveDisplayUnits(ctx)));
    }
  }

  /**
   * Logs what a dial step (Add Amount or Target Amount) sent, at info only when
   * it sent something — as the keypad does. A `quiet` step (one the continuous
   * fill-to monitor started) logs that line at debug instead: the monitor
   * re-sends as fuel burns, and before #1483 it logged only at debug.
   */
  private logStepEnd(label: "Add Amount" | "Target Amount", result: FuelStepResult, quiet = false): void {
    switch (result.outcome) {
      case "landed":
      case "unmoved":
      case "unchecked": {
        const floor = result.floorLtr === undefined ? "" : `, floor ${result.floorLtr.toFixed(2)}L`;

        if (quiet) {
          this.host.logger.debug("Fuel request sent (continuous fill-to)");
        } else {
          this.host.logger.info("Fuel request sent");
        }

        this.host.logger.debug(
          `${label}: pit.fuel(${result.sentLtr}) (${result.outcome}, +${result.extraLtr} L${floor}, baseline ${result.baselineLtr?.toFixed(2) ?? "unknown"}L)`,
        );

        return;
      }

      case "emptied":
        this.host.logger.info("Fuel request emptied");

        return;

      default:
        this.host.logger.debug(`${label} step ${result.outcome}`);
    }
  }

  /**
   * A new context for a lifecycle event (`willAppear`, `didReceiveSettings`),
   * built whole with its hold preview; the base stores it. Input events never
   * create one (#1329).
   */
  protected override createContext(action: IDeckActionContext, settings: FuelServiceSettings): FuelDialContext {
    const created: FuelDialContext = {
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
      unreachableBankLtr: null,
      fillToSends: 0,
      checkedFloorLtr: null,
      throttle: { timer: null, pendingLtr: null, lastSentLtr: null },
      marginThrottle: { timer: null, pendingTicks: 0 },
      preview: null,
      holdPreview: NOOP_HOLD_PREVIEW,
    };
    // The real helper only under the touch-strip flag (#1120): its closures
    // draw on the strip, and the non-Elgato bundles have no strip to draw on,
    // so terser folds the constant and drops them there.
    created.holdPreview = __FEATURE_DIAL_EXTENDED_GESTURES__
      ? createHoldPreview({
          // The SAME value the release classifier reads, read at press time —
          // the preview appears at exactly the instant a release counts as long.
          thresholdMs: () => getDualPressThresholdMs(),
          onThreshold: () => this.showHoldPreview(created),
          onCancel: () => this.revertHoldPreview(created),
        })
      : NOOP_HOLD_PREVIEW;

    return created;
  }

  /**
   * An EXISTING context keeps its `settings` (rule 10): settings changes only
   * flow in through `willAppear` / `didReceiveSettings`, which assign
   * `ctx.settings` explicitly. Event payloads must not refresh it: hosts with
   * per-context settings caches can deliver stale settings in dial events,
   * which would silently undo the `switch-mode` gesture's plugin-side
   * setSettings (#957, the #953 model). So only the action is refreshed.
   */
  protected override refreshContext(
    ctx: FuelDialContext,
    action: IDeckActionContext,
    _settings: FuelServiceSettings,
  ): void {
    ctx.action = action;
  }

  /**
   * The gestures this context fires, read from the context, not the event: an
   * input event does not refresh this surface's settings, so the release and
   * the touch read the stored ones.
   */
  protected override dialGestures(ctx: FuelDialContext, _settings: FuelServiceSettings): DialGestures {
    return gestureSlots(ctx.settings.dial);
  }

  private effectiveDisplayUnits(ctx: FuelDialContext): number {
    const telemetry = this.host.getTelemetry();
    const telemetryUnits = telemetry?.DisplayUnits;

    return resolveDisplayUnits(ctx.settings.unit, typeof telemetryUnits === "number" ? telemetryUnits : undefined);
  }

  /**
   * The unit system the dial's screen draws amounts in: the effective iRacing
   * display units mapped once onto the sim-neutral system the renderers take
   * (#1662).
   */
  private effectiveUnitSystem(ctx: FuelDialContext): UnitSystem {
    return unitSystemOf(this.effectiveDisplayUnits(ctx));
  }

  private effectiveMaxLtr(): number | undefined {
    return readEffectiveMaxLtr(this.host.getSessionInfo());
  }

  /** Current fuel level (liters) from live telemetry; 0 when unknown. */
  private currentLtr(): number {
    return readFuelLevel(this.host.getTelemetry());
  }

  /** Live pit fuel-fill checkbox state. */
  private isFuelFillOn(): boolean {
    return isFuelFillOn(this.host.getTelemetry());
  }

  /** Tri-state fueling indication for the display paths (green/red/gray, #728). */
  private fuelFillState(mode: DialDisplayMode): FuelFillState {
    return resolveFuelFillState(mode, this.host.getTelemetry());
  }

  /** Effective liters to ADD for a context, from its dialed value + live telemetry. */
  private effectiveAddLtr(ctx: FuelDialContext): number {
    return computeAddLtr(
      ctx.settings.dial.mode,
      ctx.dialValueLtr,
      this.currentLtr(),
      this.effectiveMaxLtr(),
      this.effectiveDisplayUnits(ctx),
    );
  }

  /** The live display mode (manual / autofuel / autofuel-off) from telemetry. */
  private displayMode(): DialDisplayMode {
    return resolveDialDisplayMode(this.host.getTelemetry());
  }

  /** Whether the bare turn adjusts the autofuel lap margin (autofuel engaged + available). */
  private isAutofuelMode(): boolean {
    return this.displayMode() === "autofuel";
  }

  /**
   * The liters value used for the bar's add segment and the readout, by mode:
   *
   * - autofuel: what the next stop will add — {@link resolveAutofuelAddLtr}.
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

    if (mode === "autofuel") return resolveAutofuelAddLtr(this.host.getTelemetry());

    if (ctx.settings.dial.mode === "add-amount") {
      return clampTargetLtr(readPitSvFuel(this.host.getTelemetry()) ?? 0, this.effectiveMaxLtr());
    }

    return this.effectiveAddLtr(ctx);
  }

  /**
   * Whether the autofuel key binding is required (a gesture slot is set to
   * toggle-autofuel-mode) but unset — drives the #612 missing-binding overlay on
   * the strip. The dial's primary functions (rotate to add fuel, press to toggle
   * fueling) go through the iRacing API and need NO binding, so a missing autofuel
   * binding only drives the strip's warning and never marks the whole key as
   * unusable — that would flag the key out of the box for everyone (the default
   * Long Press is toggle-autofuel-mode).
   */
  private autofuelBindingMissing(settings: FuelServiceSettings): boolean {
    const slots = [
      settings.dial.pressAction,
      settings.dial.longPressAction,
      settings.dial.tapAction,
      settings.dial.longTouchAction,
    ];

    return slots.includes("toggle-autofuel-mode") && this.host.isBindingMissing(TOGGLE_AUTOFUEL_KEY);
  }

  /**
   * Schedules a coalesced autofuel lap-margin keybind tap from a dial rotation.
   * Net detents accumulate within a window; a single increase/decrease tap fires
   * per window (leading + trailing edges) so a fast spin can't flood the iRacing
   * black box. The readout settles from `PitSvFuel` a beat later (open-loop).
   *
   * Deliberately does NOT honor `enableFuelingOnChange` (#759): preserve-off is
   * a keypad-only behavior — a follow-up clear per coalesced window would spam
   * iRacing and fight the dial's live state machine.
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
    this.host.logger.info("Fuel dial autofuel margin adjusted");
    this.host.logger.debug(`Lap margin ${net > 0 ? "increase" : "decrease"} (net ${net})`);
    await this.host.tapBinding(key);
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

    const telemetry = this.host.getTelemetry();
    const pitFuel = readPitSvFuel(telemetry);

    if (pitFuel === undefined) return;

    const maxLtr = this.effectiveMaxLtr();

    if (ctx.settings.dial.mode === "fill-to") {
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
    //
    // Never while a fuel step check runs (#1314): the check's own sends move
    // `PitSvFuel`, and its end re-bases the dialed value on what was banked.
    if (
      ctx.settings.dial.mode === "add-amount" &&
      Date.now() - ctx.lastUserActivity >= USER_ACTIVITY_GRACE_MS &&
      !this.stepper.busy
    ) {
      const pitFuel = readPitSvFuel(telemetry);

      if (pitFuel !== undefined) {
        ctx.dialValueLtr = clampTargetLtr(pitFuel, this.effectiveMaxLtr());
      }
    }

    // Continuous fill-to monitoring (issue #681): while fuel-fill is ON in
    // fill-to mode, recompute the add from the LIVE fuel level on every tick and
    // evaluate it only when its whole-DISPLAY-unit key changes (i.e. about once
    // per litre/gallon burned). `computeAddLtr` returns the rounded-up need as a
    // clean whole display value (no headroom clamp), so the key only moves when
    // the need crosses a whole-unit boundary — no sub-litre spam. We never
    // re-send when fuel-fill is OFF (the user's toggle-off is respected) nor in
    // add-amount mode (its add is fixed). The render-on-change path pushes the
    // resulting feedback — the monitor only updates the request.
    //
    // An evaluation SENDS only when the live bank (`PitSvFuel`) does not cover
    // the add (#1483), through the Target Amount send path, whose fuel step
    // check steps up until the bank is at least the add. Covering means at or
    // above the add, and less than one fuel step of the car above it — the
    // smallest grid point the car can bank at or above it (a whole liter stands
    // in while the step is unknown: see UNKNOWN_FUEL_STEP_LTR). On a gallon car
    // the bank then moves only when the burn takes the need past it, instead
    // of a request per liter that iRacing rounds back to the same gallon; a
    // bank a step or more above the need (the target lowered, or a stop that
    // left early) is lowered once per key change. A covered evaluation records
    // the key and the floor (`checkedFloorLtr`) without sending.
    //
    // Between key changes a SHORT bank is acted on at once, on any tick: a live
    // `PitSvFuel` below the recorded floor is re-sent. That catches a lowering
    // send that showed only after its step's watch had ended (the step saw the
    // old bank, at or above the floor, and ended; the grid point below the
    // floor showed a moment later), and a request lowered in the sim. The
    // too-high check stays per key change, and an unreadable bank never sends.
    //
    // A bank a Target Amount step could not raise (it ended `unmoved`, e.g.
    // commands ignored while out of the car) is not re-sent within the same
    // key, so the burst is not repeated tick after tick; a new key clears that
    // memory, so a stuck bank is retried at most once per whole unit — the old
    // monitor's cadence. Monitor steps log their end at debug only, as the
    // monitor always has.
    //
    // A key of null (target reached) clears, as before. The monitor also holds
    // off while a fuel step check runs: that check's own sends move `PitSvFuel`,
    // and the key is evaluated against the bank it leaves once it ends.
    //
    // The `!lastPitWasClear` guard respects a deliberate clear during the telemetry
    // LAG window: right after a toggle-off (or an auto-clear when the add hits 0)
    // iRacing keeps reporting fuel-fill ON for a few ticks, while the clear nulls
    // `lastSentWholeAdd`. Without the guard the monitor would see "the add changed"
    // and re-broadcast `pit.fuel`, silently RE-ARMING the fueling the user just
    // turned off. The pipeline's `lastPitWasClear` stays set until fueling is
    // genuinely re-armed (our own `pit.fuel`, or an external fuel-fill OFF→ON
    // edge), so the monitor resumes the moment a real request exists again.
    //
    // `lastPitWasClear` is action-wide (one pipeline per FuelService instance,
    // shared by every button/dial context) on purpose: every Fuel Service surface
    // drives the SAME single iRacing pit fuel request, so "the request was
    // deliberately cleared" is an action-wide fact, not a per-context one. With
    // two fill-to dials targeting the same request a clear on either correctly
    // suppresses the other's re-arm (last command wins, no ping-pong) — a
    // per-context flag would have them fight over the shared request every tick.
    //
    // The `!isPitstopActive` guard pauses the monitor while the car is actively
    // receiving pit service (issue #831). The monitor was built for fuel BURN
    // (the level falls slowly, ~one re-send per litre), but during the stop the
    // pump RAISES the level litres per second — every recomputed add is smaller,
    // and re-broadcasting those shrinking amounts into the in-progress fueling
    // changes the requested amount mid-fueling and stops it short of the target
    // (and at target-reached the add-hits-0 path would clearFuel mid-stop). No
    // extra re-baseline is needed after the stop: `lastSentWholeAdd` still holds
    // the pre-stop value, so the first post-stop tick evaluates the remaining
    // need exactly once — lowering a bank it now overshoots by a step or more,
    // or clearing once the target is genuinely met.
    if (
      ctx.settings.dial.mode === "fill-to" &&
      this.isFuelFillOn() &&
      !this.pipeline.lastPitWasClear &&
      !isPitstopActive(telemetry) &&
      !this.stepper.busy
    ) {
      const addLtr = this.effectiveAddLtr(ctx);
      const displayUnits = this.effectiveDisplayUnits(ctx);
      const wholeKey = addLtr <= 0 ? null : Math.round(fuelToDisplayUnits(addLtr, displayUnits));

      if (wholeKey === ctx.lastSentWholeAdd) {
        if (wholeKey !== null && this.bankShortOfCheckedFloor(ctx, telemetry)) {
          this.sendFillToStep(ctx, addLtr, "monitor");
          this.host.logger.debug(`Continuous fill-to: the bank fell short, requested ${addLtr.toFixed(2)}L`);
        }

        return;
      }

      // A new key: retry a bank a step could not raise (at most once per unit).
      ctx.unreachableBankLtr = null;

      if (wholeKey === null) {
        // Target reached: the 0 add clears (never `pit.fuel(0)`).
        this.pipeline.sendFuel(addLtr);
        ctx.lastSentWholeAdd = null;
        ctx.throttle.lastSentLtr = null;
        ctx.checkedFloorLtr = null;
        this.host.logger.debug("Continuous fill-to: target reached, cleared the request");

        return;
      }

      if (this.bankCoversAdd(addLtr, telemetry)) {
        // Nothing to send; record the key (and the rotate throttle's no-op
        // baseline) so this need is not evaluated again until it moves, and the
        // floor a short bank is measured against until then.
        ctx.lastSentWholeAdd = wholeKey;
        ctx.throttle.lastSentLtr = addLtr;
        ctx.checkedFloorLtr = this.fillToFloorLtr(addLtr);
        this.host.logger.debug(`Continuous fill-to: the bank covers ${addLtr.toFixed(2)}L, nothing sent`);

        return;
      }

      this.sendFillToStep(ctx, addLtr, "monitor");
      this.host.logger.debug(`Continuous fill-to: requested ${addLtr.toFixed(2)}L`);
    }
  }

  /**
   * Whether the live bank (`PitSvFuel`) covers a Target Amount add (#1483): at
   * or above its floor ({@link fillToFloorLtr}), and less than one fuel step of
   * the car above the add — the smallest grid point the car can bank at or
   * above it. While the car's step is unknown a whole liter
   * ({@link UNKNOWN_FUEL_STEP_LTR}) stands in, so a whole-liter car is re-sent
   * exactly when its bank differs from the rounded-up need, as before #1483,
   * and a coarser car's bank a liter or more above the need is re-sent once — a
   * send the fuel step check confirms without lowering the bank below the need,
   * and which teaches the step when it has to step up. An unreadable bank does
   * not cover.
   *
   * Evaluated only on a new key, which has already cleared the memory of a
   * bank a step could not raise: a stuck bank is retried once per whole unit,
   * and a capped bank a step or more above the need (a stop cut short) is
   * lowered like any other. Within a key, the memory is honoured by
   * {@link bankShortOfCheckedFloor}.
   */
  private bankCoversAdd(addLtr: number, telemetry: TelemetryData | null): boolean {
    const bankLtr = readPitSvFuel(telemetry);

    if (bankLtr === undefined || bankLtr < this.fillToFloorLtr(addLtr) - BANK_EPSILON_LTR) return false;

    const carPath = readPlayerCarPath(this.host.getSessionInfo());
    const stepLtr = (carPath === null ? undefined : this.stepper.fuelStepFor(carPath)) ?? UNKNOWN_FUEL_STEP_LTR;

    return bankLtr < addLtr + stepLtr - BANK_EPSILON_LTR;
  }

  /**
   * Whether, within the same key, the live bank has fallen short of the floor
   * it was last checked against (`ctx.checkedFloorLtr`) — a lowering send that
   * showed late, or a request lowered in the sim (#1483). An unreadable bank,
   * or no recorded floor, is never short. A bank still equal to the one a
   * Target Amount step could not raise is not short either: re-sending would
   * repeat the step's burst on every tick. A bank that has moved off it drops
   * that memory.
   */
  private bankShortOfCheckedFloor(ctx: FuelDialContext, telemetry: TelemetryData | null): boolean {
    const bankLtr = readPitSvFuel(telemetry);

    if (bankLtr === undefined || ctx.checkedFloorLtr === null) return false;

    if (ctx.unreachableBankLtr !== null) {
      if (Math.abs(bankLtr - ctx.unreachableBankLtr) <= BANK_EPSILON_LTR) return false;

      ctx.unreachableBankLtr = null;
    }

    return bankLtr < ctx.checkedFloorLtr - BANK_EPSILON_LTR;
  }

  onTelemetry(actionId: string, telemetry: TelemetryData | null): void {
    const ctx = this.contextsState.get(actionId);

    if (!ctx) return;

    // Feed the pipeline's OFF→ON edge detector (releases the no-double-clear
    // guard when fueling is re-armed by us or anything external).
    this.pipeline.observeFuelFill(isFuelFillOn(telemetry));

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
    const unitSystem = this.effectiveUnitSystem(ctx);
    const maxLtr = this.effectiveMaxLtr();
    const mode = this.displayMode();
    const currentLtr = this.currentLtr();
    const addLtr = this.displayAddLtr(ctx, mode);
    const totalLtr = computeTotalLtr(currentLtr, addLtr, maxLtr);

    return [
      mode,
      this.fuelFillState(mode),
      formatDisplayValue(currentLtr, unitSystem),
      formatDisplayValue(addLtr, unitSystem),
      formatDisplayValue(totalLtr, unitSystem),
      mode === "manual" && ctx.settings.dial.mode === "fill-to" ? formatDisplayValue(ctx.dialValueLtr, unitSystem) : "",
      // So the strip re-renders when the autofuel binding is set/cleared (#612).
      this.autofuelBindingMissing(ctx.settings) ? "warn" : "",
      // The hold preview is part of the DISPLAYED state (#1120): a render that
      // showed it must not be mistaken for one that did not, or the change path
      // would skip the revert.
      ctx.preview ? `pending:${ctx.preview.text}` : "",
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

  /**
   * The hold-preview threshold callback (#1120): resolves the long-press
   * gesture's outcome and, when it is knowable, previews it on the strip.
   * Returns whether anything was drawn, so the helper knows whether a release
   * has a preview to revert. Fires nothing — the release still decides.
   */
  private showHoldPreview(ctx: FuelDialContext): boolean {
    const preview = resolveHoldPreview(ctx.settings.dial.longPressAction, {
      telemetry: this.host.getTelemetry(),
      dialMode: ctx.settings.dial.mode,
      dialValueLtr: ctx.dialValueLtr,
      maxLtr: this.effectiveMaxLtr(),
      displayUnits: this.effectiveDisplayUnits(ctx),
      autofuelBindingMissing: this.autofuelBindingMissing(ctx.settings),
    });

    if (!preview) return false;

    ctx.preview = preview;
    this.host.logger.debug(`Fuel dial hold preview: ${preview.text}`);
    // Both preview renders run from a timer callback with no caller left on the
    // stack to catch a rejection (a host socket closed mid-hold being the
    // realistic one), so they handle it here rather than riding the bare `void`
    // this file uses where a caller still is — as the four sibling dial
    // surfaces do.
    this.renderFeedback(ctx).catch((err) => {
      this.host.logger.debug(`Dial hold preview render failed: ${String(err)}`);
    });

    return true;
  }

  /** The hold-preview cancel callback (#1120): back to the normal strip. */
  private revertHoldPreview(ctx: FuelDialContext): void {
    ctx.preview = null;
    this.renderFeedback(ctx).catch((err) => {
      this.host.logger.debug(`Dial hold preview revert failed: ${String(err)}`);
    });
  }

  private clearTimers(ctx: FuelDialContext): void {
    this.clearDisplayTimer(ctx);
    // The context is going away: drop the preview timer without a revert frame
    // (a frame pushed at a vanished context is wasted, #1120).
    ctx.holdPreview.dispose();
    ctx.preview = null;

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
    if (!__FEATURE_DIAL_EXTENDED_GESTURES__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.settings.dial));
  }

  /**
   * Pushes the dial's own screen — the Stream Deck+ strip or the Stream Dock
   * knob, whichever the context reports (#1013); nothing when it has none. The
   * dial surface's only render path (keypad instances render through the
   * keypad icon code).
   */
  private async renderFeedback(ctx: FuelDialContext): Promise<void> {
    const canvas = ctx.action.dialCanvas();

    if (!canvas) return;

    const unitSystem = this.effectiveUnitSystem(ctx);
    const maxLtr = this.effectiveMaxLtr();
    const mode = this.displayMode();
    const currentLtr = this.currentLtr();
    const addLtr = this.displayAddLtr(ctx, mode);
    const totalLtr = computeTotalLtr(currentLtr, addLtr, maxLtr);
    const fillState = this.fuelFillState(mode);
    // The whole dial screen is ONE self-drawn pixmap (band + readout + bar) — the
    // built-in layout text items can't have the colored band background (#728).
    // `ctx.preview` rides every render, so the 5 s heartbeat and a change-driven
    // tick mid-hold keep drawing the pending outcome rather than wiping it (#1120).
    const renderArgs = [
      mode,
      ctx.settings.dial.mode,
      fillState,
      currentLtr,
      addLtr,
      totalLtr,
      ctx.dialValueLtr,
      maxLtr,
      unitSystem,
      this.autofuelBindingMissing(ctx.settings),
      ctx.preview,
    ] as const;

    await ctx.action.setDialCanvas(svgToDataUri(renderFuelCanvasFor(canvas, renderArgs)));

    // Reset the change-detector baseline so a pushed feedback (rotate/press/
    // heartbeat) doesn't immediately re-fire the render-on-change path next tick.
    ctx.lastRenderSig = this.displayedSignature(ctx);
    ctx.lastChangeRenderAt = Date.now();
  }
}
