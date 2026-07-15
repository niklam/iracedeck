/**
 * The dial surface of the Cockpit Misc action (issue #805) — the dual-surface
 * pattern (Fuel Service #759 / Setup Brakes #775 / Setup Engine #798), behind a
 * host interface.
 *
 * Self-contained leaf (owns the `dial` schema + its own dial key bindings;
 * operates on the `dial` sub-object). Flipping through in-car dash pages to find
 * the right screen suits a detent-per-page rotary: `dial.setting` picks dash page
 * 1 or dash page 2 and turning taps the same `cockpitMiscDashPage*Increase` /
 * `Decrease` bindings as the keypad surface. The touch strip shows the live page
 * number iRacing reports for that display (`dcDashPage` / `dcDashPage2`), or
 * `---` when the car exposes no dash pages (dc*-presence is the capability
 * signal). Pressing runs a configurable gesture — any of the keypad's one-shot
 * controls (toggle wipers / trigger wipers / in-lap mode / report latency) or
 * none; default none.
 *
 * The `ffb-max-force` keypad mode is deliberately NOT a rotation setting here —
 * it shares bindings with the Force Feedback action, whose own dial surface
 * (separate issue) is the canonical home for FFB rotation.
 *
 * Readback formatter note: unlike the setup-* dial surfaces, Cockpit Misc has no
 * keypad "View …" sub-modes, so the shared `formatViewValue` / `VIEW_DEFS`
 * registry (whose `ViewSettingId` keys and mandatory `adjustmentMode` field are
 * setup-action-scoped) is the wrong seam for dash pages. A small local formatter
 * over `dcDashPage` / `dcDashPage2` is cleaner; it reuses only the generic
 * `formatInteger` helper (which already yields the shared `---` placeholder for a
 * missing value).
 */
import {
  classifyDialRelease,
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  getDualPressThresholdMs,
  type IDeckActionContext,
  svgToDataUri,
} from "@iracedeck/deck-core";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import z from "zod";

import { dialAppearanceFields, renderDialBox, resolveDialBoxColors } from "../../shared/dial-box.js";
import { renderDialNameIcon } from "../../shared/dial-name-icon.js";
import { formatInteger } from "../../shared/setup-view.js";

const CHANGE_RENDER_MIN_INTERVAL_MS = 100;

/** Cap on binding taps dispatched for one rotate event (a fast spin coalesces ticks). */
const MAX_TAPS_PER_EVENT = 5;

/**
 * The dash-page selectors the dial can cycle. `ffb-max-force` is intentionally
 * absent (its FFB rotation belongs to the Force Feedback dial surface).
 */
export const ROTATION_SETTINGS = ["dash-page-1", "dash-page-2"] as const;
export type CockpitMiscDialSetting = (typeof ROTATION_SETTINGS)[number];

/**
 * The actions a dial-button / touch gesture (Push, Long Press, Tap Display,
 * Long Touch) can run, plus the `none` sentinel. Every non-`none` value taps
 * the matching one-shot Cockpit Misc key binding — the same set of one-shots
 * the keypad surface offers (`COCKPIT_MISC_GLOBAL_KEYS` in cockpit-misc.ts),
 * so a dial user isn't missing an option a keypad placement would have (#805).
 */
export const GESTURE_ACTIONS = ["toggle-wipers", "trigger-wipers", "in-lap-mode", "report-latency", "none"] as const;
export type GestureSlot = (typeof GESTURE_ACTIONS)[number];

export type CockpitMiscDirection = "increase" | "decrease";

/** Shared Cockpit Misc rotation bindings, one increase/decrease pair per dash page. */
const DIAL_ROTATION_KEYS: Record<string, string> = {
  "dash-page-1-increase": "cockpitMiscDashPage1Increase",
  "dash-page-1-decrease": "cockpitMiscDashPage1Decrease",
  "dash-page-2-increase": "cockpitMiscDashPage2Increase",
  "dash-page-2-decrease": "cockpitMiscDashPage2Decrease",
};

