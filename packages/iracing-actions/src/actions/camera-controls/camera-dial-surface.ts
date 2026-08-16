/**
 * The dial (encoder) surface of Camera Controls (issue #803, reworked).
 *
 * On a Stream Deck+ dial, rotation cycles the camera or the focused car — the
 * dial's `mode` selects the target and the turn direction replaces the keypad
 * cycle modes' explicit next/previous setting. Clockwise = next for every mode
 * EXCEPT race-position, whose default is flipped (issue #884): clockwise
 * selects the car AHEAD (decreasing position number), because "next position"
 * would otherwise mean losing places. In track-order (issue #886) "next" IS
 * the car ahead on the road (the direction of travel), so clockwise lands on
 * the car ahead there too without a flip. The `reverseRotation` setting
 * inverts the active mode's default mapping (see `clockwiseDirection`). The
 * touch strip's small top line is always the MODE name (CAMERA / SUB-CAMERA /
 * CAR # / POSITION / TRACK ORDER / DRIVING CAM); the main content identifies
 * the thing that mode acts on, flanked by dimmed side previews that follow the
 * EFFECTIVE mapping — the left slot is always the counter-clockwise detent's
 * target and the right slot the clockwise one, so preview == execution holds
 * under both the race-position default flip and the reverse option:
 *   - camera → the current camera group's icon + name, flanked by the dimmed
 *     enabled-subset neighbours one detent either way,
 *   - sub-camera → the current camera's NAME within the focused group, flanked
 *     by the dimmed adjacent cameras from the group's `Cameras[]` list. This
 *     one is a GUIDE, not a promise: since #852 the detent taps iRacing's own
 *     Next / Previous Sub Camera binding, so the sim owns the stepping order,
 *   - car-number → the focused car's number large in the centre, flanked by the
 *     neighbouring car numbers,
 *   - race-position → the focused car's race POSITION large in the centre
 *     (`P<pos>`, the primary readout — issue #803 rework) with its car number
 *     smaller beneath it, flanked by the dimmed POSITION previews one detent
 *     either way (no car numbers at side size),
 *   - track-order → the focused car's number large in the centre, flanked by
 *     the numbers of the competitors physically ahead of / behind it on the
 *     road, each captioned AHEAD / BEHIND beneath so the strip reads correctly
 *     under either rotation mapping (issue #886),
 *   - driving → the current camera group's icon + name ONLY. The driving cycle
 *     hands `group ± 1` to iRacing, which resolves and wraps it internally, so
 *     there is no coherent neighbour to preview — better none than a lying one.
 *
 * Two families of mode:
 *   - Cycle modes (camera / sub-camera / driving) rotate via the keypad's own
 *     `executeCycle` dispatch (reuse, don't duplicate) — an SDK camera command
 *     for camera / driving, and iRacing's own sub-camera key binding for
 *     sub-camera (issue #852: the switch broadcasts' `camera` argument never
 *     selects a sub-camera, so only the sim's binding can step one).
 *   - Car modes (car-number / race-position / track-order) compute the
 *     neighbouring car from an explicit ordering — car number ascending, the
 *     canonical live race order (`getLiveRacePositions`, per
 *     `.claude/rules/race-positions.md`, official `CarIdxPosition` only as the
 *     documented fallback), or the PHYSICAL track order (the shared
 *     `findNearestCarOnTrack` primitive via `computeTrackOrderTarget`, issue
 *     #886 — a distinct concept from the race order, so the canonical-order
 *     rule doesn't apply, but the computation stays that one shared helper) —
 *     and focus it directly via the keypad's Switch by Car Number dispatch (`camera.switchNum`).
 *     race-position also resolves to a car NUMBER (never a bare position)
 *     before dispatching: the SDK's own `switchPos` resolves positions from a
 *     potentially different (official) order than the canonical one the
 *     carousel previews, so execution resolves the car number from the SAME
 *     canonical-first order and target position the preview's side badges
 *     show (issue #803 rework review) — preview and execution can't land on
 *     different cars. When the
 *     focused car has no classified position (the pace / safety car, or a car
 *     missing from the order), a detent still acts by re-entering the running
 *     order at its end — next → the leader, previous → last place — rather
 *     than stalling (#803). All car modes walk past cars that are no longer
 *     in the sim world (issue #885): post-race, finished/towed cars keep their
 *     frozen rank (and their session-info entry) but iRacing silently ignores
 *     a camera switch to them, so a detent targeting one would dead-loop —
 *     the walk continues along the ordering to the next present car, and the
 *     side previews show that same skipped-to target. All three car modes
 *     judge presence with the one shared `carInWorld` predicate — a valid lap
 *     distance and a surface other than `NotInWorld`, deliberately WITHOUT a
 *     `CarIdxLapCompleted` condition, since that field is still -1 for every
 *     car on the pace lap (the #307 fix; a lap-count term here killed cycling
 *     for the whole formation lap, #968). track-order reads the
 *     LIVE car placement, so during an in-session replay it follows the live
 *     field rather than the replay cursor (the #492 finding — the reason
 *     Replay Control's Next/Prev Car defer to iRacing's keystroke).
 *
 * Every mode but sub-camera is an iRacing SDK camera command, so only the
 * sub-camera strip can carry the #612 missing-binding warning (its detent taps
 * the sim's own Next / Previous Sub Camera bindings since #852; the owning
 * action answers `isBindingMissing` for it). Out of a session each mode falls
 * back to a plain identity label.
 */
