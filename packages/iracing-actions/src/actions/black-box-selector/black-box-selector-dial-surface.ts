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
 * walks the box's controls and adjusts each. One gesture sends nothing to the
 * sim: Switch Select / Adjust flips this dial's own `dial.rotation` between
 * Select Control and Adjust Control and persists it, so one dial can do both.
 * On a Select or Adjust dial a Press the user never set toggles the selected
 * control and a Long Press switches Select / Adjust ({@link resolveGestures});
 * a dial that cycles boxes keeps both at None, as before the choice existed.
 *
 * The surface persists settings plugin-side, so its context is authoritative
 * (encoders rule 10): `willAppear` / `didReceiveSettings` assign the dial
 * settings, and every turn, release and touch reads them from the context,
 * never from an input event's payload.
 *
 * iRacing exposes no telemetry for which black box is currently open, nor for
 * the selected control (the documented #782 identity-only compromise), so the
 * dial's own screen — the Stream Deck+ strip or the Stream Dock knob segment —
 * is STATIC: it shows what a turn does, with no readback, drawn by this surface
 * itself for each screen and each rotation (#1013, #1585). Cycle Black Boxes
 * shows a "BB" badge over the BLACK BOX wordmark (`renderBlackBoxStrip` /
 * `renderBlackBoxKnob`). Select Control and Adjust Control show no badge and no
 * word: a large up/down (Select) or left/right (Adjust) arrow pair around the
 * d-pad's muted centre dot, drawn like the Selected Control key icons
 * (`renderSelectControlStrip` / `Knob`, `renderAdjustControlStrip` / `Knob`).
 * Its only live element is the #612 missing-binding warning, which dims the
 * drawing when either binding of the chosen rotation isn't set — a
 * gesture's binding is reported by its PI status line, not on the strip; the
 * warning refreshes on global-settings changes (`refreshAll`), per context
 * since each dial may turn a different pair, not from telemetry, so this
 * surface never subscribes to the telemetry tick.
 *
 * The Switch Select / Adjust long press previews its outcome mid-hold on a
 * Stream Deck+ strip (encoders rule 9, #1120): the switch is the plugin's own
 * setting, so its result is knowable. Past the long-press threshold the strip
 * shows the OTHER rotation's arrows above the shared pending bar
 * (`renderSelectControlPendingStrip` / `renderAdjustControlPendingStrip`), and
 * a long release commits the switch. A knob never reports its release, so it
 * never previews.
 */
import {
  applyBindingWarning,
  createHoldPreview,
  type DeckTriggerDescription,
  type DialCanvasProfile,
  type DialReleaseKind,
  getDualPressThresholdMs,
  type HoldPreview,
  type IDeckActionContext,
  NOOP_HOLD_PREVIEW,
  svgToDataUri,
} from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";
import z from "zod";

import { BLACK_BOX_CONTROL_KEYS, BLACK_BOX_GLOBAL_KEYS, type BlackBoxId } from "../../shared/black-box.js";
import { dialAppearanceFields, type DialBoxColors, resolveDialBoxColors } from "../../shared/dial-box.js";
import { KNOB_BOX_HEIGHT, KNOB_BOX_WIDTH } from "../../shared/dial-knob-box.js";
import { pushDialNameIcon } from "../../shared/dial-name-icon.js";
import { persistDialPatch } from "../../shared/dial-persist.js";
import { renderPendingBar } from "../../shared/dial-preview.js";
import { classifyDialReleaseForHost } from "../../shared/dial-release.js";
import { type DialGestures, ReleaseDialSurfaceBase } from "../../shared/dial-surface-base.js";

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
 * Previous Control (#1585); `switch-rotation` sends nothing and flips this
 * dial's `dial.rotation` between Select Control and Adjust Control (#1585).
 */
export const GESTURE_ACTIONS = [
  "open-selected-box",
  "toggle-size",
  "toggle-control",
  "next-control",
  "previous-control",
  "switch-rotation",
  "none",
] as const;
export type GestureSlot = (typeof GESTURE_ACTIONS)[number];

/** The rotations Switch Select / Adjust moves between: every rotation but `boxes`. */
export type SwitchableRotation = Exclude<DialRotation, "boxes">;

/**
 * The rotation `switch-rotation` takes each rotation to (#1585): Select Control
 * and Adjust Control swap. `boxes` has no entry, so the gesture does nothing on
 * a dial that cycles boxes — it never takes a dial to or from `boxes`.
 */
export const SWITCHED_ROTATION: Partial<Record<DialRotation, SwitchableRotation>> = {
  "select-control": "adjust-control",
  "adjust-control": "select-control",
};

/**
 * What a Press and a Long Press do on a dial whose slot the user never stored,
 * by what the dial turns (#1585). On a Select or Adjust dial a press toggles
 * the selected control and a long press switches Select / Adjust; a dial that
 * cycles boxes — every dial stored before the choice existed — keeps `none`,
 * so no dial a user already has changes. The touch slots have no entry: Tap
 * Display and Long Touch default to `none` on every rotation (VR safety). The
 * PI repeats this table to show an unset slot's default, and a test holds the
 * copy to it.
 */
export const ROTATION_GESTURE_DEFAULTS: Record<
  DialRotation,
  { pressAction: GestureSlot; longPressAction: GestureSlot }
> = {
  boxes: { pressAction: "none", longPressAction: "none" },
  "select-control": { pressAction: "toggle-control", longPressAction: "switch-rotation" },
  "adjust-control": { pressAction: "toggle-control", longPressAction: "switch-rotation" },
};

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
    // No schema default on these two (#1585): a slot the user never stored
    // stays unset in the parsed settings and takes its default from the
    // rotation at read time (resolveGestures), so a stored `none` — the user's
    // own choice — is told apart from a slot nobody set. Read them through
    // resolveGestures, never directly.
    pressAction: z.enum(GESTURE_ACTIONS).optional(),
    longPressAction: z.enum(GESTURE_ACTIONS).optional(),
    tapAction: z.enum(GESTURE_ACTIONS).default("none"),
    longTouchAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Dash-box appearance overrides (colors, issue #811).
    ...dialAppearanceFields,
  })
  .prefault({});

export type DialSettings = z.infer<typeof DialSettings>;

/** The four gesture slots of one dial, each resolved to the gesture it stands for. */
export interface ResolvedGestures {
  press: GestureSlot;
  longPress: GestureSlot;
  tap: GestureSlot;
  longTouch: GestureSlot;
}

/**
 * The gesture each slot of a dial stands for (#1585) — the ONE place a slot is
 * read. A stored value always wins, `none` included; an unset Press or Long
 * Press takes the rotation's default from {@link ROTATION_GESTURE_DEFAULTS}.
 * The release, the touch, the press shapes and the trigger description all
 * read the slots through here, so they cannot disagree about a default.
 */
export function resolveGestures(dial: DialSettings): ResolvedGestures {
  const defaults = ROTATION_GESTURE_DEFAULTS[dial.rotation];

  return {
    press: dial.pressAction ?? defaults.pressAction,
    longPress: dial.longPressAction ?? defaults.longPressAction,
    tap: dial.tapAction,
    longTouch: dial.longTouchAction,
  };
}

/** Whether a resolved gesture does anything on this dial: `switch-rotation` has nothing to switch on a boxes dial. */
function gestureFires(dial: DialSettings, gesture: GestureSlot): boolean {
  if (gesture === "none") return false;

  return gesture !== "switch-rotation" || SWITCHED_ROTATION[dial.rotation] !== undefined;
}

/**
 * {@link resolveGestures} with every slot that would do nothing on this dial
 * as `none` — what the dial announces: the press sounds (#269) and the
 * trigger description. A sound or a hint for Switch Select / Adjust on a dial
 * that cycles boxes would promise a change that never comes.
 */
export function firingGestures(dial: DialSettings): ResolvedGestures {
  const resolved = resolveGestures(dial);
  const firing = (gesture: GestureSlot): GestureSlot => (gestureFires(dial, gesture) ? gesture : "none");

  return {
    press: firing(resolved.press),
    longPress: firing(resolved.longPress),
    tap: firing(resolved.tap),
    longTouch: firing(resolved.longTouch),
  };
}

/**
 * @internal Exported for testing
 *
 * The rotation a long release would switch this dial to — what its hold
 * previews (encoders rule 9, #1120) — or `null` when the Long Press is not
 * Switch Select / Adjust, or is but has nothing to switch (a dial that cycles
 * boxes). Reads the slot through {@link resolveGestures}, so an unset Long
 * Press on a Select or Adjust dial previews, and the target from
 * {@link SWITCHED_ROTATION}, the table the switch itself reads: what the strip
 * promises mid-hold is what the release does.
 */
export function pendingRotationPreview(dial: DialSettings): SwitchableRotation | null {
  if (resolveGestures(dial).longPress !== "switch-rotation") return null;

  return SWITCHED_ROTATION[dial.rotation] ?? null;
}

/** @internal Exported for testing */
export function buildTriggerDescription(dial: DialSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = { rotate: rotationLabel(dial.rotation) };
  const gestures = firingGestures(dial);

  const pushLabel = gestureLabel(gestures.press);
  const holdLabel = gestureLabel(gestures.longPress);

  if (pushLabel && holdLabel) {
    description.push = `${pushLabel} (hold: ${holdLabel})`;
  } else if (pushLabel) {
    description.push = pushLabel;
  } else if (holdLabel) {
    description.push = `Hold: ${holdLabel}`;
  }

  const tapLabel = gestureLabel(gestures.tap);

  if (tapLabel) {
    description.touch = tapLabel;
  }

  const longTouchLabel = gestureLabel(gestures.longTouch);

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
    case "switch-rotation":
      return "Switch Select / Adjust";
    case "none":
      return undefined;
    default: {
      const unhandled: never = action;

      throw new Error(`Black Box Selector: no label for dial gesture "${String(unhandled)}"`);
    }
  }
}

/** What every dial-screen drawing takes. */
interface BlackBoxDrawingArgs {
  colors: DialBoxColors;
  bindingMissing: boolean;
}

/** One drawing of the dial's screen. */
type BlackBoxDrawing = (args: BlackBoxDrawingArgs) => string;

const STRIP_WIDTH = 200;
const STRIP_HEIGHT = 100;

/** The muted opacity of the d-pad key icons' unlit parts, which the arrow screens' centre dot takes. */
const MUTED_OPACITY = 0.35;

/** The stroke the approved d-pad key icons draw their arrows and centre dot with. */
const ARROW_STROKE_WIDTH = 2;

/** The Stream Deck+ strip slot's inset panel, the frame every strip drawing sits in. */
function stripFrame(colors: DialBoxColors): string {
  const inset = 7;

  return `<rect x="${inset}" y="${inset}" width="${STRIP_WIDTH - 2 * inset}" height="${STRIP_HEIGHT - 2 * inset}" rx="10" fill="${colors.background}" stroke="${colors.border}" stroke-width="9"/>`;
}

/**
 * The knob segment's panel: the shared knob box's frame (inset 5, stroke 6,
 * outer radius 18 → rx 13), so Black Box sits in the same frame as every other
 * knob surface.
 */
function knobFrame(colors: DialBoxColors): string {
  const inset = 5;

  return `<rect x="${inset}" y="${inset}" width="${KNOB_BOX_WIDTH - 2 * inset}" height="${KNOB_BOX_HEIGHT - 2 * inset}" rx="13" fill="${colors.background}" stroke="${colors.border}" stroke-width="6"/>`;
}

/**
 * Wraps a drawing's frame and content into the screen's SVG. When the
 * rotation's bindings are not all set, the content dims under the centred #612
 * warning triangle; the frame stays as it is.
 */
function screenSvg(width: number, height: number, frame: string, content: string, bindingMissing: boolean): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    frame +
    `${bindingMissing ? applyBindingWarning(content, { width, height }) : content}</svg>`
  );
}

