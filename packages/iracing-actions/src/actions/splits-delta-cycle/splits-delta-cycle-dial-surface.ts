/**
 * The dial surface of the Splits & Reference action (issue #807) — the
 * dual-surface pattern (Fuel Service #759 / Setup Brakes #775 / the six Setup
 * dials #795–#800), behind a host interface.
 *
 * The smallest surface of the batch: a SINGLE rotation behavior, so there is no
 * `dial.setting` select. Turning the dial cycles iRacing's splits / delta
 * display modes — clockwise taps the Next binding, counter-clockwise the
 * Previous binding — scaled by the (possibly coalesced) tick magnitude and
 * capped per event so a fast spin steps several detents without runaway.
 *
 * iRacing exposes no telemetry for the currently selected splits mode, so the
 * touch strip is IDENTITY-ONLY (a static label, never a live value — the #782
 * compromise) and the surface never subscribes to telemetry. The only dynamic
 * part of the strip is the #612 missing-binding warning, refreshed by the
 * owning action via `refreshAll()` on global-settings changes.
 *
 * Pressing runs a configurable gesture, defaulting to Toggle Reference Car —
 * harmless and the natural companion to mode cycling.
 */
import {
  classifyDialRelease,
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  getDualPressThresholdMs,
  type IDeckActionContext,
  svgToDataUri,
} from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";
import z from "zod";

import { dialAppearanceFields, renderDialBox, resolveDialBoxColors } from "../../shared/dial-box.js";
import { renderDialNameIcon } from "../../shared/dial-name-icon.js";

/**
 * The global-settings binding keys the dial taps — shared verbatim with the
 * keypad surface (the `cycle` mode's Next / Previous and the reference-car
 * toggle). No new bindings are introduced.
 */
export const SPLITS_DIAL_KEYS = {
  next: "splitsDeltaNext",
  previous: "splitsDeltaPrevious",
  toggleRefCar: "toggleUiDisplayRefCar",
} as const;

/**
 * Maximum rotation taps dispatched from a single (coalesced) rotate event. A
 * fast spin reports |ticks| > 1; each tick steps one delta mode, capped so a
 * flick can't fire an unbounded burst (the Audio Controls tick-scaling model).
 */
const MAX_TAPS_PER_EVENT = 5;

/** The dash box's short identity label — no readback exists (iRacing gives no splits mode). */
const IDENTITY_ABBR = "DELTA";

/** The dash box accent (border / label default) — the action's identity purple. */
const ACCENT_COLOR = "#9b59b6";

/** Gesture slots offered by the press / touch options (Toggle Reference Car or nothing). */
export const GESTURE_ACTIONS = ["toggle-ref-car", "none"] as const;
export type SplitsDialGesture = (typeof GESTURE_ACTIONS)[number];