import {
  applyBindingWarning,
  classifyDialRelease,
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  escapeXml,
  getDualPressThresholdMs,
  type IDeckActionContext,
  svgToDataUri,
} from "@iracedeck/deck-core";
import {
  carInWorld,
  getAllCarNumbers,
  getCameraGroupsFromSessionInfo,
  getCamerasInGroup,
  getCarNumberFromSessionInfo,
  getCarNumberRawFromSessionInfo,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { z } from "zod";

import {
  computeCarNumberTarget,
  computeTrackOrderTarget,
  type TrackOrderDirection,
  type TrackOrderTarget,
} from "../../shared/car-cycling.js";
import { dialAppearanceFields, type DialBoxColors, resolveDialBoxColors } from "../../shared/dial-box.js";
import { renderDialNameIcon } from "../../shared/dial-name-icon.js";
import { computeCameraCarousel, computeSubCameraCarousel } from "./camera-groups.js";
import { SUB_CAMERA_BINDING_KEY_LIST } from "./sub-camera-bindings.js";

/**
 * Minimum gap (ms) between change-driven feedback pushes. Cycling a car or a
 * camera moves `CamCarIdx` / `CamGroupNumber`, and the strip re-renders the
 * moment the readout changes — but no more than once per this window so a burst
 * of telemetry can't exceed the documented ≤10 `setFeedback`/sec/dial cap
 * (mirrors the Setup Brakes dial).
 */
const CHANGE_RENDER_MIN_INTERVAL_MS = 100;

/** The cycle target the dial rotates through. */
export const DIAL_MODES = ["camera", "sub-camera", "car-number", "race-position", "track-order", "driving"] as const;
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

/**
 * A rotation's dispatch direction in the cycled ordering (camera list, car
 * numbers ascending, race positions ascending, or — track-order — the road,
 * where `next` is the car ahead; see `trackOrderDirection`). Which PHYSICAL
 * turn maps to which direction is decided by `clockwiseDirection` (issue #884).
 */
export type Direction = "next" | "previous";

function oppositeDirection(direction: Direction): Direction {
  return direction === "next" ? "previous" : "next";
}

/**
 * The physical-track reading of a `Direction` for the track-order mode (issue
 * #886): `next` is the car AHEAD on the road (the direction of travel),
 * `previous` the car BEHIND. The one place that mapping lives — the dispatch
 * and the carousel preview both route through it, so preview == execution.
 */
function trackOrderDirection(direction: Direction): TrackOrderDirection {
  return direction === "next" ? "ahead" : "behind";
}

/**
 * @internal Exported for testing
 *
 * The `Direction` a clockwise detent dispatches for a mode. Race-position's
 * default is flipped (issue #884): clockwise selects the car AHEAD — its
 * "next" means the position NUMBER increases, i.e. falling back through the
 * field, which nobody reads as forward. Every other mode keeps clockwise =
 * next — including track-order, whose "next" already IS the car ahead on the
 * road (`trackOrderDirection`, issue #886), so both car-neighbour modes land
 * on the car ahead clockwise. `reverseRotation` inverts the active mode's
 * default mapping (for race-position, that restores the pre-#884 clockwise →
 * P# increases feel).
 */
export function clockwiseDirection(mode: DialMode, reverseRotation: boolean): Direction {
  const defaultClockwise: Direction = mode === "race-position" ? "previous" : "next";

  return reverseRotation ? oppositeDirection(defaultClockwise) : defaultClockwise;
}

/**
 * Assigns a cycle ordering's `previous`/`next` targets to the strip's side
 * slots under the effective mapping: the left slot is always the
 * counter-clockwise detent's target and the right slot the clockwise one
 * (#884). The one place the side rule lives — every carousel view builder
 * routes through it.
 */
function orientSides<T>(clockwise: Direction, prev: T, next: T): { left: T; right: T } {
  return clockwise === "next" ? { left: prev, right: next } : { left: next, right: prev };
}

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
  "track-order": "TRACK ORDER",
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
  "track-order": "#1abc9c",
  driving: "#e67e22",
};

/** Friendly mode name for the encoder trigger description ("Cycle …"). */
const MODE_LABEL: Record<DialMode, string> = {
  camera: "Cameras",
  "sub-camera": "Sub-Cameras",
  "car-number": "Cars by Number",
  "race-position": "Cars by Position",
  "track-order": "Cars by Track Order",
  driving: "Driving Cameras",
};

/**
 * The strip's small top-line title — the ACTION/mode name, on every mode (issue
 * #803 strip redesign). Short forms kept consistent with the strip typography;
 * NO mode ever shows a camera or car name as the title.
 */
const MODE_TITLE: Record<DialMode, string> = {
  camera: "CAMERA",
  "sub-camera": "SUB-CAMERA",
  "car-number": "CAR #",
  "race-position": "POSITION",
  "track-order": "TRACK ORDER",
  driving: "DRIVING CAM",
};

/**
 * The track-order strip's side captions (issue #886): a bare pair of numbers
 * either side of the focused car says nothing about WHICH way is which, so
 * each side is captioned with the road relation its detent lands on. Assigned
 * to the strip sides through the same `orientSides` rule as the numbers, so
 * the captions follow the effective rotation mapping too.
 */
