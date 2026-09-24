/**
 * Session limits — which of a session's two limits ends it (issue #1109).
 *
 * A session can carry a lap cap, a clock, both, or neither. iRacing reports
 * the absent side with a sentinel rather than leaving the field out —
 * `SessionLapsRemainEx` reads `IRSDK_UNLIMITED_LAPS` (32767) in a timed race
 * and `SessionTimeRemain` reads `IRSDK_UNLIMITED_TIME` (604800 s, a week) in
 * a lap race — and a dual-limit session is common in practice: the 2026-08-08
 * capture (#880) was a 10-lap race whose clock read 23.7 h, a nominal ceiling
 * that would never bind. So neither "the clock whenever it is finite" nor
 * "laps whenever a cap exists" answers "how much is left"; only comparing the
 * two does, and that comparison used to live in the fuel callouts alone.
 *
 * This module owns four things. The first three are shared by every consumer —
 * the fuel laps-left callouts (`sim-events-iracing`), Session Info's Time
 * Remaining key and the template context's `session.laps_remaining` and
 * `session.time_remaining`:
 *
 *   1. decoding the two sentinels,
 *   2. the rule that `null` means UNKNOWN (missing, sentinel, nonsensical) —
 *      and that unknown must never be mistaken for zero, and
 *   3. the whichever-ends-sooner rule, ties to the lap cap.
 *
 * The fourth is shared by the consumers that SHOW the clock to the driver —
 * Session Info and the template context, never the fuel estimate:
 *
 *   4. a clock run past zero shows as `0`, not as unknown (#1221).
 *
 * It deliberately does NOT own a consumer's precision adjustments — the fuel
 * estimate's white-flag clamp, its lap-fraction subtraction, its
 * `+2 × leaderLap` checkered bound. Those describe how well that one estimate
 * knows its own side and stay with it; what is shared is the policy of
 * comparing the two sides once each is expressed in laps.
 */
import { IRSDK_UNLIMITED_LAPS, IRSDK_UNLIMITED_TIME, type TelemetryData } from "./types.js";

/**
 * Which limit ends the session sooner: the lap cap, the clock, or neither
 * (an unlimited session, or one whose limits are both unknown).
 */
export type BindingLimit = "laps" | "time" | "none";

/**
 * Laps to go by the session's lap counter (`SessionLapsRemainEx`), or `null`
 * when that side does not bind — the field is missing, reads the
 * `IRSDK_UNLIMITED_LAPS` sentinel of a timed race, or is not a usable count
 * (NaN, infinite, negative).
 *
 * `SessionLapsRemainEx` and never `SessionLapsRemain`: the reference marks the
 * latter superseded and it is deliberately not typed. In races the counter is
 * leader-relative (`SessionLapsTotal − leaderLapCompleted`, validated across
 * the #880 captures) — the "N to go" the chequered flag follows for everyone,
 * lapped cars included. In qualifying it is player-relative (#776), which is
 * also right for a lap-limited qualifying.
 *
 * The count INCLUDES the lap in progress: a reading of 1 means the current
 * lap is the last one. A `0` is reported in the window between the leader's
 * checkered and the session state following it, and is returned as-is — it
 * is a real count, not an unknown.
 *
 * @param t - The latest telemetry snapshot, or null/undefined when unavailable
 * @returns the lap count (≥ 0), or null when the lap side is unknown or unlimited
 */
export function resolveLapsRemaining(t: TelemetryData | null | undefined): number | null {
  const raw = t?.SessionLapsRemainEx;

  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw < IRSDK_UNLIMITED_LAPS ? raw : null;
}

/**
 * Seconds left on the session clock (`SessionTimeRemain`), or `null` when
 * that side does not bind — the field is missing, reads the
 * `IRSDK_UNLIMITED_TIME` sentinel of a lap race, or is not a usable duration
 * (NaN, infinite, negative).
 *
 * The clock reaching zero does NOT end a timed race — the leader takes the
 * white at their first crossing after expiry and the checkered a lap later —
 * so `0` is a real reading and is returned as-is; how many laps that still
 * implies is each consumer's own estimate (the fuel callouts bound it by the
 * leader's lap time).
 *
 * @param t - The latest telemetry snapshot, or null/undefined when unavailable
 * @returns the seconds remaining (≥ 0), or null when the time side is unknown or unlimited
 */
