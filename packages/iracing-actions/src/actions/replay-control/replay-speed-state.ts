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
 *   (#1230), applied to speed. A pause is a sent speed too (0x). Whatever
 *   takes the replay cursor next supersedes it at once — any replay command
 *   of any action, since each takes the cursor before it sends
 *   (`shared/replay-cursor.ts`). A change made from iRacing's own replay bar
 *   inside the hold cannot be told from a stale tick, so it is masked until
 *   the hold runs out, which is when the hold heals itself.
 * - The **remembered speed**: the last non-zero speed the replay played at,
 *   which Play/Pause resumes. It follows telemetry, so it is right whoever set
 *   the speed — a dial, a key or iRacing's own replay bar — and a non-zero dial
 *   send records it at once. A 0 never overwrites it, and it is 1x before any
 *   sample.
 *
 * A broadcast reports no status, so a send iRacing ignores (a speed sent
 * while paused at the end of a saved recording) looks exactly like one it
 * took. The hold running out without telemetry ever reporting the sent speed
 * is the only sign of it, and that lapse is what covers the case: the live
 * speed is telemetry's again, and a remembered speed the ignored send recorded
 * goes back to what it was.
 *
 * Time is passed in, never read here. In memory only: a plugin restart starts
 * again at 1x, and nothing here belongs in persisted settings.
 */
import { onReplayCursorTaken } from "../../shared/replay-cursor.js";
import type { ReplaySpeed } from "./replay-control-dial-mode.js";
import { isSameSpeed } from "./replay-speed-ladder.js";

/**
 * @internal Exported for testing
 *
 * How long (ms) a speed a dial sent stands in for the live speed while
 * telemetry has not reported it: long enough for the sim to answer a
 * broadcast. When it runs out unreported the send is taken as one iRacing did
 * not act on — the live speed is telemetry's again and the remembered speed
 * goes back to what it was before the send — so it is also how long a speed
 * iRacing ignored stays on a dial; the surface redraws when it lapses.
 */
export const DIAL_SPEED_HOLD_MS = 500;

/** A speed a dial sent, and when. */
interface PendingSpeed {
  readonly speed: ReplaySpeed;
  /** The send's timestamp (ms). */
  readonly sentAt: number;
  /**
   * The remembered speed this hold replaced: what it was before the first
   * send of the hold, carried unchanged through every further send made while
   * the hold stands, so two ignored sends in a row still go back to the speed
   * the replay really played at.
   */
  readonly replaced: ReplaySpeed;
}

/** What the replay resumes at before it has been seen playing. */
const NORMAL_SPEED: ReplaySpeed = { speed: 1, slowMotion: false };

let pending: PendingSpeed | null = null;
let remembered: ReplaySpeed = { ...NORMAL_SPEED };

/**
 * The pending speed that still stands for the live one, or null. Telemetry
 * reporting it, or the hold running out, drops it here for good, so a replay
 * that later passes through the same speed does not revive it. Reported, the
 * send took and what it recorded stays; run out unreported, it lapses.
 */
function settlePending(telemetrySpeed: ReplaySpeed | null, nowMs: number): PendingSpeed | null {
  if (pending === null) return null;

  if (telemetrySpeed !== null && isSameSpeed(telemetrySpeed, pending.speed)) {
    pending = null;
  } else if (nowMs - pending.sentAt >= DIAL_SPEED_HOLD_MS) {
    lapsePending(pending);
  }

  return pending;
}

/**
 * The hold ran out and telemetry never reported the sent speed: iRacing did
 * not act on it. The remembered speed goes back to what the hold replaced,
 * but only while it is still the speed that send recorded — a Reverse made
 * while paused has since replaced it with the user's own choice.
 */
function lapsePending(lapsed: PendingSpeed): void {
  if (lapsed.speed.speed !== 0 && isSameSpeed(remembered, lapsed.speed)) remembered = { ...lapsed.replaced };

  pending = null;
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
 * a turn to 4x and Pause inside one telemetry frame still resume 4x. The
 * remembered speed it replaces is kept with the hold, for the lapse.
 */
export function noteDialSpeedSent(target: ReplaySpeed, nowMs: number): void {
  // A hold that ran out with nothing reading it since lapses first, so the new
  // hold starts from the remembered speed that lapse restores.
  const standing = settlePending(null, nowMs);

  pending = { speed: { ...target }, sentAt: nowMs, replaced: standing?.replaced ?? { ...remembered } };

  if (target.speed !== 0) remembered = { ...target };
}

/**
 * Drops the pending speed: something else just took the replay cursor to send
 * a command of its own, so the dial's send no longer says what the replay is
 * doing and the live speed follows telemetry again at once. Without it a key's
 * Play inside the hold would be masked: the box would still read the dial's
 * speed, and Frame Jog would step a replay it believes paused. The remembered
 * speed is left alone. Runs on every cursor take (registered below); a dial's
 * own take goes through {@link keepDialPendingSpeed}.
 */
export function clearDialPendingSpeed(): void {
  pending = null;
}

/**
 * Runs `take` — a dial taking the replay cursor for its own command — and
 * puts back the pending speed that stood before it. A dial's command does not
 * supersede the dial's last send the way another action's does: Frame Jog
 * pauses and then steps, and the step must still read the replay as paused.
 * A speed the dial sends next replaces it through {@link noteDialSpeedSent}.
 */
export function keepDialPendingSpeed<T>(take: () => T): T {
  const held = pending;

  try {
    return take();
  } finally {
    pending = held;
  }
}

// Every replay command of every action takes the cursor before it sends.
onReplayCursorTaken(clearDialPendingSpeed);

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

/**
 * The speed Play/Pause resumes at: the last non-zero speed the replay played
 * at, 1x before any. A lapsed hold is noticed where the live speed is read
 * ({@link resolveLiveSpeed}), so a caller that needs both reads that first.
 */
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
