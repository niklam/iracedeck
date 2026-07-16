/**
 * The dial surface of the Black Box Selector action (issue #808) — the
 * dual-surface pattern (Fuel Service #759 / Setup Brakes #775 / the six Setup
 * dials #795–#800), behind a host interface.
 *
 * Self-contained leaf (owns the `dial` schema + its dial→binding key map, and
 * operates on the `dial` sub-object). Turning steps through iRacing's black
 * boxes — clockwise taps the Cycle Next binding, counter-clockwise Cycle
 * Previous — one detent per box (a fast spin coalesces ticks, capped per event).
 * A press optionally opens one chosen box directly, reusing the same per-box
 * bindings and the same single-tap dispatch the keypad Direct mode uses.
 *
 * iRacing exposes no telemetry for which black box is currently open (the
 * documented #782 identity-only compromise), so the touch strip is STATIC: it
 * shows action identity — a "BB" badge and the "BLACK BOX" wordmark — with no
 * open-box readback. Its only live element is the #612 missing-binding warning,
 * which dims the strip when the Cycle bindings aren't set; that refreshes on
 * global-settings changes (`refreshAll`), not from telemetry, so this surface
 * never subscribes to the telemetry tick.
 */
import {
  applyBindingWarning,
  classifyDialRelease,
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  getDualPressThresholdMs,
  type IDeckActionContext,
  svgToDataUri,
} from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";
import z from "zod";

import { BLACK_BOX_GLOBAL_KEYS, type BlackBoxId } from "../../shared/black-box.js";
import { dialAppearanceFields, type DialBoxColors, resolveDialBoxColors } from "../../shared/dial-box.js";
import { renderDialNameIcon } from "../../shared/dial-name-icon.js";

/** Cap on binding taps dispatched for one rotate event (a fast spin coalesces ticks). */
const MAX_TAPS_PER_EVENT = 5;

/** Cycle bindings the rotation taps — the same keys the keypad Next / Previous modes use. */
const CYCLE_NEXT_KEY = "blackBoxCycleNext";
const CYCLE_PREVIOUS_KEY = "blackBoxCyclePrevious";

/** Warm amber accent, matching the black-box icon family (olive glass / amber data). */
const ACCENT = "#d4a017";

/**
 * The eleven direct-open targets — the keypad Direct mode's Black Box options.
 * `satisfies` guards that every entry is a real {@link BlackBoxId}; the map
 * {@link BLACK_BOX_GLOBAL_KEYS} then resolves each to its global-settings key.
 */
export const PRESS_BOXES = [
  "lap-timing",
  "standings",
  "relative",
  "fuel",
  "tires",
  "tire-info",
  "pit-stop",
  "in-car",
  "mirror",
  "radio",
  "weather",
] as const satisfies readonly BlackBoxId[];
export type PressBox = (typeof PRESS_BOXES)[number];

/** `open-selected-box` taps the per-box binding chosen by `dial.pressBox`. */
export const GESTURE_ACTIONS = ["open-selected-box", "none"] as const;
export type GestureSlot = (typeof GESTURE_ACTIONS)[number];

