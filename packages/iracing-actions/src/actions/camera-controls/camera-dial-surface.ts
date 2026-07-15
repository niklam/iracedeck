/**
 * The dial (encoder) surface of Camera Controls (issue #803, reworked).
 *
 * On a Stream Deck+ dial, rotation cycles the camera or the focused car — the
 * dial's `mode` selects the target and the turn direction replaces the keypad
 * cycle modes' explicit next/previous setting (clockwise = next,
 * counter-clockwise = previous). The touch strip is a camera CAROUSEL: the
 * current camera group's icon (or the focused car's number) sits large in the
 * centre, flanked by smaller dimmed previous / next slots showing exactly what
 * one detent either way would switch to.
 *
 * Two families of mode:
 *   - Cycle modes (camera / sub-camera / driving) rotate via the keypad's own
 *     `executeCycle` SDK dispatch (reuse, don't duplicate).
 *   - Car modes (car-number / race-position) compute the neighbouring car from
 *     an explicit ordering — car number ascending, or the canonical live race
 *     order (`getLiveRacePositions`, per `.claude/rules/race-positions.md`,
 *     official `CarIdxPosition` only as the documented fallback) — and focus it
 *     directly via the keypad's Switch-by-Number dispatch. race-position also
 *     resolves to a car NUMBER (never a bare position) before dispatching: the
 *     carousel preview and the SDK's own `switchPos` resolve positions from
 *     different orders (canonical vs. official), and those orders deliberately
 *     diverge in tow/finish/freeze cases — so resolving the car number from the
 *     same canonical-first order the preview uses keeps the camera landing on
 *     the previewed car (issue #803 rework review).
 *
 * Everything the dial does is an iRacing SDK camera command, so — unlike the
 * Setup dials — the surface taps no key bindings and never shows a
 * missing-binding warning; out of a session each mode falls back to a plain
 * identity label.
 */