/** Rounds a coordinate to two decimals, so a drawing's numbers stay short and stable. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

type ArrowDirection = "up" | "down" | "left" | "right";

/**
 * A filled arrow triangle centred on (cx, cy), `base` across its base and
 * `depth` from base to apex, drawn as the approved d-pad key icons draw theirs:
 * filled, with a same-colour round-joined stroke.
 */
function arrow(direction: ArrowDirection, cx: number, cy: number, base: number, depth: number, color: string): string {
  const hb = base / 2;
  const hd = depth / 2;
  let points: Array<[number, number]>;

  switch (direction) {
    case "up":
      points = [
        [cx, cy - hd],
        [cx + hb, cy + hd],
        [cx - hb, cy + hd],
      ];
      break;
    case "down":
      points = [
        [cx, cy + hd],
        [cx - hb, cy - hd],
        [cx + hb, cy - hd],
      ];
      break;
    case "left":
      points = [
        [cx - hd, cy],
        [cx + hd, cy - hb],
        [cx + hd, cy + hb],
      ];
      break;
    case "right":
      points = [
        [cx + hd, cy],
        [cx - hd, cy + hb],
        [cx - hd, cy - hb],
      ];
      break;
    default: {
      const unhandled: never = direction;

      throw new Error(`Black Box Selector: no arrow pointing "${String(unhandled)}"`);
    }
  }

  const coords = points.map(([x, y]) => `${round(x)},${round(y)}`).join(" ");

  return `<polygon points="${coords}" fill="${color}" stroke="${color}" stroke-width="${ARROW_STROKE_WIDTH}" stroke-linejoin="round"/>`;
}

