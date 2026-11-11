/**
 * The approaching-traffic windows (issue #1113, spec decisions 4 and 5): their
 * defaults, slider bounds and sanitizers, in one place for the translator and
 * every plugin. They mirror `trafficNoticeSeconds`, `trafficHoldSeconds`,
 * `trafficPitExitBeforeSeconds` and `trafficPitExitAfterSeconds` in
 * `GlobalSettingsSchema`; the plugins wire each live-read closure through its
 * sanitizer (the `sanitizeGapAlertThresholdSeconds` precedent), so a malformed
 * persisted value can never reach the detectors.
 *
 * Each window is clamped on its own. Rejoin's hold window is also kept at or
 * under the notice window, but that is the detector's job at use, not the
 * sanitizer's: the two are separate settings and neither rewrites the other.
 */
import { coerceSettingNumber } from "./setting-number.js";

/** How far ahead the engineer looks for an arriving car (s), shared by rejoin and pit exit. */
export const TRAFFIC_DEFAULT_NOTICE_SECONDS = 20;
export const TRAFFIC_NOTICE_MIN_SECONDS = 5;
export const TRAFFIC_NOTICE_MAX_SECONDS = 60;

/** Rejoin's "hold" window (s): a car arriving inside it means stay put. */
export const TRAFFIC_DEFAULT_HOLD_SECONDS = 6;
export const TRAFFIC_HOLD_MIN_SECONDS = 2;
export const TRAFFIC_HOLD_MAX_SECONDS = 15;

/** Pit exit: a car reaching the end of the exit blend up to this long BEFORE the player counts as traffic (s). */
export const TRAFFIC_DEFAULT_PIT_EXIT_BEFORE_SECONDS = 2;
export const TRAFFIC_PIT_EXIT_BEFORE_MIN_SECONDS = 0;
export const TRAFFIC_PIT_EXIT_BEFORE_MAX_SECONDS = 10;

/** Pit exit: the same, up to this long AFTER the player (s). */
export const TRAFFIC_DEFAULT_PIT_EXIT_AFTER_SECONDS = 4;
export const TRAFFIC_PIT_EXIT_AFTER_MIN_SECONDS = 0;
export const TRAFFIC_PIT_EXIT_AFTER_MAX_SECONDS = 15;

/** Clamp a raw setting to `[min, max]`; a missing or unparseable one (a cleared field included) is `fallback`. */
function sanitizeWindow(value: unknown, min: number, max: number, fallback: number): number {
  const n = coerceSettingNumber(value);

  if (n === null) return fallback;

  return Math.min(max, Math.max(min, n));
}

/** Sanitize the `trafficNoticeSeconds` global setting. */
export function sanitizeTrafficNoticeSeconds(value: unknown): number {
  return sanitizeWindow(value, TRAFFIC_NOTICE_MIN_SECONDS, TRAFFIC_NOTICE_MAX_SECONDS, TRAFFIC_DEFAULT_NOTICE_SECONDS);
}

/** Sanitize the `trafficHoldSeconds` global setting. Not clamped to the notice window here; the detector does that. */
export function sanitizeTrafficHoldSeconds(value: unknown): number {
  return sanitizeWindow(value, TRAFFIC_HOLD_MIN_SECONDS, TRAFFIC_HOLD_MAX_SECONDS, TRAFFIC_DEFAULT_HOLD_SECONDS);
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
