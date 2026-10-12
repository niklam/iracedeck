/**
 * Replay Control dial — the replay speed every dial shares (#1316). Design:
 * `docs/superpowers/specs/2026-10-04-issue-1316-replay-control-dial.md`.
 *
 * iRacing has one replay speed, so both values here are ONE module-wide value
 * each, never per dial:
 *
 * - The **pending speed**: what a dial just sent. `ReplayPlaySpeed` reports a
 *   new speed only on a later tick, so a second detent arriving first would
 *   walk from the old speed and send the same stop again. After a dial send
 *   the live speed therefore reads as the sent target until telemetry reports
 *   it or {@link DIAL_SPEED_HOLD_MS} passes — the Replay Markers landing hold
 *   (#1230), applied to speed. A pause is a sent speed too (0x). A speed this
 *   action's keys send supersedes it at once ({@link clearDialPendingSpeed}).
 *   A change made from iRacing's own replay bar inside the hold cannot be told
 *   from a stale tick, so it is masked until the hold runs out, which is when
 *   the hold heals itself.
 * - The **remembered speed**: the last non-zero speed the replay played at,
 *   which Play/Pause resumes. It follows telemetry, so it is right whoever set
 *   the speed — a dial, a key or iRacing's own replay bar — and a non-zero dial
 *   send records it at once. A 0 never overwrites it, and it is 1x before any
 *   sample.
 *
 * Time is passed in, never read here. In memory only: a plugin restart starts
 * again at 1x, and nothing here belongs in persisted settings.
 */
import type { ReplaySpeed } from "./replay-control-dial-mode.js";
import { isSameSpeed } from "./replay-speed-ladder.js";

/**
 * @internal Exported for testing
 *
 * How long (ms) a speed a dial sent stands in for the live speed while
 * telemetry has not reported it. Long enough for the sim to answer a
 * broadcast, short enough that a speed iRacing refused is not shown for long.
 */
export const DIAL_SPEED_HOLD_MS = 500;

/** A speed a dial sent, and when. */
interface PendingSpeed {
  readonly speed: ReplaySpeed;
  /** The send's timestamp (ms). */
  readonly sentAt: number;
}

/** What the replay resumes at before it has been seen playing. */
const NORMAL_SPEED: ReplaySpeed = { speed: 1, slowMotion: false };

let pending: PendingSpeed | null = null;
let remembered: ReplaySpeed = { ...NORMAL_SPEED };

/**
 * The pending speed that still stands for the live one, or null. Telemetry
 * reporting it, or the hold running out, drops it here for good, so a replay
 * that later passes through the same speed does not revive it.
 */
function settlePending(telemetrySpeed: ReplaySpeed | null, nowMs: number): PendingSpeed | null {
  if (pending === null) return null;

  const reported = telemetrySpeed !== null && isSameSpeed(telemetrySpeed, pending.speed);

  if (reported || nowMs - pending.sentAt >= DIAL_SPEED_HOLD_MS) pending = null;

  return pending;
}

/**
 * The replay speed now: `telemetrySpeed` (the latest tick's, null when the
 * tick carries none), overlaid by a speed a dial sent that telemetry has not
 * caught up with. No telemetry speed and nothing pending reads as paused.
 */
export function resolveLiveSpeed(telemetrySpeed: ReplaySpeed | null, nowMs: number): ReplaySpeed {
  const held = settlePending(telemetrySpeed, nowMs);

  if (held !== null) return { ...held.speed };

  return telemetrySpeed === null ? { speed: 0, slowMotion: false } : { ...telemetrySpeed };
}

/**
 * Records a speed a dial just sent, a pause (0x) included. Call it only when
 * the command actually went out. The target becomes the live speed for the
 * hold, and a non-zero one is remembered as the resume speed at once, so Play,
 * a turn to 4x and Pause inside one telemetry frame still resume 4x.
 */
export function noteDialSpeedSent(target: ReplaySpeed, nowMs: number): void {
  pending = { speed: { ...target }, sentAt: nowMs };

  if (target.speed !== 0) remembered = { ...target };
}

/**
 * Drops the pending speed: something other than a dial just sent a replay
 * speed (a key's Play, Set Speed, a pause), so the dial's own send no longer
 * says what the replay is doing and the live speed follows telemetry again at
 * once. Without it a key press inside the hold would be masked: the box would
 * still read the dial's speed, and Frame Jog would step a replay it believes
 * paused. The remembered speed is left alone.
 */
export function clearDialPendingSpeed(): void {
  pending = null;
}

/**
 * Feeds one telemetry sample to the remembered speed. Call it on every tick
 * that is in a replay, and on no other: out of a replay `ReplayPlaySpeed` says
 * nothing about what a replay last played at. A 0 changes nothing. Neither
 * does a sample taken while a dial's send is pending: until telemetry reports
 * that send, a tick still carries the speed from before it, which would
 * overwrite the newer one the send recorded.
 */
export function noteTelemetrySpeed(sample: ReplaySpeed, nowMs: number): void {
  if (settlePending(sample, nowMs) !== null) return;

  if (sample.speed !== 0) remembered = { ...sample };
}

/** The speed Play/Pause resumes at: the last non-zero speed the replay played at, 1x before any. */
export function rememberedSpeed(): ReplaySpeed {
  return { ...remembered };
}

/**
 * Flips the remembered speed's direction, keeping its magnitude and
 * slow-motion flag — Reverse while paused, so the next Play/Pause resumes the
 * other way. Returns the flipped speed.
 */
export function reverseRememberedSpeed(): ReplaySpeed {
  remembered = { speed: -remembered.speed, slowMotion: remembered.slowMotion };

  return { ...remembered };
}

/** @internal Reset for tests. */
export function _resetReplaySpeedState(): void {
  pending = null;
  remembered = { ...NORMAL_SPEED };
}