/** The d-pad's centre toggle, muted: the point the arrow screens' arrows sit around. */
function centreDot(cx: number, cy: number, radius: number, color: string): string {
  return `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(radius)}" fill="${color}" stroke="${color}" stroke-width="${ARROW_STROKE_WIDTH}" opacity="${MUTED_OPACITY}"/>`;
}

/** The BLACK BOX wordmark under the Cycle Black Boxes screen's badge, centred on x. */
function blackBoxText(x: number, baseline: number, size: number, color: string): string {
  return `<text x="${x}" y="${baseline}" text-anchor="middle" fill="${color}" font-family="Arial, sans-serif" font-size="${size}" font-weight="bold">BLACK BOX</text>`;
}

/**
 * @internal Exported for testing
 *
 * The Cycle Black Boxes strip (`boxes`): the 200×100 touch-strip slot as one
 * self-drawn pixmap, an inset rounded panel with a "BB" badge over the BLACK BOX
 * wordmark — action identity only, since iRacing exposes no open-box readback.
 * Text y values are BASELINES (the deck app's QT renderer ignores
 * dominant-baseline).
 */
export function renderBlackBoxStrip({ colors, bindingMissing }: BlackBoxDrawingArgs): string {
  const content =
    `<rect x="72" y="20" width="56" height="34" rx="7" fill="none" stroke="${colors.border}" stroke-width="3"/>` +
    `<text x="100" y="45" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="22" font-weight="bold">BB</text>` +
    blackBoxText(100, 78, 17, colors.label);

  return screenSvg(STRIP_WIDTH, STRIP_HEIGHT, stripFrame(colors), content, bindingMissing);
}

