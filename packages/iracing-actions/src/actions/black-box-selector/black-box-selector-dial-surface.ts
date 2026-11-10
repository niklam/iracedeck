/**
 * The dial surface of the Black Box Selector action (issue #808) — the
 * dual-surface pattern (Fuel Service #759 / Setup Brakes #775 / the six Setup
 * dials #795–#800), behind a host interface.
 *
 * Self-contained leaf (owns the `dial` schema + its dial→binding key map, and
 * operates on the `dial` sub-object). What a turn does is `dial.rotation`
 * (#1585): `boxes`, the default and the behaviour before the choice existed,
 * steps through iRacing's black boxes (clockwise Cycle Next, counter-clockwise
 * Cycle Previous); `select-control` walks the open box's controls (Select Next
 * / Previous Control); `adjust-control` changes the selected control (Increment
 * / Decrement Selected Control). Each is one tap per detent (a fast spin
 * coalesces ticks, capped per event). A press optionally opens one chosen box
 * directly, reusing the same per-box bindings and the same single-tap dispatch
 * the keypad Direct mode uses, toggles the shown box's size with iRacing's
 * Toggle Black Box Size binding (#1238), or taps Toggle / Select Next / Select
 * Previous Control (#1585) — each the same single tap its keypad press sends.
 * With rotation on Adjust Control and the press on Next Control, one dial
 * walks the box's controls and adjusts each.
 *
 * iRacing exposes no telemetry for which black box is currently open, nor for
 * the selected control (the documented #782 identity-only compromise), so the
 * dial's own screen — the Stream Deck+ strip or the Stream Dock knob segment —
 * is STATIC: it shows action identity — a "BB" badge and a wordmark naming what
 * a turn does (BLACK BOX / SELECT / ADJUST) — with no readback, drawn by this
 * surface itself for each screen (`renderBlackBoxStrip` / `renderBlackBoxKnob`,
 * #1013). Its only live element is the #612 missing-binding warning, which dims
 * the drawing when either binding of the chosen rotation isn't set — a
 * gesture's binding is reported by its PI status line, not on the strip; the
 * warning refreshes on global-settings changes (`refreshAll`), per context
 * since each dial may turn a different pair, not from telemetry, so this
 * surface never subscribes to the telemetry tick.
 */
import {
  applyBindingWarning,
  type DeckTriggerDescription,
  type DialCanvasProfile,
  escapeXml,
  getDualPressThresholdMs,
  type IDeckActionContext,
  svgToDataUri,
} from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";
import z from "zod";

import { BLACK_BOX_CONTROL_KEYS, BLACK_BOX_GLOBAL_KEYS, type BlackBoxId } from "../../shared/black-box.js";
import { dialAppearanceFields, type DialBoxColors, resolveDialBoxColors } from "../../shared/dial-box.js";
import { KNOB_BOX_HEIGHT, KNOB_BOX_WIDTH } from "../../shared/dial-knob-box.js";
import { pushDialNameIcon } from "../../shared/dial-name-icon.js";
import { classifyDialReleaseForHost } from "../../shared/dial-release.js";
import { type DialGestures, gestureSlots, ReleaseDialSurfaceBase } from "../../shared/dial-surface-base.js";

/** Cap on binding taps dispatched for one rotate event (a fast spin coalesces ticks). */
const MAX_TAPS_PER_EVENT = 5;

/** iRacing's Toggle Black Box Size binding — the key the keypad Toggle Size mode uses (#1238). */
const TOGGLE_SIZE_KEY = BLACK_BOX_CONTROL_KEYS.toggleSize;

/**
 * What a turn of the dial does (#1585): step through the boxes, walk the open
 * box's controls, or change the selected control. `boxes` is first and the
 * default, so a dial stored before the choice existed keeps cycling boxes.
 */
export const ROTATIONS = ["boxes", "select-control", "adjust-control"] as const;
export type DialRotation = (typeof ROTATIONS)[number];

/**
 * The two bindings each rotation taps, clockwise and counter-clockwise — the
 * keys the keypad Next / Previous and Selected Control presses use. Also the
 * pair the strip's #612 warning checks.
 */
export const ROTATION_KEYS: Record<DialRotation, { clockwise: string; counterClockwise: string }> = {
  boxes: { clockwise: BLACK_BOX_CONTROL_KEYS.cycleNext, counterClockwise: BLACK_BOX_CONTROL_KEYS.cyclePrevious },
  "select-control": {
    clockwise: BLACK_BOX_CONTROL_KEYS.selectNextControl,
    counterClockwise: BLACK_BOX_CONTROL_KEYS.selectPreviousControl,
  },
  "adjust-control": {
    clockwise: BLACK_BOX_CONTROL_KEYS.incrementControl,
    counterClockwise: BLACK_BOX_CONTROL_KEYS.decrementControl,
  },
};

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

