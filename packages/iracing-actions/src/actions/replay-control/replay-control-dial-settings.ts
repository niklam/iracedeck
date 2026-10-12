/**
 * Replay Control dial settings (#1316), under the `dial` root key of the
 * action's settings so the dial's keys cannot collide with the keypad's (the
 * Fuel Service rule). Kept apart from the action so the dial surface and its
 * modes can import it without importing the action that owns them. Design:
 * `docs/superpowers/specs/2026-10-04-issue-1316-replay-control-dial.md`.
 */
import z from "zod";

import { dialAppearanceFields } from "../../shared/dial-box.js";

/** What the dial's rotation does. `dial.mode` is dial-only; the keypad's `mode` is ignored on a dial. */
export const REPLAY_DIAL_MODES = ["speed"] as const;

export type ReplayControlDialMode = (typeof REPLAY_DIAL_MODES)[number];

/** What a dial gesture slot can run. Shared by every dial mode, so changing the Mode never changes the presses. */
export const REPLAY_DIAL_GESTURES = ["play-pause", "set-1x-play", "reverse", "jump-to-live", "none"] as const;

export type ReplayControlDialGesture = (typeof REPLAY_DIAL_GESTURES)[number];

/**
 * Every speed magnitude iRacing supports, slowest first, as tokens in the
 * keypad's own speed format (`parseSpeedSetting`): `"s4"` is 1/4x, `"2"` is 2x.
 * The order is the order of the PI's Speeds grid.
 */
export const SPEED_STOP_TOKENS = [
  "s16",
  "s15",
  "s14",
  "s13",
  "s12",
  "s11",
  "s10",
  "s9",
  "s8",
  "s7",
  "s6",
  "s5",
  "s4",
  "s3",
  "s2",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
] as const;

export type SpeedStopToken = (typeof SPEED_STOP_TOKENS)[number];

/** The magnitudes ticked on a fresh dial: the ladder −8x … −¼x, 0x, ¼x … 8x. */
const DEFAULT_SPEED_STOPS: ReadonlySet<SpeedStopToken> = new Set<SpeedStopToken>(["s4", "s2", "1", "2", "4", "8"]);

/** Every magnitude and whether it is a stop on the ladder. 0x is always a stop and is not a token. */
export type SpeedStops = Record<SpeedStopToken, boolean>;

function defaultSpeedStops(): SpeedStops {
  return Object.fromEntries(SPEED_STOP_TOKENS.map((token) => [token, DEFAULT_SPEED_STOPS.has(token)])) as SpeedStops;
}

/**
 * @internal Exported for testing
 *
 * Reads the stored `dial.speedStops` map into a full one. The stored object
 * holds only what the user touched: a token absent from it (or holding
 * anything but a boolean) reads its default, so a magnitude added to the
 * offer later arrives with its own default rather than silently off, and an
 * unknown token is ignored. A map that ticks nothing reads as the default set
 * — a ladder of 0x alone would make the dial do nothing — which only a
 * hand-edit can produce, since the PI will not clear the last box.
 */
export function parseSpeedStops(raw: unknown): SpeedStops {
  const stops = defaultSpeedStops();

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return stops;

  const stored = raw as Record<string, unknown>;

  for (const token of SPEED_STOP_TOKENS) {
    const value = stored[token];

    if (typeof value === "boolean") stops[token] = value;
  }

  return Object.values(stops).some(Boolean) ? stops : defaultSpeedStops();
}

/** A gesture slot that reads anything unknown (a newer build's value) as its default. */
function dialGestureField(fallback: ReplayControlDialGesture) {
  return z.enum(REPLAY_DIAL_GESTURES).default(fallback).catch(fallback);
}

/**
 * @internal Exported for testing
 *
 * The dial's settings. Every field defaults and `.catch`es to its default, so
 * a keypad instance (no `dial` at all) and a fresh dial both parse to a full
 * object and one bad field never resets the others. Press is Play/Pause; Long
 * press sets 1x and plays (also assignable to Press, for a knob that has no
 * long press); the touch slots default to None (rule 5).
 */
export const ReplayControlDialSettings = z
  .object({
    mode: z.enum(REPLAY_DIAL_MODES).default("speed").catch("speed"),
    // `unknown` alone makes the key required; the default lets a dial that never
    // stored the map parse, and the transform fills it either way.
    speedStops: z.unknown().default({}).transform(parseSpeedStops),
    pressAction: dialGestureField("play-pause"),
    longPressAction: dialGestureField("set-1x-play"),
    tapAction: dialGestureField("none"),
    longTouchAction: dialGestureField("none"),
    ...dialAppearanceFields,
  })
  // prefault (not default): a missing `dial` parses {} THROUGH the schema so
  // the per-field defaults apply — same shape as a partially-persisted object.
  .prefault({});

/** @internal Exported for testing */
export type ReplayControlDialSettings = z.infer<typeof ReplayControlDialSettings>;

/**
 * The `dial` field of the action's settings schema. A non-object `dial` (a
 * newer build's shape) degrades to the dial defaults rather than failing the
 * whole parse and resetting the keypad's mode.
 */
export const replayControlDialField = ReplayControlDialSettings.catch(() => ReplayControlDialSettings.parse({}));