/**
 * @internal Exported for testing
 *
 * The knob-screen version of {@link renderBlackBoxStrip} (#1013): the same badge
 * and wordmark, composed for the squarer 176×112 segment — the badge larger and
 * higher, the wordmark on its own line beneath, centred on x.
 */
export function renderBlackBoxKnob({ colors, bindingMissing }: BlackBoxDrawingArgs): string {
  const content =
    `<rect x="56" y="18" width="64" height="40" rx="8" fill="none" stroke="${colors.border}" stroke-width="3"/>` +
    `<text x="88" y="47" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="26" font-weight="bold">BB</text>` +
    blackBoxText(88, 90, 18, colors.label);

  return screenSvg(KNOB_BOX_WIDTH, KNOB_BOX_HEIGHT, knobFrame(colors), content, bindingMissing);
}

/**
 * @internal Exported for testing
 *
 * The Select Control strip (`select-control`, #1585): no badge and no word, a
 * large up and down arrow around the d-pad's muted centre dot — the pair the
 * Selected Control key icons light for walking the controls. Arrows take the
 * label colour, as the dial side markers do.
 */
export function renderSelectControlStrip({ colors, bindingMissing }: BlackBoxDrawingArgs): string {
  const c = colors.label;
  const content = arrow("up", 100, 29, 46, 22, c) + centreDot(100, 50, 5, c) + arrow("down", 100, 71, 46, 22, c);

  return screenSvg(STRIP_WIDTH, STRIP_HEIGHT, stripFrame(colors), content, bindingMissing);
}

/**
 * @internal Exported for testing
 *
 * The Adjust Control strip (`adjust-control`, #1585): a large left and right
 * arrow around the muted centre dot — the pair the key icons light for
 * changing the selected control.
 */
export function renderAdjustControlStrip({ colors, bindingMissing }: BlackBoxDrawingArgs): string {
  const c = colors.label;
  const content = arrow("left", 66, 50, 48, 30, c) + centreDot(100, 50, 6, c) + arrow("right", 134, 50, 48, 30, c);

  return screenSvg(STRIP_WIDTH, STRIP_HEIGHT, stripFrame(colors), content, bindingMissing);
}

/**
 * @internal Exported for testing
 *
 * The knob-screen version of {@link renderSelectControlStrip}, larger for the
 * squarer 176×112 segment.
 */
export function renderSelectControlKnob({ colors, bindingMissing }: BlackBoxDrawingArgs): string {
  const c = colors.label;
  const content = arrow("up", 88, 31, 52, 25, c) + centreDot(88, 56, 6, c) + arrow("down", 88, 81, 52, 25, c);

  return screenSvg(KNOB_BOX_WIDTH, KNOB_BOX_HEIGHT, knobFrame(colors), content, bindingMissing);
}

/**
 * @internal Exported for testing
 *
 * The knob-screen version of {@link renderAdjustControlStrip}.
 */
export function renderAdjustControlKnob({ colors, bindingMissing }: BlackBoxDrawingArgs): string {
  const c = colors.label;
  const content = arrow("left", 52, 56, 52, 32, c) + centreDot(88, 56, 6, c) + arrow("right", 124, 56, 52, 32, c);

  return screenSvg(KNOB_BOX_WIDTH, KNOB_BOX_HEIGHT, knobFrame(colors), content, bindingMissing);
}

/**
 * Top edge of the pending bar on the two hold-preview strips (#1120, #1585):
 * low in the panel, under the arrows, at the same height on both so the mark
 * sits still whichever way the switch goes.
 */
const PENDING_BAR_Y = 77;

/** The shared pending bar, centred under a hold-preview strip's arrows, in their colour. */
function stripPendingBar(color: string): string {
  return renderPendingBar({ centerX: STRIP_WIDTH / 2, y: PENDING_BAR_Y, width: STRIP_WIDTH, color });
}

/**
 * @internal Exported for testing
 *
 * The hold preview of a switch TO Select Control (#1120, #1585), shown while
 * the Long Press is held past the threshold on an Adjust dial: the Select
 * Control strip's up and down arrows around the centre dot, a touch smaller
 * and nudged up, above the shared pending bar. A drawing of its own, so the
 * approved {@link renderSelectControlStrip} stays exactly as it is.
 */
export function renderSelectControlPendingStrip({ colors, bindingMissing }: BlackBoxDrawingArgs): string {
  const c = colors.label;
  const content =
    arrow("up", 100, 26, 40, 18, c) +
    centreDot(100, 44.5, 5, c) +
    arrow("down", 100, 63, 40, 18, c) +
    stripPendingBar(c);

  return screenSvg(STRIP_WIDTH, STRIP_HEIGHT, stripFrame(colors), content, bindingMissing);
}

