/**
 * The pit-exit traffic window (issue #1113, spec decisions 4 and 5): its two
 * sides' defaults, slider bounds and sanitizers, in one place for the
 * translator and every plugin. They mirror `trafficPitExitBeforeSeconds` and
 * `trafficPitExitAfterSeconds` in `GlobalSettingsSchema`; the plugins wire each
 * live-read closure through its sanitizer (the
 * `sanitizeGapAlertThresholdSeconds` precedent), so a malformed persisted
 * value can never reach the detector. Each side is clamped on its own.
 *
 * Rejoin has no setting (amended 2026-11-11): its bands are fixed because its
 * lines name them (`diff/traffic-rejoin.ts`), and the pit-exit call is made
 * at the stall departure, so there is no look-ahead either.
 */
import { coerceSettingNumber } from "./setting-number.js";

/** Pit exit: a car reaching the end of the exit blend up to this long BEFORE the player counts as traffic (s). */
export const TRAFFIC_DEFAULT_PIT_EXIT_BEFORE_SECONDS = 2;
export const TRAFFIC_PIT_EXIT_BEFORE_MIN_SECONDS = 0;
export const TRAFFIC_PIT_EXIT_BEFORE_MAX_SECONDS = 10;

/** Pit exit: the same, up to this long AFTER the player (s). */
export const TRAFFIC_DEFAULT_PIT_EXIT_AFTER_SECONDS = 4;
export const TRAFFIC_PIT_EXIT_AFTER_MIN_SECONDS = 0;
export const TRAFFIC_PIT_EXIT_AFTER_MAX_SECONDS = 15;

/**
 * Clamp a raw setting to `[min, max]`; a missing or unparseable one is
 * `fallback`: a cleared field, a whitespace-only one, a boolean, an array or
 * an object included. A blank string is screened here because
 * `coerceSettingNumber` reads whitespace as 0 (`Number(" ")`), which is in
 * range and would close that side of the window, like the schema's own
 * screen (`GlobalSettingsSchema`).
 */
function sanitizeWindow(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "string" && value.trim() === "" ? null : coerceSettingNumber(value);

  if (n === null) return fallback;

  return Math.min(max, Math.max(min, n));
}

/** Sanitize the `trafficPitExitBeforeSeconds` global setting. An explicit 0 is kept: it closes that side. */
export function sanitizeTrafficPitExitBeforeSeconds(value: unknown): number {
  return sanitizeWindow(
    value,
    TRAFFIC_PIT_EXIT_BEFORE_MIN_SECONDS,
    TRAFFIC_PIT_EXIT_BEFORE_MAX_SECONDS,
    TRAFFIC_DEFAULT_PIT_EXIT_BEFORE_SECONDS,
  );
}

/** Sanitize the `trafficPitExitAfterSeconds` global setting. An explicit 0 is kept: it closes that side. */
export function sanitizeTrafficPitExitAfterSeconds(value: unknown): number {
  return sanitizeWindow(
    value,
    TRAFFIC_PIT_EXIT_AFTER_MIN_SECONDS,
    TRAFFIC_PIT_EXIT_AFTER_MAX_SECONDS,
    TRAFFIC_DEFAULT_PIT_EXIT_AFTER_SECONDS,
  );
}
