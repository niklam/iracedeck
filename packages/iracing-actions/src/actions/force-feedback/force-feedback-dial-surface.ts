/**
 * The dial surface of the Force Feedback action (issue #802) — the dual-surface
 * pattern (Fuel Service #759 / Setup Brakes #775), behind a host interface.
 *
 * Self-contained leaf (owns the `dial` schema + dial key bindings; operates on
 * the `dial` sub-object). Rotating adjusts one FFB / LFE value via the same
 * increase/decrease key bindings as the keypad surface; the press can trigger
 * Auto FFB.
 *
 * `ffb-force` is the one setting iRacing reports live (`SteeringWheelMaxForceNm`,
 * already typed on `TelemetryData`), so its touch strip shows the actual max
 * force in Nm (one decimal). The two LFE values (wheel / bass-shaker volume)
 * have no telemetry readback, so they render
 * label-only via the dash box's identity-only branch — the Audio-Controls
 * voice-chat/master compromise (#782).
 *
 * `SteeringWheelMaxForceNm` is NOT a `dc*` setup value, so it has no `view-*`
 * entry in `setup-view.ts`; the surface formats it with a small local formatter
 * rather than reusing the shared View formatter machinery the Setup dials use.
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

/**
 * Minimum gap (ms) between change-driven feedback pushes — keeps the live FFB
 * force readback under the documented ≤10 `setFeedback`/sec/dial cap (mirrors the
 * Setup dial surfaces).
 */
const CHANGE_RENDER_MIN_INTERVAL_MS = 100;

/**
 * Cap on binding taps dispatched for one rotate event. A fast spin coalesces
 * multiple detents into one event (`ticks` > 1); each iRacing FFB/LFE key steps
 * a fixed amount per press (there is no absolute-set command), so a spin advances
 * several detents but never queues an unbounded tap burst (the Audio Controls
 * dial convention, #782).
 */
const MAX_TAPS_PER_EVENT = 5;

/** The directional FFB / LFE values the dial can drive (auto-compute is a press gesture, not a rotation). */
export const ROTATION_SETTINGS = [
  "ffb-force",
  "wheel-lfe",
  "bass-shaker-lfe",
] as const;
export type ForceFeedbackDialSetting = (typeof ROTATION_SETTINGS)[number];

/**
 * The actions a dial-button / touch gesture (Push, Long Press, Tap Display,
 * Long Touch) can run, plus the "none" sentinel. `auto-ffb` taps the shared
 * Force Feedback Auto Compute key binding.
 */
export const GESTURE_ACTIONS = ["auto-ffb", "none"] as const;
export type GestureSlot = (typeof GESTURE_ACTIONS)[number];

export type ForceFeedbackDirection = "increase" | "decrease";

/**
 * Rotation binding keys, shared verbatim with the keypad surface. FFB Force
 * reuses the Cockpit Misc keys (the two actions drive the same iRacing FFB max
 * force setting, #827).
 */
const DIAL_ROTATION_KEYS: Record<string, string> = {
  "ffb-force-increase": "cockpitMiscFfbForceIncrease",
  "ffb-force-decrease": "cockpitMiscFfbForceDecrease",
  "wheel-lfe-increase": "forceFeedbackWheelLfeLouder",
  "wheel-lfe-decrease": "forceFeedbackWheelLfeQuieter",
  "bass-shaker-lfe-increase": "forceFeedbackBassShakerLfeLouder",
  "bass-shaker-lfe-decrease": "forceFeedbackBassShakerLfeQuieter",
};

/** The Auto Compute FFB Force binding, tapped by the `auto-ffb` press gesture. */
const AUTO_COMPUTE_KEY = "forceFeedbackAutoCompute";

/** Resolves the shared Force Feedback global key binding for a dial setting + direction. */
export function rotationKey(setting: ForceFeedbackDialSetting, direction: ForceFeedbackDirection): string | undefined {
  return DIAL_ROTATION_KEYS[`${setting}-${direction}`];
}

/**
 * Dial-surface settings, stored under the `dial` root key. All fields default,
 * so a keypad-only instance (or a fresh dial) parses `{}` to a full object.
 * Press defaults to None: Auto FFB overwrites the user's tuned force, so it is
 * never a blind default (#802).
 */