/**
 * @internal Exported for testing
 *
 * The hold preview of a switch TO Adjust Control (#1120, #1585), shown while
 * the Long Press is held past the threshold on a Select dial: the Adjust
 * Control strip's left and right arrows around the centre dot, at their own
 * size and nudged up, above the shared pending bar. A drawing of its own, so
 * the approved {@link renderAdjustControlStrip} stays exactly as it is.
 */
export function renderAdjustControlPendingStrip({ colors, bindingMissing }: BlackBoxDrawingArgs): string {
  const c = colors.label;
  const content =
    arrow("left", 66, 43, 48, 30, c) +
    centreDot(100, 43, 6, c) +
    arrow("right", 134, 43, 48, 30, c) +
    stripPendingBar(c);

  return screenSvg(STRIP_WIDTH, STRIP_HEIGHT, stripFrame(colors), content, bindingMissing);
}

/**
 * The strip and knob drawings for what a turn does (#1585) — exhaustive over
 * {@link ROTATIONS}, so a new rotation cannot silently borrow another's screen.
 */
function drawingsFor(rotation: DialRotation): { strip: BlackBoxDrawing; knob: BlackBoxDrawing } {
  switch (rotation) {
    case "boxes":
      return { strip: renderBlackBoxStrip, knob: renderBlackBoxKnob };
    case "select-control":
      return { strip: renderSelectControlStrip, knob: renderSelectControlKnob };
    case "adjust-control":
      return { strip: renderAdjustControlStrip, knob: renderAdjustControlKnob };
    default: {
      const unhandled: never = rotation;

      throw new Error(`Black Box Selector: no drawing for dial rotation "${String(unhandled)}"`);
    }
  }
}

/**
 * The hold-preview strip for a switch to `target` (#1120, #1585) — exhaustive
 * over the two rotations the switch reaches.
 */
function pendingStripFor(target: SwitchableRotation): BlackBoxDrawing {
  switch (target) {
    case "select-control":
      return renderSelectControlPendingStrip;
    case "adjust-control":
      return renderAdjustControlPendingStrip;
    default: {
      const unhandled: never = target;

      throw new Error(`Black Box Selector: no hold preview for dial rotation "${String(unhandled)}"`);
    }
  }
}

/**
 * Picks Black Box's own drawing for the dial's screen and the rotation, or the
 * hold preview of the switch to `pending` while one is showing — exhaustive
 * over the profile ids, like `renderDialBox`, so a new canvas cannot silently
 * get the strip drawing.
 */
function renderBlackBoxFor(
  canvas: DialCanvasProfile,
  rotation: DialRotation,
  pending: SwitchableRotation | null,
  args: BlackBoxDrawingArgs,
): string {
  const drawings = drawingsFor(rotation);

  switch (canvas.id) {
    case "sd-plus-strip":
      return pending ? pendingStripFor(pending)(args) : drawings.strip(args);
    case "stream-dock-knob":
      // A knob never previews: its press never reports a release, so no hold
      // is armed (NOOP_HOLD_PREVIEW), and showPreview refuses any screen but
      // the strip. `pending` is null here in practice; were it not, the knob
      // would still show its own rotation, never a promise it cannot keep.
      return drawings.knob(args);
    default: {
      // A new DialCanvasId must get its own drawing here: this line stops compiling until it does.
      const unhandled: never = canvas.id;

      throw new Error(`Black Box Selector: no drawing for dial canvas "${String(unhandled)}"`);
    }
  }
}

interface BlackBoxDialContext {
  /**
   * The dial's settings, authoritative between settings deliveries (rule 10):
   * assigned by `willAppear` / `didReceiveSettings` and by the Switch Select /
   * Adjust gesture, never refreshed from an input event's payload.
   */
  dial: DialSettings;
  action: IDeckActionContext;
  pressStart: number;
  rotatedWhilePressed: boolean;
  /**
   * The rotation the strip is previewing mid-hold (#1120), or null when no
   * preview is showing. It lives on the context and EVERY render draws it
   * (`refreshAll`'s #612 re-render and a settings delivery included), so a
   * redraw mid-hold keeps the preview rather than wiping it.
   */
  previewRotation: SwitchableRotation | null;
  /** The display-only hold-preview timer for this context (the no-op where extended gestures are compiled out). */
  holdPreview: HoldPreview;
  /**
   * The displayed signature of the last frame whose push STARTED (cleared when
   * that push fails), which is the frame the strip ends on, so a global-settings
   * echo or a preview revert re-renders only when the strip would change.
   */
  lastRenderSig: string | null;
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
    ctx.dial = dial;