/**
 * `open-selected-box` taps the per-box binding chosen by `dial.pressBox`;
 * `toggle-size` taps Toggle Black Box Size (#1238); `toggle-control`,
 * `next-control` and `previous-control` tap Toggle / Select Next / Select
 * Previous Control (#1585).
 */
export const GESTURE_ACTIONS = [
  "open-selected-box",
  "toggle-size",
  "toggle-control",
  "next-control",
  "previous-control",
  "none",
] as const;
export type GestureSlot = (typeof GESTURE_ACTIONS)[number];

/**
 * The binding each selected-control gesture taps (#1585) — the keys the keypad
 * Selected Control mode's Toggle / Next / Previous presses use. One map for the
 * dispatch and the #612 comms catalog, which a test holds to it.
 */
export const GESTURE_CONTROL_KEYS = {
  "toggle-control": BLACK_BOX_CONTROL_KEYS.toggleControl,
  "next-control": BLACK_BOX_CONTROL_KEYS.selectNextControl,
  "previous-control": BLACK_BOX_CONTROL_KEYS.selectPreviousControl,
} as const satisfies Partial<Record<GestureSlot, string>>;

export const DialSettings = z
  .object({
    // What a turn does (#1585); missing on a dial stored before the choice, which keeps cycling boxes.
    rotation: z.enum(ROTATIONS).default("boxes"),
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
  const description: DeckTriggerDescription = { rotate: rotationLabel(dial.rotation) };

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

/** The deck's trigger-description label for a turn, by what the turn does (#1585). */
function rotationLabel(rotation: DialRotation): string {
  switch (rotation) {
    case "boxes":
      return "Cycle black boxes";
    case "select-control":
      return "Select control";
    case "adjust-control":
      return "Adjust control";
    default: {
      const unhandled: never = rotation;

      throw new Error(`Black Box Selector: no label for dial rotation "${String(unhandled)}"`);
    }
  }
}

/** The deck's trigger-description label for a gesture slot, or `undefined` for `none` (no label shown). */
function gestureLabel(action: GestureSlot): string | undefined {
  switch (action) {
    case "open-selected-box":
      return "Open selected box";
    case "toggle-size":
      return "Toggle box size";
    case "toggle-control":
      return "Toggle selected control";
    case "next-control":
      return "Select next control";
    case "previous-control":
      return "Select previous control";
    case "none":
      return undefined;
    default: {
      const unhandled: never = action;

      throw new Error(`Black Box Selector: no label for dial gesture "${String(unhandled)}"`);
    }
  }
}

/**
 * @internal Exported for testing
 *
 * The wordmark the dial's screen shows under the badge (#1585): what a turn
 * does, since iRacing reports neither the open box nor the selected control.
 */
export function rotationWordmark(rotation: DialRotation): string {
  switch (rotation) {
    case "boxes":
      return "BLACK BOX";
    case "select-control":
      return "SELECT";
    case "adjust-control":
      return "ADJUST";
    default: {
      const unhandled: never = rotation;

      throw new Error(`Black Box Selector: no wordmark for dial rotation "${String(unhandled)}"`);
    }
  }
}

/** What the strip and the knob drawings take. */
interface BlackBoxDrawingArgs {
  colors: DialBoxColors;
  bindingMissing: boolean;
  /** The wordmark under the badge; {@link rotationWordmark}. Defaults to `BLACK BOX`. */
  wordmark?: string;
}

/**
 * @internal Exported for testing
 *
 * Draws the 200×100 touch-strip slot as one self-drawn pixmap: an inset rounded
 * panel with a "BB" badge and a wordmark naming what a turn does — action
 * identity only, since iRacing exposes no open-box readback. When either
 * binding of the chosen rotation is unset the content dims under the centered
 * #612 warning triangle. Text y values are BASELINES (the deck app's QT
 * renderer ignores dominant-baseline); the wordmark is centred on x, so the
 * shorter SELECT / ADJUST sit where BLACK BOX does.
 */
export function renderBlackBoxStrip(args: BlackBoxDrawingArgs): string {
  const { colors, bindingMissing, wordmark = "BLACK BOX" } = args;
  const w = 200;
  const h = 100;
  const inset = 7;
  const strokeWidth = 9;
  const innerRx = 10;

  const panel = `<rect x="${inset}" y="${inset}" width="${w - 2 * inset}" height="${h - 2 * inset}" rx="${innerRx}" fill="${colors.background}" stroke="${colors.border}" stroke-width="${strokeWidth}"/>`;

  const badge =
    `<rect x="72" y="20" width="56" height="34" rx="7" fill="none" stroke="${colors.border}" stroke-width="3"/>` +
    `<text x="100" y="45" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="22" font-weight="bold">BB</text>`;

  const label = `<text x="100" y="78" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="17" font-weight="bold">${escapeXml(wordmark)}</text>`;

  const content = badge + label;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    panel +
    `${bindingMissing ? applyBindingWarning(content, { width: w, height: h }) : content}</svg>`
  );
}

/**
 * @internal Exported for testing
 *
 * The knob-screen version of {@link renderBlackBoxStrip} (#1013): the same
 * badge and wordmark, composed for the squarer 176×112 segment — the badge
 * larger and higher, the wordmark on its own line beneath, centred on x. The
 * panel frame is the shared knob box's (inset 5, stroke 6, outer radius 18 →
 * rx 13), so Black Box sits in the same frame as every other knob surface.
 */
export function renderBlackBoxKnob(args: BlackBoxDrawingArgs): string {
  const { colors, bindingMissing, wordmark = "BLACK BOX" } = args;
  const w = KNOB_BOX_WIDTH;
  const h = KNOB_BOX_HEIGHT;
  const inset = 5;
  const strokeWidth = 6;

  const panel = `<rect x="${inset}" y="${inset}" width="${w - 2 * inset}" height="${h - 2 * inset}" rx="13" fill="${colors.background}" stroke="${colors.border}" stroke-width="${strokeWidth}"/>`;
  const badge =
    `<rect x="56" y="18" width="64" height="40" rx="8" fill="none" stroke="${colors.border}" stroke-width="3"/>` +
    `<text x="88" y="47" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="26" font-weight="bold">BB</text>`;
  const label = `<text x="88" y="90" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="18" font-weight="bold">${escapeXml(wordmark)}</text>`;
  const content = badge + label;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    panel +
    `${bindingMissing ? applyBindingWarning(content, { width: w, height: h }) : content}</svg>`
  );
}