const TRACK_ORDER_CAPTIONS: Record<TrackOrderDirection, string> = { ahead: "AHEAD", behind: "BEHIND" };

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
    // Inverts the active mode's rotation mapping (issue #884). Deliberately NO
    // migration: an unchecked box means the NEW race-position default
    // (clockwise = the car ahead); checking it restores the pre-#884 feel
    // there, and flips clockwise to "previous" in every other mode. The
    // union+transform is the sdpi checkbox convention — z.coerce.boolean()
    // would turn the persisted string "false" into true.
    reverseRotation: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(false),
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
 * Compute the target race position for a rotation. `order` is a per-car,
 * 1-based rank array indexed by `carIdx` (the canonical live order, or the
 * `CarIdxPosition` fallback the caller supplies) — `0` = not classified.
 *
 * When the focused car IS classified, returns its current position, the wrapped
 * target one detent away, and the field size. When the focused car is NOT
 * classified (the pace / safety car, or a car missing from the order) but the
 * field is non-empty, a detent still acts by re-entering the running order at
 * its natural end — `next` → the leader (P1), `previous` → last place (issue
 * #803, so the pace car in focus doesn't stall cycling). Which physical turn
 * dispatches which direction is decided by `clockwiseDirection` (#884): under
 * the race-position default, a clockwise detent dispatches `previous`, so it
 * re-enters at last place and walks up the field. `currentPosition` is then
 * `null` (no position badge). Returns `null` when there is no usable order at
 * all (no order, or an empty field), or when no present car exists anywhere
 * along the walk.
 *
 * `isPresent` filters to cars that currently exist in the sim world (issue
 * #885): the canonical order deliberately freezes towed / finished /
 * left-world cars at their last-known rank, but iRacing silently ignores a
 * camera switch to an absent car — `CamCarIdx` never moves, so every
 * following detent would recompute the same dead target. The walk (both the
 * classified step and the recovery re-entry) continues along the order,
 * wrapping, until a position whose car is present is found; the focused car's
 * own position is never re-targeted.
 */
export function computeRacePositionTarget(
  camCarIdx: number | undefined,
  order: number[] | null,
  direction: Direction,
  isPresent: (carIdx: number) => boolean = () => true,
): { currentPosition: number | null; targetPosition: number; maxPosition: number } | null {
  if (!order || camCarIdx === undefined || camCarIdx < 0) return null;

  const maxPosition = order.reduce((m, p) => (typeof p === "number" && p > m ? p : m), 0);

  if (maxPosition <= 0) return null;

  const dir = direction === "next" ? 1 : -1;
  const currentPosition = order[camCarIdx];
  const classified = typeof currentPosition === "number" && currentPosition > 0;

  // Anchor the walk one step from the focused car's own position — or, for an
  // unclassified focused car (pace / safety car, or a car not in the order),
  // re-enter the order at its natural end so a detent isn't a no-op: next →
  // P1, previous → last place. No currentPosition → the carousel omits the
  // position badge.
  let candidate = classified ? wrapPosition(currentPosition, dir, maxPosition) : dir === 1 ? 1 : maxPosition;

  for (let step = 0; step < maxPosition; step++) {
    if (classified && candidate === currentPosition) break; // full circle — no other present car

    const carIdx = carIdxAtPosition(order, candidate);

    if (carIdx !== null && isPresent(carIdx)) {
      return { currentPosition: classified ? currentPosition : null, targetPosition: candidate, maxPosition };
    }

    candidate = wrapPosition(candidate, dir, maxPosition);
  }

  return null;
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

/**
 * The car-number carousel readouts: the focused car's number plus the nearest
 * PRESENT car either way along the ascending order (adjacent unless cars in
 * between left the world, #885), already assigned to their STRIP SIDES —
 * left = the counter-clockwise detent's target, right = the clockwise one
 * (#884).
 */
export interface CarCarouselView {
  /** Focused car's display number (no `#`), or null out of a session. */
  center: string | null;
  left: string | null;
  right: string | null;
  /**
   * Optional small captions drawn beneath the side numbers (track-order's
   * AHEAD / BEHIND, #886) — each on the side its number is on; a side with no
   * number draws no caption either. Omitted when both sides show the SAME
   * car (the primitive's no-track-position re-entry, or a two-car field),
   * where one car can't honestly be captioned both ahead and behind.
   */
  sideCaptions?: { left: string; right: string };
}

/**
 * The race-position carousel readouts: the focused car's POSITION (the
 * primary centre readout) and its car number (the secondary label beneath
 * it), plus the dimmed side previews — themselves POSITIONS, not car
 * numbers, since a side badge only needs to say "one detent away is P<n>"
 * (issue #803 rework). Sides follow the EFFECTIVE rotation mapping (#884):
 * left = the counter-clockwise detent's target, right = the clockwise one.
 */
export interface RacePositionCarouselView {
  /** Focused car's race position, or null when unclassified (pace/safety car). */
  centerPosition: number | null;
  /** Focused car's display number (no `#`), or null out of a session. */
  centerCarNumber: string | null;
  /** Recovery-aware target position one counter-clockwise detent away (see `computeRacePositionTarget`). */
  leftPosition: number | null;
  /** Recovery-aware target position one clockwise detent away. */
  rightPosition: number | null;
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

/** The strip's small top-line title — the mode name, drawn on every live strip (issue #803). */
function titleLine(w: number, h: number, title: string, colors: DialBoxColors): string {
  return `<text x="${w / 2}" y="${Math.round(h * 0.2)}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="13" font-weight="bold" opacity="0.85">${escapeXml(title)}</text>`;
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
 * Renders the camera-carousel strip: the mode-name title on top, the current
 * group's icon in the centre with its name beneath, flanked by the smaller
 * dimmed neighbour groups — `left` is the counter-clockwise detent's target,
 * `right` the clockwise one (#884). Driving mode passes both as `null` for
 * a current-only render (no coherent neighbour to preview). Falls back to a
 * centred identity label out of a session (no current group).
 */
export function renderCameraCarousel(args: {
  width: number;
  height: number;
  colors: DialBoxColors;
  title: string;
  identityLabel: string;
  current: CarouselSlot | null;
  left: CarouselSlot | null;
  right: CarouselSlot | null;
}): string {
  const { width: w, height: h, colors } = args;

  if (!args.current) return identityBox(w, h, args.identityLabel, colors);

  const parts: string[] = [dialPanel(w, h, colors), titleLine(w, h, args.title, colors)];

  // Side slots (dimmed), drawn behind the centre.
  for (const [slot, cx] of [
    [args.left, w * 0.18],
    [args.right, w * 0.82],
  ] as const) {
    if (!slot) continue;

    if (slot.glyph) parts.push(placeGlyph(slot.glyph, cx, h * 0.5, 26, 0.4));
    else
      parts.push(
        `<text x="${cx}" y="${Math.round(h * 0.56)}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="11" font-weight="bold" opacity="0.4">${escapeXml(slot.name.toUpperCase())}</text>`,
      );
  }

  // Centre glyph (if mapped) with the group name beneath it.
  if (args.current.glyph) parts.push(placeGlyph(args.current.glyph, w / 2, h * 0.5, 42, 1));

  parts.push(
    `<text x="${w / 2}" y="${Math.round(h * 0.9)}" text-anchor="middle" fill="${colors.value}" font-family="Arial, sans-serif" font-size="14" font-weight="bold">${escapeXml(args.current.name.toUpperCase())}</text>`,
  );

  return svgWrap(w, h, parts.join(""));
}

/**
 * @internal Exported for testing
 *
 * Renders the sub-camera carousel: the mode-name title on top, the current
 * camera's NAME within the focused group large in the centre, flanked by the
 * smaller dimmed adjacent camera names from the group's `Cameras[]` list —
 * `left` is the counter-clockwise detent's target, `right` the clockwise one
 * (#884). Since #852 the detent taps iRacing's own sub-camera binding, so the
 * sim owns the stepping order and the sides are a guide to the group's camera
 * list rather than a guaranteed landing spot. Falls back to a centred identity
 * label out of a session (no current camera), or to the #612 missing-binding
 * warning when `bindingMissing` is set.
 */
export function renderSubCameraCarousel(args: {
  width: number;
  height: number;
  colors: DialBoxColors;
  title: string;
  identityLabel: string;
  current: string | null;
  left: string | null;
  right: string | null;
  /** #612 overlay: the Sub-Camera bindings (#852) are unset, so a detent would do nothing. */
  bindingMissing?: boolean;
}): string {
  const { width: w, height: h, colors } = args;

  if (args.bindingMissing) {
    // Pass the strip canvas: the glyph is authored for the 144×144 key canvas
    // and only recentres/rescales onto the 200×100 strip when it is given
    // (#775) — without it the triangle lands off-centre and clipped.
    return svgWrap(
      w,
      h,
      applyBindingWarning(dialPanel(w, h, colors) + titleLine(w, h, args.title, colors), { width: w, height: h }),
    );
  }

  if (!args.current) return identityBox(w, h, args.identityLabel, colors);

  const parts: string[] = [dialPanel(w, h, colors), titleLine(w, h, args.title, colors)];

  for (const [name, cx] of [
    [args.left, w * 0.15],
    [args.right, w * 0.85],
  ] as const) {
    if (!name) continue;

    parts.push(
      `<text x="${cx}" y="${Math.round(h * 0.52)}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="11" font-weight="bold" opacity="0.4">${escapeXml(name.toUpperCase())}</text>`,
    );
  }

  parts.push(
    `<text x="${w / 2}" y="${Math.round(h * 0.68)}" text-anchor="middle" fill="${colors.value}" font-family="Arial, sans-serif" font-size="20" font-weight="bold">${escapeXml(args.current.toUpperCase())}</text>`,
  );

  return svgWrap(w, h, parts.join(""));
}

/**
 * @internal Exported for testing
 *
 * Renders the car-number carousel strip (shared by the car-number and
 * track-order modes): the mode-name title on top, the focused car's number
 * large in the centre, flanked by the smaller dimmed numbers of the cars one
 * detent away (the nearest PRESENT cars, #885) — `left` is the
 * counter-clockwise detent's target, `right` the clockwise one (#884). With
 * `sideCaptions`, each side number gets a small caption beneath it (the
 * track-order AHEAD / BEHIND, #886) — only where that side has a number.
 * Falls back to a centred identity label out of a session (no focused car
 * number).
 */
export function renderCarCarousel(
  args: {
    width: number;
    height: number;
    colors: DialBoxColors;
    title: string;
    identityLabel: string;
  } & CarCarouselView,
): string {
  const { width: w, height: h, colors } = args;

  if (!args.center) return identityBox(w, h, args.identityLabel, colors);

  const parts: string[] = [dialPanel(w, h, colors), titleLine(w, h, args.title, colors)];

  for (const [num, caption, cx] of [
    [args.left, args.sideCaptions?.left, w * 0.16],
    [args.right, args.sideCaptions?.right, w * 0.84],
  ] as const) {
    if (!num) continue;

    parts.push(
      `<text x="${cx}" y="${Math.round(h * 0.62)}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="18" font-weight="bold" opacity="0.45">#${escapeXml(num)}</text>`,
    );

    if (caption) {
      parts.push(
        `<text x="${cx}" y="${Math.round(h * 0.8)}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="9" font-weight="bold" opacity="0.45">${escapeXml(caption)}</text>`,
      );
    }
  }

  parts.push(
    `<text x="${w / 2}" y="${Math.round(h * 0.72)}" text-anchor="middle" fill="${colors.value}" font-family="Arial, sans-serif" font-size="40" font-weight="bold">#${escapeXml(args.center)}</text>`,
  );

  return svgWrap(w, h, parts.join(""));
}

/**
 * @internal Exported for testing
 *
 * Renders the race-position carousel strip: the mode-name title on top, the
 * focused car's race POSITION large in the centre (`P<pos>`, the primary
 * readout — issue #803 rework) with its car number smaller beneath it,
 * flanked by the smaller dimmed POSITION previews (the SAME recovery-aware
 * targets the rotation focuses — see `computeRacePositionTarget`; `left` is
 * the counter-clockwise detent's target, `right` the clockwise one, #884).
 * When the focused car has no classified position (the pace / safety car),
 * the centre falls back to a number-only readout rather than a lying `P`
 * badge; the side previews still show the recovery targets. Falls back to a
 * centred identity label out of a session (no focused car number).
 */
export function renderRacePositionCarousel(args: {
  width: number;
  height: number;
  colors: DialBoxColors;
  title: string;
  identityLabel: string;
  centerPosition: number | null;
  centerCarNumber: string | null;
  leftPosition: number | null;
  rightPosition: number | null;
}): string {
  const { width: w, height: h, colors } = args;

  if (!args.centerCarNumber) return identityBox(w, h, args.identityLabel, colors);

  const parts: string[] = [dialPanel(w, h, colors), titleLine(w, h, args.title, colors)];

  for (const [pos, cx] of [
    [args.leftPosition, w * 0.16],
    [args.rightPosition, w * 0.84],
  ] as const) {
    if (pos === null) continue;

    parts.push(
      `<text x="${cx}" y="${Math.round(h * 0.62)}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="18" font-weight="bold" opacity="0.45">P${pos}</text>`,
    );
  }

  if (args.centerPosition !== null) {
    parts.push(
      `<text x="${w / 2}" y="${Math.round(h * 0.68)}" text-anchor="middle" fill="${colors.value}" font-family="Arial, sans-serif" font-size="40" font-weight="bold">P${args.centerPosition}</text>`,
    );
    parts.push(
      `<text x="${w / 2}" y="${Math.round(h * 0.9)}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="15" font-weight="bold">#${escapeXml(args.centerCarNumber)}</text>`,
    );
  } else {
    parts.push(
      `<text x="${w / 2}" y="${Math.round(h * 0.72)}" text-anchor="middle" fill="${colors.value}" font-family="Arial, sans-serif" font-size="40" font-weight="bold">#${escapeXml(args.centerCarNumber)}</text>`,
    );
  }

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
 * focus stay on the action (the SDK camera commands, plus the sub-camera key
 * binding since #852), so the dial reuses the SAME dispatch as the keypad
 * rather than duplicating it. Deliberately NO `setActiveBinding` / `tapBinding`:
 * the surface never dispatches a binding itself (the action's `cycle` does),
 * and readiness state is one value per action-class instance that a dial
 * context would bleed onto the keypad buttons (see global-settings.md) —
 * `isBindingMissing` is delegated instead, because it is stateless.
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
   * Whether any of the given global binding keys is unconfigured (#612). Only
   * the Sub-Camera mode is binding-driven (issue #852) — every other mode is an
   * SDK command — so this gates that one strip's warning overlay.
   */
  isBindingMissing(keys: string | readonly string[] | null | undefined): boolean;
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

    // One step per rotate event (direction from the tick sign through the
    // mode's effective clockwise mapping, #884). The camera commands compute
    // the next car/group/position from the CURRENT telemetry, which only
    // advances after a sim tick — so re-issuing them N times in one event
    // would re-target the same neighbour, not step N. One detent = one step;
    // a continued spin arrives as further rotate events.
    const clockwise = clockwiseDirection(dial.mode, dial.reverseRotation);
    const direction: Direction = ticks > 0 ? clockwise : oppositeDirection(clockwise);
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
    // Skip cars that left the world (#885): post-race the frozen order (and
    // session info) still lists them, but a switch to an absent car is
    // silently ignored by iRacing and the dial would dead-loop on it.
    const isPresent = carInWorld(telemetry);

    if (mode === "car-number" || mode === "track-order") {
      // Both walk the SAME competitor list the carousel previews — ascending
      // car number, or (#886) the physical road order: the competitor nearest
      // ahead / behind on the lap — so the detent lands on the car the side
      // badge showed. track-order's presence test lives in the primitive
      // (see the file header), hence no `isPresent` there.
      const cars = getAllCarNumbers(this.host.getSessionInfo(), true, true);
      const target =
        mode === "car-number"
          ? computeCarNumberTarget(camCarIdx, cars, direction, isPresent)
          : this.trackOrderTarget(telemetry, cars, direction);

      if (target) this.host.focusCarNumber(target.carNumberRaw);

      return;
    }

    // race-position: canonical live order, official CarIdxPosition as fallback.
    // Resolve the target car NUMBER from that SAME order (never dispatch a bare
    // position) — the carousel preview's side badges show this SAME
    // recovery-aware target POSITION (computeRacePositionTarget), so preview
    // and execution can't land on different cars even where canonical and
    // official position orders diverge.
    const order = this.resolveOrder(telemetry);
    const target = computeRacePositionTarget(camCarIdx, order, direction, isPresent);

    if (!target || !order) return;

    const carNumberRaw = carNumberRawAtPosition(order, this.host.getSessionInfo(), target.targetPosition);

    if (carNumberRaw !== null) this.host.focusCarNumber(carNumberRaw);
  }

  /**
   * The race order, canonical first, official `CarIdxPosition` as fallback.
   *
   * The canonical order is a dense array of 1-based ranks with `0` for every
   * car it omits, so "no order at all" arrives as a NON-NULL array of zeros —
   * `??` alone accepts it and strands the mode at `maxPosition = 0`. An order
   * that ranks NOBODY is therefore "no live order at all" in the sense
   * `race-positions.md` means it, and the official counter takes over (#968).
   *
   * Before the green flag of a race the canonical order is the qualifying grid
   * (issue #974), so this mode cycles the formation exactly as it does the
   * race; the all-zero case is now the rarer one — a non-race session, or a
   * race whose grid can't be resolved — where the official counter is the last
   * resort and is itself all-zero pre-green (iRacing scores positions at
   * start/finish).
   */
  private resolveOrder(telemetry: TelemetryData | null): number[] | null {
    const canonical = this.host.getRacePositions();

    if (canonical?.some((position) => position > 0)) return canonical;

    return telemetry?.CarIdxPosition ?? canonical ?? null;
  }

  /**
   * The competitor a track-order detent in `direction` lands on (issue #886):
   * the focused car's nearest neighbour ahead / behind on the road among
   * `cars` — the SAME competitor set the car-number mode cycles
   * (`getAllCarNumbers(sessionInfo, true, true)`, pace car and spectators
   * excluded; the caller resolves it once per view / detent) — through the
   * shared `computeTrackOrderTarget`. Used by both the rotation dispatch and
   * the carousel preview.
   */
  private trackOrderTarget(
    telemetry: TelemetryData | null,
    cars: ReadonlyArray<{ carIdx: number; carNumber: string; carNumberRaw: number }>,
    direction: Direction,
  ): TrackOrderTarget | null {
    return computeTrackOrderTarget(telemetry, telemetry?.CamCarIdx, cars, trackOrderDirection(direction));
  }

  /**
   * The focused car's display number (no `#`), or null out of a session / when
   * no car is focused (`CamCarIdx` unset or a negative sentinel).
   */
  private focusedCarNumber(sessionInfo: unknown, telemetry: TelemetryData | null): string | null {
    const camCarIdx = telemetry?.CamCarIdx;

    return typeof camCarIdx === "number" && camCarIdx >= 0 ? getCarNumberFromSessionInfo(sessionInfo, camCarIdx) : null;
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

  /**
   * Builds the camera carousel view from the current group + enabled subset,
   * with the neighbours on the sides their detents actually land on (#884):
   * left = counter-clockwise, right = clockwise.
   */
  private cameraCarouselSlots(
    telemetry: TelemetryData | null,
    dial: DialSettings,
  ): {
    current: CarouselSlot | null;
    left: CarouselSlot | null;
    right: CarouselSlot | null;
  } {
    const enabled = this.host.getEnabledCameraGroups();
    const sessionGroups = getCameraGroupsFromSessionInfo(this.host.getSessionInfo());
    const camGroup = typeof telemetry?.CamGroupNumber === "number" ? telemetry.CamGroupNumber : null;
    const carousel = computeCameraCarousel(camGroup, enabled, sessionGroups);

    const slotFor = (group: (typeof carousel)["current"]): CarouselSlot | null =>
      group ? { name: group.groupName, glyph: this.host.getGroupGlyph(group.groupName) } : null;

    const clockwise = clockwiseDirection(dial.mode, dial.reverseRotation);

    return {
      current: slotFor(carousel.current),
      ...orientSides(clockwise, slotFor(carousel.prev), slotFor(carousel.next)),
    };
  }

  /**
   * Builds the car-number carousel view: the focused car plus its
   * ascending-order neighbours, each on the side its detent lands on (#884).
   */
  private carNumberCarouselView(telemetry: TelemetryData | null, dial: DialSettings): CarCarouselView {
    const sessionInfo = this.host.getSessionInfo();
    const camCarIdx = telemetry?.CamCarIdx;
    const center = this.focusedCarNumber(sessionInfo, telemetry);
    const cars = getAllCarNumbers(sessionInfo, true, true);
    const clockwise = clockwiseDirection(dial.mode, dial.reverseRotation);
    // The same world-presence walk the rotation dispatches (#885), so the side
    // previews show the car a detent actually lands on.
    const isPresent = carInWorld(telemetry);

    return {
      center,
      ...orientSides(
        clockwise,
        computeCarNumberTarget(camCarIdx, cars, "previous", isPresent)?.carNumber ?? null,
        computeCarNumberTarget(camCarIdx, cars, "next", isPresent)?.carNumber ?? null,
      ),
    };
  }

  /**
   * Builds the track-order carousel view (issue #886): the focused car plus
   * the competitors physically ahead of / behind it on the road — the SAME
   * per-direction targets the rotation focuses — each on the side its detent
   * lands on (#884), captioned AHEAD / BEHIND on that same side. When both
   * detents resolve to the SAME car (the focused car has no track position, so
   * the primitive re-enters at the car nearest start/finish for both
   * directions — or the field has only one other car), the captions are
   * dropped: one car captioned both AHEAD and BEHIND would contradict itself,
   * while the bare number on both sides still previews exactly what either
   * detent focuses.
   */
  private trackOrderCarouselView(telemetry: TelemetryData | null, dial: DialSettings): CarCarouselView {
    const sessionInfo = this.host.getSessionInfo();
    const center = this.focusedCarNumber(sessionInfo, telemetry);
    const cars = getAllCarNumbers(sessionInfo, true, true);
    const behind = this.trackOrderTarget(telemetry, cars, "previous");
    const ahead = this.trackOrderTarget(telemetry, cars, "next");
    const clockwise = clockwiseDirection(dial.mode, dial.reverseRotation);
    const sameCarBothWays = behind !== null && ahead !== null && behind.carIdx === ahead.carIdx;

    return {
      center,
      ...orientSides(clockwise, behind?.carNumber ?? null, ahead?.carNumber ?? null),
      ...(sameCarBothWays
        ? {}
        : {
            sideCaptions: orientSides(
              clockwise,
              TRACK_ORDER_CAPTIONS[trackOrderDirection("previous")],
              TRACK_ORDER_CAPTIONS[trackOrderDirection("next")],
            ),
          }),
    };
  }

  /**
   * The car-carousel view for the two number-primary car modes: car-number
   * (ascending car number) or track-order (the physical road order, #886).
   */
  private carCarouselView(telemetry: TelemetryData | null, dial: DialSettings): CarCarouselView {
    return dial.mode === "track-order"
      ? this.trackOrderCarouselView(telemetry, dial)
      : this.carNumberCarouselView(telemetry, dial);
  }

  /**
   * Builds the race-position carousel view: the focused car's position (the
   * primary centre readout) and car number (secondary), plus the dimmed side
   * PREVIEWS — the SAME per-direction targets the rotation will focus
   * (including the pace-car recovery), each on the side its detent lands on
   * (#884), so the carousel never previews a position a detent doesn't
   * actually land on.
   */
  private racePositionCarouselView(telemetry: TelemetryData | null, dial: DialSettings): RacePositionCarouselView {
    const sessionInfo = this.host.getSessionInfo();
    const camCarIdx = telemetry?.CamCarIdx;
    const centerCarNumber = this.focusedCarNumber(sessionInfo, telemetry);

    const order = this.resolveOrder(telemetry);
    // The same world-presence walk the rotation dispatches (#885), so the side
    // previews show the position a detent actually lands on.
    const isPresent = carInWorld(telemetry);
    const nextTarget = computeRacePositionTarget(camCarIdx, order, "next", isPresent);
    const prevTarget = computeRacePositionTarget(camCarIdx, order, "previous", isPresent);

    if (!nextTarget || !prevTarget) {
      return { centerPosition: null, centerCarNumber, leftPosition: null, rightPosition: null };
    }

    const clockwise = clockwiseDirection(dial.mode, dial.reverseRotation);
    const sides = orientSides(clockwise, prevTarget.targetPosition, nextTarget.targetPosition);

    return {
      // null for an unclassified focused car → no position badge (falls back
      // to a number-only centre in the renderer).
      centerPosition: nextTarget.currentPosition,
      centerCarNumber,
      leftPosition: sides.left,
      rightPosition: sides.right,
    };
  }

  /**
   * Builds the sub-camera carousel view: the current camera's name within the
   * focused group plus the adjacent camera names from `computeSubCameraCarousel`
   * (over the group's `CameraInfo.Cameras[]`), each on the side its detent
   * would land on (#884). Unlike the other modes this is a PREVIEW, not the
   * execution path: since #852 the detent taps iRacing's own sub-camera
   * binding and the sim decides the next camera, so the sides read as a guide
   * to the group's camera list.
   */
  private subCameraView(
    telemetry: TelemetryData | null,
    dial: DialSettings,
  ): {
    current: string | null;
    left: string | null;
    right: string | null;
  } {
    const camGroup = telemetry?.CamGroupNumber;

    if (typeof camGroup !== "number") return { current: null, left: null, right: null };

    const cameras = getCamerasInGroup(this.host.getSessionInfo(), camGroup);
    const camCameraNum = typeof telemetry?.CamCameraNumber === "number" ? telemetry.CamCameraNumber : null;
    const carousel = computeSubCameraCarousel(camCameraNum, cameras);
    const clockwise = clockwiseDirection(dial.mode, dial.reverseRotation);

    return {
      current: carousel.current?.cameraName ?? null,
      ...orientSides(clockwise, carousel.prev?.cameraName ?? null, carousel.next?.cameraName ?? null),
    };
  }

  /**
   * The current camera group as a carousel slot (icon + name) for the driving
   * mode's current-only strip. Resolved straight from telemetry + the session
   * camera-group list (driving cycles ALL groups, not the enabled subset).
   */
  private drivingCurrentSlot(telemetry: TelemetryData | null): CarouselSlot | null {
    const camGroup = telemetry?.CamGroupNumber;

    if (typeof camGroup !== "number") return null;

    const group = getCameraGroupsFromSessionInfo(this.host.getSessionInfo()).find((g) => g.groupNum === camGroup);

    return group ? { name: group.groupName, glyph: this.host.getGroupGlyph(group.groupName) } : null;
  }

  /** A compact signature of the displayed readout; a feedback push is due when it changes. */
  private displayedSignature(ctx: CameraDialContext): string {
    const dial = ctx.dial;
    const telemetry = this.host.getTelemetry();

    if (dial.mode === "camera") {
      const { current, left, right } = this.cameraCarouselSlots(telemetry, dial);

      return ["camera", left?.name ?? "", current?.name ?? "", right?.name ?? ""].join("|");
    }

    if (dial.mode === "car-number" || dial.mode === "track-order") {
      const v = this.carCarouselView(telemetry, dial);

      // The caption marker covers track-order's same-car-both-ways case, where
      // the captions come and go while the numbers on the sides don't change.
      return [dial.mode, v.center ?? "", v.left ?? "", v.right ?? "", v.sideCaptions ? "captions" : ""].join("|");
    }

    if (dial.mode === "race-position") {
      const v = this.racePositionCarouselView(telemetry, dial);

      return [
        "race-position",
        v.centerCarNumber ?? "",
        v.centerPosition ?? "",
        v.leftPosition ?? "",
        v.rightPosition ?? "",
      ].join("|");
    }

    if (dial.mode === "sub-camera") {
      const v = this.subCameraView(telemetry, dial);

      return ["sub-camera", v.left ?? "", v.current ?? "", v.right ?? ""].join("|");
    }

    // driving: current group only.
    return ["driving", this.drivingCurrentSlot(telemetry)?.name ?? ""].join("|");
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
    const base = { width: 200, height: 100, colors, title: MODE_TITLE[dial.mode] } as const;

    if (dial.mode === "camera") {
      const slots = this.cameraCarouselSlots(telemetry, dial);

      return renderCameraCarousel({ ...base, identityLabel: MODE_IDENTITY.camera, ...slots });
    }

    if (dial.mode === "car-number" || dial.mode === "track-order") {
      const view = this.carCarouselView(telemetry, dial);

      return renderCarCarousel({ ...base, identityLabel: MODE_IDENTITY[dial.mode], ...view });
    }

    if (dial.mode === "race-position") {
      const view = this.racePositionCarouselView(telemetry, dial);

      return renderRacePositionCarousel({ ...base, identityLabel: MODE_IDENTITY["race-position"], ...view });
    }

    if (dial.mode === "sub-camera") {
      const view = this.subCameraView(telemetry, dial);

      return renderSubCameraCarousel({
        ...base,
        identityLabel: MODE_IDENTITY["sub-camera"],
        ...view,
        // Rotation taps BOTH bindings depending on direction, so either one
        // missing makes the dial half-dead — warn on either (#612).
        bindingMissing: this.host.isBindingMissing(SUB_CAMERA_BINDING_KEY_LIST),
      });
    }

    // driving: the current camera group icon + name only. The driving cycle
    // hands `group ± 1` to iRacing, which resolves and wraps it internally — no
    // coherent neighbour to preview — so the sides are null (current-only).
    return renderCameraCarousel({
      ...base,
      identityLabel: MODE_IDENTITY.driving,
      current: this.drivingCurrentSlot(telemetry),
      left: null,
      right: null,
    });
  }

  /** Pushes the touch-strip feedback (the full-cell carousel/readout) when this is a dial. */
  private async renderFeedback(ctx: CameraDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (!ctx.action.isDial()) return;

    // Snapshot the signature of the state being RENDERED before the push:
    // recomputing it after the await would record whatever telemetry arrived
    // while setFeedback was in flight as "rendered", leaving the strip showing
    // stale state A while the baseline says B — suppressing B's render until
    // yet another change.
    const renderedSignature = this.displayedSignature(ctx);
    const feedback: DeckFeedbackPayload = { box: svgToDataUri(this.renderStrip(ctx.dial)) };
    await ctx.action.setFeedback(feedback);

    // Reset the change-detector baseline so this pushed feedback doesn't
    // immediately re-fire the render-on-change path on the next telemetry tick.
    ctx.lastRenderSig = renderedSignature;
    ctx.lastChangeRenderAt = Date.now();
  }
}

/** The carIdx running at a given race position (the inverse of `order`), or null when unclassified. */
function carIdxAtPosition(order: number[], position: number): number | null {
  const carIdx = order.findIndex((p) => p === position);

  return carIdx < 0 ? null : carIdx;
}

/**
 * The raw car number (the camera-API identity, not the display string) running
 * at a given race position. Used by the race-position rotation dispatch — see
 * the file header — so execution focuses the car at the SAME target position
 * the carousel's side preview shows, rather than a bare position that
 * iRacing's own `switchPos` would resolve against a potentially different
 * (official) order.
 */
function carNumberRawAtPosition(order: number[], sessionInfo: unknown, position: number): number | null {
  const carIdx = carIdxAtPosition(order, position);

  return carIdx === null ? null : getCarNumberRawFromSessionInfo(sessionInfo, carIdx);
}