    pushDialNameIcon(action, { line1: "BLACK", line2: "BOX", backgroundColor: "#2a2a2a" }, this.host.logger);

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  willDisappear(actionId: string): void {
    // The context is gone, so a revert frame pushed at it would be wasted:
    // tear the preview down without one.
    this.contextsState.get(actionId)?.holdPreview.dispose();
    this.forgetContext(actionId);
  }

  async didReceiveSettings(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);
    ctx.dial = dial;

    // A hold in progress keeps going, and its release reads these settings, so
    // a showing preview is re-resolved from them rather than dropped: an echo
    // of unchanged settings keeps it, a changed Long Press or rotation turns it
    // into what the release will now do, or into none. A timer that has not
    // fired yet reads them when it fires.
    if (ctx.previewRotation !== null) {
      ctx.previewRotation = pendingRotationPreview(dial);
    }

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  async rotate(action: IDeckActionContext, dial: DialSettings, ticks: number, pressed: boolean): Promise<void> {
    const ctx = this.inputContext(action, dial, "rotate");

    if (!ctx) return;

    if (pressed) {
      ctx.rotatedWhilePressed = true;
      // Push+turn pre-empts the long press, so the preview goes at once rather
      // than at the release — beside the flag it mirrors and ahead of the
      // zero-tick return, so the two always agree.
      ctx.holdPreview.rotated();
    }

    if (ticks === 0) return;

    // From the context, not the event (see refreshContext): the rotation may
    // have been switched by a gesture the event's settings do not carry yet.
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
    // The only timer this arms DRAWS and never dispatches: press vs long press
    // is still classified once, at the release (#1120).
    ctx.holdPreview.down();
  }

