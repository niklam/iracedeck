/**
 * Replay Markers settings (#1162, the dial half #1230). One schema for both
 * surfaces: the keypad reads `mode` and `secondsBack`, the dial reads the
 * `dial` root object, so the two cannot collide (the Fuel Service rule). Kept
 * apart from the action so the dial surface can import it without importing
 * the action that owns the surface.
 */
import { CommonSettings } from "@iracedeck/deck-core";
import z from "zod";

import { dialAppearanceFields } from "../../shared/dial-box.js";

export const REPLAY_MARKERS_MODES = ["add", "delete", "next", "previous"] as const;

export type ReplayMarkersMode = (typeof REPLAY_MARKERS_MODES)[number];

/** What a dial gesture slot can run (#1230): Add Marker, Delete Marker or None. */
export const DIAL_GESTURE_ACTIONS = ["add", "delete", "none"] as const;

export type ReplayMarkersDialGesture = (typeof DIAL_GESTURE_ACTIONS)[number];

/** @internal Exported for testing */
export const SECONDS_BACK_DEFAULT = 5;
/** @internal Exported for testing */
export const SECONDS_BACK_MAX = 60;

/**
 * A number typed into the PI arrives as a string. Anything out of range is
 * brought into range, and anything unreadable reads as the default — a bad
 * value here must never fail the whole schema and reset the key's mode.
 */
function clampSecondsBack(value: number): number {
  if (!Number.isFinite(value)) return SECONDS_BACK_DEFAULT;

  return Math.min(SECONDS_BACK_MAX, Math.max(0, Math.round(value)));
}

/**
 * A cleared field arrives as "" (or whitespace, or null), which `z.coerce`
 * would read as 0 — silently marking the press moment itself. Blank reads as
 * unset, so the default applies.
 */
function blankToUndefined(value: unknown): unknown {
  if (value === null) return undefined;

  if (typeof value === "string" && value.trim() === "") return undefined;

  return value;
}

/**
 * Seconds back, 0–60, default 5: the one fragment both the keypad's
 * `secondsBack` and the dial's `dial.secondsBack` parse through, so the two
 * fields cannot drift in how they read a blank or an out-of-range value.
 */
const secondsBackField = z
  .preprocess(blankToUndefined, z.coerce.number().default(SECONDS_BACK_DEFAULT))
  .transform(clampSecondsBack)
  .catch(SECONDS_BACK_DEFAULT);

/** A gesture slot that reads anything unknown (a newer build's value) as its default. */
function dialGestureField(fallback: ReplayMarkersDialGesture) {
  return z.enum(DIAL_GESTURE_ACTIONS).default(fallback).catch(fallback);
}

/**
 * @internal Exported for testing
 *
 * The dial's settings, under the `dial` root key. Every field defaults and
 * `.catch`es to its default, so a keypad instance (no `dial` at all) and a
 * fresh dial both parse to a full object and one bad field never resets the
 * others. Press adds (the one action a driver wants from the car); Long press
 * deletes (bounded by its 10 s window, and assignable to Press for a knob that
 * has no long press); the touch slots default to None (rule 5).
 */
export const ReplayMarkersDialSettings = z
  .object({
    secondsBack: secondsBackField,
    pressAction: dialGestureField("add"),
    longPressAction: dialGestureField("delete"),
    tapAction: dialGestureField("none"),
    longTouchAction: dialGestureField("none"),
    ...dialAppearanceFields,
  })
  // prefault (not default): a missing `dial` parses {} THROUGH the schema so
  // the per-field defaults apply — same shape as a partially-persisted object.
  .prefault({});

/** @internal Exported for testing */
export type ReplayMarkersDialSettings = z.infer<typeof ReplayMarkersDialSettings>;

/** @internal Exported for testing */
export const ReplayMarkersSettings = CommonSettings.extend({
  mode: z.enum(REPLAY_MARKERS_MODES).default("add"),
  secondsBack: secondsBackField,
  // A non-object `dial` (a newer build's shape) degrades to the dial defaults
  // rather than failing the whole parse and resetting the keypad's mode.
  dial: ReplayMarkersDialSettings.catch(() => ReplayMarkersDialSettings.parse({})),
});

/** @internal Exported for testing */
export type ReplayMarkersSettings = z.infer<typeof ReplayMarkersSettings>;

/** Parses raw settings, falling back to full defaults when the whole parse fails. */
export function parseReplayMarkersSettings(raw: unknown): ReplayMarkersSettings {
  const parsed = ReplayMarkersSettings.safeParse(raw);

  return parsed.success ? parsed.data : ReplayMarkersSettings.parse({});
}