export const DialSettings = z
  .object({
    // Press defaults to Toggle Reference Car (#807) — harmless and the natural
    // companion to mode cycling. The other three slots default None (blind-safe:
    // a VR driver who can't see the strip isn't surprised by a touch gesture).
    pressAction: z.enum(GESTURE_ACTIONS).default("toggle-ref-car"),
    longPressAction: z.enum(GESTURE_ACTIONS).default("none"),
    tapAction: z.enum(GESTURE_ACTIONS).default("none"),
    longTouchAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Dash-box appearance overrides (colors, issue #811).
    ...dialAppearanceFields,
  })
  .prefault({});

export type DialSettings = z.infer<typeof DialSettings>;

/** Human-readable label for a gesture slot (for the encoder trigger description). */
function gestureLabel(action: SplitsDialGesture): string | undefined {
  switch (action) {
    case "toggle-ref-car":
      return "Toggle Reference Car";
    case "none":
      return undefined;
  }
}

/**
 * @internal Exported for testing
 *
 * Computes the encoder trigger descriptions from the current settings. `rotate`
 * always cycles the splits / delta mode; `push` carries the press action with
 * the long-press as a "(hold: …)" hint; `touch` / `longTouch` carry the
 * touch-strip gestures.
 */
export function buildTriggerDescription(dial: DialSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = {
    rotate: "Cycle splits / delta mode",
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

/** Per-context runtime state. */
interface SplitsDeltaCycleDialContext {
  dial: DialSettings;
  action: IDeckActionContext;
  /** Timestamp (ms) the current dial-button press started (dialDown). */
  pressStart: number;
  /**
   * Whether the dial was rotated while the button was held during the current
   * press. Set in rotate (pressed === true), read once at dialUp so a push+turn
   * (adjust without firing the press gesture) fires no gesture on release.
   */
  rotatedWhilePressed: boolean;
}

/**
 * The delegates the surface needs from its owning action. Binding dispatch
 * stays on the action so keyboard/SimHub routing is unchanged. Deliberately NO
 * `setActiveBinding`: readiness is one value per action-class instance and
 * setting it from a dial context would bleed onto the action's keypad buttons
 * (see global-settings.md), so the dial computes its own missing-binding state
 * from the injected `isBindingMissing`. No `getTelemetry` either — the strip is
 * identity-only, with nothing to read.
 */
export interface SplitsDeltaCycleDialHost {
  readonly logger: ILogger;
  tapBinding(settingKey: string): Promise<void>;
  isBindingMissing(keys: string | string[] | null | undefined): boolean;
}

/**
 * Owns all per-dial-context state, dispatches rotations and gestures, and
 * renders the touch-strip feedback. The owning action routes every dial
 * lifecycle/input event here.
 */
export class SplitsDeltaCycleDialSurface {
  private readonly contextsState = new Map<string, SplitsDeltaCycleDialContext>();

  constructor(private readonly host: SplitsDeltaCycleDialHost) {}

  async willAppear(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    // The deck-app image for the dial: just the action name. Without this the
    // app falls back to keypad iconography for the dial slot.
    action
      .setImage(renderDialNameIcon({ line1: "SPLITS", line2: "DELTA", backgroundColor: "#412244" }))
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

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  async rotate(action: IDeckActionContext, dial: DialSettings, ticks: number, pressed: boolean): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    // A pressed rotation still cycles; the guard makes the dialUp classifier
    // skip the press gesture so holding-and-turning never also toggles the
    // reference car.
    if (pressed) {
      ctx.rotatedWhilePressed = true;
    }

    if (ticks === 0) return;

    const key = ticks > 0 ? SPLITS_DIAL_KEYS.next : SPLITS_DIAL_KEYS.previous;
    // Scale by tick magnitude (coalesced fast spins report |ticks| > 1), capped
    // so a flick advances several detents without a runaway burst.
    const taps = Math.min(Math.abs(ticks), MAX_TAPS_PER_EVENT);

    this.host.logger.info("Splits & Reference dial rotated");
    this.host.logger.debug(`${ticks > 0 ? "next" : "previous"} x${taps}`);

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

    this.host.logger.info(kind === "long" ? "Splits & Reference dial long-pressed" : "Splits & Reference dial pressed");
    await this.doGesture(action);
  }

  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    // hold === true → Long Touch slot; hold === false → Tap Display slot.
    const gesture = hold ? dial.longTouchAction : dial.tapAction;

    if (gesture === "none") return;

    this.ensureContext(action, dial);
    this.host.logger.info(hold ? "Splits & Reference dial long touch" : "Splits & Reference dial tap");
    await this.doGesture(gesture);
  }

  /**
   * Re-renders every dial context. Called by the owning action on
   * global-settings changes so the strip's #612 missing-binding warning tracks
   * live binding configuration even while iRacing is offline (an identity-only
   * strip has no telemetry ticks to trigger a redraw otherwise).
   */
  refreshAll(): void {
    for (const ctx of this.contextsState.values()) {
      this.renderFeedback(ctx).catch((err) => {
        this.host.logger.debug(`Dial feedback refresh failed: ${String(err)}`);
      });
    }
  }

  private ensureContext(action: IDeckActionContext, dial: DialSettings): SplitsDeltaCycleDialContext {
    let ctx = this.contextsState.get(action.id);

    if (!ctx) {
      ctx = {
        dial,
        action,
        pressStart: 0,
        rotatedWhilePressed: false,
      };
      this.contextsState.set(action.id, ctx);
    } else {
      ctx.action = action;
      ctx.dial = dial;
    }

    return ctx;
  }

  /** Runs a configured press / touch gesture. */
  private async doGesture(action: SplitsDialGesture): Promise<void> {
    if (action === "none") return;

    if (action === "toggle-ref-car") {
      this.host.logger.info("Splits & Reference dial toggled reference car");
      await this.host.tapBinding(SPLITS_DIAL_KEYS.toggleRefCar);
    }
  }

  /**
   * The dial's primary function is rotation, which needs BOTH the Next and
   * Previous bindings (#612); the reference-car press gesture is secondary and
   * never gates the strip warning.
   */
  private computeBindingMissing(): boolean {
    return this.host.isBindingMissing([SPLITS_DIAL_KEYS.next, SPLITS_DIAL_KEYS.previous]);
  }

  /** Pushes the encoder trigger descriptions for a dial (Elgato only). */
  private async applyTriggerDescription(ctx: SplitsDeltaCycleDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.dial));
  }

  /** Pushes the identity-only touch-strip feedback (the full-cell dash box) when this is a dial. */
  private async renderFeedback(ctx: SplitsDeltaCycleDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (!ctx.action.isDial()) return;

    const boxSvg = renderDialBox({
      width: 200,
      height: 100,
      abbr: IDENTITY_ABBR,
      // Identity-only: no readback exists, so the box draws just the label.
      value: "",
      colors: resolveDialBoxColors(ctx.dial.colors, ACCENT_COLOR),
      bindingMissing: this.computeBindingMissing(),
    });
    const feedback: DeckFeedbackPayload = { box: svgToDataUri(boxSvg) };
    await ctx.action.setFeedback(feedback);
  }
}
