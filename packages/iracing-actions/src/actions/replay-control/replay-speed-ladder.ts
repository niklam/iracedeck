/**
 * Replay Control dial — the speed ladder (#1316). Pure: the stops the Speed
 * Control rotation walks, built from the magnitudes ticked in `dial.speedStops`,
 * and the walk itself. Design:
 * `docs/superpowers/specs/2026-10-04-issue-1316-replay-control-dial.md`.
 *
 * The ladder is mirrored by construction — `−m(n) … −m(1), 0x, m(1) … m(n)` —
 * and signed: clockwise always moves toward the fastest forward stop, so from
 * −8x a clockwise detent goes to −4x. 0x is a stop like any other.
 */
import type { ReplaySpeed } from "./replay-control-dial-mode.js";
import { SPEED_STOP_TOKENS, type SpeedStops, type SpeedStopToken } from "./replay-control-dial-settings.js";
import { parseSpeedSetting } from "./replay-speed-format.js";

/**
 * How close two {@link speedValue}s must be to count as the same speed. The
 * nearest two speeds iRacing plays are 1/16x and 1/17x, 0.0037 apart.
 */
const SAME_SPEED_EPSILON = 1e-6;

/** Which way a turn goes on the ladder: 1 is clockwise (toward +16x), −1 counter-clockwise. */
export type LadderDirection = 1 | -1;

/** The paused stop, in the middle of every ladder. */
const PAUSED: ReplaySpeed = { speed: 0, slowMotion: false };

/**
 * A replay speed as one signed number, so the ladder's order and "where am I"
 * share one comparison: 8x is 8, −¼x (`{ -4, true }`) is −0.25, paused is 0.
 */
export function speedValue(s: ReplaySpeed): number {
  if (s.speed === 0) return 0;

  return s.slowMotion ? Math.sign(s.speed) / Math.abs(s.speed) : s.speed;
}

/** Whether two replay speeds are the same speed, whatever shape each was written in. */
export function isSameSpeed(a: ReplaySpeed, b: ReplaySpeed): boolean {
  return Math.abs(speedValue(a) - speedValue(b)) < SAME_SPEED_EPSILON;
}

/** The forward stop a `dial.speedStops` token names: `"s4"` is ¼x (`{ 4, true }`), `"2"` is 2x. */
export function stopFromToken(token: SpeedStopToken): ReplaySpeed {
  return parseSpeedSetting(token);
}

/**
 * The ladder for the ticked magnitudes, ascending by {@link speedValue}: every
 * ticked magnitude in reverse, fastest first, then 0x, then the same
 * magnitudes forward. `stops` is the parsed map, so at least one is ticked.
 */
export function buildLadder(stops: SpeedStops): ReplaySpeed[] {
  // The tokens are listed slowest first, so the forward half is already ascending.
  const forward = SPEED_STOP_TOKENS.filter((token) => stops[token]).map(stopFromToken);
  const reverse = forward.map((stop) => ({ speed: -stop.speed, slowMotion: stop.slowMotion })).reverse();

  return [...reverse, { ...PAUSED }, ...forward];
}

/**
 * The index a turn's first detent lands on, or −1 when there is no stop that
 * way. On the ladder that is the neighbouring stop; off it (a key set 3x,
 * iRacing's own bar set 16x when 16 is not ticked) it is the nearest stop
 * strictly beyond the live speed in the turn's direction.
 */
function firstStopIndex(ladder: readonly ReplaySpeed[], live: ReplaySpeed, direction: LadderDirection): number {
  const value = speedValue(live);

  if (direction > 0) return ladder.findIndex((stop) => speedValue(stop) > value + SAME_SPEED_EPSILON);

  return ladder.findLastIndex((stop) => speedValue(stop) < value - SAME_SPEED_EPSILON);
}

/**
 * Where a turn of `ticks` detents (positive is clockwise) takes the replay
 * from `live`: `|ticks|` stops in the turn's direction, with no per-event cap,
 * clamped at the ladder's ends and never wrapping — a wrap from +8x to −8x
 * would throw the replay backwards at full speed. Returns the stop reached,
 * or `null` when that is the live speed: a zero-tick turn, or a turn past an
 * end, for which nothing is sent.
 */
export function walkLadder(ladder: readonly ReplaySpeed[], live: ReplaySpeed, ticks: number): ReplaySpeed | null {
  if (ticks === 0) return null;

  const direction: LadderDirection = ticks > 0 ? 1 : -1;
  const first = firstStopIndex(ladder, live, direction);

  if (first === -1) return null;

  // The first detent is spent reaching `first`; the rest walk on from there.
  const target = Math.min(Math.max(first + direction * (Math.abs(ticks) - 1), 0), ladder.length - 1);

  return ladder[target];
}

/**
 * Whether a turn that way would change the speed — the same walk the rotation
 * runs, so the dial's side marks cannot promise a turn the dial will not make.
 */
export function canStep(ladder: readonly ReplaySpeed[], live: ReplaySpeed, direction: LadderDirection): boolean {
  return walkLadder(ladder, live, direction) !== null;
}
