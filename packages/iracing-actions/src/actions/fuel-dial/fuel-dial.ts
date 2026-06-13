import {
  CommonSettings,
  ConnectionStateAwareAction,
  type DeckFeedbackPayload,
  fuelFromDisplayUnits,
  fuelToDisplayUnits,
  generateBorderParts,
  getCommands,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalTitleSettings,
  type IDeckActionContext,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckTouchTapEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  isMetricUnits,
  renderIconTemplate,
  resolveBorderSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
} from "@iracedeck/deck-core";
import { DisplayUnits, type SessionInfo, type TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import fuelDialTemplate from "../../../icons/fuel-dial.svg";

/** Action triggered by a press / dial button / touch tap. */
type PressAction = "toggle-fueling" | "clear-fueling" | "fill-to-max";

/**
 * Trailing-throttle window for coalescing rapid rotations into a single
 * `pit.fuel()` broadcast + touch-strip update. The first change fires
 * promptly (leading edge); subsequent changes within the window are coalesced
 * and the latest value is flushed at the trailing edge.
 */
const THROTTLE_WINDOW_MS = 100;

/**
 * How long (ms) a dial/touch press must be held to count as a long press
 * rather than a short press. Only consulted when `__FEATURE_DIAL_LONG_PRESS__`
 * is enabled (Elgato).
 */
const LONG_PRESS_THRESHOLD_MS = 500;

/**
 * How long (ms) after a user rotation we keep ignoring telemetry re-seeds, so
 * a live `PitSvFuel` update can't fight an in-flight adjustment.
 */
const USER_ACTIVITY_GRACE_MS = 3000;

const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const GRAY = "#888888";

const FuelDialSettings = CommonSettings.extend({
  stepSize: z.preprocess(
    (val) => (typeof val === "string" ? val.replace(",", ".") : val),
    z.coerce.number().min(0.1).max(50).default(1),
  ),
  pressAction: z.enum(["toggle-fueling", "clear-fueling", "fill-to-max"]).default("toggle-fueling"),
  longPressAction: z.enum(["clear-fueling", "fill-to-max", "toggle-fueling", "none"]).default("clear-fueling"),
  touchScreenEnabled: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true")
    .default(true),
  unitMode: z.enum(["auto", "liters", "gallons"]).default("auto"),
});

type FuelDialSettings = z.infer<typeof FuelDialSettings>;

/** Pending throttle state for one context. */
interface ThrottleState {
  /** Timer for the trailing flush, or null when idle. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Latest target (liters) requested during the current window. */
  pendingLtr: number | null;
  /** Last liters value actually broadcast (suppresses no-op repeats). */
  lastSentLtr: number | null;
}

/** Per-context runtime state. */
interface FuelDialContext {
  settings: FuelDialSettings;
  action: IDeckActionContext;
  /** Internal target fuel-to-add, always in LITERS. */
  targetLtr: number;
  /** Whether fueling is currently armed (a fuel request has been issued). */
  armed: boolean;
  /** Timestamp (ms) of the last user rotation; guards telemetry re-seed. */
  lastUserActivity: number;
  /** Long-press timer (Elgato), or null. */
  longPressTimer: ReturnType<typeof setTimeout> | null;
  /** Whether the long-press timer already fired for the current press. */
  longPressFired: boolean;
  /** Timestamp (ms) the current press started (dial down). */
  pressStart: number;
  throttle: ThrottleState;
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
 * Short unit suffix for the touch-strip / icon readout ("L" or "gal").
 */
export function unitSuffix(displayUnits: number): string {
  return isMetricUnits(displayUnits) ? "L" : "gal";
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
 * Clamps a target (liters) to [0, maxLtr]. When the max is unknown only the
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
 * Builds the touch-strip readout value, e.g. "74 / 100 L" or "74 / -- L".
 */
export function buildReadout(targetLtr: number, maxLtr: number | undefined, displayUnits: number): string {
  const target = formatDisplayValue(targetLtr, displayUnits);
  const max = maxLtr === undefined ? "--" : formatDisplayValue(maxLtr, displayUnits);

  return `${target} / ${max} ${unitSuffix(displayUnits)}`;
}

/**
 * @internal Exported for testing
 *
 * Returns the fill percentage (0-100) for the indicator bar. 0 when the max
 * is unknown.
 */
export function fillPercent(targetLtr: number, maxLtr: number | undefined): number {
  if (maxLtr === undefined || maxLtr <= 0) return 0;

  return Math.max(0, Math.min(100, (targetLtr / maxLtr) * 100));
}

/**
 * @internal Exported for testing
 *
 * Reads `PitSvFuel` (liters) from telemetry, or undefined when unavailable.
 */
export function readPitSvFuel(telemetry: TelemetryData | null): number | undefined {
  if (!telemetry) return undefined;

  const value = (telemetry as Record<string, unknown>).PitSvFuel;

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * @internal Exported for testing
 *
 * Generates the keypad icon (data URI) showing "FUEL", the target value, and a
 * thin fill bar.
 */
export function generateFuelDialSvg(
  settings: FuelDialSettings,
  targetLtr: number,
  maxLtr: number | undefined,
  displayUnits: number,
  armed: boolean,
): string {
  const colors = resolveIconColors(fuelDialTemplate, getGlobalColors(), settings.colorOverrides) as Record<
    string,
    string
  >;
  const graphic1 = colors.graphic1Color || WHITE;
  const fillColor = armed ? GREEN : GRAY;
  const valueText = `${formatDisplayValue(targetLtr, displayUnits)} ${unitSuffix(displayUnits)}`;
  const pct = fillPercent(targetLtr, maxLtr);

  // Fill bar: a thin track plus a fill proportional to pct (0-100).
  const barX = 28;
  const barY = 100;
  const barW = 88;
  const barH = 8;
  const fillW = Math.round((pct / 100) * barW);
  const iconContent = `
    <text x="72" y="74" text-anchor="middle" dominant-baseline="central"
          fill="${graphic1}" font-family="Arial, sans-serif" font-size="34" font-weight="bold">${valueText}</text>
    <rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="4" fill="#1a1f26"/>
    <rect x="${barX}" y="${barY}" width="${fillW}" height="${barH}" rx="4" fill="${fillColor}"/>`;

  const resolvedTitle = resolveTitleSettings(fuelDialTemplate, getGlobalTitleSettings(), settings.titleOverrides);
  const titleContent = resolvedTitle.showTitle
    ? `<text x="72" y="26" text-anchor="middle" dominant-baseline="central" fill="${colors.textColor ?? WHITE}" font-family="Arial, sans-serif" font-size="${resolvedTitle.fontSize}" font-weight="bold">${resolvedTitle.titleText}</text>`
    : "";

  const border = resolveBorderSettings(fuelDialTemplate, getGlobalBorderSettings(), settings.borderOverrides);
  const borderSvg = generateBorderParts(border);

  const svg = renderIconTemplate(fuelDialTemplate, {
    iconContent: resolvedTitle.showGraphics ? iconContent : "",
    titleContent,
    borderDefs: borderSvg.defs,
    borderContent: borderSvg.rects,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Fuel Dial Action
 *
 * A dial-first action for Stream Deck+. Rotating sets an absolute "fuel to add"
 * target; pressing/tapping runs a configurable action (toggle/clear/fill); the
 * touch strip shows a live "74 / 100 L" readout with a fill bar. On a plain
 * keypad it shows the value and a press runs the configured action. All
 * communication uses the iRacing API (`pit.fuel` / `pit.clearFuel`).
 */
export const FUEL_DIAL_UUID = "com.iracedeck.sd.core.fuel-dial" as const;

export class FuelDial extends ConnectionStateAwareAction<FuelDialSettings> {
  private contextsState = new Map<string, FuelDialContext>();

  override async onWillAppear(ev: IDeckWillAppearEvent<FuelDialSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const ctx = this.ensureContext(ev.action, settings);
    // Seed the target from current pit fuel request on appear.
    this.seedFromTelemetry(ctx, true);

    await this.render(ctx);

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

    await this.render(ctx);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<FuelDialSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    const ctx = this.ensureContext(ev.action, settings);
    ctx.settings = settings;

    const displayUnits = this.effectiveDisplayUnits(ctx);
    const stepLtr = fuelFromDisplayUnits(settings.stepSize, displayUnits);
    const maxLtr = this.effectiveMaxLtr();
    // ticks is a SIGNED DELTA (may be >1 per event).
    ctx.targetLtr = clampTargetLtr(ctx.targetLtr + ev.payload.ticks * stepLtr, maxLtr);
    ctx.armed = true;
    ctx.lastUserActivity = Date.now();
    this.logger.debug(`Target=${ctx.targetLtr.toFixed(2)}L, ticks=${ev.payload.ticks}, step=${stepLtr.toFixed(2)}L`);

    // The touch-strip feedback (and the pit.fuel broadcast) are throttled via the
    // send window so a continuous spin can't exceed the ≤10 setFeedback/sec/dial
    // cap. Render only the keypad icon per-event here (no per-rotate feedback);
    // flushSend issues the broadcast + feedback at the leading/trailing edge.
    this.scheduleSend(ctx);
    await this.render(ctx, { skipFeedback: true });
  }

  override async onDialDown(ev: IDeckDialDownEvent<FuelDialSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    const ctx = this.ensureContext(ev.action, settings);
    ctx.settings = settings;

    if (!__FEATURE_DIAL_LONG_PRESS__) {
      // Mirabox: knobs fire dialUp immediately after dialDown, so do the press here.
      this.logger.info("Fuel dial pressed");
      await this.doPress(settings.pressAction, ctx);

      return;
    }

    // Elgato: defer classification to dialUp; start a long-press timer.
    ctx.pressStart = Date.now();
    ctx.longPressFired = false;
    this.clearLongPressTimer(ctx);

    if (settings.longPressAction !== "none") {
      ctx.longPressTimer = setTimeout(() => {
        ctx.longPressTimer = null;
        ctx.longPressFired = true;
        this.logger.info("Fuel dial long-pressed");
        // doPress already renders at its end — no extra render needed here.
        void this.doPress(settings.longPressAction as PressAction, ctx);
      }, LONG_PRESS_THRESHOLD_MS);
    }
  }

  override async onDialUp(ev: IDeckDialUpEvent<FuelDialSettings>): Promise<void> {
    if (!__FEATURE_DIAL_LONG_PRESS__) return;

    const ctx = this.contextsState.get(ev.action.id);

    if (!ctx) return;

    this.clearLongPressTimer(ctx);

    if (ctx.longPressFired) return;

    const elapsed = Date.now() - ctx.pressStart;

    // When longPressAction is "none" no long-press timer was started, so a hold
    // of any duration must still fire pressAction on release — otherwise a slow
    // press would be silently swallowed.
    if (ctx.settings.longPressAction === "none" || elapsed < LONG_PRESS_THRESHOLD_MS) {
      this.logger.info("Fuel dial pressed");
      await this.doPress(ctx.settings.pressAction, ctx);
    }
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<FuelDialSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    const ctx = this.ensureContext(ev.action, settings);
    ctx.settings = settings;
    this.logger.info("Fuel dial key pressed");
    await this.doPress(settings.pressAction, ctx);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<FuelDialSettings>): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    const settings = this.parseSettings(ev.payload.settings);

    if (!settings.touchScreenEnabled) return;

    const ctx = this.ensureContext(ev.action, settings);
    ctx.settings = settings;

    if (ev.payload.hold && __FEATURE_DIAL_LONG_PRESS__ && settings.longPressAction !== "none") {
      this.logger.info("Fuel dial touch hold");
      await this.doPress(settings.longPressAction as PressAction, ctx);

      return;
    }

    this.logger.info("Fuel dial touch tap");
    await this.doPress(settings.pressAction, ctx);
  }

  /**
   * @internal Exported for testing via the instance — runs the configured press
   * action and updates armed state. Re-render is performed by callers.
   */
  private async doPress(action: PressAction, ctx: FuelDialContext): Promise<void> {
    const pit = getCommands().pit;

    switch (action) {
      case "toggle-fueling":
        if (ctx.armed) {
          pit.clearFuel();
          ctx.armed = false;
          this.logger.debug("Toggle: cleared fueling");
        } else {
          pit.fuel(ctx.targetLtr || 0);
          ctx.armed = true;
          this.logger.debug(`Toggle: requested ${ctx.targetLtr.toFixed(2)}L`);
        }

        break;

      case "clear-fueling":
        pit.clearFuel();
        ctx.armed = false;
        this.logger.debug("Cleared fueling");
        break;

      case "fill-to-max": {
        const maxLtr = this.effectiveMaxLtr();

        if (maxLtr === undefined) {
          // No tank capacity to fill to — don't send a stale/zero target or arm.
          this.logger.warn("Fill-to-max: tank capacity unknown, skipping");

          return;
        }

        ctx.targetLtr = maxLtr;
        pit.fuel(ctx.targetLtr);
        ctx.armed = true;
        this.logger.debug(`Fill to max: requested ${ctx.targetLtr.toFixed(2)}L`);
        break;
      }
    }

    ctx.throttle.lastSentLtr = ctx.armed ? ctx.targetLtr : null;
    await this.render(ctx);
  }

  /**
   * Schedules a trailing-throttle send of the latest target. The first change
   * fires promptly (leading edge); rapid follow-ups coalesce into one flush per
   * window. No-op repeats of the same liters are suppressed.
   */
  private scheduleSend(ctx: FuelDialContext): void {
    ctx.throttle.pendingLtr = ctx.targetLtr;

    if (ctx.throttle.timer === null) {
      // Leading edge — send immediately, then open the coalescing window.
      this.flushSend(ctx);
      ctx.throttle.timer = setTimeout(() => {
        ctx.throttle.timer = null;

        if (ctx.throttle.pendingLtr !== null) {
          this.flushSend(ctx);
        }
      }, THROTTLE_WINDOW_MS);
    }
  }

  /** Broadcasts the pending target (suppressing no-op repeats) and updates feedback. */
  private flushSend(ctx: FuelDialContext): void {
    const target = ctx.throttle.pendingLtr;
    ctx.throttle.pendingLtr = null;

    if (target === null) return;

    if (ctx.throttle.lastSentLtr === target) {
      // Same value already sent — still refresh feedback, skip the broadcast.
      void this.renderFeedback(ctx);

      return;
    }

    getCommands().pit.fuel(target);
    ctx.throttle.lastSentLtr = target;
    this.logger.info("Fuel request sent");
    this.logger.debug(`Sent ${target.toFixed(2)}L`);
    void this.renderFeedback(ctx);
  }

  private parseSettings(settings: unknown): FuelDialSettings {
    const parsed = FuelDialSettings.safeParse(settings);

    return parsed.success ? parsed.data : FuelDialSettings.parse({});
  }

  private ensureContext(action: IDeckActionContext, settings: FuelDialSettings): FuelDialContext {
    let ctx = this.contextsState.get(action.id);

    if (!ctx) {
      ctx = {
        settings,
        action,
        targetLtr: 0,
        armed: false,
        lastUserActivity: 0,
        longPressTimer: null,
        longPressFired: false,
        pressStart: 0,
        throttle: { timer: null, pendingLtr: null, lastSentLtr: null },
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
    const telemetryUnits = telemetry ? (telemetry as Record<string, unknown>).DisplayUnits : undefined;

    return resolveDisplayUnits(ctx.settings.unitMode, typeof telemetryUnits === "number" ? telemetryUnits : undefined);
  }

  private effectiveMaxLtr(): number | undefined {
    return readEffectiveMaxLtr(this.sdkController.getSessionInfo());
  }

  /**
   * Re-seeds the target from `PitSvFuel`. When `force` is false the re-seed is
   * skipped if the user rotated recently (so live telemetry can't fight an
   * in-flight adjustment).
   */
  private seedFromTelemetry(ctx: FuelDialContext, force: boolean): void {
    if (!force && Date.now() - ctx.lastUserActivity < USER_ACTIVITY_GRACE_MS) return;

    const telemetry = this.sdkController.getCurrentTelemetry();
    const pitFuel = readPitSvFuel(telemetry);

    if (pitFuel === undefined) return;

    const maxLtr = this.effectiveMaxLtr();
    ctx.targetLtr = clampTargetLtr(pitFuel, maxLtr);
    ctx.armed = pitFuel > 0;
  }

  private onTelemetry(ctx: FuelDialContext, telemetry: TelemetryData | null): void {
    // Re-seed from telemetry only when the user hasn't rotated recently.
    if (Date.now() - ctx.lastUserActivity >= USER_ACTIVITY_GRACE_MS) {
      const pitFuel = readPitSvFuel(telemetry);

      if (pitFuel !== undefined) {
        const maxLtr = this.effectiveMaxLtr();
        ctx.targetLtr = clampTargetLtr(pitFuel, maxLtr);
        ctx.armed = pitFuel > 0;
      }
    }

    void this.render(ctx);
  }

  private clearLongPressTimer(ctx: FuelDialContext): void {
    if (ctx.longPressTimer !== null) {
      clearTimeout(ctx.longPressTimer);
      ctx.longPressTimer = null;
    }
  }

  private clearTimers(ctx: FuelDialContext): void {
    this.clearLongPressTimer(ctx);

    if (ctx.throttle.timer !== null) {
      clearTimeout(ctx.throttle.timer);
      ctx.throttle.timer = null;
    }
  }

  /**
   * Renders the keypad icon and (for dials) the touch-strip feedback.
   *
   * Pass `skipFeedback: true` for per-rotate renders — the touch-strip feedback
   * is instead pushed by the throttled `flushSend`, so a continuous spin stays
   * within the ≤10 `setFeedback`/sec/dial cap. Press/settings/telemetry-driven
   * renders omit the flag so feedback updates immediately.
   */
  private async render(ctx: FuelDialContext, opts?: { skipFeedback?: boolean }): Promise<void> {
    const displayUnits = this.effectiveDisplayUnits(ctx);
    const maxLtr = this.effectiveMaxLtr();

    if (ctx.action.isKey()) {
      const svg = generateFuelDialSvg(ctx.settings, ctx.targetLtr, maxLtr, displayUnits, ctx.armed);
      await this.updateKeyImageForContext(ctx, svg);
    }

    if (!opts?.skipFeedback) {
      await this.renderFeedback(ctx);
    }
  }

  /** Stores the icon for a context and pushes it to the device. */
  private async updateKeyImageForContext(ctx: FuelDialContext, svg: string): Promise<void> {
    const updated = await this.updateKeyImage(ctx.action.id, svg);

    if (!updated) {
      // First render for this context — register via setKeyImage so BaseAction tracks it.
      await this.setKeyImage({ action: ctx.action, payload: { settings: ctx.settings } }, svg);
      this.setRegenerateCallback(ctx.action.id, () => {
        const du = this.effectiveDisplayUnits(ctx);
        const max = this.effectiveMaxLtr();

        return generateFuelDialSvg(ctx.settings, ctx.targetLtr, max, du, ctx.armed);
      });
    }
  }

  /** Pushes the touch-strip feedback when this is a dial and the touch strip is enabled. */
  private async renderFeedback(ctx: FuelDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (!ctx.action.isDial() || !ctx.settings.touchScreenEnabled) return;

    const displayUnits = this.effectiveDisplayUnits(ctx);
    const maxLtr = this.effectiveMaxLtr();
    const feedback: DeckFeedbackPayload = {
      title: "FUEL",
      value: buildReadout(ctx.targetLtr, maxLtr, displayUnits),
      indicator: {
        value: fillPercent(ctx.targetLtr, maxLtr),
        bar_fill_c: ctx.armed ? GREEN : GRAY,
      },
    };
    await ctx.action.setFeedback(feedback);
  }
}