export function resolveTimeRemainingS(t: TelemetryData | null | undefined): number | null {
  const raw = t?.SessionTimeRemain;

  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw < IRSDK_UNLIMITED_TIME ? raw : null;
}

/**
 * The clock as a key SHOWS it: {@link resolveTimeRemainingS}, except that a
 * clock which has run past zero reads as the `0` it has left rather than as
 * unknown (#1221).
 *
 * `SessionTimeRemain` sits below zero while the leader runs to the flag after
 * a timed race's clock expires, and iRacing can also blip it negative for a
 * tick or two mid-race (the transient `leader-white.ts` guards with a
 * two-tick confirmation). For the fuel estimate a negative duration is
 * nonsense and is better skipped, which is why {@link resolveTimeRemainingS}
 * calls it unknown. Shown to the driver, unknown renders as `UNLIM` or a
 * blank — the opposite of an expired clock — so everything that shows the
 * time side reads it through here: a key face, and a template, whose text
 * may also go out in a chat macro. A mid-race blip therefore reads `0` for
 * that tick; that is the accepted cost, and it is no worse than the blank
 * it replaced, which was just as wrong. A consumer that must not act
 * on a one-tick blip needs a confirmation of its own, as `leader-white.ts`
 * has.
 *
 * @param t - The latest telemetry snapshot, or null/undefined when unavailable
 * @returns the seconds remaining (≥ 0), 0 for an expired clock, or null when the time side is unknown or unlimited
 */
export function resolveShownTimeRemainingS(t: TelemetryData | null | undefined): number | null {
  const raw = t?.SessionTimeRemain;

  return typeof raw === "number" && Number.isFinite(raw) && raw < 0 ? 0 : resolveTimeRemainingS(t);
}

/**
 * Which limit ends the session sooner, given each side already expressed in
 * LAPS — `lapsSide` from {@link resolveLapsRemaining} (with whatever
 * bridging the caller applies), `timeSideLaps` the caller's own estimate of
 * how many laps the clock still allows. `null` on either side means that
 * side is unknown or unlimited.
 *
 * The rule:
 *   - both unknown → `"none"`. This is a statement of IGNORANCE, not of a
 *     short race: a consumer must not read it as "zero to go". The fuel
 *     callouts keep announcing on it, Session Info shows `UNLIM`.
 *   - one side known → that side. This is also what "before any lap-time
 *     estimate exists, a finite lap cap binds over the clock" reduces to: the
 *     caller has no estimate, so it passes `null` for the time side, and the
 *     cap wins by having a number at all. The alternative — showing the
 *     captured 23:44:24 clock for a lap and then flipping — is what the spec
 *     rejected.
 *   - both known → the smaller, and a TIE GOES TO LAPS. A lap cap is a hard
 *     number the sim was given and counts down in whole laps; the time side
 *     is an estimate through somebody's lap time, so at equality the counter
 *     is the one worth showing and the one that will not move on the next
 *     tick.
 *
 * @param lapsSide - laps to go by the lap counter, or null when unknown/unlimited
 * @param timeSideLaps - laps the clock still allows by the caller's estimate, or null when unknown/unlimited
 * @returns which side binds, or `"none"` when neither is known
 */
export function resolveBindingLimit(lapsSide: number | null, timeSideLaps: number | null): BindingLimit {
  if (lapsSide === null && timeSideLaps === null) return "none";

  if (timeSideLaps === null) return "laps";

  if (lapsSide === null) return "time";

  return lapsSide <= timeSideLaps ? "laps" : "time";
}

/**
 * The laps to go by whichever limit {@link resolveBindingLimit} says binds,
 * or `null` when neither side is known. The value companion to the verdict,
 * so a consumer that wants the distance rather than the name never re-derives
 * which side a verdict points at (and can never disagree with it about the
 * tie).
 *
 * @param lapsSide - laps to go by the lap counter, or null when unknown/unlimited
 * @param timeSideLaps - laps the clock still allows by the caller's estimate, or null when unknown/unlimited
 * @returns the binding side's laps to go, or null when neither is known
 */
export function bindingLapsToGo(lapsSide: number | null, timeSideLaps: number | null): number | null {
  switch (resolveBindingLimit(lapsSide, timeSideLaps)) {
    case "laps":
      return lapsSide;
    case "time":
      return timeSideLaps;
    case "none":
      return null;
  }
}