/** Shared Cockpit Misc one-shot bindings tapped by the press / touch gestures. */
const GESTURE_KEYS: Record<Exclude<GestureSlot, "none">, string> = {
  "toggle-wipers": "cockpitMiscToggleWipers",
  "trigger-wipers": "cockpitMiscTriggerWipers",
  "in-lap-mode": "cockpitMiscInLapMode",
  "report-latency": "cockpitMiscReportLatency",
};

/** Resolves the shared Cockpit Misc rotation binding for a dial setting + direction. */
export function rotationKey(setting: CockpitMiscDialSetting, direction: CockpitMiscDirection): string | undefined {
  return DIAL_ROTATION_KEYS[`${setting}-${direction}`];
}

export const DialSettings = z
  .object({
    setting: z.enum(ROTATION_SETTINGS).default("dash-page-1"),
    // Push (short press) — fires on dialUp. Default None (blind-safe for VR).
    pressAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Long Press (held dial button past the threshold, no rotation) — fires on dialUp.
    longPressAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Tap Display (touch-strip tap, hold === false). Default None for VR safety.
    tapAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Long Touch (touch-strip tap, hold === true). Default None for VR safety.
    longTouchAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Dash-box appearance overrides (colors, issue #811).
    ...dialAppearanceFields,
  })
  // prefault (not default): a missing `dial` parses {} THROUGH the schema so the
  // per-field defaults apply — same shape as a partially-persisted object.
  .prefault({});

export type DialSettings = z.infer<typeof DialSettings>;

/**
 * Seeds the dial config from a pre-#805 encoder placement. Before this surface,
 * dial events drove the flat keypad `control` (the bare `onDialRotate` /
 * `onDialDown` handlers a 2.x encoder placement used); afterwards they read
 * `dial.setting`. When a dial instance appears with a persisted flat `control`
 * that is a valid rotation value (a dash page) and no `dial` object yet, carry
 * the choice over so the knob keeps cycling the page the user configured.
 * Returns the seeded raw settings to persist, or null when no migration applies
 * (fresh instances, a persisted `dial`, or a non-rotation `control` such as
 * `ffb-max-force` / `toggle-wipers`).
 */
export function seedDialFromLegacySetting(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;

  if (obj.dial !== undefined) return null;

  const legacy = obj.control;

  if (typeof legacy !== "string" || !(ROTATION_SETTINGS as readonly string[]).includes(legacy)) return null;

  return { ...obj, dial: { setting: legacy } };
}

/** TelemetryData field holding the live page number for each dash display. */
const TELEMETRY_FIELD: Record<CockpitMiscDialSetting, keyof TelemetryData> = {
  "dash-page-1": "dcDashPage",
  "dash-page-2": "dcDashPage2",
};

/** Short label drawn on the dash box. */
const MODE_ABBR: Record<CockpitMiscDialSetting, string> = {
  "dash-page-1": "DASH 1",
  "dash-page-2": "DASH 2",
};

/**
 * Per-setting accent for the dash box border, label, and value. Semantic (a
 * glance distinguishes dash 1 from dash 2) and the DEFAULT that each color slot
 * falls back to, independently overridable per dial (issue #811).
 */
const MODE_COLOR: Record<CockpitMiscDialSetting, string> = {
  "dash-page-1": "#3498db",
  "dash-page-2": "#f39c12",
};

/** Friendly mode name for the encoder trigger description ("Adjust …"). */
const MODE_LABEL: Record<CockpitMiscDialSetting, string> = {
  "dash-page-1": "Dash Page 1",
  "dash-page-2": "Dash Page 2",
};

/**
 * @internal Exported for testing
 *
 * The value string shown on the dash box — the live page number iRacing reports
 * for the selected display, or `---` when the car exposes no dash pages (the
 * `dc*` field is absent) or telemetry is unavailable. `formatInteger` supplies
 * both the integer formatting and the shared placeholder.
 */
export function formatDialValue(setting: CockpitMiscDialSetting, telemetry: TelemetryData | null): string {
  return formatInteger(telemetry?.[TELEMETRY_FIELD[setting]]);
}

/**
 * @internal Exported for testing
 *
 * Computes the encoder trigger descriptions from the current dial settings.
 * `rotate` names the bound dash page; `push` carries the press action with the
 * long-press as a "(hold: …)" hint; `touch` / `longTouch` carry the touch-strip
 * gestures. Slots set to `none` are omitted.
 */
export function buildTriggerDescription(dial: DialSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = {
    rotate: `Cycle ${MODE_LABEL[dial.setting]}`,
  };

  const pushLabel = gestureLabel(dial.pressAction);
  const holdLabel = gestureLabel(dial.longPressAction);

  if (pushLabel && holdLabel) {
    description.push = `${pushLabel} (hold: ${holdLabel})`;
  } else if (pushLabel) {
    description.push = pushLabel;
  } else if (holdLabel) {
    description.push = `Hold: ${holdLabel}`;
  }

  const tapLabel = gestureLabel(dial.tapAction);

  if (tapLabel) {
    description.touch = tapLabel;
  }

  const longTouchLabel = gestureLabel(dial.longTouchAction);

  if (longTouchLabel) {
    description.longTouch = longTouchLabel;
  }

  return description;
}

/** Human-readable label for a gesture slot (for the trigger description). */
function gestureLabel(action: GestureSlot): string | undefined {
  switch (action) {
    case "toggle-wipers":
      return "Toggle Wipers";
    case "trigger-wipers":
      return "Trigger Wipers";
    case "in-lap-mode":
      return "In-Lap Mode";
    case "report-latency":
      return "Report Latency";
    case "none":
      return undefined;
  }
}

/** Per-context runtime state. */
interface CockpitMiscDialContext {
  dial: DialSettings;
  action: IDeckActionContext;
  /** Timestamp (ms) the current dial-button press started (dialDown). */
  pressStart: number;
  /**
   * Whether the dial was rotated while the button was held during the current
   * press. Set in rotate (pressed === true), read once at dialUp so a push+turn
   * (used to cycle a page without firing the press gesture) fires no gesture on
   * release.
   */
  rotatedWhilePressed: boolean;
  /** Signature of the DISPLAYED state at the last change-driven render. */
  lastRenderSig: string | null;
  /** Timestamp (ms) of the last change-driven feedback push (throttle gate). */
  lastChangeRenderAt: number;
}

/**
 * The delegates the surface needs from its owning action. Binding dispatch stays
 * on the action so keyboard/SimHub routing is unchanged. Deliberately NO
 * `setActiveBinding`: readiness state is one value per action-class instance and
 * setting it from a dial context would bleed onto the action's keypad buttons
 * (see global-settings.md), so dial instances don't declare active bindings.
 */
export interface CockpitMiscDialHost {
  readonly logger: ILogger;
  getTelemetry(): TelemetryData | null;
  tapBinding(settingKey: string): Promise<void>;
  isBindingMissing(keys: string | string[] | null | undefined): boolean;
}

/**
 * Owns all per-dial-context state, dispatches rotations and gestures, and
 * renders the touch-strip feedback. The owning action routes every dial
 * lifecycle/input event here and forwards telemetry ticks per subscribed
 * context.
 */
export class CockpitMiscDialSurface {
  private readonly contextsState = new Map<string, CockpitMiscDialContext>();

  constructor(private readonly host: CockpitMiscDialHost) {}

  async willAppear(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    // The deck-app image for the dial: just the action name. Without this the
    // app falls back to keypad iconography for the dial slot.
    action
      .setImage(renderDialNameIcon({ line1: "COCKPIT", line2: "MISC", backgroundColor: "#2a2a3a" }))
      .catch((err) => {
        this.host.logger.debug(`Dial name icon push failed: ${String(err)}`);
      });

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  willDisappear(actionId: string): void {
    this.contextsState.delete(actionId);
  }

  async didReceiveSettings(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);
    // Bust the memo so the next render reflects the new page even if it happens
    // to format to the same value string as the previous one.
    ctx.lastRenderSig = null;

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  async rotate(action: IDeckActionContext, dial: DialSettings, ticks: number, pressed: boolean): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    // A pressed rotation still cycles the page; the guard makes the dialUp
    // classifier skip the press gesture so holding-and-turning never also runs
    // it. The displayed value settles a beat later from telemetry.
    if (pressed) {
      ctx.rotatedWhilePressed = true;
    }

    if (ticks === 0) return;

    const direction: CockpitMiscDirection = ticks > 0 ? "increase" : "decrease";
    const key = rotationKey(ctx.dial.setting, direction);

    if (!key) {
      this.host.logger.warn(`No global key mapping for ${ctx.dial.setting} ${direction}`);

      return;
    }

    // Scale by |ticks|, capped so a fast spin can't queue a long tap burst
    // (relative dash-page bindings apply once per press — there is no
    // absolute-page command to scale instead).
    const taps = Math.min(Math.abs(ticks), MAX_TAPS_PER_EVENT);

    this.host.logger.info(`Cockpit misc dial rotated ${direction}`);
    this.host.logger.debug(`${ctx.dial.setting} ${direction} ×${taps} (ticks=${ticks})`);

    for (let i = 0; i < taps; i++) {
      await this.host.tapBinding(key);
    }
  }

  down(action: IDeckActionContext, dial: DialSettings): void {
    const ctx = this.ensureContext(action, dial);

    // Record the press start and clear the push+turn guard. Fire nothing and
    // start no timer — press vs long-press is classified once at dialUp.
    ctx.pressStart = Date.now();
    ctx.rotatedWhilePressed = false;
  }

  async up(actionId: string): Promise<void> {
    const ctx = this.contextsState.get(actionId);

    if (!ctx) return;

    // Consume the press start immediately so a stray dialUp without a preceding
    // dialDown can't reclassify. A 0 sentinel means "no press in progress".
    const pressStartMs = ctx.pressStart;
    ctx.pressStart = 0;

    if (pressStartMs === 0) return;

    const kind = classifyDialRelease({
      pressStartMs,
      nowMs: Date.now(),
      rotatedWhilePressed: ctx.rotatedWhilePressed,
      thresholdMs: getDualPressThresholdMs(),
    });

    if (kind === "push-turn") return;

    const action = kind === "long" ? ctx.dial.longPressAction : ctx.dial.pressAction;

    if (action === "none") return;

    this.host.logger.info(kind === "long" ? "Cockpit misc dial long-pressed" : "Cockpit misc dial pressed");
    await this.doGesture(action);
  }

  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    // hold === true → Long Touch slot; hold === false → Tap Display slot.
    const gesture = hold ? dial.longTouchAction : dial.tapAction;

    if (gesture === "none") return;

    this.ensureContext(action, dial);
    this.host.logger.info(hold ? "Cockpit misc dial long touch" : "Cockpit misc dial tap");
    await this.doGesture(gesture);
  }

  onTelemetry(actionId: string, _telemetry: TelemetryData | null): void {
    const ctx = this.contextsState.get(actionId);

    if (!ctx) return;

    const sig = this.displayedSignature(ctx);

    if (sig === ctx.lastRenderSig) return;

    // Changed but feedback-throttled: do nothing and do NOT advance
    // lastRenderSig, so the throttled feedback still fires next window.
    if (Date.now() - ctx.lastChangeRenderAt < CHANGE_RENDER_MIN_INTERVAL_MS) return;

    // Advance the baseline SYNCHRONOUSLY before the async render: 60 Hz ticks
    // arriving while the setFeedback push is still in flight would otherwise each
    // fire another push inside the same 100 ms window, defeating the
    // ≤10 setFeedback/sec/dial throttle.
    ctx.lastRenderSig = sig;
    ctx.lastChangeRenderAt = Date.now();
    this.renderFeedback(ctx).catch((err) => {
      this.host.logger.debug(`Dial feedback render failed: ${String(err)}`);
    });
  }

  /**
   * Re-renders every dial context (settings-memo busted). Called by the owning
   * action on global-settings changes so the strip's #612 missing-binding
   * warning tracks live binding configuration even while iRacing is offline
   * (no telemetry ticks arrive to trigger the render-on-change path).
   */
  refreshAll(): void {
    for (const ctx of this.contextsState.values()) {
      ctx.lastRenderSig = null;
      this.renderFeedback(ctx).catch((err) => {
        this.host.logger.debug(`Dial feedback refresh failed: ${String(err)}`);
      });
    }
  }

  private ensureContext(action: IDeckActionContext, dial: DialSettings): CockpitMiscDialContext {
    let ctx = this.contextsState.get(action.id);

    if (!ctx) {
      ctx = {
        dial,
        action,
        pressStart: 0,
        rotatedWhilePressed: false,
        lastRenderSig: null,
        lastChangeRenderAt: 0,
      };
      this.contextsState.set(action.id, ctx);
    } else {
      ctx.action = action;
      ctx.dial = dial;
    }

    return ctx;
  }

  /** Runs a configured press / touch gesture. */
  private async doGesture(action: GestureSlot): Promise<void> {
    if (action === "none") return;

    const key = GESTURE_KEYS[action];

    if (!key) {
      this.host.logger.warn(`No global key mapping for ${action}`);

      return;
    }

    this.host.logger.info(`Cockpit misc dial gesture: ${gestureLabel(action)}`);
    await this.host.tapBinding(key);
  }

  /**
   * The dial's primary function is rotation, which needs BOTH the increase and
   * decrease bindings of the bound dash page (#612); the press gesture is
   * secondary and never gates the strip warning.
   */
  private computeBindingMissing(dial: DialSettings): boolean {
    const keys = [rotationKey(dial.setting, "increase"), rotationKey(dial.setting, "decrease")].filter(
      (key): key is string => key !== undefined,
    );

    return this.host.isBindingMissing(keys);
  }

  /** A compact signature of the displayed state; a feedback push is due when it changes. */
  private displayedSignature(ctx: CockpitMiscDialContext): string {
    const value = formatDialValue(ctx.dial.setting, this.host.getTelemetry());

    return [ctx.dial.setting, value, this.computeBindingMissing(ctx.dial) ? "warn" : ""].join("|");
  }

  /** Pushes the encoder trigger descriptions for a dial (Elgato only). */
  private async applyTriggerDescription(ctx: CockpitMiscDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.dial));
  }

  /** Pushes the touch-strip feedback (the full-cell dash box) when this is a dial. */
  private async renderFeedback(ctx: CockpitMiscDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (!ctx.action.isDial()) return;

    const setting = ctx.dial.setting;
    const boxSvg = renderDialBox({
      width: 200,
      height: 100,
      abbr: MODE_ABBR[setting],
      value: formatDialValue(setting, this.host.getTelemetry()),
      colors: resolveDialBoxColors(ctx.dial.colors, MODE_COLOR[setting]),
      bindingMissing: this.computeBindingMissing(ctx.dial),
    });
    const feedback: DeckFeedbackPayload = { box: svgToDataUri(boxSvg) };
    await ctx.action.setFeedback(feedback);

    // Reset the change-detector baseline so this pushed feedback doesn't
    // immediately re-fire the render-on-change path on the next telemetry tick.
    ctx.lastRenderSig = this.displayedSignature(ctx);
    ctx.lastChangeRenderAt = Date.now();
  }
}