export const DialSettings = z
  .object({
    setting: z.enum(ROTATION_SETTINGS).default("ffb-force"),
    pressAction: z.enum(GESTURE_ACTIONS).default("none"),
    longPressAction: z.enum(GESTURE_ACTIONS).default("none"),
    tapAction: z.enum(GESTURE_ACTIONS).default("none"),
    longTouchAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Dash-box appearance overrides (colors, issue #811).
    ...dialAppearanceFields,
  })
  // prefault (not default): a missing `dial` parses {} THROUGH the schema so
  // the per-field defaults apply — same shape as a partially-persisted object.
  .prefault({});

export type DialSettings = z.infer<typeof DialSettings>;

/**
 * Seeds the dial config from a pre-#802 encoder placement. Before the dial
 * surface, dial events drove the flat keypad `mode`; afterwards they read
 * `dial.setting`. When a dial instance appears with a persisted flat `mode`
 * that is a valid rotation value and no `dial` object yet, carry the choice
 * over so the knob keeps adjusting what the user configured. Returns null when
 * no migration applies (fresh instances; `auto-compute-ffb-force`, which is not
 * a rotation value; already-seeded dials).
 */
export function seedDialFromLegacySetting(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;

  if (obj.dial !== undefined) return null;

  const legacy = obj.mode;

  if (typeof legacy !== "string" || !(ROTATION_SETTINGS as readonly string[]).includes(legacy)) return null;

  return { ...obj, dial: { setting: legacy } };
}

/** Short label drawn on the dash box. */
const MODE_ABBR: Record<ForceFeedbackDialSetting, string> = {
  "ffb-force": "FFB",
  "wheel-lfe": "WHEEL",
  "bass-shaker-lfe": "SHAKER",
};

/**
 * Per-setting accent color for the dash box's border, label, and value — a
 * glance distinguishes one configured dial from another. Each is the DEFAULT
 * border / label / value color, independently overridable per dial (#811).
 */
const MODE_COLOR: Record<ForceFeedbackDialSetting, string> = {
  "ffb-force": "#4fc3f7",
  "wheel-lfe": "#2ecc71",
  "bass-shaker-lfe": "#9b59b6",
};

/** Friendly mode name for the encoder trigger description ("Adjust …"). */
const MODE_LABEL: Record<ForceFeedbackDialSetting, string> = {
  "ffb-force": "FFB Force",
  "wheel-lfe": "Wheel LFE",
  "bass-shaker-lfe": "Bass Shaker LFE",
};

/**
 * @internal Exported for testing
 *
 * The value string shown on the dash box. `ffb-force` shows the live max force
 * as "XX.X Nm" (one decimal) from `SteeringWheelMaxForceNm` — the only value
 * iRacing reports — with `---` when telemetry is unavailable. The four LFE
 * settings have no readback and return `""`, so the box renders label-only (the
 * identity-only branch, the #782 compromise).
 */
export function formatDialValue(setting: ForceFeedbackDialSetting, telemetry: TelemetryData | null): string {
  if (setting !== "ffb-force") return "";

  const nm = telemetry?.SteeringWheelMaxForceNm;

  if (typeof nm !== "number" || !Number.isFinite(nm)) return "---";

  return `${nm.toFixed(1)} Nm`;
}

/**
 * @internal Exported for testing
 *
 * Computes the encoder trigger descriptions from the current dial settings.
 * `rotate` names the bound setting; `push` carries the press action with the
 * long-press as a "(hold: …)" hint; `touch` / `longTouch` carry the touch-strip
 * gestures.
 */
export function buildTriggerDescription(dial: DialSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = {
    rotate: `Adjust ${MODE_LABEL[dial.setting]}`,
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
    case "auto-ffb":
      return "Auto FFB";
    case "none":
      return undefined;
  }
}

/** Per-context runtime state. */
interface ForceFeedbackDialContext {
  dial: DialSettings;
  action: IDeckActionContext;
  /** Timestamp (ms) the current dial-button press started (dialDown). */
  pressStart: number;
  /**
   * Whether the dial was rotated while the button was held during the current
   * press. Set in rotate (pressed === true), read once at dialUp so a
   * push+turn (adjust without firing the press gesture) fires no gesture on
   * release.
   */
  rotatedWhilePressed: boolean;
  /** Signature of the DISPLAYED state at the last change-driven render. */
  lastRenderSig: string | null;
  /** Timestamp (ms) of the last change-driven feedback push (throttle gate). */
  lastChangeRenderAt: number;
}

/**
 * The delegates the surface needs from its owning action. Binding dispatch
 * stays on the action so keyboard/SimHub routing is unchanged. Deliberately NO
 * `setActiveBinding`: readiness state is one value per action-class instance and
 * setting it from a dial context would bleed onto the action's keypad buttons
 * (see global-settings.md), so dial instances compute their own per-context
 * missing-binding via `isBindingMissing` — same as the Setup dial surfaces.
 */
export interface ForceFeedbackDialHost {
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
export class ForceFeedbackDialSurface {
  private readonly contextsState = new Map<string, ForceFeedbackDialContext>();

  constructor(private readonly host: ForceFeedbackDialHost) {}

  async willAppear(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    // The deck-app image for the dial: just the action name (#775 convention).
    // Without this the app falls back to keypad iconography for the dial slot.
    action
      .setImage(renderDialNameIcon({ line1: "FORCE", line2: "FEEDBACK", backgroundColor: "#2a2a4a" }))
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
    // Bust the memo so the next render reflects the new setting even if it
    // happens to format to the same value string as the previous one.
    ctx.lastRenderSig = null;

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  async rotate(action: IDeckActionContext, dial: DialSettings, ticks: number, pressed: boolean): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    // A pressed rotation still adjusts the setting; the guard makes the dialUp
    // classifier skip the press gesture so holding-and-turning never also runs
    // Auto FFB. The displayed value settles a beat later from telemetry.
    if (pressed) {
      ctx.rotatedWhilePressed = true;
    }

    if (ticks === 0) return;

    const direction: ForceFeedbackDirection = ticks > 0 ? "increase" : "decrease";
    const key = rotationKey(ctx.dial.setting, direction);

    if (!key) {
      this.host.logger.warn(`No global key mapping for ${ctx.dial.setting} ${direction}`);

      return;
    }

    // Scale by |ticks|, capped per event: a fast spin advances several detents
    // (each key steps a fixed amount per press) but never queues an unbounded
    // burst.
    const taps = Math.min(Math.abs(ticks), MAX_TAPS_PER_EVENT);

    this.host.logger.info("Force feedback dial rotated");
    this.host.logger.debug(`${ctx.dial.setting} ${direction} x${taps}`);

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

    this.host.logger.info(kind === "long" ? "Force feedback dial long-pressed" : "Force feedback dial pressed");
    await this.doGesture(action);
  }

  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    // hold === true → Long Touch slot; hold === false → Tap Display slot.
    const gesture = hold ? dial.longTouchAction : dial.tapAction;

    if (gesture === "none") return;

    this.ensureContext(action, dial);
    this.host.logger.info(hold ? "Force feedback dial long touch" : "Force feedback dial tap");
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
    // arriving while the setFeedback push is still in flight would otherwise
    // each fire another push inside the same 100 ms window, defeating the
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
   * warning tracks live binding configuration even while iRacing is offline (no
   * telemetry ticks arrive to trigger the render-on-change path).
   */
  refreshAll(): void {
    for (const ctx of this.contextsState.values()) {
      ctx.lastRenderSig = null;
      this.renderFeedback(ctx).catch((err) => {
        this.host.logger.debug(`Dial feedback refresh failed: ${String(err)}`);
      });
    }
  }

  private ensureContext(action: IDeckActionContext, dial: DialSettings): ForceFeedbackDialContext {
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

    if (action === "auto-ffb") {
      this.host.logger.info("Force feedback dial ran Auto FFB");
      await this.host.tapBinding(AUTO_COMPUTE_KEY);
    }
  }

  /**
   * The dial's primary function is rotation, which needs BOTH the increase and
   * decrease bindings of the bound setting (#612); the Auto FFB press gesture is
   * secondary and never gates the strip warning.
   */
  private computeBindingMissing(dial: DialSettings): boolean {
    const keys = [rotationKey(dial.setting, "increase"), rotationKey(dial.setting, "decrease")].filter(
      (key): key is string => key !== undefined,
    );

    return this.host.isBindingMissing(keys);
  }

  /** A compact signature of the displayed state; a feedback push is due when it changes. */
  private displayedSignature(ctx: ForceFeedbackDialContext): string {
    const value = formatDialValue(ctx.dial.setting, this.host.getTelemetry());

    return ForceFeedbackDialSurface.signature(ctx.dial.setting, value, this.computeBindingMissing(ctx.dial));
  }

  /** The one signature format shared by the change detector and the render memo. */
  private static signature(setting: ForceFeedbackDialSetting, value: string, bindingMissing: boolean): string {
    return [setting, value, bindingMissing ? "warn" : ""].join("|");
  }

  /** Pushes the encoder trigger descriptions for a dial (Elgato only). */
  private async applyTriggerDescription(ctx: ForceFeedbackDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.dial));
  }

  /** Pushes the touch-strip feedback (the full-cell dash box) when this is a dial. */
  private async renderFeedback(ctx: ForceFeedbackDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (!ctx.action.isDial()) return;

    const setting = ctx.dial.setting;
    const value = formatDialValue(setting, this.host.getTelemetry());
    const bindingMissing = this.computeBindingMissing(ctx.dial);
    const boxSvg = renderDialBox({
      width: 200,
      height: 100,
      abbr: MODE_ABBR[setting],
      value,
      colors: resolveDialBoxColors(ctx.dial.colors, MODE_COLOR[setting]),
      identityLabelScale: 0.24,
      bindingMissing,
    });
    const feedback: DeckFeedbackPayload = { box: svgToDataUri(boxSvg) };
    await ctx.action.setFeedback(feedback);

    // Reset the change-detector baseline to the state that was actually
    // RENDERED (not re-read after the await) so this pushed feedback doesn't
    // immediately re-fire the render-on-change path on the next telemetry tick
    // — and so a value that moved while setFeedback was in flight still counts
    // as a pending change instead of being memoized as already shown.
    ctx.lastRenderSig = ForceFeedbackDialSurface.signature(setting, value, bindingMissing);
    ctx.lastChangeRenderAt = Date.now();
  }
}