/**
 * Picks Black Box's own drawing for the dial's screen — exhaustive over the
 * profile ids, like `renderDialBox`, so a new canvas cannot silently get the
 * strip drawing.
 */
function renderBlackBoxFor(canvas: DialCanvasProfile, args: BlackBoxDrawingArgs): string {
  switch (canvas.id) {
    case "sd-plus-strip":
      return renderBlackBoxStrip(args);
    case "stream-dock-knob":
      return renderBlackBoxKnob(args);
    default: {
      // A new DialCanvasId must get its own drawing here: this line stops compiling until it does.
      const unhandled: never = canvas.id;

      throw new Error(`Black Box Selector: no drawing for dial canvas "${String(unhandled)}"`);
    }
  }
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
  tapBinding(settingKey: string): Promise<boolean>;
  isBindingMissing(keys: string | string[] | null | undefined): boolean;
}

export class BlackBoxSelectorDialSurface extends ReleaseDialSurfaceBase<BlackBoxDialContext, DialSettings> {
  constructor(protected override readonly host: BlackBoxSelectorDialHost) {
    super();
  }

  async willAppear(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    pushDialNameIcon(action, { line1: "BLACK", line2: "BOX", backgroundColor: "#2a2a2a" }, this.host.logger);

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  willDisappear(actionId: string): void {
    this.forgetContext(actionId);
  }

  async didReceiveSettings(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  async rotate(action: IDeckActionContext, dial: DialSettings, ticks: number, pressed: boolean): Promise<void> {
    const ctx = this.inputContext(action, dial, "rotate");

    if (!ctx) return;

    if (pressed) {
      ctx.rotatedWhilePressed = true;
    }

    if (ticks === 0) return;

    const { rotation } = ctx.dial;
    const keys = ROTATION_KEYS[rotation];
    const key = ticks > 0 ? keys.clockwise : keys.counterClockwise;
    const taps = Math.min(Math.abs(ticks), MAX_TAPS_PER_EVENT);

    this.host.logger.info("Black box dial rotated");
    this.host.logger.debug(`${rotation} ${ticks > 0 ? "clockwise" : "counter-clockwise"} ×${taps}`);

    for (let i = 0; i < taps; i++) {
      await this.host.tapBinding(key);
    }
  }

  down(action: IDeckActionContext, dial: DialSettings): void {
    const ctx = this.inputContext(action, dial, "down");

    if (!ctx) return;

    ctx.pressStart = Date.now();
    ctx.rotatedWhilePressed = false;
  }

  async up(actionId: string): Promise<void> {
    const ctx = this.contextsState.get(actionId);

    if (!ctx) return;

    const pressStartMs = ctx.pressStart;
    ctx.pressStart = 0;

    if (pressStartMs === 0) return;

    // Where the extended gestures are compiled out a release is never long: a
    // knob press never reports its release (`classifyDialReleaseForHost`).
    const kind = classifyDialReleaseForHost({
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
    if (!__FEATURE_DIAL_EXTENDED_GESTURES__) return;

    const gesture = hold ? dial.longTouchAction : dial.tapAction;

    if (gesture === "none") return;

    const ctx = this.inputContext(action, dial, "touchTap");

    if (!ctx) return;

    this.host.logger.info(hold ? "Black box dial long touch" : "Black box dial tap");
    await this.doGesture(ctx, gesture);
  }

  refreshAll(): void {
    for (const ctx of this.contextsState.values()) {
      // Only the missing-binding warning can change from global settings; skip
      // an echo that leaves it unchanged so the dial screen stays under ≤10 pushes/s.
      // Per context: each dial's warning is about the pair its own rotation turns.
      if (this.computeBindingMissing(ctx) === ctx.lastWarn) continue;

      this.renderFeedback(ctx).catch((err) => {
        this.host.logger.debug(`Dial feedback refresh failed: ${String(err)}`);
      });
    }
  }

  protected override createContext(action: IDeckActionContext, dial: DialSettings): BlackBoxDialContext {
    return { dial, action, pressStart: 0, rotatedWhilePressed: false, lastWarn: null };
  }

  protected override refreshContext(ctx: BlackBoxDialContext, action: IDeckActionContext, dial: DialSettings): void {
    ctx.action = action;
    ctx.dial = dial;
  }

  protected override dialGestures(_ctx: BlackBoxDialContext, dial: DialSettings): DialGestures {
    return gestureSlots(dial);
  }

  /**
   * Runs one press or touch gesture: a single tap of the binding it names (the
   * box chosen by `dial.pressBox`, Toggle Black Box Size, or a selected-control
   * press), never a #818 prime sequence. Exhaustive over {@link GESTURE_ACTIONS}.
   */
  private async doGesture(ctx: BlackBoxDialContext, gesture: GestureSlot): Promise<void> {
    switch (gesture) {
      case "none":
        return;
      case "open-selected-box": {
        const key = BLACK_BOX_GLOBAL_KEYS[ctx.dial.pressBox];
        this.host.logger.info("Black box dial opened selected box");
        this.host.logger.debug(`Open ${ctx.dial.pressBox}`);
        // Mirrors the keypad Direct mode exactly: a single tap of the per-box
        // binding. Direct-mode selection toggles the box, so this can hide the box
        // when it is already shown — the same behavior a keypad Direct press has.
        await this.host.tapBinding(key);

        return;
      }
      case "toggle-size":
        this.host.logger.info("Black box dial toggled box size");
        // Mirrors the keypad Toggle Size mode: one tap, no #818 prime — the
        // resize acts on whichever box is shown (#1238).
        await this.host.tapBinding(TOGGLE_SIZE_KEY);

        return;
      case "toggle-control":
      case "next-control":
      case "previous-control":
        this.host.logger.info(`Black box dial gesture ${gesture}`);
        // Mirrors the keypad Selected Control mode's press: one tap on the open box (#1585).
        await this.host.tapBinding(GESTURE_CONTROL_KEYS[gesture]);

        return;
      default: {
        // A new gesture must be dispatched here: this line stops compiling until it is.
        const unhandled: never = gesture;

        throw new Error(`Black Box Selector: no dial gesture "${String(unhandled)}"`);
      }
    }
  }

  /** The strip warns when either binding the context's rotation turns is unset (#612, #1585). */
  private computeBindingMissing(ctx: BlackBoxDialContext): boolean {
    const keys = ROTATION_KEYS[ctx.dial.rotation];

    return this.host.isBindingMissing([keys.clockwise, keys.counterClockwise]);
  }

  private async applyTriggerDescription(ctx: BlackBoxDialContext): Promise<void> {
    if (!__FEATURE_DIAL_EXTENDED_GESTURES__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.dial));
  }

  private async renderFeedback(ctx: BlackBoxDialContext): Promise<void> {
    // The dial's own screen decides the drawing; a key or a host with no dial
    // screen has nothing to draw on (#1013).
    const canvas = ctx.action.dialCanvas();

    if (!canvas) return;

    const bindingMissing = this.computeBindingMissing(ctx);
    const args = {
      colors: resolveDialBoxColors(ctx.dial.colors, ACCENT),
      bindingMissing,
      wordmark: rotationWordmark(ctx.dial.rotation),
    };
    await ctx.action.setDialCanvas(svgToDataUri(renderBlackBoxFor(canvas, args)));

    ctx.lastWarn = bindingMissing;
  }
}