export const DialSettings = z
  .object({
    // Which box a press opens directly (the keypad Direct mode's 11 options).
    pressBox: z.enum(PRESS_BOXES).default("lap-timing"),
    pressAction: z.enum(GESTURE_ACTIONS).default("none"),
    longPressAction: z.enum(GESTURE_ACTIONS).default("none"),
    tapAction: z.enum(GESTURE_ACTIONS).default("none"),
    longTouchAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Dash-box appearance overrides (colors, issue #811).
    ...dialAppearanceFields,
  })
  .prefault({});

export type DialSettings = z.infer<typeof DialSettings>;

/** @internal Exported for testing */
export function buildTriggerDescription(dial: DialSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = { rotate: "Cycle black boxes" };

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

function gestureLabel(action: GestureSlot): string | undefined {
  switch (action) {
    case "open-selected-box":
      return "Open selected box";
    case "none":
      return undefined;
  }
}

/**
 * @internal Exported for testing
 *
 * Draws the 200×100 touch-strip slot as one self-drawn pixmap: an inset rounded
 * panel with a "BB" badge and the "BLACK BOX" wordmark — action identity only,
 * since iRacing exposes no open-box readback. When the Cycle bindings are unset
 * the content dims under the centered #612 warning triangle. Text y values are
 * BASELINES (the deck app's QT renderer ignores dominant-baseline).
 */
export function renderBlackBoxStrip(args: { colors: DialBoxColors; bindingMissing: boolean }): string {
  const { colors, bindingMissing } = args;
  const w = 200;
  const h = 100;
  const inset = 7;
  const strokeWidth = 9;
  const innerRx = 10;

  const panel = `<rect x="${inset}" y="${inset}" width="${w - 2 * inset}" height="${h - 2 * inset}" rx="${innerRx}" fill="${colors.background}" stroke="${colors.border}" stroke-width="${strokeWidth}"/>`;

  const badge =
    `<rect x="72" y="20" width="56" height="34" rx="7" fill="none" stroke="${colors.border}" stroke-width="3"/>` +
    `<text x="100" y="45" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="22" font-weight="bold">BB</text>`;

  const label = `<text x="100" y="78" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="17" font-weight="bold">BLACK BOX</text>`;

  const content = badge + label;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    panel +
    `${bindingMissing ? applyBindingWarning(content, { width: w, height: h }) : content}</svg>`
  );
}

interface BlackBoxDialContext {
  dial: DialSettings;
  action: IDeckActionContext;
  pressStart: number;
  rotatedWhilePressed: boolean;
  /** Last-rendered missing-binding state, so a global-settings echo re-renders only on change. */
  lastWarn: boolean | null;
}

export interface BlackBoxSelectorDialHost {
  readonly logger: ILogger;
  tapBinding(settingKey: string): Promise<void>;
  isBindingMissing(keys: string | string[] | null | undefined): boolean;
}

export class BlackBoxSelectorDialSurface {
  private readonly contextsState = new Map<string, BlackBoxDialContext>();

  constructor(private readonly host: BlackBoxSelectorDialHost) {}

  async willAppear(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    action.setImage(renderDialNameIcon({ line1: "BLACK", line2: "BOX", backgroundColor: "#2a2a2a" })).catch((err) => {
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

    if (pressed) {
      ctx.rotatedWhilePressed = true;
    }

    if (ticks === 0) return;

    const key = ticks > 0 ? CYCLE_NEXT_KEY : CYCLE_PREVIOUS_KEY;
    const taps = Math.min(Math.abs(ticks), MAX_TAPS_PER_EVENT);

    this.host.logger.info("Black box dial rotated");
    this.host.logger.debug(`${ticks > 0 ? "next" : "previous"} ×${taps}`);

    for (let i = 0; i < taps; i++) {
      await this.host.tapBinding(key);
    }
  }

  down(action: IDeckActionContext, dial: DialSettings): void {
    const ctx = this.ensureContext(action, dial);

    ctx.pressStart = Date.now();
    ctx.rotatedWhilePressed = false;
  }

  async up(actionId: string): Promise<void> {
    const ctx = this.contextsState.get(actionId);

    if (!ctx) return;

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

    const gesture = kind === "long" ? ctx.dial.longPressAction : ctx.dial.pressAction;

    if (gesture === "none") return;

    this.host.logger.info(kind === "long" ? "Black box dial long-pressed" : "Black box dial pressed");
    await this.doGesture(ctx, gesture);
  }

  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    const gesture = hold ? dial.longTouchAction : dial.tapAction;

    if (gesture === "none") return;

    const ctx = this.ensureContext(action, dial);
    this.host.logger.info(hold ? "Black box dial long touch" : "Black box dial tap");
    await this.doGesture(ctx, gesture);
  }

  refreshAll(): void {
    for (const ctx of this.contextsState.values()) {
      // Only the missing-binding warning can change from global settings; skip
      // an echo that leaves it unchanged so the strip stays under ≤10 setFeedback/s.
      if (this.computeBindingMissing() === ctx.lastWarn) continue;

      this.renderFeedback(ctx).catch((err) => {
        this.host.logger.debug(`Dial feedback refresh failed: ${String(err)}`);
      });
    }
  }

  private ensureContext(action: IDeckActionContext, dial: DialSettings): BlackBoxDialContext {
    let ctx = this.contextsState.get(action.id);

    if (!ctx) {
      ctx = { dial, action, pressStart: 0, rotatedWhilePressed: false, lastWarn: null };
      this.contextsState.set(action.id, ctx);
    } else {
      ctx.action = action;
      ctx.dial = dial;
    }

    return ctx;
  }

  private async doGesture(ctx: BlackBoxDialContext, gesture: GestureSlot): Promise<void> {
    if (gesture === "none") return;

    if (gesture === "open-selected-box") {
      const key = BLACK_BOX_GLOBAL_KEYS[ctx.dial.pressBox];
      this.host.logger.info("Black box dial opened selected box");
      this.host.logger.debug(`Open ${ctx.dial.pressBox}`);
      // Mirrors the keypad Direct mode exactly: a single tap of the per-box
      // binding. Direct-mode selection toggles the box, so this can hide the box
      // when it is already shown — the same behavior a keypad Direct press has.
      await this.host.tapBinding(key);
    }
  }

  /** The strip warns when either Cycle binding (rotation) is unset (#612). */
  private computeBindingMissing(): boolean {
    return this.host.isBindingMissing([CYCLE_NEXT_KEY, CYCLE_PREVIOUS_KEY]);
  }

  private async applyTriggerDescription(ctx: BlackBoxDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.dial));
  }

  private async renderFeedback(ctx: BlackBoxDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (!ctx.action.isDial()) return;

    const bindingMissing = this.computeBindingMissing();
    const boxSvg = renderBlackBoxStrip({
      colors: resolveDialBoxColors(ctx.dial.colors, ACCENT),
      bindingMissing,
    });
    const feedback: DeckFeedbackPayload = { box: svgToDataUri(boxSvg) };
    await ctx.action.setFeedback(feedback);

    ctx.lastWarn = bindingMissing;
  }
}