import {
  classifyDialRelease,
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  escapeXml,
  getDualPressThresholdMs,
  type IDeckActionContext,
  svgToDataUri,
} from "@iracedeck/deck-core";
import {
  getAllCarNumbers,
  getCameraGroupsFromSessionInfo,
  getCarNumberFromSessionInfo,
  getCarNumberRawFromSessionInfo,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { z } from "zod";

import {
  dialAppearanceFields,
  type DialBoxColors,
  renderDialBox,
  resolveDialBoxColors,
} from "../../shared/dial-box.js";
import { renderDialNameIcon } from "../../shared/dial-name-icon.js";
import { computeCameraCarousel } from "./camera-groups.js";

/**
 * Minimum gap (ms) between change-driven feedback pushes. Cycling a car or a
 * camera moves `CamCarIdx` / `CamGroupNumber`, and the strip re-renders the
 * moment the readout changes — but no more than once per this window so a burst
 * of telemetry can't exceed the documented ≤10 `setFeedback`/sec/dial cap
 * (mirrors the Setup Brakes dial).
 */
const CHANGE_RENDER_MIN_INTERVAL_MS = 100;

/** The cycle target the dial rotates through. */
export const DIAL_MODES = ["camera", "sub-camera", "car-number", "race-position", "driving"] as const;
export type DialMode = (typeof DIAL_MODES)[number];

/**
 * The keypad `target` value each CYCLE dial mode maps to. Car modes are absent
 * — they focus a computed target directly rather than cycling.
 */
export type DialCycleTarget = "cycle-camera" | "cycle-sub-camera" | "cycle-driving";
type CycleDialMode = "camera" | "sub-camera" | "driving";

const CYCLE_MODE_TO_TARGET: Record<CycleDialMode, DialCycleTarget> = {
  camera: "cycle-camera",
  "sub-camera": "cycle-sub-camera",
  driving: "cycle-driving",
};

function isCycleMode(mode: DialMode): mode is CycleDialMode {
  return mode === "camera" || mode === "sub-camera" || mode === "driving";
}

/** Rotation direction; clockwise (`ticks > 0`) advances, counter-clockwise goes back. */
export type Direction = "next" | "previous";

/**
 * The actions a dial-button / touch gesture (Push, Long Press, Tap Display,
 * Long Touch) can run, plus the "none" sentinel. Every real gesture reuses the
 * keypad's own iRacing API dispatch: `focus-my-car` centres on the player's car
 * (keypad Focus Your Car); `change-camera` switches to the next camera angle
 * (keypad Cycle Camera); `focus-on-leader` / `focus-on-incident` /
 * `focus-on-most-exciting` are the keypad's parameterless focus one-shots.
 */
export const GESTURE_ACTIONS = [
  "none",
  "focus-my-car",
  "change-camera",
  "focus-on-leader",
  "focus-on-incident",
  "focus-on-most-exciting",
] as const;
export type GestureSlot = (typeof GESTURE_ACTIONS)[number];

/** Fallback identity label drawn when no live focus is available (out of session). */
const MODE_IDENTITY: Record<DialMode, string> = {
  camera: "CAMERA",
  "sub-camera": "SUB CAM",
  "car-number": "CAR #",
  "race-position": "POSITION",
  driving: "DRIVING",
};

/**
 * Per-mode accent for the dash box's border / label / value (the DEFAULT color,
 * each independently overridable per dial, issue #811) so multiple camera dials
 * stay distinguishable at a glance.
 */
const MODE_COLOR: Record<DialMode, string> = {
  camera: "#3498db",
  "sub-camera": "#9b59b6",
  "car-number": "#2ecc71",
  "race-position": "#e74c3c",
  driving: "#e67e22",
};

/** Friendly mode name for the encoder trigger description ("Cycle …"). */
const MODE_LABEL: Record<DialMode, string> = {
  camera: "Cameras",
  "sub-camera": "Sub-Cameras",
  "car-number": "Cars by Number",
  "race-position": "Cars by Position",
  driving: "Driving Cameras",
};

/**
 * Dial-surface settings, stored under the `dial` root key. All fields default,
 * so a keypad-only instance (or a fresh dial) parses `{}` to a full object.
 */
export const DialSettings = z
  .object({
    // Which target rotation drives. Default "car-number" — the marquee
    // broadcast/spectate flip-through-the-field use case (issue #803). The
    // preprocess maps the pre-rework enum value "car" onto "car-number" so a
    // persisted legacy dial keeps working (its gestures / colors untouched).
    mode: z.preprocess((v) => (v === "car" ? "car-number" : v), z.enum(DIAL_MODES).default("car-number")),
    // Push (short press) — fires on dialUp. Default None (blind-safe rule).
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
  // prefault (not default): a missing `dial` parses {} THROUGH the schema so
  // the per-field defaults apply — same shape as a partially-persisted object.
  .prefault({});

export type DialSettings = z.infer<typeof DialSettings>;

/** The live camera-focus readout resolved from telemetry + the session YAML. */
export interface FocusReadout {
  /** Active camera group name (from `CamGroupNumber` + `CameraInfo`), or null. */
  groupName: string | null;
  /** Focused car's display number (from `CamCarIdx` + the driver list), or null. */
  carNumber: string | null;
}

/**
 * @internal Exported for testing
 *
 * Resolves the focused car number and camera group name from the live camera
 * telemetry (`CamCarIdx` / `CamGroupNumber`) against the session driver list
 * and camera-group list. Every field independently degrades to `null` when its
 * source is unavailable (out of session, missing driver, unknown group).
 */
export function computeFocusReadout(telemetry: TelemetryData | null, sessionInfo: unknown): FocusReadout {
  if (!telemetry) return { groupName: null, carNumber: null };

  const groups = getCameraGroupsFromSessionInfo(sessionInfo);
  const camGroup = telemetry.CamGroupNumber;
  const groupName =
    typeof camGroup === "number" ? (groups.find((g) => g.groupNum === camGroup)?.groupName ?? null) : null;

  const camCarIdx = telemetry.CamCarIdx;
  const carNumber =
    typeof camCarIdx === "number" && camCarIdx >= 0 ? getCarNumberFromSessionInfo(sessionInfo, camCarIdx) : null;

  return { groupName, carNumber };
}

/**
 * @internal Exported for testing
 *
 * The dash-box label + value for the current focus, used by the sub-camera and
 * driving modes (whose strip stays the plain group-name / #car readout). With a
 * live focus the label is the camera group name and the value is the
 * `#`-prefixed car number; with no live data the label falls back to the mode
 * identity and the value is empty (the identity-only, label-only box).
 */
export function formatReadout(
  mode: DialMode,
  telemetry: TelemetryData | null,
  sessionInfo: unknown,
): { label: string; value: string } {
  const { groupName, carNumber } = computeFocusReadout(telemetry, sessionInfo);

  return {
    label: groupName ? groupName.toUpperCase() : MODE_IDENTITY[mode],
    value: carNumber ? `#${carNumber}` : "",
  };
}

/**
 * @internal Exported for testing
 *
 * Wrap a 1-based race position by `dir` within a field of `max` cars.
 */
export function wrapPosition(current: number, dir: 1 | -1, max: number): number {
  return ((current - 1 + dir + max) % max) + 1;
}

/**
 * @internal Exported for testing
 *
 * Compute the neighbouring car by ascending car number. The list is the
 * session's cars already sorted by car number (`getAllCarNumbers`); the focused
 * car (`camCarIdx`) is located in it and its `dir` neighbour returned (wrapping
 * at the ends). When the focused car is not in the list (e.g. the pace car),
 * rotation starts from the first (next) or last (previous) car.
 */
export function computeCarNumberTarget(
  camCarIdx: number | undefined,
  cars: Array<{ carIdx: number; carNumber: string; carNumberRaw: number }>,
  direction: Direction,
): { carNumberRaw: number; carNumber: string } | null {
  if (cars.length === 0) return null;

  const dir = direction === "next" ? 1 : -1;
  const idx = camCarIdx === undefined ? -1 : cars.findIndex((c) => c.carIdx === camCarIdx);
  const nextIdx = idx === -1 ? (dir === 1 ? 0 : cars.length - 1) : (idx + dir + cars.length) % cars.length;
  const target = cars[nextIdx];

  return { carNumberRaw: target.carNumberRaw, carNumber: target.carNumber };
}

/**
 * @internal Exported for testing
 *
 * Compute the target race position for a rotation. `order` is a per-car,
 * 1-based rank array indexed by `carIdx` (the canonical live order, or the
 * `CarIdxPosition` fallback the caller supplies) — `0` = not classified. Returns
 * the focused car's current position, the wrapped target one detent away, and
 * the field size, or `null` when the focused car has no position.
 */
export function computeRacePositionTarget(
  camCarIdx: number | undefined,
  order: number[] | null,
  direction: Direction,
): { currentPosition: number; targetPosition: number; maxPosition: number } | null {
  if (!order || camCarIdx === undefined || camCarIdx < 0) return null;

  const currentPosition = order[camCarIdx];

  if (typeof currentPosition !== "number" || currentPosition <= 0) return null;

  const maxPosition = order.reduce((m, p) => (typeof p === "number" && p > m ? p : m), 0);

  if (maxPosition <= 0) return null;

  const dir = direction === "next" ? 1 : -1;

  return { currentPosition, targetPosition: wrapPosition(currentPosition, dir, maxPosition), maxPosition };
}

/** Human-readable label for a gesture slot (for the trigger description). */
function gestureLabel(action: GestureSlot): string | undefined {
  switch (action) {
    case "focus-my-car":
      return "Focus My Car";
    case "change-camera":
      return "Change Camera";
    case "focus-on-leader":
      return "Focus on Leader";
    case "focus-on-incident":
      return "Focus on Incident";
    case "focus-on-most-exciting":
      return "Focus on Most Exciting";
    case "none":
      return undefined;
  }
}

/**
 * @internal Exported for testing
 *
 * Computes the encoder trigger descriptions from the current dial settings.
 * `rotate` names the cycled target; `push` carries the press action with the
 * long-press as a "(hold: …)" hint; `touch` / `longTouch` carry the touch-strip
 * gestures.
 */
export function buildTriggerDescription(dial: DialSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = {
    rotate: `Cycle ${MODE_LABEL[dial.mode]}`,
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

// --- Carousel rendering ------------------------------------------------------

/** A colour-resolved camera-group icon glyph for the carousel. */
export interface CarouselGlyph {
  /** Source viewBox width of the group icon. */
  width: number;
  /** Source viewBox height. */
  height: number;
  /** The colour-resolved inner artwork (no `<svg>` wrapper). */
  artwork: string;
}

/** One camera carousel slot: a group name plus its glyph (null when unmapped). */
export interface CarouselSlot {
  name: string;
  glyph: CarouselGlyph | null;
}

/** The three car-carousel readouts plus an optional race position badge. */
export interface CarCarouselView {
  /** Focused car's display number (no `#`), or null out of a session. */
  center: string | null;
  prev: string | null;
  next: string | null;
  /** Race position of the focused car (race-position mode only). */
  position: number | null;
}

function svgWrap(w: number, h: number, inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${inner}</svg>`;
}

/**
 * The rounded dash-box panel: the background fills the panel INSIDE the border
 * frame (outer margin stays device-black) and the border strokes it — matching
 * the shared `renderDialBox` geometry so the carousel strips look identical to
 * the label/value strips.
 */
function dialPanel(w: number, h: number, colors: DialBoxColors): string {
  const minSide = Math.min(w, h);
  const radius = Math.round(minSide * 0.16);
  const inset = Math.max(5, Math.round(minSide * 0.045));
  const strokeWidth = Math.max(5, Math.round(minSide * 0.05));
  const innerRx = Math.max(0, radius - inset);

  return `<rect x="${inset}" y="${inset}" width="${w - 2 * inset}" height="${h - 2 * inset}" rx="${innerRx}" fill="${colors.background}" stroke="${colors.border}" stroke-width="${strokeWidth}"/>`;
}

/** A centred identity label (out-of-session fallback). */
function identityBox(w: number, h: number, label: string, colors: DialBoxColors): string {
  const text = `<text x="${w / 2}" y="${Math.round(h * 0.5) + 8}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="24" font-weight="bold">${escapeXml(label)}</text>`;

  return svgWrap(w, h, dialPanel(w, h, colors) + text);
}

/** Places a glyph centred at (cx, cy), scaled so its longer side fits `size`. */
function placeGlyph(glyph: CarouselGlyph, cx: number, cy: number, size: number, opacity: number): string {
  const scale = size / Math.max(glyph.width, glyph.height);
  const x = cx - (glyph.width * scale) / 2;
  const y = cy - (glyph.height * scale) / 2;
  const op = opacity < 1 ? ` opacity="${opacity}"` : "";

  return `<g transform="translate(${x.toFixed(2)}, ${y.toFixed(2)}) scale(${scale.toFixed(4)})"${op}>${glyph.artwork}</g>`;
}

/**
 * @internal Exported for testing
 *
 * Renders the camera-carousel strip: the current group's icon large in the
 * centre with its name beneath, flanked by the smaller dimmed previous / next
 * groups. Falls back to a centred identity label out of a session (no current
 * group).
 */
export function renderCameraCarousel(args: {
  width: number;
  height: number;
  colors: DialBoxColors;
  identityLabel: string;
  current: CarouselSlot | null;
  prev: CarouselSlot | null;
  next: CarouselSlot | null;
}): string {
  const { width: w, height: h, colors } = args;

  if (!args.current) return identityBox(w, h, args.identityLabel, colors);

  const parts: string[] = [dialPanel(w, h, colors)];

  // Side slots (dimmed), drawn behind the centre.
  for (const [slot, cx] of [
    [args.prev, w * 0.18],
    [args.next, w * 0.82],
  ] as const) {
    if (!slot) continue;

    if (slot.glyph) parts.push(placeGlyph(slot.glyph, cx, h * 0.42, 28, 0.4));
    else
      parts.push(
        `<text x="${cx}" y="${Math.round(h * 0.54)}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="11" font-weight="bold" opacity="0.4">${escapeXml(slot.name.toUpperCase())}</text>`,
      );
  }

  // Centre glyph (if mapped) with the group name beneath it.
  if (args.current.glyph) parts.push(placeGlyph(args.current.glyph, w / 2, h * 0.4, 48, 1));

  parts.push(
    `<text x="${w / 2}" y="${Math.round(h * 0.87)}" text-anchor="middle" fill="${colors.value}" font-family="Arial, sans-serif" font-size="15" font-weight="bold">${escapeXml(args.current.name.toUpperCase())}</text>`,
  );

  return svgWrap(w, h, parts.join(""));
}

/**
 * @internal Exported for testing
 *
 * Renders the car-carousel strip: the focused car's number large in the centre
 * (with a `P<pos>` badge above it in race-position mode), flanked by the smaller
 * dimmed previous / next car numbers. Falls back to a centred identity label out
 * of a session (no focused car number).
 */
export function renderCarCarousel(args: {
  width: number;
  height: number;
  colors: DialBoxColors;
  identityLabel: string;
  center: string | null;
  prev: string | null;
  next: string | null;
  position: number | null;
}): string {
  const { width: w, height: h, colors } = args;

  if (!args.center) return identityBox(w, h, args.identityLabel, colors);

  const parts: string[] = [dialPanel(w, h, colors)];

  for (const [num, cx] of [
    [args.prev, w * 0.16],
    [args.next, w * 0.84],
  ] as const) {
    if (!num) continue;

    parts.push(
      `<text x="${cx}" y="${Math.round(h * 0.58)}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="18" font-weight="bold" opacity="0.45">#${escapeXml(num)}</text>`,
    );
  }

  if (args.position !== null) {
    parts.push(
      `<text x="${w / 2}" y="${Math.round(h * 0.27)}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="16" font-weight="bold">P${args.position}</text>`,
    );
  }

  const centerY = args.position !== null ? Math.round(h * 0.74) : Math.round(h * 0.66);

  parts.push(
    `<text x="${w / 2}" y="${centerY}" text-anchor="middle" fill="${colors.value}" font-family="Arial, sans-serif" font-size="40" font-weight="bold">#${escapeXml(args.center)}</text>`,
  );

  return svgWrap(w, h, parts.join(""));
}

// --- Runtime state -----------------------------------------------------------

/** Per-context runtime state. */
interface CameraDialContext {
  dial: DialSettings;
  action: IDeckActionContext;
  /** Timestamp (ms) the current dial-button press started (dialDown). */
  pressStart: number;
  /**
   * Whether the dial was rotated while the button was held during the current
   * press. Set in rotate (pressed === true), read once at dialUp so a
   * push+turn cycles without also firing the press gesture on release.
   */
  rotatedWhilePressed: boolean;
  /** Signature of the DISPLAYED readout at the last change-driven render. */
  lastRenderSig: string | null;
  /** Timestamp (ms) of the last change-driven feedback push (throttle gate). */
  lastChangeRenderAt: number;
}

/**
 * The delegates the surface needs from its owning action. Camera cycling and
 * focus stay on the action (the SDK camera commands), so the dial reuses the
 * SAME dispatch as the keypad rather than duplicating it. Deliberately NO
 * `setActiveBinding` / `tapBinding`: the surface issues no key bindings, and
 * readiness state is one value per action-class instance that a dial context
 * would bleed onto the keypad buttons (see global-settings.md).
 */
export interface CameraDialHost {
  readonly logger: ILogger;
  getTelemetry(): TelemetryData | null;
  getSessionInfo(): unknown;
  /**
   * The canonical live race order (carIdx → 1-based rank), per
   * `.claude/rules/race-positions.md`. `null` when there is no live order (a
   * non-race session, or before it is available) — the surface then falls back
   * to the official `CarIdxPosition` telemetry.
   */
  getRacePositions(): number[] | null;
  /** Enabled camera-group names (the global `cameraGroupSubset`). */
  getEnabledCameraGroups(): string[];
  /** Colour-resolved carousel glyph for a group name, or null when unmapped. */
  getGroupGlyph(groupName: string): CarouselGlyph | null;
  /** Cycle the given target one step (the keypad's own `executeCycle`). */
  cycle(target: DialCycleTarget, direction: Direction): void;
  /**
   * Focus a car by its raw car number (the keypad Switch by Car Number
   * dispatch). Also the race-position mode's execution path: it resolves its
   * target to a car number (via the same canonical-first order the preview
   * uses) rather than dispatching a bare position, so the camera can't land on
   * a different car than the one previewed — see the file header.
   */
  focusCarNumber(carNumberRaw: number): void;
  /** Center the camera on the player's car (the keypad Focus Your Car mode). */
  focusMyCar(): void;
  /** Switch to the next camera angle (the keypad Cycle Camera dispatch). */
  changeCamera(): void;
  /** Focus the race leader (the keypad Focus on Leader mode). */
  focusOnLeader(): void;
  /** Focus the latest incident (the keypad Focus on Incident mode). */
  focusOnIncident(): void;
  /** Focus the director's most-exciting car (the keypad Focus on Most Exciting mode). */
  focusOnMostExciting(): void;
}

/**
 * Owns all per-dial-context state, dispatches rotations and gestures, and
 * renders the touch-strip carousel. The owning action routes every dial
 * lifecycle/input event here and forwards telemetry ticks per subscribed
 * context.
 */
export class CameraDialSurface {
  private readonly contextsState = new Map<string, CameraDialContext>();

  constructor(private readonly host: CameraDialHost) {}

  async willAppear(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    // The deck-app image for the dial: just the action name. Without this the
    // app falls back to keypad iconography for the dial slot.
    action
      .setImage(renderDialNameIcon({ line1: "CAMERA", line2: "CONTROLS", backgroundColor: "#2a3a4a" }))
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
    // Bust the memo so the next render reflects the new mode even if it happens
    // to format to the same readout string as the previous one.
    ctx.lastRenderSig = null;

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  rotate(action: IDeckActionContext, dial: DialSettings, ticks: number, pressed: boolean): void {
    const ctx = this.ensureContext(action, dial);

    if (ticks === 0) return;

    // A pressed rotation still cycles; the guard makes the dialUp classifier
    // skip the press gesture so holding-and-turning never also fires it. The
    // readout settles a beat later from telemetry.
    if (pressed) {
      ctx.rotatedWhilePressed = true;
    }

    // One step per rotate event (direction from the tick sign). The camera
    // commands compute the next car/group/position from the CURRENT telemetry,
    // which only advances after a sim tick — so re-issuing them N times in one
    // event would re-target the same neighbour, not step N. One detent = one
    // step; a continued spin arrives as further rotate events.
    const direction: Direction = ticks > 0 ? "next" : "previous";
    this.dispatchRotation(dial.mode, direction);
    this.host.logger.info("Camera dial rotated");
    this.host.logger.debug(`${dial.mode} ${direction}`);
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

    const gesture = kind === "long" ? ctx.dial.longPressAction : ctx.dial.pressAction;

    if (gesture === "none") return;

    this.host.logger.info(kind === "long" ? "Camera dial long-pressed" : "Camera dial pressed");
    this.doGesture(gesture);
  }

  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    // hold === true → Long Touch slot; hold === false → Tap Display slot.
    const gesture = hold ? dial.longTouchAction : dial.tapAction;

    if (gesture === "none") return;

    this.ensureContext(action, dial);
    this.host.logger.info(hold ? "Camera dial long touch" : "Camera dial tap");
    this.doGesture(gesture);
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
    // fire another push inside the same 100 ms window, defeating the ≤10
    // setFeedback/sec/dial throttle.
    ctx.lastRenderSig = sig;
    ctx.lastChangeRenderAt = Date.now();
    this.renderFeedback(ctx).catch((err) => {
      this.host.logger.debug(`Dial feedback render failed: ${String(err)}`);
    });
  }

  /**
   * Re-renders every dial context (readout memo busted). Called by the owning
   * action on global-settings changes so a dash-box appearance edit (issue #811)
   * or a camera-subset change redraws the strip even while iRacing is offline
   * (no telemetry ticks arrive).
   */
  refreshAll(): void {
    for (const ctx of this.contextsState.values()) {
      ctx.lastRenderSig = null;
      this.renderFeedback(ctx).catch((err) => {
        this.host.logger.debug(`Dial feedback refresh failed: ${String(err)}`);
      });
    }
  }

  private ensureContext(action: IDeckActionContext, dial: DialSettings): CameraDialContext {
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

  /** Routes a rotation to the cycle dispatch or the car-focus dispatch by mode. */
  private dispatchRotation(mode: DialMode, direction: Direction): void {
    if (isCycleMode(mode)) {
      this.host.cycle(CYCLE_MODE_TO_TARGET[mode], direction);

      return;
    }

    const telemetry = this.host.getTelemetry();
    const camCarIdx = telemetry?.CamCarIdx;

    if (mode === "car-number") {
      const cars = getAllCarNumbers(this.host.getSessionInfo(), true, true);
      const target = computeCarNumberTarget(camCarIdx, cars, direction);

      if (target) this.host.focusCarNumber(target.carNumberRaw);

      return;
    }

    // race-position: canonical live order, official CarIdxPosition as fallback.
    // Resolve the target car NUMBER from that SAME order (never dispatch a bare
    // position) — the carousel preview does the same lookup via
    // carNumberAtPosition, so preview and execution can't land on different
    // cars even where canonical and official position orders diverge.
    const order = this.resolveOrder(telemetry);
    const target = computeRacePositionTarget(camCarIdx, order, direction);

    if (!target || !order) return;

    const carNumberRaw = carNumberRawAtPosition(order, this.host.getSessionInfo(), target.targetPosition);

    if (carNumberRaw !== null) this.host.focusCarNumber(carNumberRaw);
  }

  /** The live order, canonical first, official `CarIdxPosition` as fallback. */
  private resolveOrder(telemetry: TelemetryData | null): number[] | null {
    return this.host.getRacePositions() ?? telemetry?.CarIdxPosition ?? null;
  }

  /** Runs a configured press / touch gesture through the keypad's own dispatch. */
  private doGesture(gesture: GestureSlot): void {
    switch (gesture) {
      case "focus-my-car":
        this.host.logger.info("Camera dial focus my car");
        this.host.focusMyCar();

        return;
      case "change-camera":
        this.host.logger.info("Camera dial change camera");
        this.host.changeCamera();

        return;
      case "focus-on-leader":
        this.host.logger.info("Camera dial focus on leader");
        this.host.focusOnLeader();

        return;
      case "focus-on-incident":
        this.host.logger.info("Camera dial focus on incident");
        this.host.focusOnIncident();

        return;
      case "focus-on-most-exciting":
        this.host.logger.info("Camera dial focus on most exciting");
        this.host.focusOnMostExciting();

        return;
      case "none":
        return;
    }
  }

  /** Builds the camera carousel view from the current group + enabled subset. */
  private cameraCarouselSlots(telemetry: TelemetryData | null): {
    current: CarouselSlot | null;
    prev: CarouselSlot | null;
    next: CarouselSlot | null;
  } {
    const enabled = this.host.getEnabledCameraGroups();
    const sessionGroups = getCameraGroupsFromSessionInfo(this.host.getSessionInfo());
    const camGroup = typeof telemetry?.CamGroupNumber === "number" ? telemetry.CamGroupNumber : null;
    const carousel = computeCameraCarousel(camGroup, enabled, sessionGroups);

    const slotFor = (group: (typeof carousel)["current"]): CarouselSlot | null =>
      group ? { name: group.groupName, glyph: this.host.getGroupGlyph(group.groupName) } : null;

    return { current: slotFor(carousel.current), prev: slotFor(carousel.prev), next: slotFor(carousel.next) };
  }

  /** Builds the car carousel view for the car-number / race-position modes. */
  private carCarouselView(mode: "car-number" | "race-position", telemetry: TelemetryData | null): CarCarouselView {
    const sessionInfo = this.host.getSessionInfo();
    const camCarIdx = telemetry?.CamCarIdx;
    const center =
      typeof camCarIdx === "number" && camCarIdx >= 0 ? getCarNumberFromSessionInfo(sessionInfo, camCarIdx) : null;

    if (mode === "car-number") {
      const cars = getAllCarNumbers(sessionInfo, true, true);

      return {
        center,
        prev: computeCarNumberTarget(camCarIdx, cars, "previous")?.carNumber ?? null,
        next: computeCarNumberTarget(camCarIdx, cars, "next")?.carNumber ?? null,
        position: null,
      };
    }

    const order = this.resolveOrder(telemetry);
    const target = computeRacePositionTarget(camCarIdx, order, "next");

    if (!target || !order) return { center, prev: null, next: null, position: null };

    const prevPos = wrapPosition(target.currentPosition, -1, target.maxPosition);

    return {
      center,
      prev: carNumberAtPosition(order, sessionInfo, prevPos),
      next: carNumberAtPosition(order, sessionInfo, target.targetPosition),
      position: target.currentPosition,
    };
  }

  /** A compact signature of the displayed readout; a feedback push is due when it changes. */
  private displayedSignature(ctx: CameraDialContext): string {
    const dial = ctx.dial;
    const telemetry = this.host.getTelemetry();

    if (dial.mode === "camera") {
      const { current, prev, next } = this.cameraCarouselSlots(telemetry);

      return ["camera", prev?.name ?? "", current?.name ?? "", next?.name ?? ""].join("|");
    }

    if (dial.mode === "car-number" || dial.mode === "race-position") {
      const v = this.carCarouselView(dial.mode, telemetry);

      return [dial.mode, v.center ?? "", v.prev ?? "", v.next ?? "", v.position ?? ""].join("|");
    }

    const { label, value } = formatReadout(dial.mode, telemetry, this.host.getSessionInfo());

    return [dial.mode, label, value].join("|");
  }

  /** Pushes the encoder trigger descriptions for a dial (Elgato only). */
  private async applyTriggerDescription(ctx: CameraDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.dial));
  }

  /** Builds the touch-strip SVG for the current mode. */
  private renderStrip(dial: DialSettings): string {
    const colors = resolveDialBoxColors(dial.colors, MODE_COLOR[dial.mode]);
    const telemetry = this.host.getTelemetry();

    if (dial.mode === "camera") {
      const slots = this.cameraCarouselSlots(telemetry);

      return renderCameraCarousel({ width: 200, height: 100, colors, identityLabel: MODE_IDENTITY.camera, ...slots });
    }

    if (dial.mode === "car-number" || dial.mode === "race-position") {
      const view = this.carCarouselView(dial.mode, telemetry);

      return renderCarCarousel({ width: 200, height: 100, colors, identityLabel: MODE_IDENTITY[dial.mode], ...view });
    }

    // sub-camera / driving keep the plain group-name / #car readout.
    const { label, value } = formatReadout(dial.mode, telemetry, this.host.getSessionInfo());

    return renderDialBox({ width: 200, height: 100, abbr: label, value, colors });
  }

  /** Pushes the touch-strip feedback (the full-cell carousel/readout) when this is a dial. */
  private async renderFeedback(ctx: CameraDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (!ctx.action.isDial()) return;

    const feedback: DeckFeedbackPayload = { box: svgToDataUri(this.renderStrip(ctx.dial)) };
    await ctx.action.setFeedback(feedback);

    // Reset the change-detector baseline so this pushed feedback doesn't
    // immediately re-fire the render-on-change path on the next telemetry tick.
    ctx.lastRenderSig = this.displayedSignature(ctx);
    ctx.lastChangeRenderAt = Date.now();
  }
}

/** The carIdx running at a given race position (the inverse of `order`), or null when unclassified. */
function carIdxAtPosition(order: number[], position: number): number | null {
  const carIdx = order.findIndex((p) => p === position);

  return carIdx < 0 ? null : carIdx;
}

/** The display car number at a given race position (via the inverse of `order`). */
function carNumberAtPosition(order: number[], sessionInfo: unknown, position: number): string | null {
  const carIdx = carIdxAtPosition(order, position);

  return carIdx === null ? null : getCarNumberFromSessionInfo(sessionInfo, carIdx);
}

/**
 * The raw car number (the camera-API identity, not the display string) running
 * at a given race position. Used by the race-position rotation dispatch — see
 * the file header — so execution focuses the SAME car the carousel preview
 * shows via `carNumberAtPosition`, rather than a bare position that iRacing's
 * own `switchPos` would resolve against a potentially different (official)
 * order.
 */
function carNumberRawAtPosition(order: number[], sessionInfo: unknown, position: number): number | null {
  const carIdx = carIdxAtPosition(order, position);

  return carIdx === null ? null : getCarNumberRawFromSessionInfo(sessionInfo, carIdx);
}