  async up(actionId: string, rawSettings?: unknown): Promise<void> {
    const ctx = this.contextsState.get(actionId);

    if (!ctx) return;

    const pressStartMs = ctx.pressStart;
    ctx.pressStart = 0;
    // Classified BEFORE the preview comes down, so the teardown knows whether
    // this release switches the rotation. Reads only, and nothing returns
    // before the teardown; `null` is a release with no press to measure (a
    // stray second release).
    const release = pressStartMs === 0 ? null : this.classifyRelease(ctx, pressStartMs);

    // Take the preview off the strip before ANY of the early returns below
    // (the hold preview's trap 4): a release that fires nothing — a stray
    // release, a push+turn, a short press on a `none` slot — must still revert
    // what the hold drew. A release that switches draws the new rotation
    // through the switch itself, with no revert frame first (endHoldPreview).
    this.endHoldPreview(ctx, release?.gesture ?? "none");

    if (!release) return;

    if (release.kind === "push-turn") return;

    if (release.gesture === "none") return;

    this.host.logger.info(release.kind === "long" ? "Black box dial long-pressed" : "Black box dial pressed");
    await this.doGesture(ctx, release.gesture, rawSettings);
  }

  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean, rawSettings?: unknown): Promise<void> {
    if (!__FEATURE_DIAL_EXTENDED_GESTURES__) return;

    // The gesture is read from the context, not the event payload — the same
    // stale-settings model `up()` follows (see refreshContext).
    const ctx = this.inputContext(action, dial, "touchTap");

    if (!ctx) return;

    const gestures = resolveGestures(ctx.dial);
    const gesture = hold ? gestures.longTouch : gestures.tap;

    if (gesture === "none") return;

    this.host.logger.info(hold ? "Black box dial long touch" : "Black box dial tap");
    await this.doGesture(ctx, gesture, rawSettings);
  }

  refreshAll(): void {
    for (const ctx of this.contextsState.values()) {
      // Only the missing-binding warning can change from global settings; skip
      // an echo that leaves the strip unchanged so the dial screen stays under
      // ≤10 pushes/s. Per context: each dial's warning is about the pair its own
      // rotation turns, or mid-hold the previewed one. A re-render draws the
      // preview too, so a hold survives this.
      if (this.displayedSignature(ctx) === ctx.lastRenderSig) continue;

      this.renderFeedback(ctx).catch((err) => {
        this.host.logger.debug(`Dial feedback refresh failed: ${String(err)}`);
      });
    }
  }

  protected override createContext(action: IDeckActionContext, dial: DialSettings): BlackBoxDialContext {
    const ctx: BlackBoxDialContext = {
      dial,
      action,
      pressStart: 0,
      rotatedWhilePressed: false,
      previewRotation: null,
      // Replaced just below: the preview's callbacks close over the context
      // being built. Where extended gestures are compiled out the no-op stays.
      holdPreview: NOOP_HOLD_PREVIEW,
      lastRenderSig: null,
    };
    ctx.holdPreview = __FEATURE_DIAL_EXTENDED_GESTURES__
      ? createHoldPreview({
          // The same value the release classifier reads, so the strip changes
          // at exactly the instant a release starts counting as long.
          thresholdMs: () => getDualPressThresholdMs(),
          onThreshold: () => this.showPreview(ctx),
          onCancel: () => this.hidePreview(ctx),
        })
      : NOOP_HOLD_PREVIEW;

    return ctx;
  }

  /**
   * An EXISTING context keeps its `dial` settings (rule 10): they change only
   * through `willAppear` / `didReceiveSettings`, which assign `ctx.dial`
   * explicitly, and through the Switch Select / Adjust gesture. An input event's
   * payload must not refresh them: the host never echoes the gesture's
   * plugin-side setSettings back, and a host that fills event payloads from a
   * per-context cache could hand back the rotation from before the switch,
   * silently undoing it. So only the action is refreshed.
   */
  protected override refreshContext(ctx: BlackBoxDialContext, action: IDeckActionContext, _dial: DialSettings): void {
    ctx.action = action;
  }

  /**
   * The gestures this context announces, read from the context, not the event
   * (an input event does not refresh this surface's settings), with its unset
   * slots resolved and its no-op ones silent ({@link firingGestures}).
   */
  protected override dialGestures(ctx: BlackBoxDialContext, _dial: DialSettings): DialGestures {
    return firingGestures(ctx.dial);
  }

  /**
   * What a release is, and the gesture it fires: `none` for a push+turn, which
   * fires nothing. It only reads — the clock, the threshold and the context's
   * settings — so `up` can ask it before the hold preview comes down.
   */
  private classifyRelease(
    ctx: BlackBoxDialContext,
    pressStartMs: number,
  ): { kind: DialReleaseKind; gesture: GestureSlot } {
    // Where the extended gestures are compiled out a release is never long: a
    // knob press never reports its release (`classifyDialReleaseForHost`).
    const kind = classifyDialReleaseForHost({
      pressStartMs,
      nowMs: Date.now(),
      rotatedWhilePressed: ctx.rotatedWhilePressed,
      thresholdMs: getDualPressThresholdMs(),
    });

    if (kind === "push-turn") return { kind, gesture: "none" };

    const gestures = resolveGestures(ctx.dial);

    return { kind, gesture: kind === "long" ? gestures.longPress : gestures.press };
  }

  /**
   * Takes the hold preview down at a release (#1120), given the gesture the
   * release fires. A release that switches Select / Adjust draws the new
   * rotation itself, through {@link switchRotation}, so the preview is dropped
   * WITHOUT a revert frame: that frame would put the OLD rotation's strip up
   * between the preview and the new one, a flash of the look the release has
   * just left. `dispose` is the hold preview's teardown for exactly this — a
   * settings change whose own render is the revert. Every other release
   * reverts as it always has.
   */
  private endHoldPreview(ctx: BlackBoxDialContext, gesture: GestureSlot): void {
    if (gesture === "switch-rotation" && gestureFires(ctx.dial, gesture)) {
      ctx.holdPreview.dispose();
      ctx.previewRotation = null;

      return;
    }

    ctx.holdPreview.up();
  }

  /**
   * Runs one press or touch gesture: a single tap of the binding it names (the
   * box chosen by `dial.pressBox`, Toggle Black Box Size, or a selected-control
   * press), never a #818 prime sequence — or the Select / Adjust switch, which
   * sends nothing to the sim. Exhaustive over {@link GESTURE_ACTIONS}.
   */
  private async doGesture(ctx: BlackBoxDialContext, gesture: GestureSlot, rawSettings?: unknown): Promise<void> {
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
        this.host.logger.info("Black box dial sent a selected-control press");
        this.host.logger.debug(`Selected-control press: ${gesture}`);
        // Mirrors the keypad Selected Control mode's press: one tap on the open box (#1585).
        await this.host.tapBinding(GESTURE_CONTROL_KEYS[gesture]);

        return;
      case "switch-rotation":
        await this.switchRotation(ctx, rawSettings);

        return;
      default: {
        // A new gesture must be dispatched here: this line stops compiling until it is.
        const unhandled: never = gesture;

        throw new Error(`Black Box Selector: no dial gesture "${String(unhandled)}"`);
      }
    }
  }

  /**
   * Switch Select / Adjust (#1585): flips this dial between Select Control and
   * Adjust Control, redraws it and persists the choice, so it survives a
   * restart and the Property Inspector's Mode shows it. Nothing on a dial that
   * cycles boxes.
   */
  private async switchRotation(ctx: BlackBoxDialContext, rawSettings: unknown): Promise<void> {
    const next = SWITCHED_ROTATION[ctx.dial.rotation];

    if (!next) {
      this.host.logger.debug(`Switch Select / Adjust ignored: the dial turns ${ctx.dial.rotation}`);

      return;
    }

    this.host.logger.info("Black box dial switched rotation");
    this.host.logger.debug(`Switch Select / Adjust: ${ctx.dial.rotation} → ${next}`);

    // The host never echoes a plugin-side setSettings back as
    // didReceiveSettings, so ctx.dial is what the next turn taps and the next
    // gesture flips from — and it flips BEFORE anything is awaited, so a second
    // press landing while the write is in flight flips back rather than
    // repeating this one (rule 10).
    ctx.dial = { ...ctx.dial, rotation: next };

    // A long press still held (a Tap or Long Touch switched mid-hold) releases
    // into these settings, so a showing preview is re-resolved from them, as
    // didReceiveSettings does: it now promises the switch back. A release that
    // commits a switch drops its preview before it gets here (endHoldPreview).
    if (ctx.previewRotation !== null) {
      ctx.previewRotation = pendingRotationPreview(ctx.dial);
    }

    // The dial shows the new rotation at once; the write follows. Each reads
    // ctx.dial when it runs, so two quick switches end on the last one's look.
    // A display call that fails must not cost the write: the context already
    // turns the new rotation, so skipping it would leave the stored settings
    // and the Property Inspector on the old one until the next switch. Each is
    // caught on its own, so a failed hint still lets the strip redraw.
    try {
      await this.applyTriggerDescription(ctx);
    } catch (err) {
      this.host.logger.debug(`Dial trigger description failed after a rotation switch: ${String(err)}`);
    }

    try {
      await this.renderFeedback(ctx);
    } catch (err) {
      this.host.logger.debug(`Dial render failed after a rotation switch: ${String(err)}`);
    }

    await persistDialPatch(ctx.action, rawSettings, { rotation: next }, this.host.logger, "rotation switch");
  }

  /**
   * The hold-preview threshold callback (#1120): previews the switch a long
   * release would make. Returns whether a preview frame was pushed: none when
   * the Long Press is not a switch that does something on this dial
   * ({@link pendingRotationPreview}), and none on any screen but the Stream
   * Deck+ strip. Fires nothing — the release still decides.
   */
  private showPreview(ctx: BlackBoxDialContext): boolean {
    if (ctx.action.dialCanvas()?.id !== "sd-plus-strip") return false;

    const target = pendingRotationPreview(ctx.dial);

    if (!target) return false;

    ctx.previewRotation = target;
    this.host.logger.debug(`Black box dial hold preview: ${target}`);
    // Runs from a timer callback, with no caller left to catch a rejection.
    this.renderFeedback(ctx).catch((err) => {
      this.host.logger.debug(`Dial hold preview render failed: ${String(err)}`);
    });

    return true;
  }

  /**
   * The hold-preview cancel callback (#1120): back to the dial's own rotation.
   * Pushes nothing when the strip already shows it, as after a settings
   * delivery mid-hold that dropped the preview.
   */
  private hidePreview(ctx: BlackBoxDialContext): void {
    ctx.previewRotation = null;

    if (this.displayedSignature(ctx) === ctx.lastRenderSig) return;

    this.renderFeedback(ctx).catch((err) => {
      this.host.logger.debug(`Dial hold preview revert failed: ${String(err)}`);
    });
  }

  /**
   * The rotation the strip shows: the previewed one mid-hold, the dial's own
   * otherwise. Its pair is what the #612 warning is about, so the preview
   * frame warns exactly as the strip will once the release commits.
   */
  private displayedRotation(ctx: BlackBoxDialContext): DialRotation {
    return ctx.previewRotation ?? ctx.dial.rotation;
  }

  /** The strip warns when either binding the displayed rotation turns is unset (#612, #1585). */
  private computeBindingMissing(ctx: BlackBoxDialContext): boolean {
    const keys = ROTATION_KEYS[this.displayedRotation(ctx)];

    return this.host.isBindingMissing([keys.clockwise, keys.counterClockwise]);
  }

  /**
   * What the strip shows, as one string: the rotation, the pending preview and
   * the #612 warning. The preview is part of the DISPLAYED state (the hold
   * preview's trap 3): without it, a global-settings echo mid-hold or after
   * the revert would compare equal and leave a stale frame up.
   */
  private displayedSignature(ctx: BlackBoxDialContext): string {
    return [ctx.dial.rotation, ctx.previewRotation ?? "", this.computeBindingMissing(ctx) ? "warn" : ""].join("|");
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

    // Taken with the frame, before the push is awaited, so it names what this
    // frame draws even if the state moves on meanwhile.
    const signature = this.displayedSignature(ctx);
    const args = {
      colors: resolveDialBoxColors(ctx.dial.colors, ACCENT),
      bindingMissing: this.computeBindingMissing(ctx),
    };
    // EVERY render carries the pending preview, so a redraw mid-hold keeps it.
    const svg = renderBlackBoxFor(canvas, ctx.dial.rotation, ctx.previewRotation, args);

    // Recorded as the push STARTS: the strip ends on the last frame started,
    // so a skip decided while this push is in flight must compare against it.
    // Set after the await, a cancel landing mid-push would compare against the
    // frame before the preview, skip its revert, and leave the preview up.
    ctx.lastRenderSig = signature;

    try {
      await ctx.action.setDialCanvas(svgToDataUri(svg));
    } catch (err) {
      // The frame never reached the strip: forget it, unless a later frame has
      // started since, so the next refresh draws it rather than skipping.
      if (ctx.lastRenderSig === signature) ctx.lastRenderSig = null;

      throw err;
    }
  }
}
