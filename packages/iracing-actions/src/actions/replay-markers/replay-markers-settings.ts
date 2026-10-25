/**
 * Replay Markers settings (#1162, the dial half #1230). One schema for both
 * surfaces: the keypad reads `mode`, `secondsBack` and `deleteWindow`, the dial reads the
 * `dial` root object, so the two cannot collide (the Fuel Service rule). Kept
 * apart from the action so the dial surface can import it without importing
 * the action that owns the surface.
 */
import { CommonSettings } from "@iracedeck/deck-core";
import { MARKER_DELETE_WINDOW_FRAMES } from "@iracedeck/replay-store";
import z from "zod";

import { dialAppearanceFields } from "../../shared/dial-box.js";

export const REPLAY_MARKERS_MODES = ["add", "delete", "add-delete", "next", "previous"] as const;

export type ReplayMarkersMode = (typeof REPLAY_MARKERS_MODES)[number];

/** What a dial gesture slot can run (#1230): Add Marker, Delete Marker or None. */
export const DIAL_GESTURE_ACTIONS = ["add", "delete", "none"] as const;

export type ReplayMarkersDialGesture = (typeof DIAL_GESTURE_ACTIONS)[number];

/** @internal Exported for testing */
export const SECONDS_BACK_DEFAULT = 5;
/** @internal Exported for testing */
export const SECONDS_BACK_MAX = 60;

/**
 * @internal Exported for testing
 *
 * The Delete Window's default in whole seconds (#1454): the store's 10 s
 * window, so the number lives in one place and an existing key keeps it.
 */
export const DELETE_WINDOW_DEFAULT = MARKER_DELETE_WINDOW_FRAMES / 60;
/** @internal Exported for testing */
export const DELETE_WINDOW_MIN = 1;
/** @internal Exported for testing */
export const DELETE_WINDOW_MAX = 60;

/**
 * A number typed into the PI arrives as a string. Anything out of range is
 * brought into range, and anything unreadable reads as the default — a bad
 * value here must never fail the whole schema and reset the key's mode.
 */
function clampWholeSeconds(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;

  return Math.min(max, Math.max(min, Math.round(value)));
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

/** A whole-seconds field: blank reads as `fallback`, a number is rounded into `min`–`max`, anything else is `fallback`. */
function wholeSecondsField(min: number, max: number, fallback: number) {
  return z
    .preprocess(blankToUndefined, z.coerce.number().default(fallback))
    .transform((value) => clampWholeSeconds(value, min, max, fallback))
    .catch(fallback);
}

/**
 * Seconds back, 0–60, default 5: the one fragment both the keypad's
 * `secondsBack` and the dial's `dial.secondsBack` parse through, so the two
 * fields cannot drift in how they read a blank or an out-of-range value.
 */
const secondsBackField = wholeSecondsField(0, SECONDS_BACK_MAX, SECONDS_BACK_DEFAULT);

/**
 * The Delete Window, 1–60 whole seconds, default 10 (#1454): how far from a
 * marker — its frame, or the frame its Add was pressed at — a Delete reaches.
 * Shared by the keypad's `deleteWindow` and the dial's `dial.deleteWindow`.
 * Not 0: a window of one exact frame is never hit in a playing replay or from
 * the car, so the key would be grey for good.
 */
const deleteWindowField = wholeSecondsField(DELETE_WINDOW_MIN, DELETE_WINDOW_MAX, DELETE_WINDOW_DEFAULT);

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
 * deletes (bounded by its Delete Window, and assignable to Press for a knob that
 * has no long press); the touch slots default to None (rule 5).
 */
export const ReplayMarkersDialSettings = z
  .object({
    secondsBack: secondsBackField,
    deleteWindow: deleteWindowField,
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
  // A mode this build does not know (a newer build's) resets only the mode,
  // keeping the key's overrides and Seconds Back (#1454).
  mode: z.enum(REPLAY_MARKERS_MODES).default("add").catch("add"),
  secondsBack: secondsBackField,
  deleteWindow: deleteWindowField,
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
