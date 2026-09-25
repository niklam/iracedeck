/**
 * Replay speed encoding for iRacing's slow motion (#1202).
 *
 * In slow motion, iRacing plays a raw speed N at 1/(N+1)x — both in the
 * `ReplaySetPlaySpeed` broadcast and in the `ReplayPlaySpeed` telemetry it
 * reports back (verified in the sim: raw 1 → 1/2x, raw 4 → 1/5x, raw 16 → 1/17x).
 * Everything above the SDK speaks the divisor the user sees (1/N), so these two
 * functions are the only place that offset exists. Normal speeds (1x…16x) are
 * not encoded and pass through unchanged, as does 0 (paused).
 */

/**
 * Converts a replay speed as the user sees it into the raw SDK value.
 * In slow motion `speed` is the divisor (5 = 1/5x, -5 = -1/5x); a divisor
 * below 2 is clamped to 1/2x so it never sends a raw 0.
 */
export function replaySpeedToSdk(speed: number, slowMotion: boolean): number {
  if (!slowMotion || speed === 0) return speed;

  const divisor = Math.max(2, Math.abs(speed));

  return Math.sign(speed) * (divisor - 1);
}

/**
 * Converts a raw SDK replay speed (e.g. telemetry `ReplayPlaySpeed`) into the
 * speed the user sees. In slow motion the result is the divisor (raw 4 → 5,
 * meaning 1/5x); a raw 0 stays 0 (paused).
 */
export function replaySpeedFromSdk(raw: number, slowMotion: boolean): number {
  if (!slowMotion || raw === 0) return raw;

  return Math.sign(raw) * (Math.abs(raw) + 1);
}
